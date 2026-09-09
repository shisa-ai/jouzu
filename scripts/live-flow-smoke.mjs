#!/usr/bin/env node

/**
 * Live first-candidate check for session flow control. Everything else in this subsystem is proven
 * against a scripted provider, so this is the only place a real model's instruction-following is
 * measured: whether it declares a wait from the exact handles a tool returned, leaves that wait
 * intact across a user status turn, and receives one composed wake when the dependency ends.
 *
 * Opt-in and budgeted. It reports counts, cost, and defect labels; never transcript content.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

if (process.env.JOUZU_LIVE_SMOKE !== "1") throw new Error("live smoke is opt-in; set JOUZU_LIVE_SMOKE=1");
const provider = process.env.JOUZU_LIVE_PROVIDER;
const model = process.env.JOUZU_LIVE_MODEL;
const budget = Number(process.env.JOUZU_LIVE_MAX_USD);
if (!provider || !model) throw new Error("set JOUZU_LIVE_PROVIDER and JOUZU_LIVE_MODEL");
if (!Number.isFinite(budget) || budget <= 0 || budget > 0.25)
	throw new Error("set JOUZU_LIVE_MAX_USD to a positive release-smoke budget no greater than 0.25");

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(resolve(tmpdir(), "jouzu-live-flow-"));
const project = resolve(temp, "project");
const digest = (text) => createHash("sha256").update(String(text)).digest("hex").slice(0, 16);

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: root,
		encoding: "utf8",
		timeout: 300_000,
		maxBuffer: 16 * 1024 * 1024,
		...options,
	});
	if (result.error) throw result.error;
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

/** One RPC session driven prompt by prompt, so a status turn can land while a wait is live. */
class LiveSession {
	events = [];
	#child;
	#buffer = "";
	constructor(cli, jouzuHome) {
		this.#child = spawn(
			process.execPath,
			[
				cli,
				"--jouzu-home",
				jouzuHome,
				"--jouzu-profile",
				"core",
				"--mode",
				"rpc",
				"--no-session",
				"--no-context-files",
				"--no-approve",
				"--provider",
				provider,
				"--model",
				model,
				"--tools",
				"bg_task,agent_wait,agent_wait_cancel,agent_results",
			],
			{
				cwd: project,
				env: { ...scrubbedHarnessEnv(), JOUZU_HOME: jouzuHome, JOUZU_NO_UPDATE: "1", JOUZU_FLOW_CONTROL: "1" },
			},
		);
		this.#child.stdout.on("data", (chunk) => {
			this.#buffer += chunk;
			for (let index = this.#buffer.indexOf("\n"); index >= 0; index = this.#buffer.indexOf("\n")) {
				const line = this.#buffer.slice(0, index);
				this.#buffer = this.#buffer.slice(index + 1);
				if (line.trim()) this.events.push(JSON.parse(line));
			}
		});
		this.#child.stderr.on("data", () => {});
	}
	prompt(id, message) {
		this.#child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
	}
	/** Resolve once `predicate` holds, so each stage waits for evidence rather than a fixed delay. */
	async until(predicate, label, timeoutMs) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate(this.events)) return;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		throw new Error(`live flow smoke timed out waiting for ${label}`);
	}
	close() {
		this.#child.stdin.end();
		this.#child.kill("SIGKILL");
	}
}

const toolEnd = (events, name) =>
	events.filter((event) => event.type === "tool_execution_end" && event.toolName === name && !event.isError);
const settled = (events) => events.filter((event) => event.type === "agent_end").length;
/** The wait token the model was given, so a later turn can be checked for reusing it. */
function waitTokens(events) {
	const tokens = new Set();
	for (const event of toolEnd(events, "agent_wait")) {
		const text = JSON.stringify(event.result ?? event.details ?? {});
		for (const match of text.matchAll(/"token":"([0-9a-f-]{36})"/g)) tokens.add(match[1]);
	}
	return [...tokens];
}

