import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateTokens, SessionManager } from "@earendil-works/pi-coding-agent";

import { createSessionStatusSnapshot, summarizeSessionActivity } from "../dist/index.js";

function context(overrides = {}) {
	return {
		cwd: "/work/日本語 project",
		model: {
			provider: "anthropic",
			id: "claude-test",
			name: "Claude Test",
			contextWindow: 200_000,
		},
		thinkingLevel: "high",
		scopedModels: [{ model: {} }, { model: {} }],
		isIdle: () => true,
		getContextUsage: () => ({ tokens: 12_000, contextWindow: 200_000, percent: 6 }),
		sessionManager: {
			getBranch: () => [
				{ type: "message", message: { role: "assistant", usage: { input: 100, output: 20, cost: { total: 99 } } } },
				{ type: "message", message: { role: "assistant", usage: { input: 40, output: 5 } } },
				{ type: "message", message: { role: "toolResult", usage: { input: 10, output: 2 } } },
				{ type: "compaction", usage: { input: 5, output: 1 } },
			],
		},
		...overrides,
	};
}

test("captures provider-neutral session facts without full paths", () => {
	const snapshot = createSessionStatusSnapshot(context(), {
		clock: { now: () => 1234 },
		idleSince: 1000,
	});
	assert.equal(snapshot.observedAt, 1234);
	assert.deepEqual(snapshot.workspace, { label: "日本語 project" });
	assert.deepEqual(snapshot.activity, { idle: true, idleSince: 1000 });
	assert.deepEqual(snapshot.model, {
		providerId: "anthropic",
		modelId: "claude-test",
		displayName: "Claude Test",
		thinkingLevel: "high",
		scopedModelCount: 2,
	});
	assert.deepEqual(snapshot.context, {
		status: "known",
		observedAt: 1234,
		value: { tokens: 12_000, window: 200_000, percent: 6 },
	});
	assert.deepEqual(snapshot.usage.value, {
		scope: "active_branch",
		inputTokens: 155,
		outputTokens: 28,
		unknownMessageCount: 4,
		cacheComplete: false,
		cost: 99,
		costEstimated: true,
		costComplete: false,
	});
	assert.doesNotMatch(JSON.stringify(snapshot), /\/work\//);
});

test("adds cache reads and writes to input and sums recorded costs on the active branch", () => {
	const usage = (input, cacheRead, cacheWrite, output, total, totalFromProvider = true) => ({
		input,
		cacheRead,
		cacheWrite,
		output,
		cost: { total, totalFromProvider },
	});
	const entries = [
		{ type: "message", message: { role: "assistant", usage: usage(20000, 160000, 20000, 10000, 0.333) } },
		{ type: "compaction", usage: usage(0, 200000, 0, 100, 0.06, false) },
		{ type: "branch_summary", usage: usage(0, 0, 0, 10, 0) },
		{ type: "usage", usage: usage(0, 0, 0, 0, 0) },
	];
	const result = createSessionStatusSnapshot(context({ sessionManager: { getBranch: () => entries } })).usage.value;
	assert.equal(result.inputTokens, 400000);
	assert.equal(result.outputTokens, 10110);
	assert.equal(result.cacheReadPercent, 90);
	assert.equal(result.cacheComplete, true);
	assert.equal(result.cost, 0.393);
	assert.equal(result.costEstimated, true);
	assert.equal(result.costComplete, true);
	assert.equal(result.unknownMessageCount, 0);
});

test("distinguishes empty, zero-cache, missing, and invalid accounting", () => {
	const capture = (entries) =>
		createSessionStatusSnapshot(
			context({
				sessionManager: { getBranch: () => entries },
			}),
		).usage.value;
	const empty = capture([]);
	assert.equal(empty.cacheComplete, true);
	assert.equal(empty.cacheReadPercent, undefined);
	assert.equal(empty.cost, null);
	const entry = (usage) => ({ type: "message", message: { role: "assistant", usage } });
	const zero = capture([
		entry({ input: 100, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0, totalFromProvider: true } }),
	]);
	assert.equal(zero.cacheReadPercent, 0);
	assert.equal(zero.cost, 0);
	assert.equal(zero.costEstimated, false);
	const invalid = capture([entry({ input: -1, output: Infinity, cacheRead: NaN, cacheWrite: 0, cost: { total: -1 } })]);
	assert.equal(invalid.inputTokens, 0);
	assert.equal(invalid.outputTokens, 0);
	assert.equal(invalid.cacheComplete, false);
	assert.equal(invalid.cost, null);
	assert.equal(invalid.costComplete, false);
	const placeholder = capture([entry({ input: 100, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } })]);
	assert.equal(placeholder.cost, null);
	assert.equal(placeholder.costComplete, false);
});

