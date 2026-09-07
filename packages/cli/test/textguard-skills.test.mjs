import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_SCAN_BYTES } from "../dist/textguard.js";
import { TextGuardAdmission } from "../dist/textguard-admission.js";
import { NativeTextGuard } from "../dist/textguard-native.js";
import { readSkillSnapshot, TextGuardSkills } from "../dist/textguard-skills.js";

const clear = {
	status: "clear",
	findings: [],
	findingCount: 0,
	severityCounts: { info: 0, warn: 0, error: 0 },
	decodeReasons: [],
};
const error = {
	status: "findings",
	findings: [{ kind: "bidi", severity: "error", offset: 0, codepoint: "U+202E" }],
	findingCount: 1,
	severityCounts: { info: 0, warn: 0, error: 1 },
	decodeReasons: [],
};
const scanner = (scan = async () => clear) => ({
	async initialize() {
		return "a".repeat(64);
	},
	scan,
	async close() {},
});
async function fixture(t, body = "hello") {
	const directory = await mkdtemp(join(tmpdir(), "jouzu-skill-gate-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "guide.md");
	await writeFile(path, body);
	return {
		directory,
		path,
		skill: {
			name: "fixture",
			description: "Fixture description",
			filePath: path,
			baseDir: directory,
			disableModelInvocation: false,
			sourceInfo: { path, source: "fixture", scope: "temporary", origin: "top-level" },
		},
	};
}

test("bounded snapshots preserve exact UTF-8 bytes including BOM and astral characters", async (t) => {
	const text = "\uFEFFこんにちは 🐈\r\n";
	const { directory, path } = await fixture(t, text);
	assert.equal((await readSkillSnapshot(path)).text, text);
	assert.deepEqual(await readSkillSnapshot(directory), { reason: "file" });
	assert.deepEqual(await readSkillSnapshot(path, AbortSignal.abort()), { reason: "timeout" });
	await writeFile(path, Buffer.from([0xff, 0xfe]));
	assert.deepEqual(await readSkillSnapshot(path), { reason: "file" });
	await writeFile(path, "x".repeat(MAX_SCAN_BYTES + 1));
	assert.deepEqual(await readSkillSnapshot(path), { reason: "input-limit" });
});

test("inventory checks metadata and body together and copies fields before scanner waits", async (t) => {
	const { directory, skill } = await fixture(t, "BODY");
	let seen;
	let release;
	let started;
	const ready = new Promise((resolve) => {
		started = resolve;
	});
	const gate = new TextGuardSkills(
		new TextGuardAdmission(
			scanner(async (text) => {
				seen = text;
				started();
				return new Promise((resolve) => {
					release = resolve;
				});
			}),
		),
		directory,
	);
	skill.extra = "DO NOT PUBLISH";
	const pending = gate.filterSkills([skill]);
	await ready;
	skill.name = "MUTATED";
	skill.sourceInfo.source = "MUTATED";
	release(clear);
	const admitted = await pending;
	assert.equal(admitted[0].name, "fixture");
	assert.equal(admitted[0].sourceInfo.source, "fixture");
	assert.equal(admitted[0].extra, undefined);
	assert.match(seen, /Fixture description/);
	assert.match(seen, /BODY/);
	assert.equal(seen.includes("DO NOT PUBLISH"), false);
	assert.equal(gate.isSkillPath(skill.filePath), true);
	assert.equal(gate.isSkillPath(join(directory, "ordinary.txt")), false);
});

test("approval is stable across reload but changed body or metadata requires a new decision", async (t) => {
	const { directory, path, skill } = await fixture(t, "BODY");
	const admission = new TextGuardAdmission(scanner(async () => error));
	const gate = new TextGuardSkills(admission, directory);
	assert.deepEqual(await gate.filterSkills([skill]), []);
	assert.equal(admission.approve(admission.reviews()[0].id), true);
	assert.equal((await gate.filterSkills([skill])).length, 1);
	assert.equal(await gate.readSkill(skill), "BODY");
	await writeFile(path, "CHANGED");
	assert.equal(await gate.readSkill(skill), undefined);
	admission.approve(admission.reviews().at(-1).id);
	assert.equal(await gate.readSkill(skill), "CHANGED");
	assert.equal(await gate.readSkill({ ...skill, description: "CHANGED METADATA" }), undefined);
	assert.equal(JSON.stringify(gate.scanReports()).includes("CHANGED METADATA"), false);
	gate.clear();
	assert.equal(await gate.readSkill(skill), undefined);
});

test("expansion returns the scanned snapshot even when the file changes during scanning", async (t) => {
	const { directory, path, skill } = await fixture(t, "CHECKED");
	const gate = new TextGuardSkills(
		new TextGuardAdmission(
			scanner(async (text) => {
				assert.match(text, /CHECKED/);
				await writeFile(path, "UNCHECKED");
				return clear;
			}),
		),
		directory,
	);
	assert.equal(await gate.readSkill(skill), "CHECKED");
});

test("unreadable files and invalid metadata never produce an approval for invented content", async (t) => {
	const { directory, path, skill } = await fixture(t);
	const admission = new TextGuardAdmission(scanner());
	const gate = new TextGuardSkills(admission, directory);
	await rm(path);
	assert.deepEqual(await gate.filterSkills([skill]), []);
	assert.equal(gate.scanNotices()[0].reason, "file");
	assert.deepEqual(admission.reviews(), []);
	assert.deepEqual(await gate.filterSkills([{ ...skill, name: "\ud800" }]), []);
	assert.equal(gate.scanNotices()[0].reason, "protocol");
	assert.deepEqual(await gate.filterSkills([{ ...skill, description: "x".repeat(16385) }]), []);
});

test("session reset prevents an in-flight scan from publishing content or new reviews", async (t) => {
	const { directory, skill } = await fixture(t);
	let release;
	let started;
	const ready = new Promise((resolve) => {
		started = resolve;
	});
	const admission = new TextGuardAdmission(
		scanner(async () => {
			started();
			return new Promise((resolve) => {
				release = resolve;
			});
		}),
	);
	const gate = new TextGuardSkills(admission, directory);
	const pending = gate.filterSkills([skill]);
	await ready;
	gate.clear();
	release(error);
	assert.deepEqual(await pending, []);
	assert.deepEqual(gate.scanReports(), []);
	assert.deepEqual(admission.reviews(), []);
});

test("native skill scanning admits multilingual text and withholds major metadata findings", async (t) => {
	const native = new NativeTextGuard();
	t.after(() => native.close());
	const { directory, skill } = await fixture(t, "こんにちは、世界。\n");
	const admission = new TextGuardAdmission(native);
	const gate = new TextGuardSkills(admission, directory);
	assert.equal((await gate.filterSkills([skill])).length, 1);
	assert.deepEqual(await gate.filterSkills([{ ...skill, description: "fixture \u202e" }]), []);
	assert.ok(admission.reviews().some((review) => review.evidence.severityCounts.error > 0));
});
