import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateTokens, SessionManager } from "@earendil-works/pi-coding-agent";

import { createSessionStatusSnapshot } from "../dist/index.js";

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

test("captures provider-neutral session facts without paths or cost claims", () => {
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
		unknownMessageCount: 0,
	});
	assert.doesNotMatch(JSON.stringify(snapshot), /\/work\/|cost/i);
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
