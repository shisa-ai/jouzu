import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("CLI starts without browser tools when the Camoufox idle delay is invalid", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-camoufox-startup-"));
	try {
		const extension = join(root, "observe-tools.mjs");
		writeFileSync(
			extension,
			`export default function(pi) {
				pi.on("session_start", () => {
					console.error("registered-tools:" + JSON.stringify(pi.getAllTools().map(tool => tool.name)));
				});
			}`,
		);
		const environment = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !/^(JOUZU_|PI_|SHISA_|AI_AGENT|TEXTGUARD_)/u.test(key)),
		);
		for (const [label, value] of [
			["invalid", "soon"],
			["valid", "1000"],
			["unset", undefined],
		]) {
			const result = spawnSync(
				process.execPath,
				[
					resolve(import.meta.dirname, "../dist/cli.js"),
					"--jouzu-home",
					join(root, label),
					"--mode",
					"rpc",
					"--no-session",
					"--no-context-files",
					"--no-extensions",
					"--no-skills",
					"--extension",
					extension,
				],
				{
					cwd: root,
					env: {
						...environment,
						PI_OFFLINE: "1",
						JOUZU_NO_UPDATE: "1",
						...(value === undefined ? {} : { JOUZU_CAMOUFOX_IDLE_STOP_MS: value }),
					},
					encoding: "utf8",
					timeout: 15_000,
					input: '{"id":"state","type":"get_state"}\n',
				},
			);
			assert.equal(result.status, 0, `${label}: ${result.error ?? result.stderr}`);
			const response = result.stdout
				.split("\n")
				.filter((line) => line.startsWith("{"))
				.map((line) => JSON.parse(line))
				.find((message) => message.id === "state");
			assert.equal(response?.success, true, result.stdout);
			const toolsLine = result.stderr.split("\n").find((line) => line.startsWith("registered-tools:"));
			assert.ok(toolsLine, result.stderr);
			const tools = JSON.parse(toolsLine.slice("registered-tools:".length));
			for (const name of ["tff-fetch_url", "tff-search_web"]) {
				assert.equal(tools.includes(name), value !== "soon", `${label}: ${name}`);
			}
			assert.ok(tools.includes("web_fetch"), "static fetch must remain available");
			assert.ok(tools.includes("read"), "ordinary tools must remain available");
			const diagnostics = `${result.stdout}\n${result.stderr}`;
			if (value === "soon") {
				assert.match(diagnostics, /Optional extension jouzu-camoufox-adapter/u);
				assert.match(diagnostics, /JOUZU_CAMOUFOX_IDLE_STOP_MS.*soon/u);
			} else {
				assert.doesNotMatch(diagnostics, /Optional extension jouzu-camoufox-adapter/u);
			}
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
