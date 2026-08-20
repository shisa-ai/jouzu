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
	runNpm(["install", "--ignore-scripts", "--no-package-lock", tarball], { cwd: temp });

	const installedCli = resolve(temp, "node_modules", "jouzu", "dist", "cli.js");
	const env = { ...process.env, JOUZU_HOME: consumer, PI_OFFLINE: "1" };
	const version = run(process.execPath, [installedCli, "--version"], { cwd: temp, env }).stdout.trim();
	assert.equal(version, `jouzu ${packageJson.version}\npi ${piVersion}\nprofile schema 1`);
	const firstPlan = JSON.parse(
		run(process.execPath, [installedCli, "profile", "plan", "--profile", "ja", "--json"], { cwd: temp, env }).stdout,
	);
	assert.ok(firstPlan.actions.some((action) => action.type === "create"));
	assert.equal(existsSync(consumer), false, "packed profile plan mutated the consumer home");
	run(process.execPath, [installedCli, "profile", "apply", "--profile", "ja"], { cwd: temp, env });
	const secondPlan = JSON.parse(
		run(process.execPath, [installedCli, "profile", "plan", "--profile", "ja", "--json"], { cwd: temp, env }).stdout,
	);
	assert.deepEqual(secondPlan.actions, []);
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

	console.log(`packed jouzu@${packageJson.version} launched Pi ${piVersion} through jouzu and jz`);
} finally {
	rmSync(temp, { recursive: true, force: true });
}
