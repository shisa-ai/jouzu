import type { FlowWaitStore } from "./wait-store.js";

export interface FlowWaitClock {
	now(): number;
	/** Return a cancellation function. Callbacks must run asynchronously. */
	after(delayMs: number, callback: () => void): () => void;
}

export const systemWaitClock: FlowWaitClock = {
	now: Date.now,
	after(delayMs, callback) {
		const timer = setTimeout(callback, delayMs);
		timer.unref();
		return () => clearTimeout(timer);
	},
};

/** Persist expiry without invoking a producer or a model. Each instance belongs to one attachment. */
export class FlowWaitDeadlines {
	private stopped = false;
	private requested = false;
	private running?: Promise<void>;
	private cancelTimer?: () => void;
	private timerRevision = 0;
	constructor(
		private readonly store: Pick<FlowWaitStore, "expireDue" | "snapshot">,
		private readonly clock: FlowWaitClock,
		private readonly onError: (error: unknown) => void,
	) {}

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
		if (!this.running) {
			this.running = this.scan().finally(() => {
				this.running = undefined;
				if (this.requested && !this.stopped) this.changed();
			});
		}
		return this.running;
	}

	/** Store notifications and timers cannot make an already committed mutation fail. */
	changed = (): void => {
		void this.refresh().catch(this.onError);
	};

	private async scan(): Promise<void> {
		while (this.requested && !this.stopped) {
			this.requested = false;
			const now = this.clock.now();
			if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid wait clock time.");
			await this.store.expireDue(now);
			if (this.stopped) return;
			const waits = await this.store.snapshot();
			if (this.stopped || this.requested) continue;
			const next = Math.min(...waits.filter((wait) => wait.state === "waiting").map((wait) => wait.expiresAt));
			if (next === Infinity) return;
			// Node clamps overflowing delays to 1 ms. Recheck long deadlines in bounded segments.
			const delay = Math.min(2_147_483_647, Math.max(0, next - this.clock.now()));
			const revision = this.timerRevision;
			this.cancelTimer = this.clock.after(delay, () => {
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
