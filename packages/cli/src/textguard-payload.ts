import { createHash } from "node:crypto";
import { MAX_SCAN_BYTES } from "./textguard.js";

const MAX_IDENTITY_BYTES = 16 * 1024 * 1024;
const MAX_NODES = 8192;
const MAX_DEPTH = 32;
export type PayloadSnapshot<T> =
	| { status: "identified"; value: T; digest: string; bytes: number; text?: string }
	| { status: "unavailable"; reason: "input-limit" | "protocol" | "budget" };
class SnapshotFailure extends Error {
	constructor(readonly reason: "input-limit" | "protocol" | "budget") {
		super(reason);
	}
}

/** Copy JSON data while hashing its complete encoding, retaining scan text only within the scanner limit. */
export function snapshotPayload<T>(input: T): PayloadSnapshot<T> {
	const hash = createHash("sha256");
	let bytes = 0;
	let nodes = 0;
	let chunks: string[] | undefined = [];
	const ancestors = new Set<object>();
	const emit = (text: string) => {
		bytes += Buffer.byteLength(text);
		if (bytes > MAX_IDENTITY_BYTES) throw new SnapshotFailure("input-limit");
		hash.update(text);
		if (bytes > MAX_SCAN_BYTES) chunks = undefined;
		else chunks?.push(text);
	};
	const string = (value: string) => {
		if (Buffer.byteLength(value) > MAX_IDENTITY_BYTES) throw new SnapshotFailure("input-limit");
		if (/[\uD800-\uDFFF]/u.test(value)) throw new SnapshotFailure("protocol");
		emit('"');
		for (let start = 0; start < value.length; ) {
			let end = Math.min(start + 4096, value.length);
			if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
			emit(JSON.stringify(value.slice(start, end)).slice(1, -1));
			start = end;
		}
		emit('"');
	};
	const visit = (value: unknown, depth: number): unknown => {
		if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new SnapshotFailure("budget");
		if (typeof value === "string") {
			string(value);
			return value;
		}
		if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
			emit(JSON.stringify(value));
			return value;
		}
		if (!value || typeof value !== "object") throw new SnapshotFailure("protocol");
		if (ancestors.has(value)) throw new SnapshotFailure("protocol");
		ancestors.add(value);
		try {
			if (Array.isArray(value)) {
				if (value.length > MAX_NODES) throw new SnapshotFailure("budget");
				const copy = [];
				emit("[");
				for (let index = 0; index < value.length; index++) {
					if (index) emit(",");
					const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
					if (descriptor && !("value" in descriptor)) throw new SnapshotFailure("protocol");
					copy.push(visit(descriptor?.value ?? null, depth + 1));
				}
				emit("]");
				return copy;
			}
			const prototype = Object.getPrototypeOf(value);
			if (prototype !== null && prototype !== Object.prototype) throw new SnapshotFailure("protocol");
			const copy: Record<string, unknown> = {};
			let count = 0;
			emit("{");
			for (const key in value) {
				if (!Object.hasOwn(value, key)) continue;
				if (++nodes > MAX_NODES) throw new SnapshotFailure("budget");
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (!descriptor || !("value" in descriptor)) throw new SnapshotFailure("protocol");
				if (descriptor.value === undefined) continue;
				if (count++) emit(",");
				string(key);
				emit(":");
				Object.defineProperty(copy, key, {
					value: visit(descriptor.value, depth + 1),
					enumerable: true,
					writable: true,
					configurable: true,
				});
			}
			emit("}");
			return copy;
		} finally {
			ancestors.delete(value);
		}
	};
	try {
		const value = visit(input, 0) as T;
		return {
			status: "identified",
			value,
			digest: hash.digest("hex"),
			bytes,
			...(chunks ? { text: chunks.join("") } : {}),
		};
	} catch (error) {
		return { status: "unavailable", reason: error instanceof SnapshotFailure ? error.reason : "protocol" };
	}
}
