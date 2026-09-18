import assert from "node:assert/strict";
import { test } from "node:test";
import { formatFlowStatus, projectFlowStatus } from "../dist/flow-control/flow-status.js";
import {
	captureFlowStatusContext,
	describeFlowInput,
	flowDisplayText,
} from "../dist/flow-control/flow-status-context.js";
import { createFlowStatusExtension } from "../dist/flow-control/flow-status-extension.js";
import { terminalTextWidth } from "../dist/terminal-layout.js";
import { assembledSession, capturedNotices, installedProducerExtensions } from "./fixtures/flow-assembly.mjs";

const scope = { sessionId: "session", branchId: "branch" };
const input = (id, extra = {}) => ({
	id,
	revision: 1,
	admission: "held",
	delivery: "none",
	attemptIds: [],
	...extra,
});
const request = {
	requestId: "request-1",
	operationId: "operation-1",
	outcome: "withheld",
	hold: { hash: "a".repeat(64), reason: "required-input" },
	sources: [],
};
const context = {
	inputs: {
		continuation: { sender: "Jouzu", summary: "Continue after compaction", kind: "continuation", acceptedAt: 0 },
		old: { sender: "You", summary: "/flow", kind: "command", acceptedAt: 0 },
		notice: { sender: "pi-multiloop", summary: "Resume notice", kind: "notice", acceptedAt: 0 },
	},
	requests: {
		"request-1": {
			inputIds: ["continuation"],
			stage: "context preparation",
			provider: "fixture",
			model: "fixture-model",
		},
	},
	tasks: [],
};

test("reopened failure reports its source and puts recovery ahead of resume", () => {
	const status = projectFlowStatus(
		scope,
		[
			input("continuation", { nativeRequests: [request] }),
			input("old", { reason: "Input was not dispatched before the session ended. Submit it again to run it." }),
			input("notice", { reason: "Input is waiting for recovery reconciliation." }),
		],
		[],
		[],
		[],
		[],
		"the session was reopened",
		context,
	);
	const text = formatFlowStatus(status, 60_000);
	assert.match(text, /^Blocked: 1 request was not sent/);
	assert.match(text, /Jouzu: Continue after compaction/);
	assert.match(text, /context preparation/);
	assert.match(text, /fixture-model/);
	assert.match(text, /Not delivered before closing/);
	assert.match(text, /You: \/flow/);
	assert.match(text, /pi-multiloop: Resume notice/);
	assert.doesNotMatch(text, /Resume now with: \/flow resume/);
	assert.doesNotMatch(text, /Submit it again to run it/);
	assert.doesNotMatch(text, /recovery reconciliation/);
});

test("one request joined to multiple inputs is counted once", () => {
	const status = projectFlowStatus(
		scope,
		[
			input("continuation", { nativeRequests: [request] }),
			input("other", { nativeRequests: [{ ...request, operationId: "operation-2" }] }),
		],
		[],
		[],
		[],
		[],
		undefined,
		context,
	);
	assert.equal(status.retryable.length, 1);
});

