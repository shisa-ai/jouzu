import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CatalogSettingsComponent } from "../dist/catalog-settings.js";
import { CatalogSourceStore } from "../dist/catalog-sources.js";
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

function setup() {
	const root = mkdtempSync(join(tmpdir(), "jouzu-catalog-settings-"));
	const paths = resolveJouzuPaths({ homeOverride: join(root, "jouzu") });
	const renders = [];
	const context = {
		tui: {
			requestRender() {
				renders.push(true);
			},
			terminal: { rows: 32, columns: 100 },
		},
		theme: identityTheme,
		keybindings: {
			matches(data, id) {
				return (
					(data === "escape" && id === "tui.select.cancel") ||
					(data === "enter" && id === "tui.select.confirm") ||
					(data === "up" && id === "tui.select.up") ||
					(data === "down" && id === "tui.select.down")
				);
			},
		},
		styles: createSessionUiStyles(identityTheme),
		close() {},
	};
	return { root, paths, context, renders };
}

function response(document) {
	return new Response(JSON.stringify(document), {
		status: 200,
		headers: { "Content-Type": "application/vnd.jouzu.model-catalog+json; version=1", ETag: '"fixture"' },
	});
}

test("Catalogs settings reports source status and expands its full model list within width", async () => {
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
		let rendered = component.render(84);
		assert.match(rendered.join("\n"), /Office pool/u);
		assert.match(rendered.join("\n"), /active/u);
		assert.match(rendered.join("\n"), /1 model/u);
		assert.ok(rendered.every((line) => terminalTextWidth(line) <= 84));

		component.handleInput("enter");
		rendered = component.render(84);
		assert.match(rendered.join("\n"), /Example Model/u);
		assert.match(rendered.join("\n"), /ai\.example\.gateway\/example-model/u);
		assert.ok(rendered.every((line) => terminalTextWidth(line) <= 84));
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
		component.handleInput("\t");
		component.handleInput("\t");
		component.handleInput(" ");

		const rendered = component.render(84);
		const text = rendered.join("\n");
		assert.match(text, /Authentication\s+Bearer token from environment/u);
		assert.match(text, /Token variable/u);
		assert.match(text, /JOUZU_MODEL_CATALOG_TOKEN is not set in this Jouzu process/u);
		assert.ok(rendered.every((line) => terminalTextWidth(line) <= 84));

		env.JOUZU_MODEL_CATALOG_TOKEN = "must-not-render";
		const availableText = component.render(84).join("\n");
		assert.match(availableText, /JOUZU_MODEL_CATALOG_TOKEN is set in this Jouzu process/u);
		assert.doesNotMatch(availableText, /must-not-render/u);
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
		component.handleInput("\t");
		for (const character of "catalog.example") component.handleInput(character);
		component.handleInput("\u001b[13;5u");
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
		component.handleInput("\t");
		for (const character of "127.0.0.1:8989") component.handleInput(character);
		component.handleInput("\u001b[13;5u");
		await new Promise((resolve) => setImmediate(resolve));

		assert.deepEqual(discoveries, [{ input: "127.0.0.1:8989", auth: { type: "none" } }]);
		const saved = new CatalogSourceStore(paths).list();
		assert.equal(saved.length, 1);
		assert.equal(saved[0].label, "Local catalog");
		assert.equal(saved[0].url, "http://127.0.0.1:8989/v1/jouzu/model-catalog");
		assert.match(component.render(84).join("\n"), /Saved Local catalog with 1 model/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
