import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { verifyPiHistoryEntries } from "./pi-history-reader.js";
import { PiHostHooks } from "./pi-host-hooks.js";
import { type FlowAttempt, FlowLedgerError, type FlowReceiptLedger } from "./receipt-ledger.js";

export { type PiHistoryEvidence, verifyPiHistoryEntries, verifyPiHistoryEntry } from "./pi-history-reader.js";

interface ClaimedInput {
	role: AgentMessage["role"];
	attemptId?: string;
	members: Pick<FlowAttempt["history"][number], "id" | "revision">[];
}
interface PendingHistory {
	attemptId: string;
	entryId: string;
	members: ClaimedInput["members"];
}

/** Install after queue receipts and after AgentSession's own awaited persistence listener. */
export class PiHistoryReceipts {
	private readonly hooks = new PiHostHooks();
	private closed = false;
	private readonly claimed: ClaimedInput[] = [];
	private readonly starting = new WeakMap<object, ClaimedInput>();
	private readonly pending = new Map<string, PendingHistory>();
	private readonly unsubscribe: () => void;

	constructor(
		private readonly session: AgentSession,
		private readonly ledger: FlowReceiptLedger,
	) {
		const previous = session.agent.flowCheckpoints;
		this.hooks.set(session.agent, "flowCheckpoints", {
			...previous,
			afterQueueClaim: async (receipt, signal) => {
				this.assertActive();
				await previous?.afterQueueClaim?.(receipt, signal);
				const state = await ledger.snapshot();
				this.assertActive();
				for (const item of receipt.claimed) {
					const attempt = state.attempts.find(
						(candidate) =>
							candidate.generation === ledger.generation &&
							candidate.phase === "claimed" &&
							candidate.queue?.id === item.id &&
							candidate.queue.revision === item.revision,
					);
					this.claimed.push({
						role: item.message.role,
						attemptId: attempt?.id,
						members: attempt?.members.map(({ id, revision }) => ({ id, revision })) ?? [],
					});
				}
			},
		});
		this.unsubscribe = session.agent.subscribe(async (event) => {
			this.assertActive();
			if (
				event.type === "agent_end" ||
				(event.type === "message_start" &&
					event.message.role === "assistant" &&
					["error", "aborted"].includes(event.message.stopReason))
			)
				this.claimed.length = 0;
			if (event.type === "message_start" && event.message.role !== "system" && this.claimed.length) {
				const input = this.claimed.shift();
				if (!input || input.role !== event.message.role)
					throw new FlowLedgerError("identity", "Claimed input does not match native message order.");
				this.starting.set(event.message, input);
			}
			if (event.type !== "message_end") return;
			const input = this.starting.get(event.message);
			this.starting.delete(event.message);
			if (input?.attemptId) {
				const entry = session.sessionManager.getLeafEntry();
				const matches =
					entry?.type === "message"
						? entry.message === event.message
						: entry?.type === "custom_message" &&
							event.message.role === "custom" &&
							entry.content === event.message.content &&
							entry.customType === event.message.customType;
				if (!matches || !entry)
					throw new FlowLedgerError("identity", "Native history entry does not match the consumed message.");
				this.pending.set(entry.id, { attemptId: input.attemptId, entryId: entry.id, members: input.members });
			}
			await this.flush();
		});
	}
	private assertActive(): void {
		if (this.closed || this.session.sessionManager.getSessionId() !== this.ledger.scope.sessionId)
			throw new FlowLedgerError("stale", "History receipt attachment is closed or replaced.");
	}
	async flush(): Promise<void> {
		this.assertActive();
		const pendingEntries = [...this.pending];
		const proofs = await verifyPiHistoryEntries(
			this.session.sessionManager,
			pendingEntries.map(([id]) => id),
		);
		this.assertActive();
		for (const [id, pending] of pendingEntries) {
			const evidence = proofs.get(id);
			if (evidence?.kind !== "persisted") continue;
			await this.ledger.history(
				pending.attemptId,
				pending.members.map((member) => ({ ...member, entryId: id, entryHash: evidence.entryHash })),
			);
			this.pending.delete(id);
		}
	}
	close(): void {
		this.closed = true;
		this.hooks.close();
		this.unsubscribe();
		this.claimed.length = 0;
		this.pending.clear();
	}
}
