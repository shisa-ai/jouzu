import { completedWithoutNativeInput, isNativeUserInput } from "./native-admission.js";
import type { NativeRequest } from "./native-request-store.js";
import { projectNativeSubmissionRequests } from "./native-submission-view.js";
import type { RetainedSubmission } from "./submission-store.js";
import type { FlowAuthorityWork } from "./wait-authority.js";

/** Select only fully observed user invocations; dependency removal remains an atomic store check. */
export function finishedUserWork(
	work: FlowAuthorityWork[],
	records: RetainedSubmission[],
	requests: NativeRequest[],
	referenced: ReadonlySet<string>,
): FlowAuthorityWork[] {
	const views = projectNativeSubmissionRequests(records, requests);
	return work.filter((item) => {
		if (
			item.owner !== "host-user" ||
			!item.userInputs?.length ||
			item.lifecycle?.state === "paused" ||
			referenced.has(item.id)
		)
			return false;
		return item.userInputs.every((input) => {
			const record = records.find((record) => record.id === input.id && record.revision === input.revision);
			const dispatch = record?.dispatch;
			if (
				!record ||
				!isNativeUserInput(record.submission) ||
				record.status !== "retained" ||
				record.holds?.length ||
				dispatch?.phase !== "returned"
			)
				return false;
			if (completedWithoutNativeInput(record)) return true;
			const claims = dispatch.promptClaims ?? [];
			const queues = dispatch.queueClaims ?? [];
			if ((!claims.length && !queues.length) || queues.some((claim) => !claim.consumed) || !dispatch.inputs?.length)
				return false;
			if (
				dispatch.inputs.some(
					(input, index) =>
						input.kind === "context" ||
						(input.queue
							? !queues.some(
									(claim) => claim.id === input.queue?.id && claim.revision === input.queue?.revision && claim.consumed,
								)
							: !claims.some((claim) => claim.inputIndex === index)),
				)
			)
				return false;
			const observed = views.get(record.id) ?? [];
			// A later successful status request cannot erase an earlier failed or withheld request.
			if (
				!observed.length ||
				observed.some(
					(view) =>
						view.outcome !== "success" ||
						!view.payloadHash ||
						view.hold ||
						// Delivery is what model conversion recorded, so an unaccepted status there is what
						// leaves a source unreceived.
						view.sources.some(
							(source) => source.cancelled || !["intact", "converted"].includes(source.model?.status ?? ""),
						),
				)
			)
				return false;
			const sources = observed.flatMap((view) => view.sources);
			return (
				claims.every((claim) =>
					sources.some(
						({ identity }) =>
							identity.prompt?.inputIndex === claim.inputIndex && identity.prompt.messageIndex === claim.messageIndex,
					),
				) &&
				queues.every((claim) =>
					sources.some(({ identity }) => identity.queue?.id === claim.id && identity.queue.revision === claim.revision),
				)
			);
		});
	});
}
