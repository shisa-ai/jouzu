import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** Stale threshold after which a dead or owner-unknown lock may be recovered. */
export const STATE_LOCK_STALE_MS = 30 * 60 * 1000;

export interface StateLockRecord {
	pid: number;
	startedAt: string;
	token: string;
}

export type StateLockStatus = "free" | "held-live" | "held-dead" | "owner-unknown" | "invalid";

export interface StateLockInspection {
	exists: boolean;
	status: StateLockStatus;
	ageMs: number | null;
}

export interface AcquireStateLockOptions {
	path: string;
	staleMs?: number;
	describe: string;
	now?: Date;
	/** Maps a busy inspection to the caller's domain-specific error. */
	onBusy: (inspection: StateLockInspection) => Error;
}

function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

/**
 * Inspect a state lock without acquiring it. An empty or unparsable legacy
 * lock is classified as owner-unknown; its age is approximated from the file
 * modification time because no started-at record exists.
 */
export function inspectStateLock(path: string, now: Date): StateLockInspection {
	if (!existsSync(path)) return { exists: false, status: "free", ageMs: null };
	try {
		const metadata = lstatSync(path);
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			return { exists: true, status: "invalid", ageMs: null };
		}
		let record: StateLockRecord | null = null;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StateLockRecord>;
			if (
				typeof parsed.pid === "number" &&
				typeof parsed.startedAt === "string" &&
				typeof parsed.token === "string" &&
				Number.isFinite(Date.parse(parsed.startedAt))
			) {
				record = { pid: parsed.pid, startedAt: parsed.startedAt, token: parsed.token };
			}
		} catch {}
		if (record === null) {
			let ageMs: number | null = null;
			try {
				ageMs = now.getTime() - lstatSync(path).mtimeMs;
			} catch {}
			return { exists: true, status: "owner-unknown", ageMs };
		}
		const ageMs = now.getTime() - Date.parse(record.startedAt);
		return {
			exists: true,
			status: pidIsAlive(record.pid) ? "held-live" : "held-dead",
			ageMs,
		};
	} catch {
		return { exists: false, status: "free", ageMs: null };
	}
}

function releaseToken(path: string, token: string): void {
	try {
		const metadata = lstatSync(path);
		if (!metadata.isFile() || metadata.isSymbolicLink()) return;
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { token?: unknown };
		if (parsed.token === token) unlinkSync(path);
	} catch {}
}

/**
 * Acquire a state lock shared by the updater, profile, and keybinding
 * operations. The lock records a PID, started-at timestamp, and a release
 * token. A lock held by a live process is always refused; a dead owner's lock
 * or an owner-unknown legacy lock is refused while younger than the stale
 * threshold and recovered automatically once it is older, without deleting a
 * successor's lock. Returns a token-matched release function.
 */
export function acquireStateLock(options: AcquireStateLockOptions): () => void {
	const now = options.now ?? new Date();
	const staleMs = options.staleMs ?? STATE_LOCK_STALE_MS;
	mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
	const token = randomUUID();
	const record: StateLockRecord = { pid: process.pid, startedAt: now.toISOString(), token };
	const writeNew = (): void => {
		const descriptor = openSync(options.path, "wx", 0o600);
		writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
		fsyncSync(descriptor);
		closeSync(descriptor);
	};
	try {
		writeNew();
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		const inspection = inspectStateLock(options.path, now);
		if (inspection.status === "free") {
			writeNew();
			return () => releaseToken(options.path, token);
		}
		if (inspection.status === "held-live" || inspection.status === "invalid") {
			throw options.onBusy(inspection);
		}
		// held-dead or owner-unknown: refuse while younger than the threshold,
		// recover automatically once stale.
		if (inspection.ageMs === null || inspection.ageMs <= staleMs) {
			throw options.onBusy(inspection);
		}
		unlinkSync(options.path);
		writeNew();
		return () => releaseToken(options.path, token);
	}
	return () => releaseToken(options.path, token);
}

function ageText(ageMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(ageMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Human-readable one-line description of a lock for doctor output. */
export function describeStateLock(path: string, staleMs: number, now: Date): string {
	const inspection = inspectStateLock(path, now);
	switch (inspection.status) {
		case "free":
			return "free";
		case "held-live":
			return `held by a live process (${ageText(inspection.ageMs ?? 0)})`;
		case "held-dead":
			return `left by a dead process (${ageText(inspection.ageMs ?? 0)}; recoverable after ${ageText(staleMs)})`;
		case "owner-unknown":
			return `owner unknown (${ageText(inspection.ageMs ?? 0)}; recoverable after ${ageText(staleMs)})`;
		case "invalid":
			return "invalid (not a regular lock file)";
	}
}
