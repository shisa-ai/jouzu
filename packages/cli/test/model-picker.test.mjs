import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { createJouzuModelPicker, ModelPickerComponent } from "../dist/model-picker.js";
import { deriveProjectKey, ModelPickerStore } from "../dist/model-picker-state.js";
import { resolveJouzuPaths } from "../dist/paths.js";
import { createSessionUiStyles } from "../dist/session-ui/index.js";

const identityTheme = {
	fg: (_role, value) => value,
	bg: (_role, value) => value,
	bold: (value) => value,
};

function stripSgr(value) {
	return value
		.split("\u001b")
		.map((segment, index) => (index === 0 ? segment : segment.replace(/^\[[0-9;]*m/, "")))
		.join("");
}

function fakeKeybindings() {
	return {
		matches(data, action) {
			return (
				(action === "tui.select.down" && data === "down") ||
				(action === "tui.select.up" && data === "up") ||
				(action === "tui.select.confirm" && data === "enter") ||
				(action === "tui.select.cancel" && data === "escape")
			);
		},
	};
}

function rows() {
	return [
		{
			section: "current",
			model: { provider: "small", modelId: "tiny", name: "Tiny", contextWindow: 1000, maxTokens: 100, available: true },
			contextFit: "too-small",
			favoriteScopes: [],
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
			favoriteScopes: [],
			projectDefault: false,
			rank: 1,
		},
	];
}

function createComponent(overrides = {}) {
	const calls = { close: 0, selected: [], favorites: [], renders: 0 };
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
			keybindings: fakeKeybindings(),
			close() {
				calls.close += 1;
			},
		},
		initialRoute: { view: "models" },
		getRows: overrides.getRows ?? (() => rows()),
		onSelect: async (row, scope) => {
			calls.selected.push([row.model.modelId, scope]);
		},
		onToggleFavorite: (row, scope) => {
			calls.favorites.push([row.model.modelId, scope]);
		},
	});
	return { component, calls };
}

test("Models view renders within width and blocks a context that cannot fit", async () => {
	const { component, calls } = createComponent();
	const rendered = component.render(72);
	assert.ok(rendered.length > 8);
	assert.ok(rendered.every((line) => visibleWidth(line) === 72));
	assert.match(stripSgr(rendered[0]), /JOUZU · Models/);
	assert.match(rendered.join("\n"), /small\/tiny/);
	assert.match(rendered.join("\n"), /large\/fit/);

	component.handleInput("enter");
	await Promise.resolve();
	assert.deepEqual(calls.selected, []);
	assert.equal(calls.close, 0);
	assert.match(component.render(72).join("\n"), /does not fit/);
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
					favoriteScopes: [],
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
	third.component.handleInput("\t");
	third.component.handleInput("\x1b[Z");
	third.component.handleInput("down");
	third.component.handleInput("\x06");
	third.component.handleInput("\x1bf");
	assert.deepEqual(third.calls.favorites, [
		["fit", "global"],
		["fit", "project"],
	]);
	third.component.handleInput("escape");
	assert.equal(third.calls.close, 1);
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

test("Jouzu editor wrapper opens the Models component through the Palette surface", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-host-"));
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
		const model = { provider: "p", id: "model", name: "Model", contextWindow: 100_000, maxTokens: 10_000 };
		let rendered = "";
		let customOptions;
		let refreshCalls = 0;
		const ctx = {
			mode: "tui",
			cwd: root,
			model,
			scopedModels: [],
			sessionManager: { getBranch: () => [] },
			modelRegistry: {
				getAvailable: () => [model],
				refresh: async () => {
					refreshCalls += 1;
					return { errors: new Map() };
				},
				find: () => model,
			},
			getContextUsage: () => ({ tokens: 100, contextWindow: 100_000, percent: 1 }),
			isIdle: () => true,
			ui: {
				notify() {},
				custom(factory, options) {
					customOptions = options;
					return new Promise((resolve) => {
						const component = factory(
							{ terminal: { rows: 30 }, requestRender() {} },
							identityTheme,
							fakeKeybindings(),
							resolve,
						);
						rendered = component.render(72).join("\n");
						queueMicrotask(() => component.handleInput("escape"));
					});
				},
			},
		};
		await handlers.get("session_start")({}, ctx);
		assert.equal(await integration.open({ source: "action" }), true);
		assert.match(stripSgr(rendered), /JOUZU · Models/);
		assert.equal(customOptions.overlay, true);
		assert.equal(refreshCalls, 0, "opening the Palette must use the cached local inventory");
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

	// Cycling filters re-ranks the active list but does not disturb the counts.
	queries.length = 0;
	component.handleInput("\t");
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
	queries.length = 0;

	component.handleInput("\x06");
	// A favorite changes the inventory partition, so the three counts are
	// recomputed and the active query is ranked once more.
	assert.equal(queries.filter((query) => query === "").length, 3, "all three filter counts refresh");
	assert.deepEqual(
		queries.filter((query) => query !== ""),
		["z"],
		"the active query is re-ranked exactly once",
	);
});
