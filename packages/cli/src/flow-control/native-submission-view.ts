import type {
	NativePayloadSource,
	NativeRequest,
	NativeRequestSource,
	NativeSourceDisposition,
} from "./native-request-store.js";
import { nativeHoldHash, nativeRequestHeld } from "./native-request-store.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import type { RetainedSubmission } from "./submission-store.js";

export interface NativeSubmissionRequestView {
	requestId: string;
	operationId: string;
	outcome: NonNullable<NativeRequest["outcome"]> | "unknown";
	payloadHash?: string;
	withheldPayloadHash?: string;
	hold?: { hash: string; reason: "required-input" };
	retryOf?: string;
	retryRequestId?: string;
	sources: {
		identity: NativeRequestSource;
		consumed: true;
		history?: { entryId: string; entryHash: string };
		context?: NativeSourceDisposition["members"][number];
		model?: NativeSourceDisposition["members"][number];
		payload?: NativePayloadSource;
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
			const payload = (request.payload ?? request.withheldPayload)?.sources?.[offset];
			if ([context, model, payload].some((item) => item && item.sourceIndex !== source.index))
				throw new FlowLedgerError("identity", "Native request source disposition has a conflicting position.");
			const view = grouped.get(record.id) ?? {
				requestId: request.id,
				operationId: source.operationId,
				outcome: request.outcome ?? "unknown",
				...(request.payload ? { payloadHash: request.payload.hash } : {}),
				...(request.withheldPayload ? { withheldPayloadHash: request.withheldPayload.hash } : {}),
				...(nativeRequestHeld(request) && !request.retryAuthorization?.requestId
					? { hold: { hash: nativeHoldHash(request), reason: "required-input" as const } }
					: {}),
				...(request.retryOf ? { retryOf: request.retryOf } : {}),
				...(request.retryAuthorization?.requestId ? { retryRequestId: request.retryAuthorization.requestId } : {}),
				sources: [],
			};
			view.sources.push(
				structuredClone({
					identity: source,
					consumed: true as const,
					...(history ? { history: { entryId: history.entryId, entryHash: history.entryHash } } : {}),
					...(context ? { context } : {}),
					...(model ? { model } : {}),
					...(payload ? { payload } : {}),
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
