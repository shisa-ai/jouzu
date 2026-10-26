#!/usr/bin/env node
// Observe read-only CLI routes in isolated homes. No account, network, or install operations.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../../../..");
const cli = join(root, "packages/cli/dist/cli.js");
const output = process.argv[2];
if (!output) throw new Error("provide an output JSON path");
const scenarios = [
	["help", ["--help"]],
	["version", ["--version"]],
	["doctor-human", ["doctor"]],
	["doctor-json", ["doctor", "--json"]],
	["catalog-status", ["catalog", "status"]],
	["catalog-status-json", ["catalog", "status", "--json"]],
	["catalog-missing-file", ["catalog", "validate", "missing.json"]],
	["catalog-invalid-record", ["catalog", "validate", "invalid-catalog.json"]],
	["catalog-conformance-invalid-record", ["catalog", "conformance", "invalid-catalog.json"]],
	["keybindings-status", ["keybindings", "status"]],
	["keybindings-plan", ["keybindings", "plan"]],
	["profile-plan", ["profile", "plan", "--profile", "ja"]],
	["migration-plan", ["profile-migration", "plan"]],
	["migration-confirmation-required", ["profile-migration", "apply"]],
	["migration-no-rollback-receipt", ["profile-migration", "rollback"]],
	["update-status", ["self-update", "status"]],
	["invalid-profile", ["profile", "plan", "--profile", "audit-invalid"]],
	["invalid-catalog-operation", ["catalog", "audit-invalid"]],
	["missing-option-value", ["--jouzu-profile"]],
	["pinned-pi-update", ["pi", "update", "--self"]],
];
const observations = [];
for (const [scenario, args] of scenarios) {
	for (const locale of ["en", "ja"]) {
		const temporary = mkdtempSync(join(tmpdir(), "jouzu-cli-ui-audit-"));
		try {
			const home = join(temporary, "home");
			mkdirSync(home);
			writeFileSync(join(temporary, "invalid-catalog.json"), "{}");
			const denyNetwork = join(temporary, "deny-network.mjs");
			writeFileSync(denyNetwork, 'globalThis.fetch = async () => { throw new Error("audit-network-disabled"); };\n');
			const env = { HOME: temporary, USERPROFILE: temporary, TERM: "dumb" };
			for (const key of ["PATH", "SystemRoot", "TEMP", "TMP", "LANG", "LC_ALL", "TZ"]) {
				if (process.env[key] !== undefined) env[key] = process.env[key];
			}
			const result = spawnSync(process.execPath, ["--import", pathToFileURL(denyNetwork).href, cli, "--jouzu-home", home, "--jouzu-ui-locale", locale, ...args], {
				cwd: temporary,
				encoding: "utf8",
				timeout: 45_000,
				maxBuffer: 2 * 1024 * 1024,
				env: { ...env, JOUZU_HOME: home, JOUZU_NO_UPDATE: "1", JOUZU_NO_PI_IMPORT: "1", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
			});
			if (result.error || result.signal) throw new Error(`failed CLI audit scenario ${scenario}/${locale}: ${result.error ?? result.signal}`);
			const expectedExit = scenario.startsWith("invalid-") || ["missing-option-value", "pinned-pi-update"].includes(scenario)
				? 2 : ["catalog-missing-file", "catalog-invalid-record", "catalog-conformance-invalid-record", "migration-no-rollback-receipt"].includes(scenario) ? 1 : 0;
			if (result.status !== expectedExit) throw new Error(`unexpected exit status for ${scenario}/${locale}: ${result.status}`);
			const clean = (text) => {
				for (const [value, replacement] of [[temporary, "<temporary-root>"], [root, "<checkout-root>"], [process.execPath, "<node-executable>"], [dirname(process.execPath), "<node-directory>"], [tmpdir(), "<system-temp>"], [homedir(), "<user-home>"]]) {
					for (const form of [value, value.replaceAll("\\", "/")]) {
						text = text.replaceAll(form, replacement).replaceAll(JSON.stringify(form).slice(1, -1), replacement);
					}
				}
				return text;
			};
			observations.push({ scenario, locale, args, exit_status: result.status, stdout: clean(result.stdout), stderr: clean(result.stderr) });
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	}
}
writeFileSync(resolve(output), `${JSON.stringify({ schema_version: 1, observations }, null, 2)}\n`);
console.log(`Saved ${observations.length} CLI observations for ${scenarios.length} scenarios.`);
