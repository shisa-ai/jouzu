#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const packageDirectory = resolve(root, "packages", "cli");
const packageJson = JSON.parse(readFileSync(resolve(packageDirectory, "package.json"), "utf8"));
const piLock = JSON.parse(readFileSync(resolve(root, "upstream", "pi.lock.json"), "utf8"));
const piVersion = piLock.packages["@earendil-works/pi-coding-agent"].version;
const npmExecPath = process.env.npm_execpath;
const npmCommand = npmExecPath
	? process.execPath
	: process.platform === "win32"
		? (process.env.ComSpec ?? "cmd.exe")
		: "npm";
const npmPrefix = npmExecPath ? [npmExecPath] : process.platform === "win32" ? ["/d", "/s", "/c", "npm"] : [];

function run(command, args, options = {}) {
	const { expectedStatus = 0, ...spawnOptions } = options;
	const result = spawnSync(command, args, {
		encoding: "utf8",
		timeout: 120_000,
		maxBuffer: 128 * 1024 * 1024,
		...spawnOptions,
	});
	if (result.error) throw result.error;
	assert.equal(result.signal, null, `${command} terminated by ${result.signal}: ${result.stderr}`);
	assert.equal(result.status, expectedStatus, `${command} exited ${result.status}: ${result.stderr || result.stdout}`);
	return result;
}

function runNpm(args, options = {}) {
	const timeout = process.platform === "win32" ? 1_800_000 : 300_000;
	return run(npmCommand, [...npmPrefix, ...args], { timeout, ...options });
}

function scrubbedHarnessEnv() {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key === "AI_AGENT" || /^JOUZU_/.test(key) || /^PI_CODING_AGENT(?:_|$)/.test(key)) continue;
		env[key] = value;
	}
	return env;
}

function cleanupTemp(path) {
	try {
		rmSync(path, { recursive: true, force: true });
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		if (process.platform !== "win32" || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(String(code))) throw error;
		console.warn(`packed smoke left a Windows temp directory for runner cleanup: ${path} (${code})`);
	}
}

function rpcResponse(stdout, id) {
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		const value = JSON.parse(line);
		if (value.id === id && value.type === "response") return value;
	}
	throw new Error(`RPC response ${id} was not found`);
}

function writeInstalledPiPackage(agentDir, name, version, extensionSource) {
	const root = resolve(agentDir, "npm", "node_modules", ...name.split("/"));
	mkdirSync(root, { recursive: true });
	writeFileSync(
		resolve(root, "package.json"),
		`${JSON.stringify({ name, version, type: "module", pi: { extensions: ["index.ts"] } }, null, 2)}\n`,
	);
	writeFileSync(resolve(root, "index.ts"), extensionSource);
}

/**
 * Prove the packed launcher installs the flow assembly when enabled, removes its surface
 * when explicitly disabled, and resolves one Pi tree so the provider
 * route guard's ModelRuntime.prototype comparison is unambiguous in a real install.
 *
 * Stdin stays open while the probe runs. Closing it starts RPC shutdown, and a prompt still in
 * flight then fails against the disposed ingress; that shutdown race is tracked separately.
 */
