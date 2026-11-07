import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CatalogSourceStore } from "../dist/catalog-sources.js";
import { writeContextPolicy } from "../dist/context-clamp.js";
import { createJouzuKeybindingsManagerFromConfig } from "../dist/jouzu-keybindings.js";
import { resolveCatalog } from "../dist/locale-catalog.js";
import { MODEL_CATALOG_MEDIA_TYPE, parseAndValidateModelCatalog } from "../dist/model-catalog.js";
import { catalogRuntimeProvider } from "../dist/model-catalog-projection.js";
import { refreshCatalogSource } from "../dist/model-catalog-sync.js";
import {
	catalogModelReference,
	catalogPickerModel,
	catalogPickerModels,
	compactContextForModelSwitch,
	createJouzuModelPicker,
	ModelPickerComponent,
	pickerModels,
} from "../dist/model-picker.js";
import { buildPickerRows, modelContextFit } from "../dist/model-picker-ranking.js";
import { deriveProjectKey, emptyModelPickerState, ModelPickerStore } from "../dist/model-picker-state.js";
import { JouzuPaletteRouter, paletteHeightBudget } from "../dist/palette.js";
import { resolveJouzuPaths } from "../dist/paths.js";
import { createSessionUiStyles } from "../dist/session-ui/index.js";

const identityTheme = {
	fg: (_role, value) => value,
	bg: (_role, value) => value,
	bold: (value) => value,
};

test("active catalog metadata qualifies matching Pi models without changing local fallbacks", () => {
	const catalog = parseAndValidateModelCatalog(
		readFileSync(join(import.meta.dirname, "..", "catalog", "fixtures", "account-snapshot-v1.json"), "utf8"),
		{ remote: true },
	);
	const matching = catalogPickerModel(
		{
			provider: "ai.example.gateway",
			id: "example-model",
			name: "Pi label",
			contextWindow: 1,
			maxTokens: 1,
		},
		catalog,
	);
	assert.deepEqual(
		{
			catalogId: matching.catalogId,
			offeringId: matching.offeringId,
			name: matching.name,
			contextWindow: matching.contextWindow,
			maxTokens: matching.maxTokens,
			available: matching.available,
		},
		{
			catalogId: "ai.example.test",
			offeringId: "ai.example.gateway/example-model",
			name: "Example Model",
			contextWindow: 131072,
			maxTokens: 32768,
			available: true,
		},
	);
	assert.deepEqual(catalogModelReference("ai.example.gateway", "example-model", catalog), {
		catalogId: "ai.example.test",
		offeringId: "ai.example.gateway/example-model",
		provider: "ai.example.gateway",
		modelId: "example-model",
	});
	assert.deepEqual(catalogModelReference("local", "unlisted", catalog), {
		provider: "local",
		modelId: "unlisted",
	});

	const secondCatalog = structuredClone(catalog);
	secondCatalog.catalogId = "org.example.second";
	secondCatalog.modelOfferings[0].id = "org.example.second/example-model";
	secondCatalog.modelOfferings[0].name = "Second route";
	const qualified = catalogPickerModels(
		{
			provider: "ai.example.gateway",
			id: "example-model",
			name: "Pi label",
			contextWindow: 1,
			maxTokens: 1,
		},
		[
			{
				source: {
					id: "first",
					label: "First catalog",
					url: "https://first.test/catalog",
					enabled: true,
					auth: { type: "none" },
				},
				document: catalog,
			},
			{
				source: {
					id: "second",
					label: "Second catalog",
					url: "https://second.test/catalog",
					enabled: true,
					auth: { type: "none" },
				},
				document: secondCatalog,
			},
		],
	);
	assert.deepEqual(
		qualified.map((model) => [model.catalogId, model.offeringId, model.catalogLabel]),
		[
			["ai.example.test", "ai.example.gateway/example-model", "First catalog"],
			["org.example.second", "org.example.second/example-model", "Second catalog"],
		],
	);
});

test("catalog offering ratings and published prices populate separate picker fields", () => {
	const document = JSON.parse(
		readFileSync(join(import.meta.dirname, "..", "catalog", "fixtures", "account-snapshot-v1.json"), "utf8"),
	);
	const model = {
		provider: "ai.example.gateway",
		id: "example-model",
		name: "Pi label",
		contextWindow: 1,
		maxTokens: 1,
	};
	for (const tier of [1, 2, 3, 4]) {
		document.modelOfferings[0].metadata = {
			strength: tier,
			speed: tier,
			cost: tier,
			price: { currency: "USD", input: 99, output: 199, unit: "per_1m_tokens" },
			other: "ignored",
		};
		const catalog = parseAndValidateModelCatalog(JSON.stringify(document), { remote: true });
		const snapshot = structuredClone(catalog);
		const pickerModel = catalogPickerModel(model, catalog);
		assert.deepEqual(pickerModel.comparison, { strength: tier, speed: tier, cost: tier });
		assert.deepEqual(pickerModel.price, { input: 99, output: 199 });
		assert.equal(pickerModel.cost, undefined);
		assert.deepEqual(catalog, snapshot, "reading ratings does not mutate the catalog");
	}
	assert.equal(catalogPickerModel(model).comparison, undefined);
	assert.equal(catalogPickerModel({ ...model, id: "unlisted" }, document).comparison, undefined);
});

test("catalog prices preserve zero and partial rates without importing upstream references", () => {
	const catalog = JSON.parse(
		readFileSync(join(import.meta.dirname, "..", "catalog", "fixtures", "account-snapshot-v1.json"), "utf8"),
	);
	const model = { provider: "ai.example.gateway", id: "example-model", name: "Example" };
	const price = {
		currency: "USD",
		unit: "per_1m_tokens",
		input: 0,
		output: 0.000001,
		cacheRead: null,
		cacheWrite: 0.125,
		upstreamReference: { cacheRead: 99 },
	};
	catalog.modelOfferings[0].metadata = { price };
	assert.deepEqual(catalogPickerModel(model, catalog).price, { input: 0, output: 0.000001, cacheWrite: 0.125 });
	assert.equal(catalogPickerModel({ ...model, id: "unlisted" }, catalog).price, undefined);
	for (const invalid of [
		undefined,
		null,
		[],
		{},
		{ ...price, currency: "EUR" },
		{ ...price, unit: "per_token" },
		{ currency: "USD", unit: "per_1m_tokens", input: -1, output: "2", cacheRead: NaN, cacheWrite: Infinity },
		{ currency: "USD", unit: "per_1m_tokens", upstreamReference: { input: 99 } },
	]) {
		catalog.modelOfferings[0].metadata = { price: invalid };
		assert.equal(catalogPickerModel(model, catalog).price, undefined);
	}
});

