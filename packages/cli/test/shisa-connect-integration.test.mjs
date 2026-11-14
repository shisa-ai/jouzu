import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { assistant } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { CatalogSettingsComponent } from "../dist/catalog-settings.js";
import { MODEL_CATALOG_MEDIA_TYPE } from "../dist/model-catalog.js";
import { loadActiveModelCatalogs, refreshAvailableModelCatalogs } from "../dist/model-catalog-sync.js";
import { createJouzuModelPicker } from "../dist/model-picker.js";
import { deriveProjectKey, ModelPickerStore } from "../dist/model-picker-state.js";
import { resolveJouzuPaths } from "../dist/paths.js";
import { withPiAuthCompletion } from "../dist/pi-auth-completion.js";
import { createSessionUiStyles } from "../dist/session-ui/index.js";
import { readShisaLoginToken, setShisaSignedOut } from "../dist/shisa-link/credentials.js";
import { createShisaExtension, SHISA_PROVIDER_ID } from "../dist/shisa-link/extension.js";
import { loginShisa } from "../dist/shisa-link/login.js";
import { interactiveLoginHost } from "./fixtures/interactive-login.mjs";

const fixtureRaw = JSON.parse(
	readFileSync(join(import.meta.dirname, "..", "catalog", "fixtures", "account-snapshot-v1.json"), "utf8"),
);

const identityTheme = {
	fg: (_role, value) => value,
	bg: (_role, value) => value,
	bold: (value) => value,
};

function fakeKeybindings() {
	const keys = {
		"tui.select.cancel": ["escape", "ctrl+c"],
		"tui.select.confirm": ["enter"],
		"tui.select.up": ["up"],
		"tui.select.down": ["down"],
		"tui.select.pageUp": ["pageUp"],
		"tui.select.pageDown": ["pageDown"],
	};
	return {
		matches(data, action) {
			return keys[action]?.includes(data) ?? false;
		},
		getKeys(action) {
			return [...(keys[action] ?? [])];
		},
	};
}

function paletteContext() {
	const renders = [];
	return {
		tui: {
			requestRender() {
				renders.push(true);
			},
			terminal: { rows: 32, columns: 100 },
		},
		theme: identityTheme,
		keybindings: fakeKeybindings(),
		styles: createSessionUiStyles(identityTheme),
		close() {},
	};
}

/** The session UI surface these extensions touch; notifications are recorded for assertions. */
function sessionUiContext(notifications) {
	const noop = () => undefined;
	return {
		notify: (message, level) => notifications.push({ message, level }),
		select: noop,
		confirm: noop,
		input: noop,
		onTerminalInput: () => noop,
		setStatus: noop,
		setWorkingMessage: noop,
		setWorkingVisible: noop,
		setWorkingIndicator: noop,
		setHiddenThinkingLabel: noop,
		setWidget: noop,
		setFooter: noop,
		setHeader: noop,
		setTitle: noop,
		custom: async () => undefined,
		pasteToEditor: noop,
		setEditorText: noop,
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: noop,
		setEditorComponent: noop,
		getEditorComponent: () => undefined,
		theme: identityTheme,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "UI not available" }),
		getToolsExpanded: () => false,
		setToolsExpanded: noop,
	};
}

async function waitFor(condition, timeoutMs = 5000) {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error("condition not met before timeout");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function readBody(request) {
	return new Promise((resolve) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => resolve(body));
	});
}

/**
 * Real Settings account flow against a loopback Shisa gateway and a real Pi
 * session: the component drives the production device flow, saves the
 * credential, and refreshes the authenticated catalog through the same
 * `refreshShisaAccount` hook the model picker installs. Only the network
 * transport is substituted; no model callbacks are mocked.
 */
