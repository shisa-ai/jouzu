import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { JouzuPaths } from "./paths.js";
import { ensurePrivateDirectory, writeFilePrivateAtomic } from "./private-fs.js";
import { acquireStateLock, type StateLockInspection } from "./state-lock.js";

export const MODEL_PICKER_SCHEMA_VERSION = 2;
export const MODEL_PICKER_RECENT_LIMIT = 12;
export const MODEL_PICKER_HISTORY_LIMIT = 8;

export interface ModelReference {
	provider: string;
	modelId: string;
}

export type FavoriteScope = "global" | "project";

export interface FavoriteRecord extends ModelReference {
	scope: FavoriteScope;
	projectKey?: string;
	addedAt: string;
}

export interface RecentRecord extends ModelReference {
	lastUsedAt: string;
	useCount: number;
}

export interface ModelPickerState {
	schemaVersion: 2;
	favorites: FavoriteRecord[];
	defaults: {
		projects: Record<string, ModelReference>;
	};
	recents: {
		global: RecentRecord[];
		projects: Record<string, RecentRecord[]>;
	};
}

export interface ModelPickerStateLoadResult {
	state: ModelPickerState;
	warning?: string;
	quarantinePath?: string;
}

export class ModelPickerStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelPickerStateError";
	}
}

export function modelReferenceKey(reference: ModelReference): string {
	return `${reference.provider}\0${reference.modelId}`;
}

export function modelReferencesEqual(left: ModelReference | undefined, right: ModelReference | undefined): boolean {
	return (
		left !== undefined && right !== undefined && left.provider === right.provider && left.modelId === right.modelId
	);
}

export function emptyModelPickerState(): ModelPickerState {
	return {
		schemaVersion: MODEL_PICKER_SCHEMA_VERSION,
		favorites: [],
		defaults: { projects: {} },
		recents: { global: [], projects: {} },
	};
}

function containsControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
	});
}

function validIdentifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 512 && !containsControlCharacter(value);
}

function validTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function assertValidReference(reference: ModelReference): void {
	if (!validIdentifier(reference.provider) || !validIdentifier(reference.modelId)) {
		throw new ModelPickerStateError("model reference requires bounded provider and modelId strings");
	}
}

function parseReference(value: unknown): ModelReference {
	if (!value || typeof value !== "object") throw new ModelPickerStateError("model reference must be an object");
	const record = value as { provider?: unknown; modelId?: unknown };
	if (!validIdentifier(record.provider) || !validIdentifier(record.modelId)) {
		throw new ModelPickerStateError("model reference requires bounded provider and modelId strings");
	}
	return { provider: record.provider, modelId: record.modelId };
}

function parseRecent(value: unknown): RecentRecord {
	const reference = parseReference(value);
	const record = value as { lastUsedAt?: unknown; useCount?: unknown };
	if (!validTimestamp(record.lastUsedAt) || !Number.isInteger(record.useCount) || Number(record.useCount) < 1) {
		throw new ModelPickerStateError("recent record has invalid timestamp or use count");
	}
	return { ...reference, lastUsedAt: record.lastUsedAt, useCount: Number(record.useCount) };
}

function parseState(value: unknown): ModelPickerState {
	if (!value || typeof value !== "object") throw new ModelPickerStateError("state must be an object");
	const record = value as {
		schemaVersion?: unknown;
		favorites?: unknown;
		defaults?: { projects?: unknown };
		recents?: { global?: unknown; projects?: unknown };
	};
	if (record.schemaVersion !== 1 && record.schemaVersion !== MODEL_PICKER_SCHEMA_VERSION) {
		throw new ModelPickerStateError(`unsupported model picker state schema: ${String(record.schemaVersion)}`);
	}
	if (!Array.isArray(record.favorites)) throw new ModelPickerStateError("favorites must be an array");
	if (!record.recents || typeof record.recents !== "object" || !Array.isArray(record.recents.global)) {
		throw new ModelPickerStateError("recents must contain a global array");
	}
	if (
		!record.recents.projects ||
		typeof record.recents.projects !== "object" ||
		Array.isArray(record.recents.projects)
	) {
		throw new ModelPickerStateError("project recents must be an object");
	}

	const favorites = record.favorites.map((value): FavoriteRecord => {
		const reference = parseReference(value);
		const favorite = value as { scope?: unknown; projectKey?: unknown; addedAt?: unknown };
		if (favorite.scope !== "global" && favorite.scope !== "project") {
			throw new ModelPickerStateError("favorite scope must be global or project");
		}
		if (!validTimestamp(favorite.addedAt)) throw new ModelPickerStateError("favorite timestamp is invalid");
		if (favorite.scope === "project" && !validIdentifier(favorite.projectKey)) {
			throw new ModelPickerStateError("project favorite requires a project key");
		}
		return {
			...reference,
			scope: favorite.scope,
			...(favorite.scope === "project" ? { projectKey: favorite.projectKey as string } : {}),
			addedAt: favorite.addedAt,
		};
	});

	const defaults: Record<string, ModelReference> = {};
	if (record.defaults !== undefined) {
		if (
			!record.defaults ||
			typeof record.defaults !== "object" ||
			!record.defaults.projects ||
			typeof record.defaults.projects !== "object" ||
			Array.isArray(record.defaults.projects)
		) {
			throw new ModelPickerStateError("defaults must contain a projects object");
		}
		for (const [projectKey, reference] of Object.entries(record.defaults.projects)) {
			if (!validIdentifier(projectKey)) throw new ModelPickerStateError("project default key is invalid");
			defaults[projectKey] = parseReference(reference);
		}
	}

	const projects: Record<string, RecentRecord[]> = {};
	for (const [projectKey, values] of Object.entries(record.recents.projects)) {
		if (!validIdentifier(projectKey) || !Array.isArray(values)) {
			throw new ModelPickerStateError("project recents contain an invalid key or value");
		}
		projects[projectKey] = values.map(parseRecent).slice(0, MODEL_PICKER_RECENT_LIMIT);
	}

	return {
		schemaVersion: MODEL_PICKER_SCHEMA_VERSION,
		favorites,
		defaults: { projects: defaults },
		recents: {
			global: record.recents.global.map(parseRecent).slice(0, MODEL_PICKER_RECENT_LIMIT),
			projects,
		},
	};
}

