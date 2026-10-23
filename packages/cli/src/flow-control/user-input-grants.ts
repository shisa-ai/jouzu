import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { parseStrictJson } from "../model-catalog.js";
import { PrivatePathError, validatePrivateDirectory } from "../private-fs.js";

/**
 * Bounded authorization for extension user-input adapters.
 *
 * The user owns `user-input-adapters.json` in the resolved agent configuration
 * directory. Each grant names one exact canonical extension entry path and one
 * adapter ID. Nothing else authorizes input: there is no project-local grant,
 * glob, prefix match, or caller-supplied identity, and the file is read again on
 * every check so a revocation takes effect immediately.
 *
 * A grant authorizes the installed code at that path. It is not a code-signing
 * mechanism and it does not sandbox the extension, because installed extensions
 * already run with the user's OS permissions. This module only answers whether
 * the loader-assigned extension identity and adapter ID may use the host's
 * user-input admission path.
 */

/** File name inside the resolved agent configuration directory. */
export const USER_INPUT_ADAPTERS_FILE = "user-input-adapters.json";
/** Ceiling on the whole file, matching other bounded Jouzu-owned configuration. */
export const USER_INPUT_ADAPTERS_MAX_BYTES = 64 * 1024;

const MAX_GRANTS = 64;
const MAX_PATH_BYTES = 4096;
const ADAPTER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const FILE_KEYS: readonly string[] = ["schemaVersion", "grants"];
const GRANT_KEYS: readonly string[] = ["extensionPath", "adapterId"];
const GLOB_CHARACTERS: readonly string[] = ["*", "?", "[", "]", "{", "}"];

export interface UserInputAdapterGrant {
	/** Canonical path the grant authorizes. */
	readonly extensionPath: string;
	readonly adapterId: string;
}

export type UserInputGrantDecision =
	| { readonly authorized: true; readonly grant: UserInputAdapterGrant }
	/** `unauthorized` means no grant matched; `invalid-config` means the file itself is unusable. */
	| { readonly authorized: false; readonly code: "unauthorized" | "invalid-config"; readonly reason: string };

export interface UserInputGrantCheckOptions {
	/** Resolved Jouzu agent configuration directory that holds the grants file. */
	agentDir: string;
	/**
	 * Path the extension loader assigned to the registering extension. Callers
	 * must pass the loader value and never an identity taken from a submission
	 * payload, remote client, or model output.
	 */
	loaderExtensionPath: string;
	/** Adapter ID the extension registers under. */
	adapterId: string;
}

class GrantConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GrantConfigError";
	}
}

interface ParsedGrant {
	readonly adapterId: string;
	/** Canonical installed path, or the lexical path while the grant is stale. */
	readonly identity: string;
}

type GrantsFileRead =
	| { readonly kind: "absent" }
	| { readonly kind: "invalid"; readonly reason: string }
	| { readonly kind: "grants"; readonly grants: readonly ParsedGrant[] };

export function userInputAdapterGrantsPath(agentDir: string): string {
	return join(agentDir, USER_INPUT_ADAPTERS_FILE);
}

function deny(code: "unauthorized" | "invalid-config", reason: string): UserInputGrantDecision {
	return { authorized: false, code, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * A grant entry must already be lexically canonical so the file states exactly
 * one path per entry. Separator style is tolerated because Windows accepts both
 * forms, but `.`/`..` segments, repeated separators, and trailing separators are
 * not.
 */
function isCanonicalAbsolutePath(value: string): boolean {
	if (!isAbsolute(value)) return false;
	if (value.endsWith("/") || value.endsWith("\\")) return false;
	return normalize(value).replaceAll("\\", "/") === value.replaceAll("\\", "/");
}

function entryPathAt(value: unknown, index: number): string {
	if (typeof value !== "string") throw new GrantConfigError(`grants[${index}].extensionPath must be a string`);
	if (Buffer.byteLength(value) > MAX_PATH_BYTES)
		throw new GrantConfigError(`grants[${index}].extensionPath must be at most ${MAX_PATH_BYTES} bytes`);
	if (value.includes("\0")) throw new GrantConfigError(`grants[${index}].extensionPath must not contain NUL`);
	if (GLOB_CHARACTERS.some((character) => value.includes(character)))
		throw new GrantConfigError(`grants[${index}].extensionPath must not contain glob characters`);
	if (!isAbsolute(value)) throw new GrantConfigError(`grants[${index}].extensionPath must be an absolute path`);
	if (!isCanonicalAbsolutePath(value))
		throw new GrantConfigError(`grants[${index}].extensionPath must be a canonical path`);
	return value;
}

function adapterIdAt(value: unknown, index: number): string {
	if (typeof value !== "string") throw new GrantConfigError(`grants[${index}].adapterId must be a string`);
	if (!ADAPTER_ID_PATTERN.test(value))
		throw new GrantConfigError(`grants[${index}].adapterId must be a bounded lowercase identifier`);
	return value;
}

async function installedIdentity(path: string): Promise<string | undefined> {
	try {
		return await realpath(path);
	} catch {
		return undefined;
	}
}

async function parseGrants(value: unknown): Promise<readonly ParsedGrant[]> {
	if (!isRecord(value)) throw new GrantConfigError("user-input adapter grants must be a JSON object");
	const unknownKeys = Object.keys(value).filter((key) => !FILE_KEYS.includes(key));
	if (unknownKeys.length > 0)
		throw new GrantConfigError(`user-input adapter grants contain an unknown field: ${unknownKeys[0]}`);
	if (value.schemaVersion !== 1) throw new GrantConfigError("user-input adapter grants require schemaVersion 1");
	const entries = value.grants;
	if (!Array.isArray(entries)) throw new GrantConfigError("user-input adapter grants require a grants array");
	if (entries.length > MAX_GRANTS)
		throw new GrantConfigError(`user-input adapter grants allow at most ${MAX_GRANTS} entries`);
	const seen = new Set<string>();
	const grants: ParsedGrant[] = [];
	for (const [index, entry] of entries.entries()) {
		if (!isRecord(entry)) throw new GrantConfigError(`grants[${index}] must be an object`);
		const unknown = Object.keys(entry).filter((key) => !GRANT_KEYS.includes(key));
		if (unknown.length > 0) throw new GrantConfigError(`grants[${index}] contains an unknown field: ${unknown[0]}`);
		const extensionPath = entryPathAt(entry.extensionPath, index);
		const adapterId = adapterIdAt(entry.adapterId, index);
		// A stale grant keeps its lexical path and simply never matches an
		// installed identity; it must not deny authorization to other adapters.
		const identity = (await installedIdentity(extensionPath)) ?? extensionPath;
		const key = `${identity}\0${adapterId}`;
		if (seen.has(key))
			throw new GrantConfigError(
				`grants[${index}] duplicates an earlier grant for the same extension path and adapter ID`,
			);
		seen.add(key);
		grants.push(Object.freeze({ adapterId, identity }));
	}
	return Object.freeze(grants);
}

/** Read one bounded regular-file snapshot without following a swapped symlink. */
async function readBoundedRegularFile(path: string, expected: { dev: number; ino: number }): Promise<string> {
	const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const opened = await file.stat();
		if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino)
			throw new GrantConfigError("user-input adapter grants must be a real regular file");
		const buffer = Buffer.alloc(USER_INPUT_ADAPTERS_MAX_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > USER_INPUT_ADAPTERS_MAX_BYTES)
			throw new GrantConfigError(
				`user-input adapter grants must be no larger than ${USER_INPUT_ADAPTERS_MAX_BYTES} bytes`,
			);
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
	} finally {
		await file.close();
	}
}

