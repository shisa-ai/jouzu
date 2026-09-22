import { createHash } from "node:crypto";
import { type BigIntStats, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { FlowLedgerError } from "./receipt-ledger.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export type PiHistoryEvidence = { kind: "memory" | "buffered" } | { kind: "persisted"; entryHash: string };
export interface PiHistoryVerificationOptions {
	/** Maximum bytes buffered for one JSONL record, including an incomplete trailing record. */
	maxEntryBytes?: number;
	/** Bound index memory; exceeding this count falls back to streaming, never rejects history. */
	maxIndexEntries?: number;
	signal?: AbortSignal;
}
interface Locator {
	offset: number;
	bytes: number;
	hash: string;
	count: number;
}
interface Index {
	path: string;
	sessionId: string;
	header: string;
	stamp: BigIntStats;
	end: number;
	maxEntryBytes: number;
	maxIndexEntries: number;
	entries: Map<string, Locator>;
}
interface Reader {
	index?: Index;
	observer: NonNullable<SessionManager["historyWriteObserver"]>;
	scannedBytes: number;
	targetBytes: number;
	scans: number;
}
const readers = new WeakMap<SessionManager, Reader>();
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}
function sameStamp(a: BigIntStats, b: BigIntStats): boolean {
	return sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function stamp(path: string): BigIntStats | undefined {
	try {
		return statSync(path, { bigint: true });
	} catch {
		return undefined;
	}
}
function readerFor(manager: SessionManager): Reader {
	let reader = readers.get(manager);
	if (reader) return reader;
	const created: Reader = {
		scannedBytes: 0,
		targetBytes: 0,
		scans: 0,
		observer: {
			beforeWrite(kind) {
				const index = created.index;
				if (!index) return undefined;
				const before = stamp(index.path);
				if (
					kind !== "append" ||
					manager.getSessionFile() !== index.path ||
					manager.getSessionId() !== index.sessionId ||
					!before ||
					!sameStamp(before, index.stamp)
				) {
					created.index = undefined;
					return undefined;
				}
				return index;
			},
			afterWrite(token, succeeded) {
				const index = created.index;
				if (!index || token !== index) return;
				const after = stamp(index.path);
				if (!succeeded || !after || !sameFile(index.stamp, after) || after.size < index.stamp.size) {
					created.index = undefined;
					return;
				}
				// Only a completed host append advances the expected stamp. The new suffix is
				// still parsed on the next verification; no receipt is inferred from this callback.
				index.stamp = after;
			},
		},
	};
	reader = created;
	readers.set(manager, reader);
	// Do not take over another consumer's observer. Without our observer the strict scanner
	// remains available, but it cannot reuse a prefix across writes.
	if (!manager.historyWriteObserver) manager.historyWriteObserver = reader.observer;
	return reader;
}

/** Counters for diagnostics and deterministic complexity tests; not receipt evidence. */
export function piHistoryVerificationStats(manager: SessionManager) {
	const reader = readers.get(manager);
	return {
		scannedBytes: reader?.scannedBytes ?? 0,
		targetBytes: reader?.targetBytes ?? 0,
		scans: reader?.scans ?? 0,
		indexedEntries: reader?.index?.entries.size ?? 0,
	};
}

/** Validate requested entries against one stable file view, without a lifetime file-size limit. */
export async function verifyPiHistoryEntries(
	manager: SessionManager,
	entryIds: readonly string[],
	options: PiHistoryVerificationOptions = {},
): Promise<Map<string, PiHistoryEvidence>> {
	const { maxEntryBytes = 64 * 1024 * 1024, maxIndexEntries = 65536, signal } = options;
	if (
		!Number.isSafeInteger(maxEntryBytes) ||
		maxEntryBytes < 1 ||
		!Number.isSafeInteger(maxIndexEntries) ||
		maxIndexEntries < 0
	)
		throw new FlowLedgerError("capacity", "Invalid history record or index limit.");
	signal?.throwIfAborted();
	const branch = new Set(manager.getBranch().map((entry) => entry.id));
	const expected = new Map<string, string>();
	for (const id of entryIds) {
		const entry = manager.getEntry(id);
		if (!entry || !branch.has(id))
			throw new FlowLedgerError("identity", "History entry is not on the attached branch.");
		expected.set(id, JSON.stringify(entry));
	}
	const result = new Map<string, PiHistoryEvidence>();
	if (!expected.size) return result;
	const header = JSON.stringify(manager.getHeader());
	const sessionId = manager.getSessionId();
	const path = manager.getSessionFile();
	const uniform = (kind: "memory" | "buffered") => new Map([...expected.keys()].map((id) => [id, { kind }]));
	if (!manager.isPersisted()) return uniform("memory");
	if (!path) throw new FlowLedgerError("schema", "Persistent session has no history path.");
	const assertCurrent = () => {
		signal?.throwIfAborted();
		const currentBranch = new Set(manager.getBranch().map((entry) => entry.id));
		if (
			manager.getSessionId() !== sessionId ||
			manager.getSessionFile() !== path ||
			JSON.stringify(manager.getHeader()) !== header ||
			[...expected].some(([id, text]) => JSON.stringify(manager.getEntry(id)) !== text || !currentBranch.has(id))
		)
			throw new FlowLedgerError("stale", "History changed during receipt verification.");
	};
	const reader = readerFor(manager);
	let file: Awaited<ReturnType<typeof open>>;
	try {
		file = await open(path, "r");
	} catch (error) {
		assertCurrent();
		reader.index = undefined;
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return uniform("buffered");
		throw error;
	}
	try {
		const before = await file.stat({ bigint: true });
		if (!before.isFile()) throw new FlowLedgerError("schema", "History receipt requires a regular file.");
		if (before.size > BigInt(Number.MAX_SAFE_INTEGER))
			throw new FlowLedgerError("capacity", "History file offsets exceed the supported integer range.");
		let cached = reader.index;
		if (
			!cached ||
			cached.path !== path ||
			cached.sessionId !== sessionId ||
			cached.header !== header ||
			cached.maxEntryBytes !== maxEntryBytes ||
			cached.maxIndexEntries !== maxIndexEntries ||
			manager.historyWriteObserver !== reader.observer ||
			!sameStamp(cached.stamp, before)
		)
			cached = undefined;
		// Clone metadata so concurrent verifications and failed reads never publish a partial index.
		let entries: Map<string, Locator> | undefined = new Map(cached?.entries);
		const wanted = new Map<string, Locator>();
		for (const id of expected.keys()) {
			const locator = entries.get(id);
			if (locator) wanted.set(id, locator);
		}
		let offset = cached?.end ?? 0;
		let completeEnd = offset;
		let first = offset === 0;
		let lineStart = offset;
		let lineBytes = 0;
		let pieces: Buffer[] = [];
		const buffer = Buffer.alloc(64 * 1024);
		const add = (piece: Buffer) => {
			if (lineBytes + piece.length > maxEntryBytes)
				throw new FlowLedgerError("capacity", `History record exceeds the ${maxEntryBytes}-byte verification limit.`);
			pieces.push(Buffer.from(piece));
			lineBytes += piece.length;
		};
		if (offset < Number(before.size)) reader.scans++;
		while (offset < Number(before.size)) {
			signal?.throwIfAborted();
			const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
			if (!bytesRead) throw new FlowLedgerError("stale", "History was truncated during verification.");
			reader.scannedBytes += bytesRead;
			const chunkStart = offset;
			offset += bytesRead;
			let start = 0;
			let newline = buffer.indexOf(10, start);
			while (newline !== -1 && newline < bytesRead) {
				add(buffer.subarray(start, newline));
				let parsed: unknown;
				try {
					parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pieces, lineBytes)));
				} catch {
					throw new FlowLedgerError("schema", "History contains an invalid complete JSONL entry.");
				}
				if (
					!parsed ||
					typeof parsed !== "object" ||
					!("type" in parsed) ||
					typeof parsed.type !== "string" ||
					!("id" in parsed) ||
					typeof parsed.id !== "string"
				)
					throw new FlowLedgerError("schema", "History contains an invalid entry identity.");
				const text = JSON.stringify(parsed);
				if (first) {
					if (text !== header)
						throw new FlowLedgerError("identity", "Persisted history header differs from the attached session.");
					first = false;
				} else {
					const prior = entries?.get(parsed.id) ?? wanted.get(parsed.id);
					const locator = { offset: lineStart, bytes: lineBytes, hash: hash(text), count: (prior?.count ?? 0) + 1 };
					if (expected.has(parsed.id)) wanted.set(parsed.id, locator);
					entries?.set(parsed.id, locator);
					if (entries && entries.size > maxIndexEntries) entries = undefined;
				}
				pieces = [];
				lineBytes = 0;
				completeEnd = chunkStart + newline + 1;
				lineStart = completeEnd;
				start = newline + 1;
				newline = buffer.indexOf(10, start);
			}
			if (start < bytesRead) add(buffer.subarray(start, bytesRead));
		}
		for (const [id, text] of expected) {
			const locator = wanted.get(id);
			if (!locator) {
				result.set(id, { kind: "buffered" });
				continue;
			}
			if (locator.count !== 1 || locator.hash !== hash(text))
				throw new FlowLedgerError("identity", "Persisted history entry differs or is repeated.");
			// Re-read an indexed target even when the suffix is unchanged. Check the newline too;
			// a byte range without a completed record is never persistence evidence.
			if (cached && locator.offset < cached.end) {
				const target = Buffer.alloc(locator.bytes + 1);
				let read = 0;
				while (read < target.length) {
					signal?.throwIfAborted();
					const { bytesRead } = await file.read(target, read, target.length - read, locator.offset + read);
					if (!bytesRead) throw new FlowLedgerError("stale", "History was truncated during verification.");
					read += bytesRead;
					reader.targetBytes += bytesRead;
				}
				let actual: string;
				try {
					actual = JSON.stringify(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(target.subarray(0, -1))));
				} catch {
					throw new FlowLedgerError("schema", "History contains an invalid complete JSONL entry.");
				}
				if (target[target.length - 1] !== 10 || actual !== text)
					throw new FlowLedgerError("identity", "Persisted history entry differs or is incomplete.");
			}
			result.set(id, { kind: "persisted", entryHash: locator.hash });
		}
		const after = await file.stat({ bigint: true });
		const target = await stat(path, { bigint: true });
		if (!sameFile(target, after)) throw new FlowLedgerError("stale", "History file was replaced during verification.");
		if (!sameStamp(before, after) || !sameStamp(after, target))
			throw new FlowLedgerError("stale", "History changed during verification.");
		assertCurrent();
		reader.index =
			entries && !first && manager.historyWriteObserver === reader.observer
				? { path, sessionId, header, stamp: after, end: completeEnd, maxEntryBytes, maxIndexEntries, entries }
				: undefined;
		return result;
	} catch (error) {
		reader.index = undefined;
		throw error;
	} finally {
		await file.close();
	}
}

export async function verifyPiHistoryEntry(
	manager: SessionManager,
	entryId: string,
	options: number | PiHistoryVerificationOptions = {},
): Promise<PiHistoryEvidence> {
	const results = await verifyPiHistoryEntries(
		manager,
		[entryId],
		typeof options === "number" ? { maxEntryBytes: options } : options,
	);
	return results.get(entryId) as PiHistoryEvidence;
}
