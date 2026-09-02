import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
	type CatalogSource,
	catalogSourceConflict,
	catalogSourceCredentialAvailable,
	catalogSourceCredentialName,
	isBuiltinCatalogSource,
	isCodeOwnedCatalogSource,
	resolveCatalogBearer,
	resolveCatalogSources,
} from "./catalog-sources.js";
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
			sourceId: string;
			label: string;
			enabled: boolean;
			endpoint: string;
			catalogId?: string;
			revision?: string;
			sequence?: string;
			validatedAt?: string;
			offeringCount?: number;
			lastError?: { code: string; message: string; at: string };
			credentialName?: string;
			credentialAvailable?: boolean;
			conflict?: string;
			quarantined: number;
	  };

export interface CatalogStatuses {
	schemaVersion: 1;
	status: "unconfigured" | "empty" | "active" | "degraded";
	configured: number;
	active: number;
	sources: CatalogSyncStatus[];
}

export type CatalogRefreshResult =
	| { status: "unconfigured"; catalogStatus: CatalogSyncStatus }
	| { status: "not-modified"; catalogStatus: CatalogSyncStatus }
	| { status: "activated"; catalogStatus: CatalogSyncStatus }
	| { status: "quarantined"; catalogStatus: CatalogSyncStatus; revision: string; digest: string; reasons: string[] }
	| { status: "rejected" | "error"; catalogStatus: CatalogSyncStatus; code: string; message: string };

export interface CatalogSourceRefreshResult {
	source: CatalogSource;
	result: CatalogRefreshResult;
}

export interface CatalogRefreshAllResult {
	status: "unconfigured" | "complete" | "partial" | "failed";
	results: CatalogSourceRefreshResult[];
}

export interface ActiveModelCatalog {
	source: CatalogSource;
	document: ModelCatalogDocument;
}

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

function unconfiguredStatus(): CatalogSyncStatus {
	return {
		schemaVersion: 1,
		status: "unconfigured",
		configured: false,
		message: "No model catalog endpoint is configured. Jouzu continues using Pi and local model configuration.",
	};
}

export function getCatalogSourceStatus(
	paths: JouzuPaths,
	source: CatalogSource,
	now = new Date(),
	env: NodeJS.ProcessEnv = process.env,
): CatalogSyncStatus {
	const credentialName = catalogSourceCredentialName(source);
	const credentialAvailable = credentialName ? catalogSourceCredentialAvailable(source, env) : undefined;
	const conflict = catalogSourceConflict(source);
	try {
		const origin = readOriginState(paths, source.url);
		const account = origin?.activeAccountRefHash
			? readAccountState(paths, source.url, origin.activeAccountRefHash)
			: undefined;
		let offeringCount: number | undefined;
		if (account?.active && origin?.activeAccountRefHash) {
			offeringCount = loadDocument(accountRoot(paths, source.url, origin.activeAccountRefHash), account.active)
				.modelOfferings.length;
		}
		return {
			schemaVersion: 1,
			status: account?.active ? (account.lastError ? "stale" : "active") : "empty",
			configured: true,
			sourceId: source.id,
			label: source.label,
			enabled: source.enabled,
			endpoint: publicEndpoint(source.url),
			...(account?.catalogId ? { catalogId: account.catalogId } : {}),
			...(account?.active ? { revision: account.active.revision, sequence: account.active.sequence } : {}),
			...(account?.validatedAt ? { validatedAt: account.validatedAt } : {}),
			...(offeringCount !== undefined ? { offeringCount } : {}),
			...(account?.lastError ? { lastError: account.lastError } : {}),
			...(credentialName ? { credentialName, credentialAvailable } : {}),
			...(conflict ? { conflict } : {}),
			quarantined: account?.quarantined.length ?? 0,
		};
	} catch (error) {
		return {
			schemaVersion: 1,
			status: "stale",
			configured: true,
			sourceId: source.id,
			label: source.label,
			enabled: source.enabled,
			endpoint: publicEndpoint(source.url),
			...(credentialName ? { credentialName, credentialAvailable } : {}),
			...(conflict ? { conflict } : {}),
			lastError: {
				code: "invalid_cache",
				message: error instanceof Error ? error.message : String(error),
				at: now.toISOString(),
			},
			quarantined: 0,
		};
	}
}

