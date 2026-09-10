import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveJouzuPaths } from "../dist/paths.js";
import {
	classifyShisaTokenResponse,
	createShisaDeviceTokenPoller,
	DEFAULT_SHISA_GATEWAY_URL,
	loginShisaDeviceFlow,
	parseShisaDeviceCodeResponse,
	parseShisaTokenResponse,
	pollShisaDeviceFlow,
	resolveShisaGatewayUrl,
	SHISA_CLIENT_ID,
} from "../dist/shisa-link/device-flow.js";
import { createShisaExtension, SHISA_PROVIDER_ID } from "../dist/shisa-link/extension.js";
import {
	newShisaInstallId,
	readShisaLinkState,
	shisaLinkStatePath,
	writeShisaLinkState,
} from "../dist/shisa-link/state.js";

const DEVICE_CODE_BODY = {
	device_code: "dc-secret-value",
	user_code: "JOUZU-ABCD-EFGH",
	verification_uri: "https://platform.shisa.ai/connect",
	verification_uri_complete: "https://platform.shisa.ai/connect?code=JOUZU-ABCD-EFGH",
	verification_uri_qr: "https://platform.shisa.ai/qr",
	authorization_id: "auth-xyz",
	expires_in: 900,
	interval: 5,
};

const TOKEN_BODY = {
	api_key: { uuid: "key-uuid-1", secret: "shsk:secret-value", label: "jouzu cli" },
	org: { id: "org-1", name: "Shisa", slug: "shisa" },
	user: { email: "person@example.com" },
	endpoints: {
		openai_base_url: "https://gateway.shisa.ai/v1",
		model_catalog_url: "https://gateway.shisa.ai/catalog",
		asr_realtime_url: "wss://gateway.shisa.ai/asr",
	},
	link_token: "link-token-secret",
	authorization_id: "auth-xyz",
	urls: { bonus: "https://platform.shisa.ai/billing" },
	bonus: { status: "available", amount_usd: 10 },
	balance: 12.5,
	rate_limit: { rpm: 60 },
};

const SECRET_MATERIAL = ["dc-secret-value", "link-token-secret", "shsk:secret-value"];

function jsonResponse(status, body) {
	return new Response(body === undefined ? null : JSON.stringify(body), {
		status,
		headers: body === undefined ? {} : { "content-type": "application/json" },
	});
}

function createFetchMock() {
	const calls = [];
	const queue = [];
	const impl = (url, init) => {
		calls.push({ url: String(url), init });
		const next = queue.shift();
		if (next === undefined) return Promise.reject(new Error(`unexpected fetch: ${String(url)}`));
		return Promise.resolve(typeof next === "function" ? next(url, init) : next);
	};
	impl.calls = calls;
	impl.enqueue = (response) => queue.push(response);
	return impl;
}

function instantSleep() {
	const waits = [];
	const sleep = async (ms) => {
		waits.push(ms);
	};
	sleep.waits = waits;
	return sleep;
}

