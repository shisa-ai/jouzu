import { FlowLedgerError } from "./receipt-ledger.js";
import type { FlowAuthorityExecution } from "./wait-authority.js";
import type { FlowWaitClock } from "./wait-deadlines.js";
import { assessFlowHealth, type FlowHealthPolicy } from "./wait-health.js";
import type { FlowWaitHandle, FlowWaitState } from "./wait-state.js";
import type { FlowWaitStore } from "./wait-store.js";

export interface FlowHealthMonitorOptions {
	store: Pick<FlowWaitStore, "snapshot" | "authoritySnapshot" | "observeExecution">;
	/** Resolves the policy a wait requested, or undefined once its producer is gone. */
	policy(handle: FlowWaitHandle, workId: string): FlowHealthPolicy | undefined;
	/**
	 * Force one producer re-read. A quiet execution reports nothing on its own, so the host asks
	 * directly before treating stale evidence as a decision. Resolves when the producer has
	 * reported, or is abandoned once the policy's probe timeout passes.
	 */
	probe(handle: FlowWaitHandle): Promise<unknown>;
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
 * went stale and its probe went unanswered. A decision is written as an execution predicate, the
 * same path all producer evidence takes, so the wait's own reducer decides the outcome.
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
		let release: (() => void) | undefined;
		const bounded = new Promise<void>((resolve) => {
			release = this.options.clock.after(timeoutMs, resolve);
		});
		try {
			await Promise.race([this.options.probe(handle).then(() => undefined), bounded]);
		} catch (error) {
			// A producer that throws is evidence it cannot answer, which grace already handles.
			this.options.onError(error);
		} finally {
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
					.filter((handle) => handle.health !== undefined)
					.flatMap((handle) => {
						const execution = byKey.get(key(handle));
						// A wait cannot be live without its execution registered, so a miss is a real
						// inconsistency rather than a race to absorb silently.
						if (!execution) throw new FlowLedgerError("identity", "Monitored dependency has no registered execution.");
						return execution.predicates.some((predicate) => predicate.state === "pending")
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
			let next = Infinity;
			for (const { wait, handle, execution } of this.monitored(waits, authority.executions)) {
				const policy = this.options.policy(handle, wait.workId);
				// A producer that detached takes its policy with it. The wait keeps its hard deadline,
				// which is the guarantee that never depends on a responsive producer.
				if (!policy) continue;
				const verdict = assessFlowHealth(
					policy,
					execution.healthEvidence,
					now,
					execution.healthSince ?? execution.observedAt,
					wait.expiresAt,
				);
				if (verdict.state === "healthy") {
					// Evidence has gone stale when the next check is the end of grace rather than a
					// cadence step. Ask the producer once, bounded, before that grace runs out.
					const since = execution.healthSince ?? execution.observedAt;
					const staleAt = Math.max(execution.healthEvidence?.observedAt ?? since, since) + policy.freshnessMs;
					if (now >= staleAt && !this.probed.has(key(handle))) {
						this.probed.add(key(handle));
						await this.probeOnce(handle, policy.probeTimeoutMs);
						if (this.stopped) return;
						this.requested = true;
						continue;
					}
					if (now < staleAt) this.probed.delete(key(handle));
					if (verdict.nextCheckAt < wait.expiresAt) next = Math.min(next, verdict.nextCheckAt);
					continue;
				}
				// Terminal for this dependency. The execution transition guard refuses to overwrite an
				// already terminal predicate, so a decision cannot displace a real result.
				await this.options.store.observeExecution(
					{ producer: handle.producer, handle: handle.handle, execution: handle.execution },
					execution.revision + 1,
					execution.predicates.map((predicate) =>
						predicate.until === handle.until && predicate.state === "pending"
							? { until: predicate.until, state: verdict.state }
							: predicate,
					),
					now,
				);
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