export function getCatalogStatuses(
	paths: JouzuPaths,
	env: NodeJS.ProcessEnv = process.env,
	now = new Date(),
): CatalogStatuses {
	const sources = resolveCatalogSources(paths, env, { includeDisabled: true });
	if (sources.length === 0) return { schemaVersion: 1, status: "unconfigured", configured: 0, active: 0, sources: [] };
	const statuses = sources.map((source) => getCatalogSourceStatus(paths, source, now, env));
	const enabled = statuses.filter((status) => status.configured && status.enabled);
	const active = enabled.filter((status) => status.status === "active").length;
	const degraded = enabled.some((status) => status.status === "stale");
	return {
		schemaVersion: 1,
		status: degraded ? "degraded" : active > 0 ? "active" : "empty",
		configured: sources.length,
		active,
		sources: statuses,
	};
}

export function getCatalogStatus(
	paths: JouzuPaths,
	env: NodeJS.ProcessEnv = process.env,
	now = new Date(),
): CatalogSyncStatus {
	const source = resolveCatalogSources(paths, env)[0];
	return source ? getCatalogSourceStatus(paths, source, now, env) : unconfiguredStatus();
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
	if (!response.body) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let received = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			received += value.byteLength;
			if (received > MODEL_CATALOG_MAX_BYTES) {
				await reader.cancel("catalog response exceeds 16 MiB");
				throw new CatalogSyncError("catalog response exceeds 16 MiB");
			}
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} catch (error) {
		try {
			await reader.cancel(error);
		} catch {
			// Preserve the read/decode error.
		}
		throw error;
	} finally {
		reader.releaseLock();
	}
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
	sourceId?: string;
}

export async function refreshCatalogSource(
	paths: JouzuPaths,
	source: CatalogSource,
	options: RefreshCatalogOptions = {},
): Promise<CatalogRefreshResult> {
	const env = options.env ?? process.env;
	const now = options.now ?? new Date();
	const catalogStatus = () => getCatalogSourceStatus(paths, source, now, env);
	let token: string | undefined;
	try {
		token = resolveCatalogBearer(source, env);
	} catch (error) {
		return {
			status: "error",
			catalogStatus: catalogStatus(),
			code: "auth_required",
			message: error instanceof Error ? error.message : String(error),
		};
	}
	const config: CatalogEndpointConfig = { url: source.url, ...(token ? { token } : {}) };
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
				// Never follow a redirect with an Authorization header attached.
				redirect: "error",
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
			return { status: "not-modified", catalogStatus: catalogStatus() };
		}
		if (!response.ok) throw new CatalogSyncError(`catalog endpoint returned HTTP ${response.status}`);
		const mediaType = response.headers.get("content-type") ?? "";
		if (!mediaType.toLowerCase().startsWith(MODEL_CATALOG_MEDIA_TYPE)) {
			throw new CatalogSyncError(`catalog endpoint returned unsupported Content-Type: ${mediaType || "missing"}`);
		}
		const text = await readBoundedBody(response);
		const document = parseAndValidateModelCatalog(text, { remote: true });
		if (!document.sequence) throw new CatalogSyncError("remote catalog sequence is missing");
		if (document.scope.accountScoped && !document.scope.accountRef)
			throw new CatalogSyncError("remote account catalog is missing accountRef");
		const partitionRef = document.scope.accountScoped ? document.scope.accountRef : "public";
		const accountRefHash = hash(`${document.catalogId}\0${partitionRef}`);
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
			return { status: "not-modified", catalogStatus: catalogStatus() };
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
				catalogStatus: catalogStatus(),
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
		return { status: "activated", catalogStatus: catalogStatus() };
	} catch (error) {
		const code = errorCode(error);
		const message = error instanceof Error ? error.message : String(error);
		recordError(paths, config, origin, code, message, now);
		return {
			status: error instanceof ModelCatalogError || error instanceof CatalogSyncError ? "rejected" : "error",
			catalogStatus: catalogStatus(),
			code,
			message,
		};
	} finally {
		release();
	}
}

export async function refreshModelCatalog(
	paths: JouzuPaths,
	options: RefreshCatalogOptions = {},
): Promise<CatalogRefreshResult> {
	const env = options.env ?? process.env;
	const sources = resolveCatalogSources(paths, env);
	if (sources.length === 0) return { status: "unconfigured", catalogStatus: unconfiguredStatus() };
	const source = options.sourceId
		? sources.find((candidate) => candidate.id === options.sourceId)
		: sources.find((candidate) => !automaticallySkipped(paths, candidate, env));
	if (!source) {
		if (!options.sourceId) return { status: "unconfigured", catalogStatus: unconfiguredStatus() };
		return {
			status: "error",
			catalogStatus: unconfiguredStatus(),
			code: "source_not_found",
			message: `catalog source not found or disabled: ${options.sourceId}`,
		};
	}
	return refreshCatalogSource(paths, source, options);
}

