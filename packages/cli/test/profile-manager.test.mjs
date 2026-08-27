import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	applyProfile,
	ProfileConflictError,
	ProfileStateError,
	planProfile,
	readProfileState,
} from "../dist/profile-manager.js";
import { loadBundledProfile } from "../dist/profiles.js";

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

function temporary() {
	const root = mkdtempSync(join(tmpdir(), "jouzu-profile-manager-"));
	return { root, paths: paths(root) };
}

function cleanup(root) {
	rmSync(root, { recursive: true, force: true });
}

function hash(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

test("profile planning is non-mutating and apply converges", () => {
	const fixture = temporary();
	try {
		cleanup(fixture.root);
		const profile = loadBundledProfile("ja");
		const plan = planProfile(profile, fixture.paths, "0.1.0");
		assert.equal(existsSync(fixture.root), false);
		assert.deepEqual(plan, {
			schemaVersion: 1,
			profile: "ja",
			profileVersion: 6,
			manifestSha256: profile.manifestSha256,
			agentDir: fixture.paths.agentDir,
			actions: [
				{
					type: "create",
					target: "APPEND_SYSTEM.md",
					reason: "missing",
					desiredSha256: profile.assets.find((asset) => asset.target === "APPEND_SYSTEM.md").sha256,
				},
				{ type: "state-update", target: "profile-state.json", reason: "state-missing" },
				{
					type: "create",
					target: "prompts/jouzu-review.md",
					reason: "missing",
					desiredSha256: profile.assets.find((asset) => asset.target === "prompts/jouzu-review.md").sha256,
				},
				{
					type: "create",
					target: "skills/jouzu-clear-writing/SKILL.md",
					reason: "missing",
					desiredSha256: profile.assets.find((asset) => asset.target === "skills/jouzu-clear-writing/SKILL.md").sha256,
				},
				{
					type: "create",
					target: "skills/jouzu-core/SKILL.md",
					reason: "missing",
					desiredSha256: profile.assets.find((asset) => asset.target === "skills/jouzu-core/SKILL.md").sha256,
				},
				{
					type: "create",
					target: "skills/jouzu-source-check/SKILL.md",
					reason: "missing",
					desiredSha256: profile.assets.find((asset) => asset.target === "skills/jouzu-source-check/SKILL.md").sha256,
				},
			],
		});

		const result = applyProfile(profile, fixture.paths, "0.1.0");
		assert.equal(result.changed, true);
		assert.match(result.transactionId, /^[0-9a-f-]{36}$/);
		assert.equal(
			readFileSync(join(fixture.paths.agentDir, "APPEND_SYSTEM.md"), "utf8"),
			profile.assets[0].bytes.toString(),
		);
		assert.deepEqual(planProfile(profile, fixture.paths, "0.1.0").actions, []);
		assert.equal(applyProfile(profile, fixture.paths, "0.1.0").changed, false);
	} finally {
		cleanup(fixture.root);
	}
});

test("unmanaged and modified managed files conflict before any write", () => {
	const fixture = temporary();
	try {
		const profile = loadBundledProfile("ja");
		mkdirSync(fixture.paths.agentDir, { recursive: true });
		const target = join(fixture.paths.agentDir, "APPEND_SYSTEM.md");
		writeFileSync(target, "user-owned\n");
		const plan = planProfile(profile, fixture.paths, "0.1.0");
		assert.equal(plan.actions.find((action) => action.target === "APPEND_SYSTEM.md")?.reason, "unmanaged-different");
		assert.throws(() => applyProfile(profile, fixture.paths, "0.1.0"), ProfileConflictError);
		assert.equal(readFileSync(target, "utf8"), "user-owned\n");
		assert.equal(existsSync(fixture.paths.profileStatePath), false);

		rmSync(target);
		applyProfile(profile, fixture.paths, "0.1.0");
		writeFileSync(target, "locally modified\n");
		assert.equal(
			planProfile(profile, fixture.paths, "0.1.0").actions.find((action) => action.target === "APPEND_SYSTEM.md")
				?.reason,
			"managed-modified",
		);
		assert.throws(() => applyProfile(profile, fixture.paths, "0.1.0"), ProfileConflictError);
		assert.equal(readFileSync(target, "utf8"), "locally modified\n");
	} finally {
		cleanup(fixture.root);
	}
});

test("unsupported CP932 content is reported and left byte-identical", () => {
	const fixture = temporary();
	try {
		const bytes = Buffer.from([0x82, 0xa0, 0x82, 0xa2, 0x0d, 0x0a]);
		mkdirSync(fixture.paths.agentDir, { recursive: true });
		const target = join(fixture.paths.agentDir, "APPEND_SYSTEM.md");
		writeFileSync(target, bytes);
		const plan = planProfile(loadBundledProfile("ja"), fixture.paths, "0.1.0");
		assert.equal(plan.actions.find((action) => action.target === "APPEND_SYSTEM.md")?.reason, "unsupported-encoding");
		assert.throws(() => applyProfile(loadBundledProfile("ja"), fixture.paths, "0.1.0"), ProfileConflictError);
		assert.deepEqual(readFileSync(target), bytes);
	} finally {
		cleanup(fixture.root);
	}
});

test("matching unmanaged files are adopted without rewriting", () => {
	const fixture = temporary();
	try {
		const profile = loadBundledProfile("core");
		for (const asset of profile.assets) {
			const path = join(fixture.paths.agentDir, ...asset.target.split("/"));
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, asset.bytes);
		}
		const before = profile.assets.map((asset) =>
			readFileSync(join(fixture.paths.agentDir, ...asset.target.split("/"))),
		);
		const plan = planProfile(profile, fixture.paths, "0.1.0");
		assert.equal(plan.actions.filter((action) => action.type === "adopt").length, 4);
		applyProfile(profile, fixture.paths, "0.1.0");
		const after = profile.assets.map((asset) => readFileSync(join(fixture.paths.agentDir, ...asset.target.split("/"))));
		assert.deepEqual(after, before);
	} finally {
		cleanup(fixture.root);
	}
});

