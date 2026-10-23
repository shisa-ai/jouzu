import { completedWithoutNativeInput } from "./native-admission.js";
import type { NativeRequest } from "./native-request-store.js";
import { type NativeSubmissionRequestView, projectNativeSubmissionRequests } from "./native-submission-view.js";
import { type FlowAttempt, FlowLedgerError, type FlowLedgerState } from "./receipt-ledger.js";
import { flowMemberIncluded } from "./request-retention.js";
import type { RetainedSubmission } from "./submission-store.js";

export const UNAVAILABLE_INPUT_REASON = "Input was not dispatched and cannot be delivered. Submit it again to run it.";

export interface FlowSubmissionView {
	id: string;
	revision: number;
	admission: "pending" | "reserved" | "held" | "cancelled";
	delivery: "none" | "consumed" | "history" | "partial" | "included" | "uncertain";
	attemptIds: string[];
	nativeRequests?: NativeSubmissionRequestView[];
	nativeContextCancellations?: { inputIndex: number; removal: "confirmed" | "unconfirmed" }[];
	nativeQueueCancellations?: { id: string; revision: number; removal: "confirmed" | "unconfirmed" | "consumed" }[];
	reason?: string;
}

/** Keep historical diagnostics in storage, but expose only holds on unconsumed live revisions. */
export function activeAdmissionHolds(record: RetainedSubmission, liveQueue?: ReadonlyMap<string, number>) {
	if (record.unavailable || record.status === "cancelled") return [];
	return (record.holds ?? []).filter((hold) => {
		if (hold.phase === "submission") return !record.dispatch;
		const queue = hold.queue;
		if (!queue) return false;
		if (record.dispatch?.queueClaims?.some((claim) => claim.id === queue.id && claim.revision === queue.revision))
			return false;
		// A queue hold clears only when the host claims or removes that exact entry. An entry the live
		// host no longer holds at that revision was discarded without a recorded claim, so no later
		// admission can clear the hold; the queue evidence is missing instead of pending.
		return liveQueue ? liveQueue.get(queue.id) === queue.revision : true;
	});
}

/** Derive durable dispositions without rewriting ingress or acknowledging work completion.
 * Call under the controller's serialized boundary; this snapshot is not a dispatch permit.
 */
