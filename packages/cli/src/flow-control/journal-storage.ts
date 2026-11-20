/**
 * Journal-backed scalar storage for flow records.
 *
 * The flow journal is a v4 JSONL file: one header line, then one transaction per line, where a
 * transaction is a single write object or an array of writes. Compaction stays in
 * journal-checkpoint.ts. This module delegates to it after validating an open and before every
 * append, with proportional threshold backoff.
 */

import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm, truncate, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkpointFlowJournal, FLOW_JOURNAL_CHECKPOINT_BYTES } from "./journal-checkpoint.js";
import {
	applyValueWrites,
	type CommitResult,
	type CommittedValueWrite,
	createScalarSession,
	prepareValueCommit,
	readStoredValue,
	type ScalarContext,
	type ScalarState,
	type ScalarStorage,
	type Session,
	type SessionMetadata,
	type StoredValue,
	scanStoredValues,
	type Value,
	type Write,
} from "./scalar-storage.js";

const JOURNAL_FORMAT_VERSION = 4;
const JOURNAL_STORAGE_VERSION = 1;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;

export interface JournalCreateMetadata {
	id: string;
	cwd: string;
	createdAt?: number;
	/** Sequence floor to record in the header. Defaults to none. */
	nextSeq?: number;
	parentSessionId?: string;
	legacyParentSessionPath?: string;
}

export interface JournalSessionMetadata extends SessionMetadata {
	cwd: string;
	path: string;
	/** Sequence floor the header recorded. Commits after a checkpoint are higher. */
	nextSeq?: number;
}

export interface JournalStorageOptions {
	/** Injected append for crash and error tests. Defaults to fs.appendFile. */
	append?: (path: string, text: string) => Promise<void>;
	/** Compaction threshold. Defaults to FLOW_JOURNAL_CHECKPOINT_BYTES and backs off proportionally. */
	checkpointBytes?: number;
}

export interface JournalOpenOptions extends JournalStorageOptions {
	/** Validate session identity before repair, compaction, or an append. */
	validateMetadata?: (metadata: JournalSessionMetadata) => void | Promise<void>;
}

interface JournalHeader {
	v: typeof JOURNAL_FORMAT_VERSION;
	kind: "header";
	id: string;
	storageVersion: number;
	createdAt: number;
	cwd: string;
	parentSessionId?: string;
	legacyParentSessionPath?: string;
	nextSeq?: number;
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isSafeIntegerAtLeast(input: unknown, minimum: number): input is number {
	return Number.isSafeInteger(input) && (input as number) >= minimum;
}

async function appendText(path: string, text: string): Promise<void> {
	await appendFile(path, text, "utf8");
}

function parseJournalHeader(line: string, path: string): JournalHeader {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw new Error(`Invalid flow journal ${path}: the header is not valid JSON.`, { cause: error });
	}
	if (!isRecord(parsed)) throw new Error(`Invalid flow journal ${path}: the header is not an object.`);
	if (parsed.v !== JOURNAL_FORMAT_VERSION || parsed.kind !== "header")
		throw new Error(`Invalid flow journal ${path}: unsupported header.`);
	if (typeof parsed.id !== "string" || parsed.id.length === 0)
		throw new Error(`Invalid flow journal ${path}: missing session id.`);
	if (parsed.storageVersion !== JOURNAL_STORAGE_VERSION)
		throw new Error(`Invalid flow journal ${path}: unsupported storage version.`);
	if (!isSafeIntegerAtLeast(parsed.createdAt, 0))
		throw new Error(`Invalid flow journal ${path}: invalid creation time.`);
	if (typeof parsed.cwd !== "string") throw new Error(`Invalid flow journal ${path}: missing working directory.`);
	const nextSeq = parsed.nextSeq;
	if (nextSeq !== undefined && !isSafeIntegerAtLeast(nextSeq, 1))
		throw new Error(`Invalid flow journal ${path}: invalid sequence floor.`);
	const parentSessionId = parsed.parentSessionId;
	if (parentSessionId !== undefined && typeof parentSessionId !== "string")
		throw new Error(`Invalid flow journal ${path}: invalid parent session id.`);
	const legacyParentSessionPath = parsed.legacyParentSessionPath;
	if (legacyParentSessionPath !== undefined && typeof legacyParentSessionPath !== "string")
		throw new Error(`Invalid flow journal ${path}: invalid legacy parent session path.`);
	return {
		v: JOURNAL_FORMAT_VERSION,
		kind: "header",
		id: parsed.id,
		storageVersion: parsed.storageVersion,
		createdAt: parsed.createdAt,
		cwd: parsed.cwd,
		...(parentSessionId === undefined ? {} : { parentSessionId }),
		...(legacyParentSessionPath === undefined ? {} : { legacyParentSessionPath }),
		...(nextSeq === undefined ? {} : { nextSeq }),
	};
}

