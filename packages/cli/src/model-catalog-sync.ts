import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
	catalogDocumentSha256,
	MODEL_CATALOG_MAX_BYTES,
	MODEL_CATALOG_MEDIA_TYPE,
	type ModelCatalogDocument,
	ModelCatalogError,
	parseAndValidateModelCatalog,
} from "./model-catalog.js";
import type { JouzuPaths } from "./paths.js";
import { ensurePrivateDirectory, writeFilePrivateAtomic } from "./private-fs.js";
import { acquireStateLock, type StateLockInspection } from "./state-lock.js";

const CATALOG_URL_ENV = "JOUZU_MODEL_CATALOG_URL";
const CATALOG_TOKEN_ENV = "JOUZU_MODEL_CATALOG_TOKEN";
const CATALOG_CONNECT_TIMEOUT_MS = 5_000;
const CATALOG_TOTAL_TIMEOUT_MS = 30_000;
const QUARANTINE_LIMIT = 3;
const QUARANTINE_BYTE_LIMIT = 48 * 1024 * 1024;

export interface CatalogEndpointConfig {
	url: string;
	token?: string;
}

interface CatalogRevisionRef {
	digest: string;
	revision: string;
	sequence: string;
	generatedAt: string;
	document: string;
	activatedAt: string;
}

interface CatalogQuarantineRef {
	digest: string;
	revision: string;
	sequence: string;
	document: string;
	reasons: string[];
	receivedAt: string;
	bytes: number;
}

interface CatalogAccountState {
	schemaVersion: 1;
	catalogId: string;
	accountRefHash: string;
	active?: CatalogRevisionRef;
	previous?: CatalogRevisionRef;
	etag?: string;
	validatedAt?: string;
	lastError?: { code: string; message: string; at: string };
	quarantined: CatalogQuarantineRef[];
}

interface CatalogOriginState {
	schemaVersion: 1;
	activeAccountRefHash?: string;
}

export type CatalogSyncStatus =
	| {
			schemaVersion: 1;
			status: "unconfigured";
			configured: false;
			message: string;
	  }
	| {
			schemaVersion: 1;
			status: "empty" | "active" | "stale";
			configured: true;
			endpoint: string;
			catalogId?: string;
			revision?: string;
			sequence?: string;
			validatedAt?: string;
			lastError?: { code: string; message: string; at: string };
			quarantined: number;
	  };

export type CatalogRefreshResult =
	| { status: "unconfigured"; catalogStatus: CatalogSyncStatus }
	| { status: "not-modified"; catalogStatus: CatalogSyncStatus }
	| { status: "activated"; catalogStatus: CatalogSyncStatus }
	| { status: "quarantined"; catalogStatus: CatalogSyncStatus; revision: string; digest: string; reasons: string[] }
	| { status: "rejected" | "error"; catalogStatus: CatalogSyncStatus; code: string; message: string };

export class CatalogSyncError extends Error {
	readonly exitCode = 1;

	constructor(message: string) {
		super(message);
		this.name = "CatalogSyncError";
	}
}

function nonEmpty(value: string | undefined): string | undefined {
	return value && value.trim().length > 0 ? value.trim() : undefined;
}

export function resolveCatalogEndpoint(env: NodeJS.ProcessEnv = process.env): CatalogEndpointConfig | undefined {
	const rawUrl = nonEmpty(env[CATALOG_URL_ENV]);
	if (!rawUrl) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new CatalogSyncError(`${CATALOG_URL_ENV} must be an absolute HTTP(S) URL`);
	}
	if (parsed.username || parsed.password || parsed.hash) {
		throw new CatalogSyncError(`${CATALOG_URL_ENV} must not contain credentials or a fragment`);
	}
	const localHttp = parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
	if (parsed.protocol !== "https:" && !localHttp) {
		throw new CatalogSyncError(`${CATALOG_URL_ENV} must use HTTPS except for localhost development`);
	}
	return { url: parsed.href, ...(nonEmpty(env[CATALOG_TOKEN_ENV]) ? { token: nonEmpty(env[CATALOG_TOKEN_ENV]) } : {}) };
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function catalogRoot(paths: JouzuPaths): string {
	return join(paths.cacheDir, "model-catalog");
}

