import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = join(packageRoot, "dist", "cli.js");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const defaultHome = mkdtempSync(join(tmpdir(), "jouzu-cli-suite-"));
after(() => rmSync(defaultHome, { recursive: true, force: true }));

function run(args, options = {}) {
	return spawnSync(process.execPath, [cli, ...args], {
		encoding: "utf8",
		timeout: 30_000,
		env: { ...process.env, JOUZU_HOME: defaultHome, PI_OFFLINE: "1", ...options.env },
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

test("preserves a pinned Pi CLI failure status", () => {
	const result = run(["pi", "--session"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Unknown option: --session/);
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

test("profile plan is non-mutating and profile apply converges", () => {
	const temp = mkdtempSync(join(tmpdir(), "jouzu-profile-cli-"));
	try {
		const jouzuHome = join(temp, "Jouzu 上手");
		const firstPlan = run(["--jouzu-home", jouzuHome, "profile", "plan", "--profile", "ja", "--json"]);
		assert.equal(firstPlan.status, 0, firstPlan.stderr);
		const parsed = JSON.parse(firstPlan.stdout);
		assert.equal(parsed.profile, "ja");
		assert.ok(parsed.actions.some((action) => action.type === "create"));
		assert.equal(existsSync(jouzuHome), false, "profile plan created the Jouzu home");

		const applied = run(["--jouzu-home", jouzuHome, "profile", "apply", "--profile", "ja"]);
		assert.equal(applied.status, 0, applied.stderr);
		assert.match(applied.stdout, /Applied transaction:/);
		const secondPlan = run(["--jouzu-home", jouzuHome, "profile", "plan", "--profile", "ja", "--json"]);
		assert.equal(secondPlan.status, 0, secondPlan.stderr);
		assert.deepEqual(JSON.parse(secondPlan.stdout).actions, []);
		const doctor = run(["--jouzu-home", jouzuHome, "doctor"]);
		assert.equal(doctor.status, 0, doctor.stderr);
		const manifests = [...doctor.stdout.matchAll(/(?:Bundled|Applied) profile manifest: ([0-9a-f]{64})/g)];
		assert.equal(manifests.length, 2);
		assert.equal(manifests[0][1], manifests[1][1]);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("profile conflicts stop with the reserved status before Pi launch", () => {
	const temp = mkdtempSync(join(tmpdir(), "jouzu-profile-conflict-"));
	try {
		const jouzuHome = join(temp, "home");
		mkdirSync(join(jouzuHome, "agent"), { recursive: true });
		writeFileSync(join(jouzuHome, "agent", "APPEND_SYSTEM.md"), "user-owned\n");
		const planned = run(["--jouzu-home", jouzuHome, "profile", "plan", "--json"]);
		assert.equal(planned.status, 3);
		assert.equal(
			JSON.parse(planned.stdout).actions.find((action) => action.target === "APPEND_SYSTEM.md").reason,
			"unmanaged-different",
		);
		const result = run(["--jouzu-home", jouzuHome, "pi", "--version"]);
		assert.equal(result.status, 3);
		assert.match(result.stderr, /CONFLICT APPEND_SYSTEM\.md/);
		assert.doesNotMatch(result.stdout, /0\.84\.2/);
		assert.equal(readFileSync(join(jouzuHome, "agent", "APPEND_SYSTEM.md"), "utf8"), "user-owned\n");
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
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

test(
	"preserves interactive runtime termination handling",
	{ skip: process.platform === "win32" ? "POSIX signal assertion" : false, timeout: 30_000 },
	async () => {
		const temp = mkdtempSync(join(tmpdir(), "jouzu-signal-"));
		try {
			const child = spawn(process.execPath, [cli, "pi", "--mode", "rpc", "--no-session", "--no-context-files"], {
				env: { ...process.env, JOUZU_HOME: temp, PI_OFFLINE: "1" },
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
			await new Promise((resolveReady, rejectReady) => {
				const timeout = setTimeout(() => rejectReady(new Error(`RPC startup timed out: ${stderr}`)), 15_000);
				const poll = setInterval(() => {
					if (stdout.includes('"id":"state"')) {
						clearInterval(poll);
						clearTimeout(timeout);
						resolveReady();
					}
				}, 20);
				child.once("exit", (code, signal) => {
					clearInterval(poll);
					clearTimeout(timeout);
					rejectReady(new Error(`RPC exited before signal test: code=${code} signal=${signal} ${stderr}`));
				});
			});
			const exitPromise = new Promise((resolveExit) => {
				child.once("exit", (code, signal) => resolveExit({ code, signal }));
			});
			child.kill("SIGTERM");
			const result = await exitPromise;
			assert.ok(
				result.signal === "SIGTERM" || result.code === 143,
				`expected SIGTERM semantics, got ${JSON.stringify(result)}`,
			);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	},
);

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
