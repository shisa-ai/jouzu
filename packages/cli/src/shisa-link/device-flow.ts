import { hostname } from "node:os";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ShisaLinkState } from "./state.js";

/**
 * Shisa platform device-flow login (frozen v0.3 contract).
 *
 * A person runs the login flow, approves "Jouzu" in their browser, and this
 * CLI receives a dedicated Shisa API key plus a link_token used for account
 * status and revocation. The gateway base URL defaults to
 * https://gateway.shisa.ai and can be overridden with
 * JOUZU_SHISA_PLATFORM_URL.
 *
 * Secret hygiene: device_code, link_token, and the API key secret never
 * appear in log output, error messages, or diagnostics. user_code is shown
 * to the user through the login UI but is also never logged.
 */

export const SHISA_CLIENT_ID = "jouzu";
export const DEFAULT_SHISA_GATEWAY_URL = "https://gateway.shisa.ai";

const DEVICE_CODE_PATH = "/device/code";
const DEVICE_TOKEN_PATH = "/device/token";
const DEVICE_LINK_ACK_PATH = "/device/link/ack";
const REQUEST_TIMEOUT_MS = 30_000;
const RATE_LIMIT_BACKOFF_CAP_MS = 60_000;
const ACK_ATTEMPTS = 3;
const ACK_RETRY_DELAY_MS = 2_000;
// RFC 8628 section 3.2: without a server interval, poll every 5 seconds.
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRES_IN_SECONDS = 900;
// RFC 8628 section 3.5: slow_down raises the polling interval by 5 seconds.
const SLOW_DOWN_INCREMENT_SECONDS = 5;
const MINIMUM_POLL_INTERVAL_MS = 1000;

/** Resolve the platform gateway base URL without a trailing slash. */
export function resolveShisaGatewayUrl(env: NodeJS.ProcessEnv = process.env): string {
	const raw = env.JOUZU_SHISA_PLATFORM_URL?.trim();
	if (!raw) return DEFAULT_SHISA_GATEWAY_URL;
	return raw.replace(/\/+$/u, "");
}

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

export interface ShisaDeviceCode {
	/** Secret. Kept in memory only until the link acknowledgement settles. */
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	verificationUriQr?: string;
	authorizationId: string;
	expiresInSeconds: number;
	intervalSeconds: number;
}

export interface ShisaTokenApiKey {
	uuid: string;
	secret: string;
	label?: string;
}

