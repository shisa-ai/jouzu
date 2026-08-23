#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const packageName = "@earendil-works/pi-coding-agent";
const lock = JSON.parse(readFileSync(resolve(root, "upstream", "pi.lock.json"), "utf8"));
const expectedVersion = lock.packages[packageName].version;
const piPackageRoot = resolve(root, "node_modules", packageName);
const cli = resolve(piPackageRoot, "dist", "cli.js");
const systemPromptSource = resolve(piPackageRoot, "dist", "core", "system-prompt.js");
const keybindingsSource = resolve(piPackageRoot, "dist", "core", "keybindings.js");
const customEditorSource = resolve(piPackageRoot, "dist", "modes", "interactive", "components", "custom-editor.js");
const interactiveModeSource = resolve(piPackageRoot, "dist", "modes", "interactive", "interactive-mode.js");
const mainSource = resolve(piPackageRoot, "dist", "main.js");
const nestedTuiKeybindingsSource = resolve(
	piPackageRoot,
	"node_modules",
	"@earendil-works",
	"pi-tui",
	"dist",
	"keybindings.js",
);
const tuiKeybindingsSource = existsSync(nestedTuiKeybindingsSource)
	? nestedTuiKeybindingsSource
	: resolve(root, "node_modules", "@earendil-works", "pi-tui", "dist", "keybindings.js");
const expectedDefaultIdentity =
	"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

function runNode(args, options = {}) {
	const result = spawnSync(process.execPath, args, {
		cwd: root,
		encoding: "utf8",
		timeout: 30_000,
		...options,
	});
	if (result.error) throw result.error;
	assert.equal(result.signal, null, `child terminated by ${result.signal}: ${result.stderr}`);
	assert.equal(result.status, 0, `child exited ${result.status}: ${result.stderr || result.stdout}`);
	return result;
}

