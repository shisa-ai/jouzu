import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const directory = process.env.TEXTGUARD_ARTIFACT_DIR ?? join(root, "packages/cli/dist/textguard");
const expected = JSON.parse(readFileSync(join(root, "upstream/textguard/artifacts.lock.json"), "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const target = `${process.platform}-${{ x64: "amd64", arm64: "arm64" }[process.arch]}`;
const executable = join(directory, expected.artifacts[target]?.filename ?? "unsupported-platform");

function run(input) {
	const result = spawnSync(executable, [], {
		input,
		encoding: "utf8",
		timeout: 10000,
		maxBuffer: 1 << 20,
		windowsHide: true,
		env: {
			...process.env,
			TEXTGUARD_PRESET: "invalid",
			TEXTGUARD_YARA_RULES_DIR: "/does-not-exist",
		},
	});
	assert.ifError(result.error);
	return result;
}

test("all six packaged executables match the reviewed manifest", () => {
	const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
	assert.deepEqual(manifest, expected);
	assert.equal(Object.keys(manifest.artifacts).length, 6);
	for (const artifact of Object.values(manifest.artifacts)) {
		const path = join(directory, artifact.filename);
		assert.equal(statSync(path).size, artifact.bytes);
		assert.equal(sha(readFileSync(path)), artifact.sha256);
	}
	for (const file of [
		"TEXTGUARD-LICENSE.txt",
		"GO-LICENSE.txt",
		"UNICODE-LICENSE.txt",
		"X-NET-LICENSE.txt",
		"X-TEXT-LICENSE.txt",
		"TOML-COPYING.txt",
	]) {
		assert.ok(readFileSync(join(directory, "licenses", file)).length > 100);
	}
});

test("native helper serves isolated complete and unavailable outcomes", () => {
	const requests = [
		{ version: 1, id: "clean", text: "日本語 ordinary documentation" },
		{ version: 1, id: "bidi", text: "hello\u202eworld" },
		{ version: 1, id: "flood", text: "\u200b".repeat(20000) },
		{ version: 1, id: "again", text: "hello" },
	];
	const result = run(requests.map((value) => JSON.stringify(value)).join("\n") + "\n");
	assert.equal(result.status, 0);
	assert.equal(result.stderr, "");
	const replies = result.stdout
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(replies.length, requests.length);
	for (let i = 0; i < replies.length; i++) {
		assert.equal(replies[i].id, requests[i].id);
		assert.equal(replies[i].input_sha256, sha(Buffer.from(requests[i].text)));
		assert.ok(replies[i].findings.length <= 64);
		assert.equal("normalized_text" in replies[i], false);
	}
	assert.equal(replies[0].status, "clear");
	assert.ok(replies[1].severity_counts.error > 0);
	assert.equal(replies[2].reason, "finding-limit");
	assert.equal(replies[3].status, "clear");
});

test("native helper rejects protocol overrides and oversized lines", () => {
	const result = run('{"version":1,"id":"a","text":"hello","yara_bundled":false}\n');
	assert.equal(result.status, 0);
	assert.equal(JSON.parse(result.stdout).reason, "protocol");
	const oversized = run("x".repeat((2 << 20) + 1) + "\n");
	assert.equal(oversized.status, 1);
	assert.equal(oversized.stdout, "");
	assert.equal(oversized.stderr.trim(), "invalid protocol input");
});