async function harness(t, behavior = {}) {
	const home = mkdtempSync(join(tmpdir(), "jouzu-connect-"));
	const paths = resolveJouzuPaths({ homeOverride: home });
	t.after(() => {
		setShisaSignedOut(paths, false);
		rmSync(home, { recursive: true, force: true });
	});
	mkdirSync(paths.agentDir, { recursive: true });

	const requests = [];
	const tokenMode = behavior.token ?? "approve";
	const server = createServer(async (request, response) => {
		const body = await readBody(request);
		requests.push({
			method: request.method,
			url: request.url,
			authorization: request.headers.authorization,
			body,
		});
		const json = (status, payload) => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(payload));
		};
		if (request.url === "/device/code" && request.method === "POST") {
			json(201, {
				device_code: "loopback-device-code",
				user_code: "JOUZU-LOOP-0001",
				verification_uri: `${origin}/connect`,
				verification_uri_complete: `${origin}/connect?code=JOUZU-LOOP-0001`,
				authorization_id: "auth-loopback",
				expires_in: 900,
				interval: 5,
			});
			return;
		}
		if (request.url === "/device/token" && request.method === "POST") {
			if (tokenMode === "deny") {
				json(400, { error: "access_denied" });
				return;
			}
			if (tokenMode === "pending") {
				json(400, { error: "authorization_pending" });
				return;
			}
			json(200, {
				api_key: { uuid: "key-loopback", secret: "shsk:loopback-secret", label: "jouzu integration" },
				org: { id: "org-loopback", name: "Loopback Org", slug: "loopback" },
				user: { email: "person@example.test" },
				endpoints: {
					openai_base_url: `${origin}/v1`,
					model_catalog_url: `${origin}/v1/jouzu/model-catalog`,
					asr_realtime_url: `${origin}/asr`,
				},
				link_token: "link-token-secret",
				authorization_id: "auth-loopback",
				bonus: { status: "available", amount_usd: 10 },
			});
			return;
		}
		if (request.url === "/device/link/ack" && request.method === "POST") {
			if (behavior.ackStatus && behavior.ackStatus !== 204) {
				json(behavior.ackStatus, { error: "unavailable" });
				return;
			}
			response.writeHead(204);
			response.end();
			return;
		}
		if (request.url === "/v1/jouzu/model-catalog" && request.method === "GET") {
			if (behavior.catalogStatus && behavior.catalogStatus !== 200) {
				json(behavior.catalogStatus, { error: "unavailable" });
				return;
			}
			response.writeHead(200, { "content-type": MODEL_CATALOG_MEDIA_TYPE, etag: '"loopback"' });
			response.end(JSON.stringify(behavior.catalogDocument ?? fixtureRaw));
			return;
		}
		json(404, { error: "not_found" });
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	t.after(() => new Promise((resolve) => server.close(resolve)));

	const env = { JOUZU_SHISA_PLATFORM_URL: origin, ...(behavior.env ?? {}) };
	// Before sign-in the built-in Shisa source uses its production URL; substitute
	// only the transport so the test never reaches the real platform, and record
	// each substitution so tests can prove a signed-in refresh skipped it.
	const productionCatalogFetches = [];
	const catalogFetch = (input, init) => {
		const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(raw);
		if (url.origin === "https://api.shisa.ai") {
			productionCatalogFetches.push(url.pathname);
			return fetch(new URL(`${url.pathname}${url.search}`, origin), init);
		}
		return fetch(input, init);
	};
	const fastSleep = async (ms) => {
		await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10)));
	};

	if (behavior.cached) await refreshAvailableModelCatalogs(paths, { env, fetch: catalogFetch });
	behavior.prepare?.(paths, home, env);
	const runtime = await ModelRuntime.create({
		authPath: join(paths.agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(home, "models-store.json"),
		refreshOnCreate: false,
	});
	behavior.prepareRuntime?.(runtime);
	const picker = createJouzuModelPicker(paths, {
		palette: { env },
		catalogFetch: behavior.catalogFetch ?? catalogFetch,
		jouzuVersion: "0.1.13",
		...behavior.pickerOptions,
	});
	const notifications = [];
	const loader = new DefaultResourceLoader({
		cwd: home,
		agentDir: paths.agentDir,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		noPromptTemplates: true,
		extensionFactories: [
			createShisaExtension({
				paths,
				jouzuVersion: "0.1.13",
				env,
				fetchImpl: fetch,
				// Production wiring: Pi's OAuth login refreshes the same account state
				// the Settings account row refreshes after saving a credential.
				onSignedIn: async (signal) => {
					try {
						await picker.refreshShisaAccount({ signedIn: true, signal });
					} finally {
						behavior.onRefreshSettled?.();
					}
				},
			}),
			picker.extension,
			...(behavior.extensions ?? []),
		],
	});
	await loader.reload();
	const sessionManager = SessionManager.inMemory(home);
	if (behavior.conversation) sessionManager.appendMessage({ role: "user", content: "existing", timestamp: Date.now() });
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
		compaction: { enabled: false },
		...behavior.settings,
	});
	const { session, extensionsResult } = await createAgentSession({
		cwd: home,
		agentDir: paths.agentDir,
		modelRuntime: runtime,
		flowIngress: picker.wrapSessionIngress(behavior.selectionDelegate),
		resourceLoader: loader,
		sessionManager,
		settingsManager,
		...(behavior.thinkingLevel ? { thinkingLevel: behavior.thinkingLevel } : {}),
		tools: [],
	});
	t.after(() => session.dispose());
	assert.deepEqual(extensionsResult.errors, []);
	await session.bindExtensions({
		mode: behavior.mode ?? "rpc",
		uiContext: sessionUiContext(notifications),
		onError: (error) => assert.fail(error.message),
	});

	const component = new CatalogSettingsComponent({
		context: paletteContext(),
		paths,
		env,
		jouzuVersion: "0.1.13",
		login: (callbacks, options) => loginShisa(callbacks, { ...options, fetchImpl: fetch, sleep: fastSleep }),
		onCatalogsChanged: picker.reloadCatalogs,
		onAccountChanged: (change) => picker.refreshShisaAccount(change),
	});
	return {
		home,
		paths,
		env,
		origin,
		requests,
		productionCatalogFetches,
		runtime,
		picker,
		session,
		component,
		notifications,
		settingsManager,
	};
}

