import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parseAndValidateModelCatalog } from "../dist/model-catalog.js";
import {
	catalogModelReference,
	catalogPickerModel,
	catalogPickerModels,
	createJouzuModelPicker,
	ModelPickerComponent,
} from "../dist/model-picker.js";
import { deriveProjectKey, ModelPickerStore } from "../dist/model-picker-state.js";
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
			section: "all",
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
	const calls = { close: 0, selected: [], favorites: [], filters: [], renders: 0 };
	const component = new ModelPickerComponent({
		context: {
			tui: {
				terminal: { rows: 30 },
				requestRender() {
					calls.renders += 1;
				},
			},
			theme: identityTheme,
			styles: createSessionUiStyles(identityTheme),
			keybindings: overrides.keybindings ?? fakeKeybindings(),
			close() {
				calls.close += 1;
			},
		},
		initialRoute: { view: "models" },
		...(overrides.initialFilter ? { initialFilter: overrides.initialFilter } : {}),
		getRows: overrides.getRows ?? (() => rows()),
		onSelect: async (row, scope) => {
			calls.selected.push([row.model.modelId, scope]);
		},
		onToggleFavorite: (row) => {
			calls.favorites.push(row.model.modelId);
		},
		onFilterChange: (filter) => {
			calls.filters.push(filter);
			overrides.onFilterChange?.(filter);
		},
		...(overrides.onRefresh ? { onRefresh: overrides.onRefresh } : {}),
	});
	return { component, calls };
}

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
		selected,
		notifications,
		async dispose() {
			await handlers.get("session_shutdown")({}, ctx);
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("Models view renders within width and blocks a context that cannot fit", async () => {
	const { component, calls } = createComponent();
	const rendered = component.render(72);
	assert.ok(rendered.length > 8);
	assert.ok(rendered.every((line) => visibleWidth(line) === 72));
	assert.match(stripSgr(rendered[0]), /JOUZU · Models/);
	assert.match(stripSgr(rendered.join("\n")), /\[Models\].*Settings/u);
	assert.match(rendered.join("\n"), /small\/tiny/);
	assert.match(rendered.join("\n"), /large\/fit/);

	component.handleInput("enter");
	await Promise.resolve();
	assert.deepEqual(calls.selected, []);
	assert.equal(calls.close, 0);
	assert.match(component.render(72).join("\n"), /does not fit/);
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
	assert.match(rendered, /Ctrl\+S session/u);
	assert.match(rendered, /K\/J move/u);
	assert.match(rendered, /Alt\+X close/u);
	assert.doesNotMatch(rendered, /Enter session|Esc close|↑↓ move/u);
});

test("Models view keeps ANSI and CJK content inside aligned display-width borders", () => {
	const originalColorTerm = process.env.COLORTERM;
	process.env.COLORTERM = "truecolor";
	try {
		const { component } = createComponent({
			getRows: () => [
				{
					section: "all",
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
	}
});

test("Models view selects for the session or project, toggles filters and favorites, and cancels", async () => {
	const first = createComponent();
	first.component.handleInput("down");
	first.component.handleInput("enter");
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(first.calls.selected, [["fit", "session"]]);
	assert.equal(first.calls.close, 1);

	const second = createComponent();
	second.component.handleInput("down");
	second.component.handleInput("\x1b[13;2u");
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(second.calls.selected, [["fit", "project"]]);

	const third = createComponent();
	third.component.handleInput("\u001b[C");
	third.component.handleInput("\u001b[D");
	third.component.handleInput("down");
	third.component.handleInput(" ");
	assert.deepEqual(third.calls.filters, ["favorite", "recent"]);
	assert.deepEqual(third.calls.favorites, ["fit"]);
	third.component.handleInput("escape");
	assert.equal(third.calls.close, 1);
});

test("Models view restores the last filter and reports filter changes", () => {
	const activeFilters = [];
	const { component, calls } = createComponent({
		initialFilter: "favorite",
		getRows(_query, filter) {
			activeFilters.push(filter);
			return rows();
		},
	});
	assert.equal(activeFilters.at(-1), "favorite");

	component.handleInput("\u001b[C");
	assert.equal(activeFilters.at(-1), "all");
	component.handleInput("\u001b[D");
	assert.equal(activeFilters.at(-1), "favorite");
	assert.deepEqual(calls.filters, ["all", "favorite"]);
});

test("Models view keeps the selected filter when saving it fails", () => {
	const activeFilters = [];
	const { component } = createComponent({
		getRows(_query, filter) {
			activeFilters.push(filter);
			return rows();
		},
		onFilterChange() {
			throw new Error("broken\u001b]0;hidden\u0007 state");
		},
	});
	component.handleInput("\u001b[C");
	assert.equal(activeFilters.at(-1), "favorite");
	const rendered = component.render(72).join("\n");
	assert.match(rendered, /Filter choice was not saved: broken state/);
	assert.doesNotMatch(rendered, /hidden/);
});

test("Models view separates browse choices from search cursor input", () => {
	const activeFilters = [];
	const queries = [];
	const { component, calls } = createComponent({
		getRows(query, filter) {
			queries.push(query);
			activeFilters.push(filter);
			return rows();
		},
	});
	const browseText = component.render(72).join("\n");
	assert.match(browseText, /View\s+< Recent >/u);
	assert.match(browseText, /Tab section/u);
	assert.doesNotMatch(browseText, /Ctrl\+,|Tab filter|Ctrl\+F/u);

	component.handleInput("\u001b[C");
	assert.equal(activeFilters.at(-1), "favorite");
	component.handleInput("q");
	const filterChanges = calls.filters.length;
	component.handleInput("\u001b[C");
	assert.equal(calls.filters.length, filterChanges, "horizontal arrows edit search instead of changing View");
	component.handleInput(" ");
	assert.equal(queries.at(-1), "q ");
	assert.deepEqual(calls.favorites, []);
	assert.match(component.render(72).join("\n"), /→ Search/u);

	component.handleInput("escape");
	assert.equal(calls.close, 0, "Esc leaves search before closing the Palette");
	component.handleInput(" ");
	assert.deepEqual(calls.favorites, ["tiny"]);
	component.handleInput("escape");
	assert.equal(calls.close, 1);

	const directSearch = createComponent();
	directSearch.component.handleInput("/");
	assert.match(directSearch.component.render(72).join("\n"), /→ Search/u);
	directSearch.component.handleInput("escape");
	assert.equal(directSearch.calls.close, 0);
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
				section: "all",
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
							component.handleInput("\u001b[C");
							component.handleInput("\u001b[C");
							component.handleInput("down");
							component.handleInput(" ");
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
		assert.match(rendered, /p\/fresh/, "the Palette must render models discovered by the refresh");
		assert.doesNotMatch(rendered, /Model catalogs refreshed\./);
		assert.equal(customOptions.overlay, true);
		assert.equal(refreshCalls, 1, "opening the Palette must refresh Pi's effective model inventory");
		assert.equal(
			new ModelPickerStore(paths).load().state.filter,
			"all",
			"filter changes must persist through the integration",
		);
		assert.equal(await integration.cycleFavorite("forward"), true);
		assert.deepEqual(selected, ["fresh"], "Ctrl+P must immediately use a favorite added in the open picker");
		assert.equal(await integration.handleScopedModelsCommand(), true);
		assert.match(notifications.at(-1)[0], /Jouzu uses Favorites/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Models selection during an active call switches after turn_end", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-queued-"));
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
		new ModelPickerStore(paths).setFilter("all");
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
		await handlers.get("turn_end")({}, ctx);
		assert.deepEqual(selected, ["b"]);
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
				component.handleInput("\x1b[13;2u");
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

		assert.equal(notifications.length, 2);
		assert.match(notifications[0][0], /Unreadable model picker state was preserved/u);
		assert.match(notifications[1][0], /Cached model catalog was ignored/u);
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

test("typing reuses cached filter counts instead of re-ranking the inventory", () => {
	const queries = [];
	const { component } = createComponent({
		getRows: (query) => {
			queries.push(query);
			return rows();
		},
	});

	// Construction ranks the active query once and the three filter counts once each.
	assert.equal(queries.length, 4);
	assert.deepEqual(queries.slice(1).sort(), ["", "", ""], "filter counts are computed with an empty query");

	queries.length = 0;
	component.handleInput("a");
	assert.equal(queries.length, 1, "a keystroke must rank once, not once per filter");
	assert.equal(queries[0], "a");

	queries.length = 0;
	component.handleInput("b");
	component.handleInput("c");
	assert.equal(queries.length, 2);

	// Leaving search and changing View re-ranks the active list without disturbing the counts.
	component.handleInput("escape");
	queries.length = 0;
	component.handleInput("\u001b[C");
	assert.equal(queries.length, 1);
});

test("toggling a favorite refreshes the cached filter counts", () => {
	const queries = [];
	const { component } = createComponent({
		getRows: (query) => {
			queries.push(query);
			return rows();
		},
	});

	// Type first so the active query is distinguishable from the count queries.
	component.handleInput("z");
	component.handleInput("escape");
	queries.length = 0;

	component.handleInput(" ");
	// A favorite changes the inventory partition, so the three counts are
	// recomputed and the active query is ranked once more.
	assert.equal(queries.filter((query) => query === "").length, 3, "all three filter counts refresh");
	assert.deepEqual(
		queries.filter((query) => query !== ""),
		["z"],
		"the active query is re-ranked exactly once",
	);
});
