import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { setCatalogSourceToken } from "../dist/catalog-sources.js";
import { writeContextPolicy } from "../dist/context-clamp.js";
import { parseAndValidateModelCatalog } from "../dist/model-catalog.js";
import { CatalogProjectionController, projectCatalogProviders } from "../dist/model-catalog-projection.js";
import { resolveJouzuPaths } from "../dist/paths.js";

const fixture = () =>
	parseAndValidateModelCatalog(
		readFileSync(join(import.meta.dirname, "..", "catalog", "fixtures", "account-snapshot-v1.json"), "utf8"),
		{ remote: true },
	);

const activeCatalog = (document, id = "test") => ({
	source: {
		id,
		label: `${id} catalog`,
		url: `https://${id}.example.test/catalog`,
		enabled: true,
		auth: { type: "none" },
	},
	document,
});

const model = (id, overrides = {}) => ({
	id,
	name: `Local ${id}`,
	provider: "ai.example.gateway",
	api: "openai-completions",
	baseUrl: "https://gateway.example.test/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 },
	contextWindow: 4096,
	maxTokens: 1024,
	compat: { supportsDeveloperRole: true },
	...overrides,
});

test("active catalogs override ordinary model metadata and add complete offerings to configured providers", () => {
	const document = fixture();
	const added = structuredClone(document.modelOfferings[0]);
	added.id = "ai.example.gateway/new-model";
	added.modelId = "new-model";
	added.name = "New Model";
	added.capabilities = ["text", "reasoning"];
	document.modelOfferings.push(added);

	const result = projectCatalogProviders(
		[model("example-model"), model("local-only", { name: "Private model" })],
		[activeCatalog(document)],
	);
	assert.deepEqual(result.skipped, []);
	assert.equal(result.providers.length, 1);
	const [provider] = result.providers;
	assert.equal(provider.providerId, "ai.example.gateway");
	assert.deepEqual(provider.addedModelIds, ["new-model"]);
	assert.deepEqual(provider.overriddenModelIds, ["example-model"]);

	const existing = provider.models.find((candidate) => candidate.id === "example-model");
	assert.deepEqual(
		{
			name: existing.name,
			reasoning: existing.reasoning,
			input: existing.input,
			contextWindow: existing.contextWindow,
			maxTokens: existing.maxTokens,
			cost: existing.cost,
			compat: existing.compat,
		},
		{
			name: "Example Model",
			reasoning: false,
			input: ["text"],
			contextWindow: 131072,
			maxTokens: 32768,
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 },
			compat: { supportsDeveloperRole: true },
		},
	);
	assert.equal(provider.models.find((candidate) => candidate.id === "local-only").name, "Private model");

	const catalogOnly = provider.models.find((candidate) => candidate.id === "new-model");
	assert.deepEqual(
		{
			name: catalogOnly.name,
			api: catalogOnly.api,
			baseUrl: catalogOnly.baseUrl,
			reasoning: catalogOnly.reasoning,
			input: catalogOnly.input,
			contextWindow: catalogOnly.contextWindow,
			maxTokens: catalogOnly.maxTokens,
			cost: catalogOnly.cost,
			compat: catalogOnly.compat,
		},
		{
			name: "New Model",
			api: "openai-completions",
			baseUrl: "https://gateway.example.test/v1",
			reasoning: true,
			input: ["text"],
			contextWindow: 131072,
			maxTokens: 32768,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsDeveloperRole: true },
		},
	);
});

test("catalog projection fails closed for conflicting sources and unknown provider routes", () => {
	const first = fixture();
	const second = structuredClone(first);
	second.catalogId = "ai.example.second";
	second.modelOfferings[0].name = "Conflicting name";

	const conflict = projectCatalogProviders(
		[model("example-model")],
		[activeCatalog(first), activeCatalog(second, "second")],
	);
	assert.deepEqual(conflict.providers, []);
	assert.deepEqual(conflict.skipped, [
		{
			providerId: "ai.example.gateway",
			modelId: "example-model",
			reason: "conflicting-catalogs",
		},
	]);

	const unknownProvider = projectCatalogProviders([], [activeCatalog(first)]);
	assert.deepEqual(unknownProvider.providers, []);
	assert.deepEqual(unknownProvider.skipped, [
		{
			providerId: "ai.example.gateway",
			modelId: "example-model",
			reason: "no-provider-route",
		},
	]);
});

