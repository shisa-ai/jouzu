import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDoctorReport, formatDoctorReport } from "../dist/doctor.js";
import { loadCatalog } from "../dist/locale-catalog.js";
import { summarizeReleaseSurfaces } from "../dist/release-extensions.js";
import { DOCTOR_FIELD_IDS, DOCTOR_FIELD_KEYS, DOCTOR_REPORT_KEYS } from "./fixtures/machine-contract.mjs";

const RENDER = { colorEnabled: false, columns: 100 };

/** Collapse the renderer's alignment and wrapping so message assertions stay readable. */
function flat(text) {
	return text.replace(/\s+/gu, " ");
}

function metadata() {
	return {
		jouzuVersion: "0.1.0",
		displayVersion: "0.1.0",
		build: undefined,
		piVersion: "1.0.0",
		profileSchemaVersion: 1,
		lock: {
			schemaVersion: 2,
			repository: "https://github.com/earendil-works/pi",
			tag: "v1.0.0",
			tagCommit: "a13d35a742c6ef8462812a28fbe1d8c8b7431c32",
			commit: "a13d35a742c6ef8462812a28fbe1d8c8b7431c32",
			packages: {},
			reviewedAt: "2026-10-02",
			compatibilityStatus: "qualified",
			deviations: [],
		},
	};
}

function context(root) {
	return {
		metadata: metadata(),
		paths: {
			agentDir: join(root, "agent"),
			stateDir: join(root, "state"),
			cacheDir: join(root, "cache"),
			sessionDir: join(root, "state", "sessions"),
			profileStatePath: join(root, "state", "profile-state.json"),
			backupDir: join(root, "state", "backups"),
		},
		profile: { id: "core", source: "default" },
		piRuntimeVersion: "1.0.0",
		executable: "/opt/jouzu/dist/cli.js",
		env: { HOME: root },
		platform: "linux",
		architecture: "x64",
		nodeVersion: "v22.19.0",
		locale: "en-US",
		uiLocale: { requested: "auto", effective: "en", source: "builtin" },
		commandPaths: { git: "/usr/bin/git", bash: "/usr/bin/bash", npm: "/usr/bin/npm" },
	};
}

const SUPPORT_STAGE_EN =
	"The Jouzu-owned UI is available in English and Japanese, and the Jouzu-owned browser adapter renders its tool labels from the Jouzu catalog. The pinned Pi and the third-party bundled extensions render their own English.";
const SUPPORT_STAGE_JA =
	"Jouzu 所有の UI は英語と日本語で利用でき、Jouzu 所有のブラウザーアダプターはツールのラベルを Jouzu カタログから表示します。固定版の Pi と第三者の同梱拡張は独自の英語で表示します。";

/** The six field IDs this milestone adds to the doctor report. */
const UPSTREAM_FIELD_IDS = [
	"upstream.surfaces.total",
	"upstream.surfaces.translated",
	"upstream.surfaces.upstreamOwned",
	"upstream.surfaces.notInspected",
	"upstream.surfaces.outOfScope",
	"upstream.supportStage",
];

