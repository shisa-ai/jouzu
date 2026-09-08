import { randomUUID } from "node:crypto";
import { chooseFlowIntent, type FlowAdmissionGates, type FlowIntent, initialFlowAdmission } from "./admission.js";
import { type FlowInputItem, FlowModelInput } from "./model-input.js";
import { FlowLedgerError, type FlowLedgerState, type FlowReceiptLedger } from "./receipt-ledger.js";
import { buildFlowResultEnvelope } from "./result-envelope.js";
import { orderFlowResultProducers } from "./result-order.js";
import { type FlowResultReference, normalizeFlowResults } from "./result-types.js";

export interface FlowProducer {
	version: 1;
	namespace: string;
	/** Replay authoritative descriptors; the producer retains work and output. */
	snapshot(signal: AbortSignal): Promise<FlowIntent[]>;
	/** Build only after selection. A new instruction needs a new descriptor revision. */
	build(intent: FlowIntent, signal: AbortSignal): Promise<FlowInputItem>;
	describeResult?(intent: FlowIntent, signal: AbortSignal): Promise<FlowResultReference>;
}
export interface FlowControllerHost {
	readonly ledger: FlowReceiptLedger;
	retainResults?(members: FlowResultReference[]): Promise<string>;
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
	deferredResults: { id: string; producer: string; reason: string }[];
	deferredDecisions: { id: string; producer: string; reason: string }[];
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
export function retainedByReceipt(intent: FlowIntent, state: FlowLedgerState): boolean {
	return state.attempts.some((attempt) => {
		if (attempt.phase === "cancelled" && attempt.consumed === false) return false;
		const selected = attempt.admission?.choice.intent;
		return (
			attempt.members.some((member) => member.id === intent.id && member.revision === intent.revision) ||
			!!(
				(intent.rank === 4 || intent.rank === 5) &&
				(selected?.rank === 4 || selected?.rank === 5) &&
				selected.workId &&
				intent.workId === selected.workId &&
				intent.workRevision === selected.workRevision
			)
		);
	});
}

/** One registry and serialized admission loop for a host. The host owns execution and receipts. */
export class SessionFlowController {
	private readonly producers = new Map<string, FlowProducer>();
	private readonly held = new Map<string, string>();
	private deferredResults: FlowControllerView["deferredResults"] = [];
	private deferredDecisions: FlowControllerView["deferredDecisions"] = [];
	private revision = 0;
	private closed = false;
	private dirty = false;
	private running?: Promise<void>;
	private closing?: Promise<void>;
	private interruption = new AbortController();

	constructor(
		private readonly host: FlowControllerHost,
		private readonly maxInputBytes: number,
		private readonly maxResultBytes: number = maxInputBytes,
	) {
		if (![maxInputBytes, maxResultBytes].every((limit) => Number.isSafeInteger(limit) && limit > 0))
			throw new FlowLedgerError("capacity", "Invalid controller input byte limit.");
		if (attached.has(host)) throw new FlowLedgerError("identity", "Host already has a session flow controller.");
		attached.add(host);
	}