test("catalog projection requires complete limits and an unambiguous provider route for new models", () => {
	const incomplete = fixture();
	delete incomplete.modelOfferings[0].limits.maxOutputTokens;
	const incompleteResult = projectCatalogProviders([model("local-only")], [activeCatalog(incomplete)]);
	assert.deepEqual(incompleteResult.providers, []);
	assert.equal(incompleteResult.skipped[0].reason, "incomplete-offering");

	const ambiguous = fixture();
	delete ambiguous.modelOfferings[0].api;
	const ambiguousResult = projectCatalogProviders(
		[
			model("local-chat"),
			model("local-responses", { api: "openai-responses", baseUrl: "https://responses.example.test/v1" }),
		],
		[activeCatalog(ambiguous)],
	);
	assert.deepEqual(ambiguousResult.providers, []);
	assert.equal(ambiguousResult.skipped[0].reason, "no-provider-route");
});

test("catalog projection composes through Pi without rewriting models.json", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-catalog-pi-composition-"));
	try {
		const modelsPath = join(root, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"ai.example.gateway": {
						api: "openai-completions",
						baseUrl: "https://gateway.example.test/v1",
						apiKey: "test-key",
						models: [
							{
								id: "example-model",
								name: "Stale local name",
								contextWindow: 4096,
								maxTokens: 1024,
							},
							{ id: "local-only", name: "Local only" },
						],
					},
				},
			}),
		);
		const runtime = await ModelRuntime.create({ modelsPath, refreshOnCreate: false });
		const registry = new ModelRegistry(runtime);
		const pi = {
			registerProvider: (providerId, config) => registry.registerProvider(providerId, config),
			unregisterProvider: (providerId) => registry.unregisterProvider(providerId),
		};
		const ctx = { modelRegistry: registry };
		const controller = new CatalogProjectionController();
		const document = fixture();
		const added = structuredClone(document.modelOfferings[0]);
		added.id = "ai.example.gateway/catalog-only";
		added.modelId = "catalog-only";
		added.name = "Catalog only";
		document.modelOfferings.push(added);
		controller.sync(pi, ctx, [activeCatalog(document)]);

		assert.equal(registry.find("ai.example.gateway", "example-model").name, "Example Model");
		assert.equal(registry.find("ai.example.gateway", "example-model").contextWindow, 131072);
		assert.equal(registry.find("ai.example.gateway", "catalog-only").name, "Catalog only");
		assert.equal(registry.find("ai.example.gateway", "local-only").name, "Local only");
		assert.equal(JSON.parse(readFileSync(modelsPath, "utf8")).providers["ai.example.gateway"].models.length, 2);
		controller.release(pi, ctx);
		assert.equal(registry.find("ai.example.gateway", "example-model").name, "Stale local name");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("projection controller removes only its own overlay and restores the local provider inventory", async () => {
	const baseline = [model("local-only")];
	let models = baseline;
	let nativeProvider;
	let registered;
	const registry = {
		getAll: () => models,
		getRegisteredProviderConfig: () => registered,
		getRegisteredNativeProvider: () => nativeProvider,
		refresh: async () => ({ aborted: false, errors: new Map() }),
	};
	const pi = {
		registerProvider(providerId, config) {
			assert.equal(providerId, "ai.example.gateway");
			registered = config;
			models = config.models.map((definition) => ({ ...definition, provider: providerId }));
		},
		unregisterProvider(providerId) {
			assert.equal(providerId, "ai.example.gateway");
			registered = undefined;
			models = baseline;
		},
	};
	const ctx = { modelRegistry: registry };
	const controller = new CatalogProjectionController();

	const applied = controller.sync(pi, ctx, [activeCatalog(fixture())]);
	assert.deepEqual(applied.providers[0].addedModelIds, ["example-model"]);
	assert.ok(models.some((candidate) => candidate.id === "example-model"));

	controller.sync(pi, ctx, []);
	assert.equal(registered, undefined);
	assert.deepEqual(models, baseline);

	const external = { models: [] };
	registered = external;
	const blocked = controller.sync(pi, ctx, [activeCatalog(fixture())]);
	assert.deepEqual(blocked.blockedProviderIds, ["ai.example.gateway"]);
	assert.equal(registered, external);

	registered = undefined;
	nativeProvider = { id: "ai.example.gateway" };
	const nativeBlocked = controller.sync(pi, ctx, [activeCatalog(fixture())]);
	assert.deepEqual(nativeBlocked.blockedProviderIds, ["ai.example.gateway"]);
	assert.equal(registered, undefined);

	nativeProvider = undefined;
	await controller.refresh(pi, ctx, [activeCatalog(fixture())]);
	assert.ok(models.some((candidate) => candidate.id === "example-model"));
	controller.release(pi, ctx);
	assert.deepEqual(models, baseline);
});

