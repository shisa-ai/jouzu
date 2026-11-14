import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { readBoundedResponseText } from "./bounded-response.js";
import { describeCatalogFailure, safeCatalogMessage } from "./catalog-failure.js";
import { CatalogMessageId, catalogText, defaultCatalog } from "./cli-messages.js";
import type { CatalogBundle } from "./locale-catalog.js";
import {
	MODEL_CATALOG_MAX_BYTES,
	MODEL_CATALOG_MEDIA_TYPE,
	type ModelCatalogDocument,
	ModelCatalogError,
	parseAndValidateModelCatalog,
	parseStrictJson,
} from "./model-catalog.js";
import type { JouzuPaths } from "./paths.js";
import { validatePrivateDirectory, writeFilePrivateAtomic } from "./private-fs.js";
import { isShisaSignedOut, readShisaLoginToken } from "./shisa-link/credentials.js";
import { readShisaLinkState, shisaLinkStatePath } from "./shisa-link/state.js";

const REGISTRY_MAX_BYTES = 256 * 1024;
const OVERRIDES_MAX_BYTES = 64 * 1024;
const CREDENTIALS_MAX_BYTES = 64 * 1024;
const TOKEN_MAX_BYTES = 8 * 1024;
const LABEL_MAX_BYTES = 256;
const SOURCE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * The catalog IDs for the catalog-source configuration diagnostics and the
 * source-store operations a user reads. A source index, a source id, a field
 * name, an endpoint, a token variable name, and an HTTP status are protected
 * values passed as arguments; the sentence and the context label resolve from
 * the session bundle. The IDs stay local to this module, like the
 * catalog-failure IDs, so a parallel migration does not conflict on the shared
 * table; `scripts/check-locales.mjs` allows a catalog-only ID present in both
 * locales.
 */
const SOURCE_MESSAGE_ID = {
	contextSource: "jouzu.cli.catalogSource.context.source",
	contextSourceAuth: "jouzu.cli.catalogSource.context.sourceAuth",
	contextSourceLabel: "jouzu.cli.catalogSource.context.sourceLabel",
	contextSourceLabelBare: "jouzu.cli.catalogSource.context.sourceLabelBare",
	contextOverride: "jouzu.cli.catalogSource.context.override",
	contextRegistry: "jouzu.cli.catalogSource.context.registry",
	contextOverrides: "jouzu.cli.catalogSource.context.overrides",
	contextCredentials: "jouzu.cli.catalogSource.context.credentials",
	contextUrl: "jouzu.cli.catalogSource.context.url",
	contextToken: "jouzu.cli.catalogSource.context.token",
	contextTokenFor: "jouzu.cli.catalogSource.context.tokenFor",
	unknownField: "jouzu.cli.catalogSource.unknownField",
	notObject: "jouzu.cli.catalogSource.notObject",
	notBoundedText: "jouzu.cli.catalogSource.notBoundedText",
	invalidSourceId: "jouzu.cli.catalogSource.invalidSourceId",
	urlAbsolute: "jouzu.cli.catalogSource.urlAbsolute",
	urlCredentials: "jouzu.cli.catalogSource.urlCredentials",
	urlQueryOrFragment: "jouzu.cli.catalogSource.urlQueryOrFragment",
	urlScheme: "jouzu.cli.catalogSource.urlScheme",
	authBearerCredentialRef: "jouzu.cli.catalogSource.authBearerCredentialRef",
	authInvalidCredentialRef: "jouzu.cli.catalogSource.authInvalidCredentialRef",
	authType: "jouzu.cli.catalogSource.authType",
	sourceNotObject: "jouzu.cli.catalogSource.sourceNotObject",
	sourceRequiresFields: "jouzu.cli.catalogSource.sourceRequiresFields",
	sourceEnabledBoolean: "jouzu.cli.catalogSource.sourceEnabledBoolean",
	registryNotObject: "jouzu.cli.catalogSource.registryNotObject",
	registrySchema: "jouzu.cli.catalogSource.registrySchema",
	registryNotRegularFile: "jouzu.cli.catalogSource.registryNotRegularFile",
	duplicateId: "jouzu.cli.catalogSource.duplicateId",
	duplicateUrl: "jouzu.cli.catalogSource.duplicateUrl",
	overrideNotObject: "jouzu.cli.catalogSource.overrideNotObject",
	overrideEnabledBoolean: "jouzu.cli.catalogSource.overrideEnabledBoolean",
	overridesNotObject: "jouzu.cli.catalogSource.overridesNotObject",
	overridesSchema: "jouzu.cli.catalogSource.overridesSchema",
	overridesNotRegularFile: "jouzu.cli.catalogSource.overridesNotRegularFile",
	credentialsNotObject: "jouzu.cli.catalogSource.credentialsNotObject",
	credentialsSchema: "jouzu.cli.catalogSource.credentialsSchema",
	credentialsNotRegularFile: "jouzu.cli.catalogSource.credentialsNotRegularFile",
	tokenNotString: "jouzu.cli.catalogSource.tokenNotString",
	builtinImmutable: {
		edit: "jouzu.cli.catalogSource.builtinImmutableEdit",
		remove: "jouzu.cli.catalogSource.builtinImmutableRemove",
	},
	reservedId: "jouzu.cli.catalogSource.reservedId",
	signedOut: "jouzu.cli.catalogSource.signedOut",
	discoveryCanceled: "jouzu.cli.catalogSource.discoveryCanceled",
	unsupportedContentType: "jouzu.cli.catalogSource.unsupportedContentType",
	mediaTypeMissing: "jouzu.cli.catalogSource.mediaTypeMissing",
	attemptValid: "jouzu.cli.catalogSource.attemptValid",
	responseTooLarge: "jouzu.cli.catalogSource.responseTooLarge",
	noCatalogFound: "jouzu.cli.catalogSource.noCatalogFound",
} as const;