async function readGrantsFile(agentDir: string): Promise<GrantsFileRead> {
	try {
		validatePrivateDirectory(agentDir);
	} catch (error) {
		if (error instanceof PrivatePathError)
			return { kind: "invalid", reason: "the agent configuration directory must be a real directory" };
		return { kind: "invalid", reason: "the agent configuration directory could not be inspected" };
	}
	const path = userInputAdapterGrantsPath(agentDir);
	let before: Stats;
	try {
		before = await lstat(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
		return { kind: "invalid", reason: "user-input adapter grants could not be inspected" };
	}
	if (before.isSymbolicLink() || !before.isFile())
		return { kind: "invalid", reason: "user-input adapter grants must be a real regular file" };
	if (before.size > USER_INPUT_ADAPTERS_MAX_BYTES)
		return {
			kind: "invalid",
			reason: `user-input adapter grants must be no larger than ${USER_INPUT_ADAPTERS_MAX_BYTES} bytes`,
		};
	let text: string;
	try {
		text = await readBoundedRegularFile(path, before);
	} catch (error) {
		if (error instanceof GrantConfigError) return { kind: "invalid", reason: error.message };
		return { kind: "invalid", reason: "user-input adapter grants must be readable UTF-8" };
	}
	try {
		return { kind: "grants", grants: await parseGrants(parseStrictJson(text)) };
	} catch (error) {
		return { kind: "invalid", reason: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Decide whether the loader-assigned extension identity may act as this adapter.
 *
 * The grants file is read on every call, so a revoked or edited grant applies to
 * the next submit, lookup, or retained dispatch. A missing file denies.
 */
export async function checkUserInputAdapterGrant(options: UserInputGrantCheckOptions): Promise<UserInputGrantDecision> {
	const agentDir = options?.agentDir;
	if (typeof agentDir !== "string" || !isAbsolute(agentDir))
		return deny("invalid-config", "the agent configuration directory is not an absolute path");
	const adapterId = options?.adapterId;
	if (typeof adapterId !== "string" || !ADAPTER_ID_PATTERN.test(adapterId))
		return deny("unauthorized", "the adapter ID is not a bounded lowercase identifier");
	const loaderExtensionPath = options?.loaderExtensionPath;
	if (
		typeof loaderExtensionPath !== "string" ||
		Buffer.byteLength(loaderExtensionPath) > MAX_PATH_BYTES ||
		!isAbsolute(loaderExtensionPath)
	)
		return deny("unauthorized", "the extension identity is not an absolute loader path");
	const loaded = await readGrantsFile(agentDir);
	if (loaded.kind === "invalid") return deny("invalid-config", loaded.reason);
	if (loaded.kind === "absent") return deny("unauthorized", "no user-input adapter grants are configured");
	const identity = await installedIdentity(loaderExtensionPath);
	if (!identity) return deny("unauthorized", "the extension identity does not resolve to an installed entry path");
	const grant = loaded.grants.find((candidate) => candidate.adapterId === adapterId && candidate.identity === identity);
	if (!grant) return deny("unauthorized", "no grant authorizes this extension path and adapter ID");
	return { authorized: true, grant: Object.freeze({ extensionPath: grant.identity, adapterId: grant.adapterId }) };
}
