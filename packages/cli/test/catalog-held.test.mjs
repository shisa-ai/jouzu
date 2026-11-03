import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import {
	createHeldCatalogReviewComponent,
	heldCatalogCommand,
	heldCatalogSummary,
	heldCatalogUpdates,
	reviewHeldCatalogUpdates,
} from "../dist/catalog-held.js";
import { resolveCatalogSources } from "../dist/catalog-sources.js";
import { defaultCatalog } from "../dist/cli-messages.js";
import { loadCatalog } from "../dist/locale-catalog.js";
import { getCatalogStatuses, loadActiveModelCatalogs, refreshModelCatalog } from "../dist/model-catalog-sync.js";
import { resolveJouzuPaths } from "../dist/paths.js";

const identityTheme = { fg: (_role, value) => value, bg: (_role, value) => value, bold: (value) => value };
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const URL = "https://catalog.example.test/v1/jouzu/model-catalog";
const flat = (lines) => stripTerminalSequences(lines.join("\n")).replace(/\s+/g, " ");

const fixture = JSON.parse(
	readFileSync(join(import.meta.dirname, "..", "catalog", "fixtures", "account-snapshot-v1.json"), "utf8"),
);

function offerings(count) {
	return Array.from({ length: count }, (_, index) => ({
		...fixture.modelOfferings[0],
		id: `ai.example.gateway/model-${index}`,
		modelId: `model-${index}`,
	}));
}

function snapshot(sequence, models) {
	const document = structuredClone(fixture);
	document.sequence = String(sequence);
	document.revision = `fixture-${sequence}`;
	document.modelOfferings = models;
	return document;
}

function respond(document) {
	return async () =>
		new Response(JSON.stringify(document), {
			status: 200,
			headers: { "Content-Type": "application/vnd.jouzu.model-catalog+json; version=1" },
		});
}

const env = () => ({ JOUZU_MODEL_CATALOG_URL: URL, JOUZU_MODEL_CATALOG_TOKEN: "fixture-token" });

/** A Pi extension context whose overlay answers with the given key presses. */
function context({ keys = [], mode = "tui" } = {}) {
	const notices = [];
	const rendered = [];
	return {
		notices,
		rendered,
		ctx: {
			mode,
			hasUI: mode === "tui",
			ui: {
				notify: (text, level) => notices.push({ text, level }),
				custom: async (factory, options) => {
					assert.equal(options.overlay, true);
					let resolveDone;
					const done = new Promise((resolve) => (resolveDone = resolve));
					const component = factory(
						{ requestRender() {} },
						identityTheme,
						new KeybindingsManager(TUI_KEYBINDINGS),
						resolveDone,
					);
					rendered.push(component.render(80));
					for (const key of keys) component.handleInput(key);
					return done;
				},
			},
		},
	};
}

async function heldFixture(temporary) {
	const paths = resolveJouzuPaths({ homeOverride: join(temporary, "jouzu"), cwd: "/" });
	assert.equal(
		(await refreshModelCatalog(paths, { env: env(), fetch: respond(snapshot(1, offerings(12))) })).status,
		"activated",
	);
	const held = await refreshModelCatalog(paths, { env: env(), fetch: respond(snapshot(2, [])) });
	assert.equal(held.status, "quarantined");
	const source = resolveCatalogSources(paths, env()).find((candidate) => candidate.url === URL);
	return { paths, held, updates: heldCatalogUpdates([{ source, result: held }]) };
}

test("held summaries describe empty, changed, and unrecorded revisions", () => {
	const catalog = defaultCatalog();
	const base = { revision: "r", digest: "a".repeat(64), sequence: "2", reasons: [], receivedAt: "" };
	assert.equal(
		heldCatalogSummary(catalog, {
			...base,
			changes: { activeCount: 23, candidateCount: 0, added: 0, removed: 23 },
		}),
		"The new revision lists no models; the active revision lists 23. An empty catalog usually means the catalog server is misconfigured.",
	);
	assert.equal(
		heldCatalogSummary(catalog, {
			...base,
			changes: { activeCount: 23, candidateCount: 24, added: 24, removed: 23 },
		}),
		"The new revision lists 24 models (24 added, 23 removed); the active revision lists 23.",
	);
	assert.equal(
		heldCatalogSummary(catalog, base),
		"Jouzu did not record how this revision differs from the active one.",
	);
	assert.match(
		heldCatalogSummary(loadCatalog("ja"), {
			...base,
			changes: { activeCount: 5, candidateCount: 0, added: 0, removed: 5 },
		}),
		/モデルがありません/u,
	);
});

