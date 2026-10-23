import type { FlowNativeInput, FlowSubmissionDispatch, RetainedSubmission } from "./submission-store.js";
import { activeAdmissionHolds, UNAVAILABLE_INPUT_REASON } from "./submission-view.js";

/** Bounded identity length, matching retained submission identity. */
const MAX_IDENTITY = 512;
/** Opaque target tokens are host-issued; this only bounds what a caller may hand back. */
const MAX_TARGET = 1024;

const ADMISSION_HOLD = "Input is waiting for admission.";
const HANDLED_WITHOUT_INPUT = "The input handler completed without passing this input to the model.";
const SUBMISSION_CANCELLED = "The retained input was cancelled before delivery.";
const QUEUE_CANCELLED = "The queued input was removed before it ran.";
const CONTEXT_CANCELLED = "The deferred context was removed before it ran.";
const DISPATCH_FAILED = "Native dispatch failed before it produced input, so delivery is unconfirmed.";
const DISPATCH_UNCONFIRMED = "Input was dispatched without a receipt that confirms or rules out delivery.";
const QUEUE_EVIDENCE_MISSING = "The queued input is not in the live host queue, so delivery is unconfirmed.";
const CANCELLATION_UNCONFIRMED = "A cancellation was requested but the native removal is not confirmed.";
const FLOW_SUSPENDED = "Flow control was suspended before this input was delivered.";
const UNAUTHORIZED = "The adapter's authorization was revoked before this input was delivered.";

/** Host-issued provenance for one authorized external-user submission. */
export interface UserInputProvenance {
	adapterId: string;
	messageId: string;
	version: 1;
}

/** Committed journal ordering. Receipts order by this, never by a record's own revision. */
export interface UserInputJournalPosition {
	generation: number;
	revision: number;
}

export type UserInputReceiptState = "retained" | "held" | "queued" | "consumed" | "rejected" | "cancelled" | "unknown";

export type UserInputReceiptReasonCode =
	| "admission-hold"
	| "handled-without-input"
	| "submission-cancelled"
	| "flow-suspended"
	| "unauthorized"
	| "queue-cancelled"
	| "context-cancelled"
	| "callback-ended"
	| "dispatch-failed"
	| "dispatch-unconfirmed"
	| "queue-evidence-missing"
	| "cancellation-unconfirmed";

export interface UserInputReceiptReason {
	code: UserInputReceiptReasonCode;
	/** Fixed display text: never message text, a filesystem path, or a raw error. */
	text: string;
}

/** One projected receipt. It carries no message text and no other adapter's evidence. */
export interface UserInputReceipt {
	version: 1;
	adapterId: string;
	messageId: string;
	target: string;
	generation: number;
	revision: number;
	state: UserInputReceiptState;
	reason?: UserInputReceiptReason;
}

export interface UserInputReceiptSource {
	/** The retained record for this adapter's own message. */
	record: RetainedSubmission;
	/** Provenance the caller already matched against the record's stored host-issued provenance. */
	provenance: UserInputProvenance;
	/** Stable session/branch target the submission was addressed to. */
	target: string;
	/** Committed journal position this projection reports, and that later updates order by. */
	journal: UserInputJournalPosition;
	/**
	 * Exact native queue identities the host still holds, as id to current revision. Omit when no live
	 * view exists: an identity held at another revision is not evidence for this input either.
	 */
	liveQueue?: ReadonlyMap<string, number>;
}

type CancelledCode = "queue-cancelled" | "context-cancelled";
type UnconfirmedCode = "dispatch-unconfirmed" | "queue-evidence-missing" | "cancellation-unconfirmed";

type InputDisposition =
	| { kind: "consumed" }
	| { kind: "queued" }
	| { kind: "cancelled"; code: CancelledCode }
	| { kind: "unconfirmed"; code: UnconfirmedCode };

function cancelledText(code: CancelledCode): string {
	return code === "queue-cancelled" ? QUEUE_CANCELLED : CONTEXT_CANCELLED;
}

function unconfirmedReason(code: UnconfirmedCode): UserInputReceiptReason {
	if (code === "queue-evidence-missing") return { code, text: QUEUE_EVIDENCE_MISSING };
	if (code === "cancellation-unconfirmed") return { code, text: CANCELLATION_UNCONFIRMED };
	return { code, text: DISPATCH_UNCONFIRMED };
}

/** Receipt fields stay printable, so a serialized receipt cannot carry control sequences. */
function printable(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code <= 0x1f || code === 0x7f) return false;
	}
	return true;
}

function bounded(value: unknown, limit: number): boolean {
	return typeof value === "string" && value.length > 0 && value.length <= limit && printable(value);
}

