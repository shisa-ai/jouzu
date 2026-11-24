import { closeSync, lstatSync, openSync } from "node:fs";
import { dirname, toNamespacedPath } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { catalogText, defaultCatalog } from "./cli-messages.js";
import { protectedPath } from "./human-messages.js";
import type { CatalogBundle } from "./locale-catalog.js";
import { ensurePrivateDirectory } from "./private-fs.js";

/**
 * The catalog IDs for the process lock acquisition errors. They stay local
 * rather than joining the shared `CatalogMessageId` table so a parallel surface
 * migration does not conflict on that file; `scripts/check-locales.mjs` allows
 * a catalog-only ID present in both locales.
 */
const PROCESS_LOCK_IDS = {
	busy: "jouzu.cli.processLock.busy",
	unavailable: "jouzu.cli.processLock.unavailable",
} as const;

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

function sqliteBusy(error: unknown): boolean {
	return error instanceof Error && "errcode" in error && [5, 6].includes(Number(error.errcode) & 0xff);
}

/** Probe a lock without creating it, writing to it, or waiting for its owner. */
export function isProcessLockBusy(path: string): boolean {
	let database: DatabaseSync | undefined;
	try {
		if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return false;
		const uri = pathToFileURL(path);
		// SQLite read-only opens do not take a writer reservation for BEGIN IMMEDIATE.
		// mode=rw takes the same reservation as the owner without creating a missing file.
		uri.search = "mode=rw";
		database = new DatabaseSync(uri);
		database.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE;");
		return false;
	} catch (error) {
		return sqliteBusy(error);
	} finally {
		database?.close();
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
export function acquireProcessLock(path: string, catalog: CatalogBundle = defaultCatalog()): ProcessLock {
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
		// SQLite needs the Windows extended path prefix to open deeply nested state directories.
		database = new DatabaseSync(toNamespacedPath(path), { defensive: false });
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
		const busy = sqliteBusy(error);
		throw new ProcessLockError(
			busy ? "busy" : "storage",
			busy
				? catalogText(catalog, PROCESS_LOCK_IDS.busy, { path: protectedPath(path) })
				: catalogText(catalog, PROCESS_LOCK_IDS.unavailable, { path: protectedPath(path) }),
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
