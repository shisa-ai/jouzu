import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { verifyPiHistoryEntry } from "./pi-history-receipts.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import type { FlowSubmissionStore } from "./submission-store.js";

interface Claimed {
	message: AgentMessage;
	id: string;
	revision: number;
	operationId?: string;
}

/** Match native claim order after Pi's awaited transcript listener, including unowned queue entries. */
export class PiNativeQueueHistory {
	private readonly claimed: Claimed[] = [];
	private readonly starting = new WeakMap<object, Claimed>();
	private readonly unsubscribe: () => void;
	constructor(session: AgentSession, store: FlowSubmissionStore) {
		this.unsubscribe = session.agent.subscribe(async (event) => {
			if (session.sessionId !== store.scope.sessionId)
				throw new FlowLedgerError("stale", "Native history attachment belongs to another session.");
			if (
				event.type === "agent_end" ||
				(event.type === "message_start" &&
					event.message.role === "assistant" &&
					["error", "aborted"].includes(event.message.stopReason))
			)
				this.claimed.length = 0;
			if (event.type === "message_start" && this.claimed.length) {
				const input = this.claimed.shift();
				if (!input || !isDeepStrictEqual(input.message, event.message))
					throw new FlowLedgerError("identity", "Native consumed message differs from its queue claim.");
				this.starting.set(event.message, input);
			}
			if (event.type !== "message_end") return;
			const input = this.starting.get(event.message);
			this.starting.delete(event.message);
			if (!input?.operationId) return;
			if (!isDeepStrictEqual(input.message, event.message))
				throw new FlowLedgerError("identity", "Native consumed message changed before history persistence.");
			const manager = session.sessionManager;
			const entry = manager.getLeafEntry();
			const matches =
				entry?.type === "message"
					? entry.message === event.message
					: entry?.type === "custom_message" &&
						event.message.role === "custom" &&
						entry.content === event.message.content &&
						entry.customType === event.message.customType;
			if (!matches || !entry)
				throw new FlowLedgerError("identity", "Native transcript entry differs from its consumed message.");
			manager.flush();
			const evidence = await verifyPiHistoryEntry(manager, entry.id);
			if (evidence.kind === "memory") return;
			if (evidence.kind !== "persisted")
				throw new FlowLedgerError("identity", "Native transcript entry was not persisted.");
			await store.recordQueueHistory(input.operationId, {
				id: input.id,
				revision: input.revision,
				entryId: entry.id,
				entryHash: evidence.entryHash,
			});
		});
	}
	accept(inputs: Claimed[]): void {
		this.claimed.push(...structuredClone(inputs));
	}
	close(): void {
		this.unsubscribe();
		this.claimed.length = 0;
	}
}
