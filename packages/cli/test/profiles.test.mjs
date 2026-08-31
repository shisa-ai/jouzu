import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadBundledProfile, loadProfileFromRoot, ProfileManifestError } from "../dist/profiles.js";

function digest(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function fixtureRoot() {
	const root = mkdtempSync(join(tmpdir(), "jouzu-profiles-"));
	for (const id of ["core", "ja"]) mkdirSync(join(root, id, "assets"), { recursive: true });
	return root;
}

function writeManifest(root, id, value) {
	writeFileSync(join(root, id, "manifest.json"), `${JSON.stringify(value, null, 2)}\n`);
}

function baseManifests(root) {
	const coreBytes = Buffer.from("core\n");
	const jaBytes = Buffer.from("日本語\n");
	writeFileSync(join(root, "core", "assets", "core.md"), coreBytes);
	writeFileSync(join(root, "ja", "assets", "ja.md"), jaBytes);
	writeManifest(root, "core", {
		schemaVersion: 1,
		id: "core",
		version: 1,
		assets: [{ source: "assets/core.md", target: "prompts/jouzu-core.md", sha256: digest(coreBytes) }],
	});
	writeManifest(root, "ja", {
		schemaVersion: 1,
		id: "ja",
		version: 1,
		extends: "core",
		assets: [{ source: "assets/ja.md", target: "APPEND_SYSTEM.md", sha256: digest(jaBytes) }],
	});
}

test("bundled Core and JA profiles resolve exact ordered assets", () => {
	const core = loadBundledProfile("core");
	const ja = loadBundledProfile("ja");
	assert.deepEqual(
		core.assets.map((asset) => asset.target),
		[
			"prompts/jouzu-review.md",
			"skills/jouzu-clear-writing/SKILL.md",
			"skills/jouzu-core/SKILL.md",
			"skills/jouzu-source-check/SKILL.md",
		],
	);
	assert.deepEqual(
		ja.assets.map((asset) => asset.target),
		[
			"APPEND_SYSTEM.md",
			"prompts/jouzu-review.md",
			"skills/jouzu-clear-writing/SKILL.md",
			"skills/jouzu-core/SKILL.md",
			"skills/jouzu-source-check/SKILL.md",
		],
	);
	assert.equal(core.manifestSha256, "437111942328d86fc9d32ed95e8f9dab702f97c8ddff8ac89721811bf073a82f");
	assert.equal(ja.manifestSha256, "99c9f7b38b7fc211e075c78cef302cd971fd39f8d47d62ada55e7e7fd9f489c8");
});

test("bundled skills declare bounded public workflows", () => {
	const core = loadBundledProfile("core");
	const clearWriting = core.assets
		.find((asset) => asset.target === "skills/jouzu-clear-writing/SKILL.md")
		?.bytes.toString("utf8");
	const coreWorkflow = core.assets
		.find((asset) => asset.target === "skills/jouzu-core/SKILL.md")
		?.bytes.toString("utf8");
	const sourceCheck = core.assets
		.find((asset) => asset.target === "skills/jouzu-source-check/SKILL.md")
		?.bytes.toString("utf8");
	assert.match(clearWriting ?? "", /^---\nname: jouzu-clear-writing\n/);
	assert.match(clearWriting ?? "", /durable user-facing technical artifacts/);
	assert.match(clearWriting ?? "", /\*\*Draft:\*\* create the minimum text/);
	assert.match(clearWriting ?? "", /Do not invent acronyms or abbreviations\./);
	assert.match(clearWriting ?? "", /Put prerequisites, warnings, and conditions before the actions they govern/);
	assert.match(clearWriting ?? "", /do not transfer English style rules mechanically/);
	assert.doesNotMatch(clearWriting ?? "", /ASD-STE100|[“”]/);
	assert.match(coreWorkflow ?? "", /^---\nname: jouzu-core\n/);
	assert.match(coreWorkflow ?? "", /Work directly by default/);
	assert.match(coreWorkflow ?? "", /Validate the result/);
	assert.doesNotMatch(coreWorkflow ?? "", /vcc_recall|web_fetch|TaskCreate|multiloop|schedule_prompt/);
	assert.match(sourceCheck ?? "", /^---\nname: jouzu-source-check\n/);
	assert.match(sourceCheck ?? "", /Do not modify files, register records, commit, or publish unless the user asks\./);
	assert.match(sourceCheck ?? "", /Repeated summaries of the same source are not independent\./);
	assert.match(sourceCheck ?? "", /instead of inventing balance/);
	assert.doesNotMatch(sourceCheck ?? "", /dialectical|REALITYCHECK_DATA|rc-db|LanceDB/);
});

test("manifest validation fails closed for schema, path, inheritance, and digest errors", () => {
	const mutations = [
		(manifest) => {
			manifest.schemaVersion = 2;
		},
		(manifest) => {
			manifest.unknown = true;
		},
		(manifest) => {
			manifest.assets[0].source = "../escape.md";
		},
		(manifest) => {
			manifest.assets[0].target = "../escape.md";
		},
		(manifest) => {
			manifest.assets[0].target = "AGENTS.md";
		},
		(manifest) => {
			manifest.assets[0].sha256 = "0".repeat(64);
		},
	];
	for (const mutate of mutations) {
		const root = fixtureRoot();
		try {
			baseManifests(root);
			const manifest = JSON.parse(readFileSync(join(root, "core", "manifest.json"), "utf8"));
			mutate(manifest);
			writeManifest(root, "core", manifest);
			assert.throws(() => loadProfileFromRoot(root, "core"), ProfileManifestError);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}

	const inheritanceRoot = fixtureRoot();
	try {
		baseManifests(inheritanceRoot);
		const manifest = JSON.parse(readFileSync(join(inheritanceRoot, "ja", "manifest.json"), "utf8"));
		delete manifest.extends;
		writeManifest(inheritanceRoot, "ja", manifest);
		assert.throws(() => loadProfileFromRoot(inheritanceRoot, "ja"), /invalid inheritance/);
	} finally {
		rmSync(inheritanceRoot, { recursive: true, force: true });
	}
});

test("manifest validation rejects duplicate targets, invalid UTF-8, and symlink assets", () => {
	const duplicateRoot = fixtureRoot();
	try {
		baseManifests(duplicateRoot);
		const jaBytes = Buffer.from("override\n");
		writeFileSync(join(duplicateRoot, "ja", "assets", "ja.md"), jaBytes);
		writeManifest(duplicateRoot, "ja", {
			schemaVersion: 1,
			id: "ja",
			version: 1,
			extends: "core",
			assets: [{ source: "assets/ja.md", target: "prompts/jouzu-core.md", sha256: digest(jaBytes) }],
		});
		assert.throws(() => loadProfileFromRoot(duplicateRoot, "ja"), /duplicate resolved profile target/);
	} finally {
		rmSync(duplicateRoot, { recursive: true, force: true });
	}

	const encodingRoot = fixtureRoot();
	try {
		baseManifests(encodingRoot);
		const bytes = Buffer.from([0x82, 0xa0]);
		writeFileSync(join(encodingRoot, "core", "assets", "core.md"), bytes);
		const manifest = JSON.parse(readFileSync(join(encodingRoot, "core", "manifest.json"), "utf8"));
		manifest.assets[0].sha256 = digest(bytes);
		writeManifest(encodingRoot, "core", manifest);
		assert.throws(() => loadProfileFromRoot(encodingRoot, "core"), /not valid UTF-8/);
	} finally {
		rmSync(encodingRoot, { recursive: true, force: true });
	}

	if (process.platform !== "win32") {
		const symlinkRoot = fixtureRoot();
		try {
			baseManifests(symlinkRoot);
			rmSync(join(symlinkRoot, "core", "assets", "core.md"));
			symlinkSync(join(symlinkRoot, "ja", "assets", "ja.md"), join(symlinkRoot, "core", "assets", "core.md"));
			assert.throws(() => loadProfileFromRoot(symlinkRoot, "core"), /regular file/);
		} finally {
			rmSync(symlinkRoot, { recursive: true, force: true });
		}
	}
});
