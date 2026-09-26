import type { WorkDashboardSnapshot, WorkDashboardSource, WorkScope, WorkSourceSnapshot } from "./work-dashboard.js";

/** Owns one attachment. Late reads cannot publish into a replacement attachment. */
export class WorkDashboardController {
	private generation = 0;
	private snapshot?: WorkDashboardSnapshot;
	private cleanup: (() => void)[] = [];
	private listeners = new Set<(snapshot: WorkDashboardSnapshot) => void>();

	subscribe(listener: (snapshot: WorkDashboardSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	/** Request a display refresh without reading or acknowledging producer state. */
	invalidateDisplay(): void {
		this.publish();
	}
	getSnapshot(): WorkDashboardSnapshot | undefined {
		return this.snapshot ? structuredClone(this.snapshot) : undefined;
	}
	attach(scope: WorkScope, sources: WorkDashboardSource[]): void {
		const previous = this.snapshot;
		this.detach();
		const generation = this.generation;
		this.snapshot = { scope: { ...scope }, generation, sequence: 0, sources: {} };
		for (const source of sources) {
			if (source.id in this.snapshot.sources) throw new Error("Duplicate dashboard source identity.");
			const retained =
				previous?.scope.sessionId === scope.sessionId &&
				(source.membership === "session" || previous.scope.branchId === scope.branchId)
					? previous.sources[source.id]
					: undefined;
			this.snapshot.sources[source.id] = retained
				? { ...structuredClone(retained), availability: "stale", complete: false }
				: { availability: "unknown", complete: false, units: [] };
		}
		this.publish();
		for (const source of sources) {
			const abort = new AbortController();
			let dirty = false;
			let reading = false;
			const refresh = async () => {
				if (abort.signal.aborted) return;
				dirty = true;
				if (reading) return;
				reading = true;
				try {
					while (dirty && !abort.signal.aborted) {
						dirty = false;
						let next: WorkSourceSnapshot;
						try {
							next = await source.read({ ...scope }, abort.signal);
						} catch {
							next = { availability: "stale", complete: false, units: [] };
						}
						if (abort.signal.aborted || generation !== this.generation || !this.snapshot) return;
						// A change during the read invalidates it. Read again before publishing.
						if (dirty) continue;
						const previous = this.snapshot.sources[source.id];
						this.snapshot.sources[source.id] =
							next.complete && next.availability === "available"
								? structuredClone(next)
								: { ...previous, availability: previous.units.length ? "stale" : "unknown", complete: false };
						this.publish();
					}
				} finally {
					reading = false;
				}
			};
			this.cleanup.push(() => abort.abort());
			let subscriptionFailed = false;
			try {
				this.cleanup.push(
					source.subscribe(() => {
						void refresh();
					}),
				);
			} catch {
				subscriptionFailed = true;
			}
			const pollInterval = source.pollIntervalMs ?? (subscriptionFailed ? 1000 : undefined);
			if (pollInterval !== undefined && Number.isFinite(pollInterval) && pollInterval >= 100) {
				const timer = setInterval(() => {
					// Poll ticks coalesce; only source notifications invalidate an in-flight read.
					if (!reading) void refresh();
				}, pollInterval);
				timer.unref?.();
				this.cleanup.push(() => clearInterval(timer));
			}
			void refresh();
		}
	}
	private publish(): void {
		if (!this.snapshot) return;
		this.snapshot.sequence++;
		for (const listener of this.listeners) {
			try {
				listener(structuredClone(this.snapshot));
			} catch {}
		}
	}
	detach(): void {
		this.generation++;
		for (const dispose of this.cleanup.splice(0)) {
			try {
				dispose();
			} catch {}
		}
		this.snapshot = undefined;
	}
	dispose(): void {
		this.detach();
		this.listeners.clear();
	}
}
