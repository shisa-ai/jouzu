import type { NativeRequest } from "./native-request-store.js";

/** Successful per-input evidence, independent of its position in a later request. */
function observations(request: NativeRequest): string[] | undefined {
	if (request.outcome !== "success" || !request.payload || !request.sourceCapture) return;
	const keys: string[] = [];
	const route = [request.payload.api, request.payload.provider, request.payload.model];
	for (const [offset, source] of request.sourceCapture.members.entries()) {
		const context = request.sourceCapture.context?.members[offset];
		const model = request.sourceCapture.model?.members[offset];
		const payload = request.payload.sources?.[offset];
		if (
			context?.status !== "intact" ||
			!model ||
			!["intact", "converted"].includes(model.status) ||
			payload?.disposition !== "included"
		)
			return;
		keys.push(
			JSON.stringify([
				"source",
				route,
				source.operationId,
				source.prompt?.inputIndex,
				source.prompt?.messageIndex,
				source.queue?.id,
				source.queue?.revision,
				source.messageHash,
				context.status,
				context.messageHash,
				model.status,
				model.messageHash,
				payload.contentHash,
			]),
		);
	}
	for (const [offset, source] of (request.projectionCapture?.members ?? []).entries()) {
		const model = request.projectionCapture?.model?.members[offset];
		const payload = request.payload.projections?.[offset];
		if (model?.status !== "converted" || payload?.disposition !== "included") return;
		keys.push(
			JSON.stringify(["projection", route, source.messageHash, model.status, model.messageHash, payload.contentHash]),
		);
	}
	return keys.length ? keys : undefined;
}

/** Keep unique evidence and every retry/failure record; a surviving later success must cover each retired input. */
export function supersededNativeRequests(records: readonly NativeRequest[]): string[] {
	const retainedEvidence = new Set<string>();
	const removed: string[] = [];
	const linked = new Set(
		records.flatMap((record) =>
			[record.retryOf, record.retryAuthorization?.requestId].filter((id): id is string => !!id),
		),
	);
	for (const request of [...records].reverse()) {
		const evidence = observations(request);
		if (!evidence) continue;
		if (
			!request.retryOf &&
			!request.retryAuthorization &&
			!linked.has(request.id) &&
			evidence.every((key) => retainedEvidence.has(key))
		) {
			removed.push(request.id);
		} else {
			for (const key of evidence) retainedEvidence.add(key);
		}
	}
	return removed.reverse();
}
