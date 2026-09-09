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

/** Serialize once and retain host-owned row-copy identity outside the payload. */
export function copyFlowPayload(payload: unknown): { serialized: string; owned: unknown } {
	const qualified = plainData(payload);
	const serialized = JSON.stringify(payload);
	if (serialized === undefined) throw new FlowLedgerError("schema", "Provider payload is not JSON.");
	const owned: unknown = JSON.parse(serialized);
	if (qualified && object(payload) && object(owned)) {
		for (const key of ["messages", "input"] as const) {
			const source = key in payload ? (payload as Record<string, unknown>)[key] : undefined;
			const target = key in owned ? (owned as Record<string, unknown>)[key] : undefined;
			if (!Array.isArray(source) || !Array.isArray(target) || source.length !== target.length) continue;
			for (const [index, row] of source.entries()) {
				if (!object(row) || !object(target[index])) continue;
				origins.set(target[index], payloadRowOrigin(row) as object);
				const blocks = "content" in row ? row.content : undefined;
				const copiedBlocks = "content" in target[index] ? target[index].content : undefined;
				if (Array.isArray(blocks) && Array.isArray(copiedBlocks) && blocks.length === copiedBlocks.length)
					for (const [blockIndex, block] of blocks.entries())
						if (object(block) && object(copiedBlocks[blockIndex]))
							origins.set(copiedBlocks[blockIndex], payloadRowOrigin(block) as object);
			}
		}
	}
	return { serialized, owned };
}