test("held commands name the exact revision, digest, and source, quoting unsafe words", () => {
	const held = { revision: "sha256:abc", digest: "b".repeat(64), sequence: "2", reasons: [], receivedAt: "" };
	assert.equal(
		heldCatalogCommand("accept", "shisa-api", held),
		`jouzu catalog accept sha256:abc --digest ${"b".repeat(64)} --source shisa-api`,
	);
	assert.equal(
		heldCatalogCommand("reject", "office", { ...held, revision: "it's $(x)" }),
		`jouzu catalog reject 'it'\\''s $(x)' --digest ${"b".repeat(64)} --source office`,
	);
});

test("the review overlay shows the change and resolves accept, reject, or later", () => {
	const update = {
		source: { id: "shisa-api", label: "Shisa API" },
		held: {
			revision: "sha256:held",
			digest: "c".repeat(64),
			sequence: "2",
			reasons: ["empty_catalog"],
			receivedAt: "",
			changes: { activeCount: 23, candidateCount: 0, added: 0, removed: 23 },
		},
	};
	const decide = (keys) => {
		let decision;
		const component = createHeldCatalogReviewComponent({
			tui: { requestRender() {} },
			theme: identityTheme,
			keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
			update,
			catalog: defaultCatalog(),
			done: (value) => {
				decision = value;
			},
		});
		const text = flat(component.render(80));
		for (const key of keys) component.handleInput(key);
		return { decision, text };
	};
	const { decision, text } = decide([ENTER]);
	assert.equal(decision, "accept");
	assert.match(text, /Catalog update held: Shisa API/u);
	assert.match(text, /The new revision lists no models; the active revision lists 23\./u);
	assert.match(text, /Revision: sha256:held/u);
	assert.match(text, /> Accept and use the new catalog/u);
	assert.match(text, /Reject and keep the current catalog/u);
	assert.match(text, /decide later in \/catalogs/u);
	assert.equal(decide([DOWN, ENTER]).decision, "reject");
	assert.equal(decide([ESC]).decision, "later");
});

test("accepting in the review activates the held revision", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-held-accept-"));
	try {
		const { paths, updates } = await heldFixture(temporary);
		const { ctx, notices, rendered } = context({ keys: [ENTER] });
		assert.equal(await reviewHeldCatalogUpdates(ctx, updates, { paths, env: env() }), true);
		assert.equal(rendered.length, 1);
		assert.equal(loadActiveModelCatalogs(paths, env())[0]?.document.revision, "fixture-2");
		assert.deepEqual(notices, [
			{ text: `Applied the held catalog update for ${updates[0].source.label}.`, level: "info" },
		]);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("rejecting in the review keeps the active catalog and clears the hold", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-held-reject-"));
	try {
		const { paths, updates } = await heldFixture(temporary);
		const { ctx, notices } = context({ keys: [DOWN, ENTER] });
		assert.equal(await reviewHeldCatalogUpdates(ctx, updates, { paths, env: env() }), false);
		assert.equal(loadActiveModelCatalogs(paths, env())[0]?.document.revision, "fixture-1");
		const status = getCatalogStatuses(paths, env()).sources.find((source) => source.endpoint === URL);
		assert.equal(status.quarantined, 0);
		assert.match(notices[0].text, /Rejected the held catalog update/u);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("a deferred or non-interactive review leaves the revision held and posts the command", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-held-later-"));
	try {
		const { paths, held, updates } = await heldFixture(temporary);
		for (const options of [{ keys: [ESC] }, { mode: "rpc" }]) {
			const { ctx, notices, rendered } = context(options);
			assert.equal(await reviewHeldCatalogUpdates(ctx, updates, { paths, env: env() }), false);
			assert.equal(rendered.length, options.mode === "rpc" ? 0 : 1);
			assert.equal(notices.length, 1);
			assert.equal(notices[0].level, "warning");
			assert.ok(notices[0].text.includes("Review it in /catalogs"), notices[0].text);
			assert.ok(
				notices[0].text.includes(
					`jouzu catalog accept ${held.revision} --digest ${held.digest} --source ${updates[0].source.id}`,
				),
				notices[0].text,
			);
		}
		assert.equal(loadActiveModelCatalogs(paths, env())[0]?.document.revision, "fixture-1");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});
