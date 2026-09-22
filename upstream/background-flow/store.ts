/*
 * Canonical background-producer store for Jouzu's long-session storage mode.
 *
 * One versioned, session-owned recovery authority replaces the legacy
 * per-session sidecar plus transcript snapshot appends. It persists:
 *   - live task records (full snapshots, so restore keeps wake/receipt state);
 *   - retained terminal results, including results that outlive task clear;
 *   - the monotonic task-ID allocation counter;
 *   - a bounded recent diagnostic ring.
 *
 * Commit contract:
 *   - the next revision is built from the current view without mutating it;
 *   - identity, schema and retention limits are validated;
 *   - a temporary file is written and fsynced, atomically renamed over the
 *     store, and the parent directory is fsynced where the platform supports
 *     it (best effort: Windows and some filesystems reject directory fsync);
 *   - only then is the committed revision published to callers.
 * A filesystem rename is atomic replacement on one volume; it is not a
 * universal power-loss guarantee, which is why the file content is fsynced
 * before the rename. A failed write leaves the previous store untouched and
 * never acknowledges a result.
 *
 * Legacy import is a one-time migration: legacy sidecar and historical
 * transcript snapshots are replayed with the dependency's existing recovery
 * rules, the canonical store is committed, and only then is the single
 * adoption marker appended to the transcript. After adoption the store is the
 * only restore authority; historical snapshots are never replayed over it.
 * Missing state with an adoption marker, a corrupt store, or a store owned by
 * another session is reported as an explicit producer-recovery problem rather
 * than an empty successful task list.
 */

import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { BackgroundTerminalResult } from "./jouzu-flow.js";
import type { BackgroundTaskSnapshot } from "./types.js";

export const BG_CANONICAL_STORE_VERSION = 2;
export const BG_CANONICAL_STORE_FILE = "state-v2.json";
export const BG_CANONICAL_STORE_MARKER_TYPE = "kendex-background-tasks:store";
export const BG_CANONICAL_STORE_MARKER_VERSION = 1;
export const BG_CANONICAL_MAX_TASKS = 512;
export const BG_CANONICAL_MAX_RESULTS = 512;
export const BG_CANONICAL_MAX_DIAGNOSTICS = 100;
export const BG_CANONICAL_MAX_PRESENTATION_TASKS = 50;
export const BG_CANONICAL_MAX_PRESENTATION_BYTES = 64 * 1024;
export const BG_CANONICAL_PRESENTATION_FIELD_CHARS = 192;
export const BG_CANONICAL_PROGRESS_FLUSH_MS = 250;

export interface CanonicalStoreScope {
	sessionId: string;
	branchId: string;
}

export interface CanonicalStoreResult {
	scope: CanonicalStoreScope;
	work?: { id: string; revision: number };
	result: BackgroundTerminalResult;
}

export interface CanonicalStoreDiagnostic {
	at: number;
	message: string;
	reason?: string;
	taskId?: string;
}

export interface CanonicalStoreState {
	schemaVersion: 2;
	sessionId: string;
	generation: number;
	revision: number;
	updatedAt: number;
	nextTaskId: number;
	adoptedAt?: number;
	tasks: BackgroundTaskSnapshot[];
	results: CanonicalStoreResult[];
	diagnostics: CanonicalStoreDiagnostic[];
	counters?: Record<string, number>;
}

export interface CanonicalStoreIo {
	/** Returns undefined when the file does not exist. */
	readFile(path: string): string | undefined;
	writeFile(path: string, data: string): void;
	fsyncFile(path: string): void;
	rename(from: string, to: string): void;
	mkdir(path: string): void;
	/** Best effort: platforms/filesystems that reject directory fsync may throw. */
	fsyncDirectory(path: string): void;
	unlink(path: string): void;
}

