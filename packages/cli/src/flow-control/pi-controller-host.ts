import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { FlowAdmissionGates } from "./admission.js";
import type { FlowControllerHost } from "./controller.js";
import { type FlowModelInput, inspectPersistedFlowInput } from "./model-input.js";
import { PiHistoryReceipts } from "./pi-history-receipts.js";
import { PiHostBoundary } from "./pi-host-boundary.js";
import { PiQueueReceipts } from "./pi-queue-receipts.js";
import { type PiRequestReceiptOptions, PiRequestReceipts } from "./pi-request-receipts.js";
import { FlowLedgerError, type FlowLedgerState, type FlowReceiptLedger } from "./receipt-ledger.js";

interface Pending {
	input: FlowModelInput;
	valid: () => Promise<boolean>;
	item?: { id: string; revision: number };
	revoked: boolean;
}
const attached = new WeakSet<AgentSession>();

/** Quarantine exact inactive instructions lacking successful inclusion; leave durable history intact. */
function quarantine(messages: AgentMessage[], state: FlowLedgerState): AgentMessage[] {
	const inactive = state.attempts.filter((attempt) => attempt.admission && attempt.id !== state.activeAttemptId);
	return messages.flatMap((message): AgentMessage[] => {
		if (message.role !== "user" && message.role !== "custom") return [message];
		const content =
			typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		if (!Array.isArray(content)) return [message];
		const frames = new Map<string, number>();
		for (const attempt of inactive) {
			const members = attempt.members.filter(
				(member) =>
					!attempt.requests.some(
						(request) =>
							request.outcome === "success" &&
							request.payload?.inclusion.some(
								(item) => item.id === member.id && item.revision === member.revision && item.disposition === "included",
							),
					),
			);
			const receipts = inspectPersistedFlowInput(attempt.id, members, content);
			for (let i = 0; i < members.length; i++) {
				if (receipts[i].disposition === "omitted") continue;
				const member = members[i];
				if (receipts[i].disposition !== "included" || !member.inputFrame || member.kind === "user")
					throw new FlowLedgerError("identity", "Inactive flow input cannot be safely excluded from model context.");
				frames.set(
					JSON.stringify(["jouzu-flow", attempt.id, member.inputFrame.id, member.inputFrame.revision]),
					member.inputFrame.parts,
				);
			}
		}
		if (!frames.size) return [message];
		const kept = [];
		for (let i = 0; i < content.length; i++) {
			const part = content[i];
			let count: number | undefined;
			if (part?.type === "text") {
				try {
					count = frames.get(JSON.stringify(JSON.parse(part.text)?.flowInput));
				} catch {
					/* Ordinary context text. */
				}
			}
			if (count) i += count - 1;
			else kept.push(part);
		}
		return kept.length ? [{ ...message, content: kept }] : [];
	});
}

/** One Pi bridge joins queue, history, provider receipts, and native run settlement. */
export class PiControllerHost implements FlowControllerHost {
	private readonly queue: PiQueueReceipts;
	private readonly history: PiHistoryReceipts;
	private readonly requests: PiRequestReceipts;
	private readonly boundary: PiHostBoundary;
	private pending?: Pending;
	private closed = false;

