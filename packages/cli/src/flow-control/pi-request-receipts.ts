import type { FlowRequestInput } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type FlowModelInput, prepareFlowModelInput } from "./model-input.js";
import { FlowLedgerError, type FlowOutcome, type FlowReceiptLedger } from "./receipt-ledger.js";

/** One controller-composed request, bound to the attempt whose composition it carries. */
export interface FlowCompositionRequest {
	composition: FlowModelInput;
	id: string;
	handedOff: boolean;
}

/**
 * Ledger bookkeeping for controller-composed requests.
 *
 * This records facts and installs no hooks. One observer owns the request lifecycle
 * (`PiNativeRequests`) and drives this at the four points a composed attempt needs: prepared before
 * the request, handed off once the body is admitted, settled with the provider's outcome, and
 * withheld when the request ends before handoff. Two observers wrapping the same transport is what
 * made their install order matter, so there is only one.
 */
export class PiRequestReceipts {
	private closed = false;
	private readonly compositions = new Map<string, FlowModelInput>();

	constructor(
		private readonly session: AgentSession,
		private readonly ledger: FlowReceiptLedger,
	) {}

	/**
	 * Record the composition for a request that is about to start, or report that this request carries
	 * none. A claimed attempt without a registered composition is a fault: the controller registers
	 * every composition it dispatches.
	 */
	async prepare(
		input: FlowRequestInput,
		signal: AbortSignal | undefined,
		containsUserInput: boolean,
	): Promise<FlowCompositionRequest | undefined> {
		this.assertActive(signal);
		const state = await this.ledger.snapshot();
		const attempt = state.attempts.find((item) => item.id === state.activeAttemptId);
		if (!attempt || ["selected", "queued"].includes(attempt.phase)) return undefined;
		if (!["claimed", "running"].includes(attempt.phase))
			throw new FlowLedgerError("transition", "Prior request requires reconciliation before another request.");
		const composition = this.compositions.get(attempt.id);
		if (!composition) throw new FlowLedgerError("identity", "Claimed attempt has no registered composition.");
		await prepareFlowModelInput(this.ledger, composition, input, containsUserInput);
		const request: FlowCompositionRequest = { composition, id: input.requestId, handedOff: false };
		try {
			this.assertActive(signal);
		} catch (error) {
			await this.withhold(request);
			throw error;
		}
		return request;
	}

	/** The provider accepted the body; the composed attempt is now in flight. */
	async handedOff(request: FlowCompositionRequest, signal?: AbortSignal): Promise<void> {
		this.assertActive(signal);
		await this.ledger.handoff(request.composition.attemptId, request.id);
		request.handedOff = true;
	}

	/** Record the provider's terminal outcome for a handed-off composed request. */
	async settled(request: FlowCompositionRequest, message: AssistantMessage): Promise<void> {
		this.assertActive();
		if (!request.handedOff) {
			await this.withhold(request);
			throw new FlowLedgerError("transition", "Provider request ended without an admitted payload.");
		}
		if (!["stop", "length", "toolUse", "error", "aborted"].includes(message.stopReason))
			throw new FlowLedgerError("transition", "Provider response has no terminal outcome.");
		const outcome: FlowOutcome =
			message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "failure" : "success";
		await this.ledger.requestOutcome(request.composition.attemptId, request.id, outcome);
	}

	/** A request that never reached the provider leaves its attempt withheld, not settled. */
	async withhold(request: FlowCompositionRequest): Promise<void> {
		this.assertActive();
		if (request.handedOff) return;
		const state = await this.ledger.snapshot();
		const attempt = state.attempts.find((item) => item.id === request.composition.attemptId);
		if (attempt?.phase === "prepared")
			await this.ledger.withholdRequest(attempt.id, request.id, "Provider request failed before handoff.");
	}

	private assertActive(signal?: AbortSignal): void {
		if (this.closed || this.session.sessionId !== this.ledger.scope.sessionId)
			throw new FlowLedgerError("stale", "Request receipt attachment is closed or replaced.");
		if (signal?.aborted) throw new FlowLedgerError("transition", "Request was cancelled before handoff.");
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
	}
}
