import type { FlowAttempt, FlowLedgerState } from "./receipt-ledger.js";
import { orderFlowResultProducers } from "./result-order.js";
import { MAX_RETIRED_FLOW_IDENTITIES, retiredIdentityHash, validRetiredIdentityHash } from "./retired-identities.js";

/**
 * Summary evidence retained after pruning: replay fences, multiloop iteration counts, and
 * result-producer fairness. Context quarantine still requires full attempts, so attempts with
 * unsuccessful or omitted input remain addressable.
 */
export interface FlowRetiredAttempts {
	version: 1;
	/** Fences member replay: hash of the member id and revision. */
	members: string[];
	/** Fences cadence replay: hash of the selected work id and revision. */
	work: string[];
	/** Settled successful attempts per selected intent id, continuing iteration numbering. */
	settled: { id: string; count: number }[];
	/** The producer round carried forward so fairness does not restart at the retirement point. */
	round: string[];
}

export const emptyRetiredAttempts = (): FlowRetiredAttempts => ({
	version: 1,
	members: [],
	work: [],
	settled: [],
	round: [],
});

const identity = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= 512;

export function validateRetiredAttempts(retired: FlowRetiredAttempts): void {
	if (
		retired?.version !== 1 ||
		!Array.isArray(retired.members) ||
		!Array.isArray(retired.work) ||
		!Array.isArray(retired.settled) ||
		!Array.isArray(retired.round) ||
		retired.members.length > MAX_RETIRED_FLOW_IDENTITIES ||
		retired.work.length > MAX_RETIRED_FLOW_IDENTITIES ||
		retired.settled.length > MAX_RETIRED_FLOW_IDENTITIES ||
		retired.round.length > 64 ||
		!retired.members.every(validRetiredIdentityHash) ||
		!retired.work.every(validRetiredIdentityHash) ||
		new Set(retired.members).size !== retired.members.length ||
		new Set(retired.work).size !== retired.work.length ||
		new Set(retired.round).size !== retired.round.length ||
		!retired.round.every(identity) ||
		!retired.settled.every(
			(entry) => entry && identity(entry.id) && Number.isSafeInteger(entry.count) && entry.count > 0,
		) ||
		new Set(retired.settled.map((entry) => entry.id)).size !== retired.settled.length
	)
		throw new Error("Invalid retired attempt summary.");
}

export const retiredMemberHash = (id: string, revision: string) => retiredIdentityHash("attempt-member", id, revision);
export const retiredWorkHash = (workId: string, workRevision: string) =>
	retiredIdentityHash("attempt-work", workId, workRevision);

/** Settled successful attempts already retired for this selected intent. */
export const retiredSettledCount = (retired: FlowRetiredAttempts | undefined, id: string): number =>
	retired?.settled.find((entry) => entry.id === id)?.count ?? 0;

export const retiredByReceipt = (retired: FlowRetiredAttempts | undefined, member: string, work?: string): boolean =>
	!!retired && (retired.members.includes(member) || (work !== undefined && retired.work.includes(work)));

/**
 * Select settled attempts that no longer need context quarantine. Callers must also reconcile
 * producer delivery and wait observation before pruning. Unconsumed cancellations carry no fence.
 */
export function retirableAttempts(state: FlowLedgerState, keep: number): FlowAttempt[] {
	const settledOnly = state.attempts.filter(
		(attempt) =>
			attempt.id !== state.activeAttemptId &&
			(attempt.phase === "settled" || attempt.phase === "cancelled") &&
			!attempt.requests.some((request) => request.handedOff && request.outcome === undefined) &&
			// Persisted instructions without successful inclusion still need the full attempt for
			// context quarantine. A replay fence alone cannot keep them out of later user requests.
			!(
				attempt.admission &&
				attempt.consumed !== false &&
				attempt.members.some(
					(member) =>
						!attempt.requests.some(
							(request) =>
								request.handedOff &&
								request.outcome === "success" &&
								request.payload?.inclusion.some(
									(item) =>
										item.id === member.id &&
										item.revision === member.revision &&
										item.disposition === "included" &&
										item.contentHash === member.contentHash,
								),
						),
				)
			),
	);
	// Retire oldest first and keep the most recent settled attempts addressable for inspection.
	return settledOnly.slice(0, Math.max(0, settledOnly.length - keep));
}

/** Fold retiring attempts into the summary; the caller removes them in the same transaction. */
export function foldRetiredAttempts(
	retired: FlowRetiredAttempts,
	state: FlowLedgerState,
	retiring: readonly FlowAttempt[],
): FlowRetiredAttempts {
	const members = new Set(retired.members);
	const work = new Set(retired.work);
	const settled = new Map(retired.settled.map((entry) => [entry.id, entry.count]));
	// Fairness is replayed over the attempts being retired, seeded by the existing carried round.
	const round = orderFlowResultProducers([], { ...state, attempts: [...retiring], retiredAttempts: retired });
	for (const attempt of retiring) {
		const selected = attempt.admission?.choice.intent;
		if (attempt.phase === "cancelled" && attempt.consumed === false) continue;
		for (const member of attempt.members) members.add(retiredMemberHash(member.id, member.revision));
		if (selected && (selected.rank === 4 || selected.rank === 5) && selected.workId && selected.workRevision)
			work.add(retiredWorkHash(selected.workId, selected.workRevision));
		if (selected && attempt.phase === "settled" && attempt.outcome === "success")
			settled.set(selected.id, (settled.get(selected.id) ?? 0) + 1);
	}
	return {
		version: 1,
		members: [...members],
		work: [...work],
		settled: [...settled].map(([id, count]) => ({ id, count })),
		round,
	};
}
