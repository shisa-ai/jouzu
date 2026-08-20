import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveProfileSelection } from "../dist/runtime.js";

function paths(root) {
	return {
		agentDir: join(root, "agent"),
		stateDir: join(root, "state"),
		cacheDir: join(root, "cache"),
		sessionDir: join(root, "state", "sessions"),
		profileStatePath: join(root, "state", "profile-state.json"),
		backupDir: join(root, "state", "backups"),
	};
}

test("fresh installs default to Core and honor a saved explicit choice", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-runtime-profile-"));
	try {
		const resolved = paths(root);
		assert.deepEqual(resolveProfileSelection(resolved, undefined, {}), { id: "core", source: "default" });
		assert.deepEqual(resolveProfileSelection(resolved, undefined, {}, "ja"), {
			id: "ja",
			source: "saved choice",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("command, environment, and applied selections outrank a saved choice", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-runtime-profile-"));
	try {
		const resolved = paths(root);
		mkdirSync(resolved.stateDir, { recursive: true });
		writeFileSync(resolved.profileStatePath, JSON.stringify({ activeProfile: "ja", manifestSha256: "a".repeat(64) }));
		assert.deepEqual(resolveProfileSelection(resolved, "core", {}, "ja"), {
			id: "core",
			source: "command line",
			appliedManifestSha256: undefined,
		});
		assert.deepEqual(resolveProfileSelection(resolved, undefined, { JOUZU_PROFILE: "core" }, "ja"), {
			id: "core",
			source: "environment",
			appliedManifestSha256: undefined,
		});
		assert.deepEqual(resolveProfileSelection(resolved, undefined, {}, "core"), {
			id: "ja",
			source: "profile state",
			appliedManifestSha256: "a".repeat(64),
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