function originRoot(paths: JouzuPaths, endpoint: string): string {
	return join(catalogRoot(paths), hash(endpoint));
}

function originStatePath(paths: JouzuPaths, endpoint: string): string {
	return join(originRoot(paths, endpoint), "origin.json");
}

function accountRoot(paths: JouzuPaths, endpoint: string, accountRefHash: string): string {
	return join(originRoot(paths, endpoint), "accounts", accountRefHash);
}

function accountStatePath(paths: JouzuPaths, endpoint: string, accountRefHash: string): string {
	return join(accountRoot(paths, endpoint, accountRefHash), "state.json");
}

function lockPath(paths: JouzuPaths, endpoint: string): string {
	return join(originRoot(paths, endpoint), "refresh.lock");
}

function safeRelative(root: string, path: string): string {
	const value = relative(resolve(root), resolve(path));
	if (!value || value === ".." || value.startsWith(`..${sep}`))
		throw new CatalogSyncError("catalog cache path escaped");
	return value;
}

function resolveRelative(root: string, value: string): string {
	const path = resolve(root, value);
	safeRelative(root, path);
	return path;
}

function readRegularJson(path: string): unknown | undefined {
	if (!existsSync(path)) return undefined;
	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) {
		throw new CatalogSyncError(`catalog state must be a bounded regular file: ${path}`);
	}
	return JSON.parse(readFileSync(path, "utf8"));
}

function parseOriginState(value: unknown): CatalogOriginState | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new CatalogSyncError("catalog origin state is invalid");
	const record = value as Partial<CatalogOriginState>;
	if (
		record.schemaVersion !== 1 ||
		(record.activeAccountRefHash !== undefined && !/^[0-9a-f]{64}$/u.test(record.activeAccountRefHash))
	) {
		throw new CatalogSyncError("catalog origin state is invalid");
	}
	return {
		schemaVersion: 1,
		...(record.activeAccountRefHash ? { activeAccountRefHash: record.activeAccountRefHash } : {}),
	};
}

function validRevisionRef(value: unknown): value is CatalogRevisionRef {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Partial<CatalogRevisionRef>;
	return (
		typeof record.digest === "string" &&
		/^[0-9a-f]{64}$/u.test(record.digest) &&
		typeof record.revision === "string" &&
		typeof record.sequence === "string" &&
		typeof record.generatedAt === "string" &&
		typeof record.document === "string" &&
		typeof record.activatedAt === "string"
	);
}

function validQuarantineRef(value: unknown): value is CatalogQuarantineRef {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Partial<CatalogQuarantineRef>;
	return (
		typeof record.digest === "string" &&
		/^[0-9a-f]{64}$/u.test(record.digest) &&
		typeof record.revision === "string" &&
		typeof record.sequence === "string" &&
		typeof record.document === "string" &&
		Array.isArray(record.reasons) &&
		record.reasons.every((reason) => typeof reason === "string") &&
		typeof record.receivedAt === "string" &&
		Number.isInteger(record.bytes) &&
		Number(record.bytes) >= 0
	);
}

function parseAccountState(value: unknown): CatalogAccountState | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new CatalogSyncError("catalog account state is invalid");
	const record = value as Partial<CatalogAccountState>;
	if (
		record.schemaVersion !== 1 ||
		typeof record.catalogId !== "string" ||
		!record.catalogId ||
		typeof record.accountRefHash !== "string" ||
		!/^[0-9a-f]{64}$/u.test(record.accountRefHash) ||
		(record.active !== undefined && !validRevisionRef(record.active)) ||
		(record.previous !== undefined && !validRevisionRef(record.previous)) ||
		!Array.isArray(record.quarantined) ||
		!record.quarantined.every(validQuarantineRef)
	) {
		throw new CatalogSyncError("catalog account state is invalid");
	}
	return record as CatalogAccountState;
}