export type CanonicalStoreRead =
	| { status: "ok"; state: CanonicalStoreState }
	| { status: "missing" }
	| { status: "corrupt"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIdentity(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

let temporarySequence = 0;

export const nodeCanonicalStoreIo: CanonicalStoreIo = {
	readFile(path) {
		try {
			return readFileSync(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	},
	writeFile(path, data) {
		writeFileSync(path, data, { encoding: "utf8", mode: 0o600 });
	},
	fsyncFile(path) {
		const descriptor = openSync(path, "r+");
		try {
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
	},
	rename(from, to) {
		renameSync(from, to);
	},
	mkdir(path) {
		mkdirSync(path, { recursive: true, mode: 0o700 });
	},
	fsyncDirectory(path) {
		const descriptor = openSync(path, "r");
		try {
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
	},
	unlink(path) {
		try {
			unlinkSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	},
};

/** Canonical store path next to the legacy sidecar path. */
export function canonicalStorePath(legacyStatePath: string): string {
	return join(dirname(legacyStatePath), BG_CANONICAL_STORE_FILE);
}

/** The one adoption marker. It identifies schema and session; it never embeds paths or hashes. */
export function canonicalMarkerData(
	sessionId: string,
	now: number = Date.now(),
): { version: 1; schemaVersion: 2; sessionId: string; adoptedAt: number } {
	return {
		version: BG_CANONICAL_STORE_MARKER_VERSION,
		schemaVersion: BG_CANONICAL_STORE_VERSION,
		sessionId,
		adoptedAt: now,
	};
}

export function isCanonicalMarker(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		value.version === BG_CANONICAL_STORE_MARKER_VERSION &&
		value.schemaVersion === BG_CANONICAL_STORE_VERSION &&
		isIdentity(value.sessionId)
	);
}

/** Highest numeric task id in a record list. Allocation never rewinds past it. */
export function highestTaskNumber(tasks: readonly { id?: unknown }[]): number {
	let highest = 0;
	for (const task of tasks) {
		const match = typeof task?.id === "string" ? /^bg-(\d+)$/.exec(task.id) : null;
		if (match) highest = Math.max(highest, Number(match[1]));
	}
	return highest;
}

/** Bounded recent-diagnostics ring; newest entries win. */
export function boundedDiagnostics(
	ring: readonly CanonicalStoreDiagnostic[],
	limit: number = BG_CANONICAL_MAX_DIAGNOSTICS,
): CanonicalStoreDiagnostic[] {
	const bounded = ring
		.filter((entry) => isRecord(entry) && isFiniteNumber(entry.at) && typeof entry.message === "string")
		.slice(-Math.max(0, limit));
	return bounded.map((entry) => ({
		at: entry.at,
		message: entry.message.slice(0, 512),
		...(typeof entry.reason === "string" ? { reason: entry.reason.slice(0, 128) } : {}),
		...(typeof entry.taskId === "string" ? { taskId: entry.taskId.slice(0, 128) } : {}),
	}));
}

function validateTaskRecord(value: unknown, index: number): string | undefined {
	if (!isRecord(value)) return `tasks[${index}] is not an object`;
	if (!isIdentity(value.id)) return `tasks[${index}].id is invalid`;
	if (!isFiniteNumber(value.startedAt)) return `tasks[${index}].startedAt is invalid`;
	if (typeof value.status !== "string") return `tasks[${index}].status is invalid`;
	if (value.sessionId !== undefined && !isIdentity(value.sessionId)) return `tasks[${index}].sessionId is invalid`;
	if (value.flow !== undefined) {
		if (!isRecord(value.flow)) return `tasks[${index}].flow is invalid`;
		if (value.flow.version !== 1) return `tasks[${index}].flow.version is invalid`;
		if (!isIdentity(value.flow.execution)) return `tasks[${index}].flow.execution is invalid`;
		if (value.flow.scope !== undefined) {
			if (!isRecord(value.flow.scope)) return `tasks[${index}].flow.scope is invalid`;
			if (!isIdentity(value.flow.scope.sessionId) || !isIdentity(value.flow.scope.branchId))
				return `tasks[${index}].flow.scope identity is invalid`;
		}
		if (value.flow.work !== undefined) {
			if (!isRecord(value.flow.work)) return `tasks[${index}].flow.work is invalid`;
			if (!isIdentity(value.flow.work.id) || !isNonNegativeInteger(value.flow.work.revision))
				return `tasks[${index}].flow.work is invalid`;
		}
	}
	return undefined;
}

function validateResultRecord(value: unknown, index: number): string | undefined {
	if (!isRecord(value)) return `results[${index}] is not an object`;
	const scope = value.scope;
	if (!isRecord(scope) || !isIdentity(scope.sessionId) || !isIdentity(scope.branchId))
		return `results[${index}].scope is invalid`;
	const result = value.result;
	if (!isRecord(result) || !isRecord(result.metadata)) return `results[${index}].result is invalid`;
	if (!isIdentity(result.metadata.id)) return `results[${index}].result.metadata.id is invalid`;
	if (!isIdentity(result.metadata.execution)) return `results[${index}].result.metadata.execution is invalid`;
	if (typeof result.metadata.status !== "string") return `results[${index}].result.metadata.status is invalid`;
	return undefined;
}

export function validateCanonicalStore(
	value: unknown,
): { ok: true; state: CanonicalStoreState } | { ok: false; reason: string } {
	if (!isRecord(value)) return { ok: false, reason: "store is not an object" };
	if (value.schemaVersion !== BG_CANONICAL_STORE_VERSION) return { ok: false, reason: "schemaVersion mismatch" };
	if (!isIdentity(value.sessionId)) return { ok: false, reason: "sessionId is invalid" };
	if (!isNonNegativeInteger(value.generation)) return { ok: false, reason: "generation is invalid" };
	if (!isNonNegativeInteger(value.revision)) return { ok: false, reason: "revision is invalid" };
	if (!isFiniteNumber(value.updatedAt)) return { ok: false, reason: "updatedAt is invalid" };
	if (!isNonNegativeInteger(value.nextTaskId)) return { ok: false, reason: "nextTaskId is invalid" };
	if (value.adoptedAt !== undefined && !isFiniteNumber(value.adoptedAt)) return { ok: false, reason: "adoptedAt is invalid" };
	if (!Array.isArray(value.tasks)) return { ok: false, reason: "tasks is not an array" };
	if (value.tasks.length > BG_CANONICAL_MAX_TASKS) return { ok: false, reason: "tasks exceeds retention capacity" };
	for (const [index, task] of value.tasks.entries()) {
		const problem = validateTaskRecord(task, index);
		if (problem) return { ok: false, reason: problem };
	}
	if (!Array.isArray(value.results)) return { ok: false, reason: "results is not an array" };
	if (value.results.length > BG_CANONICAL_MAX_RESULTS) return { ok: false, reason: "results exceeds retention capacity" };
	for (const [index, result] of value.results.entries()) {
		const problem = validateResultRecord(result, index);
		if (problem) return { ok: false, reason: problem };
	}
	if (value.diagnostics !== undefined) {
		if (!Array.isArray(value.diagnostics)) return { ok: false, reason: "diagnostics is not an array" };
		if (value.diagnostics.length > BG_CANONICAL_MAX_DIAGNOSTICS)
			return { ok: false, reason: "diagnostics exceeds retention capacity" };
	}
	return { ok: true, state: value as unknown as CanonicalStoreState };
}

export function readCanonicalStore(
	file: string,
	io: CanonicalStoreIo = nodeCanonicalStoreIo,
): CanonicalStoreRead {
	let raw: string | undefined;
	try {
		raw = io.readFile(file);
	} catch (error) {
		return { status: "corrupt", reason: `store read failed: ${errorMessage(error)}` };
	}
	if (raw === undefined) return { status: "missing" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { status: "corrupt", reason: `store is not valid JSON: ${errorMessage(error)}` };
	}
	const validated = validateCanonicalStore(parsed);
	if (!validated.ok) return { status: "corrupt", reason: validated.reason };
	return { status: "ok", state: validated.state };
}

/**
 * Atomically replace the store. The caller supplies the already-validated next
 * revision; this function re-validates, writes a same-directory temporary file,
 * fsyncs it, renames it over the store and fsyncs the directory best-effort.
 * On any failure the temporary file is removed and the previous store remains.
 */
export function commitCanonicalStore(
	file: string,
	state: CanonicalStoreState,
	io: CanonicalStoreIo = nodeCanonicalStoreIo,
): void {
	const validated = validateCanonicalStore(state);
	if (!validated.ok) throw new Error(`Refusing to commit an invalid background store: ${validated.reason}`);
	const payload = `${JSON.stringify(validated.state, null, 2)}\n`;
	io.mkdir(dirname(file));
	const temporary = `${file}.tmp.${process.pid}.${temporarySequence++}.${Date.now().toString(36)}`;
	try {
		io.writeFile(temporary, payload);
		io.fsyncFile(temporary);
		io.rename(temporary, file);
	} catch (error) {
		try {
			io.unlink(temporary);
		} catch {
			// The previous store is intact; a leaked temp file is harmless.
		}
		throw error;
	}
	try {
		io.fsyncDirectory(dirname(file));
	} catch {
		// Directory fsync is best effort; rename already made the replacement atomic.
	}
}

export interface CanonicalStateInput {
	prior?: CanonicalStoreState;
	sessionId: string;
	now: number;
	nextTaskId: number;
	tasks: readonly BackgroundTaskSnapshot[];
	results: readonly CanonicalStoreResult[];
	diagnostics?: readonly CanonicalStoreDiagnostic[];
	counters?: Record<string, number>;
	adoptedAt?: number;
}

function dedupeTasks(tasks: readonly BackgroundTaskSnapshot[]): BackgroundTaskSnapshot[] {
	const byId = new Map<string, BackgroundTaskSnapshot>();
	for (const task of tasks) byId.set(task.id, structuredClone(task));
	return [...byId.values()];
}

function dedupeResults(results: readonly CanonicalStoreResult[]): CanonicalStoreResult[] {
	const byKey = new Map<string, CanonicalStoreResult>();
	for (const result of results)
		byKey.set(
			JSON.stringify([result.scope.sessionId, result.scope.branchId, result.result.metadata.execution]),
			structuredClone(result),
		);
	return [...byKey.values()];
}

export function buildCanonicalState(input: CanonicalStateInput): CanonicalStoreState {
	const adoptedAt = input.adoptedAt ?? input.prior?.adoptedAt;
	return {
		schemaVersion: BG_CANONICAL_STORE_VERSION,
		sessionId: input.sessionId,
		generation: (input.prior?.generation ?? 0) + 1,
		revision: (input.prior?.revision ?? 0) + 1,
		updatedAt: input.now,
		nextTaskId: Math.max(input.nextTaskId, highestTaskNumber(input.tasks)),
		...(adoptedAt !== undefined ? { adoptedAt } : {}),
		tasks: dedupeTasks(input.tasks),
		results: dedupeResults(input.results),
		diagnostics: boundedDiagnostics(input.diagnostics ?? []),
		...(input.counters ? { counters: input.counters } : {}),
	};
}

export interface LegacySidecarPayload {
	tasks: BackgroundTaskSnapshot[];
	updatedAt?: number;
}

/** Parse the legacy versioned sidecar defensively; malformed state is not evidence. */
export function parseLegacySidecar(raw: string): LegacySidecarPayload | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.tasks)) return undefined;
	const tasks = parsed.tasks.filter(
		(task): task is BackgroundTaskSnapshot => isRecord(task) && isIdentity(task.id) && typeof task.command === "string",
	);
	return { tasks, ...(isFiniteNumber(parsed.updatedAt) ? { updatedAt: parsed.updatedAt } : {}) };
}

function truncatePresentation(value: string | undefined, maxChars = BG_CANONICAL_PRESENTATION_FIELD_CHARS): string | undefined {
	if (value === undefined) return undefined;
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export interface CanonicalPresentationTask {
	id: string;
	status: string;
	pid: number;
	sessionId?: string;
	branchId?: string;
	startedAt: number;
	updatedAt: number;
	outputBytes: number;
	exitCode: number | null;
	exitNotified?: boolean;
	terminationReason?: string;
	title: string;
	command: string;
	logFile: string;
	counters: { wakeSequence: number; wakeEvents: number; pendingWakes: number };
	flow?: {
		version: 1;
		execution: string;
		scope?: CanonicalStoreScope;
		work?: { id: string; revision: number };
		result?: BackgroundTerminalResult;
	};
}

export interface CanonicalPresentationDetails {
	version: 3;
	fullSnapshot: false;
	presentation: true;
	reason: "payload-too-large" | "task-count-threshold";
	byteSize: number;
	counts: { tasks: number; shown: number; omitted: number };
	tasks: CanonicalPresentationTask[];
	updatedAt: number;
}

export function boundedPresentationTask(task: BackgroundTaskSnapshot): CanonicalPresentationTask {
	const flow = task.flow;
	const result = flow?.result;
	return {
		id: task.id,
		status: task.status,
		pid: task.pid,
		...(task.sessionId !== undefined ? { sessionId: task.sessionId } : {}),
		...(flow?.scope?.branchId !== undefined ? { branchId: flow.scope.branchId } : {}),
		startedAt: task.startedAt,
		updatedAt: task.updatedAt,
		outputBytes: task.outputBytes,
		exitCode: task.exitCode,
		...(task.exitNotified !== undefined ? { exitNotified: task.exitNotified } : {}),
		...(task.terminationReason !== undefined ? { terminationReason: task.terminationReason } : {}),
		title: truncatePresentation(task.title) ?? "",
		command: truncatePresentation(task.command) ?? "",
		logFile: truncatePresentation(task.logFile) ?? "",
		counters: {
			wakeSequence: task.wakeSequence ?? 0,
			wakeEvents: Array.isArray(task.wakeEvents) ? task.wakeEvents.length : 0,
			pendingWakes: Array.isArray(task.pendingWakes) ? task.pendingWakes.length : 0,
		},
		...(flow
			? {
					flow: {
						version: 1 as const,
						execution: flow.execution,
						...(flow.scope ? { scope: { ...flow.scope } } : {}),
						...(flow.work ? { work: { ...flow.work } } : {}),
						...(result
							? {
									result: {
										...(result.delivered !== undefined ? { delivered: result.delivered } : {}),
										...(result.observed !== undefined ? { observed: result.observed } : {}),
										...(result.notify !== undefined ? { notify: result.notify } : {}),
										metadata: {
											id: result.metadata.id,
											producer: truncatePresentation(result.metadata.producer) ?? "bg",
											execution: result.metadata.execution,
											revision: truncatePresentation(result.metadata.revision) ?? "1",
											status: result.metadata.status,
											title: truncatePresentation(result.metadata.title, 512) ?? "",
											reference: truncatePresentation(result.metadata.reference) ?? "",
											warnings: Array.isArray(result.metadata.warnings)
												? result.metadata.warnings.slice(0, 8).map((warning) => truncatePresentation(warning) ?? "")
												: [],
										},
										...(Array.isArray(result.reads)
											? {
													reads: result.reads.slice(-8).map((read) => ({
														id: read.id,
														revision: read.revision,
														toolCallId: truncatePresentation(read.toolCallId) ?? "",
														toolName: truncatePresentation(read.toolName) ?? "",
														contentHash: read.contentHash,
													})),
												}
											: {}),
									},
								}
							: {}),
					},
				}
			: {}),
	};
}

/**
 * Bounded transcript presentation of a task list. Under the existing byte/task
 * limits the full snapshots are returned unchanged, so live tool-result
 * consumers keep working. Over the limits, records keep identity, status,
 * counters and a retrieval reference while dropping wake arrays and full
 * commands; the payload is trimmed until it fits the byte budget.
 */
export function boundedPresentationTasks(
	tasks: BackgroundTaskSnapshot[],
	options: { maxBytes?: number; maxTasks?: number; sampleLimit?: number } = {},
): BackgroundTaskSnapshot[] | CanonicalPresentationDetails {
	const maxBytes = options.maxBytes ?? BG_CANONICAL_MAX_PRESENTATION_BYTES;
	const maxTasks = options.maxTasks ?? BG_CANONICAL_MAX_PRESENTATION_TASKS;
	const sampleLimit = options.sampleLimit ?? 20;
	const byteSize = Buffer.byteLength(JSON.stringify(tasks), "utf8");
	if (tasks.length <= maxTasks && byteSize <= maxBytes) return tasks;
	const records: CanonicalPresentationTask[] = [];
	for (const task of tasks.slice(0, Math.min(maxTasks, sampleLimit))) records.push(boundedPresentationTask(task));
	const envelope = (shown: number): CanonicalPresentationDetails => ({
		version: 3,
		fullSnapshot: false,
		presentation: true,
		reason: byteSize > maxBytes ? "payload-too-large" : "task-count-threshold",
		byteSize,
		counts: { tasks: tasks.length, shown, omitted: Math.max(0, tasks.length - shown) },
		tasks: records.slice(0, shown),
		updatedAt: tasks.reduce((latest, task) => Math.max(latest, task.updatedAt), 0),
	});
	let shown = records.length;
	while (shown > 1 && Buffer.byteLength(JSON.stringify(envelope(shown)), "utf8") > maxBytes) shown -= 1;
	return envelope(shown);
}

export type CanonicalPersistResult = {
	appendEntry: boolean;
	sidecar: boolean;
	appendReason?: "appended" | "coalesced" | "no-active-context" | "error";
};

export interface CanonicalBackgroundStoreDeps {
	sessionId(): string | null;
	storePath(context?: unknown): string | undefined;
	tasks(): BackgroundTaskSnapshot[];
	results(): CanonicalStoreResult[];
	nextTaskId(): number;
	diagnostics?(): CanonicalStoreDiagnostic[];
	prepareResults?(): void;
	commitResults?(): void;
	applyTask(snapshot: BackgroundTaskSnapshot): void;
	setNextTaskId(value: number): void;
	restoreResults(records: CanonicalStoreResult[]): void;
	markerPresent(context?: unknown): boolean;
	appendMarker(context?: unknown): void;
	reportProblem(where: string, message: string): void;
	io?: CanonicalStoreIo;
	now?: () => number;
	coalesceMs?: number;
	setTimer?: (callback: () => void, ms: number) => { unref?: () => void };
	clearTimer?: (handle: { unref?: () => void }) => void;
}

export interface CanonicalBackgroundStore {
	/** True when the store is authoritative and history must not be replayed. */
	restoreFromStore(context?: unknown): boolean;
	/** Commit migrated legacy state, then establish the adoption marker. */
	adopt(context?: unknown): void;
	persist(mode?: "force" | "progress"): CanonicalPersistResult;
	/** Flush a coalesced progress revision synchronously. */
	flush(): void;
	problem(): string | undefined;
}

/**
 * Extension-side adapter. Progress-only revisions are coalesced behind a
 * single fixed-bound timer that rebuilds state at flush time, so no
 * intermediate sample is retained. Every other revision commits immediately.
 */
export function createCanonicalBackgroundStore(deps: CanonicalBackgroundStoreDeps): CanonicalBackgroundStore {
	const io = deps.io ?? nodeCanonicalStoreIo;
	const now = deps.now ?? Date.now;
	const coalesceMs = deps.coalesceMs ?? BG_CANONICAL_PROGRESS_FLUSH_MS;
	const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
	const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	let state: CanonicalStoreState | undefined;
	let blocked: string | undefined;
	let blockedSessionId: string | undefined;
	let markerAppended = false;
	let timer: { unref?: () => void } | undefined;
	let lastProblem: string | undefined;
	let context: unknown;

	function storePath(): string | undefined {
		return deps.storePath(context);
	}

	function report(where: string, message: string): void {
		const key = `${where}:${message}`;
		if (lastProblem === key) return;
		lastProblem = key;
		deps.reportProblem(where, message);
	}

	function clearProblem(): void {
		lastProblem = undefined;
	}

	function priorState(): CanonicalStoreState | undefined {
		if (state) return state;
		const path = storePath();
		if (!path) return undefined;
		const read = readCanonicalStore(path, io);
		return read.status === "ok" ? read.state : undefined;
	}

	function buildState(sessionId: string, adoptedAt?: number): CanonicalStoreState {
		return buildCanonicalState({
			prior: priorState(),
			sessionId,
			now: now(),
			nextTaskId: deps.nextTaskId(),
			tasks: deps.tasks(),
			results: deps.results(),
			diagnostics: deps.diagnostics?.(),
			...(adoptedAt !== undefined ? { adoptedAt } : {}),
		});
	}

	function ensureMarker(): void {
		if (markerAppended) return;
		try {
			if (!deps.markerPresent(context)) deps.appendMarker(context);
			markerAppended = true;
		} catch (error) {
			report("store-marker", errorMessage(error));
		}
	}

	function writeNow(): void {
		const sessionId = deps.sessionId();
		const path = storePath();
		if (!sessionId || !path) throw new Error("No active session owns the background store.");
		const next = buildState(sessionId);
		commitCanonicalStore(path, next, io);
		state = next;
		clearProblem();
		deps.commitResults?.();
		ensureMarker();
	}

	function cancelScheduled(): void {
		if (timer === undefined) return;
		clearTimer(timer);
		timer = undefined;
	}

	function schedule(): void {
		if (timer !== undefined) return;
		timer = setTimer(() => {
			timer = undefined;
			if (blocked) return;
			try {
				writeNow();
			} catch (error) {
				report("store-write", errorMessage(error));
			}
		}, coalesceMs);
		timer?.unref?.();
	}

	return {
		restoreFromStore(candidate?: unknown): boolean {
			context = candidate ?? context;
			const sessionId = deps.sessionId();
			if (blockedSessionId !== sessionId) {
				blockedSessionId = sessionId;
				blocked = undefined;
				state = undefined;
				markerAppended = false;
				clearProblem();
			}
			const path = storePath();
			if (!sessionId || !path) return false;
			const read = readCanonicalStore(path, io);
			if (read.status === "ok") {
				if (read.state.sessionId !== sessionId) {
					blocked = "foreign";
					report("store-foreign", `The session store belongs to ${read.state.sessionId}, not ${sessionId}.`);
					return true;
				}
				state = read.state;
				blocked = undefined;
				clearProblem();
				for (const task of read.state.tasks) {
					if (typeof task.sessionId === "string" && task.sessionId && task.sessionId !== sessionId) continue;
					deps.applyTask(task);
				}
				deps.setNextTaskId(Math.max(read.state.nextTaskId, highestTaskNumber(read.state.tasks)));
				deps.restoreResults(read.state.results);
				markerAppended = deps.markerPresent(context);
				ensureMarker();
				return true;
			}
			if (read.status === "corrupt") {
				blocked = "corrupt";
				report(
					"store-corrupt",
					`The session store is corrupt (${read.reason}); background state is not restored. Inspect the file before continuing.`,
				);
				return true;
			}
			if (deps.markerPresent(context)) {
				report(
					"store-missing",
					"The session store is missing while its adoption marker exists; background state is not restored from history.",
				);
				state = undefined;
				markerAppended = true;
				return true;
			}
			return false;
		},
		adopt(candidate?: unknown): void {
			context = candidate ?? context;
			if (blocked) return;
			const sessionId = deps.sessionId();
			const path = storePath();
			if (!sessionId || !path) return;
			deps.prepareResults?.();
			try {
				const next = buildState(sessionId, now());
				commitCanonicalStore(path, next, io);
				state = next;
				clearProblem();
				deps.commitResults?.();
				ensureMarker();
			} catch (error) {
				report("store-migration", errorMessage(error));
			}
		},
		persist(mode: "force" | "progress" = "force"): CanonicalPersistResult {
			if (blocked) return { appendEntry: false, sidecar: false, appendReason: "error" };
			if (!deps.sessionId() || !storePath())
				return { appendEntry: false, sidecar: false, appendReason: "no-active-context" };
			deps.prepareResults?.();
			if (mode === "progress") {
				schedule();
				return { appendEntry: true, sidecar: false, appendReason: "coalesced" };
			}
			cancelScheduled();
			try {
				writeNow();
			} catch (error) {
				report("store-write", errorMessage(error));
				return { appendEntry: false, sidecar: false, appendReason: "error" };
			}
			return { appendEntry: true, sidecar: true, appendReason: "appended" };
		},
		flush(): void {
			cancelScheduled();
			if (blocked) return;
			if (!deps.sessionId() || !storePath()) return;
			deps.prepareResults?.();
			try {
				writeNow();
			} catch (error) {
				report("store-write", errorMessage(error));
			}
		},
		problem(): string | undefined {
			return blocked ?? lastProblem;
		},
	};
}
