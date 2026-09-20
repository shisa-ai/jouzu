import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { FlowRequestInput } from "@earendil-works/pi-agent-core";
import { convertToLlm, type SessionManager, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { compactionHistoryEnd } from "./compaction-boundary.js";
import { inspectPersistedFlowInput } from "./model-input.js";
import type { FlowAttempt, FlowMember } from "./receipt-ledger.js";

/** Prove omissions caused by Pi's active compaction, not by a context filter. */
export function compactedFlowMembers(
	manager: SessionManager,
	attempt: FlowAttempt,
	input: FlowRequestInput,
): Pick<FlowMember, "id" | "revision">[] {
	if (!input.sourceMessages.some((message) => message.role === "compactionSummary")) return [];
	const sourceInclusion = inspectPersistedFlowInput(
		attempt.id,
		attempt.members,
		convertToLlm(input.sourceMessages).flatMap((message) =>
			message.role !== "user"
				? []
				: typeof message.content === "string"
					? [{ type: "text" as const, text: message.content }]
					: message.content,
		),
	);
	const branch = manager.getBranch();
	const compaction = branch
		.slice()
		.reverse()
		.find((entry) => entry.type === "compaction");
	if (!compaction) return [];
	const kept = compactionHistoryEnd(branch, compaction);
	if (kept < 0) return [];
	const context = manager.buildContextEntries();
	if (!context.some((entry) => entry.id === compaction.id)) return [];
	const summary = sessionEntryToContextMessages(compaction).find((message) => message.role === "compactionSummary");
	if (!summary || !input.sourceMessages.some((message) => isDeepStrictEqual(message, summary))) return [];
	const modelSummary = convertToLlm([summary])[0];
	if (!modelSummary || !input.modelMessages.some((message) => isDeepStrictEqual(message, modelSummary))) return [];
	const retained = new Set(context.map((entry) => entry.id));
	const prefix = new Map(branch.slice(0, kept).map((entry) => [entry.id, entry]));
	return attempt.members
		.filter((member) => {
			if (
				sourceInclusion.find((item) => item.id === member.id && item.revision === member.revision)?.disposition !==
				"omitted"
			)
				return false;
			const receipts = attempt.history.filter(
				(receipt) => receipt.id === member.id && receipt.revision === member.revision,
			);
			if (receipts.length !== 1) return false;
			const receipt = receipts[0];
			const entry = prefix.get(receipt.entryId);
			if (!entry || retained.has(entry.id)) return false;
			if (receipt.entryHash && createHash("sha256").update(JSON.stringify(entry)).digest("hex") !== receipt.entryHash)
				return false;
			const content =
				entry.type === "custom_message"
					? entry.content
					: entry.type === "message" && entry.message.role === "user"
						? entry.message.content
						: undefined;
			if (content === undefined) return false;
			const parts = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
			return inspectPersistedFlowInput(attempt.id, [member], parts)[0].disposition === "included";
		})
		.map(({ id, revision }) => ({ id, revision }));
}