assert.ok(existsSync(cli), `Pi CLI is missing: ${cli}`);
assert.ok(existsSync(systemPromptSource), `Pi system prompt source is missing: ${systemPromptSource}`);
for (const path of [keybindingsSource, customEditorSource, interactiveModeSource, mainSource, tuiKeybindingsSource]) {
	assert.ok(existsSync(path), `Pi keybinding contract source is missing: ${path}`);
}
assert.ok(
	readFileSync(systemPromptSource, "utf8").includes(expectedDefaultIdentity),
	"Pi default identity changed; review Jouzu's exact-prefix branding before qualifying this Pi version",
);
const keybindingsText = readFileSync(keybindingsSource, "utf8");
assert.match(keybindingsText, /"app\.message\.followUp": \{\s*defaultKeys: "alt\+enter"/);
assert.match(keybindingsText, /"app\.message\.dequeue": \{\s*defaultKeys: "alt\+up"/);
assert.match(readFileSync(tuiKeybindingsSource, "utf8"), /"tui\.input\.tab": \{ defaultKeys: "tab"/);
const editorText = readFileSync(customEditorSource, "utf8");
assert.ok(
	editorText.indexOf("// Check all other app actions") < editorText.indexOf("// Pass to parent for editor handling"),
	"Pi editor no longer gives application actions priority over ordinary Tab/editor handling",
);
assert.ok(
	editorText.includes("this.isShowingAutocomplete()") &&
		editorText.indexOf('this.keybindings.matches(data, "tui.input.tab")') <
			editorText.indexOf("// Check all other app actions"),
	"Pi editor no longer preserves open autocomplete selection before app-level Tab actions",
);
const { KeybindingsManager } = await import(pathToFileURL(keybindingsSource));
const jouzuBindings = new KeybindingsManager({ "app.message.followUp": "ctrl+enter" });
assert.equal(jouzuBindings.matches("\u001b[13;5u", "app.message.followUp"), true);
assert.equal(jouzuBindings.matches("\u001b[27;5;13~", "app.message.followUp"), true);
assert.equal(jouzuBindings.matches("\t", "app.message.followUp"), false);
assert.equal(jouzuBindings.matches("\t", "tui.input.tab"), true);
const interactiveText = readFileSync(interactiveModeSource, "utf8");
assert.ok(interactiveText.includes('onAction("app.message.followUp"'), "Pi editor lost the follow-up semantic action");
assert.ok(interactiveText.includes('onAction("app.message.dequeue"'), "Pi editor lost the dequeue semantic action");
assert.ok(
	interactiveText.includes("tryHostModelPicker"),
	"Pi interactive mode lost the embedding-host model picker hook",
);
assert.ok(
	readFileSync(mainSource, "utf8").includes("HOST_MODEL_PICKER_API_VERSION = 1"),
	"Pi main entry lost host model-picker API version 1",
);

const version = runNode([cli, "--version"], { env: { ...process.env, PI_OFFLINE: "1" } }).stdout.trim();
assert.equal(version, expectedVersion, "Pi CLI version differs from the exact lock");

const help = runNode([cli, "--help"], { env: { ...process.env, PI_OFFLINE: "1" } }).stdout;
for (const required of ["--mode <mode>", "--provider <name>", "--session-dir <dir>", "--no-context-files"]) {
	assert.match(help, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `Pi help lost ${required}`);
}

const temp = mkdtempSync(join(tmpdir(), "jouzu-pi-contract-"));
try {
	const agentDir = resolve(temp, "agent");
	const sessionDir = resolve(temp, "sessions");
	const apiProbe = `
process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(agentDir)};
const pi = await import(${JSON.stringify(packageName)});
const required = ["main", "getAgentDir", "SessionManager", "ModelRuntime", "DefaultResourceLoader", "HOST_MODEL_PICKER_API_VERSION"];
for (const name of required) {
  if (pi[name] === undefined) throw new Error("missing top-level export " + name);
}
if (typeof pi.main !== "function") throw new Error("main is not a function");
if (pi.HOST_MODEL_PICKER_API_VERSION !== 1) throw new Error("host model picker API version is not 1");
if (pi.getAgentDir() !== ${JSON.stringify(agentDir)}) {
  throw new Error("PI_CODING_AGENT_DIR was not honored: " + pi.getAgentDir());
}
process.stdout.write(JSON.stringify({ exports: required, agentDir: pi.getAgentDir() }));
`;
	const api = JSON.parse(
		runNode(["--input-type=module", "--eval", apiProbe], {
			env: { ...process.env, PI_OFFLINE: "1" },
		}).stdout,
	);
	assert.equal(api.agentDir, agentDir);

	const rpcInput = `${JSON.stringify({ id: "state", type: "get_state" })}\n`;
	const rpc = runNode(
		[
			cli,
			"--mode",
			"rpc",
			"--no-session",
			"--no-context-files",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-tools",
			"--no-approve",
		],
		{
			input: rpcInput,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				PI_CODING_AGENT_SESSION_DIR: sessionDir,
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				PI_TELEMETRY: "0",
			},
		},
	);
	const records = rpc.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const state = records.find((record) => record.id === "state" && record.command === "get_state");
	assert.ok(state, `RPC get_state response missing: ${rpc.stdout}`);
	assert.equal(state.success, true);
	assert.equal(state.data.isStreaming, false);
	assert.equal(state.data.sessionFile, undefined, "--no-session unexpectedly persisted a session");
	assert.equal(existsSync(sessionDir), false, "--no-session unexpectedly created the session override directory");

	console.log(
		JSON.stringify(
			{
				version: expectedVersion,
				apiExports: api.exports,
				cli: ["version", "help"],
				rpc: ["startup", "get_state", "no-session", "isolated-agent-dir"],
				prompt: ["default-identity"],
				keybindings: [
					"semantic-message-actions",
					"ctrl-enter-follow-up",
					"app-before-editor-routing",
					"autocomplete-before-app-tab",
					"tab-editor-default",
				],
				host: ["model-picker-api-v1", "session-only-model-selection"],
			},
			null,
			2,
		),
	);
} finally {
	rmSync(temp, { recursive: true, force: true });
}
