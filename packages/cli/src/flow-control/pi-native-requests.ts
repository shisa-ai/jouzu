import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { FlowNativeRequestStore, NativeRequestSource, NativeSourceCapture } from "./native-request-store.js";
import { PiHostHooks } from "./pi-host-hooks.js";
import { FlowLedgerError } from "./receipt-ledger.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const attached = new WeakSet<AgentSession>();

/** Retain native request lifecycle around Pi's final payload callback, without inferring input membership. */
export class PiNativeRequests {
	private readonly hooks = new PiHostHooks();
	private pending?: string;
	private active = 0;
	private closed = false;
	private capture?: NativeSourceCapture;
	constructor(
		private readonly session: AgentSession,
		private readonly store: FlowNativeRequestStore,
		maxBytes: number,
		identifySources?: (messages: AgentMessage[]) => Promise<NativeRequestSource[]>,
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
				try {
					const sourceHash = hash(messages),
						references = [...messages];
					const members = await identifySources(messages);
					this.assertActive();
					signal?.throwIfAborted();
					if (
						messages.length !== references.length ||
						messages.some((message, index) => message !== references[index]) ||
						hash(messages) !== sourceHash
					)
						throw new FlowLedgerError("stale", "Native source context changed during identity capture.");
					const capture = { hash: sourceHash, count: messages.length, members: structuredClone(members) };
					const result = transform ? await transform(messages, signal) : messages;
					this.assertActive();
					signal?.throwIfAborted();
					this.capture = capture;
					return result;
				} finally {
					this.active--;
				}
			});
		}
		const previous = session.agent.flowCheckpoints;
		this.hooks.set(session.agent, "flowCheckpoints", {
			...previous,
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
					await store.begin({
						id: input.requestId,
						sourceHash: hash(input.sourceMessages),
						transformedHash: hash(input.transformedMessages),
						modelHash: hash(input.modelMessages),
						systemHash: hash(input.systemPrompt),
						...(this.capture ? { sourceCapture: this.capture } : {}),
					});
					this.pending = input.requestId;
				} finally {
					this.capture = undefined;
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
			this.active++;
			let handedOff = false;
			let admitting = false;
			let finished = false;
			const settle = () => {
				if (!finished) {
					finished = true;
					this.active--;
				}
			};
			const withheld = async () => {
				if (!handedOff) await store.finish(id, "withheld");
			};
			try {
				const response = await native(model, context, {
					...options,
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
						await store.handoff(id, {
							hash: createHash("sha256").update(serialized).digest("hex"),
							bytes: Buffer.byteLength(serialized),
							api: model.api,
							provider: model.provider,
							model: model.id,
						});
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
		this.capture = undefined;
		this.closed = true;
		this.hooks.close();
		attached.delete(this.session);
	}
}
