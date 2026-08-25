import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPickerRows } from "../dist/model-picker-ranking.js";
import { emptyModelPickerState } from "../dist/model-picker-state.js";

const projectKey = "a".repeat(64);
const models = [
	{
		provider: "anthropic",
		modelId: "claude-sonnet-test",
		name: "Claude Sonnet Test",
		contextWindow: 200_000,
		maxTokens: 16_000,
		available: true,
	},
	{
		provider: "openai",
		modelId: "gpt-test",
		name: "GPT Test",
		contextWindow: 32_000,
		maxTokens: 8_000,
		available: true,
	},
	{
		provider: "openrouter",
		modelId: "anthropic/claude-sonnet-test",
		name: "Claude Sonnet Test via OpenRouter",
		contextWindow: 200_000,
		maxTokens: 16_000,
		available: true,
	},
];

function state() {
	const value = emptyModelPickerState();
	value.favorites = [
		{
			provider: "missing-provider",
			modelId: "retired-model",
			scope: "global",
			addedAt: "2026-08-23T00:00:00.000Z",
		},
		{
			provider: "openai",
			modelId: "gpt-test",
			scope: "project",
			projectKey,
			addedAt: "2026-08-23T00:00:01.000Z",
		},
	];
	value.recents.projects[projectKey] = [
		{
			provider: "openrouter",
			modelId: "anthropic/claude-sonnet-test",
			lastUsedAt: "2026-08-23T00:01:00.000Z",
			useCount: 1,
		},
	];
	value.recents.global = [
		{ provider: "anthropic", modelId: "claude-sonnet-test", lastUsedAt: "2026-08-23T00:02:00.000Z", useCount: 2 },
	];
	return value;
}

test("Recent and Favorite filters preserve scope order and unavailable favorites", () => {
	const rows = buildPickerRows({
		models,
		state: state(),
		projectKey,
		current: { provider: "anthropic", modelId: "claude-sonnet-test" },
		previous: [{ provider: "openai", modelId: "gpt-test" }],
		activeContextTokens: 30_000,
	});

	assert.deepEqual(
		rows.map((row) => [row.section, row.model.provider, row.model.modelId]),
		[
			["current", "anthropic", "claude-sonnet-test"],
			["previous", "openai", "gpt-test"],
			["project_recent", "openrouter", "anthropic/claude-sonnet-test"],
		],
	);
	assert.equal(rows[1].contextFit, "too-small");
	assert.deepEqual(rows[1].favoriteScopes, ["project"]);

	const favorites = buildPickerRows({ models, state: state(), projectKey, filter: "favorite" });
	assert.deepEqual(
		favorites.map((row) => [row.model.provider, row.model.modelId]),
		[
			["openai", "gpt-test"],
			["missing-provider", "retired-model"],
		],
	);
	assert.equal(favorites[1].model.available, false);
});

test("typed query ranks exact provider identity before proxy-provider IDs and recency", () => {
	const rows = buildPickerRows({
		models,
		state: state(),
		projectKey,
		query: "anthropic/claude-sonnet-test",
		filter: "all",
	});
	assert.deepEqual(
		rows.slice(0, 2).map((row) => `${row.model.provider}/${row.model.modelId}`),
		["anthropic/claude-sonnet-test", "openrouter/anthropic/claude-sonnet-test"],
	);
});

test("typed search is deterministic, Unicode-normalized, and strips terminal controls", () => {
	const dirtyModels = [
		...models,
		{
			provider: "local\u001b[31m",
			modelId: "Ｑｗｅｎ-test",
			name: "Qwen\u0007 Test",
			available: true,
		},
	];
	const first = buildPickerRows({ models: dirtyModels, state: state(), projectKey, query: "qwen", filter: "all" });
	const second = buildPickerRows({ models: dirtyModels, state: state(), projectKey, query: "ｑｗｅｎ", filter: "all" });
	assert.equal(first[0].model.modelId, "Ｑｗｅｎ-test");
	assert.equal(first[0].model.provider.includes("\u001b"), false);
	assert.equal(first[0].model.name.includes("\u0007"), false);
	assert.deepEqual(first, second);
});