function parseCommittedWrite(input: unknown, path: string, lineNumber: number): CommittedValueWrite {
	if (!isRecord(input)) throw new Error(`Invalid flow journal ${path}: line ${lineNumber} has a non-object write.`);
	const { kind, op, namespace, key, seq } = input;
	if (kind !== "value" || (op !== "set" && op !== "delete"))
		throw new Error(`Invalid flow journal ${path}: line ${lineNumber} has an unsupported write.`);
	if (typeof namespace !== "string" || namespace.length === 0 || namespace.includes("\u0000"))
		throw new Error(`Invalid flow journal ${path}: line ${lineNumber} has an invalid namespace.`);
	if (typeof key !== "string" || key.includes("\u0000"))
		throw new Error(`Invalid flow journal ${path}: line ${lineNumber} has an invalid key.`);
	if (!isSafeIntegerAtLeast(seq, 1) || seq >= MAX_SEQUENCE)
		throw new Error(`Invalid flow journal ${path}: line ${lineNumber} has an invalid sequence.`);
	if (op === "delete") return { kind: "value", op: "delete", seq, namespace, key };
	if (!Object.hasOwn(input, "value"))
		throw new Error(`Invalid flow journal ${path}: line ${lineNumber} sets a value without one.`);
	return { kind: "value", op: "set", seq, namespace, key, value: input.value };
}

function parseTransaction(line: string, path: string, lineNumber: number): CommittedValueWrite[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw new Error(`Invalid flow journal ${path}: line ${lineNumber} is not valid JSON.`, { cause: error });
	}
	if ((!Array.isArray(parsed) && !isRecord(parsed)) || (Array.isArray(parsed) && parsed.length === 0))
		throw new Error(`Invalid flow journal ${path}: line ${lineNumber} is not a transaction.`);
	return (Array.isArray(parsed) ? parsed : [parsed]).map((write) => parseCommittedWrite(write, path, lineNumber));
}

function headerMetadata(header: JournalHeader, path: string): JournalSessionMetadata {
	return {
		id: header.id,
		createdAt: header.createdAt,
		storageVersion: header.storageVersion,
		cwd: header.cwd,
		path,
		...(header.parentSessionId === undefined ? {} : { parentSessionId: header.parentSessionId }),
		...(header.legacyParentSessionPath === undefined
			? {}
			: { legacyParentSessionPath: header.legacyParentSessionPath }),
		...(header.nextSeq === undefined ? {} : { nextSeq: header.nextSeq }),
	};
}

/** Refuse metadata that would produce a header this module could not open again. */
function validateCreateMetadata(metadata: JournalCreateMetadata): void {
	if (typeof metadata.id !== "string" || metadata.id.length === 0)
		throw new TypeError("Journal session id must be a non-empty string");
	if (typeof metadata.cwd !== "string") throw new TypeError("Journal working directory must be a string");
	if (metadata.createdAt !== undefined && !isSafeIntegerAtLeast(metadata.createdAt, 0))
		throw new TypeError("Journal creation time must be a non-negative safe integer");
	if (metadata.nextSeq !== undefined && !isSafeIntegerAtLeast(metadata.nextSeq, 1))
		throw new TypeError("Journal sequence floor must be a positive safe integer");
	if (metadata.parentSessionId !== undefined && typeof metadata.parentSessionId !== "string")
		throw new TypeError("Journal parent session id must be a string");
	if (metadata.legacyParentSessionPath !== undefined && typeof metadata.legacyParentSessionPath !== "string")
		throw new TypeError("Journal legacy parent path must be a string");
}