function focusAccount(component) {
	component.route({ view: "settings", query: "language" });
	for (let row = 0; row < 3; row++) component.handleInput("down");
	assert.equal(component.accountFocused, true, "the account row takes focus");
}

const isCatalogModel = (model) => model.id === "example-model" && model.provider !== "ai.example.gateway";

test("Settings connect saves the credential and makes authenticated catalog models usable without restart", async (t) => {
	const h = await harness(t);
	assert.equal(readShisaLoginToken(h.paths), undefined, "starts signed out");
	assert.equal(h.runtime.getModels().some(isCatalogModel), false, "no catalog model before sign-in");

	focusAccount(h.component);
	h.component.handleInput("enter");
	await waitFor(() => h.component.busy === false);

	assert.equal(readShisaLoginToken(h.paths), "shsk:loopback-secret", "the device-flow credential is saved");
	const catalogRequest = h.requests.find((request) => request.url === "/v1/jouzu/model-catalog");
	assert.ok(catalogRequest, "the authenticated catalog is fetched after sign-in");
	assert.deepEqual(h.productionCatalogFetches, [], "the catalog URL returned at sign-in is used");
	assert.equal(
		catalogRequest.authorization,
		"Bearer shsk:loopback-secret",
		"the login token authenticates the refresh",
	);
	assert.match(h.component.render(100).join("\n"), /Connected to Shisa AI\./u, "the panel reports success");

	const model = h.runtime.getModels().find(isCatalogModel);
	assert.ok(model, "the projected catalog model is registered in the live runtime");
	assert.ok((await h.runtime.getAvailable()).some(isCatalogModel), "the model is available for selection");
	assert.ok(await h.runtime.getAuth(model), "request auth resolves for the projected model");
	assert.equal(
		h.runtime.getRegisteredProviderConfig(SHISA_PROVIDER_ID)?.baseUrl,
		`${h.origin}/v1`,
		"the provider base URL follows the gateway that issued the sign-in",
	);
});

test("a denied device approval leaves the session signed out and unrefreshed", async (t) => {
	const h = await harness(t, { token: "deny" });
	focusAccount(h.component);
	h.component.handleInput("enter");
	await waitFor(() => h.component.busy === false);

	assert.equal(readShisaLoginToken(h.paths), undefined, "no credential is saved");
	assert.equal(
		h.requests.some((request) => request.url === "/v1/jouzu/model-catalog"),
		false,
	);
	assert.equal(h.runtime.getModels().some(isCatalogModel), false);
	assert.match(h.component.render(100).join("\n"), /could not complete/u, "the panel keeps the recovery message");
});

test("cancelling before approval leaves the session signed out and unrefreshed", async (t) => {
	const h = await harness(t, { token: "pending" });
	focusAccount(h.component);
	h.component.handleInput("enter");
	await waitFor(() => h.requests.some((request) => request.url === "/device/token"));
	assert.match(h.component.render(100).join("\n"), /JOUZU-LOOP-0001/u, "the device code is visible while polling");
	h.component.handleInput("escape");
	await waitFor(() => h.component.busy === false);

	assert.equal(readShisaLoginToken(h.paths), undefined, "cancelling never saves a credential");
	assert.equal(
		h.requests.some((request) => request.url === "/v1/jouzu/model-catalog"),
		false,
	);
	assert.equal(h.runtime.getModels().some(isCatalogModel), false);
	assert.match(h.component.render(100).join("\n"), /Shisa sign-in cancelled/u);
});