function readOriginState(paths: JouzuPaths, endpoint: string): CatalogOriginState | undefined {
	return parseOriginState(readRegularJson(originStatePath(paths, endpoint)));
}

function readAccountState(
	paths: JouzuPaths,
	endpoint: string,
	accountRefHash: string,
): CatalogAccountState | undefined {
	return parseAccountState(readRegularJson(accountStatePath(paths, endpoint, accountRefHash)));
}

function writeJson(path: string, value: unknown, root: string): void {
	writeFilePrivateAtomic(path, `${JSON.stringify(value, null, 2)}\n`, root);
}

function publicEndpoint(endpoint: string): string {
	const parsed = new URL(endpoint);
	return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

export function getCatalogStatus(
	paths: JouzuPaths,
	env: NodeJS.ProcessEnv = process.env,
	now = new Date(),
): CatalogSyncStatus {
	const config = resolveCatalogEndpoint(env);
	if (!config) {
		return {
			schemaVersion: 1,
			status: "unconfigured",
			configured: false,
			message: "No model catalog endpoint is configured. Jouzu continues using Pi and local model configuration.",
		};
	}
	try {
		const origin = readOriginState(paths, config.url);
		const account = origin?.activeAccountRefHash
			? readAccountState(paths, config.url, origin.activeAccountRefHash)
			: undefined;
		return {
			schemaVersion: 1,
			status: account?.active ? (account.lastError ? "stale" : "active") : "empty",
			configured: true,
			endpoint: publicEndpoint(config.url),
			...(account?.catalogId ? { catalogId: account.catalogId } : {}),
			...(account?.active ? { revision: account.active.revision, sequence: account.active.sequence } : {}),
			...(account?.validatedAt ? { validatedAt: account.validatedAt } : {}),
			...(account?.lastError ? { lastError: account.lastError } : {}),
			quarantined: account?.quarantined.length ?? 0,
		};
	} catch (error) {
		return {
			schemaVersion: 1,
			status: "stale",
			configured: true,
			endpoint: publicEndpoint(config.url),
			lastError: {
				code: "invalid_cache",
				message: error instanceof Error ? error.message : String(error),
				at: now.toISOString(),
			},
			quarantined: 0,
		};
	}
}

function loadDocument(accountDirectory: string, reference: CatalogRevisionRef): ModelCatalogDocument {
	const path = resolveRelative(accountDirectory, reference.document);
	const text = readFileSync(path, "utf8");
	if (catalogDocumentSha256(text) !== reference.digest) throw new CatalogSyncError("cached catalog digest mismatch");
	return parseAndValidateModelCatalog(text, { remote: true });
}

function removedOfferingReasons(previous: ModelCatalogDocument | undefined, candidate: ModelCatalogDocument): string[] {
	if (!previous || !candidate.scope.complete || !candidate.scope.includes.includes("modelOfferings")) return [];
	const nextIds = new Set(candidate.modelOfferings.map((offering) => offering.id));
	const removed = previous.modelOfferings.filter((offering) => !nextIds.has(offering.id)).length;
	if (removed >= 10 && removed / Math.max(previous.modelOfferings.length, 1) > 0.2) return ["mass_removal"];
	const additions = candidate.modelOfferings.filter(
		(offering) => !previous.modelOfferings.some((oldOffering) => oldOffering.id === offering.id),
	).length;
	if (additions >= 50 && additions / Math.max(previous.modelOfferings.length, 1) > 0.5) return ["mass_addition"];
	return [];
}

function trimQuarantine(entries: CatalogQuarantineRef[], accountDirectory: string): CatalogQuarantineRef[] {
	const sorted = [...entries].sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt));
	const retained: CatalogQuarantineRef[] = [];
	const removed: CatalogQuarantineRef[] = [];
	let bytes = 0;
	for (const entry of sorted) {
		const path = resolveRelative(accountDirectory, entry.document);
		if (!existsSync(path)) continue;
		if (retained.length >= QUARANTINE_LIMIT || bytes + entry.bytes > QUARANTINE_BYTE_LIMIT) {
			removed.push(entry);
			continue;
		}
		retained.push(entry);
		bytes += entry.bytes;
	}
	for (const entry of removed) rmSync(resolveRelative(accountDirectory, entry.document), { force: true });
	return retained;
}