/** The catalog-resolved context label a validation diagnostic names. */
function sourceContext(catalog: CatalogBundle, index: number): string {
	return catalogText(catalog, SOURCE_MESSAGE_ID.contextSource, { index: index + 1 });
}

function sourceAuthContext(catalog: CatalogBundle, index: number): string {
	return catalogText(catalog, SOURCE_MESSAGE_ID.contextSourceAuth, { index: index + 1 });
}

function sourceLabelContext(catalog: CatalogBundle, index: number): string {
	return catalogText(catalog, SOURCE_MESSAGE_ID.contextSourceLabel, { index: index + 1 });
}

function overrideContext(catalog: CatalogBundle, id: string): string {
	return catalogText(catalog, SOURCE_MESSAGE_ID.contextOverride, { id });
}

export const SHISA_API_CATALOG_SOURCE_ID = "shisa-api";
export const SHISA_API_CATALOG_CREDENTIAL_ENV = "SHISA_API_KEY";

/** Product-owned Shisa API catalog descriptor. Never persisted with a credential value. */
export const SHISA_API_CATALOG_SOURCE: CatalogSource = {
	id: SHISA_API_CATALOG_SOURCE_ID,
	label: "Shisa API",
	url: "https://api.shisa.ai/v1/jouzu/model-catalog",
	enabled: true,
	auth: { type: "bearer", credentialRef: `env:${SHISA_API_CATALOG_CREDENTIAL_ENV}` },
};

export type CatalogSourceAuth = { type: "none" } | { type: "bearer"; credentialRef: `env:${string}` };

export interface CatalogSource {
	id: string;
	label: string;
	url: string;
	enabled: boolean;
	auth: CatalogSourceAuth;
}

export interface CatalogSourceRegistry {
	schemaVersion: 1;
	sources: CatalogSource[];
}

export interface CatalogSourceInput {
	id?: string;
	label: string;
	url: string;
	enabled?: boolean;
	auth: CatalogSourceAuth;
}

export interface ResolveCatalogSourcesOptions {
	includeDisabled?: boolean;
}

interface CatalogSourceOverride {
	enabled?: boolean;
}

interface CatalogSourceOverridesFile {
	schemaVersion: 1;
	overrides: Record<string, CatalogSourceOverride>;
}

export interface CatalogSourceCredentialState {
	/** Environment variable name the source's credential reference points at. */
	name: string;
	/** True when the variable holds a non-blank value in this process. */
	envSet: boolean;
	/** True when a token is saved in Jouzu's private credential store. */
	stored: boolean;
	/** True when this Shisa endpoint can use the saved /login shisa credential. */
	login?: boolean;
}

export interface CatalogEndpointDiscoveryOptions {
	auth: CatalogSourceAuth;
	env?: NodeJS.ProcessEnv;
	/** Bearer value to send instead of resolving the credential reference. */
	bearerToken?: string;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
	/** The resolved catalog the discovery messages render from; English when omitted. */
	catalog?: CatalogBundle;
}

export interface CatalogEndpointDiscoveryResult {
	url: string;
	text: string;
	etag?: string;
	document: ModelCatalogDocument;
	attempts: Array<{ url: string; result: string }>;
}

export class CatalogSourceError extends Error {
	constructor(
		message: string,
		readonly code = "catalog_source_error",
	) {
		super(message);
		this.name = "CatalogSourceError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(
	record: Record<string, unknown>,
	allowed: readonly string[],
	context: string,
	catalog: CatalogBundle,
): void {
	const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
	if (unknown.length > 0)
		throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.unknownField, { context, field: unknown[0] }));
}

function controlFree(value: string, context: string, maxBytes: number, catalog: CatalogBundle): string {
	const trimmed = value.trim();
	const hasControl = Array.from(trimmed).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
	});
	if (!trimmed || Buffer.byteLength(trimmed) > maxBytes || hasControl) {
		throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.notBoundedText, { context }));
	}
	return trimmed;
}

function normalizeSourceId(value: string, catalog: CatalogBundle = defaultCatalog()): string {
	const id = value.trim().toLowerCase();
	if (!SOURCE_ID_PATTERN.test(id)) {
		throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.invalidSourceId));
	}
	return id;
}

function sourceIdFromLabel(label: string): string {
	const value = label
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 48)
		.replace(/-+$/u, "");
	return value || "catalog";
}