test("task state reports titles and actual dependency reasons without identity hashes", () => {
	const key = "b".repeat(64);
	const task = {
		key,
		taskId: "3",
		revision: "c".repeat(64),
		state: "blocked",
		subject: "Execute two GPU shards",
		status: "pending",
		reason: "Waiting for task #2",
		blockedBy: ["2"],
	};
	const work = {
		id: "tasks-work:opaque",
		owner: "tasks",
		participants: ["tasks"],
		revision: 1,
		createdAt: 0,
		binding: { producer: "tasks", key: [key] },
		producerRevision: task.revision,
		lifecycle: { state: "paused", reason: "Producer state changed", changedAt: 0 },
	};
	const status = projectFlowStatus(scope, [], [], [work], [], [], undefined, { ...context, tasks: [task] });
	const text = formatFlowStatus(status, 0);
	assert.match(text, /Task #3: Execute two GPU shards/);
	assert.match(text, /Waiting for task #2/);
	assert.doesNotMatch(text, /Producer state changed|tasks-work:opaque|bbbbbbbb/);
	assert.match(formatFlowStatus(status, 0, { details: true }), /tasks-work:opaque/);
});

const record = (id, origin, first, api = "prompt") => ({
	id,
	revision: 1,
	acceptedAt: 1000,
	status: "retained",
	submission: {
		version: 1,
		id,
		api,
		args: [first],
		origin,
		scope: { sessionId: "session", attachmentId: "attachment", leafId: null },
	},
	dispatch: { operationId: `op-${id}`, ownerId: "owner", phase: "returned" },
});

test("input descriptions use the recorded sender and redact bounded terminal previews", () => {
	const saved = record("s1", { kind: "host", id: "prompt" }, "Hello api_key=secret-value\n\u001b[31mred");
	const described = describeFlowInput(saved);
	assert.equal(described.sender, "You");
	assert.equal(described.acceptedAt, 1000);
	assert.match(described.summary, /api_key=\[redacted\]/);
	assert.doesNotMatch(described.summary, /secret-value|\n/);
	assert.equal(described.summary.includes("\u001b"), false);
	assert.equal(
		describeFlowInput(
			record(
				"s2",
				{ kind: "extension", id: "C:\\private\\node_modules\\@example\\agent\\src\\index.ts" },
				{ customType: "update", content: "Notice" },
				"sendCustomMessage",
			),
		).sender,
		"@example/agent",
	);
	assert.doesNotMatch(
		flowDisplayText("Bearer abc123 https://user:pass@example.test sk-123456789012345"),
		/abc123|user:pass|sk-123/,
	);
	assert.ok(terminalTextWidth(flowDisplayText("日本語".repeat(100), 40)) <= 40);
	assert.ok(Buffer.byteLength(flowDisplayText("\u0301".repeat(10000), 300)) < 4096);
});

test("request descriptions identify the failed required source, not unrelated surviving history", () => {
	const records = [
		record("old", { kind: "host", id: "prompt" }, "Already delivered"),
		record(
			"continuation",
			{ kind: "extension", id: "<inline:jouzu>" },
			{ customType: "jouzu-compaction-continue", content: [] },
			"sendCustomMessage",
		),
	];
	const raw = {
		id: "request-1",
		ownerId: "owner",
		outcome: "withheld",
		requiredSources: [1],
		withheldPayload: {
			hash: "d".repeat(64),
			bytes: 120,
			api: "openai-completions",
			provider: "fixture",
			model: "fixture",
		},
		sourceCapture: {
			members: [
				{ index: 0, operationId: "op-old" },
				{ index: 1, operationId: "op-continuation" },
			],
			context: {
				members: [
					{ sourceIndex: 0, status: "intact" },
					{ sourceIndex: 1, status: "unresolved" },
				],
			},
			model: {
				members: [
					{ sourceIndex: 0, status: "intact" },
					{ sourceIndex: 1, status: "unresolved" },
				],
			},
		},
	};
	const result = captureFlowStatusContext(records, [raw]);
	assert.deepEqual(result.requests["request-1"].inputIds, ["continuation"]);
	assert.equal(result.requests["request-1"].stage, "context preparation");
	assert.equal(result.requests["request-1"].problem, "input-changed");
	raw.sourceCapture.context.members[1].status = "intact";
	raw.sourceCapture.model.members[1].status = "intact";
	delete raw.withheldPayload;
	const prepared = captureFlowStatusContext(records, [raw]);
	assert.equal(prepared.requests["request-1"].problem, "not-admitted");
	const text = formatFlowStatus(
		projectFlowStatus(
			scope,
			[input("continuation", { nativeRequests: [request] })],
			[],
			[],
			[],
			[],
			undefined,
			prepared,
		),
		1000,
	);
	assert.match(text, /Request ended before payload admission/);
	assert.doesNotMatch(text, /was removed or changed/);
});

test("unlinked held requests remain visible without inventing a source", () => {
	const status = projectFlowStatus(scope, [], [], [], [], [], undefined, {
		inputs: {},
		tasks: [],
		requests: {
			orphan: { inputIds: [], stage: "model conversion", hash: "a".repeat(64), reason: "required-context" },
		},
	});
	assert.equal(status.retryable.length, 1);
	assert.match(formatFlowStatus(status, 0), /no submitted message is linked/);
	assert.match(formatFlowStatus(status, 0, { details: true }), /\/flow retry orphan/);
});

test("a failing diagnostic section does not hide other readable state or claim recovery", async () => {
	let handler;
	const notices = [];
	const branch = {
		scope,
		recovery: { unresolved: 0 },
		sourceRecovery: { unresolved: 0 },
		waitSourceRecovery: { missing: [] },
		attachment: {
			waits: {
				snapshot: async () => {
					throw new Error("Job storage unavailable api_key=secret-value");
				},
				authoritySnapshot: async () => ({ work: [], executions: [], waitTokens: [] }),
			},
			submissions: { snapshot: async () => [record("old", { kind: "host", id: "prompt" }, "/status")] },
			nativeRequests: { snapshot: async () => [] },
		},
	};
	const ingress = {
		branch: () => branch,
		inspect: async () => ({
			scope,
			submissions: [
				input("old", { reason: "Input was not dispatched before the session ended. Submit it again to run it." }),
			],
			uncertain: [],
		}),
		automatedPause: () => undefined,
	};
	const extension = createFlowStatusExtension({ ingress: () => ingress });
	extension.factory({
		registerMessageRenderer() {},
		on() {},
		registerCommand(_name, command) {
			handler = command.handler;
		},
	});
	await handler("", { ui: { notify: (text) => notices.push(text) } });
	assert.match(notices[0], /Status incomplete/);
	assert.match(notices[0], /You: \/status/);
	assert.match(notices[0], /Job storage unavailable/);
	assert.doesNotMatch(notices[0], /secret-value|Nothing is held|reset completed/);
});

test("narrow status keeps mixed-width previews within the terminal", () => {
	const status = projectFlowStatus(
		scope,
		[input("old", { reason: "Input was not dispatched before the session ended. Submit it again to run it." })],
		[],
		[],
		[],
		[],
		undefined,
		{
			...context,
			inputs: { old: { sender: "You", summary: "日本語".repeat(100), kind: "message", acceptedAt: 0 } },
		},
	);
	for (const line of formatFlowStatus(status, 1000, { columns: 48 }).split("\n"))
		assert.ok(terminalTextWidth(line) <= 48, line);
});

test("a running provider request is not reported as an unknown outcome needing reset", async (t) => {
	let release;
	const response = new Promise((resolve) => {
		release = resolve;
	});
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: async () => {
			await response;
			return { text: "Finished" };
		},
	});
	const running = f.session.prompt("Hold the provider response");
	try {
		const deadline = Date.now() + 5000;
		while (!f.bodies.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(f.bodies.length, 1);
		const notices = capturedNotices(f.session);
		await f.session.prompt("/flow");
		assert.match(notices.at(-1).text, /A model turn is in progress/);
		assert.doesNotMatch(notices.at(-1).text, /no recorded outcome|needs a recovery decision|\/flow reset|\/flow clear/);
	} finally {
		release();
		await running;
	}
	assert.deepEqual(f.errors, []);
});

test("long histories have bounded output and readable detail pages", () => {
	const inputs = Object.fromEntries(
		Array.from({ length: 40 }, (_, index) => [
			`old-${index}`,
			{ sender: "You", summary: `Message number ${index}`, kind: "message", acceptedAt: 0 },
		]),
	);
	const status = projectFlowStatus(
		scope,
		Object.keys(inputs).map((id) =>
			input(id, {
				reason: "Input was not dispatched before the session ended. Submit it again to run it.",
			}),
		),
		[],
		[],
		[],
		[],
		undefined,
		{ inputs, requests: {}, tasks: [] },
	);
	const report = formatFlowStatus(status, 0);
	assert.match(report, /Showing 1-10 of 40/);
	assert.match(report, /More entries: \/flow details 2/);
	assert.doesNotMatch(report, /Message number 39/);
	assert.ok(report.split("\n").length < 50);
	const third = formatFlowStatus(status, 0, { details: true, page: 3 });
	assert.match(third, /Showing 21-30 of 40/);
	assert.match(third, /Input: old-20/);
	assert.doesNotMatch(third, /Input: old-0\n/);
});
