import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { readBoundedResponseText } from "./bounded-response.js";
import { describeCatalogFailure, safeCatalogMessage } from "./catalog-failure.js";
import {
	type CatalogEndpointDiscoveryResult,
	type CatalogSource,
	CatalogSourceError,
	catalogSourceConflict,
	catalogSourceCredentialAvailable,
	catalogSourceCredentialName,
	catalogSourceCredentialState,
	isBuiltinCatalogSource,
	isCodeOwnedCatalogSource,
	resolveCatalogBearer,
	resolveCatalogSources,
} from "./catalog-sources.js";
import { CatalogMessageId, catalogText, defaultCatalog } from "./cli-messages.js";
import type { CatalogBundle } from "./locale-catalog.js";
import {
	type CatalogRegistrationGap,
	type CatalogThinkingLevelGap,
	catalogDocumentSha256,
	catalogRegistrationGaps,
	catalogThinkingLevelGaps,
	MODEL_CATALOG_MAX_BYTES,
	MODEL_CATALOG_MEDIA_TYPE,
	type ModelCatalogDocument,
	ModelCatalogError,
	parseAndValidateModelCatalog,
} from "./model-catalog.js";
import type { JouzuPaths } from "./paths.js";
import { ensurePrivateDirectory, writeFilePrivateAtomic } from "./private-fs.js";
import { acquireStateLock, type StateLockInspection } from "./state-lock.js";

const CATALOG_TOTAL_TIMEOUT_MS = 30_000;
const QUARANTINE_LIMIT = 3;
const QUARANTINE_BYTE_LIMIT = 48 * 1024 * 1024;

/**
 * The catalog ID for the "source not found or disabled" refresh error. It is
 * local to this module, like the catalog-failure IDs, so a parallel migration
 * of another surface does not conflict on the shared `CatalogMessageId` table.
 */
const CATALOG_SOURCE_NOT_FOUND_ID = "jouzu.cli.catalog.sourceNotFoundOrDisabled";

/**
 * The catalog IDs for the catalog-sync failure text a user reads. A lock
 * status word, an HTTP status, and a source id are protected values passed as
 * arguments; the sentence resolves from the session bundle. The IDs stay local
 * to this module, like the catalog-failure IDs, so a parallel migration does
 * not conflict on the shared table.
 */
const SYNC_MESSAGE_ID = {
	refreshBusy: "jouzu.cli.catalog.sync.refreshBusy",
	operationBusy: "jouzu.cli.catalog.sync.operationBusy",
	authFailed: "jouzu.cli.catalog.sync.authFailed",
	accessDenied: "jouzu.cli.catalog.sync.accessDenied",
	proxyAuth: "jouzu.cli.catalog.sync.proxyAuth",
	httpError: "jouzu.cli.catalog.sync.httpError",
	noActiveAccount: "jouzu.cli.catalog.sync.noActiveAccount",
} as const;

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

/** How a held revision differs from the active revision, by model offering ID. */
export interface CatalogRevisionChanges {
	activeCount: number;
	candidateCount: number;
	added: number;
	removed: number;
}

interface CatalogQuarantineRef {
	digest: string;
	revision: string;
	sequence: string;
	document: string;
	reasons: string[];
	receivedAt: string;
	bytes: number;
	changes?: CatalogRevisionChanges;
}

/** A revision Jouzu fetched and validated but did not activate; the user accepts or rejects it. */
export interface CatalogHeldRevision {
	revision: string;
	digest: string;
	sequence: string;
	reasons: string[];
	receivedAt: string;
	changes?: CatalogRevisionChanges;
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

interface CatalogStoredError {
	code: string;
	message: string;
	at: string;
}

interface CatalogOriginState {
	schemaVersion: 1;
	activeAccountRefHash?: string;
	lastError?: CatalogStoredError;
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
			thinkingLevelGaps?: CatalogThinkingLevelGap[];
			registrationGaps?: CatalogRegistrationGap[];
			lastError?: { code: string; message: string; at: string };
			credentialName?: string;
			credentialAvailable?: boolean;
			credentialEnv?: boolean;
			credentialStored?: boolean;
			credentialLogin?: boolean;
			conflict?: string;
			held?: CatalogHeldRevision[];
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
	| {
			status: "quarantined";
			catalogStatus: CatalogSyncStatus;
			revision: string;
			digest: string;
			reasons: string[];
			changes: CatalogRevisionChanges;
	  }
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