class JournalScalarStorage implements ScalarStorage {
	private readonly values: ScalarState;
	private nextSeq: number;
	private checkpointBytes: number;
	private state: "open" | "closing" | "closed" = "open";
	private commitQueue: Promise<void> = Promise.resolve();
	private closePromise: Promise<void> | undefined;
	/** Set when an append failed, so later commits cannot append onto uncertain bytes. */
	private fence: Error | undefined;

	constructor(
		private readonly path: string,
		private readonly append: (path: string, text: string) => Promise<void>,
		values: ScalarState,
		nextSeq: number,
		checkpointBytes: number,
	) {
		this.values = values;
		this.nextSeq = nextSeq;
		this.checkpointBytes = checkpointBytes;
	}

	commit(writes: readonly Write[], _context: ScalarContext): Promise<CommitResult> {
		if (this.state !== "open") return Promise.reject(new Error("Flow journal storage is closed"));
		if (this.fence !== undefined) return Promise.reject(this.fence);
		const result = this.commitQueue.then(() => this.applyCommit(writes));
		this.commitQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	getValue<T>(address: Value<T>, _context: ScalarContext): Promise<StoredValue<T> | undefined> {
		if (this.state !== "open") return Promise.reject(new Error("Flow journal storage is closed"));
		return Promise.resolve(readStoredValue(this.values, address));
	}

	scanValues<T>(prefix: Value<T>, _context: ScalarContext): Promise<StoredValue<T>[]> {
		if (this.state !== "open") return Promise.reject(new Error("Flow journal storage is closed"));
		return Promise.resolve(scanStoredValues(this.values, prefix));
	}

	close(_context: ScalarContext): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.state = "closing";
		this.closePromise = this.commitQueue.then(() => {
			this.state = "closed";
		});
		return this.closePromise;
	}

	private async applyCommit(writes: readonly Write[]): Promise<CommitResult> {
		// A commit queued before an earlier append failed must not run on uncertain bytes.
		if (this.fence !== undefined) throw this.fence;
		const prepared = prepareValueCommit(writes, this.nextSeq, Date.now());
		if (prepared.writes.length === 0) return prepared.result;
		// Serialize before touching the journal: an unserializable value is a caller error, not an
		// uncertain append, so it must leave the file and the sequence floor unchanged.
		const text = `${JSON.stringify(prepared.writes.length === 1 ? prepared.writes[0] : prepared.writes)}\n`;
		await this.checkpoint();
		try {
			await this.append(this.path, text);
		} catch (error) {
			// The append may have written part or all of the transaction. Only the file can decide
			// what committed, so refuse further appends until a reopen replays it.
			this.fence ??= new Error("Flow journal append failed; reopen the journal before committing again.", {
				cause: error,
			});
			throw error;
		}
		applyValueWrites(this.values, prepared.writes);
		this.nextSeq = prepared.result.firstSeq + prepared.writes.length;
		return prepared.result;
	}

	private async checkpoint(): Promise<void> {
		const size = await checkpointFlowJournal(this.path, this.checkpointBytes);
		// Live history cannot be compacted away. Wait for proportional growth before scanning it again.
		if (size !== undefined) this.checkpointBytes = Math.max(FLOW_JOURNAL_CHECKPOINT_BYTES, size * 2);
	}
}

/**
 * Storage for a journal that has no file yet. Commits apply in memory until `materialize` writes
 * the file with every value committed so far, after which it behaves as a journal at that path.
 */
class DeferredJournalStorage implements ScalarStorage {
	private readonly values: ScalarState = new Map();
	private nextSeq = 1;
	private journal?: JournalScalarStorage;
	private state: "open" | "closing" | "closed" = "open";
	private queue: Promise<unknown> = Promise.resolve();
	private closePromise: Promise<void> | undefined;

	/** Runs before the first write that reaches this storage while it has no file. */
	beforeFirstWrite?: () => Promise<void>;

	constructor(private readonly options: JournalStorageOptions) {}

	get materialized(): boolean {
		return !!this.journal;
	}

