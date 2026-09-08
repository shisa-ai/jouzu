import type { FlowRequestInput } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type FlowModelInput, prepareFlowModelInput } from "./model-input.js";
import { admitFlowPayload, type FlowPayloadProjection } from "./provider-payload.js";
import { FlowLedgerError, type FlowOutcome, type FlowReceiptLedger } from "./receipt-ledger.js";

interface RequestBinding {
	composition: FlowModelInput;
	id: string;
	signal?: AbortSignal;
	handedOff: boolean;
}
export interface PiRequestReceiptOptions {
	/** Registry populated only with qualified provider projections. */
	projections: ReadonlyMap<string, FlowPayloadProjection>;
	maxPayloadBytes: number;
	/** The ingress/controller owns user origin; never infer it from message prose. */
	containsUserInput(input: FlowRequestInput): boolean;
}

/** Native request receipts. Host settlement remains separate from response and agent_end events. */
export class PiRequestReceipts {
	private closed = false;
	private readonly compositions = new Map<string, FlowModelInput>();
	private pending?: RequestBinding;

	constructor(
		private readonly session: AgentSession,
		private readonly ledger: FlowReceiptLedger,
		options: PiRequestReceiptOptions,
	) {
		if (!Number.isSafeInteger(options.maxPayloadBytes) || options.maxPayloadBytes < 1)
			throw new FlowLedgerError("capacity", "Invalid provider payload byte limit.");
		const projections = new Map(options.projections);
		const previous = session.agent.flowCheckpoints;
		session.agent.flowCheckpoints = {
			...previous,
			beforeRequest: async (input, signal) => {
				this.assertActive();
				this.pending = undefined;
				await previous?.beforeRequest?.(input, signal);
				this.assertActive(signal);
				const state = await ledger.snapshot();
				const attempt = state.attempts.find((item) => item.id === state.activeAttemptId);
				if (!attempt || ["selected", "queued"].includes(attempt.phase)) return;
				if (!["claimed", "running"].includes(attempt.phase))
					throw new FlowLedgerError("transition", "Prior request requires reconciliation before another request.");
				const composition = this.compositions.get(attempt.id);
				if (!composition) throw new FlowLedgerError("identity", "Claimed attempt has no registered composition.");
				await prepareFlowModelInput(ledger, composition, input, options.containsUserInput(input));
				const request = { composition, id: input.requestId, signal, handedOff: false };
				try {
					this.assertActive(signal);
				} catch (error) {
					await this.withhold(request);
					throw error;
				}
				this.pending = request;
			},
		};
		const native = session.agent.streamFunction;
		session.agent.streamFunction = async (model, context, streamOptions) => {
			this.assertActive();
			const request = this.pending;
			this.pending = undefined;
			if (!request) return native(model, context, streamOptions);
			const projection = projections.get(model.api);
			try {
				if (!projection) throw new FlowLedgerError("schema", "Provider API has no qualified payload projection.");
				const response = await native(model, context, {
					...streamOptions,
					onPayload: async (payload, requestModel) => {
						this.assertActive(request.signal);
						if (request.handedOff) throw new FlowLedgerError("identity", "Provider repeated payload admission.");
						if (
							requestModel.api !== model.api ||
							requestModel.id !== model.id ||
							requestModel.provider !== model.provider
						)
							throw new FlowLedgerError("identity", "Provider identity changed during payload conversion.");
						const replacement = await streamOptions?.onPayload?.(payload, requestModel);
						this.assertActive(request.signal);
						const owned = await admitFlowPayload(
							ledger,
							request.composition,
							request.id,
							model.api,
							replacement === undefined ? payload : replacement,
							projection,
							options.maxPayloadBytes,
						);
						this.assertActive(request.signal);
						await ledger.handoff(request.composition.attemptId, request.id);
						request.handedOff = true;
						this.assertActive(request.signal);
						return owned;
					},
				});
				let recorded: Promise<AssistantMessage> | undefined;
				const result = () =>
					(recorded ??= (async () => {
						try {
							const message = await response.result();
							this.assertActive();
							if (!request.handedOff) {
								await this.withhold(request);
								throw new FlowLedgerError("transition", "Provider request ended without an admitted payload.");
							}
							if (!["stop", "length", "toolUse", "error", "aborted"].includes(message.stopReason))
								throw new FlowLedgerError("transition", "Provider response has no terminal outcome.");
							const outcome: FlowOutcome =
								message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "failure" : "success";
							await ledger.requestOutcome(request.composition.attemptId, request.id, outcome);
							return message;
						} catch (error) {
							await this.withhold(request);
							throw error;
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
				await this.withhold(request);
				throw error;
			}
		};
	}

	private assertActive(signal?: AbortSignal): void {
		if (this.closed || this.session.sessionId !== this.ledger.scope.sessionId)
			throw new FlowLedgerError("stale", "Request receipt attachment is closed or replaced.");
		if (signal?.aborted) throw new FlowLedgerError("transition", "Request was cancelled before handoff.");
	}
	private async withhold(request: RequestBinding): Promise<void> {
		this.assertActive();
		if (request.handedOff) return;
		const state = await this.ledger.snapshot();
		const attempt = state.attempts.find((item) => item.id === request.composition.attemptId);
		if (attempt?.phase === "prepared")
			await this.ledger.withholdRequest(attempt.id, request.id, "Provider request failed before handoff.");
	}
	register(composition: FlowModelInput): void {
		this.assertActive();
		if (this.compositions.has(composition.attemptId))
			throw new FlowLedgerError("identity", "Attempt composition is already registered.");
		if (this.compositions.size >= 1024)
			throw new FlowLedgerError("capacity", "Request composition retention limit reached.");
		this.compositions.set(composition.attemptId, composition);
	}
	/** Call only after the controller has reconciled the attempt. */
	forget(attemptId: string): void {
		this.compositions.delete(attemptId);
	}
	close(): void {
		this.closed = true;
		this.compositions.clear();
		this.pending = undefined;
	}
}