function statePath(paths: JouzuPaths): string {
	return join(paths.stateDir, "model-picker.json");
}

function lockPath(paths: JouzuPaths): string {
	return join(paths.stateDir, "model-picker.lock");
}

function quarantineSuffix(now: Date): string {
	return now.toISOString().replace(/[^0-9]/g, "");
}

export function loadModelPickerState(
	paths: JouzuPaths,
	options: { recover?: boolean; now?: Date } = {},
): ModelPickerStateLoadResult {
	const path = statePath(paths);
	if (!existsSync(path)) return { state: emptyModelPickerState() };
	try {
		const metadata = lstatSync(path);
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			throw new ModelPickerStateError(`model picker state must be a regular file: ${path}`);
		}
		return { state: parseState(JSON.parse(readFileSync(path, "utf8"))) };
	} catch (error) {
		if (error instanceof ModelPickerStateError && /regular file/.test(error.message)) throw error;
		const message = error instanceof Error ? error.message : String(error);
		if (options.recover === false) throw new ModelPickerStateError(`model picker state is unreadable: ${message}`);
		ensurePrivateDirectory(paths.stateDir);
		const quarantinePath = join(
			paths.stateDir,
			`model-picker.corrupt-${quarantineSuffix(options.now ?? new Date())}.json`,
		);
		renameSync(path, quarantinePath);
		return {
			state: emptyModelPickerState(),
			warning: `Unreadable model picker state was preserved at ${quarantinePath}`,
			quarantinePath,
		};
	}
}

function updateRecent(records: RecentRecord[], reference: ModelReference, now: Date): RecentRecord[] {
	const existing = records.find((record) => modelReferencesEqual(record, reference));
	return [
		{ ...reference, lastUsedAt: now.toISOString(), useCount: (existing?.useCount ?? 0) + 1 },
		...records.filter((record) => !modelReferencesEqual(record, reference)),
	].slice(0, MODEL_PICKER_RECENT_LIMIT);
}

export class ModelPickerStore {
	private readonly paths: JouzuPaths;

	constructor(paths: JouzuPaths) {
		this.paths = paths;
	}

	load(options: { recover?: boolean; now?: Date } = {}): ModelPickerStateLoadResult {
		return loadModelPickerState(this.paths, options);
	}

	private mutate(mutator: (state: ModelPickerState) => void, now: Date): ModelPickerState {
		const release = acquireStateLock({
			path: lockPath(this.paths),
			describe: "model picker state",
			now,
			onBusy: (inspection: StateLockInspection) =>
				new ModelPickerStateError(`model picker state is busy (${inspection.status})`),
		});
		try {
			const state = this.load({ now }).state;
			mutator(state);
			writeFilePrivateAtomic(statePath(this.paths), `${JSON.stringify(state, null, 2)}\n`, this.paths.stateDir);
			return state;
		} finally {
			release();
		}
	}

	setProjectDefault(reference: ModelReference, projectKey: string, now: Date = new Date()): ModelPickerState {
		assertValidReference(reference);
		if (!validIdentifier(projectKey)) throw new ModelPickerStateError("project key is invalid");
		return this.mutate((state) => {
			state.defaults.projects[projectKey] = { ...reference };
		}, now);
	}

