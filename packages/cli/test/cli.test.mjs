import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { formatDisplayVersion, parseBuildInfo } from "../dist/metadata.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = join(packageRoot, "dist", "cli.js");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const piVersion = packageJson.dependencies["@earendil-works/pi-coding-agent"];
const piLock = JSON.parse(readFileSync(join(packageRoot, "dist", "pi.lock.json"), "utf8"));
const buildInfoPath = join(packageRoot, "dist", "build-info.json");
const buildInfo = existsSync(buildInfoPath)
	? parseBuildInfo(JSON.parse(readFileSync(buildInfoPath, "utf8")))
	: undefined;
const displayVersion = formatDisplayVersion(packageJson.version, buildInfo);
const defaultHome = mkdtempSync(join(tmpdir(), "jouzu-cli-suite-"));
after(() => rmSync(defaultHome, { recursive: true, force: true }));

function scrubbedEnv() {
	const scrubbed = {};
	for (const [key, value] of Object.entries(process.env)) {
		// Scrub ambient Jouzu and inherited Pi-agent variables so the CLI suite is
		// hermetic; a case that needs them re-adds them explicitly via options.env.
		if (key === "AI_AGENT" || /^JOUZU_/.test(key) || /^PI_CODING_AGENT(?:_|$)/.test(key)) continue;
		scrubbed[key] = value;
	}
	return scrubbed;
}

function run(args, options = {}) {
	return spawnSync(process.execPath, [cli, ...args], {
		encoding: "utf8",
		timeout: 30_000,
		env: { ...scrubbedEnv(), JOUZU_HOME: defaultHome, PI_OFFLINE: "1", ...options.env },
		input: options.input,
	});
}

test("prints the Jouzu, Pi, and profile schema version tuple", () => {
	const result = run(["--version"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), `jouzu ${displayVersion}\npi ${piVersion}\nprofile schema 1`);
});

test("forwards explicit Pi version requests through the pinned runtime", () => {
	for (const args of [
		["pi", "--version"],
		["--", "--version"],
	]) {
		const result = run(args);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), piVersion);
	}
});

