import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveProfileSelection } from "../dist/runtime.js";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "jouzu-runtime-"));
	return {
		root,
		paths: {
			agentDir: join(root, "agent"),
			stateDir: join(root, "state"),
			cacheDir: join(root, "cache"),
			sessionDir: join(root, "sessions"),
			profileStatePath: join(root, "state", "profile-state.json"),
			backupDir: join(root, "backups"),
		},
	};
}

test("fresh profile selection defaults to Core instead of silently enabling JA", () => {
	const { root, paths } = fixture();
	try {
		assert.deepEqual(resolveProfileSelection(paths, undefined, {}), { id: "core", source: "default" });
		assert.deepEqual(resolveProfileSelection(paths, undefined, {}, "ja"), { id: "ja", source: "saved choice" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("explicit, environment, and applied profile selections outrank a saved choice", () => {
	const { root, paths } = fixture();
	try {
		mkdirSync(paths.stateDir, { recursive: true });
		writeFileSync(paths.profileStatePath, '{"activeProfile":"ja","manifestSha256":"applied-sha"}\n');
		assert.equal(resolveProfileSelection(paths, "core", {}, "ja").source, "command line");
		assert.deepEqual(resolveProfileSelection(paths, undefined, { JOUZU_PROFILE: "core" }, "ja"), {
			id: "core",
			source: "environment",
			appliedManifestSha256: undefined,
		});
		assert.deepEqual(resolveProfileSelection(paths, undefined, {}, "core"), {
			id: "ja",
			source: "profile state",
			appliedManifestSha256: "applied-sha",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
