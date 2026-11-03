import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { catalogStatus, formatCatalogStatus, validateCatalogFile } from "../dist/catalog-command.js";
import { heldCatalogCommand, heldCatalogSummary } from "../dist/catalog-held.js";
import { CatalogMessageId } from "../dist/cli-messages.js";
import { loadCatalog } from "../dist/locale-catalog.js";
import {
	describeCatalogRegistrationEffect,
	describeCatalogRegistrationGap,
	describeCatalogRegistrationGaps,
} from "../dist/model-catalog.js";

const ESCAPE = String.fromCharCode(27);

/** Render every assertion at a fixed width without color, so layout is deterministic. */
const RENDER = { colorEnabled: false, columns: 100 };

/** Collapse the renderer's alignment and wrapping so message assertions stay readable. */
function flat(text) {
	return text.replace(/\s+/gu, " ");
}

/** Remove every space and line break, for Japanese text the wrapper may split mid-sentence. */
function squeeze(text) {
	return text.replace(/\s+/gu, "");
}

const paths = {
	agentDir: "/unused/agent",
	stateDir: "/unused/state",
	cacheDir: "/unused/cache",
	sessionDir: "/unused/sessions",
	profileStatePath: "/unused/state/profile-state.json",
	backupDir: "/unused/state/backups",
};