function parseAuth(value: unknown, context: string, catalog: CatalogBundle): CatalogSourceAuth {
	if (!isRecord(value)) throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.notObject, { context }));
	if (value.type === "none") {
		assertOnlyKeys(value, ["type"], context, catalog);
		return { type: "none" };
	}
	if (value.type === "bearer") {
		assertOnlyKeys(value, ["type", "credentialRef"], context, catalog);
		if (typeof value.credentialRef !== "string" || !value.credentialRef.startsWith("env:")) {
			throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.authBearerCredentialRef, { context }));
		}
		const name = value.credentialRef.slice(4);
		if (!ENV_NAME_PATTERN.test(name)) {
			throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.authInvalidCredentialRef, { context }));
		}
		return { type: "bearer", credentialRef: `env:${name}` };
	}
	throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.authType, { context }));
}

function inferScheme(value: string): string {
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)) return value;
	const host = value.split(/[/?#]/u, 1)[0]?.split(":", 1)[0]?.toLowerCase();
	const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
	return `${local ? "http" : "https"}://${value}`;
}

function isLocalhost(parsed: URL): boolean {
	return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
}

/**
 * True when a catalog URL ships credentials in cleartext: plain HTTP to a host
 * that is not this machine. Localhost HTTP stays off the network, so it is exempt.
 */
export function isInsecureCatalogTransport(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" && !isLocalhost(parsed);
	} catch {
		return false;
	}
}

/** Warning shown when a catalog source would send its bearer token over plain HTTP. */
export function catalogInsecureTransportWarning(
	url: string,
	catalog: CatalogBundle = defaultCatalog(),
): string | undefined {
	if (!isInsecureCatalogTransport(url)) return undefined;
	return catalogText(catalog, CatalogMessageId.catalogInsecureTransport);
}

export function normalizeCatalogSourceUrl(value: string, catalog: CatalogBundle = defaultCatalog()): string {
	const input = controlFree(value, catalogText(catalog, SOURCE_MESSAGE_ID.contextUrl), 2048, catalog);
	let parsed: URL;
	try {
		parsed = new URL(inferScheme(input));
	} catch {
		throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.urlAbsolute));
	}
	if (parsed.username || parsed.password)
		throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.urlCredentials));
	if (parsed.hash || parsed.search)
		throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.urlQueryOrFragment));
	// Plain HTTP is allowed but flagged: see catalogInsecureTransportWarning.
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.urlScheme));
	}
	return parsed.href;
}

function parseSource(value: unknown, index: number, catalog: CatalogBundle): CatalogSource {
	if (!isRecord(value))
		throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.sourceNotObject, { index: index + 1 }));
	assertOnlyKeys(value, ["id", "label", "url", "enabled", "auth"], sourceContext(catalog, index), catalog);
	if (typeof value.id !== "string" || typeof value.label !== "string" || typeof value.url !== "string") {
		throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.sourceRequiresFields, { index: index + 1 }));
	}
	if (typeof value.enabled !== "boolean")
		throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.sourceEnabledBoolean, { index: index + 1 }));
	return {
		id: normalizeSourceId(value.id, catalog),
		label: controlFree(value.label, sourceLabelContext(catalog, index), LABEL_MAX_BYTES, catalog),
		url: normalizeCatalogSourceUrl(value.url, catalog),
		enabled: value.enabled,
		auth: parseAuth(value.auth, sourceAuthContext(catalog, index), catalog),
	};
}

function validateRegistry(value: unknown, catalog: CatalogBundle = defaultCatalog()): CatalogSourceRegistry {
	if (!isRecord(value)) throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.registryNotObject));
	assertOnlyKeys(value, ["schemaVersion", "sources"], catalogText(catalog, SOURCE_MESSAGE_ID.contextRegistry), catalog);
	if (value.schemaVersion !== 1 || !Array.isArray(value.sources)) {
		throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.registrySchema));
	}
	const sources = value.sources.map((source, index) => parseSource(source, index, catalog));
	const ids = new Set<string>();
	const urls = new Set<string>();
	for (const source of sources) {
		if (ids.has(source.id))
			throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.duplicateId, { id: source.id }));
		if (urls.has(source.url))
			throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.duplicateUrl, { url: source.url }));
		ids.add(source.id);
		urls.add(source.url);
	}
	return { schemaVersion: 1, sources };
}

function configurationRoot(paths: JouzuPaths): string {
	return paths.configDir ?? dirname(paths.agentDir);
}

export function catalogSourceRegistryPath(paths: JouzuPaths): string {
	return join(configurationRoot(paths), "catalogs.json");
}

export function catalogSourceRegistryExists(paths: JouzuPaths): boolean {
	return existsSync(catalogSourceRegistryPath(paths));
}

export function loadCatalogSourceRegistry(
	paths: JouzuPaths,
	catalog: CatalogBundle = defaultCatalog(),
): CatalogSourceRegistry {
	const path = catalogSourceRegistryPath(paths);
	if (!existsSync(path)) return { schemaVersion: 1, sources: [] };
	validatePrivateDirectory(configurationRoot(paths));
	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > REGISTRY_MAX_BYTES) {
		throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.registryNotRegularFile));
	}
	try {
		return validateRegistry(parseStrictJson(readFileSync(path, "utf8")), catalog);
	} catch (error) {
		if (error instanceof CatalogSourceError) throw error;
		throw new CatalogSourceError(error instanceof Error ? error.message : String(error));
	}
}

