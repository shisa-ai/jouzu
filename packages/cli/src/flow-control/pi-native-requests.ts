import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, getCurrentSystemPrompt, type Message } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { CatalogMessageId, catalogText, defaultCatalog } from "../cli-messages.js";
import type { CatalogBundle } from "../locale-catalog.js";
import { captureSideContext, clearSideContext } from "../side-context.js";
import { cacheWarmAdmission } from "./cache-warm-admission.js";
import { flowDiagnosticText } from "./diagnostic-text.js";
import {
	captureNativeProjections,
	convertNativeProjections,
	type NativeProjectionCapture,
} from "./native-context-projections.js";
import type {
	FlowNativeRequestStore,
	NativeRequestFailure,
	NativeRequestSource,
	NativeSourceCapture,
	NativeSourceClaim,
} from "./native-request-store.js";
import { nativeHoldHash, nativeHoldPending, nativeSourceKey } from "./native-request-store.js";
import { copyFlowPayload } from "./payload-copy.js";
import { PiHostHooks } from "./pi-host-hooks.js";
import { preparePiProviderRoute } from "./pi-provider-route.js";
import type { FlowCompositionRequest, PiRequestReceipts } from "./pi-request-receipts.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import { flowRunContainsUserInput } from "./run-input.js";
import { prepareSummaryToolHistory, prepareToolHistory } from "./tool-history.js";

export type NativeContextDecorator = (
	messages: AgentMessage[],
	sources: NativeRequestSource[],
	signal?: AbortSignal,
) => Promise<AgentMessage[] | { messages: AgentMessage[]; projections: AgentMessage[]; waitTokens?: string[] }>;

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const attached = new WeakSet<AgentSession>();

function nativeFailure(
	error: unknown,
	model: { api: string; provider: string; id: string },
	stage: NativeRequestFailure["stage"],
	catalog: CatalogBundle = defaultCatalog(),
): NativeRequestFailure {
	return {
		stage,
		transmission: "not-admitted",
		code: error instanceof FlowLedgerError ? error.code : "provider",
		message:
			flowDiagnosticText(error instanceof Error ? error.message : String(error), 300) ||
			catalogText(catalog, CatalogMessageId.flowNativeNoFailureDescription),
		api: flowDiagnosticText(model.api, 128) || "unknown",
		provider: flowDiagnosticText(model.provider, 128) || "unknown",
		model: flowDiagnosticText(model.id, 128) || "unknown",
		recordedAt: Date.now(),
	};
}

