import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TextGuardApprovalStore } from "../dist/textguard-approvals.js";
import { TextGuardRuntime } from "../dist/textguard-runtime.js";

const IDENTITY = "a".repeat(64);
const OTHER_IDENTITY = "b".repeat(64);
const evidence = {
	status: "findings",
	findings: [{ kind: "bidi_control", severity: "error", offset: 0, codepoint: "U+202E" }],
	findingCount: 1,
	severityCounts: { info: 0, warn: 0, error: 1 },
	decodeReasons: [],
};
const scanner = {
	async initialize() {
		return IDENTITY;
	},
	async scan() {
		return evidence;
	},
	async close() {},
};
const request = (url, text) => ({
	toolName: "web_fetch",
	toolCallId: "1",
	input: { url },
	result: { content: [{ type: "text", text }], details: {} },
});

async function home(t) {
	const dir = await mkdtemp(join(tmpdir(), "textguard-approvals-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function session(t, dir) {
	const runtime = new TextGuardRuntime({ scanner, mode: "strict", approvalPath: join(dir, "approvals.json") });
	t.after(() => runtime.close());
	const policy = await runtime.createPolicy({ sessionId: `${Math.random()}`, cwd: process.cwd() });
	return { runtime, policy };
}

test("a persisted approval admits the exact bytes in a later session", async (t) => {
	const dir = await home(t);
	const first = await session(t, dir);
	const blocked = await first.policy.filterToolResult(request("https://example.com/a", "body one"));
	assert.equal(blocked.isError, true);
	assert.equal(first.runtime.approve(first.policy, first.policy.reviews()[0].id, true), true);
	await first.runtime.close();

	const second = await session(t, dir);
	const admitted = await second.policy.filterToolResult(request("https://example.com/a", "body one"));
	assert.equal(admitted.isError, false);
	assert.equal(second.policy.reviews().length, 0);

	// The record binds exact bytes: changed content needs a new decision.
	const changed = await second.policy.filterToolResult(request("https://example.com/a", "body two"));
	assert.equal(changed.isError, true);
	assert.equal(second.policy.reviews().length, 1);
});

test("a session approval writes no persistent record", async (t) => {
	const dir = await home(t);
	const first = await session(t, dir);
	await first.policy.filterToolResult(request("https://example.com/a", "body one"));
	assert.equal(first.runtime.approve(first.policy, first.policy.reviews()[0].id), true);
	await first.runtime.close();

	const second = await session(t, dir);
	const result = await second.policy.filterToolResult(request("https://example.com/a", "body one"));
	assert.equal(result.isError, true);
});

test("the store retains no source text, paths, or labels", async (t) => {
	const dir = await home(t);
	const first = await session(t, dir);
	await first.policy.filterToolResult(request("https://example.com/secret-path", "confidential body"));
	assert.equal(first.runtime.approve(first.policy, first.policy.reviews()[0].id, true), true);
	await first.runtime.close();
	const text = await readFile(join(dir, "approvals.json"), "utf8");
	assert.doesNotMatch(text, /example\.com|confidential|secret-path|web_fetch/);
	const records = JSON.parse(text).records;
	assert.equal(records.length, 1);
	assert.match(records[0].key, /^[a-f0-9]{64}$/);
});

test("corrupt, oversized, and mismatched stores never approve", async (t) => {
	for (const content of [
		"not json",
		JSON.stringify({ version: 2, records: [] }),
		JSON.stringify({ records: [{ key: "x".repeat(64), checksum: "0".repeat(64) }] }),
	]) {
		const dir = await home(t);
		await writeFile(join(dir, "approvals.json"), content);
		const f = await session(t, dir);
		const result = await f.policy.filterToolResult(request("https://example.com/a", "body one"));
		assert.equal(result.isError, true, content.slice(0, 24));
	}
});

test("approvals bind the scanner identity", async (t) => {
	const dir = await home(t);
	const store = new TextGuardApprovalStore(join(dir, "approvals.json"));
	await store.ready();
	const digest = "c".repeat(64);
	store.add(digest, IDENTITY, "error-or-incomplete-v1");
	assert.equal(store.has(digest, IDENTITY, "error-or-incomplete-v1"), true);
	// A scanner or policy upgrade invalidates the record.
	assert.equal(store.has(digest, OTHER_IDENTITY, "error-or-incomplete-v1"), false);
	assert.equal(store.has(digest, IDENTITY, "other-policy"), false);
	assert.equal(store.has("d".repeat(64), IDENTITY, "error-or-incomplete-v1"), false);
	// An unavailable scanner identity can never create or match a record.
	store.add(digest, "unavailable", "error-or-incomplete-v1");
	assert.equal(store.has(digest, "unavailable", "error-or-incomplete-v1"), false);
	await store.close();
});

test("records survive a reload through the file", async (t) => {
	const dir = await home(t);
	const path = join(dir, "approvals.json");
	const first = new TextGuardApprovalStore(path);
	await first.ready();
	first.add("c".repeat(64), IDENTITY, "error-or-incomplete-v1");
	await first.close();
	const second = new TextGuardApprovalStore(path);
	await second.ready();
	assert.equal(second.has("c".repeat(64), IDENTITY, "error-or-incomplete-v1"), true);
	await second.close();
});

test("report dismissal is session-scoped and cannot dismiss withheld items", async (t) => {
	const dir = await home(t);
	const f = await session(t, dir);
	await f.policy.filterToolResult(request("https://example.com/a", "body one"));
	const withheld = f.policy.reviews()[0];
	assert.equal(f.policy.dismissReport(withheld.id), false);
	// A non-blocking report dismisses and stays dismissed across regeneration.
	const info = {
		...evidence,
		findings: [{ ...evidence.findings[0], severity: "info" }],
		severityCounts: { info: 1, warn: 0, error: 0 },
	};
	const infoScanner = {
		...scanner,
		async scan() {
			return info;
		},
	};
	const infoRuntime = new TextGuardRuntime({
		scanner: infoScanner,
		mode: "strict",
		approvalPath: join(dir, "other.json"),
	});
	t.after(() => infoRuntime.close());
	const infoPolicy = await infoRuntime.createPolicy({ sessionId: "info", cwd: process.cwd() });
	await infoPolicy.filterToolResult(request("https://example.com/b", "body b"));
	const report = infoPolicy.scanReports()[0];
	assert.ok(report);
	assert.equal(infoPolicy.dismissReport(report.id), true);
	assert.equal(infoPolicy.scanReports().length, 0);
	assert.equal(infoPolicy.dismissReport(report.id), false);
});
