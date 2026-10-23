import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { NativeRequestSource } from "./native-request-store.js";
import { PiHostHooks } from "./pi-host-hooks.js";
import { PiNativeHistory } from "./pi-native-history.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import type {
	FlowNativeInput,
	FlowNativeObserver,
	FlowSubmissionStore,
	RetainedSubmission,
} from "./submission-store.js";

interface Frame {
	active: boolean;
	operationId: string;
	observer: FlowNativeObserver;
	writes: Promise<unknown>[];
	context: boolean;
	nextTurn: boolean;
	nextTurnObserved?: boolean;
	contextInput?: { index: number; message: AgentMessage };
}
interface QueuedObservation {
	operationId: string;
	revision: number;
	write: Promise<unknown>;
	/** The revision the sender was given is already recorded as not delivered. */
	invalidated?: boolean;
}
const attached = new WeakSet<AgentSession>();

/** Observe native input inside one retained dispatch, without rerunning prompt normalization. */
export class PiNativeDispatch {
	private readonly hooks = new PiHostHooks();
	private readonly frames = new AsyncLocalStorage<Frame>();
	private readonly queued = new Map<string, QueuedObservation>();
	private readonly deferred = new Map<string, { inputIndex: number; cancel: () => boolean; removed?: boolean }>();
	private readonly held = new Map<string, { id: string; revision: number; reason: string }>();
	private readonly sessionId: string;
	private readonly contextWrites = new Set<Promise<void>>();
	/** Queue-removal evidence this observation owes the journal. Tracked writes never reject. */
	private readonly queueWrites = new Set<Promise<void>>();
	private queueFailure = false;
	/** Advances on reset, so a write from the discarded journal lifetime cannot report a failure. */
	private queueGeneration = 0;
	/** Native queue mutations this observation issues itself, whose evidence it already records. */
	private selfMutation = 0;
	/** Depth of the open queue-mutation bracket; nested mutations delegate to it. */
	private queueBracket = 0;
	private contextFailure = false;
	private active = 0;
	private closed = false;
	private drained?: () => void;
	private closing?: Promise<void>;
	private readonly enabled: () => boolean;
	private readonly history: PiNativeHistory;
	constructor(
		private readonly session: AgentSession,
		private readonly store: FlowSubmissionStore,
		private readonly admitQueued?: (record: RetainedSubmission, input: FlowNativeInput) => Promise<boolean>,
		/** Flow control is on. While it is off, permits from finished dispatches are ignored. */
		flowEnabled?: () => boolean,
	) {
		if (session.sessionId !== store.scope.sessionId)
			throw new FlowLedgerError("scope", "Native observation requires matching session storage.");
		if (attached.has(session))
			throw new FlowLedgerError("identity", "Pi session already has native dispatch observation.");
		attached.add(session);
		this.enabled = flowEnabled ?? (() => true);
		this.sessionId = session.sessionId;
		this.history = new PiNativeHistory(session, store);
		const agent = session.agent;
		const prompt = agent.prompt.bind(agent);
		this.hooks.set(agent, "prompt", async (input: string | AgentMessage | AgentMessage[], images?: ImageContent[]) => {
			const frame = this.frame();
			if (!frame) return typeof input === "string" ? prompt(input, images) : prompt(input);
			const original = Array.isArray(input) ? [...input] : input;
			const [captured, capturedImages] = structuredClone([original, images] as const);
			const observedInput = structuredClone(this.history.promptInput(original));
			const inputIndex = await frame.observer.observe({ kind: "prompt", args: [observedInput, capturedImages] });
			this.frame();
			// Let Pi reject concurrent execution without attaching input to the running prompt.
			if (agent.state.isStreaming)
				return typeof captured === "string" ? prompt(captured, capturedImages) : prompt(captured);
			const release = this.history.observePrompt(frame.operationId, inputIndex, captured, capturedImages, original);
			try {
				return await (typeof captured === "string" ? prompt(captured, capturedImages) : prompt(captured));
			} finally {
				release();
			}
		});
		for (const kind of ["steer", "followUp"] as const) {
			const enqueue = agent[kind].bind(agent);
			this.hooks.set(agent, kind, (message) => {
				const frame = this.frame();
				if (!frame) return enqueue(message);
				const args = structuredClone([message]);
				const queue = enqueue(structuredClone(message));
				let write: Promise<unknown>;
				try {
					write = frame.observer.observe({ kind, args, queue });
				} catch (error) {
					this.mutateNativeQueue(() => agent.cancelQueuedMessage(queue.id, queue.revision));
					throw error;
				}
				this.queued.set(queue.id, { operationId: frame.operationId, revision: queue.revision, write });
				// A failed observation is its dispatch's error, so it leaves no receipt to correct. The entry
				// stays observed: the claim checkpoint still has to refuse the revision the flow did not retain.
				write.catch(() => this.mutateNativeQueue(() => agent.cancelQueuedMessage(queue.id, queue.revision)));
				frame.writes.push(write);
				return queue;
			});
		}
		// Every supported host path that drops or re-revisions queued input leaves no journal evidence on
		// its own. Without a newer journal revision the receipt stays `queued` at the revision the sender
		// already accepted, and ordering drops the correction. Each path runs inside one bracket that
		// records exactly what it invalidated.
		const cancelQueuedMessage = agent.cancelQueuedMessage.bind(agent);
		this.hooks.set(agent, "cancelQueuedMessage", (id, revision) =>
			this.selfMutation
				? cancelQueuedMessage(id, revision)
				: this.queueMutationBracket(() => cancelQueuedMessage(id, revision)),
		);
		const editQueuedMessage = agent.editQueuedMessage.bind(agent);
		this.hooks.set(agent, "editQueuedMessage", (id, revision, message) =>
			this.selfMutation
				? editQueuedMessage(id, revision, message)
				: this.queueMutationBracket(() => editQueuedMessage(id, revision, message)),
		);
		const clearSteeringQueue = agent.clearSteeringQueue.bind(agent);
		this.hooks.set(agent, "clearSteeringQueue", () =>
			this.selfMutation ? clearSteeringQueue() : this.queueMutationBracket(clearSteeringQueue),
		);
		const clearFollowUpQueue = agent.clearFollowUpQueue.bind(agent);
		this.hooks.set(agent, "clearFollowUpQueue", () =>
			this.selfMutation ? clearFollowUpQueue() : this.queueMutationBracket(clearFollowUpQueue),
		);
		// The session clear reaches the lane clears through `agent.clearAllQueues`, so its bracket is the
		// outer one and the nested lane brackets only delegate to it.
		const clearQueue = session.clearQueue.bind(session);
		this.hooks.set(session, "clearQueue", () =>
			this.selfMutation ? clearQueue() : this.queueMutationBracket(clearQueue),
		);
		const nextTurn = session.flowNextTurn;
		this.hooks.set(session, "flowNextTurn", async (message, cancel) => {
			const frame = this.frame();
			if (!frame) return nextTurn?.(message, cancel);
			if (!frame.nextTurn || frame.nextTurnObserved)
				throw new FlowLedgerError("identity", "Unexpected deferred context in native dispatch.");
			const captured = structuredClone(message);
			const index = await frame.observer.observe({ kind: "context", args: [{ ...captured, timestamp: 0 }] });
			await nextTurn?.(message, cancel);
			this.frame();
			if (!isDeepStrictEqual(message, captured))
				throw new FlowLedgerError("identity", "Deferred context changed during observation.");
			this.history.observeNextTurn(frame.operationId, index, message);
			this.deferred.set(frame.operationId, { inputIndex: index, cancel });
			frame.nextTurnObserved = true;
		});
		const manager = session.sessionManager;
		const append = manager.appendCustomMessageEntry.bind(manager);
		this.hooks.set(manager, "appendCustomMessageEntry", (customType, content, display, details, emitted) => {
			const frame = this.frame();
			if (!frame?.context) return append(customType, content, display, details);
			const observed = frame.contextInput;
			// Pi 0.87 builds agent state from the session projection, so the appended message is not in
			// state yet and a refresh rebuilds its object. The idle append passes the object it emitted,
			// which the projection retains; compare the fields it persists against the message the
			// observation reviewed so the receipt binds to a message the flow actually saw.
			if (!observed) throw new FlowLedgerError("identity", "Unexpected non-waking context append.");
			const observedMessage = observed.message;
			if (
				observedMessage.role !== "custom" ||
				observedMessage.customType !== customType ||
				!isDeepStrictEqual(observedMessage.content, content) ||
				observedMessage.display !== display ||
				!isDeepStrictEqual(observedMessage.details, details)
			)
				throw new FlowLedgerError("identity", "Non-waking context differs from its retained input.");
			if (!emitted || !isDeepStrictEqual({ ...emitted, timestamp: 0 }, observedMessage))
				throw new FlowLedgerError("identity", "Non-waking emitted context differs from its retained input.");
			const message = emitted;
			frame.contextInput = undefined;
			const entryId = append(customType, content, display, details);
			const write = this.history.recordContext(session, store, frame.operationId, observed.index, message, entryId);
			this.contextWrites.add(write);
			frame.writes.push(write);
			void write.then(
				() => this.contextWrites.delete(write),
				() => {
					this.contextWrites.delete(write);
					this.contextFailure = true;
				},
			);
			return entryId;
		});

		const previous = agent.flowCheckpoints;
		this.hooks.set(agent, "flowCheckpoints", {
			...previous,
			beforeQueueClaim: async (items, signal) => {
				this.assertActive();
				let edited = false;
				await Promise.all(
					items.map((item) => {
						const observation = this.queued.get(item.id);
						if (observation && observation.revision !== item.revision) {
							edited = true;
							this.held.set(item.id, {
								id: item.id,
								revision: item.revision,
								reason: "Edited native input requires a new observation.",
							});
						}
						return observation?.write.catch(() => {
							edited = true;
							this.held.set(item.id, {
								id: item.id,
								revision: item.revision,
								reason: "Native input observation could not be retained.",
							});
						});
					}),
				);
				if (edited) return false;
				const accepted = previous?.beforeQueueClaim ? await previous.beforeQueueClaim(items, signal) : true;
				this.assertActive();
				if (!accepted) return false;
				const operations = items.flatMap((item) => {
					const observed = this.queued.get(item.id);
					return observed ? [observed.operationId] : [];
				});
				const records = await this.store.forOperations(operations);
				const selected = new Map<string, number>();
				for (const item of items) {
					const observed = this.queued.get(item.id);
					if (!observed) continue;
					const record = records.find((record) => record.dispatch?.operationId === observed.operationId);
					const input = record?.dispatch?.inputs?.find(
						(input) => input.queue?.id === item.id && input.queue.revision === item.revision,
					);
					if (
						record?.status !== "retained" ||
						!input ||
						record.dispatch?.queueCancellations?.some((cancelled) => cancelled.id === item.id)
					)
						return false;
					if (this.admitQueued) {
						let allowed: boolean;
						try {
							allowed = await this.admitQueued(structuredClone(record), structuredClone(input));
						} catch {
							this.assertActive();
							signal?.throwIfAborted();
							this.held.set(item.id, {
								id: item.id,
								revision: item.revision,
								reason: "Queue admission could not complete.",
							});
							return false;
						}
						if (!allowed) {
							this.held.set(item.id, {
								id: item.id,
								revision: item.revision,
								reason: "Queued input is held by session policy.",
							});
							return false;
						}
						this.held.delete(item.id);
					}
					selected.set(record.id, record.revision);
				}
				const current = await this.store.forOperations(operations);
				this.assertActive();
				signal?.throwIfAborted();
				return [...selected].every(([id, revision]) =>
					current.some(
						(record) =>
							record.id === id &&
							record.revision === revision &&
							record.status === "retained" &&
							!record.dispatch?.queueCancellations?.some((cancelled) => items.some((item) => item.id === cancelled.id)),
					),
				);
			},
			afterQueueClaim: async (receipt, signal) => {
				this.assertActive();
				for (const item of receipt.candidates) {
					const observed = this.queued.get(item.id);
					if (!observed) continue;
					await observed.write;
					await this.store.recordQueueClaim(
						observed.operationId,
						{ id: item.id, revision: item.revision },
						receipt.claimed.some((claimed) => claimed.id === item.id && claimed.revision === item.revision),
					);
				}
				await previous?.afterQueueClaim?.(receipt, signal);
				const records = await this.store.forOperations(
					receipt.claimed.flatMap((item) => {
						const observed = this.queued.get(item.id);
						return observed ? [observed.operationId] : [];
					}),
				);
				this.assertActive();
				for (const item of receipt.claimed) {
					const observed = this.queued.get(item.id);
					if (
						observed &&
						!records.some(
							(record) =>
								record.dispatch?.operationId === observed.operationId &&
								record.status === "retained" &&
								!record.dispatch.queueCancellations?.some((cancelled) => cancelled.id === item.id),
						)
					)
						throw new FlowLedgerError("stale", "Native input was cancelled during queue consumption.");
				}
				this.history.accept(
					receipt.claimed.map((item) => ({
						...item,
						operationId: this.queued.get(item.id)?.operationId,
					})),
				);
				for (const item of receipt.candidates)
					if (!agent.inspectQueuedMessages().some((queued) => queued.id === item.id)) this.queued.delete(item.id);
			},
		});
	}
	private assertActive(): void {
		if (this.closed || this.session.sessionId !== this.sessionId)
			throw new FlowLedgerError("stale", "Native dispatch observation is closed or replaced.");
	}
	/**
	 * Record the exact observed queue revisions one supported native mutation invalidated.
	 *
	 * The host clears queued input by identity-free calls, removes it by identity, and re-revisions it by
	 * edit, so its removal alone proves nothing durable. Nested mutations delegate to the outermost
	 * bracket, so one change is recorded once. An entry still queued at a newer revision keeps its
	 * observation, because the claim checkpoint still has to refuse the revision the flow did not review.
	 */
	private queueMutationBracket<T>(run: () => T): T {
		if (this.queueBracket) return run();
		// A native claim removes entries before awaiting its durable receipt. Those absent before this
		// mutation belong to that claim, not to this call. Match IDs rather than revisions so an edited
		// entry removed here still invalidates the revision the sender was originally given.
		const before = new Set(this.session.agent.inspectQueuedMessages().map((item) => item.id));
		this.queueBracket = 1;
		try {
			return run();
		} finally {
			this.queueBracket = 0;
			const live = new Map(this.session.agent.inspectQueuedMessages().map((item) => [item.id, item.revision]));
			for (const [id, observed] of [...this.queued]) {
				if (!before.has(id)) continue;
				const revision = live.get(id);
				if (revision === observed.revision) continue;
				if (observed.invalidated) {
					if (revision === undefined) this.forgetQueue(id);
					continue;
				}
				this.recordQueueInvalidation(id, observed, revision !== undefined);
			}
		}
	}
	/** Persist that one observed identity is no longer live at the revision the sender was given. */
	private recordQueueInvalidation(id: string, observed: QueuedObservation, stillQueued: boolean): void {
		if (stillQueued) observed.invalidated = true;
		else this.forgetQueue(id);
		const generation = this.queueGeneration;
		// A failed observation already failed its dispatch, so it leaves no receipt to correct.
		const write = observed.write.then(
			() => this.store.recordQueueClaim(observed.operationId, { id, revision: observed.revision }, false),
			() => {},
		);
		// Only the journal lifetime that owns this write reports its failure. A reset discards the records
		// it describes, so its late rejection must not pause unrelated work in the new lifetime.
		const settled = write.then(
			() => {},
			() => {
				if (generation === this.queueGeneration) this.queueFailure = true;
			},
		);
		this.queueWrites.add(settled);
		void settled.then(() => this.queueWrites.delete(settled));
	}
	private forgetQueue(id: string): void {
		this.queued.delete(id);
		this.held.delete(id);
	}
	/** Issue a native queue mutation whose own durable evidence this observation already records. */
	private mutateNativeQueue<T>(run: () => T): T {
		this.selfMutation++;
		try {
			return run();
		} finally {
			this.selfMutation--;
		}
	}
	private async drainContext(): Promise<void> {
		await Promise.all([...this.contextWrites, ...this.queueWrites]);
		if (this.contextFailure)
			throw new FlowLedgerError("identity", "Non-waking context requires receipt reconciliation.");
		if (this.queueFailure) throw new FlowLedgerError("identity", "Queue removal requires receipt reconciliation.");
	}