async function readBoundedBody(response: Response): Promise<string> {
	const contentLength = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(contentLength) && contentLength > MODEL_CATALOG_MAX_BYTES) {
		throw new CatalogSyncError("catalog response exceeds 16 MiB");
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > MODEL_CATALOG_MAX_BYTES) throw new CatalogSyncError("catalog response exceeds 16 MiB");
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function errorCode(error: unknown): string {
	if (error instanceof ModelCatalogError) return error.code;
	if (error instanceof CatalogSyncError) return "catalog_sync_error";
	if (error instanceof Error && error.name === "AbortError") return "timeout";
	return "network_error";
}

function recordError(
	paths: JouzuPaths,
	config: CatalogEndpointConfig,
	origin: CatalogOriginState | undefined,
	code: string,
	message: string,
	now: Date,
): void {
	if (!origin?.activeAccountRefHash) return;
	const state = readAccountState(paths, config.url, origin.activeAccountRefHash);
	if (!state) return;
	state.lastError = { code, message, at: now.toISOString() };
	writeJson(accountStatePath(paths, config.url, origin.activeAccountRefHash), state, catalogRoot(paths));
}

export interface RefreshCatalogOptions {
	env?: NodeJS.ProcessEnv;
	fetch?: typeof globalThis.fetch;
	now?: Date;
}

