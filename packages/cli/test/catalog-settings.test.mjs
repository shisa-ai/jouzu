import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CatalogSettingsComponent } from "../dist/catalog-settings.js";
import {
	CatalogSourceStore,
	catalogSourceRegistryPath,
	discoverCatalogEndpoint,
	getCatalogSourceToken,
	loadCatalogSourceRegistry,
	setCatalogSourceToken,
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

/** Row budget the floating palette overlay grants a component: 82% of rows minus its margin. */
function overlayBudget(rows) {
	return Math.min(Math.floor(rows * 0.82), rows - 2);
}

function selectedLine(rendered) {
	// With the identity theme the selection marker leads the framed row; key-bar
	// hints never do (they lead with a space and the key name).
	return rendered.find((value) => value.slice(2).startsWith("→ "));
}

const fixtureRaw = JSON.parse(
	readFileSync(join(import.meta.dirname, "..", "catalog", "fixtures", "account-snapshot-v1.json"), "utf8"),
);

const manyModelsFixture = parseAndValidateModelCatalog(
	JSON.stringify({
		...fixtureRaw,
		modelOfferings: Array.from({ length: 30 }, (_, index) => ({
			...fixtureRaw.modelOfferings[0],
			id: `ai.example.gateway/model-${index}`,
			modelId: `model-${index}`,
			name: `Example Model ${index}`,
		})),
	}),
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
			terminal: { rows: options.rows ?? 32, columns: options.columns ?? 100 },
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

test("plain HTTP catalog URLs save with a plain-text token warning", () => {
	const { root, paths, context } = setup();
	try {
		const store = new CatalogSourceStore(paths);
		const insecure = store.add({ label: "Insecure pool", url: "http://example.test/catalog", auth: { type: "none" } });
		const local = store.add({ label: "Local pool", url: "http://127.0.0.1:8989/catalog", auth: { type: "none" } });
		const component = new CatalogSettingsComponent({ context, paths, env: {} });

		// Sources list: the built-in Shisa API (HTTPS) carries no warning; the plain-HTTP
		// source warns only while selected, next to its URL.
		assert.doesNotMatch(component.render(84).join("\n"), /plain text/u);
		component.handleInput("down");
		let rendered = component.render(84).join("\n");
		assert.match(rendered, /Insecure pool/u);
		assert.match(rendered, /Warning: This catalog uses HTTP/u);
		assert.match(rendered, /plain text/u);
		assert.ok(component.render(84).every((line) => terminalTextWidth(line) <= 84));
		component.handleInput("down");
		assert.doesNotMatch(component.render(84).join("\n"), /plain text/u);

		// Add form: the warning appears live once the URL field holds a plain-HTTP endpoint.
		component.handleInput("a");
		for (const character of "Cleartext pool") component.handleInput(character);
		component.handleInput("down");
		for (const character of "http://example.test/other") component.handleInput(character);
		rendered = component.render(84).join("\n");
		assert.match(rendered, /URL or host/u);
		assert.match(rendered, /Warning: This catalog uses HTTP/u);
		assert.ok(component.render(84).every((line) => terminalTextWidth(line) <= 84));

		assert.equal(insecure.url, "http://example.test/catalog");
		assert.equal(local.url, "http://127.0.0.1:8989/catalog");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Catalogs settings shows the built-in source and opens the add form with A", () => {
	const { root, paths, context, closes } = setup();
	try {
		const component = new CatalogSettingsComponent({ context, paths, env: {} });
		const listing = component.render(84).join("\n");
		assert.match(listing, /Shisa API\s+SHISA_API_KEY not set/u);
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
		assert.match(component.render(84).join("\n"), /Shisa API\s+disabled/u);
		assert.equal(existsSync(overridesPath), true);
		assert.equal(existsSync(join(paths.configDir, "catalogs.json")), false);

		component.handleInput(" ");
		assert.match(component.render(84).join("\n"), /Shisa API\s+SHISA_API_KEY not set/u);
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
		assert.match(text, /Authentication\s+‹ Bearer token ›/u);
		assert.match(text, /Token variable/u);
		assert.match(text, /JOUZU_MODEL_CATALOG_TOKEN is not set in this Jouzu process/u);
		assert.match(text, /Enter save\s+↑↓ field\s+←→ change/u);
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

test("a bearer source saves with an unset token variable and warns instead of blocking", async () => {
	const { root, paths, context } = setup();
	try {
		let discoveries = 0;
		const component = new CatalogSettingsComponent({
			context,
			paths,
			env: {},
			discover: async () => {
				discoveries += 1;
				throw new Error("discovery must not run without a usable token");
			},
		});
		component.handleInput("a");
		for (const character of "Office pool") component.handleInput(character);
		component.handleInput("down");
		for (const character of "catalog.example") component.handleInput(character);
		component.handleInput("down");
		component.handleInput("\u001b[C");
		component.handleInput("enter");
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(discoveries, 0, "no unauthenticated request is sent");
		const saved = loadCatalogSourceRegistry(paths).sources;
		assert.equal(saved.length, 1);
		assert.equal(saved[0].label, "Office pool");
		// No request means no conventional-path discovery: the exact URL is saved.
		assert.equal(saved[0].url, "https://catalog.example/");
		assert.equal(saved[0].auth.type, "bearer");
		const text = component.render(84).join("\n");
		assert.match(text, /Saved Office pool without checking the catalog/u);
		assert.match(text, /JOUZU_MODEL_CATALOG_TOKEN is not set/u);
		assert.match(text, /press R to refresh/u);
		// The summary and the selected detail both carry the missing-token warning.
		assert.match(text, /Office pool\s+JOUZU_MODEL_CATALOG_TOKEN not set/u);
		assert.match(text, /Warning: token variable JOUZU_MODEL_CATALOG_TOKEN is not set/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("entering a token directly saves it masked and activates the catalog", async () => {
	const { root, paths, context } = setup();
	try {
		let seenBearerToken;
		const component = new CatalogSettingsComponent({
			context,
			paths,
			env: {},
			discover: async (_input, options) => {
				seenBearerToken = options.bearerToken;
				return {
					url: "https://catalog.example/v1/jouzu/model-catalog",
					document: fixture,
					text: JSON.stringify(fixture),
					attempts: [],
				};
			},
		});
		component.handleInput("a");
		for (const character of "Office pool") component.handleInput(character);
		component.handleInput("down");
		for (const character of "catalog.example") component.handleInput(character);
		component.handleInput("down");
		component.handleInput("\u001b[C");
		component.handleInput("down");
		// Replace the default variable name: cursor to the end, clear, type the new one.
		component.handleInput("\x05");
		component.handleInput("\x15");
		for (const character of "CODEX_POOL_CATALOG_TOKEN") component.handleInput(character);
		component.handleInput("down");
		for (const character of "sk-direct-entry") component.handleInput(character);
		// The typed token never renders: the field shows bullets only.
		assert.doesNotMatch(component.render(84).join("\n"), /sk-direct-entry/u);
		assert.match(component.render(84).join("\n"), /\u2022{6,}/u);
		component.handleInput("enter");
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(seenBearerToken, "sk-direct-entry");
		assert.equal(getCatalogSourceToken(paths, "office-pool"), "sk-direct-entry");
		assert.doesNotMatch(
			readFileSync(join(paths.configDir, "catalogs.json"), "utf8"),
			/sk-direct-entry/u,
			"the registry never stores the token value",
		);
		const rendered = component.render(84).join("\n");
		assert.doesNotMatch(rendered, /sk-direct-entry/u);
		assert.match(rendered, /Saved Office pool with 1 model/u);
		const wide = component.render(160).join("\n");
		assert.ok(wide.includes("CODEX_POOL_CATALOG_TOKEN not set, saved token in use"), wide);
		assert.equal(
			loadActiveCatalogForSource(paths, loadCatalogSourceRegistry(paths).sources[0]).revision,
			fixture.revision,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a set environment variable takes precedence over an entered token", async () => {
	const { root, paths, context } = setup();
	try {
		let seenBearerToken;
		const component = new CatalogSettingsComponent({
			context,
			paths,
			env: { JOUZU_MODEL_CATALOG_TOKEN: "sk-from-env" },
			discover: async (_input, options) => {
				seenBearerToken = options.bearerToken;
				return {
					url: "https://catalog.example/v1/jouzu/model-catalog",
					document: fixture,
					text: JSON.stringify(fixture),
					attempts: [],
				};
			},
		});
		component.handleInput("a");
		for (const character of "Office pool") component.handleInput(character);
		component.handleInput("down");
		for (const character of "catalog.example") component.handleInput(character);
		component.handleInput("down");
		component.handleInput("\u001b[C");
		component.handleInput("down");
		component.handleInput("down");
		for (const character of "sk-direct-entry") component.handleInput(character);
		component.handleInput("enter");
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(seenBearerToken, "sk-from-env");
		assert.equal(getCatalogSourceToken(paths, "office-pool"), "sk-direct-entry");
		const message = component.render(84).join("\n");
		assert.match(message, /JOUZU_MODEL_CATALOG_TOKEN is set in this Jouzu/u);
		assert.match(message, /takes precedence over the saved token/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a saved token refreshes its source without the environment variable", async () => {
	const { root, paths } = setup();
	try {
		const store = new CatalogSourceStore(paths, { env: {} });
		const source = store.add({
			label: "Office pool",
			url: "https://catalog.example/v1/jouzu/model-catalog",
			auth: { type: "bearer", credentialRef: "env:OFFICE_POOL_TOKEN" },
		});
		setCatalogSourceToken(paths, source.id, "sk-saved");
		const result = await refreshCatalogSource(paths, source, {
			env: {},
			fetch: async () => response(fixture),
		});
		assert.equal(result.status, "activated");
		assert.equal(result.catalogStatus.credentialStored, true);
		assert.equal(result.catalogStatus.credentialEnv, false);
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

test("Catalogs view keeps the selected row and footer inside the overlay budget with many sources", () => {
	const { root, paths, context } = setup({ rows: 20 });
	try {
		const store = new CatalogSourceStore(paths);
		for (let index = 0; index < 12; index += 1) {
			store.add({ label: `Pool ${index}`, url: `https://pool${index}.example/catalog`, auth: { type: "none" } });
		}
		const component = new CatalogSettingsComponent({ context, paths, env: {} });
		const budget = overlayBudget(20);
		const labels = ["Shisa API", ...Array.from({ length: 12 }, (_, index) => `Pool ${index}`)];
		for (let step = 0; step < labels.length; step += 1) {
			const rendered = component.render(84);
			assert.ok(rendered.length <= budget, `render stays within ${budget} rows at step ${step}`);
			assert.match(rendered.join("\n"), /Model Catalogs/u);
			assert.match(rendered.join("\n"), /Enter edit/u, "footer key bar stays visible");
			const marker = selectedLine(rendered);
			assert.ok(marker?.includes(labels[step]), `selected row ${labels[step]} stays visible at step ${step}`);
			assert.ok(rendered.every((line) => terminalTextWidth(line) <= 84));
			component.handleInput("down");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Catalogs view renders mixed-width labels and transport warnings within 48 columns", () => {
	const { root, paths, context } = setup({ rows: 24 });
	try {
		const store = new CatalogSourceStore(paths);
		store.add({ label: "オフィスモデルプール", url: "http://example.test/catalog", auth: { type: "none" } });
		const component = new CatalogSettingsComponent({ context, paths, env: {} });
		component.handleInput("down");
		const budget = overlayBudget(24);
		const rendered = component.render(48);
		assert.ok(rendered.length <= budget, `render stays within ${budget} rows`);
		assert.ok(
			rendered.every((line) => terminalTextWidth(line) <= 48),
			"every line fits 48 columns",
		);
		assert.match(rendered.join("\n"), /Warning: This catalog uses HTTP/u);
		assert.ok(selectedLine(rendered)?.includes("オフィスモデルプール"), "mixed-width label stays readable");
		assert.match(rendered.join("\n"), /Enter edit/u, "footer key bar stays visible");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Bearer form keeps the transport warning and footer inside the budget on a short terminal", async () => {
	const { root, paths, context } = setup({ rows: 20 });
	try {
		const component = new CatalogSettingsComponent({
			context,
			paths,
			env: { JOUZU_MODEL_CATALOG_TOKEN: "set" },
			discover: async () => {
				throw new Error(
					"Catalog authentication failed (HTTP 401). Check that the token variable is exported before Jouzu starts and contains a valid bearer token.",
				);
			},
		});
		const budget = overlayBudget(20);
		component.handleInput("a");
		for (const character of "Cleartext pool") component.handleInput(character);
		component.handleInput("down");
		for (const character of "http://example.test/other") component.handleInput(character);
		component.handleInput("down");
		component.handleInput("\u001b[C");
		let rendered = component.render(52);
		assert.ok(rendered.length <= budget, `form render stays within ${budget} rows`);
		assert.match(rendered.join("\n"), /Warning: This catalog uses HTTP/u, "transport warning stays visible");
		assert.match(rendered.join("\n"), /Token variable/u);
		assert.match(rendered.join("\n"), /Enter save/u, "footer key bar stays visible");
		assert.match(selectedLine(rendered) ?? "", /Authentication/u, "focused field stays marked");

		component.handleInput("down");
		rendered = component.render(52);
		assert.ok(rendered.length <= budget);
		assert.match(selectedLine(rendered) ?? "", /Token variable/u, "credential field can take focus");

		component.handleInput("enter");
		await new Promise((resolve) => setImmediate(resolve));
		rendered = component.render(52);
		assert.ok(rendered.length <= budget, `failed-save render stays within ${budget} rows`);
		assert.match(rendered.join("\n"), /Warning: This catalog uses HTTP/u, "transport warning survives the error");
		assert.match(rendered.join("\n"), /Catalog authentication failed \(HTTP 401\)/u);
		assert.match(rendered.join("\n"), /Enter save/u, "footer key bar survives the error");
		assert.ok(rendered.every((line) => terminalTextWidth(line) <= 52));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Expanding a source pages its offerings inside the overlay budget", async () => {
	const { root, paths, context } = setup({ rows: 24 });
	try {
		const store = new CatalogSourceStore(paths);
		const source = store.add({
			label: "Paged pool",
			url: "https://paged.example/v1/jouzu/model-catalog",
			auth: { type: "none" },
		});
		await refreshCatalogSource(paths, source, { env: {}, fetch: async () => response(manyModelsFixture) });
		const component = new CatalogSettingsComponent({ context, paths, env: {} });
		component.handleInput("down");
		component.handleInput("\u001b[C");
		const budget = overlayBudget(24);
		let rendered = component.render(84);
		assert.ok(rendered.length <= budget, `expanded render stays within ${budget} rows`);
		assert.match(rendered.join("\n"), /Example Model 0/u);
		// The context ceiling row spends one body row, so each page holds one fewer model.
		assert.match(rendered.join("\n"), /1-7\/30/u, "paging hint names the visible window");
		assert.match(rendered.join("\n"), /Maximum context/u, "context ceiling row stays visible");
		assert.ok(selectedLine(rendered)?.includes("Paged pool"), "selected source row stays visible while expanded");
		assert.match(rendered.join("\n"), /Enter edit/u, "footer key bar stays visible while expanded");

		component.handleInput("pageDown");
		rendered = component.render(84);
		assert.ok(rendered.length <= budget);
		assert.match(rendered.join("\n"), /8-14\/30/u);

		component.handleInput("pageDown");
		rendered = component.render(84);
		assert.ok(rendered.length <= budget);
		assert.match(rendered.join("\n"), /15-21\/30/u);

		component.handleInput("pageDown");
		rendered = component.render(84);
		assert.ok(rendered.length <= budget);
		assert.match(rendered.join("\n"), /22-28\/30/u);

		component.handleInput("pageDown");
		rendered = component.render(84);
		assert.ok(rendered.length <= budget);
		assert.match(rendered.join("\n"), /24-30\/30/u, "paging clamps at the end of the catalog");

		component.handleInput("pageDown");
		assert.match(component.render(84).join("\n"), /24-30\/30/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Paging steps by the rendered capacity so every offering stays reachable", async () => {
	const { root, paths, context } = setup({ rows: 20 });
	try {
		const store = new CatalogSourceStore(paths);
		const source = store.add({
			label: "Paged pool",
			url: "https://paged.example/v1/jouzu/model-catalog",
			auth: { type: "none" },
		});
		await refreshCatalogSource(paths, source, { env: {}, fetch: async () => response(manyModelsFixture) });
		const component = new CatalogSettingsComponent({ context, paths, env: {} });
		component.handleInput("down");
		component.handleInput("\u001b[C");
		const budget = overlayBudget(20);
		// The 20-row budget leaves room for a four-row page once the context ceiling
		// row is counted; paging must follow the page size, not skip it.
		const windows = ["1-4/30", "5-8/30", "9-12/30", "13-16/30", "17-20/30", "21-24/30", "25-28/30", "27-30/30"];
		for (const [step, window] of windows.entries()) {
			const rendered = component.render(84);
			assert.ok(rendered.length <= budget, `render stays within ${budget} rows at window ${window}`);
			assert.ok(rendered.join("\n").includes(window), `window ${step} (${window}) shown`);
			assert.match(rendered.join("\n"), /Maximum context/u, "context ceiling row stays visible");
			assert.match(rendered.join("\n"), /Enter edit/u, "footer stays visible");
			if (step < windows.length - 1) component.handleInput("pageDown");
		}
		// Every offering appeared exactly once across the windows: no gaps, no
		// silently skipped rows.
		const seen = new Set(
			component
				.render(84)
				.join("\n")
				.match(/model-\d+/gu) ?? [],
		);
		assert.equal(seen.size, 4);
		component.handleInput("pageUp");
		assert.match(component.render(84).join("\n"), /23-26\/30/u, "pageUp walks back one full window");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Expansion survives moving the selection and pages the sticky source by capacity", async () => {
	const { root, paths, context } = setup({ rows: 20 });
	try {
		const store = new CatalogSourceStore(paths);
		const source = store.add({
			label: "Paged pool",
			url: "https://paged.example/v1/jouzu/model-catalog",
			auth: { type: "none" },
		});
		await refreshCatalogSource(paths, source, { env: {}, fetch: async () => response(manyModelsFixture) });
		const component = new CatalogSettingsComponent({ context, paths, env: {} });
		const budget = overlayBudget(20);
		component.handleInput("down");
		component.handleInput("\u001b[C");
		component.handleInput("up");
		let rendered = component.render(84);
		assert.ok(rendered.length <= budget, "sticky expansion stays within the budget");
		assert.ok(selectedLine(rendered)?.includes("Shisa API"), "selection moved to the built-in source");
		assert.match(rendered.join("\n"), /1-2\/30/u, "sticky source keeps a paged window");
		assert.match(rendered.join("\n"), /Maximum context/u, "context ceiling row stays visible");
		assert.match(rendered.join("\n"), /Enter edit/u, "footer stays visible");

		component.handleInput("pageDown");
		rendered = component.render(84);
		assert.ok(rendered.length <= budget);
		assert.match(rendered.join("\n"), /3-4\/30/u, "sticky paging advances by the rendered capacity");
		assert.doesNotMatch(rendered.join("\n"), /1-2\/30/u, "no overlapping re-show of the first window");

		component.handleInput("\u001b[D");
		assert.doesNotMatch(component.render(84).join("\n"), /Example Model/u, "left collapses the expansion");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A long failure message keeps its status and pages every recovery line", async () => {
	const { root, paths, context } = setup({ rows: 24 });
	try {
		const detail =
			"Catalog authentication failed (HTTP 401). Check that the token variable is exported before Jouzu starts and contains a valid bearer token. Ask the catalog operator for a current token, or point JOUZU_MODEL_CATALOG_TOKEN at a variable that holds one.";
		const component = new CatalogSettingsComponent({
			context,
			paths,
			env: { JOUZU_MODEL_CATALOG_TOKEN: "set" },
			discover: async () => {
				throw new Error(`${detail} ${detail}`);
			},
		});
		const budget = overlayBudget(24);
		component.handleInput("a");
		for (const character of "Cleartext pool") component.handleInput(character);
		component.handleInput("down");
		for (const character of "http://example.test/other") component.handleInput(character);
		component.handleInput("down");
		component.handleInput("\u001b[C");
		component.handleInput("enter");
		await new Promise((resolve) => setImmediate(resolve));
		const rendered = component.render(48);
		assert.ok(rendered.length <= budget, `render stays within ${budget} rows`);
		assert.match(rendered.join("\n"), /Catalog authentication failed \(HTTP 401\)/u, "status line kept");
		assert.match(rendered.join("\n"), /1-\d+\/\d+/u, "message paging is visible");
		const messages = rendered.join("\n");
		let pages = messages;
		for (let index = 0; index < 30; index++) {
			component.handleInput("pageDown");
			const page = component.render(48);
			assert.ok(page.length <= budget);
			pages += page.join("\n");
		}
		assert.match(pages, /holds one\./u, "the last recovery instruction remains reachable");
		component.handleInput("pageUp");
		assert.ok(component.render(48).length <= budget);
		assert.match(rendered.join("\n"), /Warning: This catalog uses HTTP/u, "transport warning kept");
		assert.match(rendered.join("\n"), /Enter save/u, "footer kept");
		assert.match(rendered.join("\n"), /Token variable/u, "bearer field kept");
		assert.ok(rendered.every((value) => terminalTextWidth(value) <= 48));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Short HTTP forms keep each focused field and page failures without clipping", async () => {
	const { root, paths, context } = setup({ rows: 16 });
	try {
		const component = new CatalogSettingsComponent({
			context,
			paths,
			env: { JOUZU_MODEL_CATALOG_TOKEN: "set" },
			discover: async () => {
				throw new Error(`Authentication failed. ${"Detailed recovery instruction. ".repeat(20)}END-RECOVERY`);
			},
		});
		component.handleInput("a");
		component.handleInput("down");
		for (const character of "http://example.test/other") component.handleInput(character);
		component.handleInput("down");
		component.handleInput("\u001b[C");
		component.handleInput("enter");
		await new Promise((resolve) => setImmediate(resolve));
		for (const field of ["Authentication", "Token variable", "Token", "Label", "URL or host"]) {
			const lines = component.render(48);
			assert.ok(lines.length <= overlayBudget(16), lines.join("\n"));
			assert.match(selectedLine(lines) ?? "", new RegExp(field));
			assert.match(lines.join("\n"), /Warning: This catalog uses HTTP/u);
			assert.match(lines.join("\n"), /Authentication failed/u);
			assert.match(lines.join("\n"), /Enter save/u);
			component.handleInput("down");
		}
		let pages = "";
		for (let index = 0; index < 50; index++) {
			const lines = component.render(48);
			assert.ok(lines.length <= overlayBudget(16));
			pages += lines.join("\n");
			component.handleInput("pageDown");
		}
		assert.match(pages, /END-RECOVERY/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("At the 16-row floating floor the sources view keeps warning, selection, and footer", () => {
	const { root, paths, context } = setup({ rows: 16 });
	try {
		const store = new CatalogSourceStore(paths);
		store.add({ label: "Insecure pool", url: "http://example.test/catalog", auth: { type: "none" } });
		const component = new CatalogSettingsComponent({ context, paths, env: {} });
		component.handleInput("down");
		const budget = overlayBudget(16);
		const rendered = component.render(48);
		assert.ok(rendered.length <= budget, `render stays within ${budget} rows`);
		assert.match(rendered.join("\n"), /Warning: This catalog uses HTTP/u, "full transport warning kept");
		assert.ok(selectedLine(rendered)?.includes("Insecure pool"), "selected row kept");
		assert.match(rendered.join("\n"), /Enter edit/u, "footer kept");
		assert.ok(rendered.every((value) => terminalTextWidth(value) <= 48));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("At the 16-row floating floor the bearer form keeps the warning, focus, and footer", () => {
	const { root, paths, context } = setup({ rows: 16 });
	try {
		const component = new CatalogSettingsComponent({ context, paths, env: {} });
		const budget = overlayBudget(16);
		component.handleInput("a");
		for (const character of "Cleartext pool") component.handleInput(character);
		component.handleInput("down");
		for (const character of "http://example.test/other") component.handleInput(character);
		component.handleInput("down");
		component.handleInput("\u001b[C");
		const rendered = component.render(48);
		assert.ok(rendered.length <= budget, `render stays within ${budget} rows`);
		assert.match(rendered.join("\n"), /Warning: This catalog uses HTTP/u, "full transport warning kept");
		assert.match(rendered.join("\n"), /Enter save/u, "footer kept");
		assert.match(selectedLine(rendered) ?? "", /Authentication/u, "focused field kept");
		assert.ok(rendered.every((value) => terminalTextWidth(value) <= 48));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Expanded HTTP sources keep reachable offerings at the 16-row floor", async () => {
	const { root, paths, context } = setup({ rows: 16 });
	try {
		const store = new CatalogSourceStore(paths);
		const source = store.add({
			label: "Insecure pool",
			url: "http://example.test/catalog",
			auth: { type: "none" },
		});
		await refreshCatalogSource(paths, source, { env: {}, fetch: async () => response(manyModelsFixture) });
		const component = new CatalogSettingsComponent({ context, paths, env: {} });
		const budget = overlayBudget(16);
		component.handleInput("down");
		component.handleInput("\u001b[C");
		let rendered = component.render(48);
		assert.ok(rendered.length <= budget, `render stays within ${budget} rows`);
		assert.match(rendered.join("\n"), /model-0/u, "the first offering of the expansion is visible");
		component.handleInput("pageDown");
		rendered = component.render(48);
		assert.ok(rendered.length <= budget);
		assert.match(rendered.join("\n"), /model-1/u, "paging advances to the next offering");
		assert.match(rendered.join("\n"), /Warning: This catalog uses HTTP/u, "the transport warning stays visible");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Long source labels leave the status column readable", async () => {
	const { root, paths, context } = setup({ rows: 24 });
	try {
		const store = new CatalogSourceStore(paths);
		const source = store.add({
			label: "X".repeat(64),
			url: "https://example.test/catalog",
			auth: { type: "none" },
		});
		await refreshCatalogSource(paths, source, { env: {}, fetch: async () => response(fixture) });
		const component = new CatalogSettingsComponent({ context, paths, env: {} });
		for (const width of [48, 80]) {
			const rendered = component.render(width);
			const row = rendered.find((value) => value.includes("XXXX"));
			assert.ok(row, "the selected row renders");
			assert.match(row, /active/u, "the status stays readable beside a long label");
			assert.ok(rendered.every((value) => terminalTextWidth(value) <= width));
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("The context ceiling row steps through presets, persists, and notifies the host", () => {
	const { root, paths, context } = setup();
	try {
		let changes = 0;
		const component = new CatalogSettingsComponent({
			context,
			paths,
			env: {},
			onCatalogsChanged: () => {
				changes += 1;
			},
		});
		let rendered = component.render(84);
		assert.match(rendered.join("\n"), /Maximum context\s+‹ Off ›/u, "the ceiling starts off");

		// Up from the first source row moves focus onto the ceiling; arrows step it.
		component.handleInput("up");
		rendered = component.render(84);
		assert.match(selectedLine(rendered) ?? "", /Maximum context/u, "the ceiling row takes the selection marker");
		assert.match(rendered.join("\n"), /←→ context limit/u, "the key bar names the ceiling keys");

		component.handleInput("\u001b[C");
		rendered = component.render(84);
		assert.match(rendered.join("\n"), /‹ 128K ›/u);
		assert.equal(changes, 1, "a change asks the host to recompose provider models");
		assert.deepEqual(JSON.parse(readFileSync(join(paths.configDir, "context-policy.json"), "utf8")), {
			schemaVersion: 1,
			maxContextTokens: 128_000,
		});

		component.handleInput("\u001b[C");
		rendered = component.render(84);
		assert.match(rendered.join("\n"), /‹ 192K ›/u);

		component.handleInput("\u001b[D");
		rendered = component.render(84);
		assert.match(rendered.join("\n"), /‹ 128K ›/u, "left steps back down the ladder");

		component.handleInput("\u001b[D");
		rendered = component.render(84);
		assert.match(rendered.join("\n"), /‹ Off ›/u);
		assert.equal(existsSync(join(paths.configDir, "context-policy.json")), false, "off removes the stored policy");
		assert.equal(changes, 4);

		// Down returns to the source list and the arrows disclose models again.
		component.handleInput("down");
		rendered = component.render(84);
		assert.ok(selectedLine(rendered)?.includes("Shisa API"), "down returns the selection to the sources");
		assert.match(rendered.join("\n"), /Enter edit/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A rejected context policy warns once and keeps the ceiling off", () => {
	const { root, paths, context } = setup();
	try {
		mkdirSync(paths.configDir, { recursive: true });
		writeFileSync(join(paths.configDir, "context-policy.json"), '{"schemaVersion":9,"maxContextTokens":384000}');
		const component = new CatalogSettingsComponent({ context, paths, env: {} });
		const rendered = component.render(84);
		assert.match(rendered.join("\n"), /Maximum context\s+‹ Off ›/u);
		assert.match(rendered.join("\n"), /Context limit was not applied/u);
		assert.match(rendered.join("\n"), /use their declared windows/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