test("an unconfirmed acknowledgement warns but keeps the signed-in catalog available", async (t) => {
	const h = await harness(t, { ackStatus: 503 });
	focusAccount(h.component);
	h.component.handleInput("enter");
	await waitFor(() => h.component.busy === false);

	const text = h.component.render(100).join("\n");
	assert.match(text, /confirmation failed/u, "the acknowledgement warning survives the resolution");
	assert.match(text, /Sign in again/u);
	assert.doesNotMatch(text, /Connected to Shisa AI\./u, "an unacknowledged sign-in never reports plain success");
	assert.equal(
		readShisaLoginToken(h.paths),
		"shsk:loopback-secret",
		"the credential is saved regardless of acknowledgement",
	);
	assert.ok(
		h.requests.some((request) => request.url === "/device/link/ack"),
		"the acknowledgement was attempted",
	);
	assert.ok((await h.runtime.getAvailable()).some(isCatalogModel), "the saved credential still unlocks the catalog");
});

test("OAuth login fetches and projects the authenticated catalog without a restart", async (t) => {
	const h = await harness(t);
	assert.equal(readShisaLoginToken(h.paths), undefined, "starts signed out");
	assert.equal(h.runtime.getModels().some(isCatalogModel), false, "no catalog model before sign-in");
	assert.equal(
		h.requests.some((request) => request.url === "/v1/jouzu/model-catalog"),
		false,
		"no catalog request before sign-in",
	);

	const events = [];
	await h.runtime.login(SHISA_PROVIDER_ID, "oauth", {
		prompt: async () => assert.fail("OAuth login must not prompt"),
		notify: (event) => events.push(event),
	});

	assert.equal(readShisaLoginToken(h.paths), "shsk:loopback-secret", "the device-flow credential is saved");
	assert.ok(
		events.some((event) => event.type === "device_code"),
		"the login interaction receives the device code",
	);
	const catalogRequest = h.requests.find((request) => request.url === "/v1/jouzu/model-catalog");
	assert.ok(catalogRequest, "the authenticated catalog is fetched during login");
	assert.deepEqual(h.productionCatalogFetches, [], "the catalog URL returned at sign-in is used");
	assert.equal(
		catalogRequest.authorization,
		"Bearer shsk:loopback-secret",
		"the login token authenticates the refresh",
	);
	assert.equal(
		loadActiveModelCatalogs(h.paths, h.env)[0]?.document.revision,
		"fixture-1",
		"the refreshed catalog is cached for later sessions",
	);

	const model = h.runtime.getModels().find(isCatalogModel);
	assert.ok(model, "the projected catalog model is registered in the live runtime");
	assert.ok((await h.runtime.getAvailable()).some(isCatalogModel), "the model is available for selection");
	assert.ok(await h.runtime.getAuth(model), "request auth resolves for the projected model");
	assert.equal(
		h.runtime.getRegisteredProviderConfig(SHISA_PROVIDER_ID)?.baseUrl,
		`${h.origin}/v1`,
		"the provider base URL follows the gateway that issued the sign-in",
	);
});

test("OAuth reconnect fetches a new catalog even when an activated revision exists", async (t) => {
	const behavior = {};
	const h = await harness(t, behavior);
	const interaction = { prompt: async () => assert.fail("OAuth login must not prompt"), notify: () => {} };
	await h.runtime.login(SHISA_PROVIDER_ID, "oauth", interaction);
	assert.equal(loadActiveModelCatalogs(h.paths, h.env)[0]?.document.revision, "fixture-1");
	behavior.catalogDocument = structuredClone(fixtureRaw);
	behavior.catalogDocument.revision = "fixture-2";
	behavior.catalogDocument.sequence = String(BigInt(fixtureRaw.sequence) + 1n);
	behavior.catalogDocument.modelOfferings[0].name = "Updated catalog model";
	await h.runtime.login(SHISA_PROVIDER_ID, "oauth", interaction);
	assert.equal(h.requests.filter((request) => request.url === "/v1/jouzu/model-catalog").length, 2);
	assert.equal(loadActiveModelCatalogs(h.paths, h.env)[0]?.document.revision, "fixture-2");
	assert.equal(h.runtime.getModels().find(isCatalogModel)?.name, "Updated catalog model");
});

test("OAuth login keeps the saved credential when the catalog refresh fails", async (t) => {
	const h = await harness(t, { catalogStatus: 503 });
	await h.runtime.login(SHISA_PROVIDER_ID, "oauth", {
		prompt: async () => assert.fail("OAuth login must not prompt"),
		notify: () => {},
	});

	assert.equal(
		readShisaLoginToken(h.paths),
		"shsk:loopback-secret",
		"a failed catalog refresh never loses the credential",
	);
	assert.ok(
		h.requests.some((request) => request.url === "/v1/jouzu/model-catalog"),
		"the catalog refresh was attempted",
	);
	assert.equal(loadActiveModelCatalogs(h.paths, h.env).length, 0, "the failed catalog is not activated");
	assert.equal(h.runtime.getModels().some(isCatalogModel), false, "no catalog model is projected");
	const warning = h.notifications.find(
		(notification) => notification.level === "warning" && /Catalogs not refreshed/u.test(notification.message),
	);
	assert.ok(warning, "the failed refresh warns without failing sign-in");
});

