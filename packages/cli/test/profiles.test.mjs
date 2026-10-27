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
			"skills/jouzu-anti-slop/SKILL.md",
			"skills/jouzu-clear-writing/SKILL.md",
			"skills/jouzu-delegation/SKILL.md",
			"skills/jouzu-reference/references/configuration.md",
			"skills/jouzu-reference/references/controls.md",
			"skills/jouzu-reference/references/history.md",
			"skills/jouzu-reference/references/models.md",
			"skills/jouzu-reference/SKILL.md",
			"skills/jouzu-source-check/SKILL.md",
		],
	);
	assert.deepEqual(
		ja.assets.map((asset) => asset.target),
		[
			"APPEND_SYSTEM.md",
			"prompts/jouzu-review.md",
			"skills/jouzu-anti-slop/SKILL.md",
			"skills/jouzu-clear-writing/SKILL.md",
			"skills/jouzu-delegation/SKILL.md",
			"skills/jouzu-reference/references/configuration.md",
			"skills/jouzu-reference/references/controls.md",
			"skills/jouzu-reference/references/history.md",
			"skills/jouzu-reference/references/models.md",
			"skills/jouzu-reference/SKILL.md",
			"skills/jouzu-source-check/SKILL.md",
		],
	);
	assert.equal(core.manifestSha256, "48128a02598ab5f363a69f37e545b5e8c396584bd8f26a0180817a81332e099d");
	assert.equal(ja.manifestSha256, "a9a1688f050294c361631c8f264fffaffbd8c49c4be9b91254ddc645a95ecd7a");
});

test("reference skill has compact entry and offline links in both profiles", () => {
	for (const id of ["core", "ja"]) {
		const assets = loadBundledProfile(id).assets;
		const base = "skills/jouzu-reference/";
		const entry = assets.find((asset) => asset.target === `${base}SKILL.md`).bytes.toString("utf8");
		assert.match(entry, /^---\nname: jouzu-reference\n/);
		assert.ok(entry.length < 2200, "keep the entry point compact; load detail on demand");
		const links = [...entry.matchAll(/\]\((references\/[a-z-]+\.md)\)/g)].map((match) => match[1]);
		assert.equal(links.length, 4);
		for (const link of links) {
			const asset = assets.find((candidate) => candidate.target === `${base}${link}`);
			assert.ok(asset, `${id}: missing offline reference ${link}`);
			assert.equal(digest(asset.bytes), asset.sha256);
			assert.match(asset.bytes.toString("utf8"), /^# /);
			assert.ok(asset.bytes.length < 6000, "keep each topic a compact lookup");
		}
	}
});

test("reference targets allow Markdown only inside a Jouzu skill references directory", () => {
	for (const target of [
		"skills/jouzu-reference/references/configuration.md",
		"skills/jouzu-reference/references/run.sh",
		"skills/jouzu-reference/references/../settings.json",
		"skills/jouzu-reference/references/nested/file.md",
		"skills/other/references/configuration.md",
		"skills/jouzu-reference/settings.json",
	]) {
		const root = fixtureRoot();
		try {
			baseManifests(root);
			const manifest = JSON.parse(readFileSync(join(root, "core", "manifest.json"), "utf8"));
			manifest.assets[0].target = target;
			writeManifest(root, "core", manifest);
			if (target === "skills/jouzu-reference/references/configuration.md") {
				assert.equal(loadProfileFromRoot(root, "core").assets[0].target, target);
			} else {
				assert.throws(() => loadProfileFromRoot(root, "core"), ProfileManifestError);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("bundled skills declare bounded public workflows", () => {
	const core = loadBundledProfile("core");
	const clearWriting = core.assets
		.find((asset) => asset.target === "skills/jouzu-clear-writing/SKILL.md")
		?.bytes.toString("utf8");
	const antiSlop = core.assets
		.find((asset) => asset.target === "skills/jouzu-anti-slop/SKILL.md")
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
	assert.match(
		clearWriting ?? "",
		/Preserve useful conventions: changelog categories, issue and pull-request templates/,
	);
	assert.match(clearWriting ?? "", /Three distinct items may remain a three-item list\./);
	assert.match(clearWriting ?? "", /Check replacements against the original\./);
	assert.match(clearWriting ?? "", /brevity must not remove facts, qualifiers, or necessary context\./);
	assert.doesNotMatch(clearWriting ?? "", /ASD-STE100|[“”]/);
	assert.match(antiSlop ?? "", /^---\nname: jouzu-anti-slop\n/);
	assert.match(antiSlop ?? "", /# Anti-slop pass/);
	assert.match(antiSlop ?? "", /The test for every sentence: \*\*does it state a fact, a number, a path, a/);
	assert.match(antiSlop ?? "", /If you can't tell which bucket a sentence is in, treat it as/);
	assert.match(antiSlop ?? "", /`jouzu-clear-writing` covers structure, terminology, the reader's task, and fact/);
	assert.match(antiSlop ?? "", /### 24\. Obsolete surface narration/);
	assert.match(antiSlop ?? "", /Blunt phrasing is acceptable; don't smooth terse prose into marketing copy\./);
	assert.doesNotMatch(antiSlop ?? "", /sherpa|optimum-onnx|ORTModel|verify_export/);
	assert.equal(
		core.assets.some((asset) => asset.target === "skills/jouzu-core/SKILL.md"),
		false,
	);
	assert.match(sourceCheck ?? "", /^---\nname: jouzu-source-check\n/);
	assert.match(sourceCheck ?? "", /Do not modify files, register records, commit, or publish unless the user asks\./);
	assert.match(sourceCheck ?? "", /Repeated summaries of the same source are not independent\./);
	assert.match(sourceCheck ?? "", /instead of inventing balance/);
	assert.doesNotMatch(sourceCheck ?? "", /dialectical|REALITYCHECK_DATA|rc-db|LanceDB/);
});

test("delegation skill supplies handoffs and failure guidance in both profiles", () => {
	for (const id of ["core", "ja"]) {
		const skill = loadBundledProfile(id).assets.find((asset) => asset.target === "skills/jouzu-delegation/SKILL.md");
		assert.ok(skill);
		const text = skill.bytes.toString("utf8");
		assert.match(text, /^---\nname: jouzu-delegation\n/);
		for (const heading of ["Objective", "Context", "Constraints", "Acceptance", "Stop and report"])
			assert.ok(text.includes(`**${heading}:**`));
		assert.match(text, /Write complete sentences with normal spaces/);
		assert.match(text, /A fresh child does not receive your conversation/);
		assert.match(text, /HTTP 503/);
		assert.match(text, /Do not substitute another model/);
		assert.match(text, /do not mechanically enforce scope or guarantee model performance/);
		assert.equal(digest(skill.bytes), skill.sha256);
	}
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
