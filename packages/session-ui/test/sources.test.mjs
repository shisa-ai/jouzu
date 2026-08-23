import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { detectRuntime, GIT_STATUS_ARGS, parseGitStatus, readGitStatus, readRuntimeSnapshot } from "../dist/index.js";

test("parses one lock-free Git status probe into typed local facts", async () => {
	const output = [
		"# branch.head main",
		"# branch.ab +2 -1",
		"# stash 3",
		"1 .M N... 100644 100644 100644 abc abc modified.txt",
		"1 M. N... 100644 100644 100644 abc abc staged.txt",
		"2 R. N... 100644 100644 100644 abc abc R100 old.ts\tnew.ts",
		"? untracked.ts",
		"u UU N... 100644 100644 100644 100644 abc abc conflict.ts",
	].join("\n");
	assert.deepEqual(parseGitStatus(output), {
		branch: "main",
		dirty: true,
		ahead: 2,
		behind: 1,
		conflicted: 1,
		untracked: 1,
		stashed: 3,
		modified: 1,
		staged: 1,
		renamed: 1,
		deleted: 0,
		typeChanged: 0,
	});
	const calls = [];
	const observed = await readGitStatus("/repo", async (command, args, options) => {
		calls.push({ command, args, options });
		return { stdout: output, stderr: "", code: 0, killed: false };
	});
	assert.equal(observed.branch, "main");
	assert.deepEqual(calls, [{ command: "git", args: [...GIT_STATUS_ARGS], options: { cwd: "/repo", timeout: 3000 } }]);
});

test("detects a single project runtime and bounds its version probe", async () => {
	assert.equal(detectRuntime(["package.json", "bun.lock"]).id, "bun");
	assert.equal(detectRuntime(["package.json"]).id, "node");
	assert.equal(detectRuntime(["README.md"]), undefined);
	const root = mkdtempSync(join(tmpdir(), "jouzu-session-runtime-"));
	try {
		writeFileSync(join(root, "pyproject.toml"), "");
		const calls = [];
		const runtime = await readRuntimeSnapshot(root, async (command, args, options) => {
			calls.push({ command, args, options });
			return { stdout: "Python 3.12.7\n", stderr: "", code: 0, killed: false };
		});
		assert.deepEqual(runtime, { id: "python", version: "v3.12.7" });
		assert.deepEqual(calls, [{ command: "python3", args: ["--version"], options: { cwd: root, timeout: 2500 } }]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
