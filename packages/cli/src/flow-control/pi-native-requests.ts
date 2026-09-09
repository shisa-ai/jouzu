import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
	captureNativeProjections,
	convertNativeProjections,
	type NativeProjectionCapture,
} from "./native-context-projections.js";
import { NativePayloadSources } from "./native-payload-sources.js";
import type {
	FlowNativeRequestStore,
	NativeRequestSource,
	NativeSourceCapture,
	NativeSourceClaim,
} from "./native-request-store.js";
import { nativeCancelledSources, nativeSourceKey } from "./native-request-store.js";
import { PiHostHooks } from "./pi-host-hooks.js";
import { FlowLedgerError } from "./receipt-ledger.js";

export type NativeContextDecorator = (
	messages: AgentMessage[],
	sources: NativeRequestSource[],
	signal?: AbortSignal,
) => Promise<AgentMessage[] | { messages: AgentMessage[]; projections: AgentMessage[] }>;

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const attached = new WeakSet<AgentSession>();

/** Retain native request lifecycle around Pi's final payload callback, without inferring input membership. */
export class PiNativeRequests {
	private readonly hooks = new PiHostHooks();
	private pending?: string;
	private executing?: string;
	get queueingBlocked(): boolean {
		this.assertActive();
		return this.store.blocksQueueing(this.executing ?? this.pending);
	}
	private prepared?: { modelHash: string; capture?: NativeSourceCapture; projections?: NativeProjectionCapture };
	private active = 0;
	private closed = false;
	private capture?: NativeSourceCapture;
	private projections?: NativeProjectionCapture;
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
	) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
			throw new FlowLedgerError("capacity", "Invalid native payload limit.");
		if (session.sessionId !== store.scope.sessionId)
			throw new FlowLedgerError("scope", "Native request storage belongs to another session.");
		if (attached.has(session)) throw new FlowLedgerError("identity", "Pi session already has native request receipts.");
		attached.add(session);
		if (identifySources) {
			const transform = session.agent.transformContext;
			this.hooks.set(session.agent, "transformContext", async (messages, signal) => {
				this.assertActive();
				this.active++;
				this.capture = undefined;
				this.projections = undefined;
				this.references = undefined;
				try {
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
					const cancelled = nativeCancelledSources(await store.snapshot());
					if (cancelled.length) {
						if (hash(messages) !== sourceHash || messages.some((message, index) => message !== references[index]))
							throw new FlowLedgerError("stale", "Native context changed during cancellation lookup.");
						const excluded = new Set<number>();
						for (const source of cancelled) {
							const member = members.find((item) => nativeSourceKey(item) === nativeSourceKey(source));
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
					if (decorateContext) {
						const intact = members.flatMap((member) => {
							const reference = this.references![member.index];
							const index = result.indexOf(reference);
							return index >= 0 && result.lastIndexOf(reference) === index && hash(reference) === member.messageHash
								? [{ ...member, index }]
								: [];
						});
						const decorated = await decorateContext(result, structuredClone(intact), signal);
						result = Array.isArray(decorated) ? decorated : decorated.messages;
						if (!Array.isArray(decorated) && decorated.projections.length)
							this.projections = captureNativeProjections(result, decorated.projections);
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
					const result = await convert(messages);
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
				this.assertActive();
				this.active++;
				try {
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
					await store.begin(
						{
							id: input.requestId,
							sourceHash: hash(input.sourceMessages),
							transformedHash: hash(input.transformedMessages),
							modelHash: hash(input.modelMessages),
							systemHash: hash(input.systemPrompt),
							...(this.capture ? { sourceCapture: this.capture } : {}),
							...(this.projections ? { projectionCapture: this.projections } : {}),
						},
						enforceRequiredSources,
						await consumedSources?.(),
					);
					this.pending = input.requestId;
					this.prepared = {
						modelHash: hash(input.modelMessages),
						capture: this.capture ? structuredClone(this.capture) : undefined,
						projections: this.projections ? structuredClone(this.projections) : undefined,
					};
				} finally {
					this.capture = undefined;
					this.references = undefined;
					this.active--;
				}
			},
		});
		const native = session.agent.streamFunction;
		this.hooks.set(session.agent, "streamFunction", async (model, context, options) => {
			this.assertActive();
			const id = this.pending;
			this.pending = undefined;
			if (!id) throw new FlowLedgerError("identity", "Native provider call has no request checkpoint.");
			this.executing = id;
			const prepared = this.prepared;
			this.prepared = undefined;
			const sourceAPI =
				model.api === "anthropic-messages"
					? "anthropic-messages"
					: model.api === "openai-responses"
						? "openai-responses"
						: "openai-completions";
			const sources = new NativePayloadSources(context.messages, prepared?.capture, sourceAPI);
			const projections = new NativePayloadSources(context.messages, prepared?.projections, sourceAPI);
			this.active++;
			let handedOff = false;
			let admitting = false;
			let finished = false;
			const settle = () => {
				if (!finished) {
					finished = true;
					if (this.executing === id) this.executing = undefined;
					this.active--;
				}
			};
			const withheld = async () => {
				if (!handedOff) await store.finish(id, "withheld");
			};
			try {
				if (!prepared || hash(context.messages) !== prepared.modelHash)
					throw new FlowLedgerError("stale", "Native provider context differs from its checkpoint.");
				const response = await native(model, context, {
					...options,
					onMessageConverted: (source, output) => {
						this.assertActive();
						if (admitting || finished)
							throw new FlowLedgerError(
								"transition",
								"Native provider source mapping arrived after payload admission.",
							);
						if (
							model.api === "openai-completions" ||
							model.api === "openai-responses" ||
							model.api === "anthropic-messages"
						) {
							sources.observe(source, output);
							projections.observe(source, output);
						}
						options?.onMessageConverted?.(source, output);
					},
					onPayload: async (payload, requestModel) => {
						this.assertActive();
						options?.signal?.throwIfAborted();
						if (admitting || finished)
							throw new FlowLedgerError("transition", "Native payload admission was repeated or outlived its request.");
						admitting = true;
						if (
							requestModel.api !== model.api ||
							requestModel.provider !== model.provider ||
							requestModel.id !== model.id
						)
							throw new FlowLedgerError("identity", "Native provider identity changed during conversion.");
						const replacement = await options?.onPayload?.(payload, requestModel);
						this.assertActive();
						options?.signal?.throwIfAborted();
						const serialized = JSON.stringify(replacement === undefined ? payload : replacement);
						if (serialized === undefined || Buffer.byteLength(serialized) > maxBytes)
							throw new FlowLedgerError("capacity", "Native provider payload exceeds its byte limit.");
						const owned = JSON.parse(serialized);
						const membership = sources.inspect(model.api, replacement === undefined ? payload : replacement, owned);
						const admitted = await store.handoff(id, {
							hash: createHash("sha256").update(serialized).digest("hex"),
							bytes: Buffer.byteLength(serialized),
							api: model.api,
							provider: model.provider,
							model: model.id,
							...(membership ? { sources: membership } : {}),
							...(prepared.projections
								? {
										projections: projections.inspect(
											model.api,
											replacement === undefined ? payload : replacement,
											owned,
										),
									}
								: {}),
						});
						if (!admitted)
							throw new FlowLedgerError(
								"transition",
								"Native request withheld because required input was changed or unresolved.",
							);
						handedOff = true;
						this.assertActive();
						options?.signal?.throwIfAborted();
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
								throw new FlowLedgerError("transition", "Native provider returned without payload admission.");
							if (!["stop", "length", "toolUse", "error", "aborted"].includes(message.stopReason))
								throw new FlowLedgerError("transition", "Native provider has no terminal outcome.");
							await store.finish(
								id,
								message.stopReason === "error" ? "failure" : message.stopReason === "aborted" ? "aborted" : "success",
							);
							return message;
						} catch (error) {
							await withheld();
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
				await withheld();
				throw error;
			}
		});
	}
	private assertActive(): void {
		if (this.closed || this.session.sessionId !== this.store.scope.sessionId)
			throw new FlowLedgerError("stale", "Native request attachment is closed or replaced.");
	}
	async close(): Promise<void> {
		if (this.closed) return;
		if (this.active) throw new FlowLedgerError("busy", "Native provider execution must settle before close.");
		if (this.pending) await this.store.finish(this.pending, "withheld");
		this.pending = undefined;
		this.prepared = undefined;
		this.capture = undefined;
		this.projections = undefined;
		this.references = undefined;
		this.closed = true;
		this.hooks.close();
		attached.delete(this.session);
	}
}
