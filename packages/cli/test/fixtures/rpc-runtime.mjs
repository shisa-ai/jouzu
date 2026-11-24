import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const deadlineMs = 30_000;
const inheritedSecretEnv = /^(?:JOUZU_|PI_|SHISA_|AI_AGENT|TEXTGUARD_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AWS_|AZURE_)/u;

/** RPC children started by this process, to name any descendant that outlives them. */
const launched = new Set();

/** RPC children still running or their descendants, on Windows, as "pid name commandLine" lines. */
function survivingDescendants() {
	if (process.platform !== "win32" || !launched.size) return [];
	const ids = [...launched].join(",");
	const script = `Get-CimInstance Win32_Process | Where-Object { @(${ids}) -contains $_.ParentProcessId -or @(${ids}) -contains $_.ProcessId } | ForEach-Object { "$($_.ProcessId) $($_.Name) $($_.CommandLine)" }`;
	const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
		encoding: "utf8",
		windowsHide: true,
		timeout: 15_000,
	});
	return (result.stdout ?? "").split(/\r?\n/u).filter(Boolean);
}

/**
 * Remove a test home. Windows releases a closed process's handles asynchronously, so a just-exited
 * child can briefly keep its working directory busy; retry, and if it stays busy, name what holds it.
 */
async function removeHome(root) {
	try {
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	} catch (error) {
		const survivors = survivingDescendants();
		error.message = `Test home ${root} is still busy: ${error.message}`;
		if (survivors.length) error.message += `; runtime processes still running: ${survivors.join(" | ")}`;
		throw error;
	}
}

/**
 * An isolated Jouzu home whose only model, `fixture/slow`, is served by a local OpenAI-compatible
 * provider on `port`. The home survives restarts within the test.
 */
export async function rpcHome(t, port, { input = ["text"] } = {}) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-rpc-"));
	const runtimes = [];
	// Hooks run in registration order, so this one shuts down every runtime started in the home first.
	t.after(async () => {
		await Promise.all(runtimes.map((shutdown) => shutdown()));
		await removeHome(root);
	});
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
	Object.defineProperty(paths, "runtimes", { value: runtimes });
	const model = { id: "slow", name: "slow", input, reasoning: false, contextWindow: 128000, maxTokens: 4096 };
	await mkdir(join(paths.jouzu, "agent"), { recursive: true, mode: 0o700 });
	await writeFile(
		join(paths.jouzu, "agent", "models.json"),
		JSON.stringify({
			providers: {
				fixture: {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					api: "openai-completions",
					apiKey: "fixture",
					models: [{ ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
				},
			},
		}),
	);
	return paths;
}

/** Start the built CLI in RPC mode with flow control on, in a home from `rpcHome`. */
export function launchRpc(t, paths, extraArgs = []) {
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
			"--provider",
			"fixture",
			"--model",
			"slow",
			"--no-approve",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-tools",
			"--session-dir",
			paths.sessions,
			...extraArgs,
		],
		{ cwd: paths.workspace, env, stdio: ["pipe", "pipe", "pipe"] },
	);
	launched.add(child.pid);
	// Shut down the way a client does, by ending input, so the runtime stops what it started; kill only
	// a runtime that does not exit. Wait for the exit before the home is removed: Windows refuses to
	// delete a running process's working directory.
	const shutdown = async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise((resolve) => child.once("exit", resolve));
		child.stdin.end();
		const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
		let giveUp;
		try {
			await Promise.race([
				exited,
				new Promise((_, reject) => {
					giveUp = setTimeout(
						() =>
							reject(
								new Error(
									`RPC runtime ${child.pid} did not exit within 20 s of end of input and a kill; ${stderr.slice(-2000)}`,
								),
							),
						20_000,
					);
				}),
			]);
		} finally {
			clearTimeout(kill);
			clearTimeout(giveUp);
		}
	};
	paths.runtimes?.push(shutdown);
	t.after(shutdown);
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
	});
	child.stdin.on("error", () => {});
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
	const send = (...commands) => child.stdin.write(commands.map((command) => `${JSON.stringify(command)}\n`).join(""));
	const stop = async () => {
		if (exit) return exit;
		child.kill("SIGKILL");
		return waitFor(() => exit, "rpc exit");
	};
	/** End input, as a client does when it closes, and wait for the runtime's own shutdown. */
	const close = async () => {
		if (!exit) child.stdin.end();
		return waitFor(() => exit, "rpc exit");
	};
	return { frames, send, waitFor, stop, close };
}

export const response = (frames, id) => frames.find((frame) => frame.type === "response" && frame.id === id);
export const count = (frames, type) => frames.filter((frame) => frame.type === type).length;
/** The latest JSON status a Jouzu extension published under `key`. */
export const lastStatus = (frames, key) => {
	const status = frames.findLast(
		(frame) => frame.type === "extension_ui_request" && frame.method === "setStatus" && frame.statusKey === key,
	);
	return status ? JSON.parse(status.statusText) : undefined;
};
export const quiet = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