export async function refreshModelCatalog(
	paths: JouzuPaths,
	options: RefreshCatalogOptions = {},
): Promise<CatalogRefreshResult> {
	const env = options.env ?? process.env;
	const config = resolveCatalogEndpoint(env);
	if (!config) return { status: "unconfigured", catalogStatus: getCatalogStatus(paths, env) };
	const now = options.now ?? new Date();
	const release = acquireStateLock({
		path: lockPath(paths, config.url),
		describe: "model catalog refresh",
		now,
		onBusy: (inspection: StateLockInspection) =>
			new CatalogSyncError(`model catalog refresh is busy (${inspection.status})`),
	});
	let origin = readOriginState(paths, config.url);
	try {
		const activeState = origin?.activeAccountRefHash
			? readAccountState(paths, config.url, origin.activeAccountRefHash)
			: undefined;
		const headers = new Headers({ Accept: MODEL_CATALOG_MEDIA_TYPE });
		if (config.token) headers.set("Authorization", `Bearer ${config.token}`);
		if (activeState?.etag) headers.set("If-None-Match", activeState.etag);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), CATALOG_TOTAL_TIMEOUT_MS);
		let response: Response;
		try {
			response = await (options.fetch ?? globalThis.fetch)(config.url, {
				method: "GET",
				headers,
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timeout);
		}
		if (response.status === 304) {
			if (!activeState || !origin?.activeAccountRefHash)
				throw new CatalogSyncError("received 304 without an active cached catalog");
			activeState.validatedAt = now.toISOString();
			activeState.lastError = undefined;
			const etag = response.headers.get("etag");
			if (etag) activeState.etag = etag;
			writeJson(accountStatePath(paths, config.url, origin.activeAccountRefHash), activeState, catalogRoot(paths));
			return { status: "not-modified", catalogStatus: getCatalogStatus(paths, env, now) };
		}
		if (!response.ok) throw new CatalogSyncError(`catalog endpoint returned HTTP ${response.status}`);
		const mediaType = response.headers.get("content-type") ?? "";
		if (!mediaType.toLowerCase().startsWith(MODEL_CATALOG_MEDIA_TYPE)) {
			throw new CatalogSyncError(`catalog endpoint returned unsupported Content-Type: ${mediaType || "missing"}`);
		}
		const text = await readBoundedBody(response);
		const document = parseAndValidateModelCatalog(text, { remote: true });
		if (!document.scope.accountRef || !document.sequence)
			throw new CatalogSyncError("remote account catalog is incomplete");
		const accountRefHash = hash(`${document.catalogId}\0${document.scope.accountRef}`);
		const directory = accountRoot(paths, config.url, accountRefHash);
		ensurePrivateDirectory(catalogRoot(paths), directory);
		let state = readAccountState(paths, config.url, accountRefHash);
		if (state && state.catalogId !== document.catalogId)
			throw new CatalogSyncError("catalog identity changed inside one account partition");
		state ??= { schemaVersion: 1, catalogId: document.catalogId, accountRefHash, quarantined: [] };
		if (state.active) {
			const next = BigInt(document.sequence);
			const active = BigInt(state.active.sequence);
			if (next < active) throw new CatalogSyncError("catalog sequence decreased");
			if (next === active && document.revision !== state.active.revision)
				throw new CatalogSyncError("catalog sequence was reused");
		}
		const digest = catalogDocumentSha256(text);
		if (state.active?.revision === document.revision && state.active.digest !== digest) {
			throw new CatalogSyncError("catalog revision content changed");
		}
		if (state.active?.digest === digest) {
			state.validatedAt = now.toISOString();
			state.lastError = undefined;
			const etag = response.headers.get("etag");
			if (etag) state.etag = etag;
			writeJson(accountStatePath(paths, config.url, accountRefHash), state, catalogRoot(paths));
			writeJson(
				originStatePath(paths, config.url),
				{ schemaVersion: 1, activeAccountRefHash: accountRefHash },
				catalogRoot(paths),
			);
			return { status: "not-modified", catalogStatus: getCatalogStatus(paths, env, now) };
		}

		const previous = state.active ? loadDocument(directory, state.active) : undefined;
		const reasons = removedOfferingReasons(previous, document);
		const candidatePath = join(directory, reasons.length > 0 ? "quarantine" : "documents", `${digest}.json`);
		writeFilePrivateAtomic(candidatePath, text, catalogRoot(paths));
		if (reasons.length > 0) {
			state.quarantined = trimQuarantine(
				[
					...state.quarantined.filter((entry) => entry.digest !== digest),
					{
						digest,
						revision: document.revision,
						sequence: document.sequence,
						document: safeRelative(directory, candidatePath),
						reasons,
						receivedAt: now.toISOString(),
						bytes: Buffer.byteLength(text),
					},
				],
				directory,
			);
			state.lastError = { code: "quarantined", message: reasons.join(", "), at: now.toISOString() };
			writeJson(accountStatePath(paths, config.url, accountRefHash), state, catalogRoot(paths));
			writeJson(
				originStatePath(paths, config.url),
				{ schemaVersion: 1, activeAccountRefHash: accountRefHash },
				catalogRoot(paths),
			);
			return {
				status: "quarantined",
				catalogStatus: getCatalogStatus(paths, env, now),
				revision: document.revision,
				digest,
				reasons,
			};
		}
		const activated: CatalogRevisionRef = {
			digest,
			revision: document.revision,
			sequence: document.sequence,
			generatedAt: document.generatedAt,
			document: safeRelative(directory, candidatePath),
			activatedAt: now.toISOString(),
		};
		state.previous = state.active;
		state.active = activated;
		state.validatedAt = now.toISOString();
		state.lastError = undefined;
		const etag = response.headers.get("etag");
		if (etag) state.etag = etag;
		writeJson(accountStatePath(paths, config.url, accountRefHash), state, catalogRoot(paths));
		origin = { schemaVersion: 1, activeAccountRefHash: accountRefHash };
		writeJson(originStatePath(paths, config.url), origin, catalogRoot(paths));
		return { status: "activated", catalogStatus: getCatalogStatus(paths, env, now) };
	} catch (error) {
		const code = errorCode(error);
		const message = error instanceof Error ? error.message : String(error);
		recordError(paths, config, origin, code, message, now);
		return {
			status: error instanceof ModelCatalogError || error instanceof CatalogSyncError ? "rejected" : "error",
			catalogStatus: getCatalogStatus(paths, env, now),
			code,
			message,
		};
	} finally {
		release();
	}
}