test("estimates the compacted projection until fresh usage is available", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({
		role: "system",
		content: "System instructions",
		toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
		timestamp: 1,
	});
	manager.appendMessage({ role: "user", content: "discarded".repeat(1000), timestamp: 2 });
	const kept = manager.appendMessage({ role: "user", content: "retained tail", timestamp: 3 });
	manager.appendCompaction("Compaction summary", kept, 376745);
	manager.appendMessage({ role: "user", content: "after compaction", timestamp: 4 });
	manager.appendContextEdit(kept, { content: "edited tail" });
	let usage = { tokens: null, contextWindow: 1_000_000, percent: null };
	const ctx = context({ sessionManager: manager, getContextUsage: () => usage });
	const messages = manager.buildSessionProjection().messages;
	assert.ok(messages.some((message) => message.role === "system" && message.toolsAdded?.length));
	assert.ok(messages.some((message) => message.role === "compactionSummary"));
	assert.doesNotMatch(JSON.stringify(messages), /discarded|retained tail/);
	const expected = messages.reduce((total, message) => total + estimateTokens(message), 0);
	const estimated = createSessionStatusSnapshot(ctx).context;
	assert.equal(estimated.status, "partial");
	assert.deepEqual(estimated.value, {
		tokens: expected,
		window: 1_000_000,
		percent: (expected / 1_000_000) * 100,
		approximate: true,
	});
	usage = { tokens: 1234, contextWindow: 1_000_000, percent: 0.1234 };
	const measured = createSessionStatusSnapshot(ctx).context;
	assert.equal(measured.status, "known");
	assert.deepEqual(measured.value, { tokens: 1234, window: 1_000_000, percent: 0.1234 });
});

test("keeps missing context unknown without a compaction", () => {
	const ctx = context({
		sessionManager: SessionManager.inMemory(),
		getContextUsage: () => ({ tokens: null, contextWindow: 1000, percent: null }),
	});
	assert.deepEqual(createSessionStatusSnapshot(ctx).context.value, { window: 1000 });
});

test("labels incomplete context and usage honestly", () => {
	const snapshot = createSessionStatusSnapshot(
		context({
			model: undefined,
			thinkingLevel: undefined,
			scopedModels: [],
			isIdle: () => false,
			getContextUsage: () => ({ tokens: 500, contextWindow: 1000, percent: null }),
			sessionManager: {
				getBranch: () => [{ type: "message", message: { role: "assistant" } }],
			},
		}),
		{ clock: { now: () => 2000 }, idleSince: 1000 },
	);
	assert.deepEqual(snapshot.activity, { idle: false });
	assert.deepEqual(snapshot.model, { scopedModelCount: 0 });
	assert.deepEqual(snapshot.context, {
		status: "partial",
		observedAt: 2000,
		value: { tokens: 500, window: 1000 },
	});
	assert.equal(snapshot.usage.status, "partial");
	assert.equal(snapshot.usage.value.unknownMessageCount, 1);
});

test("summarizes branch activity and splits reply usage by model in first-use order", () => {
	const reply = (minute, provider, model, content, usage) => ({
		type: "message",
		timestamp: new Date(Date.UTC(2026, 10, 14, 5, minute)).toISOString(),
		message: { role: "assistant", provider, model, content, ...(usage ? { usage } : {}) },
	});
	const entries = [
		{ type: "message", timestamp: "2026-11-14T05:00:00.000Z", message: { role: "user", content: "hi" } },
		reply(1, "p", "big", [{ type: "toolCall" }, { type: "text" }, { type: "toolCall" }], {
			input: 10,
			output: 4,
			cacheRead: 30,
			cacheWrite: 0,
			cost: { total: 0.5, totalFromProvider: true },
		}),
		{ type: "message", timestamp: "2026-11-14T05:02:00.000Z", message: { role: "toolResult", content: [] } },
		{
			type: "compaction",
			timestamp: "2026-11-14T05:03:00.000Z",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		},
		{ type: "message", timestamp: "2026-11-14T05:04:00.000Z", message: { role: "user", content: "more" } },
		reply(5, "p", "small", [], { input: 6, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }),
		reply(6, "p", "big", [{ type: "toolCall" }]),
	];
	const summary = summarizeSessionActivity({
		getBranch: () => entries,
		getHeader: () => ({ type: "session", timestamp: "2026-11-14T04:59:00.000Z" }),
	});
	assert.deepEqual(
		{ ...summary, models: undefined },
		{
			prompts: 2,
			responses: 3,
			toolCalls: 3,
			compactions: 1,
			startedAt: Date.UTC(2026, 10, 14, 4, 59),
			lastActivityAt: Date.UTC(2026, 10, 14, 5, 6),
			models: undefined,
		},
	);
	assert.deepEqual(
		summary.models.map((model) => [model.modelId, model.responses]),
		[
			["big", 2],
			["small", 1],
		],
	);
	const [big, small] = summary.models;
	// The reply without saved usage keeps the known sum but marks it incomplete.
	assert.equal(big.usage.inputTokens, 40);
	assert.equal(big.usage.cost, 0.5);
	assert.equal(big.usage.costEstimated, false);
	assert.equal(big.usage.costComplete, false);
	assert.equal(big.usage.unknownMessageCount, 1);
	// A placeholder zero is not a cost.
	assert.equal(small.usage.cost, null);
	assert.equal(small.usage.costComplete, false);
});

test("an empty session has no start time or models", () => {
	const summary = summarizeSessionActivity({ getBranch: () => [], getHeader: () => null });
	assert.deepEqual(summary, { prompts: 0, responses: 0, toolCalls: 0, compactions: 0, models: [] });
});
