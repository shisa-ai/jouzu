import { types } from "node:util";
import { FlowLedgerError } from "./receipt-ledger.js";

const origins = new WeakMap<object, object>();
const object = (value: unknown): value is object => value !== null && typeof value === "object";

/** Only plain data can establish a positional copy mapping; getters/toJSON may replace identities. */
function plainData(value: unknown, seen = new WeakSet<object>()): boolean {
	if (!object(value)) return typeof value !== "function" && typeof value !== "symbol" && typeof value !== "bigint";
	if (types.isProxy(value)) return false;
	if (seen.has(value)) return true;
	seen.add(value);
	if (
		Array.isArray(value)
			? Object.getPrototypeOf(value) !== Array.prototype
			: Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null
	)
		return false;
	for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
		if (key === "toJSON" || !("value" in descriptor) || !plainData(descriptor.value, seen)) return false;
	}
	return true;
}

export function payloadRowOrigin(value: unknown): unknown {
	return object(value) ? (origins.get(value) ?? value) : value;
}

/** Google passes SDK parameters, including cancellation state, to its payload callback. */
function googleCancellation(payload: unknown): { data: unknown; signal?: AbortSignal } {
	if (!object(payload) || types.isProxy(payload)) return { data: payload };
	const config = Object.getOwnPropertyDescriptor(payload, "config")?.value;
	if (!object(config) || types.isProxy(config)) return { data: payload };
	const descriptor = Object.getOwnPropertyDescriptor(config, "abortSignal");
	if (!descriptor) return { data: payload };
	if (!("value" in descriptor)) throw new FlowLedgerError("schema", "Google cancellation must be a data property.");
	const signal = descriptor.value;
	if (signal === undefined) return { data: payload };
	try {
		// Use the platform brand check; prototype lookalikes and proxies are not signals.
		const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
		if (!aborted || !object(signal) || types.isProxy(signal)) throw new Error("Invalid signal");
		aborted.call(signal);
	} catch {
		throw new FlowLedgerError("schema", "Invalid Google cancellation signal.");
	}
	const configDescriptors = Object.getOwnPropertyDescriptors(config);
	delete configDescriptors.abortSignal;
	const copiedConfig = Object.create(Object.getPrototypeOf(config), configDescriptors);
	const descriptors = Object.getOwnPropertyDescriptors(payload);
	descriptors.config = { ...descriptors.config, value: copiedConfig };
	const data = Object.create(Object.getPrototypeOf(payload), descriptors);
	if (!plainData(data))
		throw new FlowLedgerError("schema", "Google SDK parameters contain unsupported runtime values.");
	return { data, signal: signal as AbortSignal };
}

/** Copy request data while retaining Google SDK cancellation outside the serialized receipt. */
export function copyFlowPayload(payload: unknown, api?: string): { serialized: string; owned: unknown } {
	const { data, signal } =
		api === "google-generative-ai" || api === "google-vertex" ? googleCancellation(payload) : { data: payload };
	payload = data;
	const qualified = plainData(payload);
	const serialized = JSON.stringify(payload);
	if (serialized === undefined) throw new FlowLedgerError("schema", "Provider payload is not JSON.");
	const owned: unknown = JSON.parse(serialized);
	if (qualified && object(payload) && object(owned)) {
		const containers = [[payload, owned]];
		if ("context" in payload && "context" in owned && object(payload.context) && object(owned.context))
			containers.push([payload.context, owned.context]);
		for (const [payload, owned] of containers)
			for (const key of ["messages", "input", "contents"] as const) {
				const source = key in payload ? (payload as Record<string, unknown>)[key] : undefined;
				const target = key in owned ? (owned as Record<string, unknown>)[key] : undefined;
				if (!Array.isArray(source) || !Array.isArray(target) || source.length !== target.length) continue;
				for (const [index, row] of source.entries()) {
					if (!object(row) || !object(target[index])) continue;
					origins.set(target[index], payloadRowOrigin(row) as object);
					const blockKey = key === "contents" ? "parts" : "content";
					const blocks = (row as Record<string, unknown>)[blockKey];
					const copiedBlocks = (target[index] as Record<string, unknown>)[blockKey];
					if (Array.isArray(blocks) && Array.isArray(copiedBlocks) && blocks.length === copiedBlocks.length)
						for (const [blockIndex, block] of blocks.entries())
							if (object(block) && object(copiedBlocks[blockIndex]))
								origins.set(copiedBlocks[blockIndex], payloadRowOrigin(block) as object);
				}
			}
	}
	if (signal) (owned as { config: { abortSignal?: AbortSignal } }).config.abortSignal = signal;
	return { serialized, owned };
}
