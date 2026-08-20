import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = join(packageRoot, "dist", "cli.js");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

function run(args, options = {}) {
	return spawnSync(process.execPath, [cli, ...args], {
		encoding: "utf8",
		timeout: 30_000,
		env: { ...process.env, PI_OFFLINE: "1", ...options.env },
		input: options.input,
	});
}

test("prints the Jouzu, Pi, and profile schema version tuple", () => {
	const result = run(["--version"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), "jouzu 0.0.1\npi 0.84.2\nprofile schema 1");
});

test("forwards explicit Pi version requests through the pinned runtime", () => {
	for (const args of [
		["pi", "--version"],
		["--", "--version"],
	]) {
		const result = run(args);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), "0.84.2");
	}
});

test("jouzu and jz package bins are exact aliases", () => {
	assert.equal(packageJson.bin.jouzu, packageJson.bin.jz);
	assert.equal(packageJson.dependencies["@earendil-works/pi-coding-agent"], "0.84.2");
});

test("rejects Pi self-update without entering Pi", () => {
	const result = run(["update", "--self"]);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /pins its Pi runtime/);
	assert.match(result.stderr, /Upgrade Jouzu instead/);
});

test("shows Jouzu help and leaves Pi help behind the explicit escape", () => {
	const jouzuHelp = run(["--help"]);
	assert.equal(jouzuHelp.status, 0, jouzuHelp.stderr);
	assert.match(jouzuHelp.stdout, /Jouzu development launcher/);
	assert.match(jouzuHelp.stdout, /Ctrl\+L/);

	const piHelp = run(["pi", "--help"]);
	assert.equal(piHelp.status, 0, piHelp.stderr);
	assert.match(piHelp.stdout, /--mode <mode>/);
});

test("Pi package operations write only to the isolated Jouzu agent root", () => {
	const temp = mkdtempSync(join(tmpdir(), "jouzu-package-isolation-"));
	try {
		const jouzuHome = join(temp, "Jouzu 上手");
		const stockPi = join(temp, "stock-pi");
		const localPackage = join(temp, "local extension");
		mkdirSync(stockPi);
		mkdirSync(localPackage);
		const stockSettings = join(stockPi, "settings.json");
		writeFileSync(stockSettings, '{"theme":"dark"}\n');
		writeFileSync(
			join(localPackage, "package.json"),
			`${JSON.stringify({ name: "jouzu-isolation-fixture", version: "1.0.0", pi: { extensions: ["extension.js"] } })}\n`,
		);
		writeFileSync(join(localPackage, "extension.js"), "export default function () {}\n");

		const result = run(["--jouzu-home", jouzuHome, "install", localPackage], {
			env: { PI_CODING_AGENT_DIR: stockPi },
		});
		assert.equal(result.status, 0, result.stderr || result.stdout);
		const jouzuSettings = JSON.parse(readFileSync(join(jouzuHome, "agent", "settings.json"), "utf8"));
		assert.equal(jouzuSettings.packages.length, 1);
		assert.equal(resolve(jouzuHome, "agent", jouzuSettings.packages[0]), localPackage);
		assert.equal(readFileSync(stockSettings, "utf8"), '{"theme":"dark"}\n');
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("doctor is non-mutating and reports replacement of inherited Pi roots", () => {
	const temp = mkdtempSync(join(tmpdir(), "jouzu-doctor-"));
	try {
		const jouzuHome = join(temp, "上手 home");
		const stockPi = join(temp, "stock-pi");
		mkdirSync(stockPi);
		const sentinel = join(stockPi, "sentinel.txt");
		writeFileSync(sentinel, "unchanged\n");
		const result = run(["--jouzu-home", jouzuHome, "doctor"], {
			env: {
				PI_CODING_AGENT_DIR: stockPi,
				PI_CODING_AGENT_SESSION_DIR: join(stockPi, "sessions"),
			},
		});
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.match(result.stdout, new RegExp(`Agent/config root: ${jouzuHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(result.stdout, /Inherited Pi agent root replaced: yes/);
		assert.match(result.stdout, /Result: ready for development dogfood/);
		assert.equal(existsSync(jouzuHome), false, "doctor created the Jouzu home");
		assert.equal(readFileSync(sentinel, "utf8"), "unchanged\n");
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});
