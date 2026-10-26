#!/usr/bin/env node
// Controlled component renders, not real startup or a launched subagent.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRuntimeDiagnostics } from "../../../../packages/cli/dist/runtime-diagnostics.js";
import { loadMetadata } from "../../../../packages/cli/dist/metadata.js";
import { loadCatalog } from "../../../../packages/cli/dist/locale-catalog.js";
import { renderSubagentDashboard } from "../../../../packages/cli/dist/subagents/dashboard.js";

const metadata = loadMetadata();
const theme = { fg: (_role, value) => value };
const run = { status: "running", role: { id: "audit-role" }, model: { provider: "audit-provider", id: "audit-model" }, cwd: "<fixture-workspace>" };
const clean = (text) => text.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/gu, "<start-time>");
const report = {
	schema_version: 1,
	evidence_level: "component-reproduction-not-real-startup-or-native-runtime",
	runtime_diagnostics: {
		source_evidence: "packages/cli/src/main-cli.ts createRuntimeDiagnostics omits catalog argument",
		production_arguments: clean(createRuntimeDiagnostics(metadata, {}).about()),
		explicit_japanese_catalog: clean(createRuntimeDiagnostics(metadata, {}, {}, loadCatalog("ja")).about()),
	},
	subagent_widget: ["en", "ja"].flatMap((locale) => [48, 100].map((width) => ({
		locale,
		width,
		text: renderSubagentDashboard([run], width, 32, theme, loadCatalog(locale)).join("\n"),
	}))),
};
writeFileSync(resolve(import.meta.dirname, "component-observations.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log("Saved controlled diagnostics/widget observations; no model or subagent was launched.");
