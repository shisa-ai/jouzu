import { FlowLedgerError } from "./receipt-ledger.js";
import type { FlowAuthorityExecution } from "./wait-authority.js";
import type { FlowWaitClock } from "./wait-deadlines.js";
import { assessFlowHealth, type FlowHealthPolicy } from "./wait-health.js";
import type { FlowWaitHandle, FlowWaitState } from "./wait-state.js";
import type { FlowWaitStore } from "./wait-store.js";

export interface FlowHealthMonitorOptions {
	store: Pick<FlowWaitStore, "snapshot" | "authoritySnapshot" | "observeWaitHealth">;
	/** Resolves the policy a wait requested, or undefined once its producer is gone. */
	policy(handle: FlowWaitHandle, workId: string): FlowHealthPolicy | undefined;
	/**
	 * Force one producer re-read. A quiet execution reports nothing on its own, so the host asks
	 * directly before treating stale evidence as a decision. Resolves when the producer has
	 * reported, or is abandoned once the policy's probe timeout passes.
	 */
	probe(handle: FlowWaitHandle, signal: AbortSignal): Promise<unknown>;
	clock: FlowWaitClock;
	onError(error: unknown): void;
}

const key = (handle: { producer: string; handle: string; execution: string }) =>
	JSON.stringify([handle.producer, handle.handle, handle.execution]);

/**
 * Turn retained producer evidence into health decisions on a schedule, without a model request.
 *
 * Evidence arriving from a producer is what refreshes health; this exists for its absence. An
 * execution that stops reporting produces no event, so only a timer can notice that its evidence
 * went stale and its probe went unanswered. Health decisions are retained on the affected wait, so later waits and producer results
 * remain independent of that assessment.
 */
export class FlowWaitHealthMonitor {
	private stopped = false;
	private requested = false;
	private running?: Promise<void>;
	private cancelTimer?: () => void;
	private timerRevision = 0;
	/** Executions already asked in this stale window, so one probe is not repeated every scan. */
	private readonly probed = new Set<string>();
	constructor(private readonly options: FlowHealthMonitorOptions) {}

	/**
	 * One bounded probe. A producer that never answers must not hold the scan open, so the timeout
	 * abandons the wait rather than the request: the grace period then decides on its own schedule.
	 */
	private async probeOnce(handle: FlowWaitHandle, timeoutMs: number): Promise<void> {
		const abort = new AbortController();
		let release: (() => void) | undefined;
		const bounded = new Promise<void>((resolve) => {
			release = this.options.clock.after(timeoutMs, resolve);
		});
		try {
			await Promise.race([this.options.probe(handle, abort.signal).then(() => undefined), bounded]);
		} catch (error) {
			// A producer that throws is evidence it cannot answer, which grace already handles.
			this.options.onError(error);
		} finally {
			abort.abort();
			release?.();
		}
	}

	private clearTimer(): void {
		this.timerRevision++;
		this.cancelTimer?.();
		this.cancelTimer = undefined;
	}

	/** Coalesce changes received while storage is awaited into another complete scan. */
	refresh(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		this.requested = true;
		this.clearTimer();
		if (!this.running)
			this.running = this.scan().finally(() => {
				this.running = undefined;
				if (this.requested && !this.stopped) this.changed();
			});
		return this.running;
	}

	changed = (): void => {
		void this.refresh().catch(this.options.onError);
	};

	/** Every monitored dependency of a live wait, paired with the execution that reports for it. */
	private monitored(
		waits: FlowWaitState[],
		executions: FlowAuthorityExecution[],
	): { wait: FlowWaitState; handle: FlowWaitHandle; execution: FlowAuthorityExecution }[] {
		const byKey = new Map(executions.map((execution) => [key(execution), execution]));
		return waits
			.filter((wait) => wait.state === "waiting")
			.flatMap((wait) =>
				wait.on
					.filter(
						(handle, index) =>
							handle.health !== undefined && !["unhealthy", "health-unknown"].includes(wait.observations[index]?.state),
					)
					.flatMap((handle) => {
						const execution = byKey.get(key(handle));
						// A wait cannot be live without its execution registered, so a miss is a real
						// inconsistency rather than a race to absorb silently.
						if (!execution) throw new FlowLedgerError("identity", "Monitored dependency has no registered execution.");
						return execution.predicates.some(
							(predicate) => predicate.until === handle.until && predicate.state === "pending",
						)
							? [{ wait, handle, execution }]
							: [];
					}),
			);
	}

	private async scan(): Promise<void> {
		while (this.requested && !this.stopped) {
			this.requested = false;
			const now = this.options.clock.now();
			if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid health clock time.");
			const [waits, authority] = await Promise.all([
				this.options.store.snapshot(),
				this.options.store.authoritySnapshot(),
			]);
			if (this.stopped) return;
			const liveTokens = new Set(waits.filter((wait) => wait.state === "waiting").map((wait) => wait.token));
			for (const id of this.probed) if (!liveTokens.has(JSON.parse(id)[0])) this.probed.delete(id);
			let next = Infinity;
			for (const { wait, handle, execution } of this.monitored(waits, authority.executions)) {
				const policy = this.options.policy(handle, execution.workId);
				// A producer that detached takes its policy with it. The wait keeps its hard deadline,
				// which is the guarantee that never depends on a responsive producer.
				if (!policy) continue;
				const verdict = assessFlowHealth(
					policy,
					execution.healthEvidence,
					now,
					Math.max(wait.createdAt, execution.healthSince ?? execution.observedAt),
					wait.expiresAt,
				);
				const since = Math.max(wait.createdAt, execution.healthSince ?? execution.observedAt);
				const staleAt = Math.max(execution.healthEvidence?.observedAt ?? since, since) + policy.freshnessMs;
				const probeKey = JSON.stringify([wait.token, key(handle)]);
				// A delayed scan must still ask before deciding that evidence is unavailable.
				if (verdict.state !== "unhealthy" && now >= staleAt && !this.probed.has(probeKey)) {
					this.probed.add(probeKey);
					await this.probeOnce(handle, policy.probeTimeoutMs);
					if (this.stopped) return;
					this.requested = true;
					continue;
				}
				if (now < staleAt) this.probed.delete(probeKey);
				if (verdict.state === "healthy") {
					if (verdict.nextCheckAt < wait.expiresAt) next = Math.min(next, verdict.nextCheckAt);
					continue;
				}
				// End this wait's dependency assessment without changing the producer's exit state.
				await this.options.store.observeWaitHealth(wait.token, handle, execution, verdict.state, now);
				if (this.stopped) return;
				// Storage changed, so the next pass reads the decision rather than trusting this one.
				this.requested = true;
			}
			if (this.stopped || this.requested) continue;
			if (next === Infinity) return;
			// Node clamps overflowing delays to 1 ms, so long waits recheck in bounded segments.
			const delay = Math.min(2_147_483_647, Math.max(0, next - this.options.clock.now()));
			const revision = this.timerRevision;
			this.cancelTimer = this.options.clock.after(delay, () => {
				if (!this.stopped && revision === this.timerRevision) this.changed();
			});
		}
	}

	/** Stop callbacks immediately and drain the scan before closing its storage. */
	async stop(): Promise<void> {
		this.stopped = true;
		this.clearTimer();
		await this.running?.catch(() => undefined);
	}
}
