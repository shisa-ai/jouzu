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
	assert.equal(result.stdout.trim(), "jouzu 0.1.0\npi 0.84.2\nprofile schema 1");
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

test("a non-interactive first run uses Core without recording Japanese consent", () => {
	const temp = mkdtempSync(join(tmpdir(), "jouzu-core-first-run-"));
	try {
		const jouzuHome = join(temp, "home");
		const result = run(["--jouzu-home", jouzuHome, "pi", "--version"]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), "0.84.2");
		const state = JSON.parse(readFileSync(join(jouzuHome, "state", "profile-state.json"), "utf8"));
		assert.equal(state.activeProfile, "core");
		assert.equal(existsSync(join(jouzuHome, "state", "profile-choice.json")), false);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("self-update status and policy are explicit and source-safe", () => {
	const temp = mkdtempSync(join(tmpdir(), "jouzu-self-update-cli-"));
	try {
		const jouzuHome = join(temp, "home");
		const status = run(["--jouzu-home", jouzuHome, "self-update", "status", "--json"]);
		assert.equal(status.status, 0, status.stderr);
		const parsed = JSON.parse(status.stdout);
		assert.equal(parsed.policy, "auto-restart");
		assert.equal(parsed.installChannel, "source");
		assert.equal(parsed.startupEligible, false);
		assert.equal(existsSync(jouzuHome), false, "self-update status mutated the Jouzu home");

		const policy = run(["--jouzu-home", jouzuHome, "self-update", "policy", "notify"]);
		assert.equal(policy.status, 0, policy.stderr);
		assert.match(policy.stdout, /policy: notify/);
		assert.equal(JSON.parse(readFileSync(join(jouzuHome, "state", "self-update.json"), "utf8")).policy, "notify");

		const apply = run(["--jouzu-home", jouzuHome, "self-update", "apply"]);
		assert.equal(apply.status, 4);
		assert.match(apply.stderr, /real global npm install/);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("keybinding commands plan without mutation, merge explicitly, and reset owned defaults", () => {
	const temp = mkdtempSync(join(tmpdir(), "jouzu-keybindings-cli-"));
	try {
		const jouzuHome = join(temp, "Jouzu 上手");
		const planned = run(["--jouzu-home", jouzuHome, "keybindings", "plan", "--json"]);
		assert.equal(planned.status, 0, planned.stderr);
		const plan = JSON.parse(planned.stdout);
		assert.equal(plan.status, "uninitialized");
		assert.deepEqual(
			plan.actions.map((action) => [action.action, action.binding]),
			[
				["app.message.followUp", "tab"],
				["app.message.dequeue", "ctrl+up"],
			],
		);
		assert.equal(existsSync(jouzuHome), false, "keybindings plan mutated the Jouzu home");

		const applied = run(["--jouzu-home", jouzuHome, "keybindings", "apply"]);
		assert.equal(applied.status, 0, applied.stderr);
		assert.match(applied.stdout, /Applied keybinding transaction/);
		assert.deepEqual(JSON.parse(readFileSync(join(jouzuHome, "agent", "keybindings.json"), "utf8")), {
			"app.message.followUp": "tab",
			"app.message.dequeue": "ctrl+up",
		});
		const status = JSON.parse(run(["--jouzu-home", jouzuHome, "keybindings", "status", "--json"]).stdout);
		assert.equal(status.status, "converged");
		assert.deepEqual(status.actions, []);

		const reset = run(["--jouzu-home", jouzuHome, "keybindings", "reset"]);
		assert.equal(reset.status, 0, reset.stderr);
		assert.match(reset.stdout, /Reset keybinding transaction/);
		assert.equal(existsSync(join(jouzuHome, "agent", "keybindings.json")), false);
		assert.equal(
			JSON.parse(readFileSync(join(jouzuHome, "state", "keybindings-state.json"), "utf8")).policy,
			"disabled",
		);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("keybinding conflicts use a dedicated status and preserve user bytes", () => {
	const temp = mkdtempSync(join(tmpdir(), "jouzu-keybindings-conflict-cli-"));
	try {
		const jouzuHome = join(temp, "home");
		const path = join(jouzuHome, "agent", "keybindings.json");
		mkdirSync(join(jouzuHome, "agent"), { recursive: true });
		writeFileSync(path, '{"app.message.followUp":"alt+enter"}\n');
		const before = readFileSync(path);
		const result = run(["--jouzu-home", jouzuHome, "keybindings", "apply"]);
		assert.equal(result.status, 5);
		assert.match(result.stderr, /user-binding-differs/);
		assert.deepEqual(readFileSync(path), before);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("jouzu and jz package bins are exact aliases", () => {
	assert.equal(packageJson.bin.jouzu, packageJson.bin.jz);
	assert.equal(packageJson.dependencies["@earendil-works/pi-coding-agent"], "0.84.2");
});

test("jz --session resolves an ID inside Jouzu's isolated session root", () => {
	const temp = mkdtempSync(join(tmpdir(), "jouzu-resume-"));
	try {
		const jouzuHome = join(temp, "Jouzu 上手");
		const sessionDir = join(jouzuHome, "state", "sessions");
		const sessionId = "11111111-2222-3333-4444-555555555555";
		const sessionFile = join(sessionDir, `2026-08-20T00-00-00-000Z_${sessionId}.jsonl`);
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: sessionId,
				timestamp: "2026-08-20T00:00:00.000Z",
				cwd: process.cwd(),
			})}\n`,
		);
		const result = run(["--jouzu-home", jouzuHome, "--session", sessionId, "--mode", "rpc", "--no-context-files"], {
			input: `${JSON.stringify({ id: "state", type: "get_state" })}\n`,
		});
		assert.equal(result.status, 0, result.stderr);
		const response = JSON.parse(result.stdout.trim());
		assert.equal(response.data.sessionId, sessionId);
		assert.equal(response.data.sessionFile, sessionFile);
		assert.doesNotMatch(result.stderr, /Session found in different project/);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
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
	assert.match(jouzuHelp.stdout, /Jouzu agentic AI environment/);
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
		assert.equal(JSON.parse(readFileSync(join(jouzuHome, "state", "profile-choice.json"), "utf8")).profile, "ja");
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
		const planned = run(["--jouzu-home", jouzuHome, "profile", "plan", "--profile", "ja", "--json"]);
		assert.equal(planned.status, 3);
		assert.equal(
			JSON.parse(planned.stdout).actions.find((action) => action.target === "APPEND_SYSTEM.md").reason,
			"unmanaged-different",
		);
		const result = run(["--jouzu-home", jouzuHome, "--jouzu-profile", "ja", "pi", "--version"]);
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
		assert.match(result.stdout, /Result: ready for Jouzu v0\.1 preview/);
		assert.equal(existsSync(jouzuHome), false, "doctor created the Jouzu home");
		assert.equal(readFileSync(sentinel, "utf8"), "unchanged\n");
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});