const defects = [];
let session;
try {
	mkdirSync(project, { recursive: true });
	let tarball = process.env.JOUZU_PACKED_TARBALL;
	if (!tarball) {
		run("npm", ["run", "build"]);
		const packed = JSON.parse(
			run("npm", ["pack", "--workspace", "jouzu", "--ignore-scripts", "--json", "--pack-destination", temp]).stdout,
		)[0];
		tarball = resolve(temp, packed.filename);
	}
	tarball = resolve(tarball);
	const artifactIntegrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
	run("npm", [
		"install",
		"--prefix",
		resolve(temp, "consumer"),
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		tarball,
	]);
	const cli = resolve(temp, "consumer", "node_modules", "jouzu", "dist", "cli.js");
	session = new LiveSession(cli, resolve(temp, "jouzu-home"));

	// Stage 1: the model must spawn the job and declare a wait from the handles its tool returned.
	session.prompt(
		"declare",
		[
			"Start a background task that runs exactly: sleep 25 && echo swept",
			"Then, before ending your turn, call agent_wait for that task using the exact producer,",
			"handle, execution and until values its tool result printed. Use a 30m deadline.",
			"Do not poll and do not run any other tool.",
		].join("\n"),
	);
	await session.until((events) => toolEnd(events, "bg_task").length > 0, "the background task to start", 120_000);
	await session.until((events) => waitTokens(events).length > 0, "a declared wait", 120_000);
	const declared = waitTokens(session.events);
	if (declared.length !== 1) defects.push("declared-multiple-waits");
	await session.until((events) => settled(events) >= 1, "the declaring turn to settle", 120_000);

	// Stage 2: a user status question must not redeclare, renew, or cancel the live wait.
	const beforeStatus = { settled: settled(session.events), waits: toolEnd(session.events, "agent_wait").length };
	session.prompt("status", "Briefly: what are you waiting on right now? Do not change anything.");
	await session.until((events) => settled(events) > beforeStatus.settled, "the status turn to settle", 120_000);
	if (toolEnd(session.events, "agent_wait").length > beforeStatus.waits) defects.push("redeclared-wait-on-status-turn");
	if (toolEnd(session.events, "agent_wait_cancel").length > 0) defects.push("cancelled-wait-on-status-turn");
	if (waitTokens(session.events).some((token) => !declared.includes(token))) defects.push("renewed-wait-token");

	// Stage 3: the dependency ends, and its decision must arrive as one wake without polling.
	const beforeWake = settled(session.events);
	await session.until((events) => settled(events) > beforeWake, "the composed wake after the job exits", 180_000);
	const wakes = settled(session.events) - beforeWake;
	if (wakes !== 1) defects.push(`composed-wake-count-${wakes}`);

	const assistants = session.events
		.filter((event) => event.type === "agent_end")
		.flatMap((event) => event.messages ?? [])
		.filter((message) => message.role === "assistant");
	const cost = assistants.reduce((total, message) => total + (message.usage?.cost?.total ?? 0), 0);
	if (!Number.isFinite(cost) || cost > budget)
		throw new Error(`live flow smoke cost ${cost} exceeded budget ${budget}`);

	console.log(
		JSON.stringify(
			{
				schemaVersion: 1,
				artifactIntegrity,
				provider,
				model,
				budgetUsd: budget,
				costUsd: cost,
				turns: settled(session.events),
				backgroundTasks: toolEnd(session.events, "bg_task").length,
				waitDeclarations: toolEnd(session.events, "agent_wait").length,
				waitCancellations: toolEnd(session.events, "agent_wait_cancel").length,
				waitTokenDigests: declared.map(digest),
				composedWakes: wakes,
				defects,
				status: defects.length ? "defects" : "passed",
			},
			null,
			2,
		),
	);
	if (defects.length) process.exitCode = 1;
} finally {
	session?.close();
	rmSync(temp, { recursive: true, force: true });
}
