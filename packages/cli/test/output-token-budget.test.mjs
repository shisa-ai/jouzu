import assert from "node:assert/strict";
import { test } from "node:test";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";

function context(tokens) {
	return {
		messages: [{ role: "user", content: "x".repeat(tokens * 4), timestamp: 1 }],
	};
}

const model = { contextWindow: 262144, maxTokens: 131072 };

test("output budget reserves five percent of the estimated prompt for tokenizer uncertainty", () => {
	// A 170457-token estimate was 4097 below the server count, exceeding the fixed reserve by one.
	const output = clampMaxTokensToContext(model, context(170457), model.maxTokens);
	assert.equal(output, 262144 - 170457 - Math.ceil(170457 * 0.05));
	assert.ok(174554 + output < model.contextWindow);
	assert.ok(Number.isInteger(output));
});

test("OpenAI-compatible payload uses the conservative budget after unmeasured trailing input", async () => {
	const input = {
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "Earlier response." }],
				api: "openai-completions",
				provider: "fixture",
				model: "fixture",
				stopReason: "stop",
				timestamp: 1,
				usage: { input: 156906, output: 787, cacheRead: 0, cacheWrite: 0, totalTokens: 157693 },
			},
			{
				role: "user",
				content: "x".repeat(12764 * 4),
				timestamp: 2,
			},
		],
	};
	const original = structuredClone(input);
	let payload;
	const result = await streamSimple(
		{
			...model,
			id: "fixture",
			name: "fixture",
			provider: "fixture",
			api: "openai-completions",
			baseUrl: "https://fixture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: { maxTokensField: "max_tokens" },
		},
		input,
		{
			apiKey: "fixture",
			onPayload(value) {
				payload = value;
				throw new Error("fixture-before-network");
			},
		},
	).result();
	assert.match(result.errorMessage, /fixture-before-network/);
	assert.equal(payload.max_tokens, 83164);
	assert.deepEqual(input, original);
});

test("output budget preserves the minimum reserve and caller output cap", () => {
	assert.equal(clampMaxTokensToContext(model, context(100), model.maxTokens), model.maxTokens);
	assert.equal(clampMaxTokensToContext(model, context(170457), 8192), 8192);
	assert.equal(clampMaxTokensToContext({ contextWindow: 10000 }, context(1000), 8000), 4904);
});

test("output budget retains a positive request for overflow recovery and unknown context windows", () => {
	assert.equal(clampMaxTokensToContext(model, context(model.contextWindow), model.maxTokens), 1);
	assert.equal(clampMaxTokensToContext({ contextWindow: 0 }, context(100), 8192), 8192);
});