function priorityCatalog({ nextUnavailable = false, priorities = true, sequence = "1" } = {}) {
	const document = structuredClone(fixtureRaw);
	document.sequence = sequence;
	document.revision = `priority-${sequence}`;
	const base = document.modelOfferings[0];
	document.modelOfferings = [
		base,
		...[
			["flash", 50],
			["flash-next", 100],
		].map(([id, priority]) => ({
			...structuredClone(base),
			id: `${base.providerId}/${id}`,
			modelId: id,
			name: id,
			capabilities: [...base.capabilities, "reasoning"],
			metadata: priorities ? { default: priority } : {},
			availability: {
				...base.availability,
				status: id === "flash-next" && nextUnavailable ? "unavailable" : "available",
			},
		})),
	];
	return document;
}

const firstUseOptions = {
	applyCatalogDefaultAtStartup: true,
	applyProjectDefaultAtStartup: true,
	restoreLastModelAtStartup: true,
};
const login = (h, signal) =>
	h.runtime.login(SHISA_PROVIDER_ID, "oauth", {
		signal,
		prompt: async () => assert.fail("unexpected prompt"),
		notify() {},
	});

test("first use selects the highest available catalog priority from a cached startup catalog", async (t) => {
	const h = await harness(t, {
		cached: true,
		env: { SHISA_API_KEY: "fixture-key" },
		catalogDocument: priorityCatalog(),
		pickerOptions: firstUseOptions,
	});
	assert.equal(h.session.model?.id, "flash-next");
	assert.equal(h.session.thinkingLevel, "medium", "catalog thinking default accompanies its model");
	assert.equal(
		h.settingsManager.getSettings().defaultModel,
		undefined,
		"automatic selection does not write a user preference",
	);
	assert.equal(new ModelPickerStore(h.paths).load().state.last, undefined, "selection is not a dispatch");
});

test("interactive first login selects Flash Next without false default-selection guidance", async (t) => {
	const h = await harness(t, { catalogDocument: priorityCatalog(), pickerOptions: firstUseOptions });
	const ui = interactiveLoginHost(h.session);
	await withPiAuthCompletion(() => ui.login());
	assert.equal(h.session.model?.id, "flash-next");
	assert.deepEqual(ui.errors, []);
	assert.match(ui.statuses[0], /Logged in to Shisa.*Credentials saved/);
	assert.equal(ui.refreshes.length, 1);
});

