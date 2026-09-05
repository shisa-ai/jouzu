import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CatalogSettingsComponent } from "../dist/catalog-settings.js";
import { CatalogSourceStore, loadCatalogSourceRegistry } from "../dist/catalog-sources.js";
import { parseAndValidateModelCatalog } from "../dist/model-catalog.js";
import { refreshCatalogSource } from "../dist/model-catalog-sync.js";
import { resolveJouzuPaths } from "../dist/paths.js";
import { createSessionUiStyles } from "../dist/session-ui/index.js";
import { terminalTextWidth } from "../dist/terminal-layout.js";

const fixture = parseAndValidateModelCatalog(
	readFileSync(join(import.meta.dirname, "..", "catalog", "fixtures", "account-snapshot-v1.json"), "utf8"),
	{ remote: true },
);

const identityTheme = {
	fg: (_role, value) => value,
	bg: (_role, value) => value,
	bold: (value) => value,
};

function fakeKeybindings(overrides = {}) {
	const keys = {
		"tui.select.cancel": ["escape", "ctrl+c"],
		"tui.select.confirm": ["enter"],
		"tui.select.up": ["up"],
		"tui.select.down": ["down"],
		"tui.select.pageUp": ["pageUp"],
		"tui.select.pageDown": ["pageDown"],
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

function setup(options = {}) {
	const root = mkdtempSync(join(tmpdir(), "jouzu-catalog-settings-"));
	const paths = resolveJouzuPaths({ homeOverride: join(root, "jouzu") });
	const renders = [];
	const closes = [];
	const context = {
		tui: {
			requestRender() {
				renders.push(true);
			},
			terminal: { rows: 32, columns: 100 },
		},
		theme: identityTheme,
		keybindings: options.keybindings ?? fakeKeybindings(),
		styles: createSessionUiStyles(identityTheme),
		close() {
			closes.push(true);
		},
	};
	return { root, paths, context, renders, closes };
}

function response(document) {
	return new Response(JSON.stringify(document), {
		status: 200,
		headers: { "Content-Type": "application/vnd.jouzu.model-catalog+json; version=1", ETag: '"fixture"' },
	});
}

test("Catalogs settings uses Enter to edit and horizontal arrows for model disclosure", async () => {
	const { root, paths, context } = setup();
	try {
		const store = new CatalogSourceStore(paths);
		const source = store.add({
			label: "Office pool",
			url: "http://127.0.0.1:8989/v1/jouzu/model-catalog",
			auth: { type: "none" },
		});
		await refreshCatalogSource(paths, source, { env: {}, fetch: async () => response(fixture) });
		const component = new CatalogSettingsComponent({ context, paths, env: {} });
		component.handleInput("down");
		let rendered = component.render(84);
		assert.match(rendered.join("\n"), /Model Catalogs/u);
		const headerIndex = rendered.findIndex((value) => value.includes("Model Catalogs"));
		const firstEntryIndex = rendered.findIndex((value) => value.includes("Office pool"));
		assert.ok(headerIndex >= 0 && firstEntryIndex > headerIndex, "entries list under the Model Catalogs header");
		assert.match(rendered.join("\n"), /Shisa API/u);
		assert.match(rendered.join("\n"), /Office pool/u);
		assert.match(rendered.join("\n"), /active/u);
		assert.match(rendered.join("\n"), /1 model/u);
		assert.match(rendered.join("\n"), /Enter edit/u);
		assert.ok(rendered.every((line) => terminalTextWidth(line) <= 84));

		component.handleInput("enter");
		rendered = component.render(84);
		assert.match(rendered.join("\n"), /Edit Office pool/u);
		for (const character of " changed") component.handleInput(character);
		component.handleInput("escape");
		assert.equal(new CatalogSourceStore(paths).list().find((entry) => entry.id === source.id).label, "Office pool");

		component.handleInput("\u001b[C");
		rendered = component.render(84);
		assert.match(rendered.join("\n"), /Example Model/u);
		assert.match(rendered.join("\n"), /ai\.example\.gateway\/example-model/u);
		component.handleInput("\u001b[D");
		assert.doesNotMatch(component.render(84).join("\n"), /Example Model/u);
		assert.ok(rendered.every((line) => terminalTextWidth(line) <= 84));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Catalogs settings shows the built-in source and opens the add form with A", () => {
	const { root, paths, context, closes } = setup();
	try {
		const component = new CatalogSettingsComponent({ context, paths, env: {} });
		const listing = component.render(84).join("\n");
		assert.match(listing, /Shisa API · SHISA_API_KEY not set/u);
		assert.doesNotMatch(listing, /Add catalog/u);

		component.handleInput("a");
		assert.match(component.render(84).join("\n"), /Add catalog/u);
		for (const character of "Canceled catalog") component.handleInput(character);
		component.handleInput("escape");
		// Esc closes only the form; the built-in source remains listed.
		assert.equal(closes.length, 0);
		assert.equal(existsSync(join(paths.configDir, "catalogs.json")), false);
		assert.match(component.render(84).join("\n"), /Shisa API/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Catalogs settings disables the code-owned built-in with Space and guards edit and remove", () => {
	const { root, paths, context } = setup();
	try {
		const component = new CatalogSettingsComponent({ context, paths, env: {} });
		const overridesPath = join(paths.configDir, "catalog-overrides.json");

		component.handleInput("enter");
		assert.match(component.render(84).join("\n"), /built-in Jouzu catalog source/u);

		component.handleInput("d");
		assert.match(component.render(84).join("\n"), /built in and cannot be removed/u);

		component.handleInput(" ");
		assert.match(component.render(84).join("\n"), /Shisa API · disabled/u);
		assert.equal(existsSync(overridesPath), true);
		assert.equal(existsSync(join(paths.configDir, "catalogs.json")), false);

		component.handleInput(" ");
		assert.match(component.render(84).join("\n"), /Shisa API · SHISA_API_KEY not set/u);
		assert.equal(existsSync(overridesPath), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Catalogs settings shows complete bearer-token fields and process availability", () => {
	const { root, paths, context } = setup();
	try {
		const env = {};
		const component = new CatalogSettingsComponent({ context, paths, env });
		component.handleInput("a");
		component.handleInput("down");
		component.handleInput("down");
		component.handleInput("\u001b[C");

		let rendered = component.render(84);
		let text = rendered.join("\n");
		const normalized = text.replace(/[│]/gu, " ").replace(/\s+/gu, " ");
		assert.match(text, /Authentication\s+< Bearer token >/u);
		assert.match(text, /Token variable/u);
		assert.match(
			normalized,
			/Enter an environment variable name, not the token\. Set it before launching Jouzu, for example with export NAME=… in ~\/\.bashrc or ~\/\.zshrc\./u,
		);
		assert.match(text, /JOUZU_MODEL_CATALOG_TOKEN is not set in this Jouzu process/u);
		assert.match(text, /Enter save · ↑↓ field · ←→ change/u);
		assert.doesNotMatch(text, /Exact URL|Tab fields|Ctrl\+Enter/u);
		assert.ok(rendered.every((line) => terminalTextWidth(line) <= 84));

		component.handleInput("down");
		assert.match(component.render(84).join("\n"), /→ Token variable/u);
		component.handleInput("up");
		component.handleInput("\u001b[D");
		assert.doesNotMatch(component.render(84).join("\n"), /Token variable/u);
		component.handleInput("\u001b[C");

		env.JOUZU_MODEL_CATALOG_TOKEN = "must-not-render";
		rendered = component.render(84);
		text = rendered.join("\n");
		assert.match(text, /JOUZU_MODEL_CATALOG_TOKEN is set in this Jouzu process/u);
		assert.doesNotMatch(text, /must-not-render/u);

		const narrowRendered = component.render(48);
		const narrowText = narrowRendered.join("\n").replace(/[│]/gu, " ").replace(/\s+/gu, " ");
		assert.ok(narrowRendered.every((line) => terminalTextWidth(line) <= 48));
		assert.match(narrowText, /Enter an environment variable name/u);
		assert.match(narrowText, /Its value is never saved/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Catalogs settings hints render effective semantic bindings", () => {
	const { root, paths, context } = setup({
		keybindings: fakeKeybindings({
			"tui.select.confirm": ["ctrl+s"],
			"tui.select.cancel": ["alt+x"],
			"tui.select.up": ["k"],
			"tui.select.down": ["j"],
		}),
	});
	try {
		const component = new CatalogSettingsComponent({ context, paths, env: {} });
		component.handleInput("a");
		const rendered = component.render(72).join("\n");
		assert.match(rendered, /Ctrl\+S save/u);
		assert.match(rendered, /K\/J field/u);
		assert.ok(rendered.includes(`${process.platform === "darwin" ? "Option" : "Alt"}+X cancel`));
		assert.doesNotMatch(rendered, /Enter save|Esc cancel|↑↓ field/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Catalogs settings wraps save errors without hiding authentication guidance", async () => {
	const { root, paths, context } = setup();
	try {
		const component = new CatalogSettingsComponent({
			context,
			paths,
			env: {},
			discover: async () => {
				throw new Error(
					"Catalog authentication failed (HTTP 401). Check that CODEX_POOL_CATALOG_TOKEN is exported before Jouzu starts and contains a valid bearer token.",
				);
			},
		});
		component.handleInput("a");
		for (const character of "Office pool") component.handleInput(character);
		component.handleInput("down");
		for (const character of "catalog.example") component.handleInput(character);
		component.handleInput("enter");
		await new Promise((resolve) => setImmediate(resolve));

		const rendered = component.render(52);
		const text = rendered.join(" ");
		assert.match(text, /Catalog authentication failed \(HTTP 401\)/u);
		assert.match(text, /CODEX_POOL_CATALOG_TOKEN/u);
		assert.match(text, /contains a valid bearer token/u);
		assert.ok(rendered.every((line) => terminalTextWidth(line) <= 52));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Catalogs settings saves a label and discovered conventional endpoint", async () => {
	const { root, paths, context } = setup();
	try {
		const discoveries = [];
		const component = new CatalogSettingsComponent({
			context,
			paths,
			env: {},
			discover: async (input, options) => {
				discoveries.push({ input, auth: options.auth });
				return {
					url: "http://127.0.0.1:8989/v1/jouzu/model-catalog",
					document: fixture,
					attempts: [],
				};
			},
			refresh: async (_paths, source) => ({
				status: "activated",
				catalogStatus: {
					schemaVersion: 1,
					status: "active",
					configured: true,
					sourceId: source.id,
					label: source.label,
					enabled: true,
					endpoint: source.url,
					offeringCount: 1,
					quarantined: 0,
				},
			}),
		});
		component.handleInput("a");
		for (const character of "Local catalog") component.handleInput(character);
		component.handleInput("down");
		for (const character of "127.0.0.1:8989") component.handleInput(character);
		component.handleInput("enter");
		await new Promise((resolve) => setImmediate(resolve));

		assert.deepEqual(discoveries, [{ input: "127.0.0.1:8989", auth: { type: "none" } }]);
		const saved = loadCatalogSourceRegistry(paths).sources;
		assert.equal(saved.length, 1);
		assert.equal(saved[0].label, "Local catalog");
		assert.equal(saved[0].url, "http://127.0.0.1:8989/v1/jouzu/model-catalog");
		assert.match(component.render(84).join("\n"), /Saved Local catalog with 1 model/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