test("a non-interactive first run uses Core without recording Japanese consent", () => {
	const temp = mkdtempSync(join(tmpdir(), "jouzu-core-first-run-"));
	try {
		const jouzuHome = join(temp, "home");
		const result = run(["--jouzu-home", jouzuHome, "pi", "--version"]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), piVersion);
		const state = JSON.parse(readFileSync(join(jouzuHome, "state", "profile-state.json"), "utf8"));
		assert.equal(state.activeProfile, "core");
		assert.equal(state.profileVersion, 5);
		assert.equal(existsSync(join(jouzuHome, "state", "profile-choice.json")), false);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("Core registers its three skills and review prompt", () => {
	const temp = mkdtempSync(join(tmpdir(), "jouzu-core-skills-"));
	try {
		const result = run(
			["--jouzu-home", join(temp, "home"), "pi", "--mode", "rpc", "--no-session", "--no-context-files"],
			{ input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n` },
		);
		assert.equal(result.status, 0, result.stderr);
		const response = JSON.parse(result.stdout.trim());
		const commandNames = response.data.commands.map((command) => command.name);
		assert.deepEqual(
			commandNames.filter((name) => name === "jouzu-review" || name.startsWith("skill:jouzu-")),
			["jouzu-review", "skill:jouzu-clear-writing", "skill:jouzu-core", "skill:jouzu-source-check"],
		);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("non-interactive commands never import existing Pi configuration", () => {
	const temp = mkdtempSync(join(tmpdir(), "jouzu-pi-import-noninteractive-"));
	try {
		const jouzuHome = join(temp, "jouzu");
		const piHome = join(temp, "pi");
		mkdirSync(piHome, { recursive: true });
		writeFileSync(join(piHome, "models.json"), "{}\n");
		writeFileSync(join(piHome, "auth.json"), "{}\n");
		const result = run(["--jouzu-home", jouzuHome, "--version"], { env: { PI_CODING_AGENT_DIR: piHome } });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(join(jouzuHome, "agent", "models.json")), false);
		assert.equal(existsSync(join(jouzuHome, "agent", "auth.json")), false);
		assert.equal(existsSync(join(jouzuHome, "state", "pi-import.json")), false);
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
				["app.message.followUp", "ctrl+enter"],
				["app.message.dequeue", "ctrl+up"],
			],
		);
		assert.equal(existsSync(jouzuHome), false, "keybindings plan mutated the Jouzu home");

		const applied = run(["--jouzu-home", jouzuHome, "keybindings", "apply"]);
		assert.equal(applied.status, 0, applied.stderr);
		assert.match(applied.stdout, /Applied keybinding transaction/);
		assert.deepEqual(JSON.parse(readFileSync(join(jouzuHome, "agent", "keybindings.json"), "utf8")), {
			"app.message.followUp": "ctrl+enter",
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
	assert.equal(packageJson.dependencies["@earendil-works/pi-coding-agent"], piVersion);
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
	assert.match(jouzuHelp.stdout, /Jouzu Models view opens/);
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
		assert.equal(doctor.status, piLock.compatibilityStatus === "qualified" ? 0 : 1, doctor.stderr || doctor.stdout);
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
				env: (() => {
					const env = {};
					for (const [key, value] of Object.entries(process.env)) {
						if (key === "AI_AGENT" || /^JOUZU_/.test(key) || /^PI_CODING_AGENT(?:_|$)/.test(key)) continue;
						env[key] = value;
					}
					return { ...env, JOUZU_HOME: temp, PI_OFFLINE: "1" };
				})(),
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

test("an inherited Jouzu environment does not leak a selected profile into another home", () => {
	const temp = mkdtempSync(join(tmpdir(), "jouzu-profile-leak-"));
	try {
		const homeA = join(temp, "home-a");
		const homeB = join(temp, "home-b");
		// Apply the ja profile to home A so its state and agent assets diverge.
		const applied = run(["--jouzu-home", homeA, "profile", "apply", "--profile", "ja"]);
		assert.equal(applied.status, 0, applied.stderr);
		assert.equal(JSON.parse(readFileSync(join(homeA, "state", "profile-state.json"), "utf8")).activeProfile, "ja");

		// Launch home B under the inherited Jouzu agent roots from a session in A,
		// with no JOUZU_PROFILE in the environment (Jouzu no longer writes it).
		const launched = run(["--jouzu-home", homeB, "pi", "--version"], {
			env: {
				PI_CODING_AGENT_DIR: join(homeA, "agent"),
				PI_CODING_AGENT_SESSION_DIR: join(homeA, "state", "sessions"),
			},
		});
		assert.equal(launched.status, 0, launched.stderr);
		// Home B falls back to its own state/default (Core), not A's ja selection.
		assert.equal(JSON.parse(readFileSync(join(homeB, "state", "profile-state.json"), "utf8")).activeProfile, "core");
		assert.equal(existsSync(join(homeB, "agent", "APPEND_SYSTEM.md")), false, "ja asset leaked into home B");
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("a caller-provided JOUZU_PROFILE keeps input precedence over isolated state", () => {
	const temp = mkdtempSync(join(tmpdir(), "jouzu-profile-input-"));
	try {
		const jouzuHome = join(temp, "home");
		const result = run(["--jouzu-home", jouzuHome, "pi", "--version"], { env: { JOUZU_PROFILE: "ja" } });
		assert.equal(result.status, 0, result.stderr);
		// Explicit caller input is honored for the resolved profile even though no
		// ja assets exist; the default Core assets are still materialized safely.
		assert.equal(JSON.parse(readFileSync(join(jouzuHome, "state", "profile-state.json"), "utf8")).activeProfile, "ja");
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("an ordinary launch recovers a stale empty profile lock", () => {
	const temp = mkdtempSync(join(tmpdir(), "jouzu-recover-lock-"));
	try {
		const jouzuHome = join(temp, "home");
		const lock = join(jouzuHome, "state", "profile.lock");
		mkdirSync(join(jouzuHome, "state"), { recursive: true });
		writeFileSync(lock, "");
		const past = new Date(Date.now() - 31 * 60 * 1000);
		utimesSync(lock, past, past);

		const result = run(["--jouzu-home", jouzuHome, "pi", "--version"]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), piVersion);
		assert.equal(existsSync(lock), false, "recovered lock must be released");
		assert.equal(
			JSON.parse(readFileSync(join(jouzuHome, "state", "profile-state.json"), "utf8")).activeProfile,
			"core",
		);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test(
	"profile operations reject symlinked Jouzu-owned state and agent roots",
	{ skip: process.platform === "win32" ? "symlink fixture requires privileges" : false },
	() => {
		const temp = mkdtempSync(join(tmpdir(), "jouzu-owned-root-link-"));
		try {
			for (const [rootName, profile] of [
				["state", "core"],
				["agent", "ja"],
			]) {
				const jouzuHome = join(temp, `home-${rootName}`);
				const outside = join(temp, `outside-${rootName}`);
				mkdirSync(jouzuHome, { recursive: true });
				mkdirSync(outside);
				symlinkSync(outside, join(jouzuHome, rootName));
				const result = run(["--jouzu-home", jouzuHome, "profile", "apply", "--profile", profile]);
				assert.equal(result.status, 1, `${rootName} symlink was accepted: ${result.stdout}`);
				assert.match(result.stderr, /must be a real directory/);
				assert.deepEqual(readdirSync(outside), [], `${rootName} symlink destination was modified`);
			}
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	},
);

test("corrupt profile state fails with exit 1 and a recovery action, not the conflict status", () => {
	const temp = mkdtempSync(join(tmpdir(), "jouzu-corrupt-state-"));
	try {
		const jouzuHome = join(temp, "home");
		mkdirSync(join(jouzuHome, "state"), { recursive: true });
		writeFileSync(join(jouzuHome, "state", "profile-state.json"), "{ not valid json");
		const result = run(["--jouzu-home", jouzuHome, "pi", "--version"]);
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /Jouzu profile state is unreadable/);
		assert.match(result.stderr, /Recovery:/);
		assert.doesNotMatch(result.stderr, /CONFLICT/);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("doctor text and experimental JSON preserve diagnostics, exit status, and roots", () => {
	const temp = mkdtempSync(join(tmpdir(), "jouzu-doctor-"));
	try {
		const jouzuHome = join(temp, "上手 home");
		const stockPi = join(temp, "stock-pi");
		mkdirSync(stockPi);
		const sentinel = join(stockPi, "sentinel.txt");
		writeFileSync(sentinel, "unchanged\n");
		const inheritedRoots = {
			PI_CODING_AGENT_DIR: stockPi,
			PI_CODING_AGENT_SESSION_DIR: join(stockPi, "sessions"),
		};
		const result = run(["--jouzu-home", jouzuHome, "doctor"], { env: inheritedRoots });
		const qualified = piLock.compatibilityStatus === "qualified";
		assert.equal(result.status, qualified ? 0 : 1, result.stderr || result.stdout);
		assert.match(result.stdout, new RegExp(`Agent/config root: ${jouzuHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(result.stdout, /Inherited Pi agent root replaced: yes/);
		assert.match(result.stdout, qualified ? /Result: ready for Jouzu v0\.1 preview/ : /Result: action required/);

		const jsonResult = run(["--jouzu-home", jouzuHome, "doctor", "--json"], { env: inheritedRoots });
		assert.equal(jsonResult.status, qualified ? 0 : 1, jsonResult.stderr || jsonResult.stdout);
		assert.equal(jsonResult.stderr, "");
		const report = JSON.parse(jsonResult.stdout);
		assert.equal(report.schemaVersion, 1);
		assert.equal(report.experimental, true);
		assert.equal(report.healthy, qualified);
		assert.equal(report.fields.find((field) => field.id === "paths.agentDir")?.value, join(jouzuHome, "agent"));
		assert.equal(report.fields.find((field) => field.id === "isolation.piAgentDir")?.value, "yes");

		const unhealthyResult = run(["--jouzu-home", jouzuHome, "doctor", "--json"], {
			env: { ...inheritedRoots, PATH: "" },
		});
		assert.equal(unhealthyResult.status, 1, unhealthyResult.stderr || unhealthyResult.stdout);
		assert.equal(unhealthyResult.stderr, "");
		const unhealthyReport = JSON.parse(unhealthyResult.stdout);
		assert.equal(unhealthyReport.healthy, false);
		assert.ok(unhealthyReport.issues.some((issue) => issue.severity === "problem"));

		assert.equal(existsSync(jouzuHome), false, "doctor created the Jouzu home");
		assert.equal(readFileSync(sentinel, "utf8"), "unchanged\n");
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

function modeOf(path) {
	return statSync(path).mode & 0o777;
}

test(
	"Jouzu-owned directories get deterministic private modes regardless of umask or order",
	{ skip: process.platform === "win32" ? "POSIX permission assertion" : false },
	() => {
		const temp = mkdtempSync(join(tmpdir(), "jouzu-perms-"));
		try {
			for (const umask of ["022", "077"]) {
				for (const [label, args] of [
					["profile", ["profile", "apply", "--profile", "core"]],
					["keybinding", ["keybindings", "apply"]],
					["updater", ["self-update", "policy", "notify"]],
					["noninteractive", ["pi", "--version"]],
				]) {
					const jouzuHome = join(temp, `home-${umask}-${label}`);
					mkdirSync(jouzuHome, { recursive: true });
					// Simulate a caller-owned home root that Jouzu must not chmod.
					const wrapped = spawnSync(
						"sh",
						["-c", `umask ${umask}; exec "$@"`, "sh", process.execPath, cli, "--jouzu-home", jouzuHome, ...args],
						{
							encoding: "utf8",
							timeout: 30_000,
							env: { ...scrubbedEnv(), JOUZU_HOME: defaultHome, PI_OFFLINE: "1" },
						},
					);
					assert.equal(wrapped.status, 0, `${label} apply failed: ${wrapped.stderr}`);
					assert.equal(modeOf(jouzuHome), 0o755, `${label} must not chmod the caller-owned home root`);
					assert.equal(modeOf(join(jouzuHome, "state")), 0o700, `${label} state dir mode`);
					if (label !== "updater") {
						assert.equal(modeOf(join(jouzuHome, "agent")), 0o700, `${label} agent dir mode`);
					}
					// The persistent state file is always private.
					const stateFile =
						label === "updater"
							? "self-update.json"
							: label === "keybinding"
								? "keybindings-state.json"
								: "profile-state.json";
					assert.equal(modeOf(join(jouzuHome, "state", stateFile)), 0o600, `${label} state file mode`);
				}
			}
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	},
);