function environmentSource(env: NodeJS.ProcessEnv, catalog: CatalogBundle): CatalogSource | undefined {
	const url = env.JOUZU_MODEL_CATALOG_URL?.trim();
	if (!url) return undefined;
	const token = env.JOUZU_MODEL_CATALOG_TOKEN?.trim();
	return {
		id: "default",
		label: "Environment catalog",
		url: normalizeCatalogSourceUrl(url, catalog),
		enabled: true,
		auth: token ? { type: "bearer", credentialRef: "env:JOUZU_MODEL_CATALOG_TOKEN" } : { type: "none" },
	};
}

export function catalogSourceOverridesPath(paths: JouzuPaths): string {
	return join(configurationRoot(paths), "catalog-overrides.json");
}

function parseOverride(value: unknown, id: string, catalog: CatalogBundle): CatalogSourceOverride {
	if (!isRecord(value)) throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.overrideNotObject, { id }));
	assertOnlyKeys(value, ["enabled"], overrideContext(catalog, id), catalog);
	if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
		throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.overrideEnabledBoolean, { id }));
	}
	return value.enabled === undefined ? {} : { enabled: value.enabled };
}

export function loadCatalogSourceOverrides(
	paths: JouzuPaths,
	catalog: CatalogBundle = defaultCatalog(),
): Record<string, CatalogSourceOverride> {
	const path = catalogSourceOverridesPath(paths);
	if (!existsSync(path)) return {};
	validatePrivateDirectory(configurationRoot(paths));
	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > OVERRIDES_MAX_BYTES) {
		throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.overridesNotRegularFile));
	}
	let value: unknown;
	try {
		value = parseStrictJson(readFileSync(path, "utf8"));
	} catch (error) {
		throw new CatalogSourceError(error instanceof Error ? error.message : String(error));
	}
	if (!isRecord(value)) throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.overridesNotObject));
	assertOnlyKeys(
		value,
		["schemaVersion", "overrides"],
		catalogText(catalog, SOURCE_MESSAGE_ID.contextOverrides),
		catalog,
	);
	if (value.schemaVersion !== 1 || !isRecord(value.overrides)) {
		throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.overridesSchema));
	}
	const overrides: Record<string, CatalogSourceOverride> = {};
	for (const [id, override] of Object.entries(value.overrides)) {
		overrides[normalizeSourceId(id, catalog)] = parseOverride(override, id, catalog);
	}
	return overrides;
}

function writeCatalogSourceOverrides(paths: JouzuPaths, overrides: Record<string, CatalogSourceOverride>): void {
	if (Object.keys(overrides).length === 0) {
		rmSync(catalogSourceOverridesPath(paths), { force: true });
		return;
	}
	const file: CatalogSourceOverridesFile = { schemaVersion: 1, overrides };
	writeFilePrivateAtomic(
		catalogSourceOverridesPath(paths),
		`${JSON.stringify(file, null, 2)}\n`,
		configurationRoot(paths),
	);
}

function sameAuth(left: CatalogSourceAuth, right: CatalogSourceAuth): boolean {
	if (left.type !== right.type) return false;
	return (
		left.type === "none" ||
		(left.type === "bearer" && right.type === "bearer" && left.credentialRef === right.credentialRef)
	);
}

/**
 * Catalog URL returned by the platform at Shisa sign-in, so a session signed in to
 * another Shisa environment reads that environment's catalog. Only HTTPS, or HTTP to
 * this machine, without embedded credentials, query, or fragment, is accepted.
 */
export function linkedShisaCatalogUrl(paths: JouzuPaths): string | undefined {
	const raw = readShisaLinkState(shisaLinkStatePath(paths))?.endpoints.model_catalog_url;
	if (!raw) return undefined;
	try {
		const parsed = new URL(raw);
		if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost(parsed))) return undefined;
		if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
		return parsed.href;
	} catch {
		return undefined;
	}
}

/**
 * True when a source targets the built-in Shisa API endpoint and credential reference.
 * With `paths`, the catalog URL from the saved Shisa sign-in also counts.
 */
export function isShisaApiCatalogEndpoint(source: CatalogSource, paths?: JouzuPaths): boolean {
	if (!sameAuth(source.auth, SHISA_API_CATALOG_SOURCE.auth)) return false;
	return (
		source.url === SHISA_API_CATALOG_SOURCE.url || (paths !== undefined && source.url === linkedShisaCatalogUrl(paths))
	);
}

/** True when a source is the built-in descriptor itself (reserved id plus exact endpoint and credential). */
export function isBuiltinCatalogSource(source: CatalogSource, paths?: JouzuPaths): boolean {
	return source.id === SHISA_API_CATALOG_SOURCE_ID && isShisaApiCatalogEndpoint(source, paths);
}

/**
 * Built-in Shisa catalog URL. The saved sign-in's catalog URL applies when that sign-in
 * is the catalog credential; `SHISA_API_KEY` or a saved catalog token keeps the default.
 */
function builtinShisaCatalogUrl(paths: JouzuPaths, env: NodeJS.ProcessEnv): string {
	if (envCredentialValue(SHISA_API_CATALOG_SOURCE, env)) return SHISA_API_CATALOG_SOURCE.url;
	try {
		if (getCatalogSourceToken(paths, SHISA_API_CATALOG_SOURCE_ID) !== undefined) return SHISA_API_CATALOG_SOURCE.url;
	} catch {
		return SHISA_API_CATALOG_SOURCE.url;
	}
	return linkedShisaCatalogUrl(paths) ?? SHISA_API_CATALOG_SOURCE.url;
}

