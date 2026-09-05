import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createJouzuKeybindingsManagerFromConfig } from "../dist/jouzu-keybindings.js";
import { parseAndValidateModelCatalog } from "../dist/model-catalog.js";
import {
	catalogModelReference,
	catalogPickerModel,
	catalogPickerModels,
	compactContextForModelSwitch,
	createJouzuModelPicker,
	ModelPickerComponent,
} from "../dist/model-picker.js";
import { deriveProjectKey, emptyModelPickerState, ModelPickerStore } from "../dist/model-picker-state.js";
import { JouzuPaletteRouter } from "../dist/palette.js";
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
	const calls = { close: 0, selected: [], compacted: [], favorites: [], filters: [], renders: 0 };
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
			jouzuKeybindings: overrides.jouzuKeybindings ?? createJouzuKeybindingsManagerFromConfig(),
			close() {
				calls.close += 1;
			},
		},
		initialRoute: { view: "models" },
		...(overrides.initialFilter ? { initialFilter: overrides.initialFilter } : {}),
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
	assert.match(rendered.join("\n"), /small\/tiny/);
	assert.match(rendered.join("\n"), /large\/fit/);

	component.handleInput("enter");
	assert.deepEqual(calls.selected, []);
	assert.deepEqual(calls.compacted, []);
	assert.equal(calls.close, 0);
	const confirmation = component.render(72).join("\n");
	assert.match(stripSgr(confirmation), /JOUZU · Models · Confirm/);
	assert.match(confirmation, /Compact the active context and switch to small\/tiny\?/);
	assert.match(confirmation, /Enter compact and switch · Esc\/Ctrl\+C cancel/);
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
		if (originalTerm === undefined) delete process.env.TERM;
		else process.env.TERM = originalTerm;
		if (originalNoColor === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = originalNoColor;
	}
});

test("Models view selects and saves for the project, toggles filters and favorites, and cancels", async () => {
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

	const third = createComponent();
	third.component.handleInput("\u001b[C");
	third.component.handleInput("\u001b[D");
	third.component.handleInput("down");
	third.component.handleInput("\u0006");
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
	assert.doesNotMatch(browseText, /Ctrl\+,|Tab filter/u);

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
	component.handleInput("\u0006");
	assert.deepEqual(calls.favorites, ["tiny"], "Ctrl+F toggles favorite from browse");
	component.handleInput(" ");
	assert.equal(queries.at(-1), "q  ", "Space types into search like every printable character");
	assert.deepEqual(calls.favorites, ["tiny"], "Space no longer toggles favorite");
	component.handleInput("escape");
	assert.equal(calls.close, 0, "Esc leaves search before closing the Palette");
	component.handleInput("escape");
	assert.equal(calls.close, 1);

	const directSearch = createComponent();
	directSearch.component.handleInput("/");
	assert.match(directSearch.component.render(72).join("\n"), /→ Search/u);
	directSearch.component.handleInput("escape");
	assert.equal(directSearch.calls.close, 0);
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
	assert.deepEqual(calls.favorites, ["fit", "fit", "fit"], "Ctrl+F toggles while search holds focus");
	assert.match(component.render(72).join("\n"), /Added large\/fit to favorites\./u);
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

test("Models view hints the browse route when a favorite binding is printable", () => {
	const { component, calls } = createComponent({
		jouzuKeybindings: createJouzuKeybindingsManagerFromConfig({ "jouzu.model.toggleFavorite": "f" }),
	});
	component.handleInput("f");
	assert.deepEqual(calls.favorites, ["tiny"], "a printable favorite binding works in browse state");
	component.handleInput("/");
	const searching = stripSgr(component.render(72).join("\n")).replace(/[│\s]+/gu, " ");
	assert.match(searching, /Esc\/Ctrl\+C then F favorite/u, "search state hints the browse route");
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
	assert.match(restored, /Search > q/u, "the query survives the section round trip");
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

test("Enter selects a model and stores it for the project", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-persist-selection-"));
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
		new ModelPickerStore(paths).setFilter("all");
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
		new ModelPickerStore(paths).setFilter("all");
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
	test(`new sessions restore last model thinking unless explicit: ${explicitThinking}`, async () => {
		const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-restore-"));
		try {
			const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
			const projectKey = deriveProjectKey(root);
			new ModelPickerStore(paths).recordDispatch({ provider: "p", modelId: "b" }, projectKey, {
				thinkingLevel: "high",
				now: new Date("2026-08-23T00:00:00.000Z"),
			});
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
				"the recorded thinking level must be restored with the model",
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

	component.handleInput("\u0006");
	// A favorite changes the inventory partition, so the three counts are
	// recomputed and the active query is ranked once more.
	assert.equal(queries.filter((query) => query === "").length, 3, "all three filter counts refresh");
	assert.deepEqual(
		queries.filter((query) => query !== ""),
		["z"],
		"the active query is re-ranked exactly once",
	);
});
