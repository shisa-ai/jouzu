import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { inspectPersistedFlowInput } from "./model-input.js";
import { verifyPiHistoryEntry } from "./pi-history-receipts.js";
import { FlowLedgerError, type FlowReceiptLedger } from "./receipt-ledger.js";

/** Recover missing history evidence on an exclusively attached, inactive branch. Never append input. */
export async function recoverPiHistory(
	manager: SessionManager,
	ledger: FlowReceiptLedger,
): Promise<{ recovered: number; unresolved: number }> {
	if (manager.getSessionId() !== ledger.scope.sessionId)
		throw new FlowLedgerError("scope", "History recovery belongs to another session.");
	const state = await ledger.snapshot();
	if (state.generation !== ledger.generation)
		throw new FlowLedgerError("stale", "History recovery attachment was replaced.");
	if (state.activeAttemptId) throw new FlowLedgerError("busy", "History recovery requires no active attempt.");
	const leaf = manager.getLeafId();
	const assertCurrent = () => {
		if (manager.getSessionId() !== ledger.scope.sessionId || manager.getLeafId() !== leaf)
			throw new FlowLedgerError("stale", "History branch changed during recovery.");
	};
	const entries = manager.getBranch();
	let recovered = 0,
		unresolved = 0;
	for (const attempt of state.attempts) {
		if (attempt.consumed === false) continue;
		const missing = attempt.members.filter(
			(member) =>
				!attempt.history.some(
					(receipt) => receipt.id === member.id && receipt.revision === member.revision && receipt.entryHash,
				),
		);
		if (!missing.length) continue;
		if (attempt.consumed !== true) {
			unresolved += missing.length;
			continue;
		}
		const candidates = new Map<string, { entryId: string; count: number; included: boolean }>();
		for (const entry of entries) {
			const content =
				entry.type === "custom_message"
					? entry.content
					: entry.type === "message" && entry.message.role === "user"
						? entry.message.content
						: undefined;
			if (content === undefined) continue;
			const parts = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
			if (!Array.isArray(parts)) continue;
			for (const member of inspectPersistedFlowInput(attempt.id, missing, parts)) {
				if (member.disposition === "omitted") continue;
				const key = JSON.stringify([member.id, member.revision]);
				const prior = candidates.get(key);
				candidates.set(key, {
					entryId: entry.id,
					count: (prior?.count ?? 0) + 1,
					included: member.disposition === "included",
				});
			}
		}
		const proofs = new Map<string, string>();
		const receipts = [];
		for (const member of missing) {
			const candidate = candidates.get(JSON.stringify([member.id, member.revision]));
			if (candidate?.count !== 1 || !candidate.included) {
				unresolved++;
				continue;
			}
			let entryHash = proofs.get(candidate.entryId);
			if (!entryHash) {
				const evidence = await verifyPiHistoryEntry(manager, candidate.entryId);
				assertCurrent();
				if (evidence.kind !== "persisted") {
					unresolved++;
					continue;
				}
				entryHash = evidence.entryHash;
				proofs.set(candidate.entryId, entryHash);
			}
			receipts.push({ id: member.id, revision: member.revision, entryId: candidate.entryId, entryHash });
		}
		if (receipts.length) {
			assertCurrent();
			await ledger.recoverHistory(attempt.id, receipts);
			recovered += receipts.length;
		}
	}
	assertCurrent();
	return { recovered, unresolved };
}
