import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { FlowAdmissionGates } from "./admission.js";
import type { FlowNativeInput, RetainedSubmission } from "./submission-store.js";

type FlowSubmission = RetainedSubmission["submission"];
export type NativeAdmissionDecision = { allowed: true } | { allowed: false; reason: string };

/** Origin is supplied by the installed host binding, never by message content. */
export function isNativeUserInput(submission: FlowSubmission): boolean {
	return submission.origin.kind === "host" && ["prompt", "steer", "followUp"].includes(submission.api);
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
	if (record.status === "cancelled" || completedWithoutNativeInput(record)) return false;
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
	// unrecoverable. Host-verified origin is what passes here, never a caller-supplied label.
	if (isNativeUserInput(submission)) return { allowed: true };
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
		records.some((record) => isNativeUserInput(record.submission) && awaitingNativeInput(record, liveQueue))
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
