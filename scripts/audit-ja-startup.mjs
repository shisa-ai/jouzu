#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "../packages/cli/dist/locale-catalog.js";

const root = resolve(import.meta.dirname, "..");
const fixture = join(root, "packages/cli/test/fixtures/localization-startup.mjs");

/** Observe production extension construction, binding, and the active slash provider. */
export function observeStartup(locale) {
	if (!["en", "ja"].includes(locale)) throw new Error("expected en or ja");
	const freshness = spawnSync(process.execPath, [join(root, "scripts/check-dist-fresh.mjs")], {
		encoding: "utf8",
		timeout: 15_000,
	});
	if (freshness.error || freshness.status !== 0) {
		throw new Error(`rebuild before auditing startup: ${freshness.error ?? freshness.stderr}`);
	}
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-localization-audit-"));
	try {
		const home = join(temporary, "home");
		const env = { HOME: temporary, USERPROFILE: temporary, TERM: "xterm-256color" };
		for (const key of ["PATH", "SystemRoot", "TEMP", "TMP", "LANG", "LC_ALL", "TZ"]) {
			if (process.env[key] !== undefined) env[key] = process.env[key];
		}
		const result = spawnSync(process.execPath, [fixture, locale], {
			cwd: temporary,
			encoding: "utf8",
			timeout: 60_000,
			maxBuffer: 4 * 1024 * 1024,
			env: {
				...env,
				JOUZU_HOME: home,
				JOUZU_NO_UPDATE: "1",
				JOUZU_NO_PI_IMPORT: "1",
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				PI_TELEMETRY: "0",
			},
		});
		if (result.error || result.status !== 0) {
			throw new Error(
				`localization startup failed (${locale}): ${result.error ?? result.status}\n${result.stderr}\n${result.stdout}`,
			);
		}
		return JSON.parse(readFileSync(join(home, "localization-audit.json"), "utf8"));
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

/** Compare runtime-discovered entries, not a hand-selected localization mapping. */
export function analyzeStartup(english, japanese) {
	if (english.locale !== "en" || japanese.locale !== "ja") throw new Error("expected en and ja startup observations");
	if (english.errors.length || japanese.errors.length) throw new Error("extension startup errors invalidate the audit");
	const enCatalog = loadCatalog("en");
	const jaCatalog = loadCatalog("ja");
	const patterns = [];
	for (const id of Object.keys(enCatalog.messages)) {
		try {
			patterns.push({ id, en: enCatalog.format(id), ja: jaCatalog.format(id) });
		} catch {
			// Parameterized messages require a scenario with real arguments.
		}
	}
	const enSuggestions = new Map(english.suggestions.map((item) => [item.value, item]));
	const jaSuggestions = new Map(japanese.suggestions.map((item) => [item.value, item]));
	if (
		!enSuggestions.size ||
		enSuggestions.size !== english.suggestions.length ||
		jaSuggestions.size !== japanese.suggestions.length
	) {
		throw new Error("missing or duplicate slash suggestions");
	}
	if (JSON.stringify([...enSuggestions.keys()].sort()) !== JSON.stringify([...jaSuggestions.keys()].sort())) {
		throw new Error("English and Japanese startup command sets differ");
	}
	const clean = (description = "") => description.replace(/^\[[^\]]+\] /u, "").replace(/^<[^\n]+> — /u, "");
	const commands = [...enSuggestions.keys()].sort().map((name) => {
		const en = clean(enSuggestions.get(name).description);
		const ja = clean(jaSuggestions.get(name).description);
		const matches = patterns.filter((pattern) => pattern.en === en && pattern.ja !== en);
		const registration = japanese.commands.find((command) => command.invocationName === name);
		return {
			command: name,
			registered_extension: Boolean(registration),
			english: en,
			japanese: ja,
			catalog: matches.length ? "translation-exists" : "not-matched",
			message_ids: matches.map((pattern) => pattern.id).sort(),
			startup_description:
				en === ja
					? "english-observed"
					: matches.some((pattern) => pattern.ja === ja)
						? "catalog-japanese-observed"
						: "needs-review",
			detail_surfaces: japanese.surfaces.some((surface) => surface.surface.startsWith(`${name}.`))
				? "selected-paths-exercised"
				: "not-exercised",
		};
	});
	const detailIdentity = (surface) => `${surface.surface}:${surface.kind}:${surface.width ?? ""}`;
	const enDetails = english.surfaces
		.filter((surface) => surface.surface !== "startup")
		.map(detailIdentity)
		.sort();
	const jaDetails = japanese.surfaces
		.filter((surface) => surface.surface !== "startup")
		.map(detailIdentity)
		.sort();
	if (JSON.stringify(enDetails) !== JSON.stringify(jaDetails))
		throw new Error("English and Japanese detail surface sets differ");
	const surfaces = japanese.surfaces
		.filter((surface) => surface.surface !== "startup")
		.map((surface) => {
			const en = english.surfaces.find(
				(entry) => entry.surface === surface.surface && entry.kind === surface.kind && entry.width === surface.width,
			);
			if (!en) throw new Error(`missing English surface: ${surface.surface}`);
			return {
				surface: surface.surface,
				kind: surface.kind,
				...(surface.width ? { width: surface.width } : {}),
				english: en.text,
				japanese: surface.text,
				startup_output:
					surface.kind === "setting-fields"
						? "source-data-not-rendered"
						: en.text === surface.text
							? "english-observed"
							: "changed-needs-review",
			};
		});
	return { schemaVersion: 1, scenario: "fresh-core-interactive-startup", commands, surfaces };
}

/** A changed inventory or output needs review; known English gaps stay explicit. */
export function compareAudit(actual, reviewed) {
	const differences = [];
	for (const group of ["commands", "surfaces"]) {
		const key = group === "commands" ? "command" : "surface";
		const identity = (row) => `${row[key]}${row.width ? `@${row.width}` : ""}`;
		const expected = new Map(reviewed[group].map((row) => [identity(row), row]));
		for (const row of actual[group]) {
			const id = identity(row);
			if (!expected.has(id)) differences.push(`unreviewed ${group}: ${id}`);
			else if (JSON.stringify(row) !== JSON.stringify(expected.get(id))) differences.push(`changed ${group}: ${id}`);
			expected.delete(id);
		}
		for (const id of expected.keys()) differences.push(`missing ${group}: ${id}`);
	}
	return differences;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	console.log(JSON.stringify(analyzeStartup(observeStartup("en"), observeStartup("ja")), null, 2));
}
