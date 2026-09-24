import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { FlowAdmissionGates } from "./admission.js";
import type { FlowNativeInput, RetainedSubmission } from "./submission-store.js";

type FlowSubmission = RetainedSubmission["submission"];
export type NativeAdmissionDecision = { allowed: true } | { allowed: false; reason: string };

/** Origin is supplied by the installed host binding, never by message content. */
export function isNativeUserInput(submission: FlowSubmission): boolean {
	return submission.origin.kind === "host" && ["prompt", "steer", "followUp"].includes(submission.api);
}

/**
 * A send the host attributed to the user's own command invocation.
 *
 * Pi records the invocation while the registered command's handler is active, and only for the
 * extension that owns the command, so this is host-assigned provenance rather than a caller's label.
 * The send is how a command answers the user, such as a `/goal` handler prompting the agent to resume
 * the goal: holding it leaves the command with no visible effect at all, which reads as a broken
 * command rather than a decision the user can make.
 */
export function isUserCommandSubmission(submission: FlowSubmission): boolean {
	return submission.userCommand !== undefined;
}

/** Whether this submission carries the user's own instruction: typed input, or a command's own send. */
export function isUserInstruction(submission: FlowSubmission): boolean {
	return isNativeUserInput(submission) || isUserCommandSubmission(submission);
}

/**
 * A retained record whose native call never ran: no dispatch intent, or a dispatch that failed before
 * producing native input. This is exactly what a new attachment can still issue on its own.
 */
export function undispatchedRecord(record: { dispatch?: { phase: string; inputs?: unknown[] } }): boolean {
	return !record.dispatch || (record.dispatch.phase === "failed" && !record.dispatch.inputs?.length);
}

/**
 * A send a reattach can still deliver: a waking continuation with no callback and no user present.
 *
 * A submission is retained before it is dispatched, so a restart between the two leaves a send the
 * session already accepted and never delivered. Nothing re-issues a continuation on its own, so
 * dropping it is silent, and the work it continues stays stalled with no visible cause. Only these
 * shapes qualify: the message is self-contained, so issuing it again is what the record says, while
 * input the user typed and sends a prior lifetime's callback would have run keep the ordinary rule
 * that they are inspected rather than replayed.
 */
export function replayableContinuation(submission: FlowSubmission): boolean {
	switch (submission.api) {
		// A typed prompt is the user's own input, which they are present to resend, unless a command issued it.
		case "prompt":
			return isUserCommandSubmission(submission);
		case "followUp":
			return isUserCommandSubmission(submission);
		case "sendUserMessage": {
			const options = submission.args[1] as { deliverAs?: string } | undefined;
			// A steer belongs to the turn it interrupts, so only a followUp continuation is still meaningful.
			return options?.deliverAs === "followUp";
		}
		case "sendCustomMessage": {
			const options = submission.args[1] as { triggerTurn?: boolean } | undefined;
			// A callback-bearing send belongs to the lifetime that composed it, so only a waking message
			// without one is self-contained enough to issue again.
			const details = (submission.args[0] as { details?: { waitContextId?: unknown } } | undefined)?.details;
			return options?.triggerTurn === true && details?.waitContextId === undefined;
		}
		default:
			return false;
	}
}

/** Only these user operations insert a queue item while the host is streaming. */
export function isNativeUserQueueSubmission(
	submission: FlowSubmission,
	host: Pick<AgentSession, "isStreaming" | "isRetrying" | "isCompacting">,
): boolean {
	if (!isNativeUserInput(submission) || !host.isStreaming || host.isRetrying || host.isCompacting) return false;
	if (submission.api === "steer" || submission.api === "followUp") return true;
	const options = submission.args[1] as { streamingBehavior?: unknown } | undefined;
	return (
		submission.hostState?.streaming === true &&
		(options?.streamingBehavior === "steer" || options?.streamingBehavior === "followUp")
	);
}
function lane(submission: FlowSubmission): string {
	const options = submission.args[1] as { deliverAs?: string; streamingBehavior?: string } | undefined;
	if (submission.api === "steer" || submission.api === "followUp") return submission.api;
	if (submission.api === "sendCustomMessage" && options?.deliverAs === "nextTurn") return "context";
	if (!submission.hostState?.streaming) return "prompt";
	return options?.deliverAs ?? options?.streamingBehavior ?? "prompt";
}
/** The host observed a completed dispatch that produced no native model or queue input. */
export function completedWithoutNativeInput(record: RetainedSubmission): boolean {
	return record.dispatch?.phase === "returned" && record.dispatch.noInput === true && !record.dispatch.inputs?.length;
}

