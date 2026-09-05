import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { readBoundedResponseText } from "./bounded-response.js";
import {
	MODEL_CATALOG_MAX_BYTES,
	MODEL_CATALOG_MEDIA_TYPE,
	type ModelCatalogDocument,
	parseAndValidateModelCatalog,
	parseStrictJson,
} from "./model-catalog.js";
import type { JouzuPaths } from "./paths.js";
import { validatePrivateDirectory, writeFilePrivateAtomic } from "./private-fs.js";

const REGISTRY_MAX_BYTES = 256 * 1024;
const OVERRIDES_MAX_BYTES = 64 * 1024;
const LABEL_MAX_BYTES = 256;
const SOURCE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const DISCOVERY_TIMEOUT_MS = 10_000;

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

export interface CatalogEndpointDiscoveryOptions {
	auth: CatalogSourceAuth;
	env?: NodeJS.ProcessEnv;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
}

export interface CatalogEndpointDiscoveryResult {
	url: string;
	document: ModelCatalogDocument;
	attempts: Array<{ url: string; result: string }>;
}

export class CatalogSourceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CatalogSourceError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], context: string): void {
	const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) throw new CatalogSourceError(`${context} contains unknown field: ${unknown[0]}`);
}

function controlFree(value: string, context: string, maxBytes: number): string {
	const trimmed = value.trim();
	const hasControl = Array.from(trimmed).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
	});
	if (!trimmed || Buffer.byteLength(trimmed) > maxBytes || hasControl) {
		throw new CatalogSourceError(`${context} must be non-empty, bounded, and control-free`);
	}
	return trimmed;
}