test("doctor shows the support stage and the upstream boundary counts in both locales", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-doctor-upstream-boundary-"));
	try {
		const result = createDoctorReport(context(root));
		const english = flat(formatDoctorReport(result.report, RENDER));
		assert.match(english, /Upstream boundary/u);
		assert.match(english, /Recorded surfaces 53/u);
		assert.match(english, /Translated surfaces 1/u);
		assert.match(english, /Upstream-owned surfaces 42/u);
		assert.match(english, /Not-inspected surfaces 1/u);
		assert.match(english, /Out-of-scope surfaces 9/u);
		assert.ok(english.includes(SUPPORT_STAGE_EN), "the English support stage is rendered");

		const japanese = flat(formatDoctorReport(result.report, { ...RENDER, locale: "ja", catalog: loadCatalog("ja") }));
		assert.match(japanese, /上流境界/u);
		assert.match(japanese, /記録済みの表示面 53/u);
		assert.match(japanese, /翻訳済みの表示面 1/u);
		assert.match(japanese, /上流所有の表示面 42/u);
		assert.match(japanese, /未確認の表示面 1/u);
		assert.match(japanese, /対象外の表示面 9/u);
		assert.ok(
			japanese.replace(/\s+/gu, "").includes(SUPPORT_STAGE_JA.replace(/\s+/gu, "")),
			"the Japanese support stage is rendered",
		);
		assert.ok(!japanese.includes(SUPPORT_STAGE_EN), "the ja render does not fall back to the English stage");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("doctor marks the Pi 1.5 surface inspection stale for a different runtime", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-doctor-surface-recheck-"));
	try {
		const current = context(root);
		current.metadata.piVersion = "1.4.0";
		current.piRuntimeVersion = "1.4.0";
		const report = createDoctorReport(current).report;
		const before = JSON.stringify(report);
		assert.match(flat(formatDoctorReport(report, RENDER)), /inspected against Pi 1\.5\.0, not the running Pi 1\.4\.0/u);
		assert.match(flat(formatDoctorReport(report, { ...RENDER, catalog: loadCatalog("ja") })), /Pi 1\.4\.0 では未確認/u);
		assert.equal(JSON.stringify(report), before);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("doctor --json carries the counts under new keys and keeps every existing key", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-doctor-upstream-json-"));
	try {
		const report = createDoctorReport(context(root)).report;

		// The report object and field shape are unchanged; only new fields are added.
		assert.deepEqual(Object.keys(report), DOCTOR_REPORT_KEYS);
		for (const field of report.fields) assert.deepEqual(Object.keys(field), DOCTOR_FIELD_KEYS);
		assert.deepEqual(
			report.fields.map((field) => field.id),
			DOCTOR_FIELD_IDS,
		);

		// The new count keys carry the record's own totals.
		const summary = summarizeReleaseSurfaces();
		const value = (id) => report.fields.find((field) => field.id === id)?.value;
		assert.equal(value("upstream.surfaces.total"), String(summary.total));
		assert.equal(value("upstream.surfaces.translated"), String(summary.translated));
		assert.equal(value("upstream.surfaces.upstreamOwned"), String(summary.upstreamOwned));
		assert.equal(value("upstream.surfaces.notInspected"), String(summary.notInspected));
		assert.equal(value("upstream.surfaces.outOfScope"), String(summary.outOfScope));
		assert.equal(value("upstream.supportStage"), SUPPORT_STAGE_EN);
		assert.deepEqual(summary, {
			total: 53,
			translated: 1,
			upstreamOwned: 42,
			notInspected: 1,
			outOfScope: 9,
			unknown: 0,
		});

		// The new fields live in their own section, so the localization section's
		// pinned keys and the other sections are untouched.
		for (const id of UPSTREAM_FIELD_IDS) {
			assert.equal(report.fields.find((field) => field.id === id)?.section, "upstream", id);
		}
		assert.equal(
			report.fields.some((field) => field.section === "localization" && field.id.startsWith("upstream.")),
			false,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the counts are labelled as the upstream boundary record, not the product's translation state", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-doctor-upstream-labels-"));
	try {
		const report = createDoctorReport(context(root)).report;
		const label = (id) => report.fields.find((field) => field.id === id)?.label;
		assert.equal(label("upstream.surfaces.total"), "Recorded surfaces");
		assert.equal(label("upstream.surfaces.translated"), "Translated surfaces");
		assert.equal(label("upstream.surfaces.upstreamOwned"), "Upstream-owned surfaces");
		assert.equal(label("upstream.surfaces.notInspected"), "Not-inspected surfaces");
		assert.equal(label("upstream.surfaces.outOfScope"), "Out-of-scope surfaces");
		assert.equal(label("upstream.supportStage"), "Support stage");

		// The support stage makes the narrower claim: only the Jouzu-owned UI is
		// translated, and it never presents the record's totals as the product's
		// overall translation state.
		assert.match(SUPPORT_STAGE_EN, /Jouzu-owned UI/u);
		assert.match(SUPPORT_STAGE_EN, /pinned Pi/u);
		assert.match(SUPPORT_STAGE_EN, /third-party bundled extensions/u);
		assert.match(SUPPORT_STAGE_EN, /Jouzu-owned browser adapter renders its tool labels from the Jouzu catalog/u);
		assert.doesNotMatch(SUPPORT_STAGE_EN, /complete|fully|all UI|entire/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
