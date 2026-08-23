import assert from "node:assert/strict";
import { test } from "node:test";

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
