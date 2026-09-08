import { randomUUID } from "node:crypto";
import { chooseFlowIntent, type FlowAdmissionGates, type FlowIntent, initialFlowAdmission } from "./admission.js";
import { type FlowInputItem, FlowModelInput } from "./model-input.js";
import { FlowLedgerError, type FlowLedgerState, type FlowReceiptLedger } from "./receipt-ledger.js";

export interface FlowProducer {
	version: 1;
	namespace: string;
	/** Replay authoritative descriptors; the producer retains work and output. */
	snapshot(signal: AbortSignal): Promise<FlowIntent[]>;
	/** Build only after selection. A new instruction needs a new descriptor revision. */
	build(intent: FlowIntent, signal: AbortSignal): Promise<FlowInputItem>;
}
export interface FlowControllerHost {
	readonly ledger: FlowReceiptLedger;
	gate(): FlowAdmissionGates;
	atIdle<T>(run: () => Promise<T>): Promise<{ kind: "busy" } | { kind: "idle"; value: T }>;
	enqueue(input: FlowModelInput, valid: () => Promise<boolean>): Promise<void>;
	run(): Promise<void>;
	reconcile(attemptId: string): Promise<void>;
	/** Synchronously revoke native unconsumed input; receipt reconciliation follows. */
	invalidate(): void;
	abort(): Promise<void>;
	close(): Promise<void>;
}
export interface FlowControllerView {
	state: "idle" | "running" | "closed";
	producers: string[];
	held: { producer: string; reason: string }[];
}
const same = (a: FlowIntent, b: FlowIntent) =>
	a.id === b.id &&
	a.revision === b.revision &&
	a.producer === b.producer &&
	a.sequence === b.sequence &&
	a.rank === b.rank &&
	a.workId === b.workId &&
	a.workRevision === b.workRevision &&
	a.independent === b.independent &&
	a.runnable === b.runnable;

const attached = new WeakSet<FlowControllerHost>();
async function cancellable<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
	signal.throwIfAborted();
	let rejectAbort: () => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = () => reject(signal.reason);
		signal.addEventListener("abort", rejectAbort, { once: true });
	});
	try {
		return await Promise.race([run(), aborted]);
	} finally {
		signal.removeEventListener("abort", rejectAbort);
	}
}

/** Consumed input never becomes an automatic replay merely because a producer repeats its descriptor. */
function retainedByReceipt(intent: FlowIntent, state: FlowLedgerState): boolean {
	return state.attempts.some((attempt) => {
		if (attempt.phase === "cancelled" && attempt.consumed === false) return false;
		const selected = attempt.admission?.choice.intent;
		return (
			attempt.members.some((member) => member.id === intent.id && member.revision === intent.revision) ||
			!!(selected?.workId && intent.workId === selected.workId && intent.workRevision === selected.workRevision)
		);
	});
}

/** One registry and serialized admission loop for a host. The host owns execution and receipts. */
export class SessionFlowController {
	private readonly producers = new Map<string, FlowProducer>();
	private readonly held = new Map<string, string>();
	private revision = 0;
	private closed = false;
	private dirty = false;
	private running?: Promise<void>;
	private closing?: Promise<void>;
	private interruption = new AbortController();