/**
 * The code-owned built-in source with an absent credential is an expected
 * unconfigured state, not an error: bulk refresh skips it without a request.
 * Registry-backed sources keep their explicit auth_required error instead.
 */
function automaticallySkipped(paths: JouzuPaths, source: CatalogSource, env: NodeJS.ProcessEnv): boolean {
	return (
		isBuiltinCatalogSource(source) &&
		isCodeOwnedCatalogSource(paths, source, env) &&
		!catalogSourceCredentialAvailable(source, env)
	);
}

export async function refreshAllModelCatalogs(
	paths: JouzuPaths,
	options: Omit<RefreshCatalogOptions, "sourceId"> = {},
): Promise<CatalogRefreshAllResult> {
	const env = options.env ?? process.env;
	const sources = resolveCatalogSources(paths, env).filter((source) => !automaticallySkipped(paths, source, env));
	if (sources.length === 0) return { status: "unconfigured", results: [] };
	const results = await Promise.all(
		sources.map(async (source) => ({ source, result: await refreshCatalogSource(paths, source, options) })),
	);
	const successful = results.filter(
		({ result }) => result.status === "activated" || result.status === "not-modified",
	).length;
	return {
		status: successful === results.length ? "complete" : successful === 0 ? "failed" : "partial",
		results,
	};
}

/**
 * Best-effort catalog refresh for interactive startup. Only sources whose
 * bearer credential is available are contacted, so an unset environment
 * variable produces no request and no error. Returns undefined when no
 * source can be refreshed.
 */
export async function refreshAvailableModelCatalogs(
	paths: JouzuPaths,
	options: Omit<RefreshCatalogOptions, "sourceId"> = {},
): Promise<CatalogRefreshAllResult | undefined> {
	const env = options.env ?? process.env;
	const sources = resolveCatalogSources(paths, env).filter((source) => catalogSourceCredentialAvailable(source, env));
	if (sources.length === 0) return undefined;
	const results = await Promise.all(
		sources.map(async (source) => ({ source, result: await refreshCatalogSource(paths, source, options) })),
	);
	const successful = results.filter(
		({ result }) => result.status === "activated" || result.status === "not-modified",
	).length;
	return {
		status: successful === results.length ? "complete" : successful === 0 ? "failed" : "partial",
		results,
	};
}

export function loadActiveCatalogForSource(paths: JouzuPaths, source: CatalogSource): ModelCatalogDocument | undefined {
	const origin = readOriginState(paths, source.url);
	if (!origin?.activeAccountRefHash) return undefined;
	const state = readAccountState(paths, source.url, origin.activeAccountRefHash);
	if (!state?.active) return undefined;
	return loadDocument(accountRoot(paths, source.url, origin.activeAccountRefHash), state.active);
}

export function loadActiveModelCatalogs(paths: JouzuPaths, env: NodeJS.ProcessEnv = process.env): ActiveModelCatalog[] {
	const active: ActiveModelCatalog[] = [];
	const streams = new Map<string, { revision: string; sourceId: string }>();
	for (const source of resolveCatalogSources(paths, env)) {
		const document = loadActiveCatalogForSource(paths, source);
		if (!document) continue;
		const scope = document.scope.accountScoped ? document.scope.accountRef : "public";
		const streamKey = `${document.catalogId}\0${scope}`;
		const existing = streams.get(streamKey);
		if (existing) {
			if (existing.revision !== document.revision) {
				throw new CatalogSyncError(
					`catalog sources ${existing.sourceId} and ${source.id} publish conflicting revisions for one stream`,
				);
			}
			continue;
		}
		streams.set(streamKey, { revision: document.revision, sourceId: source.id });
		active.push({ source, document });
	}
	return active;
}

export function loadActiveModelCatalog(
	paths: JouzuPaths,
	env: NodeJS.ProcessEnv = process.env,
): ModelCatalogDocument | undefined {
	return loadActiveModelCatalogs(paths, env)[0]?.document;
}

export function acceptQuarantinedCatalog(
	paths: JouzuPaths,
	revision: string,
	digest: string,
	env: NodeJS.ProcessEnv = process.env,
	now = new Date(),
	sourceId?: string,
): CatalogSyncStatus {
	const sources = resolveCatalogSources(paths, env);
	const source = sourceId
		? sources.find((candidate) => candidate.id === sourceId)
		: sources.find((candidate) => !automaticallySkipped(paths, candidate, env));
	if (!source) return unconfiguredStatus();
	const config: CatalogEndpointConfig = { url: source.url };
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
		return getCatalogSourceStatus(paths, source, now);
	} finally {
		release();
	}
}
