import { closeSync, lstatSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensurePrivateDirectory } from "./private-fs.js";

/**
 * Retain every reservation held by a live connection, so garbage collection
 * cannot close a connection that its holder still relies on. A close that fails
 * leaves the connection here for the rest of the process.
 */
const retained = new Set<DatabaseSync>();

export class ProcessLockError extends Error {
	constructor(
		readonly reason: "busy" | "storage",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "ProcessLockError";
	}
}

export interface ProcessLock {
	/** Idempotent. Closing the connection releases the reservation; the lock file stays in place. */
	release(): void;
}

/**
 * Hold exclusive ownership of one local path until release or process death.
 *
 * Ownership is a SQLite writer reservation on a stable database file, so the
 * operating system releases it whenever the holder exits, including a crash or
 * a kill. The file is only a rendezvous point: its existence does not mean the
 * path is locked, and a leftover file never blocks a later acquisition. Never
 * delete, replace, or write to the file, because a replacement inode would let
 * two holders both succeed and an interrupted write would turn a valid
 * database into a storage error.
 *
 * This is mutual exclusion on a local filesystem. It makes no claim across
 * machines or network shares.
 */
export function acquireProcessLock(path: string): ProcessLock {
	let database: DatabaseSync | undefined;
	try {
		ensurePrivateDirectory(dirname(path));
		try {
			closeSync(openSync(path, "wx", 0o600));
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
		const metadata = lstatSync(path);
		if (!metadata.isFile() || metadata.isSymbolicLink())
			throw new ProcessLockError("storage", `A process lock requires a regular file: ${path}`);
		database = new DatabaseSync(path, { defensive: false });
		// Newer Node releases enable SQLite defensive mode, which silently refuses
		// journal_mode=OFF. This private connection executes only the fixed SQL here:
		// no application writes, schemas, or commits are permitted.
		if (database.prepare("PRAGMA journal_mode=OFF").get()?.journal_mode !== "off")
			throw new ProcessLockError("storage", `The process lock could not disable journaling: ${path}`);
		// IMMEDIATE keeps competing openers from both failing while upgrading a
		// shared lock to exclusive. OFF prevents even an empty database's journal.
		database.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE;");
		retained.add(database);
	} catch (error) {
		try {
			database?.close();
		} catch (closeError) {
			if (database) retained.add(database);
			throw new ProcessLockError("storage", `The process lock could not be closed after acquisition failed: ${path}`, {
				cause: new AggregateError([error, closeError]),
			});
		}
		if (error instanceof ProcessLockError) throw error;
		const busy = error instanceof Error && "errcode" in error && [5, 6].includes(Number(error.errcode));
		throw new ProcessLockError(
			busy ? "busy" : "storage",
			busy ? `The process lock is held by another process: ${path}` : `The process lock could not be acquired: ${path}`,
			{ cause: error },
		);
	}
	const held = database;
	let released = false;
	let releaseError: ProcessLockError | undefined;
	return {
		release(): void {
			if (releaseError) throw releaseError;
			if (released) return;
			try {
				held.close();
				released = true;
				retained.delete(held);
			} catch (error) {
				releaseError = new ProcessLockError("storage", `The process lock did not close cleanly: ${path}`, {
					cause: error,
				});
				throw releaseError;
			}
		},
	};
}