test("switching from JA to Core backs up and retires only managed JA assets", () => {
	const fixture = temporary();
	try {
		const ja = loadBundledProfile("ja");
		const core = loadBundledProfile("core");
		applyProfile(ja, fixture.paths, "0.1.0");
		const userAgents = join(fixture.paths.agentDir, "AGENTS.md");
		writeFileSync(userAgents, "user-owned\n");
		const plan = planProfile(core, fixture.paths, "0.1.0");
		assert.equal(plan.actions.find((action) => action.target === "APPEND_SYSTEM.md")?.type, "delete");
		const result = applyProfile(core, fixture.paths, "0.1.0");
		assert.equal(existsSync(join(fixture.paths.agentDir, "APPEND_SYSTEM.md")), false);
		assert.equal(readFileSync(userAgents, "utf8"), "user-owned\n");
		assert.ok(result.backupDir);
		assert.ok(existsSync(join(result.backupDir, "APPEND_SYSTEM.md")));
		assert.deepEqual(planProfile(core, fixture.paths, "0.1.0").actions, []);
	} finally {
		cleanup(fixture.root);
	}
});

test("managed updates are backed up before atomic replacement", () => {
	const fixture = temporary();
	try {
		const core = loadBundledProfile("core");
		applyProfile(core, fixture.paths, "0.1.0");
		const replacement = Buffer.from("updated managed asset\n");
		const updated = {
			...core,
			version: 4,
			manifestSha256: "b".repeat(64),
			assets: core.assets.map((asset, index) =>
				index === 0 ? { ...asset, bytes: replacement, sha256: hash(replacement) } : asset,
			),
		};
		const changed = updated.assets[0];
		const target = join(fixture.paths.agentDir, ...changed.target.split("/"));
		const original = readFileSync(target);
		assert.equal(planProfile(updated, fixture.paths, "0.1.0").actions[1].type, "update");
		const result = applyProfile(updated, fixture.paths, "0.1.0");
		assert.equal(readFileSync(target, "utf8"), "updated managed asset\n");
		assert.deepEqual(readFileSync(join(result.backupDir, ...changed.target.split("/"))), original);
	} finally {
		cleanup(fixture.root);
	}
});

test("stale state after an interrupted asset update converges without overwriting", () => {
	const fixture = temporary();
	try {
		const core = loadBundledProfile("core");
		applyProfile(core, fixture.paths, "0.1.0");
		const replacement = Buffer.from("replacement asset\n");
		const updated = {
			...core,
			version: 4,
			manifestSha256: "a".repeat(64),
			assets: core.assets.map((asset, index) =>
				index === 0 ? { ...asset, bytes: replacement, sha256: hash(replacement) } : asset,
			),
		};
		const target = join(fixture.paths.agentDir, ...updated.assets[0].target.split("/"));
		writeFileSync(target, replacement);
		const plan = planProfile(updated, fixture.paths, "0.1.0");
		assert.deepEqual(
			plan.actions.map((action) => action.type),
			["state-update"],
		);
		applyProfile(updated, fixture.paths, "0.1.0");
		assert.equal(readFileSync(target, "utf8"), "replacement asset\n");
		assert.equal(readProfileState(fixture.paths.profileStatePath).profileVersion, 4);
	} finally {
		cleanup(fixture.root);
	}
});

test(
	"symlink profile targets conflict without touching the link destination",
	{ skip: process.platform === "win32" ? "symlink privileges vary on Windows" : false },
	() => {
		const fixture = temporary();
		try {
			const outside = join(fixture.root, "outside.md");
			writeFileSync(outside, "outside\n");
			mkdirSync(fixture.paths.agentDir, { recursive: true });
			symlinkSync(outside, join(fixture.paths.agentDir, "APPEND_SYSTEM.md"));
			const plan = planProfile(loadBundledProfile("ja"), fixture.paths, "0.1.0");
			assert.equal(plan.actions.find((action) => action.target === "APPEND_SYSTEM.md")?.reason, "unsafe-target");
			assert.throws(() => applyProfile(loadBundledProfile("ja"), fixture.paths, "0.1.0"), ProfileConflictError);
			assert.equal(readFileSync(outside, "utf8"), "outside\n");
		} finally {
			cleanup(fixture.root);
		}
	},
);

test("an existing operation lock is preserved", () => {
	const fixture = temporary();
	try {
		mkdirSync(fixture.paths.stateDir, { recursive: true });
		const lock = join(fixture.paths.stateDir, "profile.lock");
		writeFileSync(lock, "other operation\n");
		assert.throws(() => applyProfile(loadBundledProfile("core"), fixture.paths, "0.1.0"), ProfileStateError);
		assert.equal(readFileSync(lock, "utf8"), "other operation\n");
	} finally {
		cleanup(fixture.root);
	}
});
