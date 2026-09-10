import { nativeProjectionDelivered, nativeSourceDelivered } from "./native-inclusion.js";
import { type NativeRequest, nativeRequestHeld } from "./native-request-store.js";

/** Successful per-input evidence, independent of its position in a later request. */
function observations(request: NativeRequest): string[] | undefined {
	if (request.outcome !== "success" || !request.payload || !request.sourceCapture) return;
	const keys: string[] = [];
	const route = [request.payload.api, request.payload.provider, request.payload.model];
	for (const [offset, source] of request.sourceCapture.members.entries()) {
		const context = request.sourceCapture.context?.members[offset];
		const model = request.sourceCapture.model?.members[offset];
		if (context?.status !== "intact" || !model || !nativeSourceDelivered(request, source.index)) return;
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
			]),
		);
	}
	for (const [offset, source] of (request.projectionCapture?.members ?? []).entries()) {
		const model = request.projectionCapture?.model?.members[offset];
		if (!model || !nativeProjectionDelivered(request, source.index)) return;
		keys.push(JSON.stringify(["projection", route, source.messageHash, model.status, model.messageHash]));
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

/**
 * Bound evidence that no later success can supersede. A request whose input is unique is the only
 * record that the input reached the model, so it is never redundant and `supersededNativeRequests`
 * keeps it forever; a session whose turns each carry new input therefore walks to the store's
 * record limit and holds all work. History past `keep` is retired oldest first, but only where
 * dropping it cannot remove evidence something live still reads:
 *
 * - unresolved requests, and any request still held for input or context, stay;
 * - a settled failure is retired like a success: it delivered nothing, so it holds no evidence a
 *   later reader needs, and excluding it would leave a failure-prone session unbounded;
 * - a request linked to a retry, in either direction, stays with its partner;
 * - a request observing an operation that still owns a retained submission stays, so every live
 *   submission keeps a complete request view.
 *
 * The store records a compact identity fence for each retirement, so a retired id cannot be reused.
 */
export function retirableNativeRequests(
	records: readonly NativeRequest[],
	keep: number,
	liveOperations: ReadonlySet<string>,
	protectedRequestIds: ReadonlySet<string> = new Set(),
): string[] {
	const linked = new Set(
		records.flatMap((record) =>
			[record.retryOf, record.retryAuthorization?.requestId].filter((id): id is string => !!id),
		),
	);
	const retirable = records.filter(
		(record) =>
			record.outcome !== undefined &&
			!protectedRequestIds.has(record.id) &&
			// A success is retired only once its delivery evidence is complete and verifiable. A
			// request that never delivered has no such evidence to preserve, so keeping it forever
			// would walk any session with intermittent provider failures to the record limit.
			(record.outcome !== "success" ||
				(!record.sourceCapture?.members.length && !record.projectionCapture?.members.length) ||
				observations(record) !== undefined) &&
			!nativeRequestHeld(record) &&
			!record.retryOf &&
			!record.retryAuthorization &&
			!linked.has(record.id) &&
			!(record.sourceCapture?.members ?? []).some((source) => liveOperations.has(source.operationId)),
	);
	return retirable.slice(0, Math.max(0, retirable.length - keep)).map((record) => record.id);
}