	constructor(
		private readonly session: AgentSession,
		readonly ledger: FlowReceiptLedger,
		options: PiRequestReceiptOptions,
		private readonly policy: () => Omit<FlowAdmissionGates, "hostReady">,
	) {
		if (attached.has(session)) throw new FlowLedgerError("identity", "Pi session already has a flow controller host.");
		if (!Number.isSafeInteger(options.maxPayloadBytes) || options.maxPayloadBytes < 1)
			throw new FlowLedgerError("capacity", "Invalid provider payload byte limit.");
		if (session.sessionId !== ledger.scope.sessionId || !session.isIdle || session.agent.state.isStreaming)
			throw new FlowLedgerError("scope", "Flow host requires the matching idle session.");
		attached.add(session);
		this.queue = new PiQueueReceipts(session.agent, ledger);
		this.history = new PiHistoryReceipts(session, ledger);
		this.requests = new PiRequestReceipts(session, ledger, options);
		this.boundary = new PiHostBoundary(session);
		const transform = session.agent.transformContext;
		session.agent.transformContext = async (messages, signal) => {
			this.assertActive();
			const state = await ledger.snapshot();
			const admitted = quarantine(messages, state);
			const result = transform ? await transform(admitted, signal) : admitted;
			this.assertActive();
			return quarantine(result, state);
		};
		const previous = session.agent.flowCheckpoints;
		session.agent.flowCheckpoints = {
			...previous,
			beforeQueueClaim: async (items, signal) => {
				this.assertActive();
				const accepted = previous?.beforeQueueClaim ? await previous.beforeQueueClaim(items, signal) : true;
				const pending = this.pending;
				if (pending?.item && items.some((item) => item.id === pending.item?.id)) {
					let valid = false;
					try {
						valid = !pending.revoked && (await pending.valid());
					} finally {
						if (!valid || pending.revoked || signal?.aborted) this.invalidate();
					}
				}
				this.assertActive();
				return accepted;
			},
		};
	}
	private assertActive(): void {
		if (this.closed || this.session.sessionId !== this.ledger.scope.sessionId)
			throw new FlowLedgerError("stale", "Pi controller host is closed or replaced.");
		this.boundary.assertAttachedBranch();
	}
	gate(): FlowAdmissionGates {
		this.assertActive();
		const gate = this.policy();
		return {
			...gate,
			userPending:
				gate.userPending ||
				this.session.agent.inspectQueuedMessages().some((item) => item.id !== this.pending?.item?.id),
			hostReady: this.session.isIdle && !this.session.agent.state.isStreaming && !this.session.isRetrying,
		};
	}
	atIdle<T>(run: () => Promise<T>) {
		this.boundary.assertAttachedBranch();
		return this.boundary.atIdle(run);
	}
	async enqueue(input: FlowModelInput, valid: () => Promise<boolean>): Promise<void> {
		this.assertActive();
		if (this.pending) throw new FlowLedgerError("busy", "A controller input is already pending.");
		const pending: Pending = { input, valid, revoked: false };
		this.pending = pending;
		this.requests.register(input);
		await this.queue.enqueue(input.attemptId, () => {
			if (pending.revoked) throw new FlowLedgerError("stale", "Controller input was revoked before enqueue.");
			pending.item = this.session.agent.followUp({ role: "user", content: input.content, timestamp: Date.now() });
		});
	}
	async run(): Promise<void> {
		this.assertActive();
		await this.session.continueQueued();
	}
	invalidate(): void {
		const pending = this.pending;
		if (!pending) return;
		pending.revoked = true;
		if (pending.item) this.session.agent.cancelQueuedMessage(pending.item.id, pending.item.revision);
	}
	async reconcile(attemptId: string): Promise<void> {
		this.assertActive();
		const state = await this.ledger.snapshot();
		if (!this.session.isIdle || this.session.agent.state.isStreaming || this.session.isRetrying) return;
		const attempt = state.attempts.find((item) => item.id === attemptId);
		if (state.activeAttemptId === attemptId && attempt && ["selected", "queued"].includes(attempt.phase)) {
			this.invalidate();
			await this.ledger.cancel(attemptId, "Controller input was not consumed by the native run.");
		} else {
			await this.boundary.atIdle(() => this.history.flush());
			await this.boundary.reconcile(this.ledger, attemptId);
		}
		if ((await this.ledger.snapshot()).activeAttemptId !== attemptId) {
			this.requests.forget(attemptId);
			if (this.pending?.input.attemptId === attemptId) this.pending = undefined;
		}
	}
	async abort(): Promise<void> {
		await this.boundary.abortAndJoin();
	}
	async close(): Promise<void> {
		if (this.closed) return;
		if (!this.session.isIdle || this.session.agent.state.isStreaming)
			throw new FlowLedgerError("busy", "Pi controller host must settle before close.");
		if (this.pending) await this.reconcile(this.pending.input.attemptId);
		this.closed = true;
		this.history.close();
		this.requests.close();
		this.queue.close();
		this.boundary.close();
	}
}