async function probeFlowSurfaces(installedCli, probe, cwd, env, label) {
	const child = spawn(
		process.execPath,
		[installedCli, "pi", "--extension", probe, "--mode", "rpc", "--no-session", "--no-context-files"],
		{ cwd, env },
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	child.stdout.on("data", () => {});
	child.stdin.write(`${JSON.stringify({ id: "probe", type: "prompt", message: "/jouzu-surface-probe" })}\n`);
	const marker = await new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${label}: probe timed out. stderr=${stderr.slice(0, 600)}`)),
			90_000,
		);
		const check = () => {
			const line = stderr.split("\n").find((entry) => entry.startsWith("JOUZU_SURFACE_PROBE="));
			if (!line) return;
			clearTimeout(timer);
			clearInterval(poll);
			resolve(line);
		};
		const poll = setInterval(check, 100);
	});
	child.stdin.end();
	child.kill("SIGKILL");
	assert.equal(stderr.includes("Jouzu flow control:"), false, `${label}: the launcher reported a flow-control failure`);
	return JSON.parse(marker.slice("JOUZU_SURFACE_PROBE=".length));
}

async function assertPackedFlowControl(temp, installedCli, probe, cwd, env, profile) {
	const flowTools = ["agent_wait", "agent_wait_cancel", "agent_results"];
	const off = await probeFlowSurfaces(
		installedCli,
		probe,
		cwd,
		{ ...env, JOUZU_FLOW_CONTROL: "0" },
		`${profile} flow=off`,
	);
	for (const tool of flowTools)
		assert.equal(off.tools.includes(tool), false, `${profile} flow: ${tool} present while opt-out`);
	assert.equal(off.commands.includes("flow"), false, `${profile} flow: /flow present while opt-out`);
	const on = await probeFlowSurfaces(
		installedCli,
		probe,
		cwd,
		{ ...env, JOUZU_FLOW_CONTROL: "1" },
		`${profile} flow=on`,
	);
	for (const tool of flowTools) assert.ok(on.tools.includes(tool), `${profile} flow: missing ${tool} when enabled`);
	assert.ok(on.commands.includes("flow"), `${profile} flow: missing /flow when enabled`);
	// A single resolved Pi tree is what makes the route guard's prototype identity check meaningful.
	const trees = readdirSync(resolve(temp, "node_modules"), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name === "pi-coding-agent")
		.map((entry) => join(entry.parentPath, entry.name));
	assert.equal(trees.length, 1, `${profile} flow: expected one packed Pi tree, found ${trees.join(", ")}`);
}

function probePackedSurfaces(installedCli, probe, cwd, env, profile) {
	const result = run(
		process.execPath,
		[installedCli, "pi", "--extension", probe, "--mode", "rpc", "--no-session", "--no-context-files"],
		{
			cwd,
			env,
			input: `${JSON.stringify({ id: "probe", type: "prompt", message: "/jouzu-surface-probe" })}\n${JSON.stringify({ id: "commands", type: "get_commands" })}\n`,
		},
	);
	const marker = result.stderr.split("\n").find((line) => line.startsWith("JOUZU_SURFACE_PROBE="));
	assert.ok(marker, `${profile}: ${result.stderr}`);
	return { result, surfaces: JSON.parse(marker.slice("JOUZU_SURFACE_PROBE=".length)) };
}

function assertPackedSurfaces(installedCli, probe, cwd, env, profile) {
	const { result, surfaces } = probePackedSurfaces(installedCli, probe, cwd, env, profile);
	for (const tool of [
		"TaskCreate",
		"TaskList",
		"batch_web_fetch",
		"bg_task",
		"get_goal",
		"multiloop_start",
		"schedule_prompt",
		"tff-fetch_url",
		"tff-search_web",
		"update_goal",
		"vcc_recall",
		"web_fetch",
	]) {
		assert.ok(surfaces.tools.includes(tool), `${profile}: missing tool ${tool}`);
	}
	for (const command of [
		"goal",
		"multiloop",
		"pi-vcc",
		"schedule-prompt",
		"skill:jouzu-anti-slop",
		"skill:jouzu-clear-writing",
		"skill:jouzu-delegation",
		"skill:jouzu-source-check",
		"skill:multiloop",
		"status",
		"tasks",
		"textguard",
	]) {
		assert.ok(surfaces.commands.includes(command), `${profile}: missing command ${command}`);
	}
	assert.equal(surfaces.commands.includes("skill:jouzu-core"), false);
	assert.equal(rpcResponse(result.stdout, "probe").success, true);
	assert.equal(rpcResponse(result.stdout, "commands").success, true);
}

/**
 * Run the packed CLI's actual write and edit tools through a loopback provider and prove an
 * absent U+3000 path stays exact: the write creates the exact file without touching an
 * existing ASCII-space sibling sentinel, and the missing edit fails without mutating it.
 * The runtime write route is the bundled pi-code-previews override, so a source-only Pi
 * import cannot cover this regression.
 */
async function assertPackedUnicodePaths(installedCli, temp) {
	const expected = "日本語のツール確認\n完了 🦁";
	const project = resolve(temp, "日本語　project-unicode");
	mkdirSync(project, { recursive: true });
	const absolutePath = resolve(project, "絶対　確認.txt");
	const relativePath = "相対　確認.txt";
	const editPath = resolve(project, "編集　確認.txt");
	const asciiSibling = resolve(temp, "日本語 project-unicode");
	mkdirSync(asciiSibling, { recursive: true });
	const absoluteSentinel = resolve(asciiSibling, "絶対 確認.txt");
	const relativeSentinel = resolve(asciiSibling, "相対 確認.txt");
	const editSentinel = resolve(asciiSibling, "編集 確認.txt");
	writeFileSync(absoluteSentinel, "absolute sentinel");
	writeFileSync(relativeSentinel, "relative sentinel");
	writeFileSync(editSentinel, "edit sentinel");
	let step = 0;
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => (body += chunk));
		request.on("end", () => {
			const index = step++;
			const send = (payload) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
			};
			const toolCall = (id, name, args) =>
				send({
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
							},
							finish_reason: "tool_calls",
						},
					],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				});
			if (index === 0) return toolCall("call_write_absolute", "write", { path: absolutePath, content: expected });
			if (index === 1) return toolCall("call_write_relative", "write", { path: relativePath, content: expected });
			if (index === 2) return toolCall("call_read", "read", { path: absolutePath });
			if (index === 3)
				return toolCall("call_edit_missing", "edit", {
					path: editPath,
					edits: [{ oldText: "edit sentinel", newText: "changed" }],
				});
			return send({
				choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		});
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	try {
		const home = resolve(temp, "unicode-home");
		mkdirSync(resolve(home, "agent"), { recursive: true });
		writeFileSync(
			resolve(home, "agent", "models.json"),
			`${JSON.stringify(
				{
					providers: {
						loopback: {
							baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
							api: "openai-completions",
							apiKey: "loopback",
							compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
							models: [
								{
									id: "loopback-model",
									name: "Loopback",
									reasoning: false,
									input: ["text"],
									contextWindow: 8192,
									maxTokens: 512,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								},
							],
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		const env = { ...scrubbedHarnessEnv(), PI_OFFLINE: "1" };
		const child = spawn(
			process.execPath,
			[
				installedCli,
				"--jouzu-home",
				home,
				"--jouzu-profile",
				"ja",
				"--mode",
				"json",
				"--no-session",
				"--provider",
				"loopback",
				"--model",
				"loopback-model",
				"--tools",
				"read,write,edit",
				"write ツールで絶対パスと相対パスにファイルを作成し、read ツールで確認してください。",
			],
			{ cwd: project, env, stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		const status = await new Promise((done, reject) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error(`packed unicode path smoke timed out: ${stderr.slice(0, 600)}`));
			}, 120_000);
			child.on("close", (code) => {
				clearTimeout(timer);
				done(code);
			});
		});
		assert.equal(status, 0, `packed unicode path smoke exited ${status}: ${stderr || stdout}`);
		const events = stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return undefined;
				}
			})
			.filter(Boolean);
		const writes = events.filter((event) => event.type === "tool_execution_end" && event.toolName === "write");
		assert.equal(writes.length, 2, "packed unicode path smoke did not run both writes");
		assert.ok(
			writes.every((event) => !event.isError),
			"packed unicode path smoke write failed",
		);
		assert.equal(readFileSync(absolutePath, "utf8"), expected);
		assert.equal(readFileSync(resolve(project, relativePath), "utf8"), expected);
		assert.equal(readFileSync(absoluteSentinel, "utf8"), "absolute sentinel");
		assert.equal(readFileSync(relativeSentinel, "utf8"), "relative sentinel");
		assert.equal(readFileSync(editSentinel, "utf8"), "edit sentinel");
		const edits = events.filter((event) => event.type === "tool_execution_end" && event.toolName === "edit");
		assert.equal(edits.length, 1, "packed unicode path smoke did not run the edit probe");
		assert.equal(edits[0].isError, true, "a missing U+3000 edit must fail");
		assert.equal(existsSync(editPath), false, "a missing U+3000 edit must not create the exact file");
	} finally {
		await new Promise((done) => server.close(done));
	}
}

