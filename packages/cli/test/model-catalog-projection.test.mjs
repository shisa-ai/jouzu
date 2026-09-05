import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { parseAndValidateModelCatalog } from "../dist/model-catalog.js";
import { CatalogProjectionController, projectCatalogProviders } from "../dist/model-catalog-projection.js";

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