export interface ShisaTokenResponse {
	api_key: ShisaTokenApiKey;
	org: ShisaOrg;
	user: { email: string };
	endpoints: ShisaLinkEndpoints;
	link_token: string;
	authorization_id: string;
	urls: Record<string, string>;
	bonus?: { status: string; amount_usd?: number };
	balance?: unknown;
	rate_limit?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(value: Record<string, unknown>, key: string): string | undefined {
	const entry = value[key];
	return typeof entry === "string" && entry.length > 0 ? entry : undefined;
}

function numberAt(value: Record<string, unknown>, key: string): number | undefined {
	const entry = value[key];
	return typeof entry === "number" && Number.isFinite(entry) ? entry : undefined;
}

function parseOrg(value: unknown): ShisaOrg | undefined {
	if (!isRecord(value)) return undefined;
	const id = stringAt(value, "id");
	const name = stringAt(value, "name");
	const slug = stringAt(value, "slug");
	return id && name && slug ? { id, name, slug } : undefined;
}

function parseEndpoints(value: unknown): ShisaLinkEndpoints | undefined {
	if (!isRecord(value)) return undefined;
	const openaiBaseUrl = stringAt(value, "openai_base_url");
	const modelCatalogUrl = stringAt(value, "model_catalog_url");
	const asrRealtimeUrl = stringAt(value, "asr_realtime_url");
	return openaiBaseUrl && modelCatalogUrl && asrRealtimeUrl
		? { openai_base_url: openaiBaseUrl, model_catalog_url: modelCatalogUrl, asr_realtime_url: asrRealtimeUrl }
		: undefined;
}

export function parseShisaDeviceCodeResponse(body: unknown): ShisaDeviceCode | undefined {
	if (!isRecord(body)) return undefined;
	const deviceCode = stringAt(body, "device_code");
	const userCode = stringAt(body, "user_code");
	const verificationUri = stringAt(body, "verification_uri");
	const authorizationId = stringAt(body, "authorization_id");
	if (!deviceCode || !userCode || !verificationUri || !authorizationId) return undefined;
	return {
		deviceCode,
		userCode,
		verificationUri,
		verificationUriComplete: stringAt(body, "verification_uri_complete"),
		verificationUriQr: stringAt(body, "verification_uri_qr"),
		authorizationId,
		expiresInSeconds: numberAt(body, "expires_in") ?? DEFAULT_EXPIRES_IN_SECONDS,
		intervalSeconds: numberAt(body, "interval") ?? DEFAULT_POLL_INTERVAL_SECONDS,
	};
}

export function parseShisaTokenResponse(body: unknown): ShisaTokenResponse | undefined {
	if (!isRecord(body)) return undefined;
	const apiKey = isRecord(body.api_key) ? body.api_key : undefined;
	const secret = apiKey ? stringAt(apiKey, "secret") : undefined;
	const apiKeyUuid = apiKey ? stringAt(apiKey, "uuid") : undefined;
	const org = parseOrg(body.org);
	const user = isRecord(body.user) ? body.user : undefined;
	const email = user ? stringAt(user, "email") : undefined;
	const endpoints = parseEndpoints(body.endpoints);
	const linkToken = stringAt(body, "link_token");
	const authorizationId = stringAt(body, "authorization_id");
	if (!apiKey || !secret || !apiKeyUuid || !org || !email || !endpoints || !linkToken || !authorizationId) {
		return undefined;
	}
	const urls: Record<string, string> = {};
	if (isRecord(body.urls)) {
		for (const [key, value] of Object.entries(body.urls)) {
			if (typeof value === "string") urls[key] = value;
		}
	}
	const bonus =
		isRecord(body.bonus) && typeof body.bonus.status === "string"
			? typeof body.bonus.amount_usd === "number"
				? { status: body.bonus.status, amount_usd: body.bonus.amount_usd }
				: { status: body.bonus.status }
			: undefined;
	const label = apiKey ? stringAt(apiKey, "label") : undefined;
	return {
		api_key: { uuid: apiKeyUuid, secret, ...(label ? { label } : {}) },
		org,
		user: { email },
		endpoints,
		link_token: linkToken,
		authorization_id: authorizationId,
		urls,
		...(bonus ? { bonus } : {}),
		balance: body.balance,
		rate_limit: body.rate_limit,
	};
}

/**
 * The wire error name: `error` as a string, or the `code` of an object-valued
 * `error` (the edge rate limiter reports `{ error: { code: "rate_limited" } }`).
 */
function wireErrorName(body: unknown): string | undefined {
	if (!isRecord(body)) return undefined;
	if (typeof body.error === "string") return body.error;
	if (isRecord(body.error) && typeof body.error.code === "string") return body.error.code;
	return undefined;
}

export type ShisaTokenClassification =
	| { kind: "pending" }
	| { kind: "slow_down"; intervalSeconds: number }
	| { kind: "rate_limited" }
	| { kind: "complete"; value: ShisaTokenResponse }
	| { kind: "failed"; message: string };

/**
 * Map one /device/token response onto the device-flow poll outcome. Terminal
 * errors are final — in particular `invalid_grant` is never retried, because
 * every unknown device code feeds the platform's brute-force detector.
 */
export function classifyShisaTokenResponse(
	status: number,
	body: unknown,
	currentIntervalSeconds: number,
): ShisaTokenClassification {
	if (status === 200) {
		const value = parseShisaTokenResponse(body);
		return value
			? { kind: "complete", value }
			: { kind: "failed", message: "Shisa sign-in returned an unexpected response. Start the sign-in again." };
	}
	const errorName = wireErrorName(body);
	// The edge rate limiter is distinct from the per-session slow_down signal.
	if (status === 429 && errorName === "rate_limited") return { kind: "rate_limited" };
	// Upstream failures (including HTTP 502 upstream_failed) are retryable.
	if (status >= 500) return { kind: "pending" };
	if (errorName === "authorization_pending") return { kind: "pending" };
	if (errorName === "slow_down") {
		const wireInterval = numberAt(isRecord(body) ? body : {}, "interval") ?? currentIntervalSeconds;
		return { kind: "slow_down", intervalSeconds: wireInterval + SLOW_DOWN_INCREMENT_SECONDS };
	}
	if (errorName === "expired_token") {
		return { kind: "failed", message: "The sign-in request expired. Start the sign-in again." };
	}
	if (errorName === "access_denied") {
		return {
			kind: "failed",
			message: "The sign-in request was declined in the browser. Start the sign-in again to retry.",
		};
	}
	if (errorName === "invalid_grant") {
		return { kind: "failed", message: "The sign-in request was not recognized. Start the sign-in again." };
	}
	if (errorName === "already_delivered") {
		return {
			kind: "failed",
			message: "This sign-in already delivered its API key. Start a new sign-in to link this device.",
		};
	}
	// Remaining transient statuses keep polling; anything else terminates.
	if (status === 429 || status === 408) return { kind: "pending" };
	return { kind: "failed", message: `Shisa sign-in failed (HTTP ${status}). Start the sign-in again.` };
}

/** Outcome of one device-flow poll, mirroring Pi's device-code poll contract. */
export type ShisaDevicePollResult<T> =
	| { status: "pending" }
	| { status: "slow_down"; intervalSeconds?: number }
	| { status: "failed"; message: string }
	| { status: "complete"; value: T };

/**
 * RFC 8628 device-flow poll loop with the same semantics as Pi's
 * pollOAuthDeviceCodeFlow (pi-ai auth/oauth/device-code), which is not part
 * of the pi-ai public export surface and therefore reimplemented here: a
 * `slow_down` outcome raises the interval (server interval when carried,
 * otherwise +5 s), polling stops at the expiry deadline, and only `complete`
 * and `failed` settle the loop.
 */
export async function pollShisaDeviceFlow<T>(options: {
	intervalSeconds?: number;
	expiresInSeconds?: number;
	poll: () => Promise<ShisaDevicePollResult<T>>;
	sleep?: (ms: number) => Promise<void>;
	signal?: AbortSignal;
}): Promise<T> {
	const sleep = options.sleep ?? defaultSleep;
	const deadline =
		typeof options.expiresInSeconds === "number"
			? Date.now() + options.expiresInSeconds * 1000
			: Number.POSITIVE_INFINITY;
	let intervalMs = Math.max(
		MINIMUM_POLL_INTERVAL_MS,
		Math.floor((options.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000),
	);
	while (Date.now() < deadline) {
		if (options.signal?.aborted) throw new Error("Login cancelled");
		const result = await options.poll();
		if (result.status === "complete") return result.value;
		if (result.status === "failed") throw new Error(result.message);
		if (result.status === "slow_down") {
			intervalMs =
				typeof result.intervalSeconds === "number" &&
				Number.isFinite(result.intervalSeconds) &&
				result.intervalSeconds > 0
					? Math.max(MINIMUM_POLL_INTERVAL_MS, Math.floor(result.intervalSeconds * 1000))
					: intervalMs + SLOW_DOWN_INCREMENT_SECONDS * 1000;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) break;
		await sleep(Math.min(intervalMs, remainingMs));
	}
	throw new Error("Sign-in timed out before the request was approved. Start the sign-in again.");
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function postJson(
	url: string,
	payload: unknown,
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
	headers?: Record<string, string>,
): Promise<Response> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return fetchImpl(url, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json", ...headers },
		...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
}

async function readJsonBody(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return undefined;
	}
}

export interface ShisaDeviceTokenPoller {
	poll: () => Promise<ShisaDevicePollResult<ShisaTokenResponse>>;
}

/**
 * Poll /device/token for one device code. The edge rate limiter (HTTP 429
 * with error.code rate_limited) doubles the wait up to a 60 s cap; any other
 * outcome resets the backoff to the base interval. Transport failures are
 * treated as pending so a flaky connection never aborts an approvable
 * sign-in, and the device code never reaches an error message.
 */
export function createShisaDeviceTokenPoller(deps: {
	gatewayUrl: string;
	deviceCode: string;
	baseIntervalSeconds: number;
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	signal?: AbortSignal;
}): ShisaDeviceTokenPoller {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const sleep = deps.sleep ?? defaultSleep;
	const baseBackoffMs = Math.max(MINIMUM_POLL_INTERVAL_MS, Math.floor(deps.baseIntervalSeconds * 1000));
	let backoffMs = baseBackoffMs;
	return {
		async poll() {
			let status: number;
			let body: unknown;
			try {
				const response = await postJson(
					`${deps.gatewayUrl}${DEVICE_TOKEN_PATH}`,
					{ client_id: SHISA_CLIENT_ID, device_code: deps.deviceCode },
					fetchImpl,
					deps.signal,
				);
				status = response.status;
				body = await readJsonBody(response);
			} catch {
				return { status: "pending" as const };
			}
			const classification = classifyShisaTokenResponse(status, body, deps.baseIntervalSeconds);
			if (classification.kind === "rate_limited") {
				backoffMs = Math.min(backoffMs * 2, RATE_LIMIT_BACKOFF_CAP_MS);
				await sleep(backoffMs);
				return { status: "pending" as const };
			}
			backoffMs = baseBackoffMs;
			switch (classification.kind) {
				case "complete":
					return { status: "complete" as const, value: classification.value };
				case "failed":
					return { status: "failed" as const, message: classification.message };
				case "slow_down":
					return { status: "slow_down" as const, intervalSeconds: classification.intervalSeconds };
				default:
					return { status: "pending" as const };
			}
		},
	};
}

function scrubSecrets(text: string, secrets: readonly string[]): string {
	let result = text;
	for (const secret of secrets) {
		if (secret.length > 0) result = result.replaceAll(secret, "[redacted]");
	}
	return result;
}

function describeError(error: unknown, secrets: readonly string[]): string {
	const raw = error instanceof Error ? error.message : String(error);
	return scrubSecrets(raw, secrets);
}

function openBrowserFromCallbacks(callbacks: OAuthLoginCallbacks): ((url: string) => void) | undefined {
	const candidate = (callbacks as { openBrowser?: unknown }).openBrowser;
	return typeof candidate === "function" ? (candidate as (url: string) => void) : undefined;
}

export interface ShisaLoginIo {
	writeLinkState(state: ShisaLinkState): Promise<void>;
	/**
	 * Optional direct credential-store write. Production persists the
	 * credential through the login return value (Pi's credential store writes
	 * it after this flow resolves); a caller that owns a store write provides
	 * it here so the acknowledgement is strictly ordered behind both writes.
	 */
	writeCredential?(credential: OAuthCredentials): Promise<void>;
}

export interface ShisaLoginDeps extends ShisaLoginIo {
	gatewayUrl: string;
	clientVersion: string;
	installId: string;
	deviceName?: string;
	platformLabel?: string;
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	openBrowser?: (url: string) => void;
	ackAttempts?: number;
}

/**
 * Run the Shisa device-flow login. Returns the OAuth credential for Pi's
 * credential store; the platform offer data (bonus) travels in the link
 * state and is presented by the account UI, never printed here.
 */
export async function loginShisaDeviceFlow(
	callbacks: OAuthLoginCallbacks,
	deps: ShisaLoginDeps,
): Promise<OAuthCredentials> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const sleep = deps.sleep ?? defaultSleep;
	const deviceName = deps.deviceName ?? hostname();
	const platformLabel = deps.platformLabel ?? `${process.platform}-${process.arch}`;

	// 1. Request a device code. device_name is the anti-phishing signal shown
	// on the approval card, so it reflects this machine.
	const codeResponse = await postJson(
		`${deps.gatewayUrl}${DEVICE_CODE_PATH}`,
		{
			client_id: SHISA_CLIENT_ID,
			client_version: deps.clientVersion,
			install_id: deps.installId,
			device_name: deviceName,
			platform: platformLabel,
		},
		fetchImpl,
		callbacks.signal,
	).catch((error) => {
		throw new Error(`Could not reach the Shisa platform: ${describeError(error, [])}`);
	});
	const codeBody = await readJsonBody(codeResponse);
	if (codeResponse.status !== 201) {
		throw new Error(`The Shisa platform could not start the sign-in request (HTTP ${codeResponse.status}).`);
	}
	const deviceCode = parseShisaDeviceCodeResponse(codeBody);
	if (!deviceCode) throw new Error("The Shisa platform returned an unexpected sign-in response. Try again.");

	// 2. Surface the verification URL and code through the login UI and open
	// the complete URL in the browser when a helper is available.
	const verificationUri = deviceCode.verificationUriComplete ?? deviceCode.verificationUri;
	callbacks.onDeviceCode({
		userCode: deviceCode.userCode,
		verificationUri,
		intervalSeconds: deviceCode.intervalSeconds,
		expiresInSeconds: deviceCode.expiresInSeconds,
	});
	const openBrowser = deps.openBrowser ?? openBrowserFromCallbacks(callbacks);
	if (openBrowser && deviceCode.verificationUriComplete) {
		try {
			openBrowser(deviceCode.verificationUriComplete);
		} catch {
			// Opening the browser is best-effort; the URL and code stay on screen.
		}
	}

	// 3. Poll for the token. The device code stays in memory only.
	const poller = createShisaDeviceTokenPoller({
		gatewayUrl: deps.gatewayUrl,
		deviceCode: deviceCode.deviceCode,
		baseIntervalSeconds: deviceCode.intervalSeconds,
		fetchImpl,
		sleep,
		signal: callbacks.signal,
	});
	const token = await pollShisaDeviceFlow({
		intervalSeconds: deviceCode.intervalSeconds,
		expiresInSeconds: deviceCode.expiresInSeconds,
		poll: poller.poll,
		sleep,
		signal: callbacks.signal,
	});

	// 4. Persist first (link state, plus a direct credential write when the
	// caller owns one), then acknowledge. The response is re-deliverable, so
	// a crash before the acknowledgement is recovered by signing in again.
	const credential: OAuthCredentials = {
		type: "oauth",
		access: token.api_key.secret,
		refresh: "",
		expires: Number.MAX_SAFE_INTEGER,
	};
	const state: ShisaLinkState = {
		install_id: deps.installId,
		authorization_id: token.authorization_id,
		api_key_uuid: token.api_key.uuid,
		org: token.org,
		endpoints: token.endpoints,
		link_token: token.link_token,
		acked: false,
		...(token.bonus ? { bonus: token.bonus } : {}),
	};
	await deps.writeLinkState(state);
	await deps.writeCredential?.(credential);

	// 5. Acknowledge the link. Retries are bounded; a later successful
	// GET /device/link also acknowledges, and the worst case of never
	// acking is platform-side revocation when the delivery window lapses.
	const ackAttempts = deps.ackAttempts ?? ACK_ATTEMPTS;
	let acknowledged = false;
	for (let attempt = 0; attempt < ackAttempts && !acknowledged; attempt++) {
		if (attempt > 0) await sleep(ACK_RETRY_DELAY_MS);
		try {
			const ackResponse = await postJson(
				`${deps.gatewayUrl}${DEVICE_LINK_ACK_PATH}`,
				undefined,
				fetchImpl,
				callbacks.signal,
				{ authorization: `Bearer ${token.link_token}` },
			);
			if (ackResponse.status !== 204) throw new Error(`ack failed (HTTP ${ackResponse.status})`);
			acknowledged = true;
		} catch {
			// Retry below; the acknowledgement is idempotent and optional.
		}
	}
	if (acknowledged) {
		try {
			await deps.writeLinkState({ ...state, acked: true });
		} catch {
			// The ack itself succeeded; the marker update is best-effort.
		}
	} else {
		callbacks.onProgress?.("Signed in. The device link confirmation will complete automatically later.");
	}
	return credential;
}
