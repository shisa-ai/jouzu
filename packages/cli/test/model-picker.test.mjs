import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { createJouzuModelPicker, ModelPickerComponent } from "../dist/model-picker.js";
import { resolveJouzuPaths } from "../dist/paths.js";

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
			keybindings: fakeKeybindings(),
			close() {
				calls.close += 1;
			},
		},
		initialRoute: { view: "models" },
		getRows: overrides.getRows ?? (() => rows()),
		onSelect: async (row, persistDefault) => {
			calls.selected.push([row.model.modelId, persistDefault]);
		},
		onToggleFavorite: (row, scope) => {
			calls.favorites.push([row.model.modelId, scope]);
		},
		onRefresh: async () => {},
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

test("Models view selects for the session, supports global selection, favorites, and cancel", async () => {
	const first = createComponent();
	first.component.handleInput("down");
	first.component.handleInput("enter");
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(first.calls.selected, [["fit", false]]);
	assert.equal(first.calls.close, 1);

	const second = createComponent();
	second.component.handleInput("down");
	second.component.handleInput("\x1b\r");
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(second.calls.selected, [["fit", true]]);

	const third = createComponent();
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
	assert.deepEqual(queries, ["", "sonnet"]);
});

test("host handler opens the Jouzu Models component through the Palette surface", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-host-"));
	try {
		const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
		const integration = createJouzuModelPicker(paths);
		const handlers = new Map();
		integration.extension.factory({
			on(name, handler) {
				handlers.set(name, handler);
			},
		});
		const model = { provider: "p", id: "model", name: "Model", contextWindow: 100_000, maxTokens: 10_000 };
		let rendered = "";
		let customOptions;
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
		assert.equal(await integration.handle({ source: "action" }, { setModel: async () => {} }), true);
		assert.match(stripSgr(rendered), /JOUZU · Models/);
		assert.equal(customOptions.overlay, true);
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
