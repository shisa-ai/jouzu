import { nativeProjectionDelivered, nativeSourceDelivered } from "./native-inclusion.js";
import {
	type NativeRequest,
	nativeCancelledSources,
	nativeHoldPending,
	nativeSourceKey,
} from "./native-request-store.js";

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

/** No live consumer can depend on per-input evidence from these settled, unlinked requests. */
export function retirableEmptyNativeRequests(records: readonly NativeRequest[], keep = 64): string[] {
	const protectedIds = new Set(
		records
			.filter(
				(record) =>
					record.outcome === undefined ||
					record.sourceCapture?.members.length ||
					record.projectionCapture?.members.length ||
					record.waitTokens?.length ||
					record.requiredSources?.length ||
					record.requiredProjections?.length ||
					record.cancelledSources?.length ||
					record.cancelledProjections?.length ||
					record.retryOf ||
					record.retryAuthorization,
			)
			.map((record) => record.id),
	);
	return retirableNativeRequests(records, keep, new Set(), protectedIds);
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
 * - retry chains retire together, after every member is terminal and unprotected;
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
	reconciledSources: ReadonlySet<string> = new Set(),
): string[] {
	const byId = new Map(records.map((record) => [record.id, record]));
	const groups: NativeRequest[][] = [];
	const visited = new Set<string>();
	for (const record of records) {
		if (visited.has(record.id)) continue;
		const group: NativeRequest[] = [];
		const pending = [record];
		while (pending.length) {
			const member = pending.pop();
			if (!member) break;
			if (visited.has(member.id)) continue;
			visited.add(member.id);
			group.push(member);
			for (const id of [member.retryOf, member.retryAuthorization?.requestId]) {
				const partner = id ? byId.get(id) : undefined;
				if (partner) pending.push(partner);
			}
		}
		groups.push(group);
	}
	const eligible = groups.filter((group) =>
		group.every((record) => {
			const child = record.retryAuthorization?.requestId ? byId.get(record.retryAuthorization.requestId) : undefined;
			const parent = record.retryOf ? byId.get(record.retryOf) : undefined;
			return (
				(record.outcome !== undefined || record.reset === true) &&
				!protectedRequestIds.has(record.id) &&
				nativeCancelledSources([record]).every((source) => reconciledSources.has(nativeSourceKey(source))) &&
				(record.outcome !== "success" ||
					(!record.sourceCapture?.members.length && !record.projectionCapture?.members.length) ||
					observations(record) !== undefined) &&
				(!record.retryOf || parent?.retryAuthorization?.requestId === record.id) &&
				(!record.retryAuthorization || child?.retryOf === record.id) &&
				(!nativeHoldPending(record) || !!child) &&
				!(record.sourceCapture?.members ?? []).some((source) => liveOperations.has(source.operationId))
			);
		}),
	);
	const eligibleIds = new Set(eligible.flatMap((group) => group.map((record) => record.id)));
	const ordered = records.filter((record) => eligibleIds.has(record.id));
	const oldest = new Set(ordered.slice(0, Math.max(0, ordered.length - keep)).map((record) => record.id));
	const retiring = new Set(
		eligible
			.filter((group) => group.every((record) => oldest.has(record.id)))
			.flatMap((group) => group.map((record) => record.id)),
	);
	return records.filter((record) => retiring.has(record.id)).map((record) => record.id);
}