/** Explains why a user-registered source claiming the reserved id blocks the built-in source. */
export function catalogSourceConflict(
	source: CatalogSource,
	catalog: CatalogBundle = defaultCatalog(),
	paths?: JouzuPaths,
): string | undefined {
	if (source.id !== SHISA_API_CATALOG_SOURCE_ID || isBuiltinCatalogSource(source, paths)) return undefined;
	return catalogText(catalog, SOURCE_MESSAGE_ID.reservedId, {
		id: SHISA_API_CATALOG_SOURCE_ID,
		url: SHISA_API_CATALOG_SOURCE.url,
		env: SHISA_API_CATALOG_CREDENTIAL_ENV,
	});
}

export function catalogSourceCredentialName(source: CatalogSource): string | undefined {
	return source.auth.type === "bearer" ? source.auth.credentialRef.slice(4) : undefined;
}

function envCredentialValue(source: CatalogSource, env: NodeJS.ProcessEnv): string | undefined {
	if (source.auth.type === "none") return undefined;
	const value = env[source.auth.credentialRef.slice(4)];
	const trimmed = typeof value === "string" ? value.trim() : "";
	return trimmed || undefined;
}

/** Read the login credential only for the exact Shisa endpoint and auth reference. */
function shisaLoginToken(source: CatalogSource, paths: JouzuPaths): string | undefined {
	return isShisaApiCatalogEndpoint(source, paths) ? readShisaLoginToken(paths) : undefined;
}

/**
 * Where a bearer source's token can come from right now. The environment
 * variable wins when set, so it stays the override for a saved token. A
 * credential store that cannot be read reports no stored token rather than
 * break status rendering; request-time resolution still fails loudly.
 */
export function catalogSourceCredentialState(
	source: CatalogSource,
	env: NodeJS.ProcessEnv,
	paths?: JouzuPaths,
): CatalogSourceCredentialState | undefined {
	if (source.auth.type === "none") return undefined;
	let stored = false;
	if (paths) {
		try {
			stored = getCatalogSourceToken(paths, source.id) !== undefined;
		} catch {
			stored = false;
		}
	}
	return {
		name: source.auth.credentialRef.slice(4),
		envSet: envCredentialValue(source, env) !== undefined,
		stored,
		...(paths && shisaLoginToken(source, paths) ? { login: true } : {}),
	};
}

export function catalogSourceCredentialAvailable(
	source: CatalogSource,
	env: NodeJS.ProcessEnv,
	paths?: JouzuPaths,
): boolean {
	if (paths && isShisaApiCatalogEndpoint(source, paths) && isShisaSignedOut(paths)) return false;
	const state = catalogSourceCredentialState(source, env, paths);
	return !state || state.envSet || state.stored || state.login === true;
}

export function catalogSourceCredentialsPath(paths: JouzuPaths): string {
	return join(configurationRoot(paths), "catalog-credentials.json");
}

/** Normalizes and validates a bearer token value before it is stored anywhere. */
export function validateCatalogSourceToken(token: string, catalog: CatalogBundle = defaultCatalog()): string {
	return controlFree(token, catalogText(catalog, SOURCE_MESSAGE_ID.contextToken), TOKEN_MAX_BYTES, catalog);
}

function parseCredentialsFile(value: unknown, catalog: CatalogBundle): Record<string, string> {
	if (!isRecord(value)) throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.credentialsNotObject));
	assertOnlyKeys(
		value,
		["schemaVersion", "tokens"],
		catalogText(catalog, SOURCE_MESSAGE_ID.contextCredentials),
		catalog,
	);
	const tokenRecord = value.tokens;
	if (value.schemaVersion !== 1 || !isRecord(tokenRecord)) {
		throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.credentialsSchema));
	}
	const tokens: Record<string, string> = {};
	for (const [id, token] of Object.entries(tokenRecord)) {
		if (typeof token !== "string")
			throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.tokenNotString, { id }));
		tokens[normalizeSourceId(id, catalog)] = controlFree(
			token,
			catalogText(catalog, SOURCE_MESSAGE_ID.contextTokenFor, { id }),
			TOKEN_MAX_BYTES,
			catalog,
		);
	}
	return tokens;
}

/** Saved bearer tokens keyed by catalog source id; never written to catalogs.json. */
export function loadCatalogSourceTokens(
	paths: JouzuPaths,
	catalog: CatalogBundle = defaultCatalog(),
): Record<string, string> {
	const path = catalogSourceCredentialsPath(paths);
	if (!existsSync(path)) return {};
	validatePrivateDirectory(configurationRoot(paths));
	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > CREDENTIALS_MAX_BYTES) {
		throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.credentialsNotRegularFile));
	}
	try {
		return parseCredentialsFile(parseStrictJson(readFileSync(path, "utf8")), catalog);
	} catch (error) {
		if (error instanceof CatalogSourceError) throw error;
		throw new CatalogSourceError(error instanceof Error ? error.message : String(error));
	}
}