	register(producer: FlowProducer, schedule?: () => Promise<void>): { changed(): Promise<void>; dispose(): void } {
		this.assertActive();
		if (
			producer?.version !== 1 ||
			!/^[a-z][a-z0-9-]{0,63}$/.test(producer.namespace) ||
			typeof producer.snapshot !== "function" ||
			typeof producer.build !== "function" ||
			(producer.describeResult !== undefined && typeof producer.describeResult !== "function")
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
				describeResult: producer.describeResult?.bind(producer),
			}),
		);
		this.revision++;
		let disposed = false;
		return {
			changed: () => {
				if (disposed) return Promise.reject(new FlowLedgerError("stale", "Flow producer registration is disposed."));
				this.held.delete(namespace);
				if (schedule) {
					this.assertActive();
					this.revision++;
					this.interruption.abort();
					this.interruption = new AbortController();
					this.host.invalidate();
					return Promise.resolve().then(() => {
						this.assertActive();
						if (disposed) throw new FlowLedgerError("stale", "Flow producer registration is disposed.");
						return schedule();
					});
				}
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
			deferredResults: structuredClone(this.deferredResults),
			deferredDecisions: structuredClone(this.deferredDecisions),
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
	private async resultMetadata(
		producer: FlowProducer,
		intent: FlowIntent,
		signal: AbortSignal,
	): Promise<FlowResultReference> {
		if (!producer.describeResult) throw new FlowLedgerError("schema", "Producer has no result metadata callback.");
		const callback = producer.describeResult;
		const [metadata] = normalizeFlowResults(
			[await cancellable(signal, () => callback(structuredClone(intent), signal))],
			1,
		);
		if (metadata.id !== intent.id || metadata.revision !== intent.revision || metadata.producer !== producer.namespace)
			throw new FlowLedgerError("identity", "Result metadata differs from its producer descriptor.");
		return metadata;
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
			const trigger = chooseFlowIntent(
				admission,
				items.filter(
					(item) =>
						!retainedByReceipt(item, state) &&
						(item.rank !== 6 ||
							!state.attempts.some(
								(attempt) =>
									attempt.consumed !== false &&
									attempt.admission?.choice.resultSnapshot?.some(
										(sample) => sample.id === item.id && sample.revision === item.revision,
									),
							)),
				),
				this.host.gate(),
			);
			if (!trigger) return;
			// A decision keeps trigger precedence while eligible work owns the fairness charge.
			const work =
				trigger.intent.rank === 3
					? chooseFlowIntent(
							admission,
							items.filter((item) => (item.rank === 4 || item.rank === 5) && !retainedByReceipt(item, state)),
							this.host.gate(),
						)
					: undefined;
			const choice = work ?? trigger;
			const decision = work ? trigger.intent : undefined;
			const decisionProducer = decision ? this.producers.get(decision.producer) : undefined;
			if (decision && !decisionProducer) return;
			const producer = this.producers.get(choice.intent.producer);
			if (!producer) return;
			const resultCandidates = items.filter(
				(item) => item.rank === 6 && item.runnable && !retainedByReceipt(item, state),
			);
			const retainResults = this.host.retainResults?.bind(this.host);
			const aggregate =
				!!retainResults &&
				resultCandidates.length > 0 &&
				resultCandidates.every((item) => this.producers.get(item.producer)?.describeResult);
			const selectedResults: { intent: FlowIntent; producer: FlowProducer; metadata?: FlowResultReference }[] = [];
			const additionalDecisions: { intent: FlowIntent; producer: FlowProducer }[] = [];
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
				const byProducer = new Map([[producer.namespace, latest]]);
				try {
					if (decision && decisionProducer) {
						if (this.producers.get(decisionProducer.namespace) !== decisionProducer) return false;
						const descriptors =
							byProducer.get(decisionProducer.namespace) ?? (await this.descriptors(decisionProducer, signal));
						byProducer.set(decisionProducer.namespace, descriptors);
						if (!descriptors.some((item) => same(item, decision) && item.runnable)) return false;
					}
					for (const extra of additionalDecisions) {
						if (this.producers.get(extra.producer.namespace) !== extra.producer) return false;
						const descriptors =
							byProducer.get(extra.producer.namespace) ?? (await this.descriptors(extra.producer, signal));
						byProducer.set(extra.producer.namespace, descriptors);
						if (!descriptors.some((item) => same(item, extra.intent) && item.runnable)) return false;
					}
					for (const result of selectedResults) {
						if (this.producers.get(result.producer.namespace) !== result.producer) return false;
						let descriptors = byProducer.get(result.producer.namespace);
						if (!descriptors) {
							descriptors = await this.descriptors(result.producer, signal);
							byProducer.set(result.producer.namespace, descriptors);
						}
						if (!descriptors.some((item) => same(item, result.intent) && item.runnable)) return false;
						if (
							result.metadata &&
							JSON.stringify(await this.resultMetadata(result.producer, result.intent, signal)) !==
								JSON.stringify(result.metadata)
						)
							return false;
					}
				} catch (error) {
					if (signal.aborted) return false;
					throw error;
				}
				return (
					!this.closed &&
					revision === this.revision &&
					!!current &&
					!!chooseFlowIntent(admission, [current], { ...this.host.gate(), hostReady: true })
				);
			};
			let input: FlowModelInput;
			try {
				const item =
					aggregate && choice.intent.rank === 6
						? undefined
						: await cancellable(signal, () => producer.build(structuredClone(choice.intent), signal));
				if (
					item &&
					(item.id !== choice.intent.id ||
						item.revision !== choice.intent.revision ||
						item.kind !== ({ 2: "alert", 3: "wait", 4: "work", 5: "work", 6: "result" } as const)[choice.intent.rank])
				)
					throw new FlowLedgerError("identity", "Built input differs from the selected descriptor.");
				const attemptId = randomUUID();
				const built: FlowInputItem[] = item ? [item] : [];
				if (decision && decisionProducer) {
					const outcome = await cancellable(signal, () => decisionProducer.build(structuredClone(decision), signal));
					if (outcome.id !== decision.id || outcome.revision !== decision.revision || outcome.kind !== "wait")
						throw new FlowLedgerError("identity", "Built wait decision differs from its descriptor.");
					built.unshift(outcome);
				}
				this.deferredDecisions = [];
				// Required trigger/work must fit before additional terminal outcomes consume capacity.
				if (built.length) FlowModelInput.compose(attemptId, built, this.maxInputBytes);
				for (const extra of items
					.filter(
						(candidate) =>
							candidate.rank === 3 &&
							candidate.runnable &&
							candidate.id !== choice.intent.id &&
							candidate.id !== decision?.id &&
							!retainedByReceipt(candidate, state),
					)
					.sort((a, b) => a.sequence - b.sequence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
					const owner = this.producers.get(extra.producer);
					if (!owner) return;
					try {
						const outcome = await cancellable(signal, () => owner.build(structuredClone(extra), signal));
						if (outcome.id !== extra.id || outcome.revision !== extra.revision || outcome.kind !== "wait")
							throw new FlowLedgerError("identity", "Built wait decision differs from its descriptor.");
						FlowModelInput.compose(attemptId, [...built, outcome], this.maxInputBytes);
						built.push(outcome);
						additionalDecisions.push({ intent: extra, producer: owner });
					} catch (error) {
						if (signal.aborted) return;
						this.deferredDecisions.push({
							id: extra.id,
							producer: extra.producer,
							reason: error instanceof Error ? error.message : "Wait decision input unavailable.",
						});
					}
				}
				this.deferredResults = [];
				if (aggregate && retainResults) {
					const members: FlowResultReference[] = [];
					for (const intent of resultCandidates) {
						const owner = this.producers.get(intent.producer);
						if (!owner) return;
						try {
							const metadata = await this.resultMetadata(owner, intent, signal);
							members.push(metadata);
							selectedResults.push({ intent, producer: owner, metadata });
						} catch (error) {
							if (signal.aborted) return;
							this.held.set(owner.namespace, error instanceof Error ? error.message : "Result metadata unavailable.");
							if (intent.id === choice.intent.id) {
								skipped = true;
								return;
							}
						}
					}
					if (members.length) {
						const available = built.length
							? this.maxInputBytes - FlowModelInput.compose(attemptId, built, this.maxInputBytes).bytes + 1
							: this.maxInputBytes;
						try {
							const envelope = await buildFlowResultEnvelope({
								attemptId,
								id: choice.intent.rank === 6 ? choice.intent.id : `results:${randomUUID()}`,
								revision: choice.intent.rank === 6 ? choice.intent.revision : "1",
								members,
								producerOrder: orderFlowResultProducers(resultCandidates, state),
								maxBytes: Math.min(this.maxResultBytes, available),
								retain: retainResults,
							});
							built.push(envelope.item);
							choice.resultSamples = envelope.envelope.sample.map(({ id, revision }) => ({ id, revision }));
						} catch (error) {
							if (!(error instanceof FlowLedgerError && error.code === "capacity") || !built.length) throw error;
							this.deferredResults = members.map((member) => ({
								id: member.id,
								producer: member.producer,
								reason: "Aggregate metadata exceeds available capacity.",
							}));
							selectedResults.length = 0;
							choice.resultSamples = [];
						}
					}
					input = FlowModelInput.compose(attemptId, built, this.maxInputBytes);
				} else {
					input = FlowModelInput.compose(attemptId, built, this.maxInputBytes);
					// One oldest result per producer per pass prevents a large producer from owning the batch.
					const results = new Map<string, FlowIntent[]>();
					for (const result of items
						.filter(
							(candidate) =>
								candidate.rank === 6 &&
								candidate.runnable &&
								candidate.id !== choice.intent.id &&
								!retainedByReceipt(candidate, state),
						)
						.sort((a, b) => a.sequence - b.sequence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
						const group = results.get(result.producer) ?? [];
						group.push(result);
						results.set(result.producer, group);
					}
					const order = orderFlowResultProducers(
						items.filter((item) => item.rank === 6 && item.runnable && !retainedByReceipt(item, state)),
						state,
					);
					const ordered = new Map(
						order.flatMap((namespace) => {
							const group = results.get(namespace);
							return group ? [[namespace, group] as const] : [];
						}),
					);
					results.clear();
					for (const [namespace, group] of ordered) results.set(namespace, group);
					if (choice.intent.rank === 6) {
						const own = results.get(producer.namespace);
						if (own) {
							results.delete(producer.namespace);
							results.set(producer.namespace, own);
						}
					}
					while (results.size) {
						for (const [namespace, group] of results) {
							const result = group.shift();
							if (!group.length) results.delete(namespace);
							const owner = this.producers.get(namespace);
							if (!result || !owner || this.held.has(namespace)) continue;
							try {
								const content = await cancellable(signal, () => owner.build(structuredClone(result), signal));
								if (content.id !== result.id || content.revision !== result.revision || content.kind !== "result")
									throw new FlowLedgerError("identity", "Built result differs from its descriptor.");
								const composed = FlowModelInput.compose(attemptId, [...built, content], this.maxInputBytes);
								built.push(content);
								selectedResults.push({ intent: result, producer: owner });
								input = composed;
							} catch (error) {
								if (signal.aborted) return;
								if (error instanceof FlowLedgerError && error.code === "capacity")
									this.deferredResults.push({
										id: result.id,
										producer: namespace,
										reason: "Result exceeds the remaining composed-input capacity.",
									});
								else this.held.set(namespace, error instanceof Error ? error.message : "Result input unavailable.");
							}
						}
					}
				}
				if (!(await valid())) return;
			} catch (error) {
				if (signal.aborted) return;
				this.held.set(producer.namespace, error instanceof Error ? error.message : "Producer input unavailable.");
				skipped = true;
				return;
			}
			choice.resultSnapshot = items
				.filter((item) => item.rank === 6 && item.runnable && !retainedByReceipt(item, state))
				.sort((a, b) => a.sequence - b.sequence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
				.map(({ id, revision, producer }) => ({ id, revision, producer }));
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
