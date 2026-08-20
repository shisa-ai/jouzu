#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageDirectory = resolve(root, "packages", "cli");
const packageJson = JSON.parse(readFileSync(resolve(packageDirectory, "package.json"), "utf8"));
const piLock = JSON.parse(readFileSync(resolve(root, "upstream", "pi.lock.json"), "utf8"));
const piVersion = piLock.packages["@earendil-works/pi-coding-agent"].version;
const npmCommand = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
const npmPrefix = process.platform === "win32" ? ["/d", "/s", "/c", "npm"] : [];

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		timeout: 120_000,
		...options,
	});
	if (result.error) throw result.error;
	assert.equal(result.signal, null, `${command} terminated by ${result.signal}: ${result.stderr}`);
	assert.equal(result.status, 0, `${command} exited ${result.status}: ${result.stderr || result.stdout}`);
	return result;
}

function runNpm(args, options = {}) {
	return run(npmCommand, [...npmPrefix, ...args], options);
}

const temp = mkdtempSync(join(tmpdir(), "jouzu-packed-cli-"));
try {
	const packResult = runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", temp], {
		cwd: packageDirectory,
	});
	const [packed] = JSON.parse(packResult.stdout);
	const tarball = resolve(temp, packed.filename);
	const consumer = resolve(temp, "consumer");
	writeFileSync(
		resolve(temp, "package.json"),
		`${JSON.stringify({ name: "jouzu-packed-smoke", version: "1.0.0", private: true }, null, 2)}\n`,
	);
	runNpm(["install", "--ignore-scripts", tarball], { cwd: temp });
	const consumerLock = JSON.parse(readFileSync(resolve(temp, "package-lock.json"), "utf8"));
	const installedPi = consumerLock.packages["node_modules/@earendil-works/pi-coding-agent"];
	assert.equal(installedPi.version, piVersion);
	assert.equal(installedPi.integrity, piLock.packages["@earendil-works/pi-coding-agent"].integrity);

	const installedCli = resolve(temp, "node_modules", "jouzu", "dist", "cli.js");
	const env = { ...process.env, JOUZU_HOME: consumer, PI_OFFLINE: "1" };
	const version = run(process.execPath, [installedCli, "--version"], { cwd: temp, env }).stdout.trim();
	assert.equal(version, `jouzu ${packageJson.version}\npi ${piVersion}\nprofile schema 1`);
	const firstPlan = JSON.parse(
		run(process.execPath, [installedCli, "profile", "plan", "--json"], { cwd: temp, env }).stdout,
	);
	assert.equal(firstPlan.profile, "core");
	assert.ok(firstPlan.actions.some((action) => action.type === "create"));
	assert.equal(existsSync(consumer), false, "packed profile plan mutated the consumer home");
	run(process.execPath, [installedCli, "profile", "apply"], { cwd: temp, env });
	const secondPlan = JSON.parse(
		run(process.execPath, [installedCli, "profile", "plan", "--json"], { cwd: temp, env }).stdout,
	);
	assert.equal(secondPlan.profile, "core");
	assert.deepEqual(secondPlan.actions, []);
	const jaPlan = JSON.parse(
		run(process.execPath, [installedCli, "profile", "plan", "--profile", "ja", "--json"], { cwd: temp, env }).stdout,
	);
	assert.ok(jaPlan.actions.some((action) => action.target === "APPEND_SYSTEM.md"));
	run(process.execPath, [installedCli, "profile", "apply", "--profile", "ja"], { cwd: temp, env });
	run(process.execPath, [installedCli, "profile", "apply", "--profile", "core"], { cwd: temp, env });
	assert.equal(existsSync(resolve(consumer, "agent", "APPEND_SYSTEM.md")), false);
	const doctor = run(process.execPath, [installedCli, "doctor"], { cwd: temp, env }).stdout;
	assert.match(doctor, /Install channel: npm-compatible install/);
	assert.match(doctor, /Selected profile: core/);
	assert.match(doctor, /Result: ready for Jouzu v0\.1 preview/);
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

	const npmExec = runNpm(["exec", "--yes", "--package", tarball, "--", "jouzu", "--version"], {
		cwd: resolve(temp, "consumer"),
		env,
	});
	assert.match(npmExec.stdout, new RegExp(`^jouzu ${packageJson.version}`, "m"));

	const globalPrefix = resolve(temp, "global");
	runNpm(["install", "--global", "--prefix", globalPrefix, "--ignore-scripts", tarball]);
	const globalBin =
		process.platform === "win32" ? resolve(globalPrefix, "jouzu.cmd") : resolve(globalPrefix, "bin", "jouzu");
	const globalEnv = { ...env, npm_config_prefix: globalPrefix };
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

	console.log(`packed jouzu@${packageJson.version} passed local, npm-exec, and global smokes with Pi ${piVersion}`);
} finally {
	rmSync(temp, { recursive: true, force: true });
}