	recordDispatch(reference: ModelReference, projectKey: string, now: Date = new Date()): ModelPickerState {
		assertValidReference(reference);
		if (!validIdentifier(projectKey)) throw new ModelPickerStateError("project key is invalid");
		return this.mutate((state) => {
			state.recents.global = updateRecent(state.recents.global, reference, now);
			state.recents.projects[projectKey] = updateRecent(state.recents.projects[projectKey] ?? [], reference, now);
		}, now);
	}

	toggleFavorite(
		reference: ModelReference,
		scope: FavoriteScope,
		projectKey?: string,
		now: Date = new Date(),
	): ModelPickerState {
		assertValidReference(reference);
		if (scope === "project" && !validIdentifier(projectKey)) {
			throw new ModelPickerStateError("project favorite requires a project key");
		}
		return this.mutate((state) => {
			const matchesScope = (favorite: FavoriteRecord): boolean =>
				favorite.scope === scope && (scope === "global" || favorite.projectKey === projectKey);
			const existing = state.favorites.find(
				(favorite) => matchesScope(favorite) && modelReferencesEqual(favorite, reference),
			);
			if (existing) {
				state.favorites = state.favorites.filter((favorite) => favorite !== existing);
				return;
			}
			state.favorites.push({
				...reference,
				scope,
				...(scope === "project" ? { projectKey } : {}),
				addedAt: now.toISOString(),
			});
		}, now);
	}

	clearRecents(scope: "global" | "project" | "all", projectKey?: string, now: Date = new Date()): ModelPickerState {
		return this.mutate((state) => {
			if (scope === "global" || scope === "all") state.recents.global = [];
			if (scope === "all") state.recents.projects = {};
			if (scope === "project" && projectKey) delete state.recents.projects[projectKey];
		}, now);
	}
}

function hashProjectIdentity(kind: "git" | "cwd", value: string): string {
	return createHash("sha256").update(`jouzu-project-v1\0${kind}\0${value}`).digest("hex");
}

export function deriveProjectKey(
	cwd: string,
	options: {
		runGit?: (cwd: string) => string | undefined;
		realpath?: (path: string) => string;
	} = {},
): string {
	const runGit =
		options.runGit ??
		((directory: string): string | undefined => {
			const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
				cwd: directory,
				encoding: "utf8",
				timeout: 2_000,
			});
			return result.status === 0 ? result.stdout.trim() || undefined : undefined;
		});
	const resolveRealpath = options.realpath ?? ((path: string) => realpathSync.native(path));
	const gitCommonDir = runGit(cwd);
	if (gitCommonDir) {
		const absolute = isAbsolute(gitCommonDir) ? gitCommonDir : resolve(cwd, gitCommonDir);
		return hashProjectIdentity("git", resolveRealpath(absolute));
	}
	return hashProjectIdentity("cwd", resolveRealpath(cwd));
}

const PROJECT_DEFAULT_BYPASS_FLAGS = new Set(["--continue", "-c", "--resume", "-r", "--session", "--session-id"]);

export function projectDefaultAppliesAtStartup(args: readonly string[]): boolean {
	for (const argument of args) {
		if (
			argument === "--model" ||
			argument.startsWith("--model=") ||
			argument === "--models" ||
			argument.startsWith("--models=") ||
			argument === "--provider" ||
			argument.startsWith("--provider=") ||
			PROJECT_DEFAULT_BYPASS_FLAGS.has(argument) ||
			argument.startsWith("--session=") ||
			argument.startsWith("--session-id=")
		) {
			return false;
		}
	}
	return true;
}

export function previousModelStack(
	entries: readonly unknown[],
	current: ModelReference | undefined,
	limit: number = MODEL_PICKER_HISTORY_LIMIT,
): ModelReference[] {
	const sequence: ModelReference[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const value = entry as {
			type?: unknown;
			provider?: unknown;
			modelId?: unknown;
			message?: { role?: unknown; provider?: unknown; model?: unknown };
		};
		let reference: ModelReference | undefined;
		if (value.type === "model_change" && validIdentifier(value.provider) && validIdentifier(value.modelId)) {
			reference = { provider: value.provider, modelId: value.modelId };
		} else if (
			value.type === "message" &&
			value.message?.role === "assistant" &&
			validIdentifier(value.message.provider) &&
			validIdentifier(value.message.model)
		) {
			reference = { provider: value.message.provider, modelId: value.message.model };
		}
		if (reference && !modelReferencesEqual(sequence.at(-1), reference)) sequence.push(reference);
	}
	if (modelReferencesEqual(sequence.at(-1), current)) sequence.pop();
	const seen = new Set<string>();
	const result: ModelReference[] = [];
	for (const reference of sequence.reverse()) {
		const key = modelReferenceKey(reference);
		if (seen.has(key) || modelReferencesEqual(reference, current)) continue;
		seen.add(key);
		result.push(reference);
		if (result.length >= Math.max(0, limit)) break;
	}
	return result;
}