export function getCatalogSourceToken(
	paths: JouzuPaths,
	sourceId: string,
	catalog: CatalogBundle = defaultCatalog(),
): string | undefined {
	return loadCatalogSourceTokens(paths, catalog)[normalizeSourceId(sourceId, catalog)];
}

export function setCatalogSourceToken(
	paths: JouzuPaths,
	sourceId: string,
	token: string,
	catalog: CatalogBundle = defaultCatalog(),
): void {
	const id = normalizeSourceId(sourceId, catalog);
	const value = validateCatalogSourceToken(token, catalog);
	const tokens = loadCatalogSourceTokens(paths, catalog);
	tokens[id] = value;
	writeFilePrivateAtomic(
		catalogSourceCredentialsPath(paths),
		`${JSON.stringify({ schemaVersion: 1, tokens }, null, 2)}\n`,
		configurationRoot(paths),
	);
}

export function removeCatalogSourceToken(
	paths: JouzuPaths,
	sourceId: string,
	catalog: CatalogBundle = defaultCatalog(),
): void {
	const id = normalizeSourceId(sourceId, catalog);
	const tokens = loadCatalogSourceTokens(paths, catalog);
	if (!(id in tokens)) return;
	delete tokens[id];
	const path = catalogSourceCredentialsPath(paths);
	if (Object.keys(tokens).length === 0) {
		rmSync(path, { force: true });
		return;
	}
	writeFilePrivateAtomic(path, `${JSON.stringify({ schemaVersion: 1, tokens }, null, 2)}\n`, configurationRoot(paths));
}

/** Sources from the user registry, or the single-source environment shorthand when no registry exists. */
function resolveBaseCatalogSources(paths: JouzuPaths, env: NodeJS.ProcessEnv, catalog: CatalogBundle): CatalogSource[] {
	if (catalogSourceRegistryExists(paths)) return loadCatalogSourceRegistry(paths, catalog).sources;
	const shorthand = environmentSource(env, catalog);
	return shorthand ? [shorthand] : [];
}

/** True when the built-in descriptor is supplied by code rather than a user registry entry. */
export function isCodeOwnedCatalogSource(
	paths: JouzuPaths,
	source: CatalogSource,
	env: NodeJS.ProcessEnv,
	catalog: CatalogBundle = defaultCatalog(),
): boolean {
	return (
		isBuiltinCatalogSource(source, paths) &&
		!resolveBaseCatalogSources(paths, env, catalog).some((candidate) => candidate.id === source.id)
	);
}

export function resolveCatalogSources(
	paths: JouzuPaths,
	env: NodeJS.ProcessEnv = process.env,
	options: ResolveCatalogSourcesOptions = {},
	catalog: CatalogBundle = defaultCatalog(),
): CatalogSource[] {
	const base = resolveBaseCatalogSources(paths, env, catalog);
	const override = loadCatalogSourceOverrides(paths, catalog)[SHISA_API_CATALOG_SOURCE_ID];
	const url = builtinShisaCatalogUrl(paths, env);
	const builtin: CatalogSource = {
		...SHISA_API_CATALOG_SOURCE,
		url,
		...(override?.enabled === undefined ? {} : { enabled: override.enabled }),
	};
	// A registry entry with the reserved id, or any entry targeting the same endpoint and
	// credential, is the user's own registration of the built-in source. It keeps its label,
	// enabled state, and URL-keyed cache, and the code-owned descriptor stays out of the way.
	const claimed = base.some(
		(source) => source.id === SHISA_API_CATALOG_SOURCE_ID || isShisaApiCatalogEndpoint(source, paths),
	);
	const sources = (claimed ? base : [builtin, ...base]).map((source) =>
		isShisaApiCatalogEndpoint(source, paths) && isShisaSignedOut(paths) ? { ...source, enabled: false } : source,
	);
	return options.includeDisabled ? sources : sources.filter((source) => source.enabled);
}

function writeRegistry(
	paths: JouzuPaths,
	registry: CatalogSourceRegistry,
	beforeSave?: () => void,
	catalog: CatalogBundle = defaultCatalog(),
): void {
	const validated = validateRegistry(registry, catalog);
	beforeSave?.();
	writeFilePrivateAtomic(
		catalogSourceRegistryPath(paths),
		`${JSON.stringify(validated, null, 2)}\n`,
		configurationRoot(paths),
	);
}

export class CatalogSourceStore {
	private readonly paths: JouzuPaths;
	private readonly env: NodeJS.ProcessEnv;
	private readonly catalog: CatalogBundle;

	constructor(paths: JouzuPaths, options: { env?: NodeJS.ProcessEnv; catalog?: CatalogBundle } = {}) {
		this.paths = paths;
		this.env = options.env ?? process.env;
		this.catalog = options.catalog ?? defaultCatalog();
	}

	list(): CatalogSource[] {
		return resolveCatalogSources(this.paths, this.env, { includeDisabled: true }, this.catalog);
	}

	/** True when the source is the code-owned built-in rather than a registry entry. */
	isCodeOwned(source: CatalogSource): boolean {
		return isCodeOwnedCatalogSource(this.paths, source, this.env, this.catalog);
	}

	private assertMutable(source: CatalogSource, operation: "edit" | "remove"): void {
		if (this.isCodeOwned(source)) {
			throw new CatalogSourceError(
				catalogText(this.catalog, SOURCE_MESSAGE_ID.builtinImmutable[operation], { label: source.label }),
			);
		}
	}

