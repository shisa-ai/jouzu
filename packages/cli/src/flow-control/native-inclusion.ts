import type { NativeRequest } from "./native-request-store.js";

/**
 * Delivery predicates over one native request.
 *
 * Two evidence layers exist while the wire layer is being retired. The **model layer** records what
 * the host passed to Pi's provider adapter, per composed member, at `convertToLlm`. The **wire
 * layer** decoded the provider's own request body afterwards. `native-request-store.ts` requires a
 * wire-included source to carry an accepted model status, so wire inclusion implies model
 * inclusion; the reverse does not hold, because a converter that drops content, or an API with no
 * decoder, leaves model-included content with no wire receipt.
 *
 * The model layer is the contract's delivery evidence. It establishes what reached the adapter and
 * nothing after it: conversion downstream is trusted.
 */

/**
 * Model statuses that acknowledge delivery of a retained source. `changed` never does — Pi records
 * it when it replaces content, such as removing an image, and replaced content is not what the
 * controller retained.
 */
const deliveredSource = new Set(["intact", "converted"]);

const sourceOffset = (request: NativeRequest, sourceIndex: number): number =>
	request.sourceCapture?.members.findIndex((member) => member.index === sourceIndex) ?? -1;
const projectionOffset = (request: NativeRequest, sourceIndex: number): number =>
	request.projectionCapture?.members.findIndex((member) => member.index === sourceIndex) ?? -1;

/** Whether a retained source reached the provider adapter in the content the controller retained. */
export function nativeSourceDelivered(request: NativeRequest, sourceIndex: number): boolean {
	const offset = sourceOffset(request, sourceIndex);
	if (offset < 0) return false;
	const model = request.sourceCapture?.model?.members[offset];
	return !!model && model.sourceIndex === sourceIndex && deliveredSource.has(model.status);
}

/**
 * Whether a decorator-owned projection reached the adapter. Projections are composed by the host
 * rather than retained from a submission, so `intact` is not among their statuses: they are always
 * converted from a custom message into model input.
 */
export function nativeProjectionDelivered(request: NativeRequest, sourceIndex: number): boolean {
	const offset = projectionOffset(request, sourceIndex);
	if (offset < 0) return false;
	const model = request.projectionCapture?.model?.members[offset];
	return !!model && model.sourceIndex === sourceIndex && model.status === "converted";
}

/** The retiring wire predicate, retained until its readers are repointed and its decoders deleted. */
export function nativeSourceDeliveredByWire(request: NativeRequest, sourceIndex: number): boolean {
	return !!(request.payload ?? request.withheldPayload)?.sources?.some(
		(source) => source.sourceIndex === sourceIndex && source.disposition === "included",
	);
}

/** The retiring wire predicate for projections; see `nativeSourceDeliveredByWire`. */
export function nativeProjectionDeliveredByWire(request: NativeRequest, sourceIndex: number): boolean {
	return !!(request.payload ?? request.withheldPayload)?.projections?.some(
		(projection) => projection.sourceIndex === sourceIndex && projection.disposition === "included",
	);
}

export interface NativeInclusionDivergence {
	kind: "source" | "projection";
	sourceIndex: number;
	model: boolean;
	wire: boolean;
}

/**
 * Compare the two layers over one request. Used by tests to prove the substitution before the wire
 * layer is deleted: `wire && !model` must never appear, because the store rejects that combination
 * at write time, and every `model && !wire` entry is a case the reduction deliberately accepts.
 */
export function nativeInclusionDivergence(request: NativeRequest): NativeInclusionDivergence[] {
	const divergence: NativeInclusionDivergence[] = [];
	for (const member of request.sourceCapture?.members ?? []) {
		const model = nativeSourceDelivered(request, member.index),
			wire = nativeSourceDeliveredByWire(request, member.index);
		if (model !== wire) divergence.push({ kind: "source", sourceIndex: member.index, model, wire });
	}
	for (const member of request.projectionCapture?.members ?? []) {
		const model = nativeProjectionDelivered(request, member.index),
			wire = nativeProjectionDeliveredByWire(request, member.index);
		if (model !== wire) divergence.push({ kind: "projection", sourceIndex: member.index, model, wire });
	}
	return divergence;
}
