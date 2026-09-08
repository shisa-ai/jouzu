import type { NativeRequest } from "./native-request-store.js";
import { type NativeSubmissionRequestView, projectNativeSubmissionRequests } from "./native-submission-view.js";
import { type FlowAttempt, FlowLedgerError, type FlowLedgerState } from "./receipt-ledger.js";
import type { RetainedSubmission } from "./submission-store.js";

export interface FlowSubmissionView {
	id: string;
	revision: number;
	admission: "pending" | "reserved" | "held" | "cancelled";
	delivery: "none" | "consumed" | "history" | "partial" | "included" | "uncertain";
	attemptIds: string[];
	nativeRequests?: NativeSubmissionRequestView[];
	nativeQueueCancellations?: { id: string; revision: number; removal: "confirmed" | "unconfirmed" | "consumed" }[];
	reason?: string;
}

/** Keep historical diagnostics in storage, but expose only holds on unconsumed live revisions. */
export function activeAdmissionHolds(record: RetainedSubmission) {
	if (record.status === "cancelled") return [];
	return (record.holds ?? []).filter((hold) =>
		hold.phase === "submission"
			? !record.dispatch
			: !record.dispatch?.queueClaims?.some(
					(claim) => claim.id === hold.queue?.id && claim.revision === hold.queue?.revision,
				),
	);
}

/** Derive durable dispositions without rewriting ingress or acknowledging work completion.
 * Call under the controller's serialized boundary; this snapshot is not a dispatch permit.
 */
export function projectFlowSubmissions(
	records: RetainedSubmission[],
	ledger: FlowLedgerState,
	nativeRequests?: NativeRequest[],
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
		const attempts = links.get(record.id) ?? [];
		const claims = record.dispatch?.queueClaims ?? [];
		const nativeHistory = !!record.dispatch?.queueHistory?.length || !!record.dispatch?.promptHistory?.length;
		const consumedNative =
			nativeHistory || !!record.dispatch?.promptClaims?.length || claims.some((claim) => claim.consumed);
		const unconsumedNative =
			!!record.dispatch?.inputs?.length &&
			record.dispatch.inputs.every(
				(input) =>
					!!input.queue &&
					claims.some(
						(claim) => claim.id === input.queue?.id && claim.revision === input.queue.revision && !claim.consumed,
					),
			);
		const ambiguous =
			attempts.length === 0 && (unlinkedConsumption || (!!record.dispatch && !consumedNative && !unconsumedNative));
		let delivery: FlowSubmissionView["delivery"] = ambiguous
			? "uncertain"
			: nativeHistory
				? "history"
				: consumedNative
					? "consumed"
					: "none";
		const admissionHolds = activeAdmissionHolds(record);
		let held = ambiguous || !!record.dispatch || admissionHolds.length > 0;
		for (const attempt of attempts) {
			const members = attempt.members.filter((member) => member.sourceSubmission?.id === record.id);
			const matches = (item: { id: string; revision: string }) =>
				members.some((member) => member.id === item.id && member.revision === item.revision);
			const includedMembers = members.filter((member) =>
				attempt.requests.some(
					(request) =>
						request.outcome === "success" &&
						request.payload?.inclusion.some(
							(item) => item.id === member.id && item.revision === member.revision && item.disposition === "included",
						),
				),
			);
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
		const fullyCancelled =
			delivery === "none" &&
			attempts.length === 0 &&
			unconsumedNative &&
			record.dispatch?.inputs?.every((input) =>
				nativeQueueCancellations?.some(
					(cancelled) => cancelled.id === input.queue?.id && cancelled.removal === "confirmed",
				),
			);

		const reserved = attempts.some((attempt) => attempt.id === ledger.activeAttemptId);
		const admission =
			record.status === "cancelled" || fullyCancelled ? "cancelled" : reserved ? "reserved" : held ? "held" : "pending";
		return {
			id: record.id,
			revision: record.revision,
			admission,
			delivery,
			attemptIds: attempts.map((attempt) => attempt.id),
			...(native ? { nativeRequests: native.get(record.id) ?? [] } : {}),
			...(nativeQueueCancellations?.length ? { nativeQueueCancellations } : {}),
			...(admission === "held"
				? {
						reason:
							(nativeQueueCancellations?.some((item) => item.removal === "unconfirmed")
								? "Queue cancellation requires removal reconciliation."
								: undefined) ??
							admissionHolds[0]?.reason ??
							(record.dispatch
								? "Native dispatch requires reconciliation before replay."
								: "Consumed or withheld input requires reconciliation before another dispatch."),
					}
				: {}),
		};
	});
}