test("gateway catalog wins local route, auth, headers and explicit overrides without modifying local state", async () => {
	const { catalogRuntimeProvider, resolveCatalogModel } = await import("../dist/model-catalog-projection.js");
	const { pickerModels } = await import("../dist/model-picker.js");
	const root = mkdtempSync(join(tmpdir(), "jouzu-gateway-precedence-"));
	try {
		const modelsPath = join(root, "models.json");
		const localConfig = JSON.stringify({
			providers: {
				"ai.example.gateway": {
					baseUrl: "https://direct.example.test/v1",
					api: "openai-completions",
					apiKey: "$JOUZU_TEST_MISSING_UPSTREAM_KEY",
					headers: { "x-local-secret": "must-not-forward" },
					models: [{ id: "example-model", contextWindow: 4096 }, { id: "local-only" }],
					modelOverrides: {
						"example-model": {
							name: "Local override",
							contextWindow: 2048,
							headers: { Authorization: "Bearer wrong" },
						},
					},
				},
			},
		});
		writeFileSync(modelsPath, localConfig);
		const runtime = await ModelRuntime.create({ modelsPath, authPath: join(root, "auth.json") });
		const registry = new ModelRegistry(runtime);
		const ctx = { modelRegistry: registry, scopedModels: [] };
		const pi = {
			registerProvider: (...args) => registry.registerProvider(...args),
			unregisterProvider: (id) => registry.unregisterProvider(id),
		};
		const controller = new CatalogProjectionController({ GATEWAY_TOKEN: "gateway-jwt" });
		const catalog = activeCatalog(fixture());
		catalog.source.url = "https://pool.example.test/v1/jouzu/model-catalog";
		catalog.source.auth = { type: "bearer", credentialRef: "env:GATEWAY_TOKEN" };
		const added = structuredClone(catalog.document.modelOfferings[0]);
		added.providerId = "new-provider";
		added.modelId = "new-model";
		added.id = "new-provider/new-model";
		catalog.document.modelOfferings.push(added);
		controller.sync(pi, ctx, [catalog]);
		const reference = { provider: "ai.example.gateway", modelId: "example-model" };
		const effective = resolveCatalogModel(ctx, reference, [catalog]);
		assert.equal(
			effective.provider,
			catalogRuntimeProvider(catalog.document.catalogId, reference.provider, catalog.source.url),
		);
		assert.equal(effective.baseUrl, "https://pool.example.test/v1");
		assert.equal(effective.name, "Example Model");
		assert.equal(effective.contextWindow, 131072);
		const request = await runtime.prepareRequest(effective);
		assert.equal(request.options.apiKey, "gateway-jwt");
		assert.equal(request.options.headers.Authorization, "Bearer gateway-jwt");
		assert.equal(request.options.headers["x-local-secret"], undefined);
		assert.equal(registry.find("ai.example.gateway", "local-only").baseUrl, "https://direct.example.test/v1");
		const rows = pickerModels(ctx, [catalog], { GATEWAY_TOKEN: "gateway-jwt" });
		assert.equal(
			rows.filter((row) => row.provider === reference.provider && row.modelId === reference.modelId).length,
			1,
		);
		assert.ok(rows.some((row) => row.provider === "new-provider" && row.available));
		assert.ok(rows.every((row) => !row.provider.startsWith("catalog:")));
		assert.equal(rows.find((row) => row.provider === reference.provider).catalogId, catalog.document.catalogId);
		const refreshing = controller.refresh(pi, ctx, [catalog], AbortSignal.timeout(5000));
		assert.ok(registry.find(effective.provider, effective.id), "refresh keeps displayed gateway models selectable");
		await refreshing;
		assert.equal(resolveCatalogModel(ctx, reference, [catalog]).baseUrl, "https://pool.example.test/v1");
		catalog.source.url = "https://replacement.example.test/v1/jouzu/model-catalog";
		controller.sync(pi, ctx, [catalog]);
		const rebound = resolveCatalogModel(ctx, reference, [catalog]);
		assert.notEqual(
			rebound.provider,
			effective.provider,
			"changing gateway origins invalidates the old connection identity",
		);
		assert.equal(rebound.baseUrl, "https://replacement.example.test/v1");
		assert.equal(registry.find(effective.provider, effective.id), undefined);
		assert.equal(readFileSync(modelsPath, "utf8"), localConfig);
		controller.sync(pi, ctx, []);
		assert.equal(resolveCatalogModel(ctx, reference, []).baseUrl, "https://direct.example.test/v1");
		assert.equal(registry.find(effective.provider, effective.id), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("catalog-qualified selection keeps two gateway credentials separate and never falls back to a local collision", async () => {
	const { resolveCatalogModel } = await import("../dist/model-catalog-projection.js");
	const { pickerModels } = await import("../dist/model-picker.js");
	const root = mkdtempSync(join(tmpdir(), "jouzu-gateway-sources-"));
	try {
		const modelsPath = join(root, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"ai.example.gateway": {
						baseUrl: "https://local.example.test/v1",
						api: "openai-completions",
						apiKey: "local-key",
						models: [{ id: "example-model" }, { id: "local-only" }],
					},
				},
			}),
		);
		const runtime = await ModelRuntime.create({ modelsPath, authPath: join(root, "auth.json") });
		const registry = new ModelRegistry(runtime);
		const ctx = { modelRegistry: registry, scopedModels: [] };
		const pi = {
			registerProvider: (...args) => registry.registerProvider(...args),
			unregisterProvider: (id) => registry.unregisterProvider(id),
		};
		const first = activeCatalog(fixture());
		first.source.url = "https://first.example.test/v1/jouzu/model-catalog";
		first.source.auth = { type: "bearer", credentialRef: "env:FIRST_GATEWAY_KEY" };
		const second = structuredClone(first);
		second.document.catalogId = "ai.example.second";
		second.source.url = "https://second.example.test/v1/jouzu/model-catalog";
		second.source.auth.credentialRef = "env:SECOND_GATEWAY_KEY";
		const catalogs = [first, second];
		const controller = new CatalogProjectionController({
			FIRST_GATEWAY_KEY: "first-key",
			SECOND_GATEWAY_KEY: "second-key",
		});
		controller.sync(pi, ctx, catalogs);
		const reference = { provider: "ai.example.gateway", modelId: "example-model" };
		assert.equal(
			resolveCatalogModel(ctx, reference, catalogs),
			undefined,
			"unqualified ambiguous selection must not use local credentials",
		);
		for (const [catalog, key] of [
			[first, "first-key"],
			[second, "second-key"],
		]) {
			const selected = resolveCatalogModel(ctx, { ...reference, catalogId: catalog.document.catalogId }, catalogs);
			assert.equal((await runtime.prepareRequest(selected)).options.apiKey, key);
		}
		const rows = pickerModels(ctx, catalogs, { FIRST_GATEWAY_KEY: "first-key", SECOND_GATEWAY_KEY: "second-key" });
		assert.equal(rows.filter((row) => row.modelId === "example-model").length, 2);
		assert.ok(rows.some((row) => row.modelId === "local-only" && row.available));
		controller.release(pi, ctx);
		const missing = new CatalogProjectionController({});
		first.source.auth.credentialRef = "env:JOUZU_TEST_MISSING_GATEWAY_KEY";
		missing.sync(pi, ctx, [first]);
		await runtime.refresh({ allowNetwork: false });
		const unavailable = pickerModels(ctx, [first]).find((row) => row.modelId === "example-model");
		assert.equal(unavailable.available, false);
		assert.equal(unavailable.catalogId, first.document.catalogId);
		missing.release(pi, ctx);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("gateway model dispatch sends the catalog bearer and compatibility to the gateway", async () => {
	const { createServer } = await import("node:http");
	const { once } = await import("node:events");
	const { resolveCatalogModel } = await import("../dist/model-catalog-projection.js");
	const requests = [];
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		requests.push({ url: request.url, headers: request.headers, body: JSON.parse(body) });
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		response.end(
			'data: {"id":"reply","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"reply","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n',
		);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const root = mkdtempSync(join(tmpdir(), "jouzu-gateway-dispatch-"));
	try {
		const runtime = await ModelRuntime.create({
			modelsPath: join(root, "models.json"),
			authPath: join(root, "auth.json"),
		});
		const registry = new ModelRegistry(runtime);
		const ctx = { modelRegistry: registry };
		const pi = {
			registerProvider: (...args) => registry.registerProvider(...args),
			unregisterProvider: (id) => registry.unregisterProvider(id),
		};
		const catalog = activeCatalog(fixture());
		catalog.source.url = `http://127.0.0.1:${server.address().port}/v1/jouzu/model-catalog`;
		catalog.source.auth = { type: "bearer", credentialRef: "env:GATEWAY_TOKEN" };
		catalog.document.compatibilityProfiles[0].projections = {
			pi: {
				compat: {
					supportsDeveloperRole: false,
					supportsReasoningEffort: true,
					maxTokensField: "max_tokens",
				},
			},
		};
		catalog.document.modelOfferings[0].supportedThinkingLevels = ["off", "low", "high", "xhigh", "max"];
		catalog.document.modelOfferings[0].capabilities = ["reasoning"];
		const controller = new CatalogProjectionController({
			GATEWAY_TOKEN: "gateway-test-jwt",
		});
		controller.registerStartup(pi, [catalog]);
		const reference = { provider: "ai.example.gateway", modelId: "example-model" };
		assert.ok(resolveCatalogModel(ctx, reference, [catalog]), "registered before session restoration");
		controller.sync(pi, ctx, [catalog]);
		const selected = resolveCatalogModel(ctx, reference, [catalog]);
		const result = await runtime.complete(
			selected,
			{
				systemPrompt: "test instruction",
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			{ maxTokens: 8, reasoningEffort: "max" },
		);
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(requests.length, 1);
		assert.equal(requests[0].url, "/v1/chat/completions");
		assert.equal(requests[0].headers.authorization, "Bearer gateway-test-jwt");
		assert.equal(requests[0].body.model, "example-model");
		assert.equal(requests[0].body.max_tokens, 8);
		assert.deepEqual(getSupportedThinkingLevels(selected), ["off", "low", "high", "xhigh", "max"]);
		assert.equal(requests[0].body.reasoning_effort, "max");
		await runtime.complete(
			selected,
			{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
			{ maxTokens: 8 },
		);
		assert.equal(requests[1].body.reasoning_effort, "none");
		assert.equal(requests[0].body.messages[0].role, "system");
		const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(
			"@earendil-works/pi-coding-agent"
		);
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: root,
			modelRuntime: runtime,
			model: selected,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(root),
			tools: [],
			settingsManager: SettingsManager.inMemory({ defaultThinkingLevel: "medium" }),
		});
		try {
			assert.deepEqual(session.getAvailableThinkingLevels(), ["off", "low", "high", "xhigh", "max"]);
			session.setThinkingLevel("medium");
			assert.equal(session.thinkingLevel, "high");
			assert.equal(session.cycleThinkingLevel(), "xhigh");
			assert.equal(session.cycleThinkingLevel(), "max");
			assert.equal(session.cycleThinkingLevel(), "off");
			catalog.document.modelOfferings[0].supportedThinkingLevels = ["low", "high"];
			controller.sync(pi, ctx, [catalog]);
			await session.setModel(resolveCatalogModel(ctx, reference, [catalog]));
			assert.deepEqual(session.getAvailableThinkingLevels(), ["low", "high"]);
			session.setThinkingLevel("max");
			assert.equal(session.thinkingLevel, "high");
			session.setThinkingLevel("off");
			assert.equal(session.thinkingLevel, "low");
		} finally {
			session.dispose();
		}

		controller.release(pi, ctx);
		assert.equal(registry.find(selected.provider, selected.id), undefined);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		rmSync(root, { recursive: true, force: true });
	}
});

test("a saved source token serves the gateway when the environment has no value", async () => {
	const { resolveCatalogModel } = await import("../dist/model-catalog-projection.js");
	const root = mkdtempSync(join(tmpdir(), "jouzu-projection-saved-token-"));
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "jouzu") });
		const runtime = await ModelRuntime.create({
			modelsPath: join(root, "models.json"),
			authPath: join(root, "auth.json"),
		});
		const registry = new ModelRegistry(runtime);
		const ctx = { modelRegistry: registry, scopedModels: [] };
		const pi = {
			registerProvider: (...args) => registry.registerProvider(...args),
			unregisterProvider: (id) => registry.unregisterProvider(id),
		};
		const catalog = activeCatalog(fixture());
		catalog.source.url = "https://pool.example.test/v1/jouzu/model-catalog";
		catalog.source.auth = { type: "bearer", credentialRef: "env:GATEWAY_TOKEN" };
		setCatalogSourceToken(paths, catalog.source.id, "saved-gateway-jwt");

		const saved = new CatalogProjectionController({}, paths);
		saved.sync(pi, ctx, [catalog]);
		const reference = { provider: "ai.example.gateway", modelId: "example-model" };
		const resolved = resolveCatalogModel(ctx, reference, [catalog]);
		assert.ok(resolved, "the gateway projection registers the offering");
		assert.equal((await runtime.prepareRequest(resolved)).options.apiKey, "saved-gateway-jwt");
		saved.release(pi, ctx);

		// The environment value still wins over the saved token.
		const env = new CatalogProjectionController({ GATEWAY_TOKEN: "env-gateway-jwt" }, paths);
		env.sync(pi, ctx, [catalog]);
		assert.equal(
			(await runtime.prepareRequest(resolveCatalogModel(ctx, reference, [catalog]))).options.apiKey,
			"env-gateway-jwt",
		);
		env.release(pi, ctx);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("catalog levels constrain existing and added models while preserving native effort mappings", () => {
	const document = fixture();
	const offering = document.modelOfferings[0];
	offering.supportedThinkingLevels = ["low", "high", "xhigh", "max"];
	offering.capabilities = ["reasoning"];
	offering.defaultThinkingLevel = "high";
	document.modelOfferings.push({ ...offering, id: "new", modelId: "new" });
	const result = projectCatalogProviders(
		[
			model("example-model", {
				thinkingLevelMap: { high: "native-high", xhigh: "native-max" },
			}),
			model("untouched"),
		],
		[activeCatalog(document)],
	);
	const models = result.providers[0].models;
	for (const id of ["example-model", "new"]) {
		const selected = models.find((model) => model.id === id);
		assert.deepEqual(getSupportedThinkingLevels(selected), offering.supportedThinkingLevels);
		assert.equal(clampThinkingLevel(selected, "off"), "low");
		assert.equal(clampThinkingLevel(selected, "medium"), "high");
		assert.equal(clampThinkingLevel(selected, "max"), "max");
	}
	assert.equal(models[0].thinkingLevelMap.high, "native-high");
	assert.equal(models[0].thinkingLevelMap.xhigh, "native-max");
	assert.equal(models.find((model) => model.id === "untouched").thinkingLevelMap, undefined);
	const conflict = structuredClone(document);
	conflict.modelOfferings[0].supportedThinkingLevels = ["high"];
	assert.ok(
		projectCatalogProviders([model("example-model")], [activeCatalog(document), activeCatalog(conflict)]).skipped.some(
			(skip) => skip.modelId === "example-model" && skip.reason === "conflicting-catalogs",
		),
	);
});

test("catalog levels unknown to this client are filtered before projection", () => {
	const document = fixture();
	document.modelOfferings[0].supportedThinkingLevels = ["low", "ultra"];
	document.modelOfferings[0].capabilities = ["reasoning"];
	document.modelOfferings[0].defaultThinkingLevel = "ultra";
	const parsed = parseAndValidateModelCatalog(JSON.stringify(document));
	assert.deepEqual(parsed.modelOfferings[0].supportedThinkingLevels, ["low"]);
	assert.equal(parsed.modelOfferings[0].defaultThinkingLevel, undefined);
	const result = projectCatalogProviders([model("example-model")], [activeCatalog(parsed)]);
	const selected = result.providers[0].models.find((candidate) => candidate.id === "example-model");
	assert.deepEqual(getSupportedThinkingLevels(selected), ["low"]);
	assert.equal(selected.reasoning, true);
});

test("a context clamp caps catalog models and adds a clamp-only overlay for untouched providers", () => {
	const local = model("example-model");
	const other = { ...model("big-model"), provider: "ai.example.other", contextWindow: 1_000_000 };
	const catalogs = [activeCatalog(fixture())];
	const clamped = projectCatalogProviders([local, other], catalogs, { maxContextTokens: 100_000 });
	const gateway = clamped.providers.find((provider) => provider.providerId === "ai.example.gateway");
	assert.equal(gateway.models.find((candidate) => candidate.id === "example-model").contextWindow, 100_000);
	assert.deepEqual(gateway.clampedModelIds, ["example-model"]);
	const untouched = clamped.providers.find((provider) => provider.providerId === "ai.example.other");
	assert.equal(untouched.addedModelIds.length, 0);
	assert.deepEqual(untouched.clampedModelIds, ["big-model"]);
	assert.equal(untouched.models.find((candidate) => candidate.id === "big-model").contextWindow, 100_000);

	// A ceiling above every model leaves the projection exactly as it was.
	const unclamped = projectCatalogProviders([local, other], catalogs, { maxContextTokens: 2_000_000 });
	assert.deepEqual(unclamped.providers.map((provider) => provider.providerId), ["ai.example.gateway"]);
	assert.deepEqual(unclamped.providers[0].clampedModelIds, []);
	assert.equal(
		projectCatalogProviders([local, other], catalogs, { maxContextTokens: 2_000_000 })
			.providers[0].models.find((candidate) => candidate.id === "example-model").contextWindow,
		131_072,
	);
});

test("the clamp survives the projection controller round-trip for a local provider", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-context-clamp-local-"));
	try {
		const modelsPath = join(root, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"ai.example.local": {
						api: "openai-completions",
						baseUrl: "https://local.example.test/v1",
						apiKey: "local-key",
						models: [{ id: "big-model", name: "Big", contextWindow: 1_000_000, maxTokens: 32_768 }],
					},
				},
			}),
		);
		const paths = resolveJouzuPaths({ homeOverride: join(root, "jouzu") });
		mkdirSync(paths.configDir, { recursive: true });
		writeContextPolicy(paths, 384_000);
		const runtime = await ModelRuntime.create({ modelsPath, refreshOnCreate: false });
		const registry = new ModelRegistry(runtime);
		const ctx = { modelRegistry: registry };
		const pi = {
			registerProvider: (providerId, config) => registry.registerProvider(providerId, config),
			unregisterProvider: (providerId) => registry.unregisterProvider(providerId),
		};
		const controller = new CatalogProjectionController({}, paths);

		const applied = controller.sync(pi, ctx, []);
		assert.deepEqual(
			applied.providers.find((provider) => provider.providerId === "ai.example.local").clampedModelIds,
			["big-model"],
		);
		assert.equal(registry.find("ai.example.local", "big-model").contextWindow, 384_000);
		assert.equal(registry.getRegisteredProviderConfig("ai.example.local").refreshModels !== undefined, true);

		// The refresh hook re-applies the ceiling to models reloaded from models.json.
		const provider = registry.getProvider("ai.example.local");
		await provider.refreshModels({
			allowNetwork: false,
			force: false,
			signal: new AbortController().signal,
			stored: undefined,
			publish: async (update) => {
				await update.update();
				return true;
			},
		});
		assert.equal(registry.find("ai.example.local", "big-model").contextWindow, 384_000);

		writeContextPolicy(paths, undefined);
		controller.sync(pi, ctx, []);
		assert.equal(registry.find("ai.example.local", "big-model").contextWindow, 1_000_000);
		assert.equal(
			registry.getRegisteredProviderConfig("ai.example.local"),
			undefined,
			"turning the ceiling off removes the clamp overlay",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a gateway catalog clamps its models through the controller", async () => {
	const { catalogRuntimeProvider } = await import("../dist/model-catalog-projection.js");
	const root = mkdtempSync(join(tmpdir(), "jouzu-context-clamp-gateway-"));
	try {
		const modelsPath = join(root, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"ai.example.gateway": {
						api: "openai-completions",
						baseUrl: "https://gateway.example.test/v1",
						apiKey: "test-key",
						models: [{ id: "example-model", name: "Stale local name", contextWindow: 4096, maxTokens: 1024 }],
					},
				},
			}),
		);
		const paths = resolveJouzuPaths({ homeOverride: join(root, "jouzu") });
		mkdirSync(paths.configDir, { recursive: true });
		writeContextPolicy(paths, 384_000);
		const runtime = await ModelRuntime.create({ modelsPath, refreshOnCreate: false });
		const registry = new ModelRegistry(runtime);
		const ctx = { modelRegistry: registry };
		const pi = {
			registerProvider: (providerId, config) => registry.registerProvider(providerId, config),
			unregisterProvider: (providerId) => registry.unregisterProvider(providerId),
		};
		const catalog = activeCatalog(fixture());
		catalog.source.url = "https://pool.example.test/v1/jouzu/model-catalog";
		catalog.source.auth = { type: "bearer", credentialRef: "env:GATEWAY_TOKEN" };
		catalog.document.modelOfferings[0].limits = { contextWindow: 1_000_000, maxOutputTokens: 32_768 };
		const controller = new CatalogProjectionController({ GATEWAY_TOKEN: "gateway-jwt" }, paths);

		controller.registerStartup(pi, [catalog]);
		const gatewayId = catalogRuntimeProvider(catalog.document.catalogId, "ai.example.gateway", catalog.source.url);
		assert.equal(registry.find(gatewayId, "example-model").contextWindow, 384_000);

		// Turning the ceiling off re-registers the gateway with its declared window.
		writeContextPolicy(paths, undefined);
		controller.sync(pi, ctx, [catalog]);
		assert.equal(registry.find(gatewayId, "example-model").contextWindow, 1_000_000);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a native provider is wrapped while the ceiling is active and restored after release", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-context-clamp-native-"));
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "jouzu") });
		mkdirSync(paths.configDir, { recursive: true });
		writeContextPolicy(paths, 384_000);
		const runtime = await ModelRuntime.create({ modelsPath: join(root, "models.json"), refreshOnCreate: false });
		const registry = new ModelRegistry(runtime);
		const ctx = { modelRegistry: registry };
		const pi = {
			registerProvider: (...args) => registry.registerProvider(...args),
			unregisterProvider: (providerId) => registry.unregisterProvider(providerId),
		};
		const nativeProvider = {
			id: "native-test",
			name: "Native Test",
			auth: {
				apiKey: {
					name: "API key",
					check: async () => ({ type: "api_key", source: "test" }),
					resolve: async () => ({ auth: { apiKey: "native-key" }, source: "test" }),
				},
			},
			getModels: () => [
				{
					id: "big-model",
					name: "Big",
					provider: "native-test",
					api: "openai-completions",
					baseUrl: "https://native.example.test/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1_000_000,
					maxTokens: 32_768,
				},
			],
			stream: () => {
				throw new Error("stream is not used in this test");
			},
			streamSimple: () => {
				throw new Error("streamSimple is not used in this test");
			},
		};
		runtime.registerNativeProvider(nativeProvider);
		assert.equal(registry.find("native-test", "big-model").contextWindow, 1_000_000);

		const controller = new CatalogProjectionController({}, paths);
		const applied = controller.sync(pi, ctx, []);
		assert.deepEqual(
			applied.providers.find((provider) => provider.providerId === "native-test").clampedModelIds,
			["big-model"],
		);
		assert.notEqual(registry.getRegisteredNativeProvider("native-test"), nativeProvider);
		assert.equal(registry.find("native-test", "big-model").contextWindow, 384_000);

		controller.release(pi, ctx);
		assert.equal(registry.getRegisteredNativeProvider("native-test"), nativeProvider);
		assert.equal(registry.find("native-test", "big-model").contextWindow, 1_000_000);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