test("built-in source without a key is visible and idle with no network work", () => {
	let fetchCount = 0;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		fetchCount += 1;
		throw new Error("network must not be reached");
	};
	try {
		const status = catalogStatus(paths, {});
		assert.deepEqual(status, {
			schemaVersion: 1,
			status: "empty",
			configured: 1,
			active: 0,
			sources: [
				{
					schemaVersion: 1,
					status: "empty",
					configured: true,
					sourceId: "shisa-api",
					label: "Shisa API",
					enabled: true,
					endpoint: "https://api.shisa.ai/v1/jouzu/model-catalog",
					credentialName: "SHISA_API_KEY",
					credentialAvailable: false,
					credentialEnv: false,
					credentialStored: false,
					quarantined: 0,
				},
			],
		});
		assert.equal(fetchCount, 0);
		const text = formatCatalogStatus(status, RENDER);
		assert.match(text, /^○ Shisa API \[shisa-api\] · empty$/mu);
		assert.match(text, /^ +Credential {2,}environment variable SHISA_API_KEY \(not set\)$/mu);
		assert.match(flat(text), /⚠ shisa-api token variable SHISA_API_KEY is not set/u);
		assert.ok(!text.includes(ESCAPE), "piped output carries no escape sequences");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("catalog status lists offerings that declare no thinking levels", () => {
	const status = {
		schemaVersion: 1,
		status: "active",
		configured: true,
		sourceId: "codex-pool",
		label: "codex-pool",
		enabled: true,
		endpoint: "http://localhost:8989/v1/jouzu/model-catalog",
		catalogId: "ai.shisa.codex-pool",
		revision: "sha256:fixture",
		sequence: "7",
		offeringCount: 36,
		thinkingLevelGaps: [{ providerId: "aiand", modelId: "deepseek-ai/deepseek-v4-flash" }],
		quarantined: 0,
	};
	const text = formatCatalogStatus(status, RENDER);
	assert.match(text, /^✓ codex-pool active$/mu);
	assert.match(text, /^ +Thinking levels {2,}1 of 36 offerings have no declared levels$/mu);
	assert.match(text, /^ +aiand\/deepseek-ai\/deepseek-v4-flash$/mu);
	assert.match(flat(text), /⚠ codex-pool 1 of 36 offerings have no declared levels/u);
	assert.doesNotMatch(formatCatalogStatus({ ...status, thinkingLevelGaps: [] }, RENDER), /Thinking levels/u);
});

test("catalog status renders every hoisted note and gap field from the catalog", () => {
	const status = {
		schemaVersion: 1,
		status: "active",
		configured: true,
		sourceId: "codex-pool",
		label: "codex-pool",
		enabled: true,
		endpoint: "http://catalog.example.test/v1/jouzu/model-catalog",
		catalogId: "ai.shisa.codex-pool",
		revision: "sha256:fixture",
		sequence: "7",
		offeringCount: 36,
		registrationGaps: [
			{
				providerId: "aiand",
				modelId: "deepseek-ai/deepseek-v4-flash",
				missing: ["textModality", "maxOutputTokens"],
			},
		],
		thinkingLevelGaps: [{ providerId: "aiand", modelId: "deepseek-ai/deepseek-v4-flash" }],
		credentialName: "CODEX_POOL_KEY",
		credentialAvailable: false,
		credentialEnv: false,
		credentialStored: false,
		quarantined: 2,
		held: [
			{
				revision: "sha256:held",
				digest: "a".repeat(64),
				sequence: "8",
				reasons: ["empty_catalog"],
				receivedAt: "2026-11-03T13:57:41.868Z",
				changes: { activeCount: 36, candidateCount: 0, added: 0, removed: 36 },
			},
			{
				revision: "sha256:legacy",
				digest: "b".repeat(64),
				sequence: "9",
				reasons: ["mass_removal"],
				receivedAt: "2026-11-03T13:58:41.868Z",
			},
		],
	};
	const text = formatCatalogStatus(status, RENDER);
	assert.match(flat(text), /⚠ codex-pool This catalog uses HTTP, so its bearer token is sent in plain text/u);
	assert.match(
		flat(text),
		/⚠ codex-pool token variable CODEX_POOL_KEY is not set and no token is saved for this source; refreshes are skipped until one is available\./u,
	);
	assert.match(
		flat(text),
		/⚠ codex-pool 35 of 36 offerings carry the fields a new model needs \(1 no text input, 1 no maximum output tokens\)\. An offering for a model Pi does not already provide is dropped, so that model never reaches the model list\./u,
	);
	assert.match(
		flat(text),
		/⚠ codex-pool 1 of 36 offerings have no declared levels, so Jouzu cannot control their reasoning effort\./u,
	);
	assert.match(
		flat(text),
		/⚠ codex-pool Update held for review\. The new revision lists no models; the active revision lists 36\. An empty catalog usually means the catalog server is misconfigured\. To use it, run jouzu catalog accept sha256:held --digest a{64} --source codex-pool or review it in \/catalogs\. To discard it, run jouzu catalog reject sha256:held --digest a{64} --source codex-pool/u,
	);
	assert.match(
		flat(text),
		/⚠ codex-pool Update held for review\. Jouzu did not record how this revision differs from the active one\. To use it, run jouzu catalog accept sha256:legacy --digest b{64} --source codex-pool/u,
	);
	assert.match(text, /^ +Registration {2,}35 of 36 offerings carry the fields a new model needs$/mu);
	assert.match(flat(text), /aiand\/deepseek-ai\/deepseek-v4-flash — no text input, no maximum output tokens/u);
	assert.match(text, /^ +Thinking levels {2,}1 of 36 offerings have no declared levels$/mu);
	assert.match(text, /^ +Credential {2,}environment variable CODEX_POOL_KEY \(not set\)$/mu);
	assert.match(text, /^ +Held updates {2,}2$/mu);
});

test("catalog status renders the migrated text from the Japanese catalog", () => {
	const status = {
		schemaVersion: 1,
		status: "active",
		configured: true,
		sourceId: "codex-pool",
		label: "codex-pool",
		enabled: true,
		endpoint: "http://catalog.example.test/v1/jouzu/model-catalog",
		offeringCount: 36,
		registrationGaps: [{ providerId: "aiand", modelId: "m", missing: ["textModality", "maxOutputTokens"] }],
		thinkingLevelGaps: [{ providerId: "aiand", modelId: "m" }],
		credentialName: "CODEX_POOL_KEY",
		credentialAvailable: false,
		credentialEnv: false,
		credentialStored: false,
		quarantined: 2,
		held: [
			{
				revision: "sha256:held",
				digest: "a".repeat(64),
				sequence: "8",
				reasons: ["empty_catalog"],
				receivedAt: "2026-11-03T13:57:41.868Z",
				changes: { activeCount: 36, candidateCount: 0, added: 0, removed: 36 },
			},
			{
				revision: "sha256:legacy",
				digest: "b".repeat(64),
				sequence: "9",
				reasons: ["mass_removal"],
				receivedAt: "2026-11-03T13:58:41.868Z",
			},
		],
	};
	const ja = loadCatalog("ja");
	const text = formatCatalogStatus(status, { ...RENDER, catalog: ja, locale: "ja" });
	const [gap] = status.registrationGaps;
	for (const fragment of [
		ja.format(CatalogMessageId.catalogNoteTokenMissing, { name: "CODEX_POOL_KEY" }),
		ja.format(CatalogMessageId.catalogNoteRegistrationGaps, {
			complete: 35,
			total: 36,
			gaps: describeCatalogRegistrationGaps(status.registrationGaps, ja),
			effect: describeCatalogRegistrationEffect(ja),
		}),
		ja.format(CatalogMessageId.catalogNoteThinkingLevels, { count: 1, total: 36 }),
		...status.held.map((held) =>
			ja.format(CatalogMessageId.catalogNoteQuarantined, {
				summary: heldCatalogSummary(ja, held),
				accept: heldCatalogCommand("accept", status.sourceId, held),
				reject: heldCatalogCommand("reject", status.sourceId, held),
			}),
		),
		ja.format(CatalogMessageId.catalogFieldRegistrationValue, { complete: 35, total: 36 }),
		ja.format(CatalogMessageId.catalogRegistrationGapDetail, {
			model: "aiand/m",
			gap: describeCatalogRegistrationGap(gap, ja),
		}),
		ja.format(CatalogMessageId.catalogFieldThinkingLevelsValue, { count: 1, total: 36 }),
		`${ja.format(CatalogMessageId.catalogFieldCredential)} ${ja.format(
			CatalogMessageId.catalogCredentialEnvironmentNotSet,
			{ name: "CODEX_POOL_KEY" },
		)}`,
	]) {
		assert.ok(squeeze(text).includes(squeeze(fragment)), `${fragment}\n${text}`);
	}
});

test("the catalog title state word renders from the catalog", () => {
	const japanese = { ...RENDER, catalog: loadCatalog("ja"), locale: "ja" };
	const single = formatCatalogStatus(
		{ schemaVersion: 1, status: "unconfigured", configured: false, message: "not configured" },
		japanese,
	);
	assert.match(flat(single), /Jouzu モデルカタログ 未設定/u, single);

	for (const [status, word] of [
		["empty", "空"],
		["active", "有効"],
		["degraded", "一部制限"],
	]) {
		const text = formatCatalogStatus({ schemaVersion: 1, status, configured: 1, active: 1, sources: [] }, japanese);
		assert.ok(flat(text).includes(word), `${status}: ${text}`);
	}

	for (const status of ["empty", "active", "degraded", "unconfigured"]) {
		const text = flat(
			formatCatalogStatus({ schemaVersion: 1, status, configured: 1, active: 1, sources: [] }, japanese),
		);
		assert.doesNotMatch(text, new RegExp(`\\b${status}\\b`, "u"), `${status}: ${text}`);
	}

	const withSource = flat(
		formatCatalogStatus(
			{
				schemaVersion: 1,
				status: "empty",
				configured: 1,
				active: 0,
				sources: [
					{
						schemaVersion: 1,
						status: "empty",
						configured: true,
						sourceId: "shisa-api",
						label: "Shisa API",
						enabled: true,
						endpoint: "https://api.example.test/v1/jouzu/model-catalog",
						quarantined: 0,
					},
				],
			},
			japanese,
		),
	);
	assert.match(withSource, /Shisa API \[shisa-api\] · 空/u, withSource);
	assert.doesNotMatch(withSource, /\bempty\b/u, withSource);
});

test("catalog file validation fails gracefully", () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-command-"));
	try {
		const invalidPath = join(temporary, "invalid.json");
		writeFileSync(invalidPath, "[]\n");
		const invalid = validateCatalogFile(invalidPath, false);
		assert.equal(invalid.valid, false);
		assert.equal(invalid.error?.code, "invalid_record");

		const missing = validateCatalogFile(join(temporary, "missing.json"), true);
		assert.equal(missing.valid, false);
		assert.match(missing.error?.message ?? "", /does not exist/);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});