	async consumedSources() {
		this.assertActive();
		await this.drainContext();
		const records = await this.store.snapshot();
		this.assertActive();
		return records.flatMap(({ dispatch }) =>
			dispatch
				? [
						...(dispatch.promptClaims ?? []).map((prompt) => ({ operationId: dispatch.operationId, prompt })),
						...(dispatch.queueClaims ?? [])
							.filter((claim) => claim.consumed)
							.map(({ id, revision }) => ({ operationId: dispatch.operationId, queue: { id, revision } })),
					]
				: [],
		);
	}
	async sources(messages: AgentMessage[]): Promise<NativeRequestSource[]> {
		this.assertActive();
		await this.drainContext();
		const members = this.history.identify(messages);
		await this.history.validateSources(members, this.store);
		this.assertActive();
		return members;
	}
	async recoverSources(atRequestBoundary = false): Promise<{ recovered: number; unresolved: number }> {
		this.assertActive();
		if (this.active && !atRequestBoundary)
			throw new FlowLedgerError("busy", "Native source recovery requires drained dispatch.");
		this.active++;
		try {
			return await this.history.recover(this.session, this.store, () => this.assertActive(), atRequestBoundary);
		} finally {
			this.active--;
			if (!this.active) this.drained?.();
		}
	}
	/** Re-observe the reviewed live revision without replacing Pi's queue entry or appending history. */
	async reconcileQueueEdit(id: string, revision: number): Promise<void> {
		this.assertActive();
		const item = this.session.agent
			.inspectQueuedMessages()
			.find((item) => item.id === id && item.revision === revision);
		const observed = this.queued.get(id);
		if (!item || !observed) throw new FlowLedgerError("stale", "Native edit has no matching live queue observation.");
		if (revision === observed.revision) return;
		this.active++;
		try {
			await observed.write;
			await this.store.recordQueueEdit(
				observed.operationId,
				{ id, revision: observed.revision },
				{
					kind: item.lane,
					args: [item.message],
					queue: { id, revision },
				},
			);
			this.assertActive();
			if (this.queued.get(id) !== observed)
				throw new FlowLedgerError("stale", "Native edit observation changed during reconciliation.");
			this.queued.set(id, { operationId: observed.operationId, revision, write: Promise.resolve() });
			if (
				!this.session.agent
					.inspectQueuedMessages()
					.some((current) => current.id === id && current.revision === revision)
			)
				throw new FlowLedgerError("stale", "Native queue changed while its edit was retained.");
			this.held.delete(id);
		} finally {
			this.active--;
			if (!this.active) this.drained?.();
		}
	}
	/** Run under the session queue-maintenance boundary; persist intent before native removal. */
	async cancelQueue(id: string, revision: number): Promise<void> {
		this.assertActive();
		const item = this.session.agent
			.inspectQueuedMessages()
			.find((item) => item.id === id && item.revision === revision);
		const observed = this.queued.get(id);
		if (!item || !observed) {
			const records = await this.store.snapshot();
			this.assertActive();
			if (
				!item &&
				records.some(
					(record) =>
						record.dispatch?.queueCancellations?.some(
							(cancelled) => cancelled.id === id && cancelled.revision === revision,
						) &&
						record.dispatch.queueClaims?.some(
							(claim) => claim.id === id && claim.revision === revision && !claim.consumed,
						),
				)
			)
				return;
			throw new FlowLedgerError("stale", "Queue cancellation has no matching live input.");
		}
		this.active++;
		try {
			await observed.write;
			if (observed.revision !== revision) await this.reconcileQueueEdit(id, revision);
			await this.store.cancelQueue(observed.operationId, { id, revision });
			this.assertActive();
			const result = this.mutateNativeQueue(() => this.session.agent.cancelQueuedMessage(id, revision));
			if (result.kind !== "cancelled") throw new FlowLedgerError("stale", "Native queue changed during cancellation.");
			await this.store.recordQueueClaim(observed.operationId, { id, revision }, false);
			this.queued.delete(id);
			this.held.delete(id);
		} finally {
			this.active--;
			if (!this.active) this.drained?.();
		}
	}

