import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const deadlineMs = 30_000;
const inheritedSecretEnv = /^(?:JOUZU_|PI_|SHISA_|AI_AGENT|TEXTGUARD_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AWS_|AZURE_)/u;

/**
 * Launch the built CLI in RPC mode with the production flow ingress and host boundary. End-of-input
 * shutdown has to stay bounded when the production boundary joins a command frame that never
 * settles, which a pass-through fixture cannot reproduce.
 */
async function launch(t, extension) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-eof-rpc-"));
	const paths = {
		home: join(root, "home"),
		config: join(root, "config"),
		state: join(root, "state"),
		cache: join(root, "cache"),
		runtime: join(root, "runtime"),
		workspace: join(root, "workspace"),
		sessions: join(root, "sessions"),
		agent: join(root, "agent"),
		jouzu: join(root, "jouzu"),
	};
	for (const path of Object.values(paths)) await mkdir(path, { recursive: true, mode: 0o700 });
	const extensionPath = join(root, "fixture.mjs");
	await writeFile(extensionPath, extension);
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !inheritedSecretEnv.test(key)));
	Object.assign(env, {
		HOME: paths.home,
		USERPROFILE: paths.home,
		XDG_CONFIG_HOME: paths.config,
		XDG_STATE_HOME: paths.state,
		XDG_CACHE_HOME: paths.cache,
		XDG_RUNTIME_DIR: paths.runtime,
		PI_CODING_AGENT_DIR: paths.agent,
		PI_CODING_AGENT_SESSION_DIR: paths.sessions,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		DISABLE_AUTOUPDATER: "1",
		JOUZU_HOME: paths.jouzu,
		JOUZU_FLOW_CONTROL: "1",
		LANG: "C.UTF-8",
		TERM: "dumb",
	});
	const child = spawn(
		process.execPath,
		[
			cli,
			"--jouzu-home",
			paths.jouzu,
			"--jouzu-profile",
			"core",
			"--mode",
			"rpc",
			"--offline",
			"--no-approve",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-tools",
			"--session-dir",
			paths.sessions,
			"-e",
			extensionPath,
		],
		{ cwd: paths.workspace, env, stdio: ["pipe", "pipe", "pipe"] },
	);
	t.after(async () => {
		if (child.exitCode === null) child.kill("SIGKILL");
		await rm(root, { recursive: true, force: true });
	});
	const events = new EventEmitter();
	const frames = [];
	let stderr = "";
	let buffer = "";
	let exit;
	child.stdout.setEncoding("utf8").on("data", (chunk) => {
		buffer += chunk;
		while (buffer.includes("\n")) {
			const newline = buffer.indexOf("\n");
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (!line.trim()) continue;
			try {
				frames.push(JSON.parse(line));
			} catch {
				stderr += `\nUnexpected stdout: ${line.slice(0, 200)}`;
			}
		}
		events.emit("change");
	});
	child.stderr.setEncoding("utf8").on("data", (chunk) => {
		stderr += chunk;
		events.emit("change");
	});
	child.stdin.on("error", () => {});
	child.on("error", (error) => {
		stderr += `\nSpawn error: ${error.message}`;
		events.emit("change");
	});
	child.on("close", (code, signal) => {
		exit = { code, signal };
		events.emit("change");
	});
	function waitFor(check, label, timeout = deadlineMs) {
		return new Promise((resolve, reject) => {
			const finish = (error, value) => {
				clearTimeout(timer);
				events.off("change", inspect);
				if (error) reject(error);
				else resolve(value);
			};
			const inspect = () => {
				const value = check();
				if (value) finish(undefined, value);
				else if (exit) finish(new Error(`${label}: exited ${JSON.stringify(exit)}; ${stderr}`));
			};
			const timer = setTimeout(
				() => finish(new Error(`${label} deadline; ${stderr}; frames=${JSON.stringify(frames.slice(-3))}`)),
				timeout,
			);
			events.on("change", inspect);
			inspect();
		});
	}
	return { child, frames, stderr: () => stderr, exit: () => exit, waitFor };
}

const shutdownDiagnostics = (frames) =>
	frames.filter((frame) => frame.type === "response" && frame.command === "shutdown" && !frame.success);

test("a native command that never settles does not hold end-of-input shutdown", async (t) => {
	const f = await launch(
		t,
		`
export default function (pi) {
	pi.registerCommand("fixture-stall", {
		handler: async (args, ctx) => {
			ctx.ui.notify("fixture stall started");
			await new Promise(() => { });
		}
	});
}
`,
	);
	f.child.stdin.write(`${JSON.stringify({ id: "stall", type: "prompt", message: "/fixture-stall" })}\n`);
	await f.waitFor(
		() => f.frames.find((frame) => frame.type === "extension_ui_request" && frame.method === "notify"),
		"stall notify",
	);
	f.child.stdin.end();
	const exit = await f.waitFor(() => f.exit(), "bounded EOF exit", 25_000);
	assert.equal(exit.signal, null, f.stderr());
	assert.equal(exit.code, 1, f.stderr());
	const responses = f.frames.filter((frame) => frame.type === "response" && frame.id === "stall");
	assert.equal(responses.length, 1, JSON.stringify(f.frames));
	assert.equal(responses[0].success, false);
	assert.match(responses[0].error, /accepted command did not settle within 5000ms/u);
	const diagnostics = shutdownDiagnostics(f.frames);
	assert.equal(diagnostics.length, 1, JSON.stringify(f.frames));
	assert.match(diagnostics[0].error, /end-of-input cleanup did not complete within 5000ms/u);
});

test("a session_shutdown handler that never settles does not hold end-of-input shutdown", async (t) => {
	const f = await launch(
		t,
		`
export default function (pi) {
	pi.on("session_shutdown", async () => {
		await new Promise(() => { });
	});
}
`,
	);
	f.child.stdin.write(`${JSON.stringify({ id: "history", type: "get_messages" })}\n`);
	await f.waitFor(
		() => f.frames.find((frame) => frame.type === "response" && frame.id === "history"),
		"history response",
	);
	f.child.stdin.end();
	const exit = await f.waitFor(() => f.exit(), "bounded EOF exit", 25_000);
	assert.equal(exit.signal, null, f.stderr());
	assert.equal(exit.code, 1, f.stderr());
	const responses = f.frames.filter((frame) => frame.type === "response" && frame.id === "history");
	assert.equal(responses.length, 1, JSON.stringify(f.frames));
	assert.equal(responses[0].success, true);
	const diagnostics = shutdownDiagnostics(f.frames);
	assert.equal(diagnostics.length, 1, JSON.stringify(f.frames));
	assert.match(diagnostics[0].error, /end-of-input cleanup did not complete within 5000ms/u);
});
