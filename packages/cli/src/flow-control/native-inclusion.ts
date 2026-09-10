import type { NativeRequest } from "./native-request-store.js";

/**
 * Delivery predicates over one native request.
 *
 * Delivery is established at the **model layer**: what the host passed to Pi's provider adapter, per
 * composed member, recorded at `convertToLlm`. It establishes what reached the adapter and nothing
 * after it, because conversion downstream is trusted and its wire format is not decoded.
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