/**
 * Whether a retained send still has input the host has not taken.
 *
 * `liveQueue` is the set of queue identities the host still holds. An unclaimed entry that is no
 * longer among them was discarded rather than delivered, which is what happens to a queued steer
 * when its run is aborted. Without that evidence such a record reads as pending forever, and since
 * pending user work holds every automated send, one dropped steer starves the session for good.
 * Omitting the set keeps the conservative reading, so a caller with no view of the queue is unchanged.
 */
export function awaitingNativeInput(record: RetainedSubmission, liveQueue?: ReadonlySet<string>): boolean {
	if (record.unavailable || record.status === "cancelled" || completedWithoutNativeInput(record)) return false;
	if (!record.dispatch) return true;
	if (record.dispatch.promptClaims?.length || record.dispatch.promptHistory?.length) return false;
	const inputs = record.dispatch.inputs;
	if (!inputs?.length) return true;
	return inputs.some((input) => {
		if (!input.queue) return true;
		const queue = input.queue;
		if (record.dispatch?.queueClaims?.some((claim) => claim.id === queue.id && claim.revision === queue.revision))
			return false;
		return liveQueue ? liveQueue.has(queue.id) : true;
	});
}

/** Conservative admission for retained sends without semantic work/independence authority. */
export function decideNativeAdmission(
	submission: FlowSubmission,
	records: RetainedSubmission[],
	gates: Omit<FlowAdmissionGates, "hostReady">,
	host: Pick<AgentSession, "isIdle" | "isStreaming" | "isRetrying" | "isCompacting">,
	phase: "submission" | "queue",
	input?: FlowNativeInput,
	liveQueue?: ReadonlySet<string>,
): NativeAdmissionDecision {
	const hold = (reason: string): NativeAdmissionDecision => ({ allowed: false, reason });
	const index = records.findIndex((record) => record.id === submission.id);
	if (index < 0 || records[index].status !== "retained") return hold("Input is missing or cancelled.");
	if (gates.recoveryBlocked) return hold("Input is waiting for recovery reconciliation.");
	if (host.isRetrying || host.isCompacting) return hold("Input is waiting for host retry or compaction.");
	if (phase === "queue" && !input?.queue) return hold("Input has no exact native queue revision.");
	// An unresolved outcome holds automated admission but never the user: resolving it is the user's
	// decision, and the controls for it arrive as user input, so holding those would make the state
	// unrecoverable. Host-assigned provenance is what passes here, never a caller-supplied label.
	if (isUserInstruction(submission)) return { allowed: true };
	// Checked immediately after the user-input allow: an interrupt holds everything automated and
	// nothing the user typed, and it outranks the ordinary boundary reasons below because the user
	// asked for it directly rather than the controller inferring it from session state.
	if (gates.automatedPaused) return hold("Automated input is paused until the next user turn is under way.");
	if (gates.outcomeUnresolved) return hold("Automated input is waiting for an interrupted turn to be resolved.");
	if (submission.api === "sendCustomMessage") {
		const options = submission.args[1] as { deliverAs?: string; triggerTurn?: boolean } | undefined;
		const wakes = options?.triggerTurn ?? submission.hostState?.streaming;
		if (options?.deliverAs === "nextTurn") return { allowed: true };
		if (wakes === undefined) return hold("Deferred context requires a persistence receipt before release.");
		if (wakes === false)
			return host.isIdle && !host.isStreaming
				? { allowed: true }
				: hold("Non-waking context is waiting for an idle append boundary.");
	}
	if (gates.waitingWorkIds.length) return hold("Unclassified input cannot establish independence from a live wait.");
	if (
		gates.userPending ||
		records.some((record) => isUserInstruction(record.submission) && awaitingNativeInput(record, liveQueue))
	)
		return hold("Input is waiting for queued user work.");
	if (phase === "submission" && (!host.isIdle || host.isStreaming))
		return hold("Automated input is waiting for an idle host boundary.");
	if (
		records
			.slice(0, index)
			.some(
				(record) =>
					lane(record.submission) === lane(submission) &&
					awaitingNativeInput(record, liveQueue) &&
					(phase === "submission" || !record.dispatch?.inputs?.every((input) => !!input.queue)),
			)
	)
		return hold("Input is waiting for an earlier retained instruction in its lane.");
	return { allowed: true };
}