	private serial<T>(work: () => Promise<T>): Promise<T> {
		const result = this.queue.then(work);
		this.queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	commit(writes: readonly Write[], context: ScalarContext): Promise<CommitResult> {
		if (this.state !== "open") return Promise.reject(new Error("Flow journal storage is closed"));
		const first = !this.journal ? this.beforeFirstWrite : undefined;
		if (first)
			return first().then(() => {
				if (this.state !== "open") throw new Error("Flow journal storage is closed");
				return this.serial(() => this.write(writes, context));
			});
		return this.serial(() => this.write(writes, context));
	}

	private async write(writes: readonly Write[], context: ScalarContext): Promise<CommitResult> {
		if (this.journal) return this.journal.commit(writes, context);
		const prepared = prepareValueCommit(writes, this.nextSeq, Date.now());
		applyValueWrites(this.values, prepared.writes);
		this.nextSeq = prepared.result.firstSeq + prepared.writes.length;
		return prepared.result;
	}

	getValue<T>(address: Value<T>, _context: ScalarContext): Promise<StoredValue<T> | undefined> {
		if (this.state !== "open") return Promise.reject(new Error("Flow journal storage is closed"));
		return Promise.resolve(readStoredValue(this.values, address));
	}

	scanValues<T>(prefix: Value<T>, _context: ScalarContext): Promise<StoredValue<T>[]> {
		if (this.state !== "open") return Promise.reject(new Error("Flow journal storage is closed"));
		return Promise.resolve(scanStoredValues(this.values, prefix));
	}

	/**
	 * Write the journal: its header and one transaction holding every current value, through a
	 * temporary file so a crash leaves either no journal or a complete one. Later commits append.
	 */
	materialize(path: string, metadata: JournalCreateMetadata): Promise<void> {
		if (this.state !== "open") return Promise.reject(new Error("Flow journal storage is closed"));
		validateCreateMetadata(metadata);
		return this.serial(async () => {
			if (this.journal) return;
			const header: JournalHeader = {
				v: JOURNAL_FORMAT_VERSION,
				kind: "header",
				id: metadata.id,
				storageVersion: JOURNAL_STORAGE_VERSION,
				createdAt: metadata.createdAt ?? Date.now(),
				cwd: metadata.cwd,
				nextSeq: this.nextSeq,
			};
			const records = [...this.values.values()]
				.sort((left, right) => left.seq - right.seq)
				.map((record) => ({
					kind: "value",
					op: "set",
					namespace: record.address.namespace,
					key: record.address.key,
					value: record.value,
					seq: record.seq,
				}));
			const text = `${JSON.stringify(header)}\n${records.length ? `${JSON.stringify(records)}\n` : ""}`;
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			// The temporary file lives beside the owner directory's sessions folder, as checkpoints do, so a
			// crash before the rename can never leave a stray file where journals are discovered.
			const temporary = join(dirname(dirname(dirname(path))), `.materialize-${randomUUID()}`);
			try {
				const output = await open(temporary, "wx", 0o600);
				try {
					await output.writeFile(text);
					await output.sync();
				} finally {
					await output.close();
				}
				await rename(temporary, path);
			} catch (error) {
				await rm(temporary, { force: true }).catch(() => {});
				throw error;
			}
			this.journal = new JournalScalarStorage(
				path,
				this.options.append ?? appendText,
				this.values,
				this.nextSeq,
				this.options.checkpointBytes ?? FLOW_JOURNAL_CHECKPOINT_BYTES,
			);
		});
	}

	close(context: ScalarContext): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.state = "closing";
		this.closePromise = this.serial(async () => {
			await this.journal?.close(context);
			this.state = "closed";
		});
		return this.closePromise;
	}
}

/** A flow journal kept in memory until its owner decides it has something worth keeping. */
export interface DeferredJournal {
	readonly session: Session;
	readonly materialized: boolean;
	/** Create the journal file at `path` from everything committed so far. Idempotent once done. */
	materialize(path: string, metadata: JournalCreateMetadata): Promise<void>;
	/**
	 * Run `hook` before the first commit that arrives while there is no file, so recording anything
	 * creates the file first. Commits made before this is set stay in memory.
	 */
	beforeFirstWrite(hook: () => Promise<void>): void;
}

