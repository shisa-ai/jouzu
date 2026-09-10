import { types } from "node:util";
import { FlowLedgerError } from "./receipt-ledger.js";

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

/** AWS consumes binary views; the receipt records their exact bytes as base64. */
function copyBedrockPayload(payload: unknown): { serialized: string; owned: unknown } {
	const active = new WeakSet<object>();
	function copy(value: unknown): { data: unknown; owned: unknown } {
		if (!object(value)) {
			if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint")
				throw new FlowLedgerError("schema", "Unsupported Bedrock request value.");
			return { data: value, owned: value };
		}
		if (types.isProxy(value) || active.has(value))
			throw new FlowLedgerError("schema", "Invalid Bedrock request object.");
		if (types.isUint8Array(value)) {
			if (Object.getPrototypeOf(value) !== Uint8Array.prototype && !Buffer.isBuffer(value))
				throw new FlowLedgerError("schema", "Unsupported Bedrock binary view.");
			if (
				Reflect.ownKeys(value).some((key) => typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) ||
				types.isSharedArrayBuffer(value.buffer)
			)
				throw new FlowLedgerError("schema", "Unsupported Bedrock binary storage.");
			const owned = new Uint8Array(value);
			return { data: Buffer.from(owned).toString("base64"), owned };
		}
		const array = Array.isArray(value);
		if (
			Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype) &&
			!(Object.getPrototypeOf(value) === null && !array)
		)
			throw new FlowLedgerError("schema", "Unsupported Bedrock request object.");
		active.add(value);
		const data: Record<string, unknown> = array ? ([] as unknown as Record<string, unknown>) : {};
		const owned: Record<string, unknown> = array ? ([] as unknown as Record<string, unknown>) : {};
		for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
			if (array && key === "length") {
				data.length = descriptor.value;
				owned.length = descriptor.value;
				continue;
			}
			if (key === "toJSON" || !("value" in descriptor))
				throw new FlowLedgerError("schema", "Bedrock request requires data properties.");
			if (!descriptor.enumerable) continue;
			const child = copy(descriptor.value);
			Object.defineProperty(data, key, { value: child.data, enumerable: true, configurable: true, writable: true });
			Object.defineProperty(owned, key, { value: child.owned, enumerable: true, configurable: true, writable: true });
		}
		active.delete(value);
		return { data, owned };
	}
	const result = copy(payload);
	const serialized = JSON.stringify(result.data);
	if (serialized === undefined) throw new FlowLedgerError("schema", "Bedrock payload is not JSON.");
	return { serialized, owned: result.owned };
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
	if (api === "bedrock-converse-stream") return copyBedrockPayload(payload);
	const { data, signal } =
		api === "google-generative-ai" || api === "google-vertex" ? googleCancellation(payload) : { data: payload };
	payload = data;
	const serialized = JSON.stringify(payload);
	if (serialized === undefined) throw new FlowLedgerError("schema", "Provider payload is not JSON.");
	const owned: unknown = JSON.parse(serialized);
	if (signal) (owned as { config: { abortSignal?: AbortSignal } }).config.abortSignal = signal;
	return { serialized, owned };
}
