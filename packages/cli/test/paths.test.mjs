import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveJouzuPaths } from "../dist/paths.js";

test("resolves Linux XDG defaults without using Pi roots", () => {
	assert.deepEqual(
		resolveJouzuPaths({
			platform: "linux",
			homeDir: "/home/user",
			cwd: "/work",
			env: {},
		}),
		{
			agentDir: "/home/user/.config/jouzu/agent",
			stateDir: "/home/user/.local/state/jouzu",
			cacheDir: "/home/user/.cache/jouzu",
			sessionDir: "/home/user/.local/state/jouzu/sessions",
			profileStatePath: "/home/user/.local/state/jouzu/profile-state.json",
			backupDir: "/home/user/.local/state/jouzu/backups",
		},
	);
});

test("resolves macOS native roots", () => {
	const paths = resolveJouzuPaths({ platform: "darwin", homeDir: "/Users/上手", cwd: "/tmp", env: {} });
	assert.equal(paths.agentDir, "/Users/上手/Library/Application Support/Jouzu/agent");
	assert.equal(paths.sessionDir, "/Users/上手/Library/Application Support/Jouzu/state/sessions");
	assert.equal(paths.cacheDir, "/Users/上手/Library/Caches/Jouzu");
});

test("resolves Windows native and fallback roots", () => {
	const native = resolveJouzuPaths({
		platform: "win32",
		homeDir: "C:\\Users\\利用者",
		cwd: "C:\\work",
		env: { APPDATA: "D:\\Roaming Data", LOCALAPPDATA: "D:\\Local Data" },
	});
	assert.equal(native.agentDir, "D:\\Roaming Data\\Jouzu\\agent");
	assert.equal(native.sessionDir, "D:\\Local Data\\Jouzu\\state\\sessions");

	const fallback = resolveJouzuPaths({
		platform: "win32",
		homeDir: "C:\\Users\\利用者",
		cwd: "C:\\work",
		env: {},
	});
	assert.equal(fallback.agentDir, "C:\\Users\\利用者\\AppData\\Roaming\\Jouzu\\agent");
});

test("portable home override derives all isolated roots and supports spaces", () => {
	const paths = resolveJouzuPaths({
		platform: "linux",
		homeDir: "/home/user",
		cwd: "/work",
		env: { JOUZU_HOME: "./上手 home" },
	});
	assert.equal(paths.agentDir, "/work/上手 home/agent");
	assert.equal(paths.sessionDir, "/work/上手 home/state/sessions");
	assert.equal(paths.cacheDir, "/work/上手 home/cache");
});

test("CLI home override takes precedence over the environment", () => {
	const paths = resolveJouzuPaths({
		platform: "linux",
		homeDir: "/home/user",
		cwd: "/work",
		env: { JOUZU_HOME: "/environment" },
		homeOverride: "~/CLI home",
	});
	assert.equal(paths.agentDir, "/home/user/CLI home/agent");
});