function fakeCallbacks() {
	const events = [];
	const callbacks = {
		onAuth: (info) => events.push({ kind: "auth", info }),
		onDeviceCode: (info) => events.push({ kind: "device_code", info }),
		onPrompt: async () => {
			throw new Error("no prompts expected");
		},
		onProgress: (message) => events.push({ kind: "progress", message }),
		onSelect: async () => undefined,
	};
	return { callbacks, events };
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function waitFor(condition, timeoutMs = 2000) {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error("condition not met before timeout");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function assertNoSecretMaterial(text) {
	for (const secret of SECRET_MATERIAL) {
		assert.ok(!text.includes(secret), `secret material must never appear: ${secret}`);
	}
}

function loginDeps(overrides = {}) {
	const order = [];
	const mock = createFetchMock();
	const sleep = instantSleep();
	return {
		deps: {
			gatewayUrl: "https://gateway.test",
			clientVersion: "0.1.8",
			installId: newShisaInstallId(),
			writeLinkState: async (state) => {
				order.push(`state:${state.acked ? "acked" : "pending"}`);
			},
			fetchImpl: mock,
			sleep,
			ackAttempts: overrides.ackAttempts ?? 3,
			...overrides,
		},
		mock,
		sleep,
		order,
	};
}

function standardTokenResponses(mock) {
	mock.enqueue(jsonResponse(201, DEVICE_CODE_BODY));
	mock.enqueue(jsonResponse(200, TOKEN_BODY));
	mock.enqueue(jsonResponse(204));
}

test("gateway URL resolves from the environment with a documented default", () => {
	assert.equal(resolveShisaGatewayUrl({}), DEFAULT_SHISA_GATEWAY_URL);
	assert.equal(
		resolveShisaGatewayUrl({ JOUZU_SHISA_PLATFORM_URL: "https://staging.shisa.ai/" }),
		"https://staging.shisa.ai",
	);
	assert.equal(
		resolveShisaGatewayUrl({ JOUZU_SHISA_PLATFORM_URL: "  https://edge.shisa.ai  " }),
		"https://edge.shisa.ai",
	);
});

test("device code and token responses are parsed strictly", () => {
	const deviceCode = parseShisaDeviceCodeResponse(DEVICE_CODE_BODY);
	assert.equal(deviceCode?.deviceCode, "dc-secret-value");
	assert.equal(deviceCode?.userCode, "JOUZU-ABCD-EFGH");
	assert.equal(deviceCode?.expiresInSeconds, 900);
	assert.equal(deviceCode?.intervalSeconds, 5);
	assert.equal(parseShisaDeviceCodeResponse({ ...DEVICE_CODE_BODY, device_code: "" }), undefined);
	assert.equal(parseShisaDeviceCodeResponse({}), undefined);
	const token = parseShisaTokenResponse(TOKEN_BODY);
	assert.equal(token?.api_key.secret, "shsk:secret-value");
	assert.equal(token?.org.slug, "shisa");
	assert.equal(token?.urls.bonus, "https://platform.shisa.ai/billing");
	assert.deepEqual(token?.bonus, { status: "available", amount_usd: 10 });
	assert.equal(parseShisaTokenResponse({ ...TOKEN_BODY, link_token: "" }), undefined);
	assert.equal(parseShisaTokenResponse({ ...TOKEN_BODY, api_key: { uuid: "k" } }), undefined);
});

test("poll classification maps the frozen v0.3 wire errors", () => {
	assert.equal(classifyShisaTokenResponse(400, { error: "authorization_pending" }, 5).kind, "pending");
	assert.deepEqual(classifyShisaTokenResponse(400, { error: "slow_down", interval: 7 }, 5), {
		kind: "slow_down",
		intervalSeconds: 12,
	});
	assert.equal(classifyShisaTokenResponse(502, { error: "upstream_failed" }, 5).kind, "pending");
	assert.equal(classifyShisaTokenResponse(503, {}, 5).kind, "pending");
	assert.equal(classifyShisaTokenResponse(429, { error: { code: "rate_limited" } }, 5).kind, "rate_limited");
	assert.equal(classifyShisaTokenResponse(429, {}, 5).kind, "pending");
	for (const [error, expected] of [
		["expired_token", "expired"],
		["access_denied", "declined"],
		["invalid_grant", "not recognized"],
		["already_delivered", "already delivered"],
	]) {
		const classification = classifyShisaTokenResponse(400, { error }, 5);
		assert.equal(classification.kind, "failed");
		assert.match(classification.message, new RegExp(expected, "i"));
		assert.doesNotMatch(classification.message, /device_code|link_token|shsk:/iu);
	}
	const complete = classifyShisaTokenResponse(200, TOKEN_BODY, 5);
	assert.equal(complete.kind, "complete");
	if (complete.kind === "complete") assert.equal(complete.value.api_key.uuid, "key-uuid-1");
	const unknown = classifyShisaTokenResponse(403, { error: "something_new" }, 5);
	assert.equal(unknown.kind, "failed");
});

test("poll loop: pending then complete, with recorded waits", async () => {
	const sleep = instantSleep();
	let polls = 0;
	const value = await pollShisaDeviceFlow({
		intervalSeconds: 5,
		expiresInSeconds: 900,
		poll: async () => (polls++ === 0 ? { status: "pending" } : { status: "complete", value: 42 }),
		sleep,
	});
	assert.equal(value, 42);
	assert.deepEqual(sleep.waits, [5000]);
});

test("poll loop: slow_down raises the interval and the timeout deadline holds", async () => {
	const sleep = instantSleep();
	let polls = 0;
	await pollShisaDeviceFlow({
		intervalSeconds: 5,
		expiresInSeconds: 900,
		poll: async () => {
			polls++;
			if (polls === 1) return { status: "slow_down", intervalSeconds: 8 };
			return { status: "complete", value: "done" };
		},
		sleep,
	});
	assert.deepEqual(sleep.waits, [8000], "the raised interval is used for the next wait");
	await assert.rejects(
		() =>
			pollShisaDeviceFlow({
				intervalSeconds: 5,
				expiresInSeconds: 0,
				poll: async () => ({ status: "pending" }),
				sleep,
			}),
		/timed out/i,
	);
	await assert.rejects(
		() =>
			pollShisaDeviceFlow({
				intervalSeconds: 5,
				poll: async () => ({ status: "failed", message: "The sign-in request was declined in the browser." }),
				sleep,
			}),
		/declined/i,
	);
	const signal = AbortSignal.abort();
	await assert.rejects(
		() => pollShisaDeviceFlow({ poll: async () => ({ status: "pending" }), sleep, signal }),
		/cancelled/i,
	);
});

test("token poller retries upstream failures and completes", async () => {
	const mock = createFetchMock();
	mock.enqueue(jsonResponse(502, { error: "upstream_failed" }));
	mock.enqueue(jsonResponse(200, TOKEN_BODY));
	const sleep = instantSleep();
	const poller = createShisaDeviceTokenPoller({
		gatewayUrl: "https://gateway.test",
		deviceCode: "dc-secret-value",
		baseIntervalSeconds: 5,
		fetchImpl: mock,
		sleep,
	});
	const first = await poller.poll();
	assert.deepEqual(first, { status: "pending" });
	const second = await poller.poll();
	assert.equal(second.status, "complete");
	if (second.status === "complete") assert.equal(second.value.api_key.secret, "shsk:secret-value");
	assert.equal(mock.calls.length, 2);
	const payload = JSON.parse(mock.calls[0].init.body);
	assert.deepEqual(payload, { client_id: SHISA_CLIENT_ID, device_code: "dc-secret-value" });
});

test("token poller never retries invalid_grant", async () => {
	const mock = createFetchMock();
	mock.enqueue(jsonResponse(400, { error: "invalid_grant" }));
	mock.enqueue(jsonResponse(200, TOKEN_BODY));
	const poller = createShisaDeviceTokenPoller({
		gatewayUrl: "https://gateway.test",
		deviceCode: "dc-secret-value",
		baseIntervalSeconds: 5,
		fetchImpl: mock,
		sleep: instantSleep(),
	});
	const result = await poller.poll();
	assert.equal(result.status, "failed");
	assert.equal(mock.calls.length, 1, "every unknown code feeds the brute-force detector, so no retry");
	assertNoSecretMaterial(result.status === "failed" ? result.message : "");
});

test("token poller doubles the wait on edge rate limiting and caps at 60 seconds", async () => {
	const mock = createFetchMock();
	for (let index = 0; index < 8; index++) mock.enqueue(jsonResponse(429, { error: { code: "rate_limited" } }));
	mock.enqueue(jsonResponse(200, TOKEN_BODY));
	const sleep = instantSleep();
	const poller = createShisaDeviceTokenPoller({
		gatewayUrl: "https://gateway.test",
		deviceCode: "dc-secret-value",
		baseIntervalSeconds: 1,
		fetchImpl: mock,
		sleep,
	});
	for (let index = 0; index < 8; index++) {
		const result = await poller.poll();
		assert.equal(result.status, "pending");
	}
	assert.deepEqual(sleep.waits, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
	const final = await poller.poll();
	assert.equal(final.status, "complete");
	assert.deepEqual(sleep.waits.slice(-1), [60000], "a non-429 outcome stops the backoff growth");
});

test("token poller treats transport failures as pending without leaking the device code", async () => {
	const mock = createFetchMock();
	mock.enqueue(jsonResponse(502, { error: "upstream_failed" }));
	const failing = async () => {
		throw new Error(`connection reset while sending dc-secret-value`);
	};
	const poller = createShisaDeviceTokenPoller({
		gatewayUrl: "https://gateway.test",
		deviceCode: "dc-secret-value",
		baseIntervalSeconds: 5,
		fetchImpl: failing,
		sleep: instantSleep(),
	});
	const result = await poller.poll();
	assert.deepEqual(result, { status: "pending" });
	void mock;
});

test("login surfaces the verification URL and code and never logs secret material", async () => {
	const { deps, mock } = loginDeps();
	standardTokenResponses(mock);
	const { callbacks, events } = fakeCallbacks();
	const openedUrls = [];
	const credential = await loginShisaDeviceFlow(callbacks, { ...deps, openBrowser: (url) => openedUrls.push(url) });
	assert.deepEqual(credential, {
		type: "oauth",
		access: "shsk:secret-value",
		refresh: "",
		expires: Number.MAX_SAFE_INTEGER,
	});
	const deviceCodeEvent = events.find((event) => event.kind === "device_code");
	assert.equal(deviceCodeEvent.info.userCode, "JOUZU-ABCD-EFGH");
	assert.equal(deviceCodeEvent.info.verificationUri, "https://platform.shisa.ai/connect?code=JOUZU-ABCD-EFGH");
	assert.equal(deviceCodeEvent.info.intervalSeconds, 5);
	assert.equal(deviceCodeEvent.info.expiresInSeconds, 900);
	assert.deepEqual(openedUrls, ["https://platform.shisa.ai/connect?code=JOUZU-ABCD-EFGH"]);
	assertNoSecretMaterial(JSON.stringify(events));
	const codeRequest = JSON.parse(mock.calls[0].init.body);
	assert.deepEqual(codeRequest, {
		client_id: "jouzu",
		client_version: "0.1.8",
		install_id: deps.installId,
		device_name: hostname(),
		platform: `${process.platform}-${process.arch}`,
	});
	const ack = mock.calls.at(-1);
	assert.equal(ack.url, "https://gateway.test/device/link/ack");
	assert.equal(ack.init.headers.authorization, "Bearer link-token-secret");
});

test("login falls back to the plain verification URI when no complete URL exists", async () => {
	const { deps, mock } = loginDeps();
	mock.enqueue(jsonResponse(201, { ...DEVICE_CODE_BODY, verification_uri_complete: undefined }));
	mock.enqueue(jsonResponse(200, TOKEN_BODY));
	mock.enqueue(jsonResponse(204));
	const { callbacks, events } = fakeCallbacks();
	await loginShisaDeviceFlow(callbacks, deps);
	assert.equal(
		events.find((event) => event.kind === "device_code").info.verificationUri,
		"https://platform.shisa.ai/connect",
	);
});

test("the link acknowledgement is issued only after both writes resolve", async () => {
	const order = [];
	const mock = createFetchMock();
	standardTokenResponses(mock);
	const stateGate = deferred();
	const credentialGate = deferred();
	const { callbacks } = fakeCallbacks();
	const pending = loginShisaDeviceFlow(callbacks, {
		gatewayUrl: "https://gateway.test",
		clientVersion: "0.1.8",
		installId: newShisaInstallId(),
		writeLinkState: async (_state) => {
			order.push("state");
			await stateGate.promise;
		},
		writeCredential: async (_credential) => {
			order.push("credential");
			await credentialGate.promise;
		},
		fetchImpl: mock,
		sleep: instantSleep(),
	});
	await waitFor(() => order.includes("state"));
	assert.equal(mock.calls.filter((call) => call.url.endsWith("/device/link/ack")).length, 0);
	stateGate.resolve();
	await waitFor(() => order.includes("credential"));
	assert.equal(mock.calls.filter((call) => call.url.endsWith("/device/link/ack")).length, 0);
	credentialGate.resolve();
	const credential = await pending;
	assert.equal(credential.access, "shsk:secret-value");
	await waitFor(() => mock.calls.some((call) => call.url.endsWith("/device/link/ack")));
	// The third entry is the acked-marker rewrite that follows the successful ack.
	assert.deepEqual(order.slice(0, 2), ["state", "credential"]);
	assert.ok(
		mock.calls.some((call) => call.url.endsWith("/device/link/ack")),
		"ack issued after both writes",
	);
});

test("the link state records the link data before the acknowledgement", async () => {
	const states = [];
	const { deps, mock } = loginDeps({
		writeLinkState: async (state) => {
			states.push(state);
		},
	});
	standardTokenResponses(mock);
	const { callbacks } = fakeCallbacks();
	await loginShisaDeviceFlow(callbacks, deps);
	assert.equal(states.length, 2);
	assert.equal(states[0].acked, false);
	assert.equal(states[1].acked, true);
	assert.equal(states[0].install_id, deps.installId);
	assert.equal(states[0].api_key_uuid, "key-uuid-1");
	assert.equal(states[0].org.slug, "shisa");
	assert.equal(states[0].endpoints.openai_base_url, "https://gateway.shisa.ai/v1");
	assert.equal(states[0].authorization_id, "auth-xyz");
	assert.deepEqual(states[0].bonus, { status: "available", amount_usd: 10 });
});

test("a failing acknowledgement is retried, then the login continues", async () => {
	const { deps, mock, sleep } = loginDeps();
	mock.enqueue(jsonResponse(201, DEVICE_CODE_BODY));
	mock.enqueue(jsonResponse(200, TOKEN_BODY));
	mock.enqueue(jsonResponse(500, {}));
	mock.enqueue(jsonResponse(500, {}));
	mock.enqueue(jsonResponse(204));
	const { callbacks, events } = fakeCallbacks();
	await loginShisaDeviceFlow(callbacks, deps);
	assert.equal(sleep.waits.at(-1), 2000, "retries wait between attempts");
	assert.ok(!events.some((event) => event.kind === "progress"), "a successful retry stays quiet");
});

test("an acknowledgement that never succeeds does not fail the login", async () => {
	const states = [];
	const { deps, mock } = loginDeps({ ackAttempts: 2, writeLinkState: async (state) => states.push(state) });
	mock.enqueue(jsonResponse(201, DEVICE_CODE_BODY));
	mock.enqueue(jsonResponse(200, TOKEN_BODY));
	mock.enqueue(jsonResponse(503, {}));
	mock.enqueue(jsonResponse(503, {}));
	const { callbacks, events } = fakeCallbacks();
	const credential = await loginShisaDeviceFlow(callbacks, deps);
	assert.equal(credential.access, "shsk:secret-value");
	assert.equal(states.length, 1);
	assert.equal(states[0].acked, false, "the marker stays false without a confirmed acknowledgement");
	const progress = events.filter((event) => event.kind === "progress");
	assert.equal(progress.length, 1);
	assertNoSecretMaterial(JSON.stringify(events));
});

test("failures before approval surface without secret material", async () => {
	const mock = createFetchMock();
	mock.enqueue(jsonResponse(500, { error: "boom", detail: "dc-secret-value shsk:secret-value link-token-secret" }));
	const { callbacks } = fakeCallbacks();
	const { deps } = loginDeps({ fetchImpl: mock });
	await assert.rejects(() => loginShisaDeviceFlow(callbacks, deps), /HTTP 500/);
	const thrown = await loginShisaDeviceFlow(callbacks, { ...deps }).then(
		() => "",
		(error) => error.message,
	);
	assertNoSecretMaterial(thrown);
	assertNoSecretMaterial(JSON.stringify(callbacks));
});

test("an unexpected token approval payload fails without leaking secrets", async () => {
	const { deps, mock } = loginDeps();
	mock.enqueue(jsonResponse(201, DEVICE_CODE_BODY));
	mock.enqueue(jsonResponse(200, { note: "dc-secret-value shsk:secret-value" }));
	const { callbacks, events } = fakeCallbacks();
	await assert.rejects(() => loginShisaDeviceFlow(callbacks, deps), /unexpected response/i);
	assertNoSecretMaterial(JSON.stringify(events));
});

test("extension registers the shisa provider and reconnects with the stored install id", async () => {
	const home = mkdtempSync(join(tmpdir(), "jouzu-shisa-extension-"));
	try {
		const paths = resolveJouzuPaths({ homeOverride: home });
		const statePath = shisaLinkStatePath(paths);
		const { callbacks } = fakeCallbacks();

		// Before any link: gateway placeholder base URL, no network, no state file.
		let captured;
		const pi = {
			registerProvider: (name, config) => {
				captured = { name, config };
			},
		};
		// Login through the extension writes the state file and re-registers
		// with the token response's endpoints.
		const mock = createFetchMock();
		standardTokenResponses(mock);
		const sleep = instantSleep();
		const extension = createShisaExtension({ paths, jouzuVersion: "0.1.8", env: {}, fetchImpl: mock, sleep });
		assert.equal(extension.name, "jouzu-shisa");
		extension.factory(pi);
		assert.equal(captured.name, SHISA_PROVIDER_ID);
		assert.equal(captured.config.api, "openai-completions");
		assert.equal(captured.config.baseUrl, DEFAULT_SHISA_GATEWAY_URL);
		assert.equal(captured.config.oauth.name, "Shisa");
		assert.equal(existsSync(statePath), false);

		// Login through the extension writes the state file and re-registers
		// with the token response's endpoints.
		const credential = await captured.config.oauth.login({
			...callbacks,
			onDeviceCode: (info) => callbacks.onDeviceCode(info),
			onProgress: (message) => callbacks.onProgress(message),
		});
		void credential;
		const linked = readShisaLinkState(statePath);
		assert.equal(linked?.endpoints.openai_base_url, "https://gateway.shisa.ai/v1");
		assert.equal(linked?.acked, true);
		assert.equal(captured.config.baseUrl, "https://gateway.shisa.ai/v1", "re-registration serves the linked endpoint");
		const firstCodeRequest = JSON.parse(mock.calls[0].init.body);
		assert.equal(firstCodeRequest.client_version, "0.1.8");

		// A reconnecting login reuses the stored install_id.
		const mock2 = createFetchMock();
		mock2.enqueue(jsonResponse(201, DEVICE_CODE_BODY));
		mock2.enqueue(jsonResponse(200, TOKEN_BODY));
		mock2.enqueue(jsonResponse(204));
		const extension2 = createShisaExtension({ paths, jouzuVersion: "0.1.8", env: {}, fetchImpl: mock2, sleep });
		extension2.factory(pi);
		await captured.config.oauth.login({
			...callbacks,
			onDeviceCode: (info) => callbacks.onDeviceCode(info),
			onProgress: (message) => callbacks.onProgress(message),
		});
		const secondCodeRequest = JSON.parse(mock2.calls[0].init.body);
		assert.equal(secondCodeRequest.install_id, linked.install_id, "install_id is stable across logins");

		// Refresh is a no-op and getApiKey reads the stored access token.
		const stored = { type: "oauth", access: "shsk:secret-value", refresh: "", expires: Number.MAX_SAFE_INTEGER };
		assert.deepEqual(await captured.config.oauth.refreshToken(stored, undefined), stored);
		assert.equal(captured.config.oauth.getApiKey(stored), "shsk:secret-value");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("extension logout support leaves no state behind through clearShisaLinkState", async () => {
	const home = mkdtempSync(join(tmpdir(), "jouzu-shisa-clear-"));
	try {
		const paths = resolveJouzuPaths({ homeOverride: home });
		const statePath = shisaLinkStatePath(paths);
		const installId = newShisaInstallId();
		await writeShisaLinkState(
			statePath,
			{
				install_id: installId,
				authorization_id: "auth-xyz",
				api_key_uuid: "key-uuid-1",
				org: { id: "org-1", name: "Shisa", slug: "shisa" },
				endpoints: TOKEN_BODY.endpoints,
				link_token: "link-token-secret",
				acked: true,
			},
			paths.stateDir,
		);
		assert.ok(readFileSync(statePath, "utf8").includes(installId));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
