import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	classifyInstallChannel,
	compareSemver,
	JouzuUpdater,
	readUpdateState,
	relaunchUpdatedJouzu,
	UpdateError,
	updateStatePath,
} from "../dist/updater.js";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "jouzu-updater-"));
	const paths = {
		agentDir: join(root, "agent"),
		stateDir: join(root, "state"),
		cacheDir: join(root, "cache"),
		sessionDir: join(root, "state", "sessions"),
		profileStatePath: join(root, "state", "profile-state.json"),
		backupDir: join(root, "state", "backups"),
	};
	const globalRoot = join(root, "global", "node_modules");
	const packageRoot = join(globalRoot, "jouzu");
	return { root, paths, globalRoot, packageRoot, executable: join(packageRoot, "dist", "cli.js") };
}

function integrity(bytes) {
	return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function release(version) {
	const bytes = Buffer.from(`jouzu-${version}`);
	return { version, bytes, integrity: integrity(bytes) };
}

function fakeNpm(options) {
	const artifacts = new Map();
	let installedVersion = options.currentVersion;
	const calls = [];
	const run = (args) => {
		calls.push(args);
		if (args[0] === "root") return { status: 0, stdout: `${options.globalRoot}\n`, stderr: "" };
		if (args[0] === "view") {
			return {
				status: 0,
				stdout: `${JSON.stringify({ version: options.latest.version, "dist.integrity": options.latest.integrity })}\n`,
				stderr: "",
			};
		}
		if (args[0] === "pack") {
			const specifier = args[1];
			const directory = args[args.indexOf("--pack-destination") + 1];
			const version = specifier.startsWith("jouzu@") ? specifier.slice("jouzu@".length) : options.currentVersion;
			const bytes = version === options.latest.version ? options.latest.bytes : Buffer.from(`backup-${version}`);
			const filename = `jouzu-${version}.tgz`;
			const path = join(directory, filename);
			writeFileSync(path, bytes);
			artifacts.set(path, version);
			return {
				status: 0,
				stdout: `${JSON.stringify([{ name: "jouzu", version, integrity: integrity(bytes), filename }])}\n`,
				stderr: "",
			};
		}
		if (args[0] === "install") {
			const path = args[2];
			const requestedVersion = artifacts.get(path);
			if (options.failCandidateInstall && requestedVersion === options.latest.version) {
				return { status: 1, stdout: "", stderr: "permission denied" };
			}
			installedVersion = requestedVersion;
			return { status: installedVersion ? 0 : 1, stdout: "", stderr: "" };
		}
		return { status: 1, stdout: "", stderr: "unexpected fake npm call" };
	};
	return {
		run,
		calls,
		installedVersion: () => installedVersion,
	};
}

test("semantic version comparison handles stable and prerelease ordering", () => {
	assert.equal(compareSemver("0.1.0", "0.1.0"), 0);
	assert.equal(compareSemver("0.1.1", "0.1.0"), 1);
	assert.equal(compareSemver("1.0.0-alpha.2", "1.0.0-alpha.10"), -1);
	assert.equal(compareSemver("1.0.0", "1.0.0-rc.1"), 1);
	assert.throws(() => compareSemver("latest", "0.1.0"), UpdateError);
	assert.throws(() => compareSemver("1.0.0-01", "1.0.0"), UpdateError);
	assert.throws(() => compareSemver("999999999999999999.0.0", "1.0.0"), UpdateError);
});

test("install-channel classification distinguishes global, local, npx, and source roots", () => {
	assert.equal(
		classifyInstallChannel({
			packageRoot: "/opt/npm/lib/node_modules/jouzu",
			globalNpmRoot: "/opt/npm/lib/node_modules",
		}),
		"global-npm",
	);
	assert.equal(classifyInstallChannel({ packageRoot: "/work/node_modules/jouzu" }), "local-npm");
	assert.equal(classifyInstallChannel({ packageRoot: "/home/u/.npm/_npx/id/node_modules/jouzu" }), "ephemeral-npx");
	assert.equal(classifyInstallChannel({ packageRoot: "/work/jouzu/packages/cli" }), "source");
	assert.equal(
		classifyInstallChannel({
			packageRoot: "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\jouzu",
			globalNpmRoot: "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules",
			platform: "win32",
		}),
		"global-npm",
	);
});

test("update state is absent by default and rejects unknown fields and symlinks", () => {
	const { root, paths } = fixture();
	try {
		const path = updateStatePath(paths);
		assert.equal(readUpdateState(path, "0.1.0").policy, "auto-restart");
		mkdirSync(paths.stateDir, { recursive: true });
		writeFileSync(path, '{"schemaVersion":1,"unknown":true}\n');
		assert.throws(() => readUpdateState(path, "0.1.0"), /missing or unknown fields/);
		if (process.platform !== "win32") {
			rmSync(path);
			const target = join(root, "state-target.json");
			writeFileSync(target, "{}\n");
			symlinkSync(target, path);
			assert.throws(() => readUpdateState(path, "0.1.0"), /regular file/);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("registry check records a newer integrity-qualified release", () => {
	const context = fixture();
	const latest = release("0.1.1");
	const npm = fakeNpm({ currentVersion: "0.1.0", latest, globalRoot: context.globalRoot });
	try {
		const updater = new JouzuUpdater({
			paths: context.paths,
			currentVersion: "0.1.0",
			executable: context.executable,
			packageRoot: context.packageRoot,
			runNpm: npm.run,
			now: () => new Date("2026-08-20T12:00:00.000Z"),
		});
		assert.deepEqual(updater.check(), {
			status: "available",
			installedVersion: "0.1.0",
			version: "0.1.1",
			integrity: latest.integrity,
		});
		const state = JSON.parse(readFileSync(updateStatePath(context.paths), "utf8"));
		assert.equal(state.lastResult, "available");
		assert.equal(state.latestIntegrity, latest.integrity);
		assert.equal(state.nextCheckAt, "2026-08-21T12:00:00.000Z");
	} finally {
		rmSync(context.root, { recursive: true, force: true });
	}
});

test("offline registry failures preserve the current install and schedule a bounded retry", () => {
	const context = fixture();
	try {
		const updater = new JouzuUpdater({
			paths: context.paths,
			currentVersion: "0.1.0",
			executable: context.executable,
			packageRoot: context.packageRoot,
			runNpm: (args) =>
				args[0] === "view"
					? { status: 1, stdout: "", stderr: "offline" }
					: { status: 0, stdout: `${context.globalRoot}\n`, stderr: "" },
			now: () => new Date("2026-08-20T12:00:00.000Z"),
		});
		assert.throws(
			() => updater.check(),
			(error) => error instanceof UpdateError && error.code === "npm-view-exit",
		);
		const state = JSON.parse(readFileSync(updateStatePath(context.paths), "utf8"));
		assert.equal(state.lastResult, "failed");
		assert.equal(state.installedVersion, "0.1.0");
		assert.equal(state.lastCheckedAt, "2026-08-20T12:00:00.000Z");
		assert.equal(state.nextCheckAt, "2026-08-20T13:00:00.000Z");
	} finally {
		rmSync(context.root, { recursive: true, force: true });
	}
});

test("global update downloads, verifies, installs, records, and requests restart", () => {
	const context = fixture();
	const latest = release("0.1.1");
	const npm = fakeNpm({ currentVersion: "0.1.0", latest, globalRoot: context.globalRoot });
	try {
		const updater = new JouzuUpdater({
			paths: context.paths,
			currentVersion: "0.1.0",
			executable: context.executable,
			packageRoot: context.packageRoot,
			runNpm: npm.run,
			verifyInstalled: (expected) => assert.equal(npm.installedVersion(), expected),
			now: () => new Date("2026-08-20T12:00:00.000Z"),
		});
		assert.deepEqual(updater.startup(), { action: "restart", version: "0.1.1" });
		assert.equal(npm.installedVersion(), "0.1.1");
		const state = JSON.parse(readFileSync(updateStatePath(context.paths), "utf8"));
		assert.equal(state.lastResult, "updated");
		assert.equal(state.installedVersion, "0.1.1");
		assert.equal(state.previousVersion, "0.1.0");
		assert.ok(npm.calls.some((args) => args[0] === "install" && args.includes("--ignore-scripts")));
	} finally {
		rmSync(context.root, { recursive: true, force: true });
	}
});

test("a failed install leaves a still-verified current version running without rollback", () => {
	const context = fixture();
	const latest = release("0.1.1");
	const npm = fakeNpm({
		currentVersion: "0.1.0",
		latest,
		globalRoot: context.globalRoot,
		failCandidateInstall: true,
	});
	try {
		const updater = new JouzuUpdater({
			paths: context.paths,
			currentVersion: "0.1.0",
			executable: context.executable,
			packageRoot: context.packageRoot,
			runNpm: npm.run,
			verifyInstalled: (expected) => assert.equal(npm.installedVersion(), expected),
		});
		const result = updater.startup();
		assert.equal(result.action, "continue");
		assert.match(result.message, /update-not-installed/);
		assert.equal(npm.installedVersion(), "0.1.0");
		assert.equal(npm.calls.filter((args) => args[0] === "install").length, 1);
	} finally {
		rmSync(context.root, { recursive: true, force: true });
	}
});

test("failed candidate verification restores the packed previous version", () => {
	const context = fixture();
	const latest = release("0.1.1");
	const npm = fakeNpm({ currentVersion: "0.1.0", latest, globalRoot: context.globalRoot });
	try {
		const updater = new JouzuUpdater({
			paths: context.paths,
			currentVersion: "0.1.0",
			executable: context.executable,
			packageRoot: context.packageRoot,
			runNpm: npm.run,
			verifyInstalled: (expected) => {
				assert.equal(npm.installedVersion(), expected);
				if (expected === "0.1.1") throw new Error("candidate smoke failed");
			},
		});
		assert.throws(
			() =>
				updater.apply({
					status: "available",
					installedVersion: "0.1.0",
					version: latest.version,
					integrity: latest.integrity,
				}),
			(error) => error instanceof UpdateError && error.code === "update-rolled-back",
		);
		assert.equal(npm.installedVersion(), "0.1.0");
		assert.equal(JSON.parse(readFileSync(updateStatePath(context.paths), "utf8")).lastResult, "failed");
	} finally {
		rmSync(context.root, { recursive: true, force: true });
	}
});

test("a cached available release survives the check-to-install process boundary", () => {
	const context = fixture();
	const latest = release("0.1.1");
	const npm = fakeNpm({ currentVersion: "0.1.0", latest, globalRoot: context.globalRoot });
	try {
		const updater = new JouzuUpdater({
			paths: context.paths,
			currentVersion: "0.1.0",
			executable: context.executable,
			packageRoot: context.packageRoot,
			runNpm: npm.run,
			verifyInstalled: (expected) => assert.equal(npm.installedVersion(), expected),
			now: () => new Date("2026-08-20T12:00:00.000Z"),
		});
		assert.equal(updater.check().status, "available");
		npm.calls.length = 0;
		assert.deepEqual(updater.startup(), { action: "restart", version: "0.1.1" });
		assert.equal(
			npm.calls.some((args) => args[0] === "view"),
			false,
		);
		assert.equal(
			npm.calls.some((args) => args[0] === "install"),
			true,
		);
	} finally {
		rmSync(context.root, { recursive: true, force: true });
	}
});

test("invalid environment policy overrides fail safe without checking or installing", () => {
	const context = fixture();
	const latest = release("0.1.1");
	const npm = fakeNpm({ currentVersion: "0.1.0", latest, globalRoot: context.globalRoot });
	try {
		const updater = new JouzuUpdater({
			paths: context.paths,
			currentVersion: "0.1.0",
			executable: context.executable,
			packageRoot: context.packageRoot,
			env: { JOUZU_UPDATE_POLICY: "typo" },
			runNpm: npm.run,
		});
		assert.deepEqual(updater.startup(), { action: "continue" });
		assert.equal(npm.calls.length, 0);
		assert.equal(updater.status().policy, "off");
	} finally {
		rmSync(context.root, { recursive: true, force: true });
	}
});

test("an active update lock blocks a concurrent installer without deleting the lock", () => {
	const context = fixture();
	const latest = release("0.1.1");
	const npm = fakeNpm({ currentVersion: "0.1.0", latest, globalRoot: context.globalRoot });
	try {
		mkdirSync(context.paths.stateDir, { recursive: true });
		const lockPath = join(context.paths.stateDir, "self-update.lock");
		const lock = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: "other" })}\n`;
		writeFileSync(lockPath, lock);
		const updater = new JouzuUpdater({
			paths: context.paths,
			currentVersion: "0.1.0",
			executable: context.executable,
			packageRoot: context.packageRoot,
			runNpm: npm.run,
		});
		assert.throws(
			() =>
				updater.apply({
					status: "available",
					installedVersion: "0.1.0",
					version: latest.version,
					integrity: latest.integrity,
				}),
			(error) => error instanceof UpdateError && error.code === "update-busy",
		);
		assert.equal(readFileSync(lockPath, "utf8"), lock);
		assert.equal(
			npm.calls.some((args) => args[0] === "install"),
			false,
		);
	} finally {
		rmSync(context.root, { recursive: true, force: true });
	}
});

test("the updater relaunch marker and original arguments reach the child once", () => {
	const context = fixture();
	try {
		const marker = join(context.root, "relaunch.json");
		const executable = join(context.root, "relaunch.mjs");
		writeFileSync(
			executable,
			'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], JSON.stringify({ args: process.argv.slice(3), restarted: process.env.JOUZU_INTERNAL_UPDATE_RESTARTED }));\n',
		);
		assert.equal(relaunchUpdatedJouzu({ executable, args: [marker, "日本語", "space value"], env: {} }), 0);
		assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), {
			args: ["日本語", "space value"],
			restarted: "1",
		});
	} finally {
		rmSync(context.root, { recursive: true, force: true });
	}
});

test("notify and off policies never install during startup", () => {
	for (const policy of ["notify", "off"]) {
		const context = fixture();
		const latest = release("0.1.1");
		const npm = fakeNpm({ currentVersion: "0.1.0", latest, globalRoot: context.globalRoot });
		try {
			const updater = new JouzuUpdater({
				paths: context.paths,
				currentVersion: "0.1.0",
				executable: context.executable,
				packageRoot: context.packageRoot,
				runNpm: npm.run,
			});
			updater.setPolicy(policy);
			const result = updater.startup();
			assert.equal(result.action, "continue");
			if (policy === "notify") assert.match(result.message, /is available/);
			assert.equal(
				npm.calls.some((args) => args[0] === "install"),
				false,
			);
		} finally {
			rmSync(context.root, { recursive: true, force: true });
		}
	}
});