export function projectFlowSubmissions(
	records: RetainedSubmission[],
	ledger: FlowLedgerState,
	nativeRequests?: NativeRequest[],
	liveQueue?: ReadonlyMap<string, number>,
): FlowSubmissionView[] {
	const native = nativeRequests ? projectNativeSubmissionRequests(records, nativeRequests) : undefined;
	const byId = new Map(records.map((record) => [record.id, record]));
	if (byId.size !== records.length) throw new FlowLedgerError("identity", "Duplicate retained submission identity.");
	const links = new Map<string, FlowAttempt[]>();
	for (const attempt of ledger.attempts) {
		const seen = new Set<string>();
		for (const member of attempt.members) {
			const source = member.sourceSubmission;
			if (!source) continue;
			const record = byId.get(source.id);
			if (
				!record ||
				source.revision > record.revision ||
				(record.status === "retained" && source.revision !== record.revision)
			)
				throw new FlowLedgerError("identity", "Attempt references a missing or changed retained submission.");
			if (!seen.has(source.id)) {
				const entries = links.get(source.id) ?? [];
				entries.push(attempt);
				links.set(source.id, entries);
				seen.add(source.id);
			}
		}
	}
	const unlinkedConsumption = ledger.attempts.some(
		(attempt) =>
			attempt.members.some((member) => !member.sourceSubmission) &&
			(attempt.consumed === true ||
				attempt.history.length > 0 ||
				attempt.requests.length > 0 ||
				(attempt.consumed === undefined && !!attempt.queue)),
	);
	return records.map((record): FlowSubmissionView => {
		if (record.submission.scope.sessionId !== ledger.scope.sessionId)
			throw new FlowLedgerError("scope", "Retained submission belongs to another session.");
		if (record.unavailable && record.status !== "cancelled")
			return {
				id: record.id,
				revision: record.revision,
				admission: "held",
				delivery: "none",
				attemptIds: [],
				reason: UNAVAILABLE_INPUT_REASON,
			};
		const attempts = links.get(record.id) ?? [];
		const claims = record.dispatch?.queueClaims ?? [];
		const nativeHistory = !!record.dispatch?.queueHistory?.length || !!record.dispatch?.promptHistory?.length;
		const consumedNative =
			nativeHistory || !!record.dispatch?.promptClaims?.length || claims.some((claim) => claim.consumed);
		const unconsumedNative =
			!!record.dispatch?.inputs?.length &&
			record.dispatch.inputs.every(
				(input, index) =>
					(input.kind === "context" &&
						!!record.dispatch?.contextCancellations?.some((item) => item.inputIndex === index && item.removed)) ||
					(!!input.queue &&
						claims.some(
							(claim) => claim.id === input.queue?.id && claim.revision === input.queue.revision && !claim.consumed,
						)),
			);
		const ambiguous =
			!completedWithoutNativeInput(record) &&
			attempts.length === 0 &&
			(unlinkedConsumption || (!!record.dispatch && !consumedNative && !unconsumedNative));
		let delivery: FlowSubmissionView["delivery"] = ambiguous
			? "uncertain"
			: nativeHistory
				? "history"
				: consumedNative
					? "consumed"
					: "none";
		const admissionHolds = activeAdmissionHolds(record, liveQueue);
		let held = ambiguous || !!record.dispatch || admissionHolds.length > 0;
		for (const attempt of attempts) {
			const members = attempt.members.filter((member) => member.sourceSubmission?.id === record.id);
			const matches = (item: { id: string; revision: string }) =>
				members.some((member) => member.id === item.id && member.revision === item.revision);
			const includedMembers = members.filter((member) => flowMemberIncluded(attempt, member));
			const included = includedMembers.length === members.length;
			const partial = includedMembers.length > 0;
			const history = attempt.history.some(matches);
			const consumed = attempt.consumed === true || history || attempt.requests.length > 0;
			// Older cancelled records lost their prior phase. Absence of receipts cannot prove no consumption.
			const legacyUnknown =
				attempt.consumed === undefined && attempt.phase === "cancelled" && !!attempt.queue && !consumed;
			const uncertain =
				attempt.phase === "uncertain" ||
				legacyUnknown ||
				attempt.requests.some((request) => request.handedOff && request.outcome === undefined);
			held ||= consumed || uncertain || attempt.phase === "withheld";
			if (uncertain) delivery = "uncertain";
			else if (delivery !== "uncertain") {
				if (included) delivery = "included";
				else if (partial && delivery !== "included") delivery = "partial";
				else if (history && delivery !== "included" && delivery !== "partial") delivery = "history";
				else if (consumed && delivery === "none") delivery = "consumed";
			}
		}
		const nativeQueueCancellations = record.dispatch?.queueCancellations?.map((cancelled) => {
			const claim = claims.find((claim) => claim.id === cancelled.id && claim.revision === cancelled.revision);
			return {
				...cancelled,
				removal: claim ? (claim.consumed ? ("consumed" as const) : ("confirmed" as const)) : ("unconfirmed" as const),
			};
		});
		const nativeContextCancellations = record.dispatch?.contextCancellations?.map((item) => ({
			inputIndex: item.inputIndex,
			removal: item.removed ? ("confirmed" as const) : ("unconfirmed" as const),
		}));
		const fullyCancelled =
			delivery === "none" &&
			attempts.length === 0 &&
			unconsumedNative &&
			record.dispatch?.inputs?.every(
				(input, index) =>
					(input.kind === "context" &&
						nativeContextCancellations?.some((item) => item.inputIndex === index && item.removal === "confirmed")) ||
					nativeQueueCancellations?.some(
						(cancelled) => cancelled.id === input.queue?.id && cancelled.removal === "confirmed",
					),
			);

		const reserved = attempts.some((attempt) => attempt.id === ledger.activeAttemptId);
		const admission =
			record.status === "cancelled" || fullyCancelled ? "cancelled" : reserved ? "reserved" : held ? "held" : "pending";
		// `held` covers every record that cannot be dispatched again, and input the model already
		// received is most of them. Name a reason only when a reader can act on it: an unreconciled
		// cancellation, a recorded admission hold, or a dispatch whose delivery is unknown. Spent input
		// carries none, and a status reader lists only what carries one.
		const reason =
			admission !== "held"
				? undefined
				: ((nativeContextCancellations?.some((item) => item.removal === "unconfirmed")
						? "Deferred context cancellation requires removal reconciliation."
						: undefined) ??
					(nativeQueueCancellations?.some((item) => item.removal === "unconfirmed")
						? "Queue cancellation requires removal reconciliation."
						: undefined) ??
					admissionHolds[0]?.reason ??
					(delivery === "uncertain" ? "Sent, but whether the model received it is not known." : undefined));
		return {
			id: record.id,
			revision: record.revision,
			admission,
			delivery,
			attemptIds: attempts.map((attempt) => attempt.id),
			...(native ? { nativeRequests: native.get(record.id) ?? [] } : {}),
			...(nativeQueueCancellations?.length ? { nativeQueueCancellations } : {}),
			...(nativeContextCancellations?.length ? { nativeContextCancellations } : {}),
			...(reason ? { reason } : {}),
		};
	});
}