/** Retain native request lifecycle around Pi's final payload callback, without inferring input membership. */
export class PiNativeRequests {
	private readonly hooks = new PiHostHooks();
	private readonly enabled: () => boolean;
	private warmGeneration = 0;
	private pending?: string;
	private executing?: string;
	get queueingBlocked(): boolean {
		this.assertActive();
		return this.store.blocksQueueing(this.executing ?? this.pending);
	}
	/**
	 * The user stopped the current run and its outcome is not recorded yet. Both facts are recorded
	 * when they happen: the Stop when the session is aborted, the recording when it completes. Pi's
	 * own run state cannot stand in for them, because Pi ends the run, and clears its abort signal,
	 * before it reports the run settled.
	 */
	get userStopPending(): boolean {
		return !!this.runEnd?.stoppedByUser || this.recordingUserStop > 0;
	}
	/** Resolves once a pending user Stop has ended its run and recorded its requests. */
	async userStopSettled(): Promise<void> {
		if (this.runEnd?.stoppedByUser) await this.runEnd.promise;
		await this.abortedRun;
	}
	private prepared?: { modelHash: string; capture?: NativeSourceCapture; projections?: NativeProjectionCapture };
	private active = 0;
	private closed = false;
	/** Latest response in this run, even if host recovery removes it from projected history. */
	private lastAssistant?: AssistantMessage;
	/** Requests begun in the current run, so a user abort can close exactly those. */
	private runRequests = new Set<string>();
	/** Recording the outcome of a run the user aborted; the next request waits for it. */
	private abortedRun: Promise<void> = Promise.resolve();
	/**
	 * Resolves when the current run has settled and recorded its outcome. `stoppedByUser` is set when
	 * the user aborts the session during the run, whatever aborts the run after that.
	 */
	private runEnd?: { promise: Promise<void>; resolve: () => void; stoppedByUser: boolean };
	private recordingUserStop = 0;
	private readonly unsubscribeTurn: () => void;
	private guardedStream?: AgentSession["agent"]["streamFunction"];
	private guardTransport = false;
	private sealed = false;
	private capture?: NativeSourceCapture;
	private projections?: NativeProjectionCapture;
	/** Wait tokens the decorator reported for this request's projections. */
	private projectionWaitTokens?: string[];
	/** Ledger bookkeeping for controller-composed requests, driven from this one observer. */
	private composition?: PiRequestReceipts;
	private composed?: FlowCompositionRequest;
	private references?: AgentMessage[];
	private cloneSourceHash?: string;
	private converting?: AgentMessage[];
	private conversion?: { outputs: AgentMessage[]; hashes: string[]; sourceIndices: number[]; imageReplaced: boolean[] };
	constructor(
		private readonly session: AgentSession,
		private readonly store: FlowNativeRequestStore,
		maxBytes: number,
		identifySources?: (messages: AgentMessage[]) => Promise<NativeRequestSource[]>,
		enforceRequiredSources = false,
		consumedSources?: () => Promise<NativeSourceClaim[]>,
		decorateContext?: NativeContextDecorator,
		trustedStream?: AgentSession["agent"]["streamFunction"],
		/** Operation IDs of host-verified user submissions, used to place user instruction in a run. */
		private readonly userOperations?: () => Promise<ReadonlySet<string>>,
		/**
		 * Turn-level signals the session acts on as a whole.
		 *
		 * The host reserves its interrupt key, so an interrupt is not observable directly; a turn
		 * ending with an aborted outcome is the evidence available for it. Only the conversational
		 * route reports here. Maintenance work such as compaction aborts for its own reasons and
		 * already gates the session while it runs, so it is left out deliberately.
		 */
		private readonly turn?: {
			aborted(): void;
			failed?(error: unknown): void;
			providerFailed?(detail: string): void;
			/** A stopped run's requests are recorded; this follows the run's settlement. */
			stopRecorded?(): void;
		},
		reconcileSources?: () => Promise<unknown>,
		/**
		 * Flow control is on. While it is off, receipts are still recorded but nothing is enforced or
		 * injected: a stuck recovery hold must not keep blocking the session's own sends, because
		 * turning flow control off is the user's way of taking it out of the way.
		 */
		flowEnabled?: () => boolean,
		retireHistory?: () => Promise<unknown>,
		private readonly catalog: CatalogBundle = defaultCatalog(),
	) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
			throw new FlowLedgerError("capacity", "Invalid native payload limit.");
		if (session.sessionId !== store.scope.sessionId)
			throw new FlowLedgerError("scope", "Native request storage belongs to another session.");
		if (trustedStream && session.agent.streamFunction !== trustedStream)
			throw new FlowLedgerError("identity", "Flow control cannot attach after the session request handler changed.");
		if (attached.has(session)) throw new FlowLedgerError("identity", "Pi session already has native request receipts.");
		attached.add(session);
		this.enabled = flowEnabled ?? (() => true);
		this.unsubscribeTurn = session.subscribe((event) => this.observeTurn(event));
		// The user's Stop is recorded against the run it stops at the moment it is made. An abort that
		// keeps prompts, such as compaction's, is not the user's and does not change that record.
		const abort = session.abort;
		this.hooks.set(session, "abort", (options?: { keepPrompts?: boolean }) => {
			if (!options?.keepPrompts && this.runEnd) this.runEnd.stoppedByUser = true;
			return abort.call(session, options);
		});
		if (identifySources) {
			const transform = session.agent.transformContext;
			this.hooks.set(session.agent, "transformContext", async (messages, signal) => {
				this.assertActive();
				clearSideContext(session);
				this.active++;
				this.capture = undefined;
				this.projections = undefined;
				this.projectionWaitTokens = undefined;
				this.references = undefined;
				try {
					await reconcileSources?.();
					let sourceHash = hash(messages),
						references = [...messages];
					let members = await identifySources(messages);
					this.assertActive();
					signal?.throwIfAborted();
					if (
						messages.length !== references.length ||
						messages.some((message, index) => message !== references[index]) ||
						hash(messages) !== sourceHash
					)
						throw new FlowLedgerError("stale", "Native source context changed during identity capture.");
					const cancelled = await store.cancelledSources(members);
					if (cancelled.length) {
						if (hash(messages) !== sourceHash || messages.some((message, index) => message !== references[index]))
							throw new FlowLedgerError("stale", "Native context changed during cancellation lookup.");
						const excluded = new Set<number>();
						for (const source of cancelled) {
							const member = members.find((item) => nativeSourceKey(item) === nativeSourceKey(source));
							if (!member && (await store.sourceReconciled(source))) continue;
							if (!member)
								throw new FlowLedgerError("identity", "Cancelled native input requires source reconciliation.");
							excluded.add(member.index);
						}
						const positions = new Map<number, number>();
						messages = messages.filter((_message, index) => {
							if (excluded.has(index)) return false;
							positions.set(index, positions.size);
							return true;
						});
						members = members.flatMap((member) => {
							const index = positions.get(member.index);
							return index === undefined ? [] : [{ ...member, index }];
						});
						sourceHash = hash(messages);
						references = [...messages];
					}
					const capture: NativeSourceCapture = {
						hash: sourceHash,
						count: messages.length,
						members: structuredClone(members),
					};
					this.references = references;
					this.cloneSourceHash = sourceHash;
					let result = transform ? await transform(messages, signal) : messages;
					if (decorateContext && this.enabled()) {
						const intact = members.flatMap((member) => {
							const reference = this.references![member.index];
							const index = result.indexOf(reference);
							return index >= 0 && result.lastIndexOf(reference) === index && hash(reference) === member.messageHash
								? [{ ...member, index }]
								: [];
						});
						const decorated = await decorateContext(result, structuredClone(intact), signal);
						result = Array.isArray(decorated) ? decorated : decorated.messages;
						if (!Array.isArray(decorated) && decorated.projections.length) {
							this.projections = captureNativeProjections(result, decorated.projections);
							this.projectionWaitTokens = decorated.waitTokens?.length ? [...decorated.waitTokens] : undefined;
						}
					}
					this.cloneSourceHash = undefined;
					const contextReferences = this.references;
					this.assertActive();
					signal?.throwIfAborted();
					const occurrences = new Map<AgentMessage, number>();
					for (const message of contextReferences) occurrences.set(message, (occurrences.get(message) ?? 0) + 1);
					const positions = new Map<AgentMessage, number[]>();
					for (const [index, message] of result.entries()) {
						const existing = positions.get(message) ?? [];
						existing.push(index);
						positions.set(message, existing);
					}
					capture.context = {
						hash: hash(result),
						count: result.length,
						members: capture.members.map((member) => {
							const original = contextReferences[member.index];
							const matches = positions.get(original) ?? [];
							// Repeated references cannot distinguish an occurrence after a filter.
							if (matches.length !== 1 || occurrences.get(original) !== 1)
								return { sourceIndex: member.index, status: "unresolved" };
							return {
								sourceIndex: member.index,
								status: hash(original) === member.messageHash ? "intact" : "changed",
								index: matches[0],
							};
						}),
					};
					this.capture = capture;
					return result;
				} catch (error) {
					this.turn?.failed?.(error);
					throw error;
				} finally {
					this.cloneSourceHash = undefined;
					this.active--;
				}
			});
			const convert = session.agent.convertToLlm;
			this.hooks.set(session.agent, "convertToLlm", async (messages) => {
				this.assertActive();
				this.active++;
				try {
					const capture = this.capture,
						references = this.references;
					if (!capture?.context || !references)
						throw new FlowLedgerError("identity", "Native model conversion lacks source context.");
					if (hash(messages) !== capture.context.hash)
						throw new FlowLedgerError("stale", "Native context changed before model conversion.");
					this.converting = [...messages];
					this.conversion = undefined;
					// Repair the model projection before admission and position capture, not
					// the persisted branch. Original converted objects retain their identity.
					const result = prepareToolHistory(await convert(messages));
					this.assertActive();
					const positions = new Map<AgentMessage, number[]>();
					for (const [index, message] of result.entries()) {
						const existing = positions.get(message) ?? [];
						existing.push(index);
						positions.set(message, existing);
					}
					capture.model = {
						hash: hash(result),
						count: result.length,
						members: capture.members.map((member, offset) => {
							const context = capture.context?.members[offset];
							const convertedIndex =
								context?.index === undefined ? -1 : (this.conversion?.sourceIndices.indexOf(context.index) ?? -1);
							const converted = convertedIndex < 0 ? undefined : this.conversion?.outputs[convertedIndex];
							const original = converted ?? references[member.index];
							const matches = positions.get(original) ?? [];
							if (context?.status === "unresolved" || (this.conversion && convertedIndex < 0) || matches.length !== 1)
								return { sourceIndex: member.index, status: "unresolved" };
							const messageHash = hash(original);
							const status = converted
								? context?.status === "changed" ||
									this.conversion?.imageReplaced[convertedIndex] ||
									messageHash !== this.conversion?.hashes[convertedIndex]
									? "changed"
									: messageHash === member.messageHash
										? "intact"
										: "converted"
								: messageHash === member.messageHash
									? "intact"
									: "changed";
							return { sourceIndex: member.index, status, index: matches[0], messageHash };
						}),
					};
					if (this.projections) convertNativeProjections(this.projections, result, this.conversion);
					return result;
				} finally {
					this.converting = undefined;
					this.conversion = undefined;
					this.active--;
				}
			});
		} else {
			const convert = session.agent.convertToLlm;
			this.hooks.set(session.agent, "convertToLlm", async (messages) => {
				this.assertActive();
				this.active++;
				try {
					const result = prepareToolHistory(await convert(messages));
					this.assertActive();
					return result;
				} finally {
					this.active--;
				}
			});
		}
		const previous = session.agent.flowCheckpoints;
		this.hooks.set(session.agent, "flowCheckpoints", {
			...previous,
			afterModelConversion: async (input) => {
				this.assertActive();
				this.active++;
				try {
					if (!identifySources) {
						await previous?.afterModelConversion?.(input);
						return;
					}
					const references = this.converting;
					if (!references || this.conversion || !this.capture?.context)
						throw new FlowLedgerError("identity", "Unexpected native model conversion mapping.");
					const { sourceMessages, modelMessages, sourceIndices, imageReplaced } = input;
					const outputs = [...modelMessages];
					const sourceHash = hash(sourceMessages),
						modelHash = hash(modelMessages);
					const indices = [...sourceIndices],
						replacements = [...imageReplaced];
					if (
						sourceHash !== this.capture.context.hash ||
						sourceMessages.length !== references.length ||
						sourceMessages.some((message, index) => message !== references[index]) ||
						sourceIndices.length !== modelMessages.length ||
						imageReplaced.length !== modelMessages.length ||
						sourceIndices.some(
							(index, offset) =>
								!Number.isSafeInteger(index) ||
								index < 0 ||
								index >= references.length ||
								(offset > 0 && index <= sourceIndices[offset - 1]),
						) ||
						imageReplaced.some((replaced) => typeof replaced !== "boolean")
					)
						throw new FlowLedgerError("identity", "Invalid native model conversion mapping.");
					// Reserve before awaiting another observer so a repeated callback cannot replace this mapping.
					const conversion = {
						outputs,
						hashes: outputs.map(hash),
						sourceIndices: indices,
						imageReplaced: replacements,
					};
					this.conversion = conversion;
					await previous?.afterModelConversion?.(input);
					this.assertActive();
					if (
						hash(sourceMessages) !== sourceHash ||
						hash(modelMessages) !== modelHash ||
						hash(sourceIndices) !== hash(indices) ||
						hash(imageReplaced) !== hash(replacements) ||
						sourceMessages.some((message, index) => message !== references[index]) ||
						modelMessages.some((message, index) => message !== outputs[index])
					)
						throw new FlowLedgerError("stale", "Native model conversion changed during its checkpoint.");
				} finally {
					this.active--;
				}
			},
			afterContextClone: async (source, cloned, signal) => {
				this.assertActive();
				this.active++;
				try {
					if (!identifySources) {
						await previous?.afterContextClone?.(source, cloned, signal);
						return;
					}
					const references = this.references,
						expectedHash = this.cloneSourceHash;
					if (!references || !expectedHash)
						throw new FlowLedgerError("identity", "Unexpected native context clone checkpoint.");
					this.cloneSourceHash = undefined;
					const clonedReferences = [...cloned];
					await previous?.afterContextClone?.(source, cloned, signal);
					this.assertActive();
					signal?.throwIfAborted();
					if (
						source.length !== references.length ||
						cloned.length !== references.length ||
						source.some((message, index) => message !== references[index]) ||
						cloned.some((message, index) => message !== clonedReferences[index]) ||
						hash(source) !== expectedHash ||
						hash(cloned) !== expectedHash
					)
						throw new FlowLedgerError("stale", "Native context clone changed during its checkpoint.");
					this.references = clonedReferences;
				} finally {
					this.active--;
				}
			},
			beforeRequest: async (input, signal) => {
				this.warmGeneration++;
				this.assertActive();
				this.active++;
				try {
					await this.abortedRun;
					await previous?.beforeRequest?.(input, signal);
					this.assertActive();
					signal?.throwIfAborted();
					if (this.pending) await store.finish(this.pending, "withheld");
					this.pending = undefined;
					if (identifySources && !this.capture)
						throw new FlowLedgerError("identity", "Native request has no source context checkpoint.");
					if (
						this.capture?.context?.hash !== undefined &&
						this.capture.context.hash !== hash(input.transformedMessages)
					)
						throw new FlowLedgerError("stale", "Native context changed after source disposition capture.");
					if (identifySources && !this.capture?.model)
						throw new FlowLedgerError("identity", "Native request has no model conversion checkpoint.");
					if (this.capture?.model && this.capture.model.hash !== hash(input.modelMessages))
						throw new FlowLedgerError("stale", "Native model input changed after source disposition capture.");
					// Tool sequences and follow-ups may never expose an idle boundary. Preserve
					// live evidence while retiring redundant and evidence-empty settled history.
					if (!store.recoveryBlocked) await store.retireBeforeRequest();
					if (!store.recoveryBlocked && retireHistory && (await store.historyNeedsRetirement())) await retireHistory();
					await store.begin(
						{
							id: input.requestId,
							sourceHash: hash(input.sourceMessages),
							transformedHash: hash(input.transformedMessages),
							modelHash: hash(input.modelMessages),
							systemHash: hash(input.systemPrompt),
							...(this.capture ? { sourceCapture: this.capture } : {}),
							...(this.projections ? { projectionCapture: this.projections } : {}),
							...(this.projections && this.projectionWaitTokens ? { waitTokens: this.projectionWaitTokens } : {}),
						},
						this.enabled() && enforceRequiredSources,
						await consumedSources?.(),
						this.enabled(),
					);
					this.pending = input.requestId;
					this.runRequests.add(input.requestId);
					// One checkpoint records both facts: the native request and, when this turn carries a
					// controller composition, its ledger preparation. Whether the run carries user
					// instruction is decided from carried membership and recorded positions.
					const carriesUserInput = flowRunContainsUserInput(
						input.modelMessages,
						this.capture,
						await userOperations?.(),
					);
					this.composed = await this.composition?.prepare(input, signal, carriesUserInput);
					this.prepared = {
						modelHash: hash(input.modelMessages),
						capture: this.capture ? structuredClone(this.capture) : undefined,
						projections: this.projections ? structuredClone(this.projections) : undefined,
					};
				} catch (error) {
					if (signal?.aborted) {
						// The user stopped the turn; run settlement records its open requests as aborted.
						this.turn?.aborted();
						throw error;
					}
					this.turn?.failed?.(error);
					throw error;
				} finally {
					this.capture = undefined;
					this.references = undefined;
					this.active--;
				}
			},
		});
		const native = session.agent.streamFunction;
		/**
		 * Pi summarizes for compaction and branch summaries by calling the session stream function
		 * directly, so those requests carry none of the checkpoints a controlled turn passes through:
		 * their input is session history, not retained submissions. They are recorded as maintenance
		 * receipts, which observe the exact final payload and its outcome but establish no source
		 * membership. Any other unchecked call is still refused.
		 */
		const maintenance: typeof native = async (model, context, options) => {
			if (!session.isCompacting)
				throw new FlowLedgerError("identity", "Native provider call has no request checkpoint.");
			const id = randomUUID();
			const sourceHash = hash(context.messages);
			// Compaction and branch summaries bypass conversational conversion.
			context = { ...context, messages: prepareToolHistory(context.messages) };
			const modelHash = hash(context.messages);
			this.active++;
			let handedOff = false;
			let finished = false;
			let failure: NativeRequestFailure | undefined;
			const settle = () => {
				if (!finished) {
					finished = true;
					this.active--;
				}
			};
			const withheld = async (error?: unknown) => {
				if (error !== undefined) failure ??= nativeFailure(error, model, "compaction-preparation", this.catalog);
				if (!handedOff) await store.finish(id, "withheld", failure);
			};
			try {
				if (!store.recoveryBlocked && retireHistory && (await store.historyNeedsRetirement())) await retireHistory();
				await store.begin({
					id,
					kind: "maintenance",
					sourceHash,
					transformedHash: modelHash,
					modelHash,
					systemHash: hash(getCurrentSystemPrompt(context.messages)),
				});
				const flowValidateProvider = trustedStream
					? preparePiProviderRoute(session.modelRuntime, model, () => this.assertActive())
					: undefined;
				const response = await native(model, context, {
					...options,
					// Admission records full Anthropic payloads; do not replace them with server-side thread deltas.
					...(model.api === "anthropic-messages" ? { disableContinuation: true } : {}),
					...(flowValidateProvider ? { flowValidateProvider } : {}),
					onPayload: async (payload, requestModel) => {
						this.assertActive();
						options?.signal?.throwIfAborted();
						if (handedOff || finished)
							throw new FlowLedgerError(
								"transition",
								"Maintenance payload admission was repeated or outlived its request.",
							);
						if (
							requestModel.api !== model.api ||
							requestModel.provider !== model.provider ||
							requestModel.id !== model.id
						)
							throw new FlowLedgerError("identity", "Native provider identity changed during conversion.");
						const replacement = await options?.onPayload?.(payload, requestModel);
						this.assertActive();
						const { serialized, owned } = copyFlowPayload(replacement === undefined ? payload : replacement, model.api);
						if (serialized === undefined || Buffer.byteLength(serialized) > maxBytes)
							throw new FlowLedgerError("capacity", "Native provider payload exceeds its byte limit.");
						await store.handoff(id, {
							hash: createHash("sha256").update(serialized).digest("hex"),
							bytes: Buffer.byteLength(serialized),
							api: model.api,
							provider: model.provider,
							model: model.id,
						});
						handedOff = true;
						return owned;
					},
				});
				let recorded: Promise<AssistantMessage> | undefined;
				const result = () =>
					(recorded ??= (async () => {
						try {
							const message = await response.result();
							this.assertActive();
							if (!handedOff)
								throw new FlowLedgerError(
									"transition",
									message.stopReason === "error" && message.errorMessage
										? catalogText(this.catalog, CatalogMessageId.flowNativeCompactionProviderFailed, {
												message: flowDiagnosticText(message.errorMessage, 300),
											})
										: catalogText(catalog, CatalogMessageId.flowNativeMaintenanceNoAdmission),
								);
							await store.finish(
								id,
								message.stopReason === "error" ? "failure" : message.stopReason === "aborted" ? "aborted" : "success",
							);
							return message;
						} catch (error) {
							await withheld(error);
							throw error;
						} finally {
							settle();
						}
					})());
				return new Proxy(response, {
					get(target, property) {
						if (property === "result") return result;
						const value = Reflect.get(target, property, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
			} catch (error) {
				settle();
				await withheld(error);
				throw error;
			}
		};
		this.hooks.set(session.agent, "streamFunction", async (model, context, options) => {
			this.assertActive();
			const id = this.pending;
			this.pending = undefined;
			if (!id) return maintenance(model, context, options);
			this.executing = id;
			const prepared = this.prepared;
			this.prepared = undefined;
			this.active++;
			let handedOff = false;
			let admitting = false;
			let admissionFailure: { error: unknown } | undefined;
			let failure: NativeRequestFailure | undefined;
			let finished = false;
			const settle = () => {
				if (!finished) {
					finished = true;
					if (this.executing === id) this.executing = undefined;
					this.active--;
				}
			};
			const composed = this.composed;
			this.composed = undefined;
			const warmGeneration = this.warmGeneration;
			const warming = cacheWarmAdmission({
				session,
				store,
				requestId: id,
				model,
				context,
				maxBytes,
				members: prepared?.capture?.members ?? [],
				assertCurrent: () => {
					this.assertActive();
					if (warmGeneration !== this.warmGeneration)
						throw new FlowLedgerError("stale", "Cache refresh was replaced by a new request.");
				},
			});
			// The user's own abort is a cancellation, never a failure: it records an aborted outcome,
			// raises no hold, and asks for no recovery decision.
			const cancelledByUser = () => options?.signal?.aborted === true;
			const recordUserAbort = async () => {
				await store.finish(id, "aborted");
				if (handedOff && composed)
					await this.composition?.settled(composed, { stopReason: "aborted" } as AssistantMessage);
			};
			const withheld = async (error?: unknown) => {
				if (handedOff) return;
				if (cancelledByUser()) {
					// Never sent: recorded as withheld with no failure, and its attempt is left to host
					// settlement, which cancels an attempt that never reached the provider.
					await store.finish(id, "withheld");
					return;
				}
				if (error !== undefined)
					failure ??= nativeFailure(
						error,
						model,
						admissionFailure ? "payload-admission" : "provider-preparation",
						this.catalog,
					);
				await store.finish(id, "withheld", failure);
				if (composed) await this.composition?.withhold(composed);
			};
			try {
				if (!prepared || hash(context.messages) !== prepared.modelHash)
					throw new FlowLedgerError("stale", "Native provider context differs from its checkpoint.");
				const flowValidateProvider = trustedStream
					? preparePiProviderRoute(session.modelRuntime, model, () => this.assertActive())
					: undefined;
				clearSideContext(session);
				const sideMessages = structuredClone(context.messages);
				const response = await native(model, context, {
					...options,
					// Keep final-payload receipts bound to the complete admitted Anthropic request.
					...(model.api === "anthropic-messages" ? { disableContinuation: true } : {}),
					...(flowValidateProvider ? { flowValidateProvider } : {}),
					...{ flowCacheWarm: warming.refresh },
					onPayload: async (payload, requestModel) => {
						try {
							this.assertActive();
							options?.signal?.throwIfAborted();
							if (admitting || finished)
								throw new FlowLedgerError(
									"transition",
									"Native payload admission was repeated or outlived its request.",
								);
							admitting = true;
							if (
								requestModel.api !== model.api ||
								requestModel.provider !== model.provider ||
								requestModel.id !== model.id
							)
								throw new FlowLedgerError("identity", "Native provider identity changed during conversion.");
							const rawPayload = copyFlowPayload(payload, model.api).owned;
							const replacement = await options?.onPayload?.(payload, requestModel);
							this.assertActive();
							options?.signal?.throwIfAborted();
							const { serialized, owned } = copyFlowPayload(
								replacement === undefined ? payload : replacement,
								model.api,
							);
							if (serialized === undefined || Buffer.byteLength(serialized) > maxBytes)
								throw new FlowLedgerError("capacity", "Native provider payload exceeds its byte limit.");
							// The body is serialized to bound and identify it, never to locate membership inside it.
							const admitted = await store.handoff(id, {
								hash: createHash("sha256").update(serialized).digest("hex"),
								bytes: Buffer.byteLength(serialized),
								api: model.api,
								provider: model.provider,
								model: model.id,
							});
							if (!admitted)
								throw new FlowLedgerError(
									"transition",
									"Native request withheld because required input was changed or unresolved at conversion. Run /flow to identify the input and recovery options.",
								);
							handedOff = true;
							if (composed) await this.composition?.handedOff(composed, options?.signal);
							this.assertActive();
							options?.signal?.throwIfAborted();
							warming.capture(rawPayload, owned);
							// Payload-only redactions cannot be mapped back to messages safely.
							if (this.enabled() && hash(rawPayload) === hash(owned)) captureSideContext(session, model, sideMessages, store.scope.branchId);
							return owned;
						} catch (error) {
							admissionFailure = { error };
							this.turn?.failed?.(error);
							throw error;
						}
					},
				});
				let recorded: Promise<AssistantMessage> | undefined;
				const result = () =>
					(recorded ??= (async () => {
						try {
							const message = await response.result();
							this.assertActive();
							if (!handedOff && admissionFailure) throw admissionFailure.error;
							if (!handedOff && message.stopReason === "aborted" && cancelledByUser()) {
								await store.finish(id, "withheld");
								this.turn?.aborted();
								return message;
							}
							if (!handedOff) {
								if (message.stopReason === "error" && message.errorMessage)
									failure ??= nativeFailure(
										new Error(message.errorMessage),
										model,
										"provider-preparation",
										this.catalog,
									);
								const error = new FlowLedgerError(
									"transition",
									message.stopReason === "error" && message.errorMessage
										? catalogText(this.catalog, CatalogMessageId.flowNativeProviderFailed, {
												provider: flowDiagnosticText(model.provider),
												model: flowDiagnosticText(model.id),
												message: flowDiagnosticText(message.errorMessage, 300),
											})
										: catalogText(this.catalog, CatalogMessageId.flowNativeProviderNoAdmission),
								);
								this.turn?.failed?.(error);
								throw error;
							}
							if (!["stop", "length", "toolUse", "error", "aborted"].includes(message.stopReason))
								throw new FlowLedgerError("transition", "Native provider has no terminal outcome.");
							await store.finish(
								id,
								message.stopReason === "error" ? "failure" : message.stopReason === "aborted" ? "aborted" : "success",
							);
							if (message.stopReason === "aborted") this.turn?.aborted();
							if (composed) await this.composition?.settled(composed, message);
							return message;
						} catch (error) {
							// An interrupt usually rejects the request rather than returning an aborted
							// outcome, so the signal is what identifies it. Both routes are reported: a
							// provider that answers with `aborted` is the same event to the user.
							if (options?.signal?.aborted) this.turn?.aborted();
							if (handedOff && cancelledByUser()) {
								// The request may have reached the provider, but the user stopped it: record
								// it as aborted, as when the stream itself ends aborted, not as unknown.
								await recordUserAbort();
								throw error;
							}
							await withheld(error);
							throw error;
						} finally {
							settle();
						}
					})());
				return new Proxy(response, {
					get(target, property) {
						if (property === "result") return result;
						if (property === Symbol.asyncIterator)
							return async function* () {
								let drained = false;
								try {
									yield* response;
									drained = true;
								} finally {
									if (!drained) {
										try {
											await withheld();
										} finally {
											settle();
										}
									}
								}
							};
						const value = Reflect.get(target, property, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
			} catch (error) {
				settle();
				await withheld(error);
				throw error;
			}
		});
		// Pi invokes this hook while history is still structured, before summary
		// serialization. The transport guard below covers the resulting request.
		this.hooks.set(
			session.agent.streamFunction as typeof native & {
				flowPrepareSummaryMessages?: (messages: Message[]) => Message[];
			},
			"flowPrepareSummaryMessages",
			(messages) => {
				this.assertActive();
				return prepareSummaryToolHistory(messages);
			},
		);
		this.guardTransport = trustedStream !== undefined;
		if (trustedStream) this.guardedStream = session.agent.streamFunction;
	}

	/**
	 * Re-capture the guarded transport once every flow wrapper is installed. Request receipts wrap
	 * `streamFunction` after this object does, so the constructor's capture would otherwise compare
	 * against a stale handler and hold every request. One use only, called by the session service
	 * while it still owns construction, so no later replacement can be absorbed here.
	 */
	/**
	 * Attach the ledger bookkeeping for controller-composed requests. One observer wraps the transport
	 * and drives both projections, so the two no longer depend on which installed first.
	 */
	attachComposition(receipts: PiRequestReceipts): void {
		this.assertActive();
		if (this.composition) throw new FlowLedgerError("identity", "Composition receipts are already attached.");
		this.composition = receipts;
	}

	detachComposition(): void {
		this.composition = undefined;
		this.composed = undefined;
	}

	sealTransport(): void {
		if (this.sealed) throw new FlowLedgerError("transition", "Native request transport is already sealed.");
		this.sealed = true;
		if (this.guardTransport) this.guardedStream = this.session.agent.streamFunction;
	}
	private assertActive(): void {
		if (this.guardedStream && this.session.agent.streamFunction !== this.guardedStream)
			throw new FlowLedgerError(
				"identity",
				"Flow control is holding this request because its session transport changed.",
			);
		if (this.closed || this.session.sessionId !== this.store.scope.sessionId)
			throw new FlowLedgerError("stale", "Native request attachment is closed or replaced.");
	}
	/**
	 * Wait for host recovery to finish before pausing. Retry and overflow recovery can remove failed
	 * responses from projected history, so capture message events rather than searching that history.
	 * A recovery response replaces the failed response; settlement consumes it once, including while
	 * flow is disabled. A new run cannot inherit an error from an earlier run or restored history.
	 */
	private observeTurn(event: AgentSessionEvent): void {
		if (this.closed || this.session.sessionId !== this.store.scope.sessionId) return;
		if (event.type === "agent_start") {
			this.lastAssistant = undefined;
			this.runRequests = new Set();
			let resolve = () => {};
			const promise = new Promise<void>((done) => {
				resolve = done;
			});
			this.runEnd = { promise, resolve, stoppedByUser: false };
		}
		if (event.type === "message_end" && event.message.role === "assistant") this.lastAssistant = event.message;
		if (event.type !== "agent_settled") return;
		const ended = this.runEnd;
		this.runEnd = undefined;
		const last = this.lastAssistant;
		this.lastAssistant = undefined;
		if (event.aborted) {
			// The run was stopped. Whatever point each of its requests reached, its outcome is known:
			// record it, so nothing is left unresolved. Requests from earlier runs or processes keep their
			// recorded state.
			const ids = [...this.runRequests];
			this.runRequests = new Set();
			const byUser = ended?.stoppedByUser === true;
			if (byUser) this.recordingUserStop++;
			this.abortedRun = this.abortedRun
				.then(() => this.finishAborted(ids, byUser))
				.catch(() => {})
				.finally(() => {
					if (byUser) this.recordingUserStop--;
					if (!this.closed) this.turn?.stopRecorded?.();
				});
			void this.abortedRun.then(ended?.resolve);
			return;
		}
		ended?.resolve();
		if (!this.enabled()) return;
		if (last?.stopReason === "error") this.turn?.providerFailed?.(last.errorMessage ?? "");
		else if (last?.stopReason === "length")
			this.turn?.providerFailed?.("Response was truncated before completion.");
	}
	private async finishAborted(ids: string[], byUser: boolean): Promise<void> {
		if (!ids.length || this.closed) return;
		const open = (await this.store.snapshot()).filter(
			(record) => ids.includes(record.id) && record.outcome === undefined && !record.reset,
		);
		// A request that reached the provider ends aborted; one that never did is withheld, unsent.
		for (const record of open) await this.store.finish(record.id, record.payload ? "aborted" : "withheld");
		// The user's Stop is their decision, so an unsent request never becomes a hold that asks for one.
		// Its hold is released, keeping its receipts: the input stays in the conversation, as it does
		// after a Stop without flow control, and nothing is sent again on its own. A run something else
		// stopped, such as compaction, leaves its unsent request held for the user to decide.
		if (byUser) await this.store.reset(ids);
		if (this.pending && ids.includes(this.pending)) this.pending = undefined;
	}
	async close(): Promise<void> {
		if (this.closed) return;
		if (this.active) throw new FlowLedgerError("busy", "Native provider execution must settle before close.");
		if (this.pending) await this.store.finish(this.pending, "withheld");
		this.pending = undefined;
		this.prepared = undefined;
		this.capture = undefined;
		this.projections = undefined;
		this.projectionWaitTokens = undefined;
		this.references = undefined;
		clearSideContext(this.session);
		this.closed = true;
		this.lastAssistant = undefined;
		this.unsubscribeTurn();
		this.hooks.close();
		attached.delete(this.session);
	}
}
