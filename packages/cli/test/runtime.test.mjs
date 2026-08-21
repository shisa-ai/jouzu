import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeProfileChoice } from "../dist/profile-choice.js";
import { ProfileStateError } from "../dist/profile-manager.js";
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

function validState(activeProfile, manifestSha256) {
	return {
		schemaVersion: 1,
		activeProfile,
		profileVersion: 1,
		manifestSha256,
		jouzuVersion: "0.1.0",
		transactionId: "00000000-0000-0000-0000-000000000000",
		appliedAt: "2026-08-20T00:00:00.000Z",
		managedTargets: [],
	};
}

test("fresh installs default to Core and honor a saved explicit choice", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-runtime-profile-"));
	try {
		const resolved = paths(root);
		assert.deepEqual(resolveProfileSelection(resolved, { env: {}, allowSavedChoice: false }), {
			id: "core",
			source: "default",
			needsFirstRunInput: false,
		});
		writeProfileChoice(join(resolved.stateDir, "profile-choice.json"), "ja");
		assert.deepEqual(resolveProfileSelection(resolved, { env: {} }), {
			id: "ja",
			source: "saved choice",
			needsFirstRunInput: false,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the resolver reports first-run input and saved choice suppresses it", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-runtime-first-run-"));
	try {
		const resolved = paths(root);
		assert.deepEqual(resolveProfileSelection(resolved, { env: {}, interactiveStartup: true }), {
			id: "core",
			source: "default",
			needsFirstRunInput: true,
		});
		writeProfileChoice(join(resolved.stateDir, "profile-choice.json"), "core");
		assert.deepEqual(resolveProfileSelection(resolved, { env: {}, interactiveStartup: true }), {
			id: "core",
			source: "saved choice",
			needsFirstRunInput: false,
		});

		writeFileSync(resolved.profileStatePath, JSON.stringify(validState("core", "a".repeat(64))));
		writeProfileChoice(join(resolved.stateDir, "profile-choice.json"), "ja");
		assert.deepEqual(resolveProfileSelection(resolved, { env: {}, interactiveStartup: true }), {
			id: "core",
			source: "profile state",
			appliedManifestSha256: "a".repeat(64),
			needsFirstRunInput: false,
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
		writeFileSync(resolved.profileStatePath, JSON.stringify(validState("ja", "a".repeat(64))));
		writeProfileChoice(join(resolved.stateDir, "profile-choice.json"), "core");
		assert.deepEqual(resolveProfileSelection(resolved, { explicitProfile: "core", env: {} }), {
			id: "core",
			source: "command line",
			appliedManifestSha256: undefined,
			needsFirstRunInput: false,
		});
		assert.deepEqual(resolveProfileSelection(resolved, { env: { JOUZU_PROFILE: "core" } }), {
			id: "core",
			source: "environment",
			appliedManifestSha256: undefined,
			needsFirstRunInput: false,
		});
		assert.deepEqual(resolveProfileSelection(resolved, { env: {} }), {
			id: "ja",
			source: "profile state",
			appliedManifestSha256: "a".repeat(64),
			needsFirstRunInput: false,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("corrupt and symlinked profile state raise a strict ProfileStateError", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-runtime-strict-"));
	try {
		const resolved = paths(root);
		mkdirSync(resolved.stateDir, { recursive: true });
		writeFileSync(resolved.profileStatePath, "{ not valid json");
		assert.throws(() => resolveProfileSelection(resolved, { env: {} }), ProfileStateError);
		assert.match(
			(() => {
				try {
					resolveProfileSelection(resolved, { env: {} });
					return "";
				} catch (error) {
					return error.message;
				}
			})(),
			/profile-state\.json/,
		);

		rmSync(resolved.profileStatePath, { force: true });
		const outside = join(root, "outside");
		writeFileSync(outside, JSON.stringify(validState("ja", "b".repeat(64))));
		symlinkSync(outside, resolved.profileStatePath);
		assert.throws(() => resolveProfileSelection(resolved, { env: {} }), ProfileStateError);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