	private save(sources: CatalogSource[], beforeSave?: () => void): void {
		writeRegistry(this.paths, { schemaVersion: 1, sources }, beforeSave, this.catalog);
	}

	add(input: CatalogSourceInput, beforeSave?: (source: CatalogSource) => void): CatalogSource {
		const resolved = this.list();
		const label = controlFree(
			input.label,
			catalogText(this.catalog, SOURCE_MESSAGE_ID.contextSourceLabelBare),
			LABEL_MAX_BYTES,
			this.catalog,
		);
		const baseId = input.id ? normalizeSourceId(input.id, this.catalog) : sourceIdFromLabel(label);
		let id = baseId;
		let suffix = 2;
		while (resolved.some((source) => source.id === id)) {
			id = `${baseId.slice(0, Math.max(1, 63 - String(suffix).length))}-${suffix}`;
			suffix += 1;
		}
		const source = parseSource(
			{
				id,
				label,
				url: input.url,
				enabled: input.enabled ?? true,
				auth: input.auth,
			},
			resolved.length,
			this.catalog,
		);
		// Persist only user-managed sources; the code-owned built-in is never materialized.
		this.save([...resolveBaseCatalogSources(this.paths, this.env, this.catalog), source], () => beforeSave?.(source));
		return source;
	}

	update(
		id: string,
		input: Omit<CatalogSourceInput, "id">,
		beforeSave?: (source: CatalogSource) => void,
	): CatalogSource {
		const normalizedId = normalizeSourceId(id, this.catalog);
		const sources = resolveBaseCatalogSources(this.paths, this.env, this.catalog);
		const index = sources.findIndex((source) => source.id === normalizedId);
		if (index < 0) {
			const resolved = this.list().find((source) => source.id === normalizedId);
			if (resolved) this.assertMutable(resolved, "edit");
			throw new CatalogSourceError(
				catalogText(this.catalog, CatalogMessageId.catalogSourceNotFound, { id: normalizedId }),
			);
		}
		const source = parseSource(
			{ ...input, id: normalizedId, enabled: input.enabled ?? sources[index].enabled },
			index,
			this.catalog,
		);
		sources[index] = source;
		this.save(sources, () => beforeSave?.(source));
		// A source that no longer authenticates has no use for a saved token.
		if (source.auth.type === "none") removeCatalogSourceToken(this.paths, normalizedId, this.catalog);
		return source;
	}

	setEnabled(id: string, enabled: boolean): CatalogSource {
		const normalizedId = normalizeSourceId(id, this.catalog);
		const resolved = this.list();
		const source = resolved.find((candidate) => candidate.id === normalizedId);
		if (!source)
			throw new CatalogSourceError(
				catalogText(this.catalog, CatalogMessageId.catalogSourceNotFound, { id: normalizedId }),
			);
		if (this.isCodeOwned(source)) {
			// Store only the override; the descriptor and credential reference stay code-owned.
			// Returning to the descriptor default drops the override entirely.
			const overrides = { ...loadCatalogSourceOverrides(this.paths, this.catalog) };
			if (enabled === SHISA_API_CATALOG_SOURCE.enabled) delete overrides[source.id];
			else overrides[source.id] = { enabled };
			writeCatalogSourceOverrides(this.paths, overrides);
			return { ...source, enabled };
		}
		const sources = resolveBaseCatalogSources(this.paths, this.env, this.catalog);
		const index = sources.findIndex((candidate) => candidate.id === normalizedId);
		sources[index] = { ...sources[index], enabled };
		this.save(sources);
		return sources[index];
	}

	remove(id: string): CatalogSource {
		const normalizedId = normalizeSourceId(id, this.catalog);
		const sources = resolveBaseCatalogSources(this.paths, this.env, this.catalog);
		const index = sources.findIndex((source) => source.id === normalizedId);
		if (index < 0) {
			const resolved = this.list().find((source) => source.id === normalizedId);
			if (resolved) this.assertMutable(resolved, "remove");
			throw new CatalogSourceError(
				catalogText(this.catalog, CatalogMessageId.catalogSourceNotFound, { id: normalizedId }),
			);
		}
		const [removed] = sources.splice(index, 1);
		this.save(sources);
		// The saved token is scoped to this source id, so it goes with the source.
		removeCatalogSourceToken(this.paths, removed.id, this.catalog);
		return removed;
	}
}

export function resolveCatalogBearer(
	source: CatalogSource,
	env: NodeJS.ProcessEnv = process.env,
	paths?: JouzuPaths,
	catalog: CatalogBundle = defaultCatalog(),
): string | undefined {
	if (source.auth.type === "none") return undefined;
	if (paths && isShisaApiCatalogEndpoint(source, paths) && isShisaSignedOut(paths))
		throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.signedOut), "auth_required");
	const name = source.auth.credentialRef.slice(4);
	const fromEnv = envCredentialValue(source, env);
	if (fromEnv) return fromEnv;
	if (paths) {
		const stored = getCatalogSourceToken(paths, source.id, catalog);
		if (stored) return stored;
		const login = shisaLoginToken(source, paths);
		if (login) return login;
	}
	throw new CatalogSourceError(
		catalogText(catalog, paths ? CatalogMessageId.catalogTokenMissingWithSaved : CatalogMessageId.catalogTokenMissing, {
			name,
		}),
		"auth_required",
	);
}

