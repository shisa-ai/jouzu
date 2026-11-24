import { chmodSync, closeSync, lstatSync, openSync } from "node:fs";
import { join, toNamespacedPath } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { ensurePrivateDirectory } from "./private-fs.js";

const maxRows = 10_000;
const maxRecordBytes = 16 * 1024;

export interface SessionMetadataStore {
	get(path: string, fingerprint: string): SessionInfo | undefined;
	put(path: string, fingerprint: string, info: SessionInfo): void;
	close(): void;
}

function decode(path: string, data: string): SessionInfo | undefined {
	const row = JSON.parse(data);
	if (
		!row ||
		typeof row.id !== "string" ||
		typeof row.cwd !== "string" ||
		(row.name !== undefined && typeof row.name !== "string") ||
		(row.parentSessionPath !== undefined && typeof row.parentSessionPath !== "string") ||
		!Number.isFinite(row.created) ||
		!Number.isFinite(row.modified) ||
		!Number.isSafeInteger(row.messageCount) ||
		row.messageCount < 0 ||
		typeof row.firstMessage !== "string"
	)
		return undefined;
	return {
		path,
		id: row.id,
		cwd: row.cwd,
		name: row.name,
		parentSessionPath: row.parentSessionPath,
		created: new Date(row.created),
		modified: new Date(row.modified),
		messageCount: row.messageCount,
		firstMessage: row.firstMessage,
		allMessagesText: "",
	};
}

/** Each listing opens a short-lived cache reader. Only changed rows are written. */
export function createSessionMetadataCache(cacheDir: string): () => SessionMetadataStore | undefined {
	const directory = join(cacheDir, "session-list");
	// Bump the filename when the schema or Pi's metadata extraction semantics change.
	const path = join(directory, "v1.sqlite");
	return () => {
		let db: DatabaseSync | undefined;
		try {
			ensurePrivateDirectory(cacheDir, directory);
			const file = lstatSync(path, { throwIfNoEntry: false });
			if (!file) {
				try {
					closeSync(openSync(path, "wx", 0o600));
				} catch (error) {
					if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
				}
			}
			if (!lstatSync(path).isFile()) return undefined;
			if (process.platform !== "win32") chmodSync(path, 0o600);
			db = new DatabaseSync(toNamespacedPath(path));
			db.exec(`PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF;
				CREATE TABLE IF NOT EXISTS sessions (path TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
					data TEXT NOT NULL, written INTEGER NOT NULL) STRICT;`);
			const read = db.prepare("SELECT data FROM sessions WHERE path = ? AND fingerprint = ?");
			const write = db.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?)
				ON CONFLICT(path) DO UPDATE SET fingerprint=excluded.fingerprint, data=excluded.data, written=excluded.written`);
			const prune = db.prepare(
				"DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions ORDER BY written DESC, rowid DESC LIMIT -1 OFFSET ?)",
			);
			const connection = db;
			const pending: [string, string, string][] = [];
			function flush() {
				if (!pending.length) return;
				const rows = pending.splice(0);
				try {
					connection.exec("BEGIN IMMEDIATE");
					const now = Date.now();
					for (const row of rows) write.run(...row, now);
					prune.run(maxRows);
					connection.exec("COMMIT");
				} catch {
					try {
						connection.exec("ROLLBACK");
					} catch {
						/* No transaction to roll back. */
					}
				}
			}
			return {
				get(path, fingerprint) {
					try {
						const data = read.get(path, fingerprint)?.data;
						return typeof data === "string" && Buffer.byteLength(data) <= maxRecordBytes
							? decode(path, data)
							: undefined;
					} catch {
						return undefined;
					}
				},
				put(path, fingerprint, info) {
					const { id, cwd, name, parentSessionPath, messageCount, created, modified, firstMessage } = info;
					const data = JSON.stringify({
						id,
						cwd,
						name,
						parentSessionPath,
						messageCount,
						firstMessage,
						created: created.getTime(),
						modified: modified.getTime(),
					});
					if (Buffer.byteLength(data) > maxRecordBytes) return;
					pending.push([path, fingerprint, data]);
					if (pending.length >= 100) flush();
				},
				close() {
					flush();
					try {
						connection.close();
					} catch {
						/* Cache failure must not block listing. */
					}
				},
			};
		} catch {
			try {
				db?.close();
			} catch {
				/* Cache is optional. */
			}
			return undefined;
		}
	};
}