	constructor(
		private readonly host: FlowControllerHost,
		private readonly maxInputBytes: number,
	) {
		if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1)
			throw new FlowLedgerError("capacity", "Invalid controller input byte limit.");
		if (attached.has(host)) throw new FlowLedgerError("identity", "Host already has a session flow controller.");
		attached.add(host);
	}

	register(producer: FlowProducer): { changed(): Promise<void>; dispose(): void } {
		this.assertActive();
		if (
			producer?.version !== 1 ||
			!/^[a-z][a-z0-9-]{0,63}$/.test(producer.namespace) ||
			typeof producer.snapshot !== "function" ||
			typeof producer.build !== "function"
		)
			throw new FlowLedgerError("schema", "Unsupported flow producer registration.");
		if (this.producers.has(producer.namespace))
			throw new FlowLedgerError("identity", "Flow producer namespace is already registered.");
		const namespace = producer.namespace;
		this.producers.set(
			namespace,
			Object.freeze({
				version: 1,
				namespace,
				snapshot: producer.snapshot.bind(producer),
				build: producer.build.bind(producer),
			}),
		);
		this.revision++;
		let disposed = false;
		return {
			changed: () => {
				if (disposed) return Promise.reject(new FlowLedgerError("stale", "Flow producer registration is disposed."));
				this.held.delete(namespace);
				return this.wake();
			},
			dispose: () => {
				if (disposed) return;
				disposed = true;
				this.producers.delete(namespace);
				this.held.delete(namespace);
				this.revision++;
				this.dirty = !!this.running;
				this.interruption.abort();
				this.interruption = new AbortController();
				this.host.invalidate();
			},
		};
	}

	view(): FlowControllerView {
		return {
			state: this.closed ? "closed" : this.running ? "running" : "idle",
			producers: [...this.producers.keys()].sort(),
			held: [...this.held].map(([producer, reason]) => ({ producer, reason })),
		};
	}
	private assertActive(): void {
		if (this.closed) throw new FlowLedgerError("stale", "Flow controller is closed.");
	}
	/** Lifecycle, user-input, and producer changes share this same scheduling entry point. */
	wake(): Promise<void> {
		this.assertActive();
		this.revision++;
		this.interruption.abort();
		this.interruption = new AbortController();
		this.dirty = true;
		this.host.invalidate();
		this.running ??= Promise.resolve()
			.then(async () => {
				do {
					this.dirty = false;
					const advanced = await this.step();
					if (!advanced && !this.dirty) break;
				} while (!this.closed);
			})
			.finally(() => {
				this.running = undefined;
				if (this.dirty && !this.closed) return this.wake();
			});
		return this.running;
	}
	private async descriptors(producer: FlowProducer, signal: AbortSignal): Promise<FlowIntent[]> {
		const items = structuredClone(await cancellable(signal, () => producer.snapshot(signal)));
		if (!Array.isArray(items) || items.some((item) => item.producer !== producer.namespace))
			throw new FlowLedgerError("identity", "Producer descriptors have a foreign namespace.");
		// Validate descriptors without selecting work or mutating fairness state.
		chooseFlowIntent(initialFlowAdmission(), items, {
			hostReady: false,
			userPending: false,
			recoveryBlocked: false,
			waitingWorkIds: [],
		});
		return items;
	}
	private async step(): Promise<boolean> {
		const active = (await this.host.ledger.snapshot()).activeAttemptId;
		if (active) await this.host.reconcile(active);
		let selected: { input: FlowModelInput; valid: () => Promise<boolean> } | undefined;
		let skipped = false;
		const boundary = await this.host.atIdle(async () => {
			if (this.closed) return;
			const revision = this.revision;
			const signal = this.interruption.signal;
			const state = await this.host.ledger.snapshot();
			const admission = state.admission;
			if (!admission) throw new FlowLedgerError("schema", "Controller admission state is missing.");
			if (state.activeAttemptId) return;
			const items: FlowIntent[] = [];
			for (const producer of this.producers.values()) {
				if (this.held.has(producer.namespace)) continue;
				try {
					items.push(...(await this.descriptors(producer, signal)));
				} catch (error) {
					if (signal.aborted) return;
					this.held.set(producer.namespace, error instanceof Error ? error.message : "Producer state unavailable.");
				}
			}
			if (this.closed || revision !== this.revision) return;
			const choice = chooseFlowIntent(
				admission,
				items.filter((item) => !retainedByReceipt(item, state)),
				this.host.gate(),
			);
			if (!choice) return;
			const producer = this.producers.get(choice.intent.producer);
			if (!producer) return;
			const valid = async () => {
				if (this.closed || revision !== this.revision || this.producers.get(producer.namespace) !== producer)
					return false;
				const gate = this.host.gate();
				// Native execution owns the host at claim; only policy/user gates apply there.
				if (gate.userPending || gate.recoveryBlocked) return false;
				let latest: FlowIntent[];
				try {
					latest = await this.descriptors(producer, signal);
				} catch (error) {
					if (signal.aborted) return false;
					throw error;
				}
				const current = latest.find((item) => same(item, choice.intent));
				return (
					!this.closed &&
					revision === this.revision &&
					!!current &&
					!!chooseFlowIntent(admission, [current], { ...this.host.gate(), hostReady: true })
				);
			};
			let input: FlowModelInput;
			try {
				const item = await cancellable(signal, () => producer.build(structuredClone(choice.intent), signal));
				if (
					item.id !== choice.intent.id ||
					item.revision !== choice.intent.revision ||
					item.kind !== ({ 2: "alert", 3: "wait", 4: "work", 5: "work", 6: "result" } as const)[choice.intent.rank]
				)
					throw new FlowLedgerError("identity", "Built input differs from the selected descriptor.");
				input = FlowModelInput.compose(randomUUID(), [item], this.maxInputBytes);
				if (!(await valid())) return;
			} catch (error) {
				if (signal.aborted) return;
				this.held.set(producer.namespace, error instanceof Error ? error.message : "Producer input unavailable.");
				skipped = true;
				return;
			}
			await this.host.ledger.select(input.attemptId, input.members, choice);
			selected = { input, valid };
		});
		if (boundary.kind === "busy" || !selected) return skipped;
		const { input, valid } = selected;
		try {
			if (await valid()) {
				await this.host.enqueue(input, valid);
				await this.host.run();
			} else await this.host.ledger.cancel(input.attemptId, "Flow input changed before enqueue.");
		} finally {
			await this.host.reconcile(input.attemptId);
		}
		const state = await this.host.ledger.snapshot();
		return !state.activeAttemptId && state.attempts.some((item) => item.id === input.attemptId && item.consumed);
	}
	close(): Promise<void> {
		this.closing ??= (async () => {
			this.closed = true;
			this.revision++;
			this.interruption.abort();
			this.host.invalidate();
			try {
				await this.host.abort();
				await this.running;
			} finally {
				await this.host.close();
				this.producers.clear();
			}
		})();
		return this.closing;
	}
}