	constructor(
		message: string,
		readonly code = "catalog_sync_error",
	) {
		super(message);
		this.name = "CatalogSyncError";
	}
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
	const text = readFileSync(path, "utf8");
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new CatalogSyncError(
			`catalog state is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function validStoredError(value: unknown): value is CatalogStoredError {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<CatalogStoredError>;
	return (
		typeof record.code === "string" &&
		/^[a-z0-9_]{1,128}$/u.test(record.code) &&
		typeof record.message === "string" &&
		record.message.length <= 512 &&
		typeof record.at === "string" &&
		Number.isFinite(Date.parse(record.at))
	);
}

function parseOriginState(value: unknown): CatalogOriginState | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new CatalogSyncError("catalog origin state is invalid");
	const record = value as Partial<CatalogOriginState>;
	if (
		record.schemaVersion !== 1 ||
		(record.activeAccountRefHash !== undefined && !/^[0-9a-f]{64}$/u.test(record.activeAccountRefHash)) ||
		(record.lastError !== undefined && !validStoredError(record.lastError))
	) {
		throw new CatalogSyncError("catalog origin state is invalid");
	}
	return {
		schemaVersion: 1,
		...(record.activeAccountRefHash ? { activeAccountRefHash: record.activeAccountRefHash } : {}),
		...(record.lastError ? { lastError: record.lastError } : {}),
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
		Number(record.bytes) >= 0 &&
		(record.changes === undefined || validRevisionChanges(record.changes))
	);
}

function validRevisionChanges(value: unknown): value is CatalogRevisionChanges {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Partial<CatalogRevisionChanges>;
	return [record.activeCount, record.candidateCount, record.added, record.removed].every(
		(count) => Number.isInteger(count) && Number(count) >= 0,
	);
}

function heldRevision(entry: CatalogQuarantineRef): CatalogHeldRevision {
	return {
		revision: entry.revision,
		digest: entry.digest,
		sequence: entry.sequence,
		reasons: [...entry.reasons],
		receivedAt: entry.receivedAt,
		...(entry.changes ? { changes: { ...entry.changes } } : {}),
	};
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

/**
 * Checks activation metadata only; it does not validate the referenced document.
 * A stale revision still counts. Missing or unreadable state counts as absent;
 * document loading and its error reporting remain the picker's responsibility.
 */
function hasActiveRevision(paths: JouzuPaths, source: CatalogSource): boolean {
	try {
		const origin = readOriginState(paths, source.url);
		if (!origin?.activeAccountRefHash) return false;
		return readAccountState(paths, source.url, origin.activeAccountRefHash)?.active !== undefined;
	} catch {
		return false;
	}
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
		message: catalogText(defaultCatalog(), CatalogMessageId.catalogUnconfigured),
	};
}

export function getCatalogSourceStatus(
	paths: JouzuPaths,
	source: CatalogSource,
	now = new Date(),
	env: NodeJS.ProcessEnv = process.env,
	catalog: CatalogBundle = defaultCatalog(),
): CatalogSyncStatus {
	const credentialName = catalogSourceCredentialName(source);
	const credential = credentialName ? catalogSourceCredentialState(source, env, paths) : undefined;
	const credentialAvailable = credential
		? credential.envSet || credential.stored || credential.login === true
		: undefined;
	const conflict = catalogSourceConflict(source, catalog);
	try {
		const origin = readOriginState(paths, source.url);
		const account = origin?.activeAccountRefHash
			? readAccountState(paths, source.url, origin.activeAccountRefHash)
			: undefined;
		let offeringCount: number | undefined;
		let thinkingLevelGaps: CatalogThinkingLevelGap[] | undefined;
		let registrationGaps: CatalogRegistrationGap[] | undefined;
		if (account?.active && origin?.activeAccountRefHash) {
			const document = loadDocument(accountRoot(paths, source.url, origin.activeAccountRefHash), account.active);
			offeringCount = document.modelOfferings.length;
			thinkingLevelGaps = catalogThinkingLevelGaps(document);
			registrationGaps = catalogRegistrationGaps(document);
		}
		const lastError = account?.lastError ?? origin?.lastError;
		return {
			schemaVersion: 1,
			status: account?.active ? (lastError ? "stale" : "active") : "empty",
			configured: true,
			sourceId: source.id,
			label: source.label,
			enabled: source.enabled,
			endpoint: publicEndpoint(source.url),
			...(account?.catalogId ? { catalogId: account.catalogId } : {}),
			...(account?.active ? { revision: account.active.revision, sequence: account.active.sequence } : {}),
			...(account?.validatedAt ? { validatedAt: account.validatedAt } : {}),
			...(offeringCount !== undefined ? { offeringCount } : {}),
			...(thinkingLevelGaps ? { thinkingLevelGaps } : {}),
			...(registrationGaps ? { registrationGaps } : {}),
			...(lastError ? { lastError } : {}),
			...(credentialName ? { credentialName, credentialAvailable } : {}),
			...(credential ? { credentialEnv: credential.envSet, credentialStored: credential.stored } : {}),
			...(credential?.login ? { credentialLogin: true } : {}),
			...(conflict ? { conflict } : {}),
			...(account?.quarantined.length ? { held: account.quarantined.map(heldRevision) } : {}),
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
			...(credential ? { credentialEnv: credential.envSet, credentialStored: credential.stored } : {}),
			...(credential?.login ? { credentialLogin: true } : {}),
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
	catalog: CatalogBundle = defaultCatalog(),
): CatalogStatuses {
	const sources = resolveCatalogSources(paths, env, { includeDisabled: true }, catalog);
	if (sources.length === 0) return { schemaVersion: 1, status: "unconfigured", configured: 0, active: 0, sources: [] };
	const statuses = sources.map((source) => getCatalogSourceStatus(paths, source, now, env, catalog));
	const enabled = statuses.filter((status) => status.configured && status.enabled);
	const active = enabled.filter((status) => status.status === "active").length;
	const degraded = enabled.some((status) => status.status === "stale" || (status.configured && status.lastError));
	return {
		schemaVersion: 1,
		status: degraded ? "degraded" : active > 0 ? "active" : "empty",
		configured: sources.length,
		active,
		sources: statuses,
	};
}

function pruneDocuments(directory: string, state: CatalogAccountState): void {
	try {
		const documents = join(directory, "documents");
		if (!lstatSync(documents).isDirectory() || lstatSync(documents).isSymbolicLink()) return;
		const retained = new Set([state.active?.document, state.previous?.document]);
		for (const entry of readdirSync(documents, { withFileTypes: true })) {
			if (
				entry.isFile() &&
				/^[0-9a-f]{64}\.json$/u.test(entry.name) &&
				!retained.has(safeRelative(directory, join(documents, entry.name)))
			) {
				rmSync(join(documents, entry.name));
			}
		}
	} catch {
		// A cleanup failure must not turn a committed activation into a failed refresh.
	}
}

function loadDocument(accountDirectory: string, reference: CatalogRevisionRef): ModelCatalogDocument {
	const path = resolveRelative(accountDirectory, reference.document);
	const text = readFileSync(path, "utf8");
	if (catalogDocumentSha256(text) !== reference.digest) throw new CatalogSyncError("cached catalog digest mismatch");
	return parseAndValidateModelCatalog(text, { remote: true });
}

export function catalogRevisionChanges(
	active: ModelCatalogDocument | undefined,
	candidate: ModelCatalogDocument,
): CatalogRevisionChanges {
	const activeIds = new Set((active?.modelOfferings ?? []).map((offering) => offering.id));
	const candidateIds = new Set(candidate.modelOfferings.map((offering) => offering.id));
	return {
		activeCount: activeIds.size,
		candidateCount: candidateIds.size,
		added: [...candidateIds].filter((id) => !activeIds.has(id)).length,
		removed: [...activeIds].filter((id) => !candidateIds.has(id)).length,
	};
}

/**
 * The catalog publisher owns model membership: additions, removals, and renames
 * activate as delivered. The one revision Jouzu holds for review is a complete
 * catalog that would replace a non-empty active catalog with no models at all,
 * which means a misconfigured publisher rather than an intended change.
 */
function heldRevisionReasons(previous: ModelCatalogDocument | undefined, candidate: ModelCatalogDocument): string[] {
	if (!previous || previous.modelOfferings.length === 0) return [];
	if (!candidate.scope.complete || !candidate.scope.includes.includes("modelOfferings")) return [];
	return candidate.modelOfferings.length === 0 ? ["empty_catalog"] : [];
}

/**
 * Drop held revisions an activation has superseded. A held revision whose
 * sequence is not newer than the active one can never be accepted, so keeping
 * it would only leave a stale review prompt behind.
 */
function dropSupersededHeld(state: CatalogAccountState, directory: string): void {
	if (!state.active) return;
	const active = BigInt(state.active.sequence);
	const superseded = state.quarantined.filter((entry) => BigInt(entry.sequence) <= active);
	if (superseded.length === 0) return;
	state.quarantined = state.quarantined.filter((entry) => !superseded.includes(entry));
	for (const entry of superseded) {
		try {
			rmSync(resolveRelative(directory, entry.document), { force: true });
		} catch {
			// A cleanup failure must not turn a committed activation into a failed refresh.
		}
	}
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

function recordError(
	paths: JouzuPaths,
	config: CatalogEndpointConfig,
	origin: CatalogOriginState | undefined,
	code: string,
	message: string,
	now: Date,
): void {
	if (!origin?.activeAccountRefHash) {
		writeJson(
			originStatePath(paths, config.url),
			{ schemaVersion: 1, lastError: { code, message, at: now.toISOString() } },
			catalogRoot(paths),
		);
		return;
	}
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
	timeoutMs?: number;
	signal?: AbortSignal;
	/** The resolved catalog the sync failure text renders from; English when omitted. */
	catalog?: CatalogBundle;
}

export async function refreshCatalogSource(
	paths: JouzuPaths,
	source: CatalogSource,
	options: RefreshCatalogOptions = {},
): Promise<CatalogRefreshResult> {
	const env = options.env ?? process.env;
	const now = options.now ?? new Date();
	const catalog = options.catalog ?? defaultCatalog();
	const catalogStatus = () => getCatalogSourceStatus(paths, source, now, env, catalog);
	let token: string | undefined;
	const config: CatalogEndpointConfig = { url: source.url };
	let release: (() => void) | undefined;
	let origin: CatalogOriginState | undefined;
	let originLoaded = false;
	let phase: "network" | "filesystem" = "filesystem";
	try {
		options.signal?.throwIfAborted();
		release = acquireStateLock({
			path: lockPath(paths, config.url),
			describe: "model catalog refresh",
			now,
			onBusy: (inspection: StateLockInspection) =>
				new CatalogSyncError(catalogText(catalog, SYNC_MESSAGE_ID.refreshBusy, { status: inspection.status })),
		});
		origin = readOriginState(paths, config.url);
		originLoaded = true;
		token = resolveCatalogBearer(source, env, paths, catalog);
		const activeState = origin?.activeAccountRefHash
			? readAccountState(paths, config.url, origin.activeAccountRefHash)
			: undefined;
		const headers = new Headers({ Accept: MODEL_CATALOG_MEDIA_TYPE });
		if (token) headers.set("Authorization", `Bearer ${token}`);
		if (activeState?.etag) headers.set("If-None-Match", activeState.etag);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? CATALOG_TOTAL_TIMEOUT_MS);
		let response: Response;
		let text: string;
		try {
			phase = "network";
			response = await (options.fetch ?? globalThis.fetch)(config.url, {
				method: "GET",
				headers,
				// Never follow a redirect with an Authorization header attached.
				redirect: "error",
				signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
			});
			options.signal?.throwIfAborted();
			if (response.status === 304) {
				phase = "filesystem";
				if (!activeState || !origin?.activeAccountRefHash)
					throw new CatalogSyncError("received 304 without an active cached catalog");
				activeState.validatedAt = now.toISOString();
				activeState.lastError = undefined;
				const etag = response.headers.get("etag");
				if (etag) activeState.etag = etag;
				writeJson(accountStatePath(paths, config.url, origin.activeAccountRefHash), activeState, catalogRoot(paths));
				return { status: "not-modified", catalogStatus: catalogStatus() };
			}
			if (!response.ok) {
				if (response.status === 401)
					throw new CatalogSyncError(catalogText(catalog, SYNC_MESSAGE_ID.authFailed), "auth_rejected");
				if (response.status === 403)
					throw new CatalogSyncError(catalogText(catalog, SYNC_MESSAGE_ID.accessDenied), "access_denied");
				if (response.status === 407)
					throw new CatalogSyncError(catalogText(catalog, SYNC_MESSAGE_ID.proxyAuth), "proxy_auth_required");
				throw new CatalogSyncError(
					catalogText(catalog, SYNC_MESSAGE_ID.httpError, { status: response.status }),
					"http_error",
				);
			}
			const mediaType = response.headers.get("content-type") ?? "";
			if (!mediaType.toLowerCase().startsWith(MODEL_CATALOG_MEDIA_TYPE)) {
				throw new CatalogSyncError(`catalog endpoint returned unsupported Content-Type: ${mediaType || "missing"}`);
			}
			text = await readBoundedResponseText(response, {
				maxBytes: MODEL_CATALOG_MAX_BYTES,
				tooLargeError: () => new CatalogSyncError("catalog response exceeds 16 MiB"),
			});
		} finally {
			clearTimeout(timeout);
		}
		options.signal?.throwIfAborted();
		phase = "filesystem";
		return activateCatalogDocument(paths, source, text, response.headers.get("etag") ?? undefined, now, env, catalog);
	} catch (error) {
		options.signal?.throwIfAborted();
		const { code, message } =
			error instanceof ModelCatalogError || error instanceof CatalogSyncError || error instanceof CatalogSourceError
				? { code: error.code, message: safeCatalogMessage(error.message, token) }
				: describeCatalogFailure(error, phase);
		try {
			if (release && originLoaded) recordError(paths, config, origin, code, message, now);
		} catch {
			// Keep the original refresh failure when cached state is also unreadable.
		}
		return {
			status: error instanceof ModelCatalogError || error instanceof CatalogSyncError ? "rejected" : "error",
			catalogStatus: catalogStatus(),
			code,
			message,
		};
	} finally {
		release?.();
	}
}

/** Activate the exact discovery response without issuing a second request. */
export function activateDiscoveredCatalog(
	paths: JouzuPaths,
	source: CatalogSource,
	discovered: CatalogEndpointDiscoveryResult,
	env: NodeJS.ProcessEnv = process.env,
	catalog: CatalogBundle = defaultCatalog(),
): CatalogRefreshResult {
	if (source.url !== discovered.url) throw new CatalogSyncError("discovered catalog endpoint does not match source");
	const release = acquireStateLock({
		path: lockPath(paths, source.url),
		describe: "model catalog activation",
		onBusy: (inspection) =>
			new CatalogSyncError(catalogText(catalog, SYNC_MESSAGE_ID.refreshBusy, { status: inspection.status })),
	});
	try {
		return activateCatalogDocument(paths, source, discovered.text, discovered.etag, new Date(), env, catalog);
	} finally {
		release();
	}
}

function activateCatalogDocument(
	paths: JouzuPaths,
	source: CatalogSource,
	text: string,
	etag: string | undefined,
	now: Date,
	env: NodeJS.ProcessEnv,
	catalog: CatalogBundle = defaultCatalog(),
): CatalogRefreshResult {
	const config = { url: source.url };
	const catalogStatus = () => getCatalogSourceStatus(paths, source, now, env, catalog);
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
	const reasons = heldRevisionReasons(previous, document);
	const changes = catalogRevisionChanges(previous, document);
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
					changes,
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
			changes,
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
	if (etag) state.etag = etag;
	dropSupersededHeld(state, directory);
	writeJson(accountStatePath(paths, config.url, accountRefHash), state, catalogRoot(paths));
	const origin = { schemaVersion: 1, activeAccountRefHash: accountRefHash };
	writeJson(originStatePath(paths, config.url), origin, catalogRoot(paths));
	pruneDocuments(directory, state);
	return { status: "activated", catalogStatus: catalogStatus() };
}

export async function refreshModelCatalog(
	paths: JouzuPaths,
	options: RefreshCatalogOptions = {},
): Promise<CatalogRefreshResult> {
	const env = options.env ?? process.env;
	const catalog = options.catalog ?? defaultCatalog();
	const sources = resolveCatalogSources(paths, env, {}, catalog);
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
			message: catalogText(catalog, CATALOG_SOURCE_NOT_FOUND_ID, { id: options.sourceId }),
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
		!catalogSourceCredentialAvailable(source, env, paths)
	);
}

export async function refreshAllModelCatalogs(
	paths: JouzuPaths,
	options: Omit<RefreshCatalogOptions, "sourceId"> = {},
): Promise<CatalogRefreshAllResult> {
	const env = options.env ?? process.env;
	const sources = resolveCatalogSources(paths, env, {}, options.catalog ?? defaultCatalog()).filter(
		(source) => !automaticallySkipped(paths, source, env),
	);
	if (sources.length === 0) return { status: "unconfigured", results: [] };
	return refreshSources(paths, sources, options);
}

/**
 * Sources that are enabled, hold an available bearer credential, and have no
 * activated revision. These have nothing cached to serve Pi's initial model
 * selection, so interactive startup refreshes them before the model picker
 * snapshots catalogs. A source with an activated revision, stale included, keeps
 * serving and refreshes in the background instead.
 */
export function pendingStartupCatalogSources(
	paths: JouzuPaths,
	env: NodeJS.ProcessEnv = process.env,
	catalog: CatalogBundle = defaultCatalog(),
): CatalogSource[] {
	return resolveCatalogSources(paths, env, {}, catalog).filter(
		(source) => catalogSourceCredentialAvailable(source, env, paths) && !hasActiveRevision(paths, source),
	);
}

/**
 * Refreshes exactly the given sources. Returns undefined for an empty list, so a
 * caller can tell "nothing to do" from a refresh that ran.
 */
export async function refreshModelCatalogSources(
	paths: JouzuPaths,
	sources: CatalogSource[],
	options: Omit<RefreshCatalogOptions, "sourceId"> = {},
): Promise<CatalogRefreshAllResult | undefined> {
	if (sources.length === 0) return undefined;
	return refreshSources(paths, sources, options);
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
	return refreshModelCatalogSources(
		paths,
		resolveCatalogSources(paths, env, {}, options.catalog ?? defaultCatalog()).filter((source) =>
			catalogSourceCredentialAvailable(source, env, paths),
		),
		options,
	);
}

async function refreshSources(
	paths: JouzuPaths,
	sources: CatalogSource[],
	options: RefreshCatalogOptions,
): Promise<CatalogRefreshAllResult> {
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

export function loadActiveModelCatalogs(
	paths: JouzuPaths,
	env: NodeJS.ProcessEnv = process.env,
	catalog: CatalogBundle = defaultCatalog(),
): ActiveModelCatalog[] {
	const active: ActiveModelCatalog[] = [];
	const streams = new Map<string, { revision: string; sourceId: string }>();
	for (const source of resolveCatalogSources(paths, env, {}, catalog)) {
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

export function acceptQuarantinedCatalog(
	paths: JouzuPaths,
	revision: string,
	digest: string,
	env: NodeJS.ProcessEnv = process.env,
	now = new Date(),
	sourceId?: string,
	catalog: CatalogBundle = defaultCatalog(),
): CatalogSyncStatus {
	const sources = resolveCatalogSources(paths, env, {}, catalog);
	const source = sourceId
		? sources.find((candidate) => candidate.id === sourceId)
		: sources.find((candidate) => !automaticallySkipped(paths, candidate, env));
	if (!source) return unconfiguredStatus();
	const config: CatalogEndpointConfig = { url: source.url };
	const release = acquireStateLock({
		path: lockPath(paths, config.url),
		describe: "model catalog acceptance",
		now,
		onBusy: (inspection) =>
			new CatalogSyncError(catalogText(catalog, SYNC_MESSAGE_ID.operationBusy, { status: inspection.status })),
	});
	try {
		const origin = readOriginState(paths, config.url);
		if (!origin?.activeAccountRefHash)
			throw new CatalogSyncError(catalogText(catalog, SYNC_MESSAGE_ID.noActiveAccount));
		const directory = accountRoot(paths, config.url, origin.activeAccountRefHash);
		const state = readAccountState(paths, config.url, origin.activeAccountRefHash);
		if (!state) throw new CatalogSyncError("catalog account state is missing");
		const candidate = state.quarantined.find((entry) => entry.revision === revision && entry.digest === digest);
		if (!candidate) throw new CatalogSyncError("the exact quarantined catalog candidate was not found");
		const sourcePath = resolveRelative(directory, candidate.document);
		const text = readFileSync(sourcePath, "utf8");
		if (catalogDocumentSha256(text) !== digest) throw new CatalogSyncError("quarantined catalog digest mismatch");
		const document = parseAndValidateModelCatalog(text, { remote: true });
		if (!document.sequence) throw new CatalogSyncError("quarantined catalog sequence is missing");
		if (state.active) {
			const candidateSequence = BigInt(document.sequence);
			const activeSequence = BigInt(state.active.sequence);
			if (candidateSequence < activeSequence) {
				throw new CatalogSyncError("quarantined catalog sequence is older than the active catalog");
			}
			if (candidateSequence === activeSequence && document.revision !== state.active.revision) {
				throw new CatalogSyncError("quarantined catalog sequence was reused by the active catalog");
			}
			if (document.revision === state.active.revision && digest !== state.active.digest) {
				throw new CatalogSyncError("quarantined catalog revision content differs from the active catalog");
			}
		}
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
		dropSupersededHeld(state, directory);
		state.lastError = undefined;
		state.validatedAt = now.toISOString();
		writeJson(accountStatePath(paths, config.url, origin.activeAccountRefHash), state, catalogRoot(paths));
		pruneDocuments(directory, state);
		return getCatalogSourceStatus(paths, source, now, env, catalog);
	} finally {
		release();
	}
}

/**
 * Discard one held revision and keep the active catalog. A later refresh that
 * receives the same revision holds it again, so a publisher that keeps serving
 * an empty catalog stays visible.
 */
export function rejectHeldCatalog(
	paths: JouzuPaths,
	revision: string,
	digest: string,
	env: NodeJS.ProcessEnv = process.env,
	now = new Date(),
	sourceId?: string,
	catalog: CatalogBundle = defaultCatalog(),
): CatalogSyncStatus {
	const sources = resolveCatalogSources(paths, env, {}, catalog);
	const source = sourceId
		? sources.find((candidate) => candidate.id === sourceId)
		: sources.find((candidate) => !automaticallySkipped(paths, candidate, env));
	if (!source) return unconfiguredStatus();
	const release = acquireStateLock({
		path: lockPath(paths, source.url),
		describe: "model catalog rejection",
		now,
		onBusy: (inspection) =>
			new CatalogSyncError(catalogText(catalog, SYNC_MESSAGE_ID.operationBusy, { status: inspection.status })),
	});
	try {
		const origin = readOriginState(paths, source.url);
		if (!origin?.activeAccountRefHash)
			throw new CatalogSyncError(catalogText(catalog, SYNC_MESSAGE_ID.noActiveAccount));
		const directory = accountRoot(paths, source.url, origin.activeAccountRefHash);
		const state = readAccountState(paths, source.url, origin.activeAccountRefHash);
		if (!state) throw new CatalogSyncError("catalog account state is missing");
		const candidate = state.quarantined.find((entry) => entry.revision === revision && entry.digest === digest);
		if (!candidate) throw new CatalogSyncError("the exact held catalog revision was not found");
		rmSync(resolveRelative(directory, candidate.document), { force: true });
		state.quarantined = state.quarantined.filter((entry) => entry !== candidate);
		if (state.lastError?.code === "quarantined" && state.quarantined.length === 0) state.lastError = undefined;
		writeJson(accountStatePath(paths, source.url, origin.activeAccountRefHash), state, catalogRoot(paths));
		return getCatalogSourceStatus(paths, source, now, env, catalog);
	} finally {
		release();
	}
}
