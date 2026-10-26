import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { analyzeStartup, compareAudit, observeStartup } from "../../../scripts/audit-ja-startup.mjs";
import { loadCatalog } from "../dist/locale-catalog.js";

const reviewed = JSON.parse(
	readFileSync(
		new URL("../../../review/ja-localization/translation-drafts/startup-audit.json", import.meta.url),
		"utf8",
	),
);

test("real Japanese startup localizes shared extension commands and matches reviewed coverage", () => {
	const english = observeStartup("en");
	const japanese = observeStartup("ja");
	const catalog = loadCatalog("ja");
	assert.match(english.runtimeSummary, /^Runtime: Jouzu /u);
	assert.match(japanese.runtimeSummary, /^実行環境: Jouzu /u);
	for (const [name, id] of [
		["labels", "jouzu.cli.sessionLabels.command.description"],
		["textguard", "jouzu.cli.textguard.commandDescription"],
	]) {
		assert.equal(japanese.commands.find((row) => row.name === name).description, catalog.format(id));
	}
	for (const [surface, id] of [
		["labels.invalid-argument", "jouzu.cli.sessionLabels.notify.useCommand"],
		["textguard.reports-empty", "jouzu.cli.textguard.reports.empty"],
	]) {
		assert.equal(japanese.surfaces.find((row) => row.surface === surface).text, catalog.format(id));
	}
	const actual = analyzeStartup(english, japanese);
	assert.deepEqual(
		compareAudit(actual, reviewed),
		[],
		"review changed runtime coverage; do not silently accept a new surface",
	);
	assert.deepEqual(
		actual.commands.filter((row) => row.startup_description === "english-observed").map((row) => row.command),
		[],
	);
	for (const name of ["labels", "textguard"]) {
		const command = actual.commands.find((row) => row.command === name);
		assert.equal(command.catalog, "translation-exists", "catalog presence is not startup wiring evidence");
		assert.equal(command.startup_description, "catalog-japanese-observed");
	}
	const fields = actual.surfaces.filter((row) => row.kind === "setting-fields");
	assert.ok(fields.length, "discover real settings rows");
	assert.ok(fields.every((row) => row.startup_output === "source-data-not-rendered"));
	// The adapter preserves English backing fields and translates during render.
	// Identical backing fields are not evidence of an English screen.
	assert.equal(fields[0].english, fields[0].japanese);
	const settings = actual.surfaces.find((row) => row.surface === "settings.root" && row.width === 100);
	assert.match(settings.japanese, /自動圧縮/u);
	const modelThinking = actual.surfaces.find(
		(row) => row.surface === "settings.submenu.model-thinking" && row.width === 100,
	);
	assert.match(
		modelThinking.japanese,
		/Step 1\/2 · Select a model to configure/u,
		"keep the partial English leak visible",
	);
	assert.ok(actual.surfaces.length, "the audit must drive help and error paths, not just slash descriptions");
});

test("the audit flags a new command independently of the localization mapping", () => {
	const candidate = structuredClone(reviewed);
	candidate.commands.push({ command: "audit-new-command", english: "New command", japanese: "New command" });
	assert.deepEqual(compareAudit(candidate, reviewed), ["unreviewed commands: audit-new-command"]);
});

test("the audit flags broken Japanese wiring, a missing command, and changed detail output", () => {
	const candidate = structuredClone(reviewed);
	const command = candidate.commands.find((row) => row.command === "status");
	command.japanese = command.english;
	candidate.commands = candidate.commands.filter((row) => row.command !== "voice");
	const detail = candidate.surfaces.find((row) => row.surface === "labels.status-help");
	detail.japanese = "Unexpected fallback";
	assert.deepEqual(compareAudit(candidate, reviewed), [
		"changed commands: status",
		"missing commands: voice",
		"changed surfaces: labels.status-help",
	]);
});

test("a repaired gap regressing to English requires updating its reviewed classification", () => {
	const candidate = structuredClone(reviewed);
	candidate.commands.find((row) => row.command === "labels").startup_description = "english-observed";
	assert.deepEqual(compareAudit(candidate, reviewed), ["changed commands: labels"]);
});

test("startup failures, asymmetric discovery, and empty observations cannot pass as coverage", () => {
	const observation = (locale) => ({ locale, errors: [], commands: [], suggestions: [], surfaces: [] });
	assert.throws(() => analyzeStartup(observation("en"), observation("ja")), /missing or duplicate/u);
	const en = { ...observation("en"), suggestions: [{ value: "audit-fixture", description: "Fixture" }] };
	assert.throws(() => analyzeStartup(en, observation("ja")), /command sets differ/u);
	assert.throws(() => analyzeStartup(en, { ...observation("ja"), errors: ["failed extension"] }), /startup errors/u);
});
