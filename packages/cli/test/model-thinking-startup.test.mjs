import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ModelPickerStore } from "../dist/model-picker-state.js";
import { resolveJouzuPaths } from "../dist/paths.js";

test("CLI preserves explicit reasoning suffixes and distinguishes literal colon IDs", { timeout: 120000 }, () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-thinking-cli-"));
	try {
		const home = join(root, "home");
		const extension = join(root, "provider.mjs");
		writeFileSync(
			extension,
			`export default function(pi) {
			pi.registerProvider('thinking-fixture', {
				baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture-only', api: 'openai-completions',
				models: ['fixture', 'literal:low'].map(id => ({id, name:id, reasoning:true,
					input:['text'], cost:{input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:32000,maxTokens:1000}))
			});
		}`,
		);
		const store = new ModelPickerStore(resolveJouzuPaths({ homeOverride: home }));
		for (const modelId of ["fixture", "literal:low"])
			store.setModelThinkingLevel({ provider: "thinking-fixture", modelId }, "high");
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !/^(JOUZU_|PI_|SHISA_|AI_AGENT|TEXTGUARD_)/u.test(key)),
		);
		Object.assign(env, { PI_OFFLINE: "1", JOUZU_NO_UPDATE: "1" });
		for (const [args, expected] of [
			[["--model", "thinking-fixture/fixture:low"], "low"],
			[["--provider", "thinking-fixture", "--model", "fixture:off"], "off"],
			[["--model", "thinking-fixture/fixture:low", "--thinking", "medium"], "medium"],
			[["--model", "thinking-fixture/fixture", "--thinking", "low"], "low"],
			[["--model", "thinking-fixture/fixture"], "high"],
			[["--model", "thinking-fixture/literal:low"], "high"],
			[["--model", "thinking-fixture/literal:low:off"], "off"],
		]) {
			const result = spawnSync(
				process.execPath,
				[
					resolve(import.meta.dirname, "../dist/cli.js"),
					"--jouzu-home",
					home,
					"--mode",
					"rpc",
					"--no-session",
					"--no-context-files",
					"--no-extensions",
					"--no-skills",
					"--extension",
					extension,
					...args,
				],
				{
					cwd: root,
					env,
					encoding: "utf8",
					timeout: 15000,
					input: '{"id":"state","type":"get_state"}\n',
				},
			);
			assert.equal(result.status, 0, result.stderr);
			const response = result.stdout
				.split("\n")
				.filter((line) => line.startsWith("{"))
				.map((line) => JSON.parse(line))
				.find((value) => value.id === "state");
			assert.equal(
				response?.data?.thinkingLevel,
				expected,
				JSON.stringify({ args, stdout: result.stdout, stderr: result.stderr }),
			);
			assert.deepEqual(
				store.load().state.thinkingLevels.map((entry) => entry.thinkingLevel),
				["high", "high"],
			);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