export function loadActiveModelCatalog(
	paths: JouzuPaths,
	env: NodeJS.ProcessEnv = process.env,
): ModelCatalogDocument | undefined {
	const config = resolveCatalogEndpoint(env);
	if (!config) return undefined;
	const origin = readOriginState(paths, config.url);
	if (!origin?.activeAccountRefHash) return undefined;
	const state = readAccountState(paths, config.url, origin.activeAccountRefHash);
	if (!state?.active) return undefined;
	return loadDocument(accountRoot(paths, config.url, origin.activeAccountRefHash), state.active);
}

export function acceptQuarantinedCatalog(
	paths: JouzuPaths,
	revision: string,
	digest: string,
	env: NodeJS.ProcessEnv = process.env,
	now = new Date(),
): CatalogSyncStatus {
	const config = resolveCatalogEndpoint(env);
	if (!config) return getCatalogStatus(paths, env, now);
	const release = acquireStateLock({
		path: lockPath(paths, config.url),
		describe: "model catalog acceptance",
		now,
		onBusy: (inspection) => new CatalogSyncError(`model catalog operation is busy (${inspection.status})`),
	});
	try {
		const origin = readOriginState(paths, config.url);
		if (!origin?.activeAccountRefHash) throw new CatalogSyncError("no catalog account is active");
		const directory = accountRoot(paths, config.url, origin.activeAccountRefHash);
		const state = readAccountState(paths, config.url, origin.activeAccountRefHash);
		if (!state) throw new CatalogSyncError("catalog account state is missing");
		const candidate = state.quarantined.find((entry) => entry.revision === revision && entry.digest === digest);
		if (!candidate) throw new CatalogSyncError("the exact quarantined catalog candidate was not found");
		const sourcePath = resolveRelative(directory, candidate.document);
		const text = readFileSync(sourcePath, "utf8");
		if (catalogDocumentSha256(text) !== digest) throw new CatalogSyncError("quarantined catalog digest mismatch");
		const document = parseAndValidateModelCatalog(text, { remote: true });
		const activePath = join(directory, "documents", `${digest}.json`);
		writeFilePrivateAtomic(activePath, text, catalogRoot(paths));
		if (resolve(sourcePath) !== resolve(activePath)) rmSync(sourcePath, { force: true });
		state.previous = state.active;
		state.active = {
			digest,
			revision: document.revision,
			sequence: document.sequence as string,
			generatedAt: document.generatedAt,
			document: safeRelative(directory, activePath),
			activatedAt: now.toISOString(),
		};
		state.quarantined = state.quarantined.filter((entry) => entry !== candidate);
		state.lastError = undefined;
		state.validatedAt = now.toISOString();
		writeJson(accountStatePath(paths, config.url, origin.activeAccountRefHash), state, catalogRoot(paths));
		return getCatalogStatus(paths, env, now);
	} finally {
		release();
	}
}

export const catalogSyncDefaults = {
	connectTimeoutMs: CATALOG_CONNECT_TIMEOUT_MS,
	totalTimeoutMs: CATALOG_TOTAL_TIMEOUT_MS,
};
