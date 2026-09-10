import { createHash } from "node:crypto";
import type { FlowLedgerState, FlowMember } from "./receipt-ledger.js";

/**
 * Permission for the model to end a turn without replying.
 *
 * This is deliberately the narrowest thing the contract allows. A run qualifies only when it
 * carries nothing the user is owed an answer about: no user instruction, and every member a result
 * rather than requested work or a wait decision. Anything else — a lane continuation, a wait
 * outcome, a user message joining the run — is something the model was asked to act on, so silence
 * would drop it.
 *
 * The permission names one attempt, which is what the model is offered alongside that run's results.
 * Eligibility is re-decided when the tool runs, against every request the run has recorded, so
 * queued user input that joined after the offer withdraws it. Nothing here persists across runs:
 * a token whose attempt is no longer current is refused.
 */
export const NO_REPLY_MEMBER_KINDS = new Set(["result"]);

export function flowNoReplyToken(attemptId: string): string {
	return createHash("sha256")
		.update(JSON.stringify(["jouzu-flow-no-reply", attemptId]))
		.digest("hex");
}

/** The token a notification-only run may offer, or undefined when the model owes a reply. */
export function flowNoReplyPermission(attempt: {
	id: string;
	members: readonly Pick<FlowMember, "kind">[];
}): string | undefined {
	// An empty run is not notification-only; it is a run with nothing to notify about.
	if (!attempt.members.length) return undefined;
	if (!attempt.members.every((member) => NO_REPLY_MEMBER_KINDS.has(member.kind))) return undefined;
	return flowNoReplyToken(attempt.id);
}

export type FlowNoReplyRefusal =
	| "unknown-run"
	| "stale-run"
	| "carries-user-input"
	| "carries-requested-work"
	| "empty-run";

/**
 * Validate a token against current ledger state. The attempt must still be the active one, so a
 * token from a settled or superseded run cannot terminate a later turn.
 */
export function checkFlowNoReply(
	state: FlowLedgerState,
	token: unknown,
): { allowed: true; attemptId: string } | { allowed: false; reason: FlowNoReplyRefusal } {
	const attempt = state.attempts.find((candidate) => candidate.id === state.activeAttemptId);
	if (!attempt || typeof token !== "string" || !token) return { allowed: false, reason: "unknown-run" };
	const request = attempt.requests.at(-1);
	if (!request) return { allowed: false, reason: "unknown-run" };
	if (token !== flowNoReplyToken(attempt.id)) return { allowed: false, reason: "stale-run" };
	// Any request of the run, not only the newest: a user message that joined mid-run stays behind
	// the assistant turns that followed it, so the newest request alone can no longer see it.
	if (attempt.requests.some((joined) => joined.containsUserInput))
		return { allowed: false, reason: "carries-user-input" };
	if (!attempt.members.length) return { allowed: false, reason: "empty-run" };
	if (!attempt.members.every((member) => NO_REPLY_MEMBER_KINDS.has(member.kind)))
		return { allowed: false, reason: "carries-requested-work" };
	return { allowed: true, attemptId: attempt.id };
}

export const NO_REPLY_REFUSALS: Record<FlowNoReplyRefusal, string> = {
	"unknown-run": "This turn has no current flow run, so there is nothing to end without replying.",
	"stale-run": "That permission belongs to an earlier run. Answer this turn instead.",
	"carries-user-input": "This run carries user input, which is owed a reply.",
	"carries-requested-work": "This run carries requested work or a wait decision, which is owed a reply.",
	"empty-run": "This run carries nothing to notify about.",
};