const temp = mkdtempSync(join(tmpdir(), "jouzu-packed-cli-"));
try {
	let tarball;
	if (process.env.JOUZU_PACKED_TARBALL) {
		tarball = resolve(process.env.JOUZU_PACKED_TARBALL);
		assert.ok(existsSync(tarball), `prepared Jouzu tarball does not exist: ${tarball}`);
	} else {
		const packResult = runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", temp], {
			cwd: packageDirectory,
		});
		const [packed] = JSON.parse(packResult.stdout);
		tarball = resolve(temp, packed.filename);
	}
	const scope = process.env.JOUZU_PACKED_SCOPE ?? "all";
	assert.ok(["all", "local", "npm-exec", "global"].includes(scope), `unsupported packed smoke scope: ${scope}`);
	const baseEnv = { ...scrubbedHarnessEnv(), PI_OFFLINE: "1" };
	if (scope === "all" || scope === "local") {
		const consumer = resolve(temp, "consumer");
		writeFileSync(
			resolve(temp, "package.json"),
			`${JSON.stringify({ name: "jouzu-packed-smoke", version: "1.0.0", private: true }, null, 2)}\n`,
		);
		runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", tarball], { cwd: temp });
		const consumerLock = JSON.parse(readFileSync(resolve(temp, "package-lock.json"), "utf8"));
		const installedPi = consumerLock.packages["node_modules/@earendil-works/pi-coding-agent"];
		if (installedPi) {
			assert.equal(installedPi.version, piVersion);
			assert.equal(installedPi.integrity, piLock.packages["@earendil-works/pi-coding-agent"].integrity);
		} else {
			const bundledPi = JSON.parse(
				readFileSync(
					resolve(temp, "node_modules", "jouzu", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
					"utf8",
				),
			);
			assert.equal(bundledPi.version, piVersion);
		}

		const installedRoot = resolve(temp, "node_modules", "jouzu");
		const jouzuRequire = createRequire(resolve(installedRoot, "package.json"));
		const webaioRequire = createRequire(resolve(installedRoot, "node_modules", "pi-webaio", "package.json"));
		assert.equal(webaioRequire.resolve("wreq-js"), jouzuRequire.resolve("wreq-js"));
		const installedCli = resolve(temp, "node_modules", "jouzu", "dist", "cli.js");
		const nativeModule = pathToFileURL(resolve(installedRoot, "dist", "textguard-native.js")).href;
		run(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				`import assert from "node:assert/strict";
				import { NativeTextGuard } from ${JSON.stringify(nativeModule)};
				const scanner = new NativeTextGuard();
				try {
					assert.equal((await scanner.scan("日本語の資料を確認します。")).status, "clear");
					assert.match(scanner.identity, /^[a-f0-9]{64}$/);
					const flagged = await scanner.scan("packed\\u202econtent");
					assert.equal(flagged.status, "findings");
					assert.ok(flagged.severityCounts.error > 0);
					assert.equal((await scanner.scan("after findings")).status, "clear");
				} finally { await scanner.close(); }
				assert.equal((await scanner.scan("closed")).reason, "closed");`,
			],
			{ cwd: temp, env: baseEnv },
		);
		const probe = resolve(temp, "surface-probe.js");
		writeFileSync(
			probe,
			`export default function (pi) {
			pi.registerCommand("jouzu-surface-probe", {
				handler: async () => {
					const tools = pi.getAllTools().map((tool) => tool.name).sort();
					const commands = pi.getCommands().map((command) => command.name).sort();
					process.stderr.write("JOUZU_SURFACE_PROBE=" + JSON.stringify({ tools, commands }) + "\\n");
				},
			});
		}
`,
		);
		const env = { ...baseEnv, JOUZU_HOME: consumer };
		const version = run(process.execPath, [installedCli, "--version"], { cwd: temp, env }).stdout.trim();
		assert.equal(version, `jouzu ${packageJson.version}\npi ${piVersion}\nprofile schema 1`);
		const firstPlan = JSON.parse(
			run(process.execPath, [installedCli, "profile", "plan", "--json"], { cwd: temp, env }).stdout,
		);
		assert.equal(firstPlan.profile, "core");
		assert.ok(firstPlan.actions.some((action) => action.type === "create"));
		assert.equal(existsSync(consumer), false, "packed profile plan mutated the consumer home");
		const keyPlan = JSON.parse(
			run(process.execPath, [installedCli, "keybindings", "plan", "--json"], { cwd: temp, env }).stdout,
		);
		assert.equal(keyPlan.status, "uninitialized");
		assert.equal(keyPlan.actions.length, 2);
		run(process.execPath, [installedCli, "keybindings", "apply"], { cwd: temp, env });
		assert.deepEqual(JSON.parse(readFileSync(resolve(consumer, "agent", "keybindings.json"), "utf8")), {
			"app.message.followUp": "ctrl+enter",
			"app.message.dequeue": "ctrl+up",
		});
		run(process.execPath, [installedCli, "profile", "apply"], { cwd: temp, env });
		const secondPlan = JSON.parse(
			run(process.execPath, [installedCli, "profile", "plan", "--json"], { cwd: temp, env }).stdout,
		);
		assert.equal(secondPlan.profile, "core");
		assert.deepEqual(secondPlan.actions, []);
		assertPackedSurfaces(installedCli, probe, temp, env, "core");
		await assertPackedFlowControl(temp, installedCli, probe, temp, env, "core");
		await assertPackedUnicodePaths(installedCli, temp);
		assert.equal(
			existsSync(resolve(consumer, "state", "camoufox-runtime")),
			false,
			"ordinary packed startup installed the optional Camoufox runtime",
		);
		const jaPlan = JSON.parse(
			run(process.execPath, [installedCli, "profile", "plan", "--profile", "ja", "--json"], { cwd: temp, env }).stdout,
		);
		assert.ok(jaPlan.actions.some((action) => action.target === "APPEND_SYSTEM.md"));
		run(process.execPath, [installedCli, "profile", "apply", "--profile", "ja"], { cwd: temp, env });
		assertPackedSurfaces(installedCli, probe, temp, env, "ja");
		run(process.execPath, [installedCli, "profile", "apply", "--profile", "core"], { cwd: temp, env });
		assert.equal(existsSync(resolve(consumer, "agent", "APPEND_SYSTEM.md")), false);

		const upgradeConsumer = resolve(temp, "upgrade-consumer");
		const upgradeAgentDir = resolve(upgradeConsumer, "agent");
		mkdirSync(upgradeAgentDir, { recursive: true });
		writeInstalledPiPackage(
			upgradeAgentDir,
			"@sting8k/pi-vcc",
			"0.6.1",
			`export default function (pi) {
			pi.registerTool({
				name: "vcc_recall",
				label: "duplicate",
				description: "duplicate",
				parameters: { type: "object", properties: {} },
				async execute() { return { content: [{ type: "text", text: "duplicate" }], details: {} }; },
			});
		}
`,
		);
		writeInstalledPiPackage(
			upgradeAgentDir,
			"jouzu-packed-user-fixture",
			"1.0.0",
			`export default function (pi) {
			pi.registerCommand("packed-user-fixture", { handler: async () => {} });
		}
`,
		);
		const upgradeSettingsPath = resolve(upgradeAgentDir, "settings.json");
		const upgradeSettings = `${JSON.stringify(
			{ packages: ["npm:@sting8k/pi-vcc@0.6.1", "npm:jouzu-packed-user-fixture@1.0.0"] },
			null,
			2,
		)}\n`;
		writeFileSync(upgradeSettingsPath, upgradeSettings);
		const upgradeEnv = { ...scrubbedHarnessEnv(), JOUZU_HOME: upgradeConsumer, PI_OFFLINE: "1" };
		const upgradeRun = run(
			process.execPath,
			[installedCli, "pi", "--mode", "rpc", "--no-session", "--no-context-files"],
			{
				cwd: temp,
				env: upgradeEnv,
				input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`,
			},
		);
		assert.doesNotMatch(upgradeRun.stderr, /conflicts with/u);
		const upgradeCommands = rpcResponse(upgradeRun.stdout, "commands").data.commands.map((command) => command.name);
		assert.ok(upgradeCommands.includes("pi-vcc"));
		assert.ok(upgradeCommands.includes("packed-user-fixture"));
		assert.equal(readFileSync(upgradeSettingsPath, "utf8"), upgradeSettings);
		const upgradeList = run(process.execPath, [installedCli, "list"], { cwd: temp, env: upgradeEnv }).stdout;
		assert.match(upgradeList, /npm:@sting8k\/pi-vcc@0\.6\.1/u);
		assert.match(upgradeList, /npm:jouzu-packed-user-fixture@1\.0\.0/u);

		const qualified = piLock.compatibilityStatus === "qualified";
		const doctor = run(process.execPath, [installedCli, "doctor"], {
			cwd: temp,
			env,
			expectedStatus: qualified ? 0 : 1,
		}).stdout;
		assert.match(doctor, /Install channel +local npm install/u);
		assert.match(doctor, /Selected profile +core/u);
		assert.match(doctor, qualified ? /✓ 0 problems/u : /✗ \d+ problem/u);
		const pi = run(process.execPath, [installedCli, "pi", "--version"], { cwd: temp, env }).stdout.trim();
		assert.equal(pi, piVersion);

		for (const binName of ["jouzu", "jz"]) {
			const bin = resolve(temp, "node_modules", ".bin", process.platform === "win32" ? `${binName}.cmd` : binName);
			const result =
				process.platform === "win32"
					? run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", bin, "--version"], { cwd: temp, env })
					: run(bin, ["--version"], { cwd: temp, env });
			assert.match(result.stdout, new RegExp(`^jouzu ${packageJson.version}`, "m"));
		}
	}

	if (scope === "all" || scope === "npm-exec") {
		const npmExec = runNpm(["exec", "--yes", "--package", tarball, "--", "jouzu", "--version"], {
			cwd: temp,
			env: baseEnv,
		});
		assert.match(npmExec.stdout, new RegExp(`^jouzu ${packageJson.version}`, "m"));
	}

	if (scope === "all" || scope === "global") {
		const globalPrefix = resolve(temp, "global");
		runNpm([
			"install",
			"--global",
			"--prefix",
			globalPrefix,
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--loglevel=error",
			tarball,
		]);
		const globalBin =
			process.platform === "win32" ? resolve(globalPrefix, "jouzu.cmd") : resolve(globalPrefix, "bin", "jouzu");
		const globalEnv = { ...baseEnv, JOUZU_HOME: resolve(temp, "global-home"), npm_config_prefix: globalPrefix };
		const runGlobal = (args) =>
			process.platform === "win32"
				? run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", globalBin, ...args], {
						cwd: temp,
						env: globalEnv,
					})
				: run(globalBin, args, { cwd: temp, env: globalEnv });
		const globalVersion = runGlobal(["--version"]);
		assert.match(globalVersion.stdout, new RegExp(`^jouzu ${packageJson.version}`, "m"));
		const globalUpdate = JSON.parse(runGlobal(["self-update", "status", "--json"]).stdout);
		assert.equal(globalUpdate.installChannel, "global-npm");
		assert.equal(globalUpdate.policy, "auto-restart");
		assert.equal(globalUpdate.startupEligible, true);
	}

	console.log(`packed jouzu@${packageJson.version} passed ${scope} smoke with Pi ${piVersion}`);
} finally {
	cleanupTemp(temp);
}