export function catalogEndpointCandidates(input: string, catalog: CatalogBundle = defaultCatalog()): string[] {
	const exact = normalizeCatalogSourceUrl(input, catalog);
	const parsed = new URL(exact);
	const path = parsed.pathname.replace(/\/+$/u, "") || "/";
	let conventionalPath: string;
	if (path === "/") conventionalPath = "/v1/jouzu/model-catalog";
	else if (path.endsWith("/v1")) conventionalPath = `${path}/jouzu/model-catalog`;
	else if (path.endsWith("/v1/jouzu")) conventionalPath = `${path}/model-catalog`;
	else conventionalPath = `${path}/v1/jouzu/model-catalog`;
	const conventional = new URL(parsed.href);
	conventional.pathname = conventionalPath;
	const candidates = [exact, conventional.href];
	return [...new Set(candidates)];
}

export async function discoverCatalogEndpoint(
	input: string,
	options: CatalogEndpointDiscoveryOptions,
): Promise<CatalogEndpointDiscoveryResult> {
	const catalog = options.catalog ?? defaultCatalog();
	if (options.signal?.aborted) throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.discoveryCanceled));
	const candidates = catalogEndpointCandidates(input, catalog);
	const token =
		options.auth.type === "bearer"
			? options.bearerToken?.trim() ||
				resolveCatalogBearer(
					{ id: "discovery", label: "Catalog", url: candidates[0], enabled: true, auth: options.auth },
					options.env,
					undefined,
					catalog,
				)
			: undefined;
	const attempts: Array<{ url: string; result: string }> = [];
	// The first access failure drives the final diagnosis. It is recorded from the
	// response status, not from the rendered attempt text, so a localized attempt
	// result cannot change the control flow.
	let accessFailureStatus: string | undefined;
	for (const url of candidates) {
		if (options.signal?.aborted)
			throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.discoveryCanceled));
		const controller = new AbortController();
		const abort = () => controller.abort(options.signal?.reason);
		options.signal?.addEventListener("abort", abort, { once: true });
		const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
		try {
			const headers = new Headers({ Accept: MODEL_CATALOG_MEDIA_TYPE });
			if (token) headers.set("Authorization", `Bearer ${token}`);
			const response = await (options.fetch ?? globalThis.fetch)(url, {
				method: "GET",
				headers,
				redirect: "error",
				signal: controller.signal,
			});
			if (!response.ok) {
				if ((response.status === 401 || response.status === 403) && accessFailureStatus === undefined)
					accessFailureStatus = String(response.status);
				attempts.push({
					url,
					result: catalogText(catalog, CatalogMessageId.catalogAttemptHttp, { status: response.status }),
				});
				continue;
			}
			const mediaType = response.headers.get("content-type") ?? "";
			if (!mediaType.toLowerCase().startsWith(MODEL_CATALOG_MEDIA_TYPE)) {
				const detail = mediaType || catalogText(catalog, SOURCE_MESSAGE_ID.mediaTypeMissing);
				attempts.push({
					url,
					result: safeCatalogMessage(
						catalogText(catalog, SOURCE_MESSAGE_ID.unsupportedContentType, { mediaType: detail }),
						token,
					),
				});
				continue;
			}
			const text = await readBoundedResponseText(response, {
				maxBytes: MODEL_CATALOG_MAX_BYTES,
				tooLargeError: () => new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.responseTooLarge)),
			});
			const document = parseAndValidateModelCatalog(text, { remote: true });
			attempts.push({ url, result: catalogText(catalog, SOURCE_MESSAGE_ID.attemptValid) });
			return { url, document, text, etag: response.headers.get("etag") ?? undefined, attempts };
		} catch (error) {
			if (options.signal?.aborted)
				throw new CatalogSourceError(catalogText(catalog, SOURCE_MESSAGE_ID.discoveryCanceled));
			const message =
				error instanceof CatalogSourceError || error instanceof ModelCatalogError
					? safeCatalogMessage(error.message, token)
					: describeCatalogFailure(error, "network").message;
			attempts.push({
				url,
				result: controller.signal.aborted ? catalogText(catalog, CatalogMessageId.catalogAttemptTimedOut) : message,
			});
		} finally {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abort);
		}
	}
	if (accessFailureStatus !== undefined) {
		const status = accessFailureStatus;
		const name = options.auth.type === "bearer" ? options.auth.credentialRef.slice(4) : undefined;
		const messageId =
			status === "401"
				? name === undefined
					? CatalogMessageId.catalogDiscoveryAuthFailed
					: CatalogMessageId.catalogDiscoveryAuthFailedBearer
				: name === undefined
					? CatalogMessageId.catalogDiscoveryAccessDenied
					: CatalogMessageId.catalogDiscoveryAccessDeniedBearer;
		throw new CatalogSourceError(catalogText(catalog, messageId, name === undefined ? { status } : { status, name }));
	}
	throw new CatalogSourceError(
		catalogText(catalog, SOURCE_MESSAGE_ID.noCatalogFound, {
			attempts: attempts.map((attempt) => `${attempt.url}: ${attempt.result}`).join("; "),
		}),
	);
}
