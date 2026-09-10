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
export function awaitingNativeInput(record: RetainedSubmission): boolean {
	if (record.status === "cancelled") return false;
	if (!record.dispatch) return true;
	if (record.dispatch.promptClaims?.length || record.dispatch.promptHistory?.length) return false;
	const inputs = record.dispatch.inputs;
	return (
		!inputs?.length ||
		inputs.some(
			(input) =>
				!input.queue ||
				!record.dispatch?.queueClaims?.some(
					(claim) => claim.id === input.queue?.id && claim.revision === input.queue.revision,
				),
		)
	);
}

/** Conservative admission for retained sends without semantic work/independence authority. */
export function decideNativeAdmission(
	submission: FlowSubmission,
	records: RetainedSubmission[],
	gates: Omit<FlowAdmissionGates, "hostReady">,
	host: Pick<AgentSession, "isIdle" | "isStreaming" | "isRetrying" | "isCompacting">,
	phase: "submission" | "queue",
	input?: FlowNativeInput,
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
		records.some((record) => isNativeUserInput(record.submission) && awaitingNativeInput(record))
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
					awaitingNativeInput(record) &&
					(phase === "submission" || !record.dispatch?.inputs?.every((input) => !!input.queue)),
			)
	)
		return hold("Input is waiting for an earlier retained instruction in its lane.");
	return { allowed: true };
}