test("selected model prices wrap, follow selection, and disappear without known rates", () => {
	const inventory = rows();
	inventory[0].model.price = { input: 0, output: 0.000001, cacheRead: 0.25, cacheWrite: 1.25 };
	const terminal = { rows: 40 };
	for (const locale of ["en", "ja", "zh-Hans", "zh-Hant"]) {
		const { component } = createComponent({
			terminal,
			catalog: resolveCatalog(locale).bundle,
			getRows: () => inventory,
		});
		for (const width of [48, 80, 160]) {
			const lines = component.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			const text = stripSgr(lines.join("\n"));
			for (const rate of ["$0", "$0.000001", "$0.25", "$1.25"]) assert.ok(text.includes(rate), text);
			assert.match(text, /\$\/(?:1M|100万|百万|百萬)/u);
			const priceStart = lines.findIndex((line) => line.includes("$/"));
			const priceEnd = lines.findIndex((line) => line.includes("$1.25"));
			for (const line of lines.slice(priceStart, priceEnd + 1)) {
				assert.match(stripSgr(line), /^│ {2}\S/u, "every pricing row shares the detail indent");
			}
			if (locale === "en" && width === 160) {
				assert.match(text, /1K context \/ 100 output/u);
				assert.match(text, /\$\/1M tokens {2}\$0\.00 in · \$0\.000001 out · \$0\.25 cached · \$1\.25 cache write/u);
			}
		}
		component.handleInput("down");
		assert.doesNotMatch(component.render(160).join("\n"), /\$\//u);
		component.handleInput("up");
		for (const height of [16, 12, 8]) {
			terminal.rows = height;
			const lines = component.render(48);
			assert.ok(lines.length <= paletteHeightBudget(height));
			assert.ok(lines.every((line) => visibleWidth(line) <= 48));
		}
		terminal.rows = 40;
		component.dispose();
	}
});

test("catalog picker ratings ignore malformed metadata and invalid tiers independently", () => {
	const catalog = parseAndValidateModelCatalog(
		readFileSync(join(import.meta.dirname, "..", "catalog", "fixtures", "account-snapshot-v1.json"), "utf8"),
		{ remote: true },
	);
	const model = {
		provider: "ai.example.gateway",
		id: "example-model",
		name: "Pi label",
		contextWindow: 1,
		maxTokens: 1,
	};
	for (const metadata of [undefined, null, false, 3, "ratings", [], {}, { price: { input: 1, output: 2 } }]) {
		catalog.modelOfferings[0].metadata = metadata;
		assert.equal(catalogPickerModel(model, catalog).comparison, undefined);
	}
	for (const key of ["strength", "speed", "cost"]) {
		for (const value of [undefined, null, false, true, "3", 0, -1, 5, 1.5, NaN, Infinity, {}, []]) {
			catalog.modelOfferings[0].metadata = { strength: 4, speed: 3, cost: 2, [key]: value };
			const expected = { strength: 4, speed: 3, cost: 2 };
			delete expected[key];
			assert.deepEqual(catalogPickerModel(model, catalog).comparison, expected, `${key}: ${String(value)}`);
		}
	}
	catalog.modelOfferings[0].metadata = { speed: 2 };
	assert.deepEqual(catalogPickerModel(model, catalog).comparison, { speed: 2 });
});

test("picker ratings stay scoped to their catalog for local and gateway identities", () => {
	const first = parseAndValidateModelCatalog(
		readFileSync(join(import.meta.dirname, "..", "catalog", "fixtures", "account-snapshot-v1.json"), "utf8"),
		{ remote: true },
	);
	first.modelOfferings[0].metadata = { strength: 4, speed: 3, cost: 2 };
	const second = structuredClone(first);
	second.catalogId = "org.example.second";
	second.modelOfferings[0].id = "org.example.second/example-model";
	second.modelOfferings[0].metadata = { strength: 2, speed: 4, cost: 1 };
	const active = [first, second].map((document, index) => ({
		source: {
			id: `source-${index}`,
			label: `Catalog ${index}`,
			url: `https://source-${index}.test/catalog`,
			enabled: true,
			auth: { type: "none" },
		},
		document,
	}));
	const model = {
		provider: "ai.example.gateway",
		id: "example-model",
		name: "Pi label",
		contextWindow: 1,
		maxTokens: 1,
	};
	assert.deepEqual(
		catalogPickerModels(model, active).map((row) => row.comparison),
		[
			{ strength: 4, speed: 3, cost: 2 },
			{ strength: 2, speed: 4, cost: 1 },
		],
	);
	for (const { document } of active) {
		const gatewayModel = { ...model, provider: catalogRuntimeProvider(document.catalogId, model.provider) };
		assert.deepEqual(catalogPickerModels(gatewayModel, active)[0].comparison, document.modelOfferings[0].metadata);
	}
	const refreshed = structuredClone(first);
	refreshed.modelOfferings[0].metadata = { strength: 3, speed: 2, cost: 4 };
	assert.deepEqual(catalogPickerModels(model, [{ ...active[0], document: refreshed }])[0].comparison, {
		strength: 3,
		speed: 2,
		cost: 4,
	});
});

test("catalog offering lookups index an immutable snapshot once", () => {
	const catalog = parseAndValidateModelCatalog(
		readFileSync(join(import.meta.dirname, "..", "catalog", "fixtures", "account-snapshot-v1.json"), "utf8"),
		{ remote: true },
	);
	let offeringReads = 0;
	catalog.modelOfferings = new Proxy(catalog.modelOfferings, {
		get(target, property, receiver) {
			if (typeof property === "string" && /^\d+$/u.test(property)) offeringReads += 1;
			return Reflect.get(target, property, receiver);
		},
	});
	const activeCatalogs = [
		{
			source: {
				id: "indexed",
				label: "Indexed catalog",
				url: "https://indexed.test/catalog",
				enabled: true,
				auth: { type: "none" },
			},
			document: catalog,
		},
	];
	const model = {
		provider: "ai.example.gateway",
		id: "example-model",
		name: "Pi label",
		contextWindow: 1,
		maxTokens: 1,
	};

	assert.equal(catalogPickerModels(model, activeCatalogs)[0].name, "Example Model");
	const readsAfterIndexing = offeringReads;
	assert.ok(readsAfterIndexing > 0);
	assert.equal(catalogPickerModels(model, activeCatalogs)[0].name, "Example Model");
	assert.equal(offeringReads, readsAfterIndexing);
});

test("session startup, /reload, and Catalogs changes project offerings into configured providers", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-catalog-projection-"));
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
		const document = JSON.parse(
			readFileSync(join(import.meta.dirname, "..", "catalog", "fixtures", "account-snapshot-v1.json"), "utf8"),
		);
		const sourceStore = new CatalogSourceStore(paths);
		const source = sourceStore.add({
			label: "Office pool",
			url: "http://127.0.0.1:8989/v1/jouzu/model-catalog",
			auth: { type: "none" },
		});
		await refreshCatalogSource(paths, source, {
			env: {},
			fetch: async () =>
				new Response(JSON.stringify(document), {
					status: 200,
					headers: { "content-type": MODEL_CATALOG_MEDIA_TYPE },
				}),
		});

		const baseline = [
			{
				id: "local-only",
				name: "Local only",
				provider: "ai.example.gateway",
				api: "openai-completions",
				baseUrl: "https://gateway.example.test/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 1024,
			},
		];
		let models = baseline;
		let registered;
		const modelRegistry = {
			getAll: () => models,
			getAvailable: () => models,
			getRegisteredProviderConfig: () => registered,
			getRegisteredNativeProvider: () => undefined,
			find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
			refresh: async () => ({ aborted: false, errors: new Map() }),
		};
		const refreshedDocument = structuredClone(document);
		refreshedDocument.revision = "fixture-2";
		refreshedDocument.sequence = "2";
		refreshedDocument.modelOfferings[0].name = "Example Model Refreshed";
		const handlers = new Map();
		const integration = createJouzuModelPicker(paths, {
			palette: { env: {} },
			catalogFetch: async () =>
				new Response(JSON.stringify(refreshedDocument), {
					status: 200,
					headers: { "content-type": MODEL_CATALOG_MEDIA_TYPE },
				}),
		});
		const pi = {
			on(event, handler) {
				handlers.set(event, handler);
			},
			registerCommand() {},
			registerProvider(providerId, config) {
				registered = config;
				models = config.models.map((model) => ({ ...model, provider: providerId }));
			},
			unregisterProvider() {
				registered = undefined;
				models = baseline;
			},
			setModel: async () => true,
			setThinkingLevel() {},
		};
		integration.extension.factory(pi);
		const ctx = {
			mode: "tui",
			cwd: root,
			model: baseline[0],
			scopedModels: [],
			sessionManager: { getBranch: () => [] },
			modelRegistry,
			ui: { notify() {} },
		};
		await handlers.get("session_start")({ reason: "startup" }, ctx);
		assert.equal(modelRegistry.find("ai.example.gateway", "example-model").contextWindow, 131072);
		assert.equal(modelRegistry.find("ai.example.gateway", "local-only").name, "Local only");

		sourceStore.setEnabled(source.id, false);
		integration.reloadCatalogs();
		assert.equal(modelRegistry.find("ai.example.gateway", "example-model"), undefined);
		assert.equal(modelRegistry.find("ai.example.gateway", "local-only").name, "Local only");

		sourceStore.setEnabled(source.id, true);
		integration.reloadCatalogs();
		assert.equal(modelRegistry.find("ai.example.gateway", "example-model").name, "Example Model");

		await handlers.get("session_start")({ reason: "reload" }, ctx);
		assert.equal(modelRegistry.find("ai.example.gateway", "example-model").name, "Example Model Refreshed");
		await handlers.get("session_shutdown")({}, ctx);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function stripSgr(value) {
	return value
		.split("\u001b")
		.map((segment, index) => (index === 0 ? segment : segment.replace(/^\[[0-9;]*m/, "")))
		.join("");
}

function fakeKeybindings(overrides = {}) {
	const keys = {
		"tui.select.down": ["down"],
		"tui.select.up": ["up"],
		"tui.select.pageDown": ["pageDown"],
		"tui.select.pageUp": ["pageUp"],
		"tui.select.confirm": ["enter"],
		"tui.select.cancel": ["escape", "ctrl+c"],
		...overrides,
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

function rows() {
	return [
		{
			section: "current",
			model: { provider: "small", modelId: "tiny", name: "Tiny", contextWindow: 1000, maxTokens: 100, available: true },
			contextFit: "too-small",
			favorite: false,
			projectDefault: false,
			rank: 0,
		},
		{
			section: "other",
			model: {
				provider: "large",
				modelId: "fit",
				name: "Large Model",
				contextWindow: 200_000,
				maxTokens: 10_000,
				available: true,
			},
			contextFit: "fits",
			favorite: false,
			projectDefault: false,
			rank: 1,
		},
	];
}

function createComponent(overrides = {}) {
	const calls = { close: 0, selected: [], compacted: [], favorites: [], renders: 0 };
	const component = new ModelPickerComponent({
		context: {
			tui: {
				terminal: overrides.terminal ?? { rows: 30 },
				requestRender() {
					calls.renders += 1;
				},
			},
			theme: identityTheme,
			styles: createSessionUiStyles(identityTheme),
			catalog: overrides.catalog,
			keybindings: overrides.keybindings ?? fakeKeybindings(),
			jouzuKeybindings: overrides.jouzuKeybindings ?? createJouzuKeybindingsManagerFromConfig(),
			close() {
				calls.close += 1;
			},
		},
		initialRoute: { view: "models" },
		getRows: overrides.getRows ?? (() => rows()),
		onSelect: async (row) => {
			calls.selected.push(row.model.modelId);
		},
		onCompactAndSelect: async (row) => {
			calls.compacted.push(row.model.modelId);
			await overrides.onCompactAndSelect?.(row);
		},
		onToggleFavorite: (row) => {
			calls.favorites.push(row.model.modelId);
			overrides.onToggleFavorite?.(row);
		},
		...(overrides.onRefresh ? { onRefresh: overrides.onRefresh } : {}),
		...(overrides.onRefreshCatalogs ? { onRefreshCatalogs: overrides.onRefreshCatalogs } : {}),
		...(overrides.subscribeCatalogsReloaded ? { subscribeCatalogsReloaded: overrides.subscribeCatalogsReloaded } : {}),
	});
	return { component, calls };
}

test("Japanese model rows keep the current columns and query-preserving favorite route", () => {
	const { component, calls } = createComponent({
		catalog: resolveCatalog("ja").bundle,
		jouzuKeybindings: createJouzuKeybindingsManagerFromConfig({ "jouzu.model.toggleFavorite": "f" }),
	});
	for (const width of [24, 48, 80, 120]) {
		const lines = component.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(lines.join("\n"), /名前/u);
		assert.doesNotMatch(lines.join("\n"), /Recent|Favorites|View|Models|Workflow|Settings/u);
		if (width >= 48) {
			assert.match(stripSgr(lines[0]), /JOUZU · モデル/u);
			assert.match(lines[1], /\[モデル\].*ワークフロー.*設定/u);
		}
		if (width >= 80) assert.match(lines.join("\n"), /コンテキスト/u);
	}
	component.handleInput("/");
	component.handleInput("a");
	const search = stripSgr(component.render(120).join("\n"));
	assert.match(search, /検索をクリア/u);
	assert.match(search, /↑↓ → F/u);
	component.handleInput("down");
	assert.equal(component.snapshotRoute().query, "a");
	component.handleInput("f");
	assert.equal(calls.favorites.length, 1);
	component.handleInput("escape");
	assert.equal(component.snapshotRoute().query, undefined);
	assert.equal(calls.close, 0);
	component.dispose();
});

test("Models fills the shared height budget, pages visibly, and survives short-terminal resizing", () => {
	const inventory = Array.from({ length: 100 }, (_, index) => ({
		...rows()[1],
		model: { ...rows()[1].model, modelId: `model-${index}`, name: `Model ${index} 日本語` },
	}));
	for (const locale of ["en", "ja"]) {
		const terminal = { rows: 80 };
		const { component } = createComponent({
			terminal,
			catalog: resolveCatalog(locale).bundle,
			getRows: () => inventory,
			keybindings: fakeKeybindings({ "tui.select.confirm": ["ctrl+shift+enter"] }),
		});
		for (const width of [24, 48, 80, 120]) {
			const lines = component.render(width);
			assert.equal(lines.length, paletteHeightBudget(terminal.rows));
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.ok(lines.filter((line) => line.includes("Model ")).length > 12);
			assert.match(stripSgr(lines.join("\n")), /Ctrl\+Shift\+Enter/u);
			assert.match(lines.join("\n"), /Esc\/Ctrl\+C/u);
		}
		const pageSize = component.render(120).filter((line) => line.includes("Model ")).length;
		component.handleInput("pageDown");
		assert.match(stripSgr(component.render(120).join("\n")), new RegExp(`→.*Model ${pageSize}(?:\\s|$)`, "u"));
		component.handleInput("\x1b[F");
		for (const rows of [24, 16, 12, 8, 4, 1, 80]) {
			terminal.rows = rows;
			for (const width of [24, 48, 80, 120]) {
				const lines = component.render(width);
				assert.ok(lines.length <= paletteHeightBudget(rows));
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
				if (rows >= 12) {
					assert.match(stripSgr(lines.join("\n")), /→.*Model 99/u);
					assert.match(lines.join("\n"), /Esc\/Ctrl\+C/u);
					assert.ok(lines.at(-1).startsWith("╰"));
				}
			}
		}
		component.dispose();
	}
});

test("Models scrolls a bounded viewport and marks hidden rows above and below", () => {
	const inventory = Array.from({ length: 100 }, (_, index) => ({
		...rows()[1],
		model: { ...rows()[1].model, modelId: `model-${index}`, name: `Model ${index}` },
	}));
	const terminal = { rows: 24 };
	const { component } = createComponent({ terminal, getRows: () => inventory });
	const render = () => stripSgr(component.render(80).join("\n"));
	const tall = render();
	assert.match(tall, /→.*Model 0/u);
	assert.match(tall, /█/u, "the scrollbar thumb marks the current position");
	assert.match(tall, /▼/u, "the scrollbar marks content below the viewport");
	assert.doesNotMatch(tall, /▲/u);

	terminal.rows = 12;
	let view = render();
	assert.match(view, /→.*Model 0/u);
	assert.match(view, /▼/u);
	assert.doesNotMatch(view, /▲/u);

	component.handleInput("down");
	view = render();
	assert.match(view, /→.*Model 1/u);
	assert.match(view, /↕/u);
	component.handleInput("up");
	view = render();
	assert.match(view, /→.*Model 0/u);
	assert.match(view, /▼/u);

	component.handleInput("pageDown");
	view = render();
	assert.match(view, /→.*Model 1/u);
	assert.match(view, /↕/u, "one visible row reports both hidden sides");
	component.handleInput("pageUp");
	view = render();
	assert.match(view, /→.*Model 0/u);
	assert.match(view, /▼/u);

	component.handleInput("\x1b[F");
	view = render();
	assert.match(view, /→.*Model 99/u);
	assert.match(view, /▲/u);
	assert.doesNotMatch(view, /▼/u);

	component.handleInput("\x1b[H");
	view = render();
	assert.match(view, /→.*Model 0/u);
	assert.match(view, /▼/u);

	component.handleInput("/");
	component.handleInput("\x1b[1;5F");
	view = render();
	assert.match(view, /→.*Model 99/u, "Ctrl+End reaches the last item while search holds focus");
	assert.match(view, /▲/u);
	component.handleInput("\x1b[1;5H");
	view = render();
	assert.match(view, /→.*Model 0/u, "Ctrl+Home returns to the first item while search holds focus");
	assert.match(view, /▼/u);
	component.dispose();
});

test("Models reserves wrapped messages and full action hints before allocating list rows", () => {
	const terminal = { rows: 24 };
	const { component } = createComponent({ terminal });
	component.handleInput("enter");
	for (const width of [24, 48, 80, 120]) {
		const lines = component.render(width);
		assert.ok(lines.length <= paletteHeightBudget(terminal.rows));
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(lines.join("\n"), /→/u);
		if (width >= 48) assert.match(lines.join("\n"), /→.*Tiny/u);
		assert.match(lines.join("\n"), /Esc\/Ctrl\+C cancel/u);
		const text = lines.join("").replaceAll(/[│\s]/gu, "");
		assert.ok(text.includes("Entercompactandswitch"));
		assert.ok(text.includes("Compacttheactivecontextandswitchtosmall/tiny?"));
	}
	component.dispose();
});

test("Models scrolls through every line of a long message in a short terminal", async () => {
	const terminal = { rows: 16 };
	const { component } = createComponent({
		terminal,
		getRows: () => [{ ...rows()[1], contextFit: "fits", model: { ...rows()[1].model, name: "Tiny" } }],
		onRefresh: async () => {
			throw new Error("network unreachable while reading the Office pool catalog; retry with /reload");
		},
	});
	await new Promise((resolve) => setImmediate(resolve));
	for (const width of [24, 48, 80, 120]) {
		const lines = component.render(width);
		assert.ok(lines.length <= paletteHeightBudget(terminal.rows));
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(lines.join("\n"), /→.*Tiny/u);
		assert.match(lines.join("\n"), /Esc\/Ctrl\+C close/u);
		const seen = [...lines];
		if (!lines.join("\n").includes("/reload")) {
			for (let page = 0; page < 20; page += 1) {
				component.handleInput("pageDown");
				seen.push(...component.render(width));
			}
		}
		const text = stripSgr(seen.join(" ")).replaceAll(/\s+/gu, " ");
		assert.match(text, /Model refresh/u);
		assert.match(text, /Office/u, "the middle of the message remains reachable");
		assert.match(text, /\/reload/u, "the recovery tail remains reachable");
		if (!lines.join("\n").includes("/reload")) component.handleInput("\u001b[1;5H");
		assert.match(component.render(width).join("\n"), /Model refresh/u);
	}
	component.dispose();
});

async function createFavoriteCycleHarness(options = {}) {
	const root = mkdtempSync(join(tmpdir(), "jouzu-favorite-cycle-"));
	const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
	const models =
		options.models ??
		["a", "b", "c"].map((id) => ({
			provider: "p",
			id,
			name: id.toUpperCase(),
			contextWindow: 100_000,
			maxTokens: 10_000,
		}));
	const byId = new Map(models.map((model) => [model.id, model]));
	const store = new ModelPickerStore(paths);
	for (const favorite of options.favorites ?? []) {
		store.toggleFavorite(
			typeof favorite === "string" ? { provider: "p", modelId: favorite } : favorite,
			new Date(`2026-08-23T00:00:0${store.load().state.favorites.length}.000Z`),
		);
	}
	const integration = createJouzuModelPicker(paths);
	const handlers = new Map();
	const selected = [];
	const notifications = [];
	let ctx;
	integration.extension.factory({
		on(name, handler) {
			handlers.set(name, handler);
		},
		async setModel(model) {
			selected.push(model.id);
			const result = options.setModel ? await options.setModel(model) : true;
			if (result) ctx.model = model;
			return result;
		},
	});
	const current = byId.get(options.currentId ?? models[0].id);
	ctx = {
		mode: "tui",
		cwd: root,
		model: current,
		scopedModels: (options.scopedIds ?? []).map((id) => ({ model: byId.get(id) })),
		sessionManager: { getBranch: () => [] },
		modelRegistry: {
			getAvailable: () => models,
			find: (provider, id) => (provider === "p" ? byId.get(id) : undefined),
			refresh: async () => ({ errors: new Map() }),
		},
		getContextUsage: () => ({ tokens: options.contextTokens ?? 100, contextWindow: 100_000, percent: 1 }),
		isIdle: () => options.isIdle ?? true,
		ui: {
			notify(message, level) {
				notifications.push([message, level]);
			},
		},
	};
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	return {
		ctx,
		handlers,
		integration,
		paths,
		selected,
		notifications,
		async dispose() {
			await handlers.get("session_shutdown")({}, ctx);
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("Models view confirms compaction before selecting a context-small model", async () => {
	const { component, calls } = createComponent();
	const rendered = component.render(72);
	assert.ok(rendered.length > 8);
	assert.ok(rendered.every((line) => visibleWidth(line) === 72));
	assert.match(stripSgr(rendered[0]), /JOUZU · Models/);
	assert.match(stripSgr(rendered.join("\n")), /\[Models\].*Settings/u);
	const listing = stripSgr(rendered.join("\n"));
	assert.match(listing, /Name\s+Provider\s+Context/u, "the list has a column header");
	assert.match(listing, /→ ●\s+Tiny context-small\s+small\s+1K/u, "the current row shows name, provider, and context");
	assert.match(listing, /Large Model\s+large\s+200K/u);
	assert.match(listing, /small\/tiny · 1K context/u, "the details line keeps the exact identity visible");

	component.handleInput("enter");
	assert.deepEqual(calls.selected, []);
	assert.deepEqual(calls.compacted, []);
	assert.equal(calls.close, 0);
	const confirmation = component.render(72).join("\n");
	assert.match(stripSgr(confirmation), /JOUZU · Models · Confirm/);
	assert.match(confirmation, /Compact the active context and switch to small\/tiny\?/);
	assert.match(confirmation, /Enter compact and switch\s+Esc\/Ctrl\+C cancel/);
	assert.ok(component.render(48).every((line) => visibleWidth(line) === 48));

	component.handleInput("escape");
	assert.equal(calls.close, 0, "Esc cancels confirmation without closing the Models view");
	assert.doesNotMatch(component.render(72).join("\n"), /· Confirm/);

	component.handleInput("enter");
	component.handleInput("enter");
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(calls.compacted, ["tiny"]);
	assert.equal(calls.close, 1);
});

test("Models view keeps compact-switch busy and reports sanitized failures", async () => {
	let failCompaction;
	const { component, calls } = createComponent({
		onCompactAndSelect: () =>
			new Promise((_resolve, reject) => {
				failCompaction = reject;
			}),
	});
	component.handleInput("enter");
	component.handleInput("enter");
	assert.equal(component.allowsGlobalNavigation(), false);
	assert.match(component.render(72).join("\n"), /Compacting before switching to small\/tiny/);
	assert.equal(calls.close, 0, "the Palette stays open while compaction is running");

	failCompaction(new Error("Compaction failed: unavailable\u001b]0;hidden\u0007 service"));
	await new Promise((resolve) => setImmediate(resolve));
	const rendered = component.render(72).join("\n");
	assert.match(rendered, /Compaction failed: unavailable service/);
	assert.doesNotMatch(rendered, /hidden/);
	assert.equal(component.allowsGlobalNavigation(), true);
});

test("Esc during a running selection closes the Palette and late completion stays inert", async () => {
	let failCompaction;
	const { component, calls } = createComponent({
		onCompactAndSelect: () =>
			new Promise((_resolve, reject) => {
				failCompaction = reject;
			}),
	});
	component.handleInput("enter");
	component.handleInput("enter");
	assert.equal(component.allowsGlobalNavigation(), false);
	component.handleInput("escape");
	assert.equal(calls.close, 1, "Esc closes the Palette while a selection is running");

	failCompaction(new Error("Compaction failed: late failure"));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.close, 1, "a late failure does not touch the closed Palette");
});

test("model-switch compaction rechecks context and reports failures", async () => {
	const target = {
		provider: "p",
		modelId: "small",
		name: "Small",
		contextWindow: 8_000,
		maxTokens: 8_000,
		available: true,
	};
	let tokens = 10_000;
	let compactOptions;
	const ctx = {
		getContextUsage: () => ({ tokens, contextWindow: 100_000, percent: 10 }),
		compact(options) {
			compactOptions = options;
		},
	};

	const stillTooLarge = compactContextForModelSwitch(ctx, target);
	assert.equal(compactOptions.customInstructions, "keep:0");
	compactOptions.onComplete({ summary: "brief", firstKeptEntryId: "", tokensBefore: 10_000 });
	await assert.rejects(stillTooLarge, /active context still does not fit p\/small/);

	tokens = 10_000;
	const estimatedTooLarge = compactContextForModelSwitch(ctx, target);
	tokens = null;
	compactOptions.onComplete({
		summary: "brief",
		firstKeptEntryId: "",
		tokensBefore: 10_000,
		estimatedTokensAfter: 10_000,
	});
	await assert.rejects(estimatedTooLarge, /active context still does not fit p\/small/);

	tokens = 10_000;
	const failed = compactContextForModelSwitch(ctx, target);
	compactOptions.onError(new Error("compactor unavailable"));
	await assert.rejects(failed, /Compaction failed: compactor unavailable/);

	tokens = 1_000;
	compactOptions = undefined;
	await compactContextForModelSwitch(ctx, target);
	assert.equal(compactOptions, undefined, "a context that already fits must switch without compaction");
});

test("Models view hints render effective semantic bindings", () => {
	const { component } = createComponent({
		keybindings: fakeKeybindings({
			"tui.select.confirm": ["ctrl+s"],
			"tui.select.cancel": ["alt+x"],
			"tui.select.up": ["k"],
			"tui.select.down": ["j"],
		}),
	});
	const rendered = component.render(72).join("\n");
	assert.match(rendered, /Ctrl\+S select and save for project/u);
	assert.match(rendered, /K\/J move/u);
	assert.ok(rendered.includes(`${process.platform === "darwin" ? "Option" : "Alt"}+X close`));
	assert.doesNotMatch(rendered, /Enter select|Esc close|↑↓ move/u);
});

test("Models view keeps ANSI and CJK content inside aligned display-width borders", () => {
	const originalColorTerm = process.env.COLORTERM;
	const originalTerm = process.env.TERM;
	const originalNoColor = process.env.NO_COLOR;
	process.env.TERM = "xterm-256color";
	delete process.env.NO_COLOR;
	process.env.COLORTERM = "truecolor";
	try {
		const { component } = createComponent({
			getRows: () => [
				{
					section: "other",
					model: {
						provider: "日本語プロバイダー",
						modelId: "モデル・長い識別子",
						name: "日本語モデル",
						contextWindow: 200_000,
						maxTokens: 10_000,
						available: true,
					},
					contextFit: "fits",
					favorite: false,
					projectDefault: false,
					rank: 0,
				},
			],
		});
		const rendered = component.render(48);
		assert.ok(rendered.every((line) => visibleWidth(line) === 48));
		assert.ok(rendered[0].includes("\u001b[38;2;34;211;238mJ"));
		assert.match(rendered.join("\n"), /日本語/);
	} finally {
		if (originalColorTerm === undefined) delete process.env.COLORTERM;
		else process.env.COLORTERM = originalColorTerm;
		if (originalTerm === undefined) delete process.env.TERM;
		else process.env.TERM = originalTerm;
		if (originalNoColor === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = originalNoColor;
	}
});

test("Models view refreshes catalogs through the refresh binding", () => {
	const refreshSignals = [];
	const { component, calls } = createComponent({
		onRefreshCatalogs: (signal) => {
			refreshSignals.push(signal);
			return new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("aborted")));
			});
		},
	});
	const rendersBefore = calls.renders;
	component.handleInput("\u001b[114;6u");
	assert.equal(refreshSignals.length, 1, "Ctrl+Shift+R starts a catalog refresh");
	assert.ok(calls.renders > rendersBefore, "the refreshing state renders");
	component.handleInput("\u001b[114;6u");
	assert.equal(refreshSignals.length, 2, "a second press restarts the refresh");
	assert.equal(refreshSignals[0].aborted, true, "the previous refresh is aborted");
	component.dispose();
});

test("Models view recomputes rows when catalogs reload in the background", () => {
	const listeners = new Set();
	let rowCount = 0;
	const { component, calls } = createComponent({
		getRows: () => {
			rowCount += 1;
			return rows();
		},
		subscribeCatalogsReloaded: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	});
	const computedBefore = rowCount;
	const rendersBefore = calls.renders;
	for (const listener of listeners) listener();
	assert.ok(rowCount > computedBefore, "rows are recomputed after the reload");
	assert.ok(calls.renders > rendersBefore, "the view re-renders after the reload");
	component.dispose();
	assert.equal(listeners.size, 0, "dispose unsubscribes the view");
});

test("Models view selects and saves for the project, toggles favorites, and cancels", async () => {
	const first = createComponent();
	first.component.handleInput("\u0006");
	assert.deepEqual(first.calls.favorites, ["tiny"], "Ctrl+F toggles favorite for the selected row");
	assert.deepEqual(first.calls.selected, [], "Ctrl+F does not select or save a project default");
	first.component.handleInput("down");
	first.component.handleInput("enter");
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(first.calls.selected, ["fit"]);
	assert.equal(first.calls.close, 1);

	const second = createComponent();
	second.component.handleInput("down");
	second.component.handleInput("\u0006");
	assert.deepEqual(second.calls.favorites, ["fit"]);
	second.component.handleInput("escape");
	assert.equal(second.calls.close, 1);
});

test("Models hides rating columns that no model in the inventory fills", () => {
	for (const [locale, headers] of [
		["en", /Strength|Speed|Cost/u],
		["ja", /実力|速度|コスト/u],
	]) {
		const { component } = createComponent({ catalog: resolveCatalog(locale).bundle });
		const wide = stripSgr(component.render(120).join("\n"));
		assert.doesNotMatch(wide, headers, locale);
		assert.match(wide, /→.*Tiny.*1K\s*│/u, locale);
		for (const width of [24, 48, 72, 80, 96, 120]) {
			assert.ok(
				component.render(width).every((line) => visibleWidth(line) <= width),
				`${locale}: ${width}`,
			);
		}
		component.dispose();
	}
});

test("Models keeps rating columns while a search shows only unrated models", () => {
	const [unrated, other] = rows();
	const rated = { ...other, model: { ...other.model, comparison: { strength: 2 } } };
	const { component } = createComponent({
		getRows: (query) => (query ? [unrated] : [unrated, rated]),
	});
	const header = /Strength\s+Speed\s+Cost/u;
	assert.doesNotMatch(stripSgr(component.render(120).join("\n")), /Strength\s+Speed|Speed\s+Cost/u);
	assert.match(stripSgr(component.render(120).join("\n")), /Strength/u);
	for (const character of "tiny") component.handleInput(character);
	const filtered = stripSgr(component.render(120).join("\n"));
	assert.match(filtered, /Strength/u, "filtering does not hide a column the inventory fills");
	assert.doesNotMatch(filtered, header, "columns no model fills stay hidden");
	assert.doesNotMatch(filtered, /Large Model/u);
	component.dispose();
});

test("Models renders catalog ratings with localized headers within terminal widths", () => {
	const document = JSON.parse(
		readFileSync(join(import.meta.dirname, "..", "catalog", "fixtures", "account-snapshot-v1.json"), "utf8"),
	);
	document.modelOfferings[0].name = "評価 Model";
	document.modelOfferings[0].metadata = { strength: 4, speed: 3, cost: 2 };
	const catalog = parseAndValidateModelCatalog(JSON.stringify(document), { remote: true });
	const model = catalogPickerModel(
		{ provider: "ai.example.gateway", id: "example-model", name: "Pi label", contextWindow: 1, maxTokens: 1 },
		catalog,
	);
	for (const locale of ["en", "ja"]) {
		const { component } = createComponent({
			catalog: resolveCatalog(locale).bundle,
			getRows: () => [{ ...rows()[1], model }],
		});
		const wide = stripSgr(component.render(120).join("\n"));
		assert.match(wide, /評価 Model.*★★★★\s+↯↯↯\s+\$\$/u);
		for (const width of [24, 48, 72, 80, 96, 120]) {
			assert.ok(
				component.render(width).every((line) => visibleWidth(line) <= width),
				`${locale}: ${width}`,
			);
		}
		assert.doesNotMatch(stripSgr(component.render(48).join("\n")), /★★★★|↯|\$\$/u);
		component.dispose();
	}
});

test("Models renders one to four comparison symbols and rejects invalid tiers", () => {
	const inventory = [1, 2, 3, 4, 0, 5, 1.5].map((tier) => ({
		...rows()[1],
		model: { ...rows()[1].model, name: `Tier ${tier}`, comparison: { strength: tier, speed: tier, cost: tier } },
	}));
	const { component } = createComponent({ getRows: () => inventory });
	const lines = component.render(120).map(stripSgr);
	const header = lines.find((line) => /Strength\s+Speed\s+Cost/u.test(line));
	assert.ok(header);
	for (const tier of [1, 2, 3, 4]) {
		const line = lines.find((value) => value.includes(`Tier ${tier} `));
		assert.ok(line, `tier ${tier}`);
		for (const [label, symbol] of [
			["Strength", "★"],
			["Speed", "↯"],
			["Cost", "$"],
		]) {
			assert.ok(line.includes(symbol.repeat(tier)), `${label}: tier ${tier}`);
			assert.equal(
				visibleWidth(line.slice(0, line.indexOf(symbol))),
				visibleWidth(header.slice(0, header.indexOf(label))),
				`${label}: tier ${tier} aligns with its header`,
			);
		}
	}
	for (const tier of [0, 5, 1.5]) {
		const line = lines.find((value) => value.includes(`Tier ${tier} `));
		assert.doesNotMatch(line, /[—★↯$]/u, "invalid tiers leave the cells blank");
	}
	for (const width of [24, 48, 72, 80, 96, 120]) {
		assert.ok(
			component.render(width).every((line) => visibleWidth(line) <= width),
			`width ${width}`,
		);
	}
	component.dispose();
});

test("Models rating rows align under an independent single-cell text cursor model", () => {
	const inventory = [undefined, 1, 2, 3, 4].map((tier) => ({
		...rows()[1],
		model: {
			...rows()[1].model,
			name: `Cells ${tier ?? "unknown"}`,
			comparison: tier === undefined ? undefined : { strength: 4, speed: tier, cost: 2 },
		},
	}));
	// This fixture contains only ASCII and single-cell text glyphs. Model a terminal
	// honoring VS15 as zero-width without consulting Pi's width implementation.
	const cursorColumns = (value) => {
		const text = value.replace(/\uFE0E/gu, "");
		assert.match(text, /^[\x20-\x7e│→★↯—⚡]*$/u);
		return Array.from(text).length;
	};
	const { component } = createComponent({ getRows: () => inventory });
	for (const width of [48, 72, 80, 96, 120, 160]) {
		const lines = component.render(width).map(stripSgr);
		const header = lines.find((line) => /Strength\s+Speed\s+Cost/u.test(line));
		for (const tier of [undefined, 1, 2, 3, 4]) {
			const line = lines.find((line) => line.includes(`Cells ${tier ?? "unknown"} `));
			assert.ok(line, `width ${width}, tier ${tier}`);
			assert.equal(cursorColumns(line), width, `width ${width}, tier ${tier}: right border`);
			assert.doesNotMatch(line, /[\uFE0E\uFE0F]|\p{Emoji_Presentation}/u, "ratings use plain text glyphs");
			if (header && tier !== undefined) {
				assert.equal(
					cursorColumns(line.slice(0, line.indexOf("$"))),
					cursorColumns(header.slice(0, header.indexOf("Cost"))),
					`width ${width}, tier ${tier}: Cost column`,
				);
			}
		}
	}
	component.dispose();
});

test("Models columns name the catalog for shared identities and drop on narrow terminals", () => {
	const shared = (catalogLabel, rank) => ({
		section: "other",
		model: {
			provider: "shisa",
			providerName: "Shisa AI",
			modelId: "shisa-v2.1-70b",
			name: "Shisa V2.1 70B",
			catalogLabel,
			contextWindow: 65_536,
			available: true,
		},
		contextFit: "fits",
		favorite: rank === 0,
		projectDefault: false,
		rank,
	});
	const { component } = createComponent({ getRows: () => [shared("Shisa API", 0), shared("codex-pool", 1)] });
	const wide = stripSgr(component.render(96).join("\n"));
	assert.match(wide, /→ {2}★ {2}Shisa V2\.1 70B\s+Shisa AI · Shisa API\s+65\.5K/u);
	assert.match(wide, /Shisa V2\.1 70B\s+Shisa AI · codex-pool\s+65\.5K/u);
	assert.match(wide, /shisa\/shisa-v2\.1-70b · Shisa API · 65\.5K context/u);
	for (const width of [24, 48, 96]) {
		assert.ok(
			component.render(width).every((line) => visibleWidth(line) === width),
			`width ${width}`,
		);
	}
	const narrow = stripSgr(component.render(36).join("\n"));
	assert.doesNotMatch(narrow, /Provider|Context/u, "narrow terminals keep only the name column");
	assert.match(narrow, /Shisa V2\.1 70B/u);
});

test("Models view has one list with no view choice", () => {
	const queries = [];
	const { component } = createComponent({
		getRows(query) {
			queries.push(query);
			return rows();
		},
	});
	const before = queries.length;
	const browseText = stripSgr(component.render(72).join("\n"));
	assert.doesNotMatch(browseText, /View|Recent|Favorite|‹/u);
	assert.doesNotMatch(browseText, /←→/u, "browse hints do not advertise horizontal arrows");
	component.handleInput("\u001b[C");
	component.handleInput("\u001b[D");
	assert.equal(queries.length, before, "horizontal arrows do not re-rank the list in browse state");
});

test("Models view separates browse keys from search cursor input", () => {
	const queries = [];
	const { component, calls } = createComponent({
		getRows(query) {
			queries.push(query);
			return rows();
		},
	});
	const browseText = component.render(72).join("\n");
	assert.match(browseText, /Tab section/u);
	assert.doesNotMatch(browseText, /Ctrl\+,|Tab filter/u);

	component.handleInput("q");
	component.handleInput("\u001b[D");
	component.handleInput("\u001b[C");
	assert.equal(queries.at(-1), "q", "horizontal arrows move the search cursor without editing the query");
	component.handleInput(" ");
	assert.equal(queries.at(-1), "q ");
	assert.deepEqual(calls.favorites, []);
	assert.match(component.render(72).join("\n"), /→ Search/u);

	component.handleInput("escape");
	assert.equal(calls.close, 0, "Esc clears the search before closing the Palette");
	assert.equal(queries.at(-1), "", "the first Esc clears a non-empty query");
	assert.doesNotMatch(component.render(72).join("\n"), /→ Search/u, "Esc leaves search focus");
	component.handleInput("\u0006");
	assert.deepEqual(calls.favorites, ["tiny"], "Ctrl+F toggles favorite from browse");
	component.handleInput(" ");
	assert.equal(queries.at(-1), " ", "Space types into search like every printable character");
	assert.deepEqual(calls.favorites, ["tiny"], "Space no longer toggles favorite");
	component.handleInput("escape");
	assert.equal(calls.close, 0, "Esc clears the search before closing the Palette");
	component.handleInput("escape");
	assert.equal(calls.close, 1);

	const directSearch = createComponent();
	directSearch.component.handleInput("/");
	assert.match(directSearch.component.render(72).join("\n"), /→ Search/u);
	directSearch.component.handleInput("escape");
	assert.equal(directSearch.calls.close, 0);
});

test("Models provider filtering keeps favorites first and other rows alphabetical", () => {
	const inventory = [
		{ provider: "other", modelId: "current", name: "Current", available: true },
		{ provider: "Shisa AI", modelId: "favorite-with-long-id", name: "Zulu Favorite", available: true },
		{ provider: "Shisa AI", modelId: "a", name: "MiniMax M3", available: true },
		{ provider: "Shisa AI", modelId: "long-hidden-id", name: "Beam", available: true },
		{ provider: "Shisa AI", modelId: "even-longer-hidden-id", name: "Alpha", available: true },
	];
	const pickerState = emptyModelPickerState();
	pickerState.favorites = [{ ...inventory[1], addedAt: "2026-10-28T00:00:00.000Z" }];
	const { component } = createComponent({
		getRows: (query) =>
			buildPickerRows({ models: inventory, state: pickerState, projectKey: "test", current: inventory[0], query }),
	});
	component.handleInput("down");
	component.handleInput("down");
	assert.match(stripSgr(component.render(120).join("\n")), /→.*Alpha/u);
	for (const character of "shisa") component.handleInput(character);
	const filtered = stripSgr(component.render(120).join("\n"));
	assert.match(filtered, /→.*Zulu Favorite/u, "the first matching row follows the default grouping");
	assert.ok(filtered.indexOf("Zulu Favorite") < filtered.indexOf("Alpha"));
	assert.ok(filtered.indexOf("Alpha") < filtered.indexOf("Beam"));
	assert.ok(filtered.indexOf("Beam") < filtered.indexOf("MiniMax M3"));
	component.handleInput("escape");
	assert.match(stripSgr(component.render(120).join("\n")), /→.*Alpha/u, "clearing restores the pre-search selection");
	component.dispose();
});

test("Models view returns to the pre-search position when the search is cleared", () => {
	const inventory = Array.from({ length: 40 }, (_, index) => ({
		section: "other",
		model: {
			provider: "p",
			modelId: `m${String(index).padStart(2, "0")}`,
			name: `Model ${index}`,
			contextWindow: 200_000,
			maxTokens: 10_000,
			available: true,
		},
		contextFit: "fits",
		favorite: false,
		projectDefault: false,
		rank: index,
	}));
	const { component, calls } = createComponent({
		getRows: (query) => (query ? inventory.filter((row) => row.model.modelId.includes(query.trim())) : inventory),
	});
	const selectedId = () => /\bp\/(m\d+)/u.exec(stripSgr(component.render(96).join("\n")))?.[1];
	for (let step = 0; step < 5; step += 1) component.handleInput("down");
	assert.equal(selectedId(), "m05");

	component.handleInput("3");
	assert.equal(selectedId(), "m03", "editing the query selects the first matching row");
	component.handleInput("escape");
	assert.equal(calls.close, 0);
	assert.equal(selectedId(), "m05", "the first Esc clears the search and returns to the pre-search position");
	assert.match(stripSgr(component.render(96).join("\n")), /Esc\/Ctrl\+C close/u);

	component.handleInput("3");
	component.handleInput("down");
	assert.equal(selectedId(), "m13", "moving through results keeps the query");
	assert.doesNotMatch(component.render(96).join("\n"), /→ Search/u, "moving through results leaves the search field");
	assert.match(stripSgr(component.render(96).join("\n")), /Esc\/Ctrl\+C clear search/u);
	component.handleInput("escape");
	assert.equal(selectedId(), "m05", "Esc from the results also clears the search and restores the position");

	component.handleInput("3");
	component.handleInput("\u007f");
	assert.equal(selectedId(), "m05", "deleting the query also returns to the pre-search position");
});

test("Models view toggles favorites with the semantic action in browse and search", () => {
	const favoriteIds = new Set();
	const { component, calls } = createComponent({
		getRows: () => rows().map((row) => ({ ...row, favorite: favoriteIds.has(row.model.modelId) })),
		onToggleFavorite: (row) => {
			if (favoriteIds.has(row.model.modelId)) favoriteIds.delete(row.model.modelId);
			else favoriteIds.add(row.model.modelId);
		},
	});
	assert.doesNotMatch(component.render(72).join("\n"), /· Search/u, "browse state is the unmarked default");

	component.handleInput("down");
	component.handleInput("\u0006");
	assert.deepEqual(calls.favorites, ["fit"]);
	assert.match(component.render(72).join("\n"), /Added large\/fit to favorites\./u);
	component.handleInput("\u0006");
	assert.match(component.render(72).join("\n"), /Removed large\/fit from favorites\./u);

	component.handleInput("q");
	const searching = component.render(72).join("\n");
	assert.match(searching, /· Search/u, "the title names the search state");
	assert.match(searching, /Ctrl\+F/u, "the search hint names the favorite accelerator");
	assert.match(
		stripSgr(searching)
			.replace(/[│╭╮╰╯─]/gu, " ")
			.replace(/\s+/g, " "),
		/Ctrl\+F favorite/u,
		"the search hint names the favorite accelerator",
	);
	assert.doesNotMatch(searching, /Space favorite/u, "the search hint omits the printable binding");
	component.handleInput(" ");
	assert.deepEqual(calls.favorites, ["fit", "fit"], "Space stays text input while search holds focus");
	component.handleInput("\u0006");
	assert.deepEqual(
		calls.favorites,
		["fit", "fit", "tiny"],
		"Ctrl+F toggles the first matching row while search holds focus",
	);
	assert.match(component.render(72).join("\n"), /Added small\/tiny to favorites\./u);
	component.handleInput("down");
	assert.doesNotMatch(component.render(72).join("\n"), /· Search/u, "moving into the results leaves search");
	component.handleInput("\u0006");
	assert.deepEqual(calls.favorites, ["fit", "fit", "tiny", "fit"], "Ctrl+F toggles the moved-to row");
});

test("Models view resolves a rebound favorite binding", () => {
	const { component, calls } = createComponent({
		jouzuKeybindings: createJouzuKeybindingsManagerFromConfig({
			"jouzu.model.toggleFavorite": "ctrl+shift+b",
		}),
	});
	const browse = component.render(72).join("\n");
	assert.match(browse, /Ctrl\+Shift\+B favorite/u);
	assert.doesNotMatch(browse, /Space favorite|Shift\+Enter|project default/u);

	component.handleInput(" ");
	assert.deepEqual(calls.favorites, [], "Space no longer toggles after rebinding");
	component.handleInput("\u001b[98;6u");
	assert.deepEqual(calls.favorites, ["tiny"], "the rebound key toggles the selected row");
});

// Product decision: the first Esc in a non-empty Models search clears the query and
// returns the cursor to its pre-search position. Keep this test unless that decision
// changes; see docs/models.md.
test("the first Esc clears a non-empty Models search from the search field or the results", () => {
	const queries = [];
	const { component, calls } = createComponent({
		getRows: (query) => {
			queries.push(query);
			return rows();
		},
	});
	component.handleInput("down");
	component.handleInput("t");
	component.handleInput("escape");
	assert.equal(queries.at(-1), "", "Esc in the search field clears the query");
	assert.equal(calls.close, 0);
	assert.match(stripSgr(component.render(72).join("\n")), /large\/fit/u, "the pre-search row is selected again");

	component.handleInput("t");
	component.handleInput("down");
	component.handleInput("escape");
	assert.equal(queries.at(-1), "", "Esc in the results clears the query");
	assert.equal(calls.close, 0);
	component.handleInput("escape");
	assert.equal(calls.close, 1, "with no search, Esc closes the Palette");
});

test("printable favorite actions retain a searched row different from the browse selection", () => {
	const queries = [];
	const { component, calls } = createComponent({
		jouzuKeybindings: createJouzuKeybindingsManagerFromConfig({ "jouzu.model.toggleFavorite": "f" }),
		getRows: (query) => {
			queries.push(query);
			return rows().filter((row) => !query || row.model.modelId.includes(query));
		},
	});
	component.handleInput("/");
	component.handleInput("fit");
	assert.equal(queries.at(-1), "fit");
	assert.match(stripSgr(component.render(96).join("\n")).replace(/[│\s]+/gu, " "), /↑↓ then F favorite/u);
	component.handleInput("down");
	component.handleInput("f");
	assert.deepEqual(calls.favorites, ["fit"]);
	assert.equal(queries.at(-1), "fit", "favorite preserves the active filter");
	component.handleInput("escape");
	assert.equal(queries.at(-1), "", "Esc then clears the search");
	assert.equal(calls.close, 0);
});

test("Models view hints the browse route when a favorite binding is printable", () => {
	const { component, calls } = createComponent({
		jouzuKeybindings: createJouzuKeybindingsManagerFromConfig({ "jouzu.model.toggleFavorite": "f" }),
	});
	component.handleInput("f");
	assert.deepEqual(calls.favorites, ["tiny"], "a printable favorite binding works in browse state");
	component.handleInput("/");
	const searching = stripSgr(component.render(72).join("\n")).replace(/[│\s]+/gu, " ");
	assert.match(searching, /↑↓ then F favorite/u, "search state hints the route into the results");
	component.handleInput("f");
	assert.deepEqual(calls.favorites, ["tiny"], "the printable binding stays text input while search holds focus");
});

test("Palette section switches retain the Models query without grabbing search focus", () => {
	const context = {
		tui: { terminal: { rows: 30 }, requestRender() {} },
		theme: identityTheme,
		styles: createSessionUiStyles(identityTheme),
		keybindings: fakeKeybindings(),
		jouzuKeybindings: createJouzuKeybindingsManagerFromConfig(),
		close() {},
	};
	const router = new JouzuPaletteRouter({
		context,
		initialRoute: { view: "models" },
		factories: {
			models: (ctx, route) =>
				new ModelPickerComponent({
					context: ctx,
					initialRoute: route,
					getRows: () => rows(),
					onSelect: async () => {},
					onCompactAndSelect: async () => {},
					onToggleFavorite: () => {},
				}),
			settings: () => ({
				render: () => ["settings"],
				invalidate() {},
				route() {},
				dispose() {},
			}),
		},
	});

	router.handleInput("q");
	assert.match(router.render(72).join("\n"), /· Search/u);
	router.handleInput("\t");
	assert.deepEqual(router.render(72), ["settings"]);
	router.handleInput("\u001b[Z");
	const restored = stripSgr(router.render(72).join("\n"));
	assert.match(restored, /Search[\s\S]*q/u, "the query survives the section round trip");
	assert.doesNotMatch(restored, /· Search/u, "a resumed route does not grab search focus");
});

test("Palette routing replaces the query and keeps the component reusable", () => {
	const queries = [];
	const { component } = createComponent({
		getRows(query) {
			queries.push(query);
			return rows();
		},
	});
	component.route({ view: "models", query: "sonnet" });
	component.route({ view: "usage", query: "ignored" });
	assert.ok(queries.includes("sonnet"));
	assert.equal(queries.includes("ignored"), false);
});

test("Models view silently reranks the inventory after refresh", async () => {
	let resolveRefresh;
	let refreshed = false;
	const { component, calls } = createComponent({
		getRows: () => [
			{
				section: "other",
				model: {
					provider: "p",
					modelId: refreshed ? "fresh" : "cached",
					name: refreshed ? "Fresh" : "Cached",
					contextWindow: 100_000,
					maxTokens: 10_000,
					available: true,
				},
				contextFit: "fits",
				favorite: false,
				projectDefault: false,
				rank: 0,
			},
		],
		onRefresh: () =>
			new Promise((resolve) => {
				resolveRefresh = resolve;
			}),
	});
	assert.match(component.render(72).join("\n"), /p\/cached/);
	refreshed = true;
	resolveRefresh();
	await new Promise((resolve) => setImmediate(resolve));
	const rendered = component.render(72).join("\n");
	assert.match(rendered, /p\/fresh/);
	assert.doesNotMatch(rendered, /catalogs refreshed/i);
	assert.ok(calls.renders > 0);
	component.dispose();
});

test("Models view keeps cached inventory and sanitizes refresh failures", async () => {
	const { component } = createComponent({
		onRefresh: async () => {
			throw new Error("broken\u001b]0;hidden\u0007\nprovider");
		},
	});
	await new Promise((resolve) => setImmediate(resolve));
	const rendered = component.render(72).join("\n");
	assert.match(rendered, /small\/tiny/);
	assert.match(rendered, /Model refresh failed; showing cached models:/);
	assert.doesNotMatch(rendered, /hidden/);
	component.dispose();
});

test("Models view aborts an in-flight refresh when disposed", async () => {
	let refreshSignal;
	const { component } = createComponent({
		onRefresh: (signal) => {
			refreshSignal = signal;
			return new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		},
	});
	assert.equal(refreshSignal.aborted, false);
	component.dispose();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(refreshSignal.aborted, true);
});

test("Ctrl+P cycles global favorites deterministically in both directions", async () => {
	const harness = await createFavoriteCycleHarness({ favorites: ["a", "b", "c"], currentId: "a" });
	try {
		assert.equal(await harness.integration.cycleFavorite("forward"), true);
		assert.equal(await harness.integration.cycleFavorite("forward"), true);
		assert.equal(await harness.integration.cycleFavorite("forward"), true);
		assert.equal(await harness.integration.cycleFavorite("backward"), true);
		assert.deepEqual(harness.selected, ["b", "c", "a", "c"]);
		assert.ok(harness.notifications.every(([message]) => message.startsWith("Switched to p/")));
		assert.deepEqual(new ModelPickerStore(harness.paths).load().state.defaults.projects, {});
	} finally {
		await harness.dispose();
	}
});

test("favorite cycling honors the effective scope and skips unsafe targets", async () => {
	const harness = await createFavoriteCycleHarness({
		models: [
			{ provider: "p", id: "a", name: "A", contextWindow: 100_000, maxTokens: 10_000 },
			{ provider: "p", id: "b", name: "B", contextWindow: 100_000, maxTokens: 10_000 },
			{ provider: "p", id: "small", name: "Small", contextWindow: 5_000, maxTokens: 1_000 },
			{ provider: "p", id: "c", name: "C", contextWindow: 100_000, maxTokens: 10_000 },
		],
		favorites: ["b", "small", "c", "missing"],
		currentId: "a",
		scopedIds: ["a", "small", "c"],
		contextTokens: 10_000,
	});
	try {
		assert.equal(await harness.integration.cycleFavorite("forward"), true);
		assert.deepEqual(harness.selected, ["c"], "out-of-scope, missing, and context-small favorites must be skipped");
		assert.equal(await harness.integration.cycleFavorite("forward"), true);
		assert.deepEqual(harness.selected, ["c"]);
		assert.match(harness.notifications.at(-1)[0], /Only one favorite model is available/);
	} finally {
		await harness.dispose();
	}
});

test("favorite cycling handles empty, active, unauthenticated, and failed switches without stock fallback", async (t) => {
	await t.test("empty favorite list", async () => {
		const harness = await createFavoriteCycleHarness();
		try {
			assert.equal(await harness.integration.cycleFavorite("forward"), true);
			assert.deepEqual(harness.selected, []);
			assert.match(harness.notifications[0][0], /No favorite models/);
		} finally {
			await harness.dispose();
		}
	});
	await t.test("active model call", async () => {
		const harness = await createFavoriteCycleHarness({ favorites: ["a", "b", "c"], isIdle: false });
		try {
			assert.equal(await harness.integration.cycleFavorite("forward"), true);
			assert.equal(await harness.integration.cycleFavorite("forward"), true);
			assert.equal(await harness.integration.cycleFavorite("forward"), true);
			assert.deepEqual(harness.selected, []);
			assert.deepEqual(
				harness.notifications.map(([message]) => message.match(/p\/[abc]/)?.[0]),
				["p/b", "p/c", "p/a"],
			);
			await harness.handlers.get("turn_end")({}, harness.ctx);
			assert.deepEqual(harness.selected, ["a"]);
			assert.match(harness.notifications.at(-1)[0], /Switched to p\/a/);
			// Cycling switches models without ever persisting a project default.
			assert.deepEqual(new ModelPickerStore(harness.paths).load().state.defaults.projects, {});
		} finally {
			await harness.dispose();
		}
	});
	await t.test("missing authentication", async () => {
		const harness = await createFavoriteCycleHarness({ favorites: ["a", "b"], setModel: async () => false });
		try {
			assert.equal(await harness.integration.cycleFavorite("forward"), true);
			assert.deepEqual(harness.selected, ["b"]);
			assert.match(harness.notifications[0][0], /No authentication for p\/b/);
		} finally {
			await harness.dispose();
		}
	});
	await t.test("activation error", async () => {
		const harness = await createFavoriteCycleHarness({
			favorites: ["a", "b"],
			setModel: async () => {
				throw new Error("broken\u001b]0;hidden\u0007 provider");
			},
		});
		try {
			assert.equal(await harness.integration.cycleFavorite("forward"), true);
			assert.match(harness.notifications[0][0], /Favorite model switch failed: broken provider/);
			assert.doesNotMatch(harness.notifications[0][0], /hidden/);
		} finally {
			await harness.dispose();
		}
	});
});

test("favorite cycling serializes repeated keypresses", async () => {
	let finishSwitch;
	const harness = await createFavoriteCycleHarness({
		favorites: ["a", "b", "c"],
		setModel: () =>
			new Promise((resolve) => {
				finishSwitch = resolve;
			}),
	});
	try {
		const first = harness.integration.cycleFavorite("forward");
		assert.equal(await harness.integration.cycleFavorite("forward"), true);
		assert.deepEqual(harness.selected, ["b"]);
		assert.match(harness.notifications[0][0], /already in progress/);
		finishSwitch(true);
		assert.equal(await first, true);
	} finally {
		await harness.dispose();
	}
});

test("favorite guidance resolves the effective model-select binding", async () => {
	const { getKeybindings, setKeybindings, KeybindingsManager } = await import("@earendil-works/pi-tui");
	const previous = getKeybindings();
	setKeybindings(
		new KeybindingsManager({ "app.model.select": { defaultKeys: "ctrl+shift+l", description: "test double" } }),
	);
	try {
		const harness = await createFavoriteCycleHarness({ favorites: [] });
		await harness.integration.cycleFavorite("forward");
		assert.match(harness.notifications[0][0], /Open Models with Ctrl\+Shift\+L/);
		assert.doesNotMatch(harness.notifications[0][0], /browse mode/);
		await harness.dispose();
	} finally {
		setKeybindings(previous);
	}
});

test("/about routes to Settings About and reports text outside the TUI", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-about-command-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
	const commands = new Map();
	const handlers = new Map();
	const integration = createJouzuModelPicker(paths, {
		palette: { env: {}, columns: 100, rows: 30 },
		runtime: { about: () => "Running Jouzu startup-build\nPi test-pi" },
	});
	integration.extension.factory({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		setModel: async () => true,
	});
	const rendered = [];
	const notices = [];
	const ctx = {
		mode: "tui",
		ui: {
			notify: (text) => notices.push(text),
			custom: (factory) =>
				new Promise((resolve) => {
					const component = factory(
						{ terminal: { rows: 30 }, requestRender() {} },
						identityTheme,
						fakeKeybindings(),
						resolve,
					);
					setImmediate(() => {
						rendered.push(component.render(80).join("\n"));
						component.handleInput("escape");
					});
				}),
		},
	};
	await commands.get("about").handler("", ctx);
	assert.match(rendered[0], /Settings/);
	assert.match(rendered[0], /About/);
	assert.match(rendered[0], /startup-build/);
	await commands.get("about").handler("", { ...ctx, mode: "rpc" });
	assert.deepEqual(notices, ["Running Jouzu startup-build\nPi test-pi"]);
	assert.equal(rendered.length, 1);
	await handlers.get("session_shutdown")({}, ctx);
});

test("Jouzu editor wrapper opens the Models component through the Palette surface", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-host-"));
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
		const integration = createJouzuModelPicker(paths, { palette: { env: {}, columns: 100, rows: 30 } });
		const handlers = new Map();
		const selected = [];
		let ctx;
		integration.extension.factory({
			on(name, handler) {
				handlers.set(name, handler);
			},
			setModel: async (target) => {
				selected.push(target.id);
				ctx.model = target;
				return true;
			},
		});
		const model = { provider: "p", id: "model", name: "Model", contextWindow: 100_000, maxTokens: 10_000 };
		const fresh = { provider: "p", id: "fresh", name: "Fresh", contextWindow: 100_000, maxTokens: 10_000 };
		let availableModels = [model];
		let rendered = "";
		let customOptions;
		let refreshCalls = 0;
		const notifications = [];
		ctx = {
			mode: "tui",
			cwd: root,
			model,
			scopedModels: [],
			sessionManager: { getBranch: () => [] },
			modelRegistry: {
				getAvailable: () => availableModels,
				refresh: async () => {
					refreshCalls += 1;
					availableModels = [model, fresh];
					return { errors: new Map() };
				},
				find: (_provider, id) => availableModels.find((candidate) => candidate.id === id),
			},
			getContextUsage: () => ({ tokens: 100, contextWindow: 100_000, percent: 1 }),
			isIdle: () => true,
			ui: {
				notify(message, level) {
					notifications.push([message, level]);
				},
				custom(factory, options) {
					customOptions = options;
					return new Promise((resolve) => {
						const component = factory(
							{ terminal: { rows: 30 }, requestRender() {} },
							identityTheme,
							fakeKeybindings(),
							resolve,
						);
						setImmediate(() => {
							component.handleInput("down");
							component.handleInput("\u0006");
							rendered = component.render(72).join("\n");
							component.handleInput("escape");
						});
					});
				},
			},
		};
		await handlers.get("session_start")({}, ctx);
		assert.equal(await integration.open({ source: "action" }), true);
		assert.match(stripSgr(rendered), /JOUZU · Models/);
		assert.match(stripSgr(rendered), /Fresh\s+p\s/u, "the Palette must render models discovered by the refresh");
		assert.doesNotMatch(rendered, /Model catalogs refreshed\./);
		assert.equal(customOptions.overlay, true);
		assert.equal(refreshCalls, 1, "opening the Palette must refresh Pi's effective model inventory");
		assert.equal(await integration.cycleFavorite("forward"), true);
		assert.deepEqual(selected, ["fresh"], "Ctrl+P must immediately use a favorite added in the open picker");
		assert.equal(await integration.handleScopedModelsCommand(), true);
		assert.match(notifications.at(-1)[0], /Jouzu uses Favorites/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Enter selects a model and stores it for the project", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-persist-selection-"));
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
		const integration = createJouzuModelPicker(paths);
		const handlers = new Map();
		const selected = [];
		let ctx;
		integration.extension.factory({
			on(name, handler) {
				handlers.set(name, handler);
			},
			async setModel(model) {
				selected.push(model.id);
				ctx.model = model;
				return true;
			},
		});
		const models = ["a", "b"].map((id) => ({
			provider: "p",
			id,
			name: id.toUpperCase(),
			contextWindow: 100_000,
			maxTokens: 10_000,
		}));
		ctx = {
			mode: "tui",
			cwd: root,
			model: models[0],
			scopedModels: [],
			sessionManager: { getBranch: () => [] },
			modelRegistry: {
				getAvailable: () => models,
				find: (provider, id) => (provider === "p" ? models.find((model) => model.id === id) : undefined),
				refresh: async () => ({ errors: new Map() }),
			},
			getContextUsage: () => ({ tokens: 100, contextWindow: 100_000, percent: 1 }),
			isIdle: () => true,
			ui: {
				notify() {},
				custom(factory) {
					return new Promise((resolve) => {
						const component = factory(
							{ terminal: { rows: 30 }, requestRender() {} },
							identityTheme,
							fakeKeybindings(),
							resolve,
						);
						setImmediate(() => {
							component.handleInput("down");
							component.handleInput("down");
							component.handleInput("enter");
						});
					});
				},
			},
		};
		await handlers.get("session_start")({ reason: "startup" }, ctx);
		assert.equal(await integration.open({ source: "action" }), true);
		assert.deepEqual(selected, ["b"]);
		assert.deepEqual(new ModelPickerStore(paths).load().state.defaults.projects[deriveProjectKey(root)], {
			provider: "p",
			modelId: "b",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the Models picker renders a selection failure in Japanese from the resolved bundle", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-locale-selection-"));
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
		const integration = createJouzuModelPicker(paths, { catalog: resolveCatalog("ja").bundle });
		const handlers = new Map();
		integration.extension.factory({
			on(name, handler) {
				handlers.set(name, handler);
			},
			// A failed activation makes `onSelect` throw the no-authentication message.
			async setModel() {
				return false;
			},
		});
		const models = ["a", "b"].map((id) => ({
			provider: "p",
			id,
			name: id.toUpperCase(),
			contextWindow: 100_000,
			maxTokens: 10_000,
		}));
		let rendered = "";
		const ctx = {
			mode: "tui",
			cwd: root,
			model: models[0],
			scopedModels: [],
			sessionManager: { getBranch: () => [] },
			modelRegistry: {
				getAvailable: () => models,
				find: (provider, id) => (provider === "p" ? models.find((model) => model.id === id) : undefined),
				refresh: async () => ({ errors: new Map() }),
			},
			getContextUsage: () => ({ tokens: 100, contextWindow: 100_000, percent: 1 }),
			isIdle: () => true,
			ui: {
				notify() {},
				custom(factory) {
					return new Promise((resolve) => {
						const component = factory(
							{ terminal: { rows: 30 }, requestRender() {} },
							identityTheme,
							fakeKeybindings(),
							resolve,
						);
						setImmediate(async () => {
							component.handleInput("down");
							component.handleInput("down");
							component.handleInput("enter");
							await new Promise((settle) => setImmediate(settle));
							await new Promise((settle) => setImmediate(settle));
							rendered = component.render(72).join("\n");
							component.handleInput("escape");
						});
					});
				},
			},
		};
		await handlers.get("session_start")({ reason: "startup" }, ctx);
		assert.equal(await integration.open({ source: "action" }), true);
		assert.match(rendered, /認証がありません/u, "the selection failure reads the Japanese bundle");
		assert.doesNotMatch(rendered, /No authentication for/u, "no English selection failure survives");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Models selection during an active call switches after turn_end", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-queued-"));
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
		const integration = createJouzuModelPicker(paths);
		const handlers = new Map();
		const selected = [];
		const notifications = [];
		let ctx;
		integration.extension.factory({
			on(name, handler) {
				handlers.set(name, handler);
			},
			async setModel(model) {
				selected.push(model.id);
				ctx.model = model;
				return true;
			},
		});
		const models = ["a", "b"].map((id) => ({
			provider: "p",
			id,
			name: id.toUpperCase(),
			contextWindow: 100_000,
			maxTokens: 10_000,
		}));
		ctx = {
			mode: "tui",
			cwd: root,
			model: models[0],
			scopedModels: [],
			sessionManager: { getBranch: () => [] },
			modelRegistry: {
				getAvailable: () => models,
				find: (provider, id) => (provider === "p" ? models.find((model) => model.id === id) : undefined),
				refresh: async () => ({ errors: new Map() }),
			},
			getContextUsage: () => ({ tokens: 100, contextWindow: 100_000, percent: 1 }),
			isIdle: () => false,
			ui: {
				notify: (...values) => notifications.push(values),
				custom(factory) {
					return new Promise((resolve) => {
						const component = factory(
							{ terminal: { rows: 30 }, requestRender() {} },
							identityTheme,
							fakeKeybindings(),
							resolve,
						);
						setImmediate(() => {
							component.handleInput("down");
							component.handleInput("down");
							component.handleInput("enter");
						});
					});
				},
			},
		};
		await handlers.get("session_start")({ reason: "startup" }, ctx);
		assert.equal(await integration.open({ source: "action" }), true);
		assert.deepEqual(selected, []);
		assert.match(notifications[0][0], /queued for the next model call: p\/b/);
		assert.deepEqual(new ModelPickerStore(paths).load().state.defaults.projects, {});
		await handlers.get("turn_end")({}, ctx);
		assert.deepEqual(selected, ["b"]);
		assert.deepEqual(new ModelPickerStore(paths).load().state.defaults.projects[deriveProjectKey(root)], {
			provider: "p",
			modelId: "b",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("context-small selection compacts before switching models", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-compact-switch-"));
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
		const integration = createJouzuModelPicker(paths);
		const handlers = new Map();
		const selected = [];
		let ctx;
		integration.extension.factory({
			on(name, handler) {
				handlers.set(name, handler);
			},
			async setModel(model) {
				selected.push(model.id);
				ctx.model = model;
				return true;
			},
		});
		const models = [
			{ provider: "p", id: "large", name: "Large", contextWindow: 100_000, maxTokens: 16_000 },
			{ provider: "p", id: "small", name: "Small", contextWindow: 8_000, maxTokens: 8_000 },
		];
		let contextTokens = 10_000;
		let compactOptions;
		ctx = {
			mode: "tui",
			cwd: root,
			model: models[0],
			scopedModels: [],
			sessionManager: { getBranch: () => [] },
			modelRegistry: {
				getAvailable: () => models,
				find: (provider, id) => (provider === "p" ? models.find((model) => model.id === id) : undefined),
				refresh: async () => ({ errors: new Map() }),
			},
			getContextUsage: () => ({ tokens: contextTokens, contextWindow: 100_000, percent: 10 }),
			isIdle: () => true,
			compact(options) {
				compactOptions = options;
				setImmediate(() => {
					contextTokens = 1_000;
					options.onComplete({ summary: "brief", firstKeptEntryId: "", tokensBefore: 10_000 });
				});
			},
			ui: {
				notify() {},
				custom(factory) {
					return new Promise((resolve) => {
						const component = factory(
							{ terminal: { rows: 30 }, requestRender() {} },
							identityTheme,
							fakeKeybindings(),
							resolve,
						);
						setImmediate(() => {
							component.handleInput("down");
							component.handleInput("enter");
							component.handleInput("enter");
						});
					});
				},
			},
		};
		await handlers.get("session_start")({ reason: "startup" }, ctx);
		assert.equal(await integration.open({ source: "action" }), true);
		assert.equal(compactOptions.customInstructions, "keep:0");
		assert.deepEqual(selected, ["small"]);
		assert.deepEqual(new ModelPickerStore(paths).load().state.defaults.projects[deriveProjectKey(root)], {
			provider: "p",
			modelId: "small",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("new sessions apply an available project default through session-only extension activation", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-default-"));
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
		const projectKey = deriveProjectKey(root);
		new ModelPickerStore(paths).setProjectDefault({ provider: "p", modelId: "b" }, projectKey);
		const integration = createJouzuModelPicker(paths, { applyProjectDefaultAtStartup: true });
		const handlers = new Map();
		const selected = [];
		integration.extension.factory({
			on(name, handler) {
				handlers.set(name, handler);
			},
			async setModel(model) {
				selected.push(model.id);
				return true;
			},
		});
		const current = { provider: "p", id: "a", name: "A", contextWindow: 100_000, maxTokens: 10_000 };
		const target = { provider: "p", id: "b", name: "B", contextWindow: 100_000, maxTokens: 10_000 };
		let branch = [
			{ type: "model_change", provider: "p", modelId: "a" },
			{ type: "thinking_level_change", thinkingLevel: "off" },
		];
		const ctx = {
			mode: "tui",
			cwd: root,
			model: current,
			scopedModels: [],
			sessionManager: { getBranch: () => branch },
			modelRegistry: { find: () => target },
			ui: { notify() {} },
		};
		await handlers.get("session_start")({ reason: "startup" }, ctx);
		assert.deepEqual(selected, ["b"]);

		branch = [...branch, { type: "message", message: { role: "user", content: "existing" } }];
		await handlers.get("session_start")({ reason: "new" }, ctx);
		assert.deepEqual(selected, ["b"], "a session with conversation messages must keep its restored model");

		branch = branch.filter((entry) => entry.type !== "message");
		ctx.scopedModels = [{ model: target }];
		await handlers.get("session_start")({ reason: "new" }, ctx);
		assert.deepEqual(selected, ["b"], "a scoped model set must retain precedence");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

for (const explicitThinking of [false, true]) {
	test(`new sessions restore last model user override unless explicit: ${explicitThinking}`, async () => {
		const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-restore-"));
		try {
			const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
			const projectKey = deriveProjectKey(root);
			new ModelPickerStore(paths).recordDispatch({ provider: "p", modelId: "b" }, projectKey, {
				thinkingLevel: "high",
				now: new Date("2026-08-23T00:00:00.000Z"),
			});
			new ModelPickerStore(paths).setModelThinkingLevel({ provider: "p", modelId: "b" }, "high");
			const integration = createJouzuModelPicker(paths, {
				restoreLastModelAtStartup: true,
				restoreLastThinkingLevelAtStartup: !explicitThinking,
			});
			const handlers = new Map();
			const selected = [];
			const levels = [];
			integration.extension.factory({
				on(name, handler) {
					handlers.set(name, handler);
				},
				async setModel(model) {
					selected.push(model.id);
					return true;
				},
				setThinkingLevel(level) {
					levels.push(level);
				},
			});
			const current = { provider: "p", id: "a", name: "A", contextWindow: 100_000, maxTokens: 10_000 };
			const target = { provider: "p", id: "b", name: "B", contextWindow: 100_000, maxTokens: 10_000 };
			let branch = [];
			const ctx = {
				mode: "tui",
				cwd: root,
				model: current,
				scopedModels: [],
				sessionManager: { getBranch: () => branch },
				modelRegistry: { find: (provider, id) => (provider === "p" && id === "b" ? target : undefined) },
				ui: { notify() {} },
			};
			await handlers.get("session_start")({ reason: "startup" }, ctx);
			assert.deepEqual(selected, ["b"]);
			assert.deepEqual(
				levels,
				explicitThinking ? [] : ["high"],
				"the explicit user thinking preference must be restored with the model",
			);

			branch = [{ type: "message", message: { role: "user", content: "existing" } }];
			await handlers.get("session_start")({ reason: "new" }, ctx);
			assert.deepEqual(selected, ["b"], "a session with conversation messages must keep its restored model");

			branch = [];
			ctx.model = target;
			await handlers.get("session_start")({ reason: "new" }, ctx);
			assert.deepEqual(selected, ["b"], "restoring the already-active model must be a no-op");
			assert.deepEqual(levels, explicitThinking ? [] : ["high", "high"], "same model still restores saved thinking");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("a project default takes precedence over the last used model", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-restore-precedence-"));
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
		const projectKey = deriveProjectKey(root);
		const store = new ModelPickerStore(paths);
		store.setProjectDefault({ provider: "p", modelId: "c" }, projectKey);
		store.recordDispatch({ provider: "p", modelId: "b" }, projectKey, { thinkingLevel: "high" });
		const integration = createJouzuModelPicker(paths, {
			applyProjectDefaultAtStartup: true,
			restoreLastModelAtStartup: true,
		});
		const handlers = new Map();
		const selected = [];
		const levels = [];
		integration.extension.factory({
			on(name, handler) {
				handlers.set(name, handler);
			},
			async setModel(model) {
				selected.push(model.id);
				return true;
			},
			setThinkingLevel(level) {
				levels.push(level);
			},
		});
		const models = ["a", "b", "c"].map((id) => ({
			provider: "p",
			id,
			name: id.toUpperCase(),
			contextWindow: 100_000,
			maxTokens: 10_000,
		}));
		const ctx = {
			mode: "tui",
			cwd: root,
			model: models[0],
			scopedModels: [],
			sessionManager: { getBranch: () => [] },
			modelRegistry: {
				find: (provider, id) => (provider === "p" ? models.find((model) => model.id === id) : undefined),
			},
			ui: { notify() {} },
		};
		await handlers.get("session_start")({ reason: "startup" }, ctx);
		assert.deepEqual(selected, ["c"]);
		assert.deepEqual(levels, [], "a project default does not borrow the last model's thinking level");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("legacy state without a last record falls back to the most recent global dispatch", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-restore-legacy-"));
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
		mkdirSync(paths.stateDir, { recursive: true });
		writeFileSync(
			join(paths.stateDir, "model-picker.json"),
			JSON.stringify({
				...emptyModelPickerState(),
				recents: {
					global: [{ provider: "p", modelId: "b", lastUsedAt: "2026-08-23T00:00:00.000Z", useCount: 3 }],
					projects: {},
				},
			}),
		);
		const integration = createJouzuModelPicker(paths, { restoreLastModelAtStartup: true });
		const handlers = new Map();
		const selected = [];
		const levels = [];
		integration.extension.factory({
			on(name, handler) {
				handlers.set(name, handler);
			},
			async setModel(model) {
				selected.push(model.id);
				return true;
			},
			setThinkingLevel(level) {
				levels.push(level);
			},
		});
		const target = { provider: "p", id: "b", name: "B", contextWindow: 100_000, maxTokens: 10_000 };
		const ctx = {
			mode: "tui",
			cwd: root,
			model: { provider: "p", id: "a", name: "A", contextWindow: 100_000, maxTokens: 10_000 },
			scopedModels: [],
			sessionManager: { getBranch: () => [] },
			modelRegistry: { find: () => target },
			ui: { notify() {} },
		};
		await handlers.get("session_start")({ reason: "startup" }, ctx);
		assert.deepEqual(selected, ["b"]);
		assert.deepEqual(levels, [], "a legacy recent record has no thinking level to restore");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("last model restore stays off unless requested and warns when the model is unavailable", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-restore-off-"));
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
		const projectKey = deriveProjectKey(root);
		new ModelPickerStore(paths).recordDispatch({ provider: "p", modelId: "b" }, projectKey);

		const offIntegration = createJouzuModelPicker(paths);
		const offHandlers = new Map();
		const offSelected = [];
		offIntegration.extension.factory({
			on(name, handler) {
				offHandlers.set(name, handler);
			},
			async setModel(model) {
				offSelected.push(model.id);
				return true;
			},
			setThinkingLevel() {},
		});
		const current = { provider: "p", id: "a", name: "A", contextWindow: 100_000, maxTokens: 10_000 };
		const makeCtx = (find, notifications) => ({
			mode: "tui",
			cwd: root,
			model: current,
			scopedModels: [],
			sessionManager: { getBranch: () => [] },
			modelRegistry: { find },
			ui: { notify: (...values) => notifications?.push(values) },
		});
		await offHandlers.get("session_start")(
			{ reason: "startup" },
			makeCtx(() => undefined, []),
		);
		assert.deepEqual(offSelected, [], "restore must be opt-in so embedded hosts keep Pi's own selection");

		const onIntegration = createJouzuModelPicker(paths, { restoreLastModelAtStartup: true });
		const onHandlers = new Map();
		onIntegration.extension.factory({
			on(name, handler) {
				onHandlers.set(name, handler);
			},
			async setModel() {
				return true;
			},
			setThinkingLevel() {},
		});
		const notifications = [];
		await onHandlers.get("session_start")(
			{ reason: "startup" },
			makeCtx(() => undefined, notifications),
		);
		assert.match(notifications[0][0], /Last used model is unavailable: p\/b/);
		assert.equal(notifications[0][1], "warning");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("thinking level changes persist for the dispatched model only", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-thinking-"));
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
		const projectKey = deriveProjectKey(root);
		new ModelPickerStore(paths).recordDispatch({ provider: "p", modelId: "b" }, projectKey, {
			thinkingLevel: "medium",
		});
		const integration = createJouzuModelPicker(paths);
		const handlers = new Map();
		integration.extension.factory({
			on(name, handler) {
				handlers.set(name, handler);
			},
			setModel: async () => true,
			setThinkingLevel() {},
		});
		const modelB = { provider: "p", id: "b", name: "B", contextWindow: 100_000, maxTokens: 10_000 };
		const ctx = {
			mode: "tui",
			cwd: root,
			model: modelB,
			scopedModels: [],
			sessionManager: { getBranch: () => [] },
			modelRegistry: { find: () => modelB },
			ui: { notify() {} },
		};
		await handlers.get("session_start")({ reason: "startup" }, ctx);
		await handlers.get("thinking_level_select")({ level: "max", previousLevel: "medium" }, ctx);
		assert.equal(new ModelPickerStore(paths).load().state.last?.thinkingLevel, "max");

		ctx.model = { provider: "p", id: "a", name: "A", contextWindow: 100_000, maxTokens: 10_000 };
		await handlers.get("thinking_level_select")({ level: "low", previousLevel: "max" }, ctx);
		assert.equal(
			new ModelPickerStore(paths).load().state.last?.thinkingLevel,
			"max",
			"a level change on another model must not rewrite the last record",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("failed project activation does not persist a project default", async (testContext) => {
	for (const [name, setModel] of [
		["missing authentication", async () => false],
		["activation error", async () => Promise.reject(new Error("activation failed"))],
	]) {
		await testContext.test(name, async () => {
			const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-failed-default-"));
			try {
				const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
				const integration = createJouzuModelPicker(paths);
				const handlers = new Map();
				integration.extension.factory({
					on(event, handler) {
						handlers.set(event, handler);
					},
					setModel,
				});
				const model = { provider: "p", id: "m", name: "M", contextWindow: 100_000, maxTokens: 10_000 };
				let component;
				const ctx = {
					mode: "tui",
					cwd: root,
					model,
					scopedModels: [],
					sessionManager: { getBranch: () => [] },
					modelRegistry: {
						getAvailable: () => [model],
						refresh: async () => ({ errors: new Map() }),
						find: () => model,
					},
					getContextUsage: () => ({ tokens: 100, contextWindow: 100_000, percent: 1 }),
					isIdle: () => true,
					ui: {
						notify() {},
						custom(factory) {
							return new Promise((resolve) => {
								component = factory(
									{ terminal: { rows: 30 }, requestRender() {} },
									identityTheme,
									fakeKeybindings(),
									resolve,
								);
							});
						},
					},
				};
				await handlers.get("session_start")({ reason: "startup" }, ctx);
				const opened = integration.open({ source: "action" });
				await Promise.resolve();
				component.handleInput("enter");
				await new Promise((resolve) => setTimeout(resolve, 5));
				component.handleInput("escape");
				await opened;
				assert.deepEqual(new ModelPickerStore(paths).load().state.defaults.projects, {});
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
});

test("corrupt picker state is quarantined and reported after a UI context exists", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-corrupt-launch-"));
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
		mkdirSync(paths.stateDir, { recursive: true });
		const statePath = join(paths.stateDir, "model-picker.json");
		writeFileSync(statePath, "{ broken");
		const integration = createJouzuModelPicker(paths);
		assert.equal(readFileSync(statePath, "utf8"), "{ broken", "construction must not recover without a UI");
		const handlers = new Map();
		integration.extension.factory({
			on(event, handler) {
				handlers.set(event, handler);
			},
			setModel: async () => true,
		});
		const notifications = [];
		await handlers.get("session_start")(
			{ reason: "startup" },
			{
				mode: "tui",
				cwd: root,
				model: undefined,
				scopedModels: [],
				sessionManager: { getBranch: () => [] },
				ui: { notify: (...values) => notifications.push(values) },
			},
		);
		assert.equal(existsSync(statePath), false);
		assert.equal(
			readdirSync(paths.stateDir).some((name) => name.startsWith("model-picker.corrupt-")),
			true,
		);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0][0], /Unreadable model picker state was preserved/);
		assert.equal(notifications[0][1], "warning");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("picker state and cached catalog warnings are each reported once", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-warning-latches-"));
	const previousEndpoint = process.env.JOUZU_MODEL_CATALOG_URL;
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
		mkdirSync(paths.stateDir, { recursive: true });
		writeFileSync(join(paths.stateDir, "model-picker.json"), "{ broken");

		const endpoint = "https://catalog.example.test/v1/jouzu/model-catalog";
		process.env.JOUZU_MODEL_CATALOG_URL = endpoint;
		const endpointHash = createHash("sha256").update(endpoint).digest("hex");
		const originDirectory = join(paths.cacheDir, "model-catalog", endpointHash);
		mkdirSync(originDirectory, { recursive: true });
		writeFileSync(join(originDirectory, "origin.json"), "{ broken");

		const integration = createJouzuModelPicker(paths);
		const handlers = new Map();
		integration.extension.factory({
			on(event, handler) {
				handlers.set(event, handler);
			},
			setModel: async () => true,
		});
		const notifications = [];
		const ctx = {
			mode: "tui",
			cwd: root,
			model: undefined,
			scopedModels: [],
			sessionManager: { getBranch: () => [] },
			ui: { notify: (...values) => notifications.push(values) },
		};
		await handlers.get("session_start")({ reason: "startup" }, ctx);
		await handlers.get("session_start")({ reason: "reload" }, ctx);

		assert.equal(notifications.length, 3);
		assert.match(notifications[0][0], /Unreadable model picker state was preserved/u);
		assert.match(notifications[1][0], /Cached model catalog was ignored/u);
		assert.match(notifications[2][0], /Catalogs not refreshed/u);
		assert.match(notifications[2][0], /Cached catalog data remains available/u);
		assert.ok(notifications.every(([, level]) => level === "warning"));
	} finally {
		if (previousEndpoint === undefined) delete process.env.JOUZU_MODEL_CATALOG_URL;
		else process.env.JOUZU_MODEL_CATALOG_URL = previousEndpoint;
		rmSync(root, { recursive: true, force: true });
	}
});

test("integration records recency only on the first physical dispatch after each selection", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-integration-"));
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
		const integration = createJouzuModelPicker(paths);
		const handlers = new Map();
		integration.extension.factory({
			on(name, handler) {
				handlers.set(name, handler);
			},
			setModel: async () => true,
		});
		let model = { provider: "p", id: "a", name: "A", contextWindow: 100_000, maxTokens: 10_000 };
		const ctx = {
			mode: "tui",
			cwd: root,
			model,
			scopedModels: [],
			sessionManager: { getBranch: () => [] },
			modelRegistry: { getAvailable: () => [model] },
			ui: { notify() {} },
		};
		await handlers.get("session_start")({}, ctx);
		await handlers.get("before_provider_request")({}, ctx);
		await handlers.get("before_provider_request")({}, ctx);

		model = { provider: "p", id: "b", name: "B", contextWindow: 100_000, maxTokens: 10_000 };
		ctx.model = model;
		ctx.modelRegistry.getAvailable = () => [model];
		await handlers.get("model_select")({ model, previousModel: { provider: "p", id: "a" } }, ctx);
		await handlers.get("before_provider_request")({}, ctx);

		const state = JSON.parse(readFileSync(join(paths.stateDir, "model-picker.json"), "utf8"));
		assert.deepEqual(
			state.recents.global.map(({ modelId, useCount }) => [modelId, useCount]),
			[
				["b", 1],
				["a", 1],
			],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("typing reuses the cached total instead of re-ranking the inventory", () => {
	const queries = [];
	const { component } = createComponent({
		getRows: (query) => {
			queries.push(query);
			return rows();
		},
	});

	// Construction ranks the empty-query total once and the active query once.
	assert.deepEqual(queries, ["", ""]);

	queries.length = 0;
	component.handleInput("a");
	assert.equal(queries.length, 1, "a keystroke must rank once and reuse the total");
	assert.equal(queries[0], "a");

	queries.length = 0;
	component.handleInput("b");
	component.handleInput("c");
	assert.equal(queries.length, 2);
});

test("toggling a favorite refreshes the cached total", () => {
	const queries = [];
	const { component } = createComponent({
		getRows: (query) => {
			queries.push(query);
			return rows();
		},
	});

	// Type first so the active query is distinguishable from the count queries.
	component.handleInput("z");
	queries.length = 0;

	component.handleInput("\u0006");
	// A favorite moves the row in the base order, so the total is recomputed
	// and the active query is ranked once more.
	assert.equal(queries.filter((query) => query === "").length, 1, "the total refreshes once");
	assert.deepEqual(
		queries.filter((query) => query !== ""),
		["z"],
		"the active query is re-ranked exactly once",
	);
});

test("Models search selects and remembers the gateway offering over a conflicting local provider", async () => {
	const { ModelRuntime, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
	const root = mkdtempSync(join(tmpdir(), "jouzu-picker-gateway-"));
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
		const document = JSON.parse(
			readFileSync(join(import.meta.dirname, "..", "catalog", "fixtures", "account-snapshot-v1.json"), "utf8"),
		);
		const env = { PICKER_GATEWAY_TOKEN: "picker-gateway-jwt" };
		const source = new CatalogSourceStore(paths).add({
			label: "Office pool",
			url: "https://pool.example.test/v1/jouzu/model-catalog",
			auth: { type: "bearer", credentialRef: "env:PICKER_GATEWAY_TOKEN" },
		});
		await refreshCatalogSource(paths, source, {
			env,
			fetch: async () =>
				new Response(JSON.stringify(document), { status: 200, headers: { "content-type": MODEL_CATALOG_MEDIA_TYPE } }),
		});
		mkdirSync(paths.agentDir, { recursive: true });
		const modelsPath = join(paths.agentDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"ai.example.gateway": {
						api: "openai-completions",
						baseUrl: "https://direct.example.test/v1",
						apiKey: "$MISSING_DIRECT_KEY",
						models: [{ id: "example-model", name: "Direct model" }],
					},
				},
			}),
		);
		const runtime = await ModelRuntime.create({ modelsPath, authPath: join(paths.agentDir, "auth.json") });
		const registry = new ModelRegistry(runtime);
		registry.refresh = () => runtime.refresh({ allowNetwork: false });
		const handlers = new Map();
		let selected;
		let ctx;
		const integration = createJouzuModelPicker(paths, { palette: { env, columns: 100, rows: 30 } });
		const pi = {
			on: (name, handler) => handlers.set(name, handler),
			registerProvider: (...args) => registry.registerProvider(...args),
			unregisterProvider: (id) => registry.unregisterProvider(id),
			setThinkingLevel() {},
			setModel: async (model) => {
				selected = model;
				ctx.model = model;
				return true;
			},
		};
		integration.extension.factory(pi);
		ctx = {
			mode: "tui",
			cwd: root,
			model: registry.find("ai.example.gateway", "example-model"),
			scopedModels: [],
			modelRegistry: registry,
			sessionManager: { getBranch: () => [] },
			getContextUsage: () => undefined,
			isIdle: () => true,
			ui: {
				notify() {},
				custom: (factory) =>
					new Promise((resolve, reject) => {
						const component = factory(
							{ terminal: { rows: 30 }, requestRender() {} },
							identityTheme,
							fakeKeybindings(),
							resolve,
						);
						setImmediate(() => {
							try {
								const rendered = stripSgr(component.render(100).join("\n"));
								assert.match(rendered, /ai\.example\.gateway\/example-model/);
								assert.match(rendered, /Office pool/);
								assert.doesNotMatch(rendered, /Direct model|catalog:/);
								component.handleInput("enter");
								setTimeout(() => {
									if (!selected) reject(new Error(stripSgr(component.render(100).join("\n"))));
								}, 300);
							} catch (error) {
								reject(error);
							}
						});
					}),
			},
		};
		await handlers.get("session_start")({ reason: "startup" }, ctx);
		await integration.open({ source: "action", initialSearchInput: "example-model" });
		assert.equal(selected.baseUrl, "https://pool.example.test/v1");
		assert.equal((await runtime.prepareRequest(selected)).options.apiKey, "picker-gateway-jwt");
		const saved = new ModelPickerStore(paths).load().state.defaults.projects[deriveProjectKey(root)];
		assert.deepEqual(saved, {
			provider: "ai.example.gateway",
			modelId: "example-model",
			catalogId: document.catalogId,
			offeringId: document.modelOfferings[0].id,
		});
		ctx.model = registry.find("ai.example.gateway", "example-model");
		assert.deepEqual(await handlers.get("input")({ text: "hello" }, ctx), { action: "continue" });
		assert.equal(
			ctx.model.baseUrl,
			"https://pool.example.test/v1",
			"an existing local selection is rebound before dispatch",
		);
		ctx.model = registry.find("ai.example.gateway", "example-model");
		pi.setModel = async () => false;
		let restoredDraft;
		ctx.ui.setEditorText = (text) => {
			restoredDraft = text;
		};
		assert.deepEqual(await handlers.get("input")({ text: "keep this draft" }, ctx), { action: "handled" });
		assert.equal(
			restoredDraft,
			"keep this draft",
			"failed gateway activation must preserve the prompt and stop local dispatch",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("session startup restores a saved catalog model over the initial local model", async () => {
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const root = mkdtempSync(join(tmpdir(), "jouzu-picker-catalog-restore-"));
	let session;
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
		const document = JSON.parse(
			readFileSync(join(import.meta.dirname, "..", "catalog", "fixtures", "account-snapshot-v1.json"), "utf8"),
		);
		const env = { PICKER_GATEWAY_TOKEN: "fixture-key" };
		const source = new CatalogSourceStore(paths).add({
			label: "Office pool",
			url: "https://pool.example.test/v1/jouzu/model-catalog",
			auth: { type: "bearer", credentialRef: "env:PICKER_GATEWAY_TOKEN" },
		});
		const reference = catalogModelReference("ai.example.gateway", "example-model", document);
		new ModelPickerStore(paths).recordDispatch(reference, deriveProjectKey(root));
		assert.equal(
			(
				await refreshCatalogSource(paths, source, {
					env,
					fetch: async () =>
						new Response(JSON.stringify(document), {
							headers: { "content-type": MODEL_CATALOG_MEDIA_TYPE },
						}),
				})
			).status,
			"activated",
		);
		const runtime = await ModelRuntime.create({
			modelsPath: null,
			modelsStorePath: join(root, "models.json"),
			refreshOnCreate: false,
			allowModelNetwork: false,
			credentials: {
				read: async () => undefined,
				list: async () => [],
				modify: async () => undefined,
				delete: async () => {},
			},
		});
		runtime.registerProvider("local-fixture", {
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:1",
			apiKey: "local-fixture-key",
			models: [{ id: "fallback", name: "Local fallback", input: ["text"], contextWindow: 32000, maxTokens: 1000 }],
		});
		const integration = createJouzuModelPicker(paths, { restoreLastModelAtStartup: true, palette: { env } });
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: paths.agentDir,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
			extensionFactories: [integration.extension.factory],
		});
		await loader.reload();
		({ session } = await createAgentSession({
			cwd: root,
			agentDir: paths.agentDir,
			modelRuntime: runtime,
			model: runtime.getModel("local-fixture", "fallback"),
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(root),
			tools: [],
			settingsManager: SettingsManager.inMemory(),
		}));
		assert.equal(session.model.provider, "local-fixture");
		const errors = [];
		const notifications = [];
		await session.bindExtensions({
			mode: "tui",
			onError: (error) => errors.push(error),
			uiContext: { notify: (message) => notifications.push(message) },
		});
		assert.equal(session.model.id, reference.modelId);
		assert.equal(session.model.baseUrl, "https://pool.example.test/v1");
		assert.equal((await runtime.prepareRequest(session.model)).options.apiKey, "fixture-key");
		assert.deepEqual(errors, []);
		assert.deepEqual(notifications, []);
	} finally {
		session?.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("selecting the active Models row preserves live and saved thinking with the Pi session setter", {
	timeout: 15000,
}, async () => {
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const root = mkdtempSync(join(tmpdir(), "jouzu-picker-same-thinking-"));
	let session;
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
		const store = new ModelPickerStore(paths);
		const reference = { provider: "thinking-fixture", modelId: "fixture" };
		store.setModelThinkingLevel(reference, "high");
		const runtime = await ModelRuntime.create({
			modelsPath: null,
			modelsStorePath: join(root, "models.json"),
			refreshOnCreate: false,
			allowModelNetwork: false,
			credentials: {
				read: async () => undefined,
				list: async () => [],
				modify: async () => undefined,
				delete: async () => {},
			},
		});
		runtime.registerProvider(reference.provider, {
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:1",
			apiKey: "fixture-only",
			models: [
				{
					id: "fixture",
					name: "Fixture",
					reasoning: true,
					input: ["text"],
					contextWindow: 32000,
					maxTokens: 1000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
		});
		const integration = createJouzuModelPicker(paths, {
			palette: { env: { TERM: "xterm-256color" }, columns: 100, rows: 30 },
		});
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: paths.agentDir,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
			extensionFactories: [integration.extension.factory],
		});
		await loader.reload();
		({ session } = await createAgentSession({
			cwd: root,
			agentDir: paths.agentDir,
			modelRuntime: runtime,
			model: runtime.getModel(reference.provider, reference.modelId),
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(root),
			tools: [],
			settingsManager: SettingsManager.inMemory({ defaultThinkingLevel: "medium" }),
		}));
		const errors = [];
		await session.bindExtensions({
			mode: "tui",
			onError: (error) => errors.push(error),
			uiContext: {
				notify() {},
				custom: (factory) =>
					new Promise((resolve, reject) => {
						const component = factory(
							{ terminal: { rows: 30 }, requestRender() {} },
							identityTheme,
							fakeKeybindings(),
							resolve,
						);
						setImmediate(() => {
							try {
								assert.match(stripSgr(component.render(100).join("\n")), /fixture/);
								component.handleInput("enter");
							} catch (error) {
								reject(error);
							}
						});
					}),
			},
		});
		assert.equal(session.thinkingLevel, "high");
		await integration.open({ source: "action", initialSearchInput: "fixture" });
		assert.equal(session.thinkingLevel, "high");
		assert.equal(store.load().state.thinkingLevels[0].thinkingLevel, "high");
		assert.deepEqual(store.load().state.defaults.projects[deriveProjectKey(root)], reference);
		session.setThinkingLevel("low");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(store.load().state.thinkingLevels[0].thinkingLevel, "low", "later user changes still persist");
		assert.deepEqual(errors, []);
	} finally {
		session?.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("The context ceiling caps picker rows and the model switch fit check", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-clamp-"));
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "jouzu") });
		mkdirSync(paths.configDir, { recursive: true });
		writeContextPolicy(paths, 384_000);
		const catalog = parseAndValidateModelCatalog(
			readFileSync(join(import.meta.dirname, "..", "catalog", "fixtures", "account-snapshot-v1.json"), "utf8"),
			{ remote: true },
		);
		catalog.modelOfferings[0].limits = { contextWindow: 1_000_000, maxOutputTokens: 32_768 };
		const active = [
			{
				source: {
					id: "metadata",
					label: "Metadata catalog",
					url: "https://metadata.test/catalog",
					enabled: true,
					auth: { type: "none" },
				},
				document: catalog,
			},
		];
		const model = {
			provider: "ai.example.gateway",
			id: "example-model",
			name: "Pi label",
			contextWindow: 1_000_000,
			maxTokens: 32_768,
		};
		const ctx = {
			modelRegistry: { getAvailable: () => [model], getAll: () => [model] },
			scopedModels: [],
		};

		const rows = pickerModels(ctx, active, {}, paths);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].contextWindow, 384_000, "the catalog offering's declared window is capped");
		assert.equal(modelContextFit(rows[0], 500_000), "too-small", "the fit check uses the capped window");
		assert.equal(modelContextFit(rows[0], 300_000), "fits");

		writeContextPolicy(paths, undefined);
		assert.equal(pickerModels(ctx, active, {}, paths)[0].contextWindow, 1_000_000, "off restores the declared window");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
