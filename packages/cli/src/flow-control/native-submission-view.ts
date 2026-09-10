import type { NativeProjectionCapture } from "./native-context-projections.js";
import { nativeProjectionDelivered } from "./native-inclusion.js";
import type { NativeRequest, NativeRequestSource, NativeSourceDisposition } from "./native-request-store.js";
import { nativeHoldHash, nativeHoldPending } from "./native-request-store.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import type { RetainedSubmission } from "./submission-store.js";

export interface NativeSubmissionRequestView {
	requestId: string;
	operationId: string;
	outcome: NonNullable<NativeRequest["outcome"]> | "unknown";
	payloadHash?: string;
	withheldPayloadHash?: string;
	hold?: { hash: string; reason: "required-input" | "required-context" };
	retryOf?: string;
	retryRequestId?: string;
	projections?: {
		identity: NativeProjectionCapture["members"][number];
		required: boolean;
		cancelled?: true;
		model?: NativeSourceDisposition["members"][number];
	}[];
	sources: {
		identity: NativeRequestSource;
		consumed: true;
		cancelled?: true;
		history?: { entryId: string; entryHash: string };
		context?: NativeSourceDisposition["members"][number];
		model?: NativeSourceDisposition["members"][number];
	}[];
}

/** Join retained operation/claim identities. Content equality never repairs a missing link. */
export function projectNativeSubmissionRequests(
	records: RetainedSubmission[],
	requests: NativeRequest[],
): Map<string, NativeSubmissionRequestView[]> {
	const operations = new Map<string, RetainedSubmission>();
	for (const record of records) {
		if (!record.dispatch) continue;
		if (operations.has(record.dispatch.operationId))
			throw new FlowLedgerError("identity", "Native operation belongs to multiple submissions.");
		operations.set(record.dispatch.operationId, record);
	}
	const result = new Map<string, NativeSubmissionRequestView[]>();
	const ids = new Set<string>();
	for (const request of requests) {
		if (ids.has(request.id)) throw new FlowLedgerError("identity", "Repeated native request identity.");
		ids.add(request.id);
		const grouped = new Map<string, NativeSubmissionRequestView>();
		for (const [offset, source] of (request.sourceCapture?.members ?? []).entries()) {
			const record = operations.get(source.operationId);
			const dispatch = record?.dispatch;
			if (
				!record ||
				!dispatch ||
				(source.prompt === undefined) === (source.queue === undefined) ||
				(source.prompt &&
					!dispatch.promptClaims?.some(
						(claim) =>
							claim.inputIndex === source.prompt?.inputIndex && claim.messageIndex === source.prompt.messageIndex,
					)) ||
				(source.queue &&
					!dispatch.queueClaims?.some(
						(claim) => claim.consumed && claim.id === source.queue?.id && claim.revision === source.queue.revision,
					))
			)
				throw new FlowLedgerError("identity", "Native request source has no retained submission claim.");
			const history = source.prompt
				? dispatch.promptHistory?.find(
						(entry) =>
							entry.inputIndex === source.prompt?.inputIndex && entry.messageIndex === source.prompt.messageIndex,
					)
				: dispatch.queueHistory?.find(
						(entry) => entry.id === source.queue?.id && entry.revision === source.queue.revision,
					);
			const context = request.sourceCapture?.context?.members[offset];
			const model = request.sourceCapture?.model?.members[offset];
			if ([context, model].some((item) => item && item.sourceIndex !== source.index))
				throw new FlowLedgerError("identity", "Native request source disposition has a conflicting position.");
			const view = grouped.get(record.id) ?? {
				requestId: request.id,
				operationId: source.operationId,
				outcome: request.outcome ?? "unknown",
				...(request.payload ? { payloadHash: request.payload.hash } : {}),
				...(request.withheldPayload ? { withheldPayloadHash: request.withheldPayload.hash } : {}),
				...(nativeHoldPending(request) && !request.retryAuthorization?.requestId
					? {
							hold: {
								hash: nativeHoldHash(request),
								// Which kind of required item conversion refused still separates these reasons: a
								// required projection is host context, a required source is retained input.
								reason: request.requiredProjections?.some((index) => !nativeProjectionDelivered(request, index))
									? ("required-context" as const)
									: ("required-input" as const),
							},
						}
					: {}),
				...(request.retryOf ? { retryOf: request.retryOf } : {}),
				...(request.retryAuthorization?.requestId ? { retryRequestId: request.retryAuthorization.requestId } : {}),
				...(request.projectionCapture?.members.length
					? {
							projections: request.projectionCapture.members.map((projection, index) =>
								structuredClone({
									identity: projection,
									required: request.requiredProjections?.includes(projection.index) ?? false,
									...(request.cancelledProjections?.includes(projection.index) ? { cancelled: true as const } : {}),
									...(request.projectionCapture?.model?.members[index]
										? { model: request.projectionCapture.model.members[index] }
										: {}),
								}),
							),
						}
					: {}),
				sources: [],
			};
			view.sources.push(
				structuredClone({
					identity: source,
					consumed: true as const,
					...(request.cancelledSources?.includes(source.index) ? { cancelled: true as const } : {}),
					...(history ? { history: { entryId: history.entryId, entryHash: history.entryHash } } : {}),
					...(context ? { context } : {}),
					...(model ? { model } : {}),
				}),
			);
			grouped.set(record.id, view);
		}
		for (const [id, view] of grouped) {
			const entries = result.get(id) ?? [];
			entries.push(view);
			result.set(id, entries);
		}
	}
	return result;
}