function normalizeSourceId(value: string): string {
	const id = value.trim().toLowerCase();
	if (!SOURCE_ID_PATTERN.test(id)) {
		throw new CatalogSourceError(
			"catalog source id must use 1-64 lowercase letters, numbers, dots, dashes, or underscores",
		);
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

function parseAuth(value: unknown, context: string): CatalogSourceAuth {
	if (!isRecord(value)) throw new CatalogSourceError(`${context} must be an object`);
	if (value.type === "none") {
		assertOnlyKeys(value, ["type"], context);
		return { type: "none" };
	}
	if (value.type === "bearer") {
		assertOnlyKeys(value, ["type", "credentialRef"], context);
		if (typeof value.credentialRef !== "string" || !value.credentialRef.startsWith("env:")) {
			throw new CatalogSourceError(`${context} bearer auth requires an environment credential reference`);
		}
		const name = value.credentialRef.slice(4);
		if (!ENV_NAME_PATTERN.test(name)) {
			throw new CatalogSourceError(`${context} has an invalid environment credential reference`);
		}
		return { type: "bearer", credentialRef: `env:${name}` };
	}
	throw new CatalogSourceError(`${context}.type must be none or bearer`);
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

export function normalizeCatalogSourceUrl(value: string): string {
	const input = controlFree(value, "catalog source URL", 2048);
	let parsed: URL;
	try {
		parsed = new URL(inferScheme(input));
	} catch {
		throw new CatalogSourceError("catalog source URL must be an absolute HTTP(S) URL or host");
	}
	if (parsed.username || parsed.password)
		throw new CatalogSourceError("catalog source URL must not contain credentials");
	if (parsed.hash || parsed.search)
		throw new CatalogSourceError("catalog source URL must not contain a query or fragment");
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost(parsed))) {
		throw new CatalogSourceError("catalog source URL must use HTTPS except for localhost development");
	}
	return parsed.href;
}

function parseSource(value: unknown, index: number): CatalogSource {
	if (!isRecord(value)) throw new CatalogSourceError(`catalog source ${index + 1} must be an object`);
	assertOnlyKeys(value, ["id", "label", "url", "enabled", "auth"], `catalog source ${index + 1}`);
	if (typeof value.id !== "string" || typeof value.label !== "string" || typeof value.url !== "string") {
		throw new CatalogSourceError(`catalog source ${index + 1} requires id, label, and url strings`);
	}
	if (typeof value.enabled !== "boolean")
		throw new CatalogSourceError(`catalog source ${index + 1}.enabled must be boolean`);
	return {
		id: normalizeSourceId(value.id),
		label: controlFree(value.label, `catalog source ${index + 1} label`, LABEL_MAX_BYTES),
		url: normalizeCatalogSourceUrl(value.url),
		enabled: value.enabled,
		auth: parseAuth(value.auth, `catalog source ${index + 1}.auth`),
	};
}

function validateRegistry(value: unknown): CatalogSourceRegistry {
	if (!isRecord(value)) throw new CatalogSourceError("catalog source registry must be an object");
	assertOnlyKeys(value, ["schemaVersion", "sources"], "catalog source registry");
	if (value.schemaVersion !== 1 || !Array.isArray(value.sources)) {
		throw new CatalogSourceError("catalog source registry requires schemaVersion 1 and a sources array");
	}
	const sources = value.sources.map(parseSource);
	const ids = new Set<string>();
	const urls = new Set<string>();
	for (const source of sources) {
		if (ids.has(source.id)) throw new CatalogSourceError(`duplicate catalog source id: ${source.id}`);
		if (urls.has(source.url)) throw new CatalogSourceError(`duplicate catalog source URL: ${source.url}`);
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

export function loadCatalogSourceRegistry(paths: JouzuPaths): CatalogSourceRegistry {
	const path = catalogSourceRegistryPath(paths);
	if (!existsSync(path)) return { schemaVersion: 1, sources: [] };
	validatePrivateDirectory(configurationRoot(paths));
	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > REGISTRY_MAX_BYTES) {
		throw new CatalogSourceError("catalog source registry must be a bounded regular file");
	}
	try {
		return validateRegistry(parseStrictJson(readFileSync(path, "utf8")));
	} catch (error) {
		if (error instanceof CatalogSourceError) throw error;
		throw new CatalogSourceError(error instanceof Error ? error.message : String(error));
	}
}

function environmentSource(env: NodeJS.ProcessEnv): CatalogSource | undefined {
	const url = env.JOUZU_MODEL_CATALOG_URL?.trim();
	if (!url) return undefined;
	const token = env.JOUZU_MODEL_CATALOG_TOKEN?.trim();
	return {
		id: "default",
		label: "Environment catalog",
		url: normalizeCatalogSourceUrl(url),
		enabled: true,
		auth: token ? { type: "bearer", credentialRef: "env:JOUZU_MODEL_CATALOG_TOKEN" } : { type: "none" },
	};
}

export function catalogSourceOverridesPath(paths: JouzuPaths): string {
	return join(configurationRoot(paths), "catalog-overrides.json");
}

function parseOverride(value: unknown, id: string): CatalogSourceOverride {
	if (!isRecord(value)) throw new CatalogSourceError(`catalog source override ${id} must be an object`);
	assertOnlyKeys(value, ["enabled"], `catalog source override ${id}`);
	if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
		throw new CatalogSourceError(`catalog source override ${id}.enabled must be boolean`);
	}
	return value.enabled === undefined ? {} : { enabled: value.enabled };
}

export function loadCatalogSourceOverrides(paths: JouzuPaths): Record<string, CatalogSourceOverride> {
	const path = catalogSourceOverridesPath(paths);
	if (!existsSync(path)) return {};
	validatePrivateDirectory(configurationRoot(paths));
	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > OVERRIDES_MAX_BYTES) {
		throw new CatalogSourceError("catalog source overrides must be a bounded regular file");
	}
	let value: unknown;
	try {
		value = parseStrictJson(readFileSync(path, "utf8"));
	} catch (error) {
		throw new CatalogSourceError(error instanceof Error ? error.message : String(error));
	}
	if (!isRecord(value)) throw new CatalogSourceError("catalog source overrides must be an object");
	assertOnlyKeys(value, ["schemaVersion", "overrides"], "catalog source overrides");
	if (value.schemaVersion !== 1 || !isRecord(value.overrides)) {
		throw new CatalogSourceError("catalog source overrides require schemaVersion 1 and an overrides object");
	}
	const overrides: Record<string, CatalogSourceOverride> = {};
	for (const [id, override] of Object.entries(value.overrides)) {
		overrides[normalizeSourceId(id)] = parseOverride(override, id);
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

/** True when a source targets the built-in Shisa API endpoint and credential reference. */
export function isShisaApiCatalogEndpoint(source: CatalogSource): boolean {
	return source.url === SHISA_API_CATALOG_SOURCE.url && sameAuth(source.auth, SHISA_API_CATALOG_SOURCE.auth);
}

/** True when a source is the built-in descriptor itself (reserved id plus exact endpoint and credential). */
export function isBuiltinCatalogSource(source: CatalogSource): boolean {
	return source.id === SHISA_API_CATALOG_SOURCE_ID && isShisaApiCatalogEndpoint(source);
}

/** Explains why a user-registered source claiming the reserved id blocks the built-in source. */
export function catalogSourceConflict(source: CatalogSource): string | undefined {
	if (source.id !== SHISA_API_CATALOG_SOURCE_ID || isBuiltinCatalogSource(source)) return undefined;
	return `source id "${SHISA_API_CATALOG_SOURCE_ID}" is reserved for the built-in Shisa API catalog (${SHISA_API_CATALOG_SOURCE.url}, env:${SHISA_API_CATALOG_CREDENTIAL_ENV}); this entry points elsewhere, so the built-in source stays inactive`;
}

export function catalogSourceCredentialName(source: CatalogSource): string | undefined {
	return source.auth.type === "bearer" ? source.auth.credentialRef.slice(4) : undefined;
}

export function catalogSourceCredentialAvailable(source: CatalogSource, env: NodeJS.ProcessEnv): boolean {
	const name = catalogSourceCredentialName(source);
	if (!name) return true;
	const value = env[name];
	return typeof value === "string" && Boolean(value.trim());
}

/** Sources from the user registry, or the single-source environment shorthand when no registry exists. */
function resolveBaseCatalogSources(paths: JouzuPaths, env: NodeJS.ProcessEnv): CatalogSource[] {
	if (catalogSourceRegistryExists(paths)) return loadCatalogSourceRegistry(paths).sources;
	const shorthand = environmentSource(env);
	return shorthand ? [shorthand] : [];
}

/** True when the built-in descriptor is supplied by code rather than a user registry entry. */
export function isCodeOwnedCatalogSource(paths: JouzuPaths, source: CatalogSource, env: NodeJS.ProcessEnv): boolean {
	return (
		isBuiltinCatalogSource(source) &&
		!resolveBaseCatalogSources(paths, env).some((candidate) => candidate.id === source.id)
	);
}

export function resolveCatalogSources(
	paths: JouzuPaths,
	env: NodeJS.ProcessEnv = process.env,
	options: ResolveCatalogSourcesOptions = {},
): CatalogSource[] {
	const base = resolveBaseCatalogSources(paths, env);
	const override = loadCatalogSourceOverrides(paths)[SHISA_API_CATALOG_SOURCE_ID];
	const builtin: CatalogSource =
		override?.enabled === undefined
			? SHISA_API_CATALOG_SOURCE
			: { ...SHISA_API_CATALOG_SOURCE, enabled: override.enabled };
	// A registry entry with the reserved id, or any entry targeting the same endpoint and
	// credential, is the user's own registration of the built-in source. It keeps its label,
	// enabled state, and URL-keyed cache, and the code-owned descriptor stays out of the way.
	const claimed = base.some((source) => source.id === SHISA_API_CATALOG_SOURCE_ID || isShisaApiCatalogEndpoint(source));
	const sources = claimed ? base : [builtin, ...base];
	return options.includeDisabled ? sources : sources.filter((source) => source.enabled);
}

function writeRegistry(paths: JouzuPaths, registry: CatalogSourceRegistry): void {
	const validated = validateRegistry(registry);
	writeFilePrivateAtomic(
		catalogSourceRegistryPath(paths),
		`${JSON.stringify(validated, null, 2)}\n`,
		configurationRoot(paths),
	);
}

export class CatalogSourceStore {
	private readonly paths: JouzuPaths;
	private readonly env: NodeJS.ProcessEnv;

	constructor(paths: JouzuPaths, options: { env?: NodeJS.ProcessEnv } = {}) {
		this.paths = paths;
		this.env = options.env ?? process.env;
	}

	list(): CatalogSource[] {
		return resolveCatalogSources(this.paths, this.env, { includeDisabled: true });
	}

	/** True when the source is the code-owned built-in rather than a registry entry. */
	isCodeOwned(source: CatalogSource): boolean {
		return isCodeOwnedCatalogSource(this.paths, source, this.env);
	}

	private assertMutable(source: CatalogSource, operation: "edit" | "remove"): void {
		if (this.isCodeOwned(source)) {
			throw new CatalogSourceError(
				`cannot ${operation} the built-in ${source.label} catalog source; it can only be enabled or disabled`,
			);
		}
	}

	private save(sources: CatalogSource[]): void {
		writeRegistry(this.paths, { schemaVersion: 1, sources });
	}

	add(input: CatalogSourceInput): CatalogSource {
		const resolved = this.list();
		const label = controlFree(input.label, "catalog source label", LABEL_MAX_BYTES);
		const baseId = input.id ? normalizeSourceId(input.id) : sourceIdFromLabel(label);
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
		);
		// Persist only user-managed sources; the code-owned built-in is never materialized.
		this.save([...resolveBaseCatalogSources(this.paths, this.env), source]);
		return source;
	}

	update(id: string, input: Omit<CatalogSourceInput, "id">): CatalogSource {
		const normalizedId = normalizeSourceId(id);
		const sources = resolveBaseCatalogSources(this.paths, this.env);
		const index = sources.findIndex((source) => source.id === normalizedId);
		if (index < 0) {
			const resolved = this.list().find((source) => source.id === normalizedId);
			if (resolved) this.assertMutable(resolved, "edit");
			throw new CatalogSourceError(`catalog source not found: ${normalizedId}`);
		}
		const source = parseSource({ ...input, id: normalizedId, enabled: input.enabled ?? sources[index].enabled }, index);
		sources[index] = source;
		this.save(sources);
		return source;
	}

	setEnabled(id: string, enabled: boolean): CatalogSource {
		const normalizedId = normalizeSourceId(id);
		const resolved = this.list();
		const source = resolved.find((candidate) => candidate.id === normalizedId);
		if (!source) throw new CatalogSourceError(`catalog source not found: ${normalizedId}`);
		if (this.isCodeOwned(source)) {
			// Store only the override; the descriptor and credential reference stay code-owned.
			// Returning to the descriptor default drops the override entirely.
			const overrides = { ...loadCatalogSourceOverrides(this.paths) };
			if (enabled === SHISA_API_CATALOG_SOURCE.enabled) delete overrides[source.id];
			else overrides[source.id] = { enabled };
			writeCatalogSourceOverrides(this.paths, overrides);
			return { ...source, enabled };
		}
		const sources = resolveBaseCatalogSources(this.paths, this.env);
		const index = sources.findIndex((candidate) => candidate.id === normalizedId);
		sources[index] = { ...sources[index], enabled };
		this.save(sources);
		return sources[index];
	}

	remove(id: string): CatalogSource {
		const normalizedId = normalizeSourceId(id);
		const sources = resolveBaseCatalogSources(this.paths, this.env);
		const index = sources.findIndex((source) => source.id === normalizedId);
		if (index < 0) {
			const resolved = this.list().find((source) => source.id === normalizedId);
			if (resolved) this.assertMutable(resolved, "remove");
			throw new CatalogSourceError(`catalog source not found: ${normalizedId}`);
		}
		const [removed] = sources.splice(index, 1);
		this.save(sources);
		return removed;
	}
}

export function resolveCatalogBearer(source: CatalogSource, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (source.auth.type === "none") return undefined;
	const name = source.auth.credentialRef.slice(4);
	const credential = env[name];
	const value = typeof credential === "string" ? credential.trim() : "";
	if (!value) {
		throw new CatalogSourceError(
			`Catalog token variable ${name} is not set in this Jouzu process. Export it before starting Jouzu, then retry.`,
		);
	}
	return value;
}

export function catalogEndpointCandidates(input: string): string[] {
	const exact = normalizeCatalogSourceUrl(input);
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
	if (options.signal?.aborted) throw new CatalogSourceError("Catalog endpoint discovery was canceled.");
	const candidates = catalogEndpointCandidates(input);
	const token =
		options.auth.type === "bearer"
			? resolveCatalogBearer(
					{ id: "discovery", label: "Catalog", url: candidates[0], enabled: true, auth: options.auth },
					options.env,
				)
			: undefined;
	const attempts: Array<{ url: string; result: string }> = [];
	for (const url of candidates) {
		if (options.signal?.aborted) throw new CatalogSourceError("Catalog endpoint discovery was canceled.");
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
				attempts.push({ url, result: `HTTP ${response.status}` });
				continue;
			}
			const mediaType = response.headers.get("content-type") ?? "";
			if (!mediaType.toLowerCase().startsWith(MODEL_CATALOG_MEDIA_TYPE)) {
				attempts.push({ url, result: `unsupported Content-Type ${mediaType || "missing"}` });
				continue;
			}
			const text = await readBoundedResponseText(response, {
				maxBytes: MODEL_CATALOG_MAX_BYTES,
				tooLargeError: () => new CatalogSourceError("catalog response exceeds 16 MiB"),
			});
			const document = parseAndValidateModelCatalog(text, { remote: true });
			attempts.push({ url, result: "valid" });
			return { url, document, attempts };
		} catch (error) {
			if (options.signal?.aborted) throw new CatalogSourceError("Catalog endpoint discovery was canceled.");
			const message = error instanceof Error ? error.message : String(error);
			attempts.push({ url, result: controller.signal.aborted ? "timed out" : message });
		} finally {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abort);
		}
	}
	const accessFailure = attempts.find((attempt) => attempt.result === "HTTP 401" || attempt.result === "HTTP 403");
	if (accessFailure) {
		const status = accessFailure.result.slice(5);
		const summary = status === "401" ? "Catalog authentication failed" : "Catalog access was denied";
		if (options.auth.type === "bearer") {
			const name = options.auth.credentialRef.slice(4);
			throw new CatalogSourceError(
				`${summary} (HTTP ${status}). Check that ${name} contains a bearer token accepted by the catalog.`,
			);
		}
		throw new CatalogSourceError(
			`${summary} (HTTP ${status}). Configure bearer-token authentication if this catalog requires it.`,
		);
	}
	throw new CatalogSourceError(
		`No Jouzu catalog found. Attempts: ${attempts.map((attempt) => `${attempt.url}: ${attempt.result}`).join("; ")}`,
	);
}