test("interactive cancellation after authorization reports signed in with refresh cancelled", async (t) => {
	const entered = Promise.withResolvers();
	const settled = Promise.withResolvers();
	const h = await harness(t, {
		pickerOptions: firstUseOptions,
		onRefreshSettled: () => settled.resolve(),
		catalogFetch: async (_url, { signal }) => {
			entered.resolve();
			return new Promise((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
			);
		},
	});
	const ui = interactiveLoginHost(h.session);
	await withPiAuthCompletion(async () => {
		const login = ui.login();
		await entered.promise;
		ui.focused.handleInput("\u001b");
		await login;
		await settled.promise;
	});
	assert.ok(readShisaLoginToken(h.paths));
	assert.equal(h.session.model?.id, "unknown");
	assert.deepEqual(ui.errors, []);
	assert.deepEqual(ui.statuses, ["Signed in to Shisa; catalog refresh cancelled. Run /reload to load Shisa models."]);
	assert.equal(ui.refreshes.length, 0, "completion must not restart the cancelled refresh");
});

test("interactive cancellation before approval does not report signed in", async (t) => {
	const h = await harness(t, { token: "pending", pickerOptions: firstUseOptions });
	const ui = interactiveLoginHost(h.session);
	await withPiAuthCompletion(async () => {
		const login = ui.login();
		await waitFor(() => h.requests.some((request) => request.url === "/device/token"));
		ui.focused.handleInput("\u001b");
		await login;
	});
	assert.equal(readShisaLoginToken(h.paths), undefined);
	assert.deepEqual(ui.statuses, []);
	assert.equal(ui.refreshes.length, 0);
});

for (const method of ["OAuth", "Settings"]) {
	test(`${method} first login selects the highest available default without restarting`, async (t) => {
		const h = await harness(t, { catalogDocument: priorityCatalog(), pickerOptions: firstUseOptions });
		assert.equal(h.session.model?.id, "unknown");
		if (method === "OAuth") await login(h);
		else {
			focusAccount(h.component);
			h.component.handleInput("enter");
			await waitFor(() => h.component.busy === false);
		}
		assert.equal(h.session.model?.id, "flash-next");
	});
}

test("first use skips an unavailable higher-priority offering", async (t) => {
	const h = await harness(t, {
		catalogDocument: priorityCatalog({ nextUnavailable: true }),
		pickerOptions: firstUseOptions,
	});
	await login(h);
	assert.equal(h.session.model?.id, "flash");
});

for (const choice of ["project", "last", "pi-settings", "explicit", "scope", "resume", "conversation", "disabled"]) {
	test(`catalog default does not override ${choice} selection policy`, async (t) => {
		const h = await harness(t, {
			cached: true,
			env: { SHISA_API_KEY: "fixture-key" },
			catalogDocument: priorityCatalog(),
			pickerOptions: {
				...firstUseOptions,
				...(choice === "disabled" ? { applyCatalogDefaultAtStartup: false } : {}),
				startupArgs:
					choice === "explicit"
						? ["--model", "example-model"]
						: choice === "scope"
							? ["--models=example-model"]
							: choice === "resume"
								? ["--resume"]
								: [],
			},
			settings: choice === "pi-settings" ? { defaultProvider: "saved-provider", defaultModel: "saved-model" } : {},
			conversation: choice === "conversation",
			prepare(paths, home) {
				const store = new ModelPickerStore(paths);
				const reference = {
					catalogId: fixtureRaw.catalogId,
					offeringId: fixtureRaw.modelOfferings[0].id,
					provider: fixtureRaw.providers[0].id,
					modelId: "example-model",
				};
				if (choice === "project") store.setProjectDefault(reference, deriveProjectKey(home));
				if (choice === "last") store.recordDispatch(reference, deriveProjectKey(home));
			},
		});
		assert.notEqual(h.session.model?.id, "flash-next");
		if (choice === "project" || choice === "last") assert.equal(h.session.model?.id, "example-model");
		await h.picker.reloadCatalogs();
		assert.notEqual(h.session.model?.id, "flash-next", "refresh does not bypass a saved or explicit choice");
	});
}

test("a delayed catalog default applies only until a model is chosen", async (t) => {
	const behavior = { catalogDocument: priorityCatalog({ priorities: false }), pickerOptions: firstUseOptions };
	const h = await harness(t, behavior);
	await login(h);
	assert.equal(h.session.model?.id, "unknown", "no hint leaves the existing fallback unchanged");
	behavior.catalogDocument = priorityCatalog({ sequence: "2" });
	await h.picker.refreshShisaAccount({ signedIn: true });
	assert.equal(h.session.model?.id, "flash-next", "late authenticated hints fill an untouched empty session");
	const flash = (await h.runtime.getAvailable()).find((model) => model.id === "flash");
	await h.session.setModel(flash);
	await h.picker.refreshShisaAccount({ signedIn: true });
	assert.equal(h.session.model?.id, "flash", "later refresh preserves the user's selection");
});

test("first-use hints preserve explicit startup thinking", async (t) => {
	const h = await harness(t, {
		cached: true,
		env: { SHISA_API_KEY: "fixture-key" },
		catalogDocument: priorityCatalog(),
		pickerOptions: { ...firstUseOptions, startupArgs: ["--thinking", "low"] },
		thinkingLevel: "low",
	});
	assert.equal(h.session.model?.id, "flash-next");
	assert.equal(h.session.thinkingLevel, "low");
});

test("cached priorities wait for authentication before selecting a model", async (t) => {
	const h = await harness(t, {
		cached: true,
		env: { SHISA_API_KEY: "fixture-key" },
		catalogDocument: priorityCatalog(),
		pickerOptions: firstUseOptions,
		prepare(_paths, _home, env) {
			delete env.SHISA_API_KEY;
		},
	});
	assert.equal(h.session.model?.id, "unknown");
	await login(h);
	assert.equal(h.session.model?.id, "flash-next");
});

test("login chooses from the refreshed account catalog, not the signed-out cache", async (t) => {
	const behavior = {
		cached: true,
		env: { SHISA_API_KEY: "fixture-key" },
		catalogDocument: priorityCatalog(),
		pickerOptions: firstUseOptions,
		prepare(_paths, _home, env) {
			delete env.SHISA_API_KEY;
		},
	};
	const h = await harness(t, behavior);
	behavior.catalogDocument = priorityCatalog({ nextUnavailable: true, sequence: "2" });
	await login(h);
	assert.equal(h.session.model?.id, "flash", "fresh entitlement wins over the cached recommendation");
});

test("an automatic first-use selection remains stable when later priorities change", async (t) => {
	const behavior = { catalogDocument: priorityCatalog(), pickerOptions: firstUseOptions };
	const h = await harness(t, behavior);
	await login(h);
	assert.equal(h.session.model?.id, "flash-next");
	behavior.catalogDocument = priorityCatalog({ sequence: "2" });
	behavior.catalogDocument.modelOfferings.find((offering) => offering.modelId === "flash").metadata.default = 200;
	await h.picker.refreshShisaAccount({ signedIn: true });
	assert.equal(h.session.model?.id, "flash-next");
});

test("automatic selection crosses an asynchronous host hook without waiting on itself", async (t) => {
	let restore;
	const h = await harness(t, {
		catalogDocument: priorityCatalog(),
		pickerOptions: firstUseOptions,
		selectionDelegate: {
			version: 1,
			attach(session) {
				const original = session.setModel;
				session.setModel = async (...args) => {
					await Promise.resolve();
					return original.apply(session, args);
				};
				restore = () => {
					session.setModel = original;
				};
			},
			dispose() {
				restore?.();
			},
			async submit(_submission, dispatch) {
				await dispatch();
			},
		},
	});
	await login(h);
	assert.equal(h.session.model?.id, "flash-next");
});

test("a model_select extension can replace the automatic choice without a self-join", async (t) => {
	let replaced = false;
	const h = await harness(t, {
		catalogDocument: priorityCatalog(),
		pickerOptions: firstUseOptions,
		extensions: [
			{
				name: "replace-default",
				factory(pi) {
					pi.on("model_select", async (event, ctx) => {
						if (event.model.id !== "flash-next" || replaced) return;
						replaced = true;
						await pi.setModel(ctx.modelRegistry.find(event.model.provider, "flash"));
					});
				},
			},
		],
	});
	await login(h);
	assert.equal(replaced, true);
	assert.equal(h.session.model?.id, "flash");
});

for (const honorsAbort of [true, false]) {
	test(`cancelling login during catalog fetch stops late selection (transport honors abort: ${honorsAbort})`, async (t) => {
		const entered = Promise.withResolvers();
		const release = Promise.withResolvers();
		const settled = Promise.withResolvers();
		t.after(() => release.resolve());
		let fetchSignal;
		const h = await harness(t, {
			pickerOptions: firstUseOptions,
			onRefreshSettled: () => settled.resolve(),
			catalogFetch: async (_url, { signal }) => {
				fetchSignal = signal;
				entered.resolve();
				if (honorsAbort)
					await new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
				else await release.promise;
				return new Response(JSON.stringify(priorityCatalog()), {
					headers: { "content-type": MODEL_CATALOG_MEDIA_TYPE },
				});
			},
		});
		const controller = new AbortController();
		const signingIn = login(h, controller.signal);
		const rejected = assert.rejects(signingIn, /Login cancelled/);
		await entered.promise;
		assert.ok(readShisaLoginToken(h.paths), "device authorization has already saved the credential");
		controller.abort(new Error("Login cancelled"));
		await rejected;
		assert.equal(fetchSignal.aborted, true);
		release.resolve();
		await settled.promise;
		assert.equal(h.session.model?.id, "unknown");
		assert.equal(loadActiveModelCatalogs(h.paths, h.env).length, 0, "aborted response is not activated");
		assert.deepEqual(h.notifications, [], "cancellation is not reported as a refresh failure");
	});
}

test("cancelling login during default authentication prevents model mutation", async (t) => {
	const settled = Promise.withResolvers();
	let auth;
	const h = await harness(t, {
		catalogDocument: priorityCatalog(),
		pickerOptions: firstUseOptions,
		onRefreshSettled: () => settled.resolve(),
		prepareRuntime(runtime) {
			auth = holdNextCatalogAuth({ runtime }, true);
		},
	});
	t.after(auth.release);
	const controller = new AbortController();
	const signingIn = login(h, controller.signal);
	const rejected = assert.rejects(signingIn, /Login cancelled/);
	await auth.entered;
	controller.abort(new Error("Login cancelled"));
	await rejected;
	auth.release();
	await settled.promise;
	assert.equal(h.session.model?.id, "unknown");
	assert.equal(
		h.session.sessionManager
			.getEntries()
			.some((entry) => entry.type === "model_change" && entry.modelId === "flash-next"),
		false,
	);
	assert.deepEqual(h.notifications, []);
});

for (const action of ["set", "cycle"]) {
	test(`cancelling automatic selection does not cancel a waiting native ${action}`, async (t) => {
		let auth;
		const h = await harness(t, {
			catalogDocument: priorityCatalog(),
			pickerOptions: firstUseOptions,
			prepareRuntime(runtime) {
				auth = holdNextCatalogAuth({ runtime });
			},
		});
		t.after(auth.release);
		const controller = new AbortController();
		const rejected = assert.rejects(login(h, controller.signal), /Login cancelled/);
		await auth.entered;
		const target = (await h.runtime.getAvailable()).find((model) => model.id === "flash");
		const choice = action === "set" ? h.session.setModel(target) : h.session.cycleModel("forward");
		controller.abort(new Error("Login cancelled"));
		await rejected;
		auth.release();
		await choice;
		if (action === "set") assert.equal(h.session.model?.id, "flash");
		else assert.notEqual(h.session.model?.id, "unknown");
	});
}

function holdNextCatalogAuth(h, afterAuth = false) {
	const auth = h.runtime.checkAuth.bind(h.runtime);
	const entered = Promise.withResolvers();
	const release = Promise.withResolvers();
	let held = false;
	h.runtime.checkAuth = async (provider, ...args) => {
		if (!held && provider !== SHISA_PROVIDER_ID) {
			held = true;
			const result = afterAuth ? await auth(provider, ...args) : undefined;
			entered.resolve();
			await release.promise;
			if (afterAuth) return result;
		}
		return auth(provider, ...args);
	};
	return { entered: entered.promise, release: () => release.resolve() };
}

for (const action of ["set", "cycle"]) {
	test(`in-flight first-use auth cannot override a later native ${action} choice`, async (t) => {
		const h = await harness(t, { catalogDocument: priorityCatalog(), pickerOptions: firstUseOptions });
		const auth = holdNextCatalogAuth(h);
		t.after(auth.release);
		const signingIn = login(h);
		await auth.entered;
		const target = (await h.runtime.getAvailable()).find((model) => model.id === "flash");
		let finished = false;
		const choice = (action === "set" ? h.session.setModel(target) : h.session.cycleModel("backward")).then(() => {
			finished = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(finished, false, "the native selection waits for the automatic auth check");
		auth.release();
		await Promise.all([signingIn, choice]);
		assert.notEqual(h.session.model?.id, "flash-next", "the user's choice runs last");
		if (action === "set") assert.equal(h.session.model?.id, "flash");
		await h.picker.reloadCatalogs();
		assert.notEqual(h.session.model?.id, "flash-next");
	});
}

test("input waits for in-flight first-use selection before request preparation", async (t) => {
	const seen = [];
	const h = await harness(t, {
		catalogDocument: priorityCatalog(),
		pickerOptions: firstUseOptions,
		extensions: [
			{
				name: "capture-input",
				factory(pi) {
					pi.on("input", (_event, ctx) => {
						seen.push(ctx.model?.id);
						return { action: "handled" };
					});
				},
			},
		],
	});
	const auth = holdNextCatalogAuth(h);
	t.after(auth.release);
	const signingIn = login(h);
	await auth.entered;
	const prompt = h.session.prompt("hello");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(seen, [], "request preparation cannot run against the previous model");
	auth.release();
	await Promise.all([signingIn, prompt]);
	assert.deepEqual(seen, ["flash-next"]);
});

test("custom turns drain in-flight selection before dispatch and close first-use eligibility", async (t) => {
	const behavior = { catalogDocument: priorityCatalog(), pickerOptions: firstUseOptions };
	const h = await harness(t, behavior);
	const dispatched = [];
	h.session.agent.streamFunction = async (model) => {
		dispatched.push(model.id);
		const final = { ...assistant(), provider: model.provider, model: model.id, api: model.api };
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "done", partial: final };
			},
			result: async () => final,
		};
	};
	const auth = holdNextCatalogAuth(h);
	t.after(auth.release);
	const signingIn = login(h);
	await auth.entered;
	const turn = h.session.sendCustomMessage(
		{ customType: "fixture", content: "hello", display: false },
		{ triggerTurn: true },
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(dispatched, []);
	auth.release();
	await Promise.all([signingIn, turn]);
	assert.deepEqual(dispatched, ["flash-next"]);
	behavior.catalogDocument = priorityCatalog({ sequence: "2" });
	behavior.catalogDocument.modelOfferings.find((offering) => offering.modelId === "flash").metadata.default = 200;
	await h.picker.refreshShisaAccount({ signedIn: true });
	assert.equal(h.session.model?.id, "flash-next");
});

test("a manual choice before hints arrive prevents a late default override", async (t) => {
	const behavior = { catalogDocument: priorityCatalog({ priorities: false }), pickerOptions: firstUseOptions };
	const h = await harness(t, behavior);
	await login(h);
	const flash = (await h.runtime.getAvailable()).find((model) => model.id === "flash");
	await h.session.setModel(flash);
	behavior.catalogDocument = priorityCatalog({ sequence: "2" });
	await h.picker.refreshShisaAccount({ signedIn: true });
	assert.equal(h.session.model?.id, "flash");
});