/**
 * The caller restricts provenance, so reject shapes that could mint a receipt for another message.
 *
 * The record itself is store-validated; only what the caller supplies is checked here, because an
 * empty target or an unbounded message ID would produce a receipt that cannot be looked up safely.
 */
function validateSource(source: UserInputReceiptSource): void {
	const provenance = source.provenance;
	if (
		provenance?.version !== 1 ||
		!bounded(provenance.adapterId, MAX_IDENTITY) ||
		!bounded(provenance.messageId, MAX_IDENTITY)
	)
		throw new TypeError("Invalid external-user receipt provenance.");
	if (!bounded(source.target, MAX_TARGET)) throw new TypeError("Invalid external-user receipt target.");
	const journal = source.journal;
	if (
		!journal ||
		!Number.isSafeInteger(journal.generation) ||
		journal.generation < 0 ||
		!Number.isSafeInteger(journal.revision) ||
		journal.revision < 0
	)
		throw new TypeError("Invalid external-user receipt journal position.");
}

/** Native prompt inputs carry their messages in the first argument, and a single message is not an array. */
function messageCount(input: FlowNativeInput): number {
	const first = input.args[0];
	return Array.isArray(first) ? first.length : 1;
}

/** A prompt input is consumed only when every message position it delivered has a durable claim. */
function promptClaimed(dispatch: FlowSubmissionDispatch, inputIndex: number, input: FlowNativeInput): boolean {
	const count = messageCount(input);
	if (count < 1) return false;
	const claimed = new Set(
		(dispatch.promptClaims ?? []).filter((claim) => claim.inputIndex === inputIndex).map((claim) => claim.messageIndex),
	);
	for (let messageIndex = 0; messageIndex < count; messageIndex++) if (!claimed.has(messageIndex)) return false;
	return true;
}

/**
 * One observed native input reads as consumed, queued, exactly cancelled, or unconfirmed.
 *
 * A queue identity is judged only by receipts for that exact identity and revision. An identity the live
 * host no longer holds at that revision proves nothing about delivery, so it stays unconfirmed instead of
 * reading as queued or as safely cancellable.
 */
function inputDisposition(
	dispatch: FlowSubmissionDispatch,
	input: FlowNativeInput,
	inputIndex: number,
	liveQueue?: ReadonlyMap<string, number>,
): InputDisposition {
	const queue = input.queue;
	if (queue) {
		const claims = (dispatch.queueClaims ?? []).filter(
			(claim) => claim.id === queue.id && claim.revision === queue.revision,
		);
		if (claims.some((claim) => claim.consumed)) return { kind: "consumed" };
		const cancellation = (dispatch.queueCancellations ?? []).some(
			(item) => item.id === queue.id && item.revision === queue.revision,
		);
		if (cancellation)
			return claims.some((claim) => !claim.consumed)
				? { kind: "cancelled", code: "queue-cancelled" }
				: { kind: "unconfirmed", code: "cancellation-unconfirmed" };
		return liveQueue?.get(queue.id) === queue.revision
			? { kind: "queued" }
			: { kind: "unconfirmed", code: "queue-evidence-missing" };
	}
	if (promptClaimed(dispatch, inputIndex, input)) return { kind: "consumed" };
	const context = (dispatch.contextCancellations ?? []).filter((item) => item.inputIndex === inputIndex);
	if (context.length)
		return context.some((item) => item.removed)
			? { kind: "cancelled", code: "context-cancelled" }
			: { kind: "unconfirmed", code: "cancellation-unconfirmed" };
	return { kind: "unconfirmed", code: "dispatch-unconfirmed" };
}

/**
 * Cancellation is confirmed only where the journal proves no input can still be delivered: before any
 * dispatch intent, or for every observed native input. A cancelled record whose queued input the host
 * still holds may still be consumed, so it is not reported as a definitive cancellation.
 */
function cancellationConfirmed(record: RetainedSubmission, dispositions: InputDisposition[]): boolean {
	const cancelled = record.status === "cancelled";
	if (!cancelled && !dispositions.some((item) => item.kind === "cancelled")) return false;
	const dispatch = record.dispatch;
	if (!dispatch) return cancelled;
	// A dispatch still in flight may yet produce or consume input.
	if (dispatch.phase === "started") return false;
	if (!dispatch.inputs?.length) return cancelled;
	return dispositions.every((item) => item.kind === "cancelled");
}

/** A durable cancellation cause is the actionable reason; the record's own status is the fallback. */
function durableCancellationReason(
	reason: RetainedSubmission["cancellationReason"],
): UserInputReceiptReason | undefined {
	if (reason === "flow-suspended") return { code: "flow-suspended", text: FLOW_SUSPENDED };
	if (reason === "unauthorized") return { code: "unauthorized", text: UNAUTHORIZED };
	return undefined;
}

