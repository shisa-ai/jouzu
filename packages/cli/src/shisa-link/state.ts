import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JouzuPaths } from "../paths.js";
import { writeFilePrivateAtomic } from "../private-fs.js";

/**
 * Private link state for the Shisa device-flow login. The file lives in the
 * Jouzu state directory and is written with private-file semantics (mode 0600
 * via `writeFilePrivateAtomic`). `link_token` is a secret and must never
 * appear in logs, error messages, or diagnostics.
 */

export interface ShisaOrg {
	id: string;
	name: string;
	slug: string;
}

export interface ShisaLinkEndpoints {
	openai_base_url: string;
	model_catalog_url: string;
	asr_realtime_url: string;
}

/** Credits bonus offer data from the login response; presented by the account UI, never logged. */
export interface ShisaBonus {
	status: string;
	amount_usd?: number;
}

export interface ShisaLinkState {
	/** Stable per-device identifier the platform uses to offer key replacement on reconnect. */
	install_id: string;
	/** Opaque, non-secret support-correlation identifier from the login response. */
	authorization_id: string;
	api_key_uuid: string;
	org: ShisaOrg;
	endpoints: ShisaLinkEndpoints;
	link_token: string;
	/** Whether the device-link acknowledgement has been confirmed by the platform. */
	acked: boolean;
	/** Present when the login response carried a credits bonus offer. */
	bonus?: ShisaBonus;
}

const STATE_FILE_NAME = "shisa-link.json";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function shisaLinkStatePath(paths: Pick<JouzuPaths, "stateDir">): string {
	return join(paths.stateDir, STATE_FILE_NAME);
}

/** Fresh random install identifier; callers persist it with the link state. */
export function newShisaInstallId(): string {
	return randomUUID();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseOrg(value: unknown): ShisaOrg | undefined {
	if (!isRecord(value)) return undefined;
	const id = requiredString(value.id);
	const name = requiredString(value.name);
	const slug = requiredString(value.slug);
	return id && name && slug ? { id, name, slug } : undefined;
}

function parseEndpoints(value: unknown): ShisaLinkEndpoints | undefined {
	if (!isRecord(value)) return undefined;
	const openaiBaseUrl = requiredString(value.openai_base_url);
	const modelCatalogUrl = requiredString(value.model_catalog_url);
	const asrRealtimeUrl = requiredString(value.asr_realtime_url);
	return openaiBaseUrl && modelCatalogUrl && asrRealtimeUrl
		? { openai_base_url: openaiBaseUrl, model_catalog_url: modelCatalogUrl, asr_realtime_url: asrRealtimeUrl }
		: undefined;
}

function parseBonus(value: unknown): ShisaBonus | undefined {
	if (!isRecord(value) || typeof value.status !== "string") return undefined;
	return typeof value.amount_usd === "number"
		? { status: value.status, amount_usd: value.amount_usd }
		: { status: value.status };
}

/** Validate an untrusted value as link state; undefined when the shape is not usable. */
export function parseShisaLinkState(value: unknown): ShisaLinkState | undefined {
	if (!isRecord(value)) return undefined;
	const installId = requiredString(value.install_id);
	const authorizationId = requiredString(value.authorization_id);
	const apiKeyUuid = requiredString(value.api_key_uuid);
	const linkToken = requiredString(value.link_token);
	const org = parseOrg(value.org);
	const endpoints = parseEndpoints(value.endpoints);
	if (!installId || !authorizationId || !apiKeyUuid || !linkToken || !org || !endpoints) return undefined;
	if (!UUID_PATTERN.test(installId)) return undefined;
	if (typeof value.acked !== "boolean") return undefined;
	const bonus = value.bonus === undefined ? undefined : parseBonus(value.bonus);
	if (value.bonus !== undefined && !bonus) return undefined;
	return {
		install_id: installId,
		authorization_id: authorizationId,
		api_key_uuid: apiKeyUuid,
		org,
		endpoints,
		link_token: linkToken,
		acked: value.acked,
		...(bonus ? { bonus } : {}),
	};
}

/**
 * Load the link state, resolving to undefined when the file is absent or not
 * a usable state object. Reads never throw and never surface file contents.
 */
export function readShisaLinkState(path: string): ShisaLinkState | undefined {
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	try {
		return parseShisaLinkState(JSON.parse(contents));
	} catch {
		return undefined;
	}
}

/**
 * Persist the link state atomically with private-file semantics. Resolves once
 * the write has completed, so callers can order follow-up work (such as the
 * device-link acknowledgement) behind it.
 */
export async function writeShisaLinkState(
	path: string,
	state: ShisaLinkState,
	root: string = dirname(path),
): Promise<void> {
	if (parseShisaLinkState(state) === undefined) {
		throw new Error("Refusing to write incomplete Shisa link state");
	}
	writeFilePrivateAtomic(path, `${JSON.stringify(state, null, 2)}\n`, root);
}

/** Remove the link state file, if present. */
export function clearShisaLinkState(path: string): void {
	rmSync(path, { force: true });
}
