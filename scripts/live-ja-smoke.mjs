#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

if (process.env.JOUZU_LIVE_SMOKE !== "1") {
	throw new Error("live smoke is opt-in; set JOUZU_LIVE_SMOKE=1");
}
const provider = process.env.JOUZU_LIVE_PROVIDER;
const model = process.env.JOUZU_LIVE_MODEL;
const budget = Number(process.env.JOUZU_LIVE_MAX_USD);
if (!provider || !model) throw new Error("set JOUZU_LIVE_PROVIDER and JOUZU_LIVE_MODEL");
if (!Number.isFinite(budget) || budget <= 0 || budget > 0.25) {
	throw new Error("set JOUZU_LIVE_MAX_USD to a positive release-smoke budget no greater than 0.25");
}

const root = resolve(import.meta.dirname, "..");
const expected = Buffer.from("日本語のツール確認\n完了 🦁");
const temp = mkdtempSync(resolve(tmpdir(), "jouzu-live-ja-"));
const project = resolve(temp, "日本語　project");
const output = resolve(project, "確認-結果.txt");

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: root,
		encoding: "utf8",
		timeout: 180_000,
		maxBuffer: 16 * 1024 * 1024,
		...options,
	});
	if (result.error) throw result.error;
	assert.equal(result.signal, null, `${command} terminated by ${result.signal}`);
	assert.equal(result.status, 0, `${command} exited ${result.status}: ${result.stderr || result.stdout}`);
	return result;
}

function scrubbedHarnessEnv() {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key === "AI_AGENT" || /^JOUZU_/.test(key) || /^PI_CODING_AGENT(?:_|$)/.test(key)) continue;
		env[key] = value;
	}
	return env;
}

try {
	mkdirSync(project, { recursive: true });
	run("npm", ["run", "build"]);
	const packed = JSON.parse(
		run("npm", ["pack", "--workspace", "jouzu", "--ignore-scripts", "--json", "--pack-destination", temp]).stdout,
	)[0];
	run("npm", ["install", "--prefix", resolve(temp, "consumer"), "--ignore-scripts", resolve(temp, packed.filename)]);
	const cli = resolve(temp, "consumer", "node_modules", "jouzu", "dist", "cli.js");
	const jouzuHome = resolve(temp, "jouzu-home");
	const prompt = [
		"write ツールを使い、作業ディレクトリに「確認-結果.txt」を作成してください。",
		"内容は次の2行だけにしてください。",
		"日本語のツール確認",
		"完了 🦁",
		"作成後に read ツールで確認し、最終回答は日本語で短く報告してください。",
	].join("\n");
	const result = run(
		process.execPath,
		[
			cli,
			"--jouzu-home",
			jouzuHome,
			"--jouzu-profile",
			"ja",
			"--mode",
			"json",
			"--no-session",
			"--provider",
			provider,
			"--model",
			model,
			"--tools",
			"read,write",
			prompt,
		],
		{
			cwd: project,
			env: { ...scrubbedHarnessEnv(), JOUZU_NO_UPDATE: "1", PI_OFFLINE: "1" },
		},
	);
	const events = result.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const end = events.findLast((event) => event.type === "agent_end");
	const assistant = end?.messages?.findLast((message) => message.role === "assistant");
	if (!assistant || assistant.stopReason === "error" || assistant.errorMessage) {
		throw new Error(`live provider failed: ${assistant?.errorMessage ?? "no assistant completion"}`);
	}
	const cost = Number(assistant.usage?.cost?.total ?? 0);
	if (!Number.isFinite(cost) || cost > budget) throw new Error(`live smoke cost ${cost} exceeded budget ${budget}`);
	assert.deepEqual(readFileSync(output), expected, "live tool flow changed the requested Japanese bytes");
	const profileState = JSON.parse(readFileSync(resolve(jouzuHome, "state", "profile-state.json"), "utf8"));
	assert.equal(profileState.activeProfile, "ja", "live JA smoke did not apply the explicit JA profile");
	const usedWrite = events.some(
		(event) => event.type === "tool_execution_end" && event.toolName === "write" && !event.isError,
	);
	const usedRead = events.some(
		(event) => event.type === "tool_execution_end" && event.toolName === "read" && !event.isError,
	);
	assert.equal(usedWrite, true, "live smoke did not use write");
	assert.equal(usedRead, true, "live smoke did not use read");
	console.log(
		JSON.stringify(
			{
				schemaVersion: 1,
				provider,
				model,
				budgetUsd: budget,
				costUsd: cost,
				toolFlow: ["write", "read"],
				outputBytes: expected.length,
				status: "passed",
			},
			null,
			2,
		),
	);
} finally {
	rmSync(temp, { recursive: true, force: true });
}