	async cancelContext(id: string, revision: number, inputIndex: number): Promise<void> {
		this.assertActive();
		this.active++;
		try {
			const record = (await this.store.forIds([id])).find((record) => record.revision === revision);
			this.assertActive();
			if (!record?.dispatch) throw new FlowLedgerError("stale", "Deferred cancellation has no matching submission.");
			if (record.dispatch.contextCancellations?.some((item) => item.inputIndex === inputIndex && item.removed)) return;
			const pending = this.deferred.get(record.dispatch.operationId);
			if (!pending || pending.inputIndex !== inputIndex)
				throw new FlowLedgerError("stale", "Deferred cancellation has no matching live input.");
			await this.store.cancelContext(record.dispatch.operationId, inputIndex);
			this.assertActive();
			if (!pending.removed) {
				if (!pending.cancel())
					throw new FlowLedgerError("stale", "Deferred cancellation requires removal reconciliation.");
				pending.removed = true;
			}
			await this.store.confirmContextCancellation(record.dispatch.operationId, inputIndex);
			this.deferred.delete(record.dispatch.operationId);
		} finally {
			this.active--;
			if (!this.active) this.drained?.();
		}
	}

	heldInputs(): { id: string; revision: number; reason: string }[] {
		const queued = this.session.agent.inspectQueuedMessages();
		for (const id of this.held.keys()) if (!queued.some((item) => item.id === id)) this.held.delete(id);
		return structuredClone([...this.held.values()]);
	}
	reset(): void {
		this.assertActive();
		if (this.active || this.contextWrites.size)
			throw new FlowLedgerError("busy", "Native reset requires drained dispatch.");
		// Reset discards the journal and the queue together, so the clear is not a removal to record.
		this.queued.clear();
		// A removal write that started before this reset describes records the reset discards. Fence it:
		// its late failure belongs to the old journal lifetime and must not pause the new one.
		this.queueGeneration++;
		this.queueWrites.clear();
		this.queueFailure = false;
		this.mutateNativeQueue(() => this.session.clearQueue());
		for (const pending of this.deferred.values()) pending.cancel();
		this.deferred.clear();
		this.held.clear();
		this.contextFailure = false;
		this.history.reset();
	}
	private frame(): Frame | undefined {
		this.assertActive();
		const frame = this.frames.getStore();
		if (!frame) return undefined;
		if (!frame.active) {
			// A finished dispatch's frame is inherited by any callback the turn registered, such as a
			// producer's deferred completion. Flow control off no longer validates host input, so that
			// leftover frame must not decide whether the host may run.
			if (!this.enabled()) return undefined;
			throw new FlowLedgerError("stale", "Native input outlived its dispatch.");
		}
		return frame;
	}
	dispatch<T>(id: string, revision: number, operationId: string, run: () => Promise<T>): Promise<T> {
		this.assertActive();
		const pending = this.session.agent.inspectQueuedMessages();
		for (const id of this.queued.keys()) if (!pending.some((item) => item.id === id)) this.queued.delete(id);
		this.active++;
		return this.store
			.dispatch(id, revision, operationId, (observer, submission) => {
				const options = submission.args[1] as { triggerTurn?: boolean; deliverAs?: string } | undefined;
				const context =
					submission.api === "sendCustomMessage" &&
					options?.deliverAs !== "nextTurn" &&
					(options?.triggerTurn === false ||
						(options?.triggerTurn === undefined && submission.hostState?.streaming === false));
				if (
					context &&
					(!this.session.isIdle || this.session.isStreaming || this.session.isRetrying || this.session.isCompacting)
				)
					throw new FlowLedgerError("busy", "Non-waking context requires an idle append boundary.");
				const frame: Frame = {
					active: true,
					operationId,
					observer,
					writes: [],
					context,
					nextTurn: submission.api === "sendCustomMessage" && options?.deliverAs === "nextTurn",
				};
				return this.frames.run(frame, async () => {
					try {
						if (context) {
							const raw = submission.args[0] as {
								customType: string;
								content?: unknown;
								display: boolean;
								details?: unknown;
							};
							const message = {
								role: "custom" as const,
								customType: raw.customType,
								content: raw.content ?? [],
								display: raw.display,
								details: raw.details,
								timestamp: 0,
							} as AgentMessage;
							const index = await observer.observe({ kind: "context", args: [message] });
							frame.contextInput = { index, message };
							if (
								!this.session.isIdle ||
								this.session.isStreaming ||
								this.session.isRetrying ||
								this.session.isCompacting
							)
								throw new FlowLedgerError("busy", "Non-waking append boundary changed.");
						}
						const result = await run();
						if (frame.nextTurn && !frame.nextTurnObserved)
							throw new FlowLedgerError("identity", "Deferred context has no native observation.");
						if (frame.contextInput)
							throw new FlowLedgerError("identity", "Non-waking input has no native append receipt.");
						frame.active = false;
						await Promise.all(frame.writes);
						// A completed command or handled input hook can return before Agent.prompt.
						// Record that observed absence explicitly; missing receipts alone prove nothing.
						if (submission.api === "prompt" && !frame.writes.length) observer.completeWithoutInput();
						return result;
					} catch (error) {
						if (context) this.contextFailure = true;
						throw error;
					} finally {
						frame.active = false;
						await Promise.allSettled(frame.writes);
					}
				});
			})
			.finally(() => {
				this.active--;
				if (!this.active) this.drained?.();
			});
	}
	/** Call after native execution is aborted/joined; drain receipts before releasing owned hooks. */
	close(): Promise<void> {
		if (this.frames.getStore()?.active)
			return Promise.reject(new FlowLedgerError("busy", "Native dispatch cannot join its own close."));
		if (this.closing) return this.closing;
		this.closed = true;
		this.closing = (
			this.active
				? new Promise<void>((resolve) => {
						this.drained = resolve;
					})
				: Promise.resolve()
		).then(async () => {
			// Queue-removal evidence still owed must land before the hooks are released.
			await Promise.allSettled([...this.queueWrites]);
			const pending = this.session.agent.inspectQueuedMessages().filter((item) => this.queued.has(item.id));
			for (const item of pending) {
				const observed = this.queued.get(item.id);
				if (!observed) throw new FlowLedgerError("stale", "Native queue observation changed during close.");
				if (item.revision !== observed.revision) {
					await observed.write;
					await this.store.recordQueueEdit(
						observed.operationId,
						{ id: item.id, revision: observed.revision },
						{
							kind: item.lane,
							args: [item.message],
							queue: { id: item.id, revision: item.revision },
						},
					);
				}
				const result = this.mutateNativeQueue(() => this.session.agent.cancelQueuedMessage(item.id, item.revision));
				if (result.kind !== "cancelled") throw new FlowLedgerError("stale", "Native queue changed during close.");
				await this.store.recordQueueClaim(observed.operationId, { id: item.id, revision: item.revision }, false);
			}
			this.hooks.close();
			this.history.close();
			this.queued.clear();
			this.deferred.clear();
			this.held.clear();
			attached.delete(this.session);
		});
		return this.closing;
	}
}
