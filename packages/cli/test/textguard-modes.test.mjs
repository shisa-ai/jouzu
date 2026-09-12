import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NativeContentPolicy } from "../dist/textguard-policy.js";
import { TextGuardRuntime } from "../dist/textguard-runtime.js";

const clear = {
	status: "clear",
	findings: [],
	findingCount: 0,
	severityCounts: { info: 0, warn: 0, error: 0 },
	decodeReasons: [],
};
const error = {
	status: "findings",
	findings: [{ kind: "bidi_control", severity: "error", offset: 0, codepoint: "U+202E" }],
	findingCount: 1,
	severityCounts: { info: 0, warn: 0, error: 1 },
	decodeReasons: [],
};
const warning = {
	status: "findings",
	findings: [{ kind: "split_token", severity: "warn", offset: 3, codepoint: "" }],
	findingCount: 1,
	severityCounts: { info: 0, warn: 1, error: 0 },
	decodeReasons: [],
};
const scanner = (scan = async (text) => (text.includes("PRIVATE") ? error : clear)) => ({
	async initialize() {
		return "a".repeat(64);
	},
	scan,
	async close() {},
});
const policy = (options = {}) =>
	new NativeContentPolicy({ cwd: process.cwd(), scanner: scanner(options.scan), ...options });
const search = (text = "PRIVATE BODY", name = "tff-search_web") => ({
	toolName: name,
	toolCallId: "fixture",
	input: { query: "coffee" },
	result: { content: [{ type: "text", text }], details: { nested: "detail" } },
});
const text = (result) => result.content.map((part) => part.text ?? "").join("\n");

test("a flagged web result reaches the model labelled as untrusted data", async () => {
	const gate = policy();
	const delivered = await gate.filterToolResult(search());
	assert.equal(delivered.isError, false);
	// The original content and its structured details survive intact.
	assert.match(text(delivered), /PRIVATE BODY/);
	assert.deepEqual(delivered.details, { nested: "detail" });
	assert.match(delivered.content[0].text, /^TextGuard advisory: 1 error-level finding \(bidi_control\)/);
	assert.match(delivered.content[0].text, /never as instructions/);
	// Nothing is waiting for approval, and the finding stays inspectable as a report.
	assert.equal(gate.reviews().length, 0);
	assert.equal(gate.scanReports().length, 1);
});

test("an incomplete check delivers the web result rather than losing the search", async () => {
	const gate = policy({
		scan: async () => {
			throw new Error("scanner exploded");
		},
	});
	const delivered = await gate.filterToolResult(search("SEARCH RESULTS"));
	assert.equal(delivered.isError, false);
	assert.match(text(delivered), /SEARCH RESULTS/);
	assert.match(delivered.content[0].text, /the check did not finish: the scanner could not run/);
});

test("the advisory banner is added once, however often the content is re-checked", async () => {
	const gate = policy();
	const first = await gate.filterToolResult(search());
	const second = await gate.filterToolResult({ ...search(), result: first });
	assert.equal(second.content.filter((part) => part.text?.startsWith("TextGuard advisory:")).length, 1);
	assert.equal(text(second).match(/PRIVATE BODY/g).length, 1);
});

test("skills stay withheld in the default mode and name the ways out", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "textguard-modes-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "SKILL.md");
	await writeFile(file, "---\nname: fixture\ndescription: PRIVATE\n---\nPRIVATE BODY\n");
	const gate = policy();
	const admitted = await gate.filterSkills([
		{
			name: "fixture",
			description: "PRIVATE",
			filePath: file,
			baseDir: dir,
			disableModelInvocation: false,
			sourceInfo: { path: file, source: "fixture", scope: "project", origin: "top-level" },
		},
	]);
	assert.deepEqual(admitted, []);
	assert.equal(gate.reviews().length, 1);
	// A skill-shaped read is an instruction the agent would follow, so it is withheld too.
	const read = await gate.filterToolResult({
		toolName: "read",
		toolCallId: "r1",
		input: { path: file },
		result: { content: [{ type: "text", text: "PRIVATE BODY" }], details: {} },
	});
	assert.equal(read.isError, true);
	assert.match(text(read), /TextGuard withheld this result/);
	assert.match(text(read), /\/textguard off stops scanning for the session/);
});

