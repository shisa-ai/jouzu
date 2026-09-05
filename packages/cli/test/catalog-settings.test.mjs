import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CatalogSettingsComponent } from "../dist/catalog-settings.js";
import {
	CatalogSourceStore,
	catalogSourceRegistryPath,
	discoverCatalogEndpoint,
	loadCatalogSourceRegistry,
} from "../dist/catalog-sources.js";
import { parseAndValidateModelCatalog } from "../dist/model-catalog.js";
import { loadActiveCatalogForSource, refreshCatalogSource } from "../dist/model-catalog-sync.js";
import { resolveJouzuPaths } from "../dist/paths.js";
import { createSessionUiStyles } from "../dist/session-ui/index.js";
import { acquireStateLock } from "../dist/state-lock.js";
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
	return new Response(JSON.stringify(document, null, 2), {
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
		assert.match(text, /Authentication\s+< Bearer token >/u);
		assert.match(text, /Token variable/u);
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
					text: JSON.stringify(fixture),
					attempts: [],
				};
			},
			refresh: async () => {
				throw new Error("saving must not fetch twice");
			},
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

for (const editing of [false, true]) {
	test(`catalog save remains retryable after activation failure, editing=${editing}`, async () => {
		const { root, paths, context } = setup();
		let release;
		try {
			const url = "https://catalog.example/v1/jouzu/model-catalog";
			const store = new CatalogSourceStore(paths, {});
			if (editing) store.add({ label: "Original", url, enabled: false, auth: { type: "none" } });
			const registry = catalogSourceRegistryPath(paths);
			const before = existsSync(registry) ? readFileSync(registry, "utf8") : undefined;
			let requests = 0;
			const component = new CatalogSettingsComponent({
				context,
				paths,
				env: {},
				discover: (input, options) =>
					discoverCatalogEndpoint(input, {
						...options,
						fetch: async () => {
							requests++;
							return response(fixture);
						},
					}),
				refresh: async () => {
					throw new Error("second request");
				},
			});
			if (editing) {
				component.handleInput("down");
				component.handleInput("enter");
				component.handleInput(" changed");
			} else {
				component.handleInput("a");
				component.handleInput("Catalog");
				component.handleInput("down");
				component.handleInput(url);
			}
			release = acquireStateLock({
				path: join(paths.cacheDir, "model-catalog", createHash("sha256").update(url).digest("hex"), "refresh.lock"),
				describe: "test",
				onBusy: () => new Error("busy"),
			});
			component.handleInput("enter");
			await new Promise((resolve) => setImmediate(resolve));
			assert.match(component.render(100).join("\n"), /busy/);
			assert.equal(existsSync(registry) ? readFileSync(registry, "utf8") : undefined, before);
			release();
			release = undefined;
			component.handleInput("enter");
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(requests, 2, "one discovery request per attempt");
			const sources = loadCatalogSourceRegistry(paths).sources;
			assert.equal(sources.length, 1);
			assert.equal(loadActiveCatalogForSource(paths, sources[0]).revision, fixture.revision);
			assert.equal(sources[0].enabled, !editing);
			const origin = join(paths.cacheDir, "model-catalog", createHash("sha256").update(url).digest("hex"));
			const account = JSON.parse(readFileSync(join(origin, "origin.json"))).activeAccountRefHash;
			const directory = join(origin, "accounts", account);
			const state = JSON.parse(readFileSync(join(directory, "state.json")));
			assert.equal(state.etag, '"fixture"');
			assert.equal(readFileSync(join(directory, state.active.document), "utf8"), JSON.stringify(fixture, null, 2));
			assert.match(component.render(100).join("\n"), /Saved/);
		} finally {
			release?.();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test(`canceling catalog discovery preserves registry bytes, editing=${editing}`, async () => {
		const { root, paths, context } = setup();
		try {
			const url = "https://catalog.example/catalog";
			if (editing) new CatalogSourceStore(paths, {}).add({ label: "Original", url, auth: { type: "none" } });
			const registry = catalogSourceRegistryPath(paths);
			const before = existsSync(registry) ? readFileSync(registry, "utf8") : undefined;
			let finish, signal;
			const component = new CatalogSettingsComponent({
				context,
				paths,
				env: {},
				discover: (_input, options) => {
					signal = options.signal;
					return new Promise((resolve) => {
						finish = resolve;
					});
				},
			});
			if (editing) {
				component.handleInput("down");
				component.handleInput("enter");
			} else {
				component.handleInput("a");
				component.handleInput("Catalog");
				component.handleInput("down");
				component.handleInput(url);
			}
			component.handleInput("enter");
			component.handleInput("escape");
			assert.equal(signal.aborted, true);
			finish({ url, document: fixture, text: JSON.stringify(fixture), attempts: [] });
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(existsSync(registry) ? readFileSync(registry, "utf8") : undefined, before);
			assert.equal(existsSync(join(paths.cacheDir, "model-catalog")), false);
			assert.match(component.render(100).join("\n"), /Catalog save canceled/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