function cancellationReason(record: RetainedSubmission, dispositions: InputDisposition[]): UserInputReceiptReason {
	const durable = durableCancellationReason(record.cancellationReason);
	if (durable) return durable;
	if (record.status === "cancelled") return { code: "submission-cancelled", text: SUBMISSION_CANCELLED };
	for (const item of dispositions)
		if (item.kind === "cancelled") return { code: item.code, text: cancelledText(item.code) };
	return { code: "submission-cancelled", text: SUBMISSION_CANCELLED };
}

/**
 * Project one authorized external-user submission's receipt from existing journal evidence.
 *
 * Pure: it dispatches nothing, mutates nothing, and keeps no delivery log of its own. Consumption means
 * native delivery, never provider success, model observation, or the completion of the actions the
 * message asked for. Evidence is read in one order, and the first state the journal proves wins:
 *
 * 1. `consumed` — an observed native input has its durable consumption receipt. It outranks later
 *    provider failure, a cancelled record, and missing history corroboration, because input the host
 *    already took must never be reported as deliverable again.
 * 2. `rejected` — the dispatch returned and recorded that it produced no native input at all.
 * 3. `cancelled` — the record, or every observed native input, is exactly cancelled. A recorded durable
 *    cause names the reason; otherwise the cancellation that was proven does.
 * 4. `held` — an active admission hold is recorded on the record.
 * 5. `queued` — every observed native queue input is still in the live host queue at its revision.
 * 6. `retained` — the record is durable with no dispatch intent yet.
 * 7. `unknown` — everything else, including a dispatch that started without a receipt.
 *
 * Callers supply provenance, target, and journal position; none of them are derived from the record, so
 * a caller must project only records whose stored host-issued provenance equals `provenance` and whose
 * stable target equals `target`. Receipts for other messages, text the adapter did not submit, and raw
 * errors are never returned. Queued evidence needs the exact queue identity at its exact revision, so
 * omitting `liveQueue` (after a restart, or from another attachment) makes it unknown rather than
 * assumed. A durable cancellation cause on the record names the reason a cancelled receipt reports. A
 * submission refused before retention has no record, so its structured error comes from the submit path
 * rather than from a receipt.
 *
 * A receipt reports a disposition. It is not a dispatch permit, and no state it returns authorizes
 * issuing the same message again.
 */
export function projectUserInputReceipt(source: UserInputReceiptSource): UserInputReceipt {
	validateSource(source);
	const { record, provenance, target, journal, liveQueue } = source;
	const receipt = (state: UserInputReceiptState, reason?: UserInputReceiptReason): UserInputReceipt => ({
		version: 1,
		adapterId: provenance.adapterId,
		messageId: provenance.messageId,
		target,
		generation: journal.generation,
		revision: journal.revision,
		state,
		...(reason ? { reason } : {}),
	});

	const dispatch = record.dispatch;
	const inputs = dispatch?.inputs ?? [];
	const dispositions = dispatch
		? inputs.map((input, inputIndex) => inputDisposition(dispatch, input, inputIndex, liveQueue))
		: [];
	// One consumed native input settles the message: delivery happened, so the receipt never invites a
	// resend. Partial consumption is still consumption, and later failure or reset cannot undo it.
	if (dispositions.some((item) => item.kind === "consumed")) return receipt("consumed");
	// A handled prompt that inserted nothing is a definitive refusal, not an unknown delivery.
	if (dispatch?.phase === "returned" && dispatch.noInput === true && !inputs.length)
		return receipt("rejected", { code: "handled-without-input", text: HANDLED_WITHOUT_INPUT });
	if (cancellationConfirmed(record, dispositions))
		return receipt("cancelled", cancellationReason(record, dispositions));
	const holds = activeAdmissionHolds(record, liveQueue);
	if (holds.length) return receipt("held", { code: "admission-hold", text: ADMISSION_HOLD });
	// The callback that owned this record ended before any dispatch, so nothing will deliver it and no
	// delivery can have happened. It stays inspectable without being replayed on its own.
	if (record.unavailable === "callback-ended")
		return receipt("unknown", { code: "callback-ended", text: UNAVAILABLE_INPUT_REASON });
	if (dispositions.length && dispositions.every((item) => item.kind === "queued")) return receipt("queued");
	if (!dispatch && record.status === "retained") return receipt("retained");
	if (dispatch?.phase === "failed" && !inputs.length)
		return receipt("unknown", { code: "dispatch-failed", text: DISPATCH_FAILED });
	for (const item of dispositions)
		if (item.kind === "unconfirmed") return receipt("unknown", unconfirmedReason(item.code));
	return receipt("unknown", { code: "dispatch-unconfirmed", text: DISPATCH_UNCONFIRMED });
}
