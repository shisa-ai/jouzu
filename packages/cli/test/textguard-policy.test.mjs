import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NativeContentPolicy, TEXTGUARD_WEB_TOOLS } from "../dist/textguard-policy.js";

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
const scanner = (scan = async (text) => (text.includes("PRIVATE") ? error : clear)) => ({
	async initialize() {
		return "a".repeat(64);
	},
	scan,
	async close() {},
});
const policy = (scan) => new NativeContentPolicy({ cwd: process.cwd(), scanner: scanner(scan) });
const result = (text) => ({ content: [{ type: "text", text }], details: {} });
const event = (name = "web_fetch", text = "PRIVATE BODY", input = { url: "https://example.com" }) => ({
	toolName: name,
	toolCallId: "fixture",
	input,
	result: result(text),
});

test("every shipped web tool withholds complete text and structured details together", async () => {
	for (const name of TEXTGUARD_WEB_TOOLS) {
		const gate = policy();
		const request = event(name, "public");
		request.result.details = { nested: [{ body: "PRIVATE DETAIL" }] };
		const blocked = await gate.filterToolResult(request);
		assert.equal(blocked.isError, true);
		assert.deepEqual(blocked.details, {});
		assert.equal(JSON.stringify(blocked).includes("PRIVATE"), false);
		assert.equal(gate.reviews().length, 1);
		gate.admission.approve(gate.reviews()[0].id);
		const allowed = await gate.filterToolResult(request);
		assert.equal(allowed.content[0].text, "public");
		assert.deepEqual(allowed.details, request.result.details);
		request.result.details.nested[0].body = "PRIVATE CHANGED";
		assert.equal((await gate.filterToolResult(request)).isError, true);
	}
});

test("ordinary reads retain scope while skill reads and unknown read paths are checked", async () => {
	const gate = policy();
	assert.equal(gate.shouldInspectTool("read", { path: "guide/SKILL.md" }), true);
	assert.equal(gate.shouldInspectTool("read", { path: "code.ts" }), false);
	assert.equal(gate.shouldInspectTool("bash", { command: "anything" }), false);
	const ordinary = event("read", "PRIVATE BODY", { path: "code.ts" });
	assert.equal(await gate.filterToolResult(ordinary), ordinary.result);
	assert.equal((await gate.filterToolResult(event("read", "PRIVATE BODY", { path: "guide/SKILL.md" }))).isError, true);
	assert.equal((await gate.filterToolResult(event("read", "PRIVATE BODY", {}))).isError, true);
});

test("restored tool context reconstructs source identity, and detached results are withheld", async () => {
	const request = event();
	const gate = policy();
	const call = {
		role: "assistant",
		content: [{ type: "toolCall", id: request.toolCallId, name: request.toolName, arguments: request.input }],
	};
	const tool = {
		role: "toolResult",
		toolCallId: request.toolCallId,
		toolName: request.toolName,
		timestamp: 1,
		...request.result,
		isError: false,
	};
	const blocked = await gate.filterContext([call, tool]);
	assert.equal(blocked[1].isError, true);
	assert.equal(JSON.stringify(blocked[1]).includes("PRIVATE"), false);
	gate.admission.approve(gate.reviews()[0].id);
	assert.equal((await gate.filterContext([call, tool]))[1].content[0].text, "PRIVATE BODY");
	const fresh = policy();
	const detached = await fresh.filterContext([tool]);
	assert.equal(detached[0].isError, true);
	assert.deepEqual(fresh.reviews(), []);
	const ordinaryCall = {
		role: "assistant",
		content: [{ type: "toolCall", id: "ordinary", name: "read", arguments: { path: "code.ts" } }],
	};
	const ordinary = { ...tool, toolName: "read", toolCallId: "ordinary" };
	assert.equal((await fresh.filterContext([ordinaryCall, ordinary]))[1], ordinary);
});

test("structured snapshots isolate post-check mutation and cancellation never releases content", async () => {
	const request = event("web_fetch", "public");
	let started;
	let release;
	const ready = new Promise((resolve) => {
		started = resolve;
	});
	const gate = policy(async () => {
		started();
		return new Promise((resolve) => {
			release = resolve;
		});
	});
	const pending = gate.filterToolResult(request);
	await ready;
	request.result.content[0].text = "PRIVATE MUTATION";
	release(clear);
	assert.equal((await pending).content[0].text, "public");
	const other = policy();
	assert.equal(
		(await other.filterToolResult({ ...event("web_fetch", "public"), signal: AbortSignal.abort() })).isError,
		true,
	);
	await assert.rejects(other.filterContext([], AbortSignal.abort()), /interrupted/);
});

test("images require explicit incomplete-coverage approval even when accompanying text is clear", async () => {
	const gate = policy();
	const request = event("tff-fetch_url", "public");
	request.result.content.push({ type: "image", mimeType: "image/png", data: "AAAA" });
	assert.equal((await gate.filterToolResult(request)).isError, true);
	assert.equal(gate.reviews()[0].evidence.reason, "unsupported-content");
	gate.admission.approve(gate.reviews()[0].id);
	assert.deepEqual((await gate.filterToolResult(request)).content, request.result.content);
});

test("approved skill expansion inherits only the exact checked prefix, and reset removes it", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "jouzu-policy-skill-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "SKILL.md");
	await writeFile(path, "---\nname: fixture\ndescription: fixture\n---\nPRIVATE BODY\n");
	const skill = {
		name: "fixture",
		description: "fixture",
		filePath: path,
		baseDir: directory,
		disableModelInvocation: false,
		sourceInfo: { path, source: "fixture", scope: "temporary", origin: "top-level" },
	};
	const gate = policy();
	assert.deepEqual(await gate.filterSkills([skill]), []);
	gate.admission.approve(gate.reviews()[0].id);
	assert.equal((await gate.filterSkills([skill])).length, 1);
	assert.match(await gate.readSkill(skill), /PRIVATE BODY/);
	const text = `<skill name="fixture" location="${path}">\nReferences are relative to ${directory}.\n\nPRIVATE BODY\n</skill>`;
	const message = { role: "user", content: `${text}\n\nuser arguments`, timestamp: 1 };
	assert.deepEqual((await gate.filterContext([message]))[0], message);
	const changed = { ...message, content: message.content.replace("PRIVATE BODY", "PRIVATE CHANGED") };
	assert.equal(JSON.stringify((await gate.filterContext([changed]))[0]).includes("PRIVATE"), false);
	gate.clear();
	assert.equal(JSON.stringify((await gate.filterContext([message]))[0]).includes("PRIVATE"), false);
});

test("expanded user messages return the checked snapshot after concurrent mutation", async () => {
	const message = {
		role: "user",
		content: [{ type: "text", text: '<skill name="fixture">public</skill>' }],
		timestamp: 1,
	};
	const gate = policy(async () => {
		message.content[0].text = "PRIVATE MUTATION";
		return clear;
	});
	const checked = await gate.filterContext([message]);
	assert.equal(checked[0].content[0].text, '<skill name="fixture">public</skill>');
});

test("scanner exceptions withhold content without exposing exception text", async () => {
	const gate = policy(async () => {
		throw Error("PRIVATE ERROR");
	});
	const withheld = await gate.filterToolResult(event());
	assert.equal(JSON.stringify(withheld).includes("PRIVATE"), false);
	assert.equal(withheld.isError, true);
	assert.equal(gate.reviews()[0].evidence.status, "unavailable");
});