export function createDeferredJournal(options: JournalStorageOptions = {}): DeferredJournal {
	const storage = new DeferredJournalStorage(options);
	const session = createScalarSession(
		{ id: "flow", createdAt: Date.now(), storageVersion: JOURNAL_STORAGE_VERSION },
		storage,
	);
	return {
		session,
		get materialized() {
			return storage.materialized;
		},
		materialize: (path, metadata) => storage.materialize(path, metadata),
		beforeFirstWrite: (hook) => {
			storage.beforeFirstWrite = hook;
		},
	};
}

/** Create a new journal at an explicit path. An existing file is never replaced. */
export async function createJournalSession(
	path: string,
	metadata: JournalCreateMetadata,
	options: JournalStorageOptions = {},
): Promise<Session<JournalSessionMetadata>> {
	validateCreateMetadata(metadata);
	const header: JournalHeader = {
		v: JOURNAL_FORMAT_VERSION,
		kind: "header",
		id: metadata.id,
		storageVersion: JOURNAL_STORAGE_VERSION,
		createdAt: metadata.createdAt ?? Date.now(),
		cwd: metadata.cwd,
		...(metadata.parentSessionId === undefined ? {} : { parentSessionId: metadata.parentSessionId }),
		...(metadata.legacyParentSessionPath === undefined
			? {}
			: { legacyParentSessionPath: metadata.legacyParentSessionPath }),
		...(metadata.nextSeq === undefined ? {} : { nextSeq: metadata.nextSeq }),
	};
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify(header)}\n`, { flag: "wx", mode: 0o600 });
	return createScalarSession(
		headerMetadata(header, path),
		new JournalScalarStorage(
			path,
			options.append ?? appendText,
			new Map(),
			header.nextSeq ?? 1,
			options.checkpointBytes ?? FLOW_JOURNAL_CHECKPOINT_BYTES,
		),
	);
}

/**
 * Open an existing journal, replay its complete transactions, and repair an unterminated final
 * transaction. Invalid complete records or metadata leave the file unchanged.
 */
export async function openJournalSession(
	path: string,
	options: JournalOpenOptions = {},
): Promise<Session<JournalSessionMetadata>> {
	let checkpointBytes = options.checkpointBytes ?? FLOW_JOURNAL_CHECKPOINT_BYTES;
	const content = await readFile(path);
	// Newline offsets must be bytes, not UTF-16 indices: complete records can contain Japanese.
	const completeBytes = content.lastIndexOf(10) + 1;
	if (completeBytes === 0) throw new Error(`Invalid flow journal ${path}: missing complete header.`);
	const complete = content.subarray(0, completeBytes);
	if (!isUtf8(complete)) throw new Error(`Invalid flow journal ${path}: complete records contain invalid UTF-8.`);
	const lines = complete.toString("utf8").slice(0, -1).split("\n");
	const header = parseJournalHeader(lines[0] ?? "", path);
	const metadata = headerMetadata(header, path);
	await options.validateMetadata?.(metadata);
	const values: ScalarState = new Map();
	let lastSeq = 0;
	for (let index = 1; index < lines.length; index++) {
		const writes = parseTransaction(lines[index] ?? "", path, index + 1);
		for (const write of writes) {
			if (write.seq <= lastSeq)
				throw new Error(`Invalid flow journal ${path}: line ${index + 1} repeats or lowers a sequence.`);
			lastSeq = write.seq;
		}
		applyValueWrites(values, writes);
	}
	const nextSeq = Math.max(header.nextSeq ?? 1, lastSeq + 1);
	// Writer ownership excludes concurrent appends. Truncate only the validated incomplete suffix;
	// interrupted repair must not leave a temporary file that blocks journal discovery.
	if (completeBytes !== content.length) await truncate(path, completeBytes);
	// Complete records and identity are validated before either repair or compaction can write.
	const size = await checkpointFlowJournal(path, checkpointBytes);
	if (size !== undefined) checkpointBytes = Math.max(FLOW_JOURNAL_CHECKPOINT_BYTES, size * 2);
	return createScalarSession(
		metadata,
		new JournalScalarStorage(path, options.append ?? appendText, values, nextSeq, checkpointBytes),
	);
}