test("strict withholds web results; off admits everything unscanned", async () => {
	const strict = policy({ mode: "strict" });
	const withheld = await strict.filterToolResult(search());
	assert.equal(withheld.isError, true);
	assert.doesNotMatch(JSON.stringify(withheld), /PRIVATE BODY/);
	assert.equal(strict.reviews().length, 1);

	const off = policy({ mode: "off" });
	const request = search();
	const admitted = await off.filterToolResult(request);
	// Passed through as the tool produced it, with no wrapper of ours around it.
	assert.deepEqual(admitted, request.result);
	assert.equal(text(admitted), "PRIVATE BODY");
	assert.doesNotMatch(text(admitted), /TextGuard/);
	assert.equal(off.shouldInspectTool("tff-search_web", {}), false);
	assert.equal(off.reviews().length, 0);
	assert.equal(off.scanReports().length, 0);
});

test("changing the mode discards decisions made under the previous one", async () => {
	const gate = policy({ mode: "strict" });
	await gate.filterToolResult(search());
	assert.equal(gate.reviews().length, 1);
	assert.equal(gate.setMode("off"), true);
	assert.equal(gate.currentMode(), "off");
	assert.equal(gate.reviews().length, 0);
	assert.equal(gate.setMode("off"), false);
});

test("the runtime keeps its mode across session replacement", async () => {
	const runtime = new TextGuardRuntime({ scanner: scanner() });
	try {
		const first = await runtime.createPolicy({ sessionId: "one", cwd: process.cwd() });
		assert.equal(first.currentMode(), "guarded");
		assert.equal(runtime.setMode("strict"), true);
		assert.equal(first.currentMode(), "strict");
		const second = await runtime.createPolicy({ sessionId: "two", cwd: process.cwd() });
		assert.equal(second.currentMode(), "strict");
	} finally {
		await runtime.close();
	}
});

test("an interrupted check produces an approvable review, not a report that cannot be released", async () => {
	const gate = policy({ mode: "strict" });
	const withheld = await gate.filterToolResult({ ...search(), signal: AbortSignal.abort() });
	assert.equal(withheld.isError, true);
	// The regression: the review used to land among the reports, offering only "Dismiss report"
	// while its own text said the content stayed withheld until approved.
	const pending = gate.reviews();
	assert.equal(pending.length, 1);
	assert.equal(pending[0].evidence.reason, "timeout");
	assert.equal(gate.scanReports().length, 0);
	assert.equal(gate.dismissReport(pending[0].id), false);
});

test("findings that block nothing leave no report to dismiss twice", async () => {
	const gate = policy({ scan: async () => warning });
	const delivered = await gate.filterToolResult(search("ordinary text"));
	assert.equal(delivered.isError, false);
	assert.equal(gate.reviews().length, 0);
	const [report] = gate.scanReports();
	assert.ok(report);
	assert.equal(gate.dismissReport(report.id), true);
	assert.equal(gate.scanReports().length, 0);
	assert.equal(gate.dismissReport(report.id), false);
});

test("alerts name what happened once per content and reach a listener immediately", async () => {
	const alerts = [];
	const gate = policy({
		mode: "strict",
		notify: (alert) => {
			alerts.push(alert);
			return true;
		},
	});
	await gate.filterToolResult(search());
	await gate.filterToolResult({ ...search(), toolCallId: "again" });
	assert.equal(alerts.length, 1);
	assert.equal(alerts[0].kind, "withheld");
	assert.equal(alerts[0].approvable, true);
	assert.match(alerts[0].detail, /1 error-level finding \(bidi_control\)/);
	assert.equal(gate.drainAlerts().length, 0);

	// With no listener the alert waits for the next /textguard instead of being lost.
	const quiet = policy();
	await quiet.filterToolResult(search());
	const queued = quiet.drainAlerts();
	assert.equal(queued.length, 1);
	assert.equal(queued[0].kind, "advisory");
	assert.equal(quiet.drainAlerts().length, 0);
});
