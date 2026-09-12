import assert from "node:assert/strict";
import { test } from "node:test";
import { TextGuardRuntime } from "../dist/textguard-runtime.js";

const evidence = {
	status: "findings",
	findings: [{ kind: "bidi", severity: "error", offset: 0, codepoint: "U+202E" }],
	findingCount: 1,
	severityCounts: { info: 0, warn: 0, error: 1 },
	decodeReasons: [],
};
const request = {
	toolName: "web_fetch",
	toolCallId: "1",
	input: { url: "https://example.com" },
	result: { content: [{ type: "text", text: "fixture" }], details: {} },
};
function fixture() {
	let scans = 0;
	let closes = 0;
	const runtime = new TextGuardRuntime({
		mode: "strict",
		scanner: {
			async initialize() {
				return "a".repeat(64);
			},
			async scan() {
				scans++;
				return evidence;
			},
			async close() {
				closes++;
			},
		},
	});
	return { runtime, scans: () => scans, closes: () => closes };
}

test("reload retains approvals while replacement sessions reuse verdicts without approvals", async (t) => {
	const { runtime, scans } = fixture();
	t.after(() => runtime.close());
	const first = await runtime.createPolicy({ sessionId: "first", cwd: process.cwd() });
	assert.equal((await first.filterToolResult(request)).isError, true);
	assert.equal(runtime.approve(first, first.reviews()[0].id), true);
	assert.equal((await first.filterToolResult(request)).isError, false);
	assert.equal(await runtime.createPolicy({ sessionId: "first", cwd: process.cwd() }), first);
	const second = await runtime.createPolicy({ sessionId: "second", cwd: process.cwd() });
	assert.notEqual(second, first);
	assert.equal(runtime.forSession("first"), undefined);
	assert.equal(runtime.forSession("second"), second);
	assert.equal((await second.filterToolResult(request)).isError, true);
	assert.equal(scans(), 1);
	assert.equal(runtime.approve(first, second.reviews()[0].id), false);
});

test("a changed working directory invalidates approval even if the session identifier is reused", async (t) => {
	const { runtime } = fixture();
	t.after(() => runtime.close());
	const first = await runtime.createPolicy({ sessionId: "same", cwd: process.cwd() });
	await first.filterToolResult(request);
	const review = first.reviews()[0].id;
	const second = await runtime.createPolicy({ sessionId: "same", cwd: ".." });
	assert.equal(runtime.approve(first, review), false);
	assert.equal((await second.filterToolResult(request)).isError, true);
});

test("shutdown closes the shared scanner once and invalidates pending confirmation", async () => {
	const { runtime, closes } = fixture();
	const policy = await runtime.createPolicy({ sessionId: "first", cwd: process.cwd() });
	await policy.filterToolResult(request);
	const review = policy.reviews()[0].id;
	const closing = runtime.close();
	assert.equal(runtime.close(), closing);
	await closing;
	assert.equal(closes(), 1);
	assert.equal(runtime.forSession("first"), undefined);
	assert.equal(runtime.approve(policy, review), false);
	assert.throws(() => runtime.createPolicy({ sessionId: "next", cwd: process.cwd() }), /closed/);
});
