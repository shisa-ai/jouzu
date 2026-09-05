#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertNoAgplDependencies } from "./pack-check.mjs";

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

function assertPackedSurfaces(installedCli, probe, cwd, env, profile) {
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
	const surfaces = JSON.parse(marker.slice("JOUZU_SURFACE_PROBE=".length));
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
		"skill:jouzu-clear-writing",
		"skill:jouzu-source-check",
		"skill:multiloop",
		"status",
		"tasks",
	]) {
		assert.ok(surfaces.commands.includes(command), `${profile}: missing command ${command}`);
	}
	assert.equal(surfaces.commands.includes("skill:jouzu-core"), false);
	assert.equal(rpcResponse(result.stdout, "probe").success, true);
	assert.equal(rpcResponse(result.stdout, "commands").success, true);
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
		assertNoAgplDependencies(consumerLock);
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

		const installedCli = resolve(temp, "node_modules", "jouzu", "dist", "cli.js");
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
		assert.match(doctor, /Install channel: local npm install/);
		assert.match(doctor, /Selected profile: core/);
		assert.match(doctor, qualified ? /Result: ready for Jouzu v0\.1 preview/ : /Result: action required/);
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
