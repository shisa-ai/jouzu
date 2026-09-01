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
			addedAt: "2026-08-23T00:00:00.000Z",
		},
		{
			provider: "openai",
			modelId: "gpt-test",
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

test("Recent and Favorite filters preserve global favorite order and unavailable entries", () => {
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
	assert.equal(rows[1].favorite, true);

	const favorites = buildPickerRows({ models, state: state(), projectKey, filter: "favorite" });
	assert.deepEqual(
		favorites.map((row) => [row.model.provider, row.model.modelId]),
		[
			["missing-provider", "retired-model"],
			["openai", "gpt-test"],
		],
	);
	assert.equal(favorites[0].model.available, false);
});

test("context fit reserves Pi's safety margin instead of the model output cap", () => {
	const limits = [
		{ provider: "local", modelId: "equal-cap", name: "Equal Cap", contextWindow: 8_000, maxTokens: 8_000 },
		{ provider: "hosted", modelId: "large-output", name: "Large Output", contextWindow: 200_000, maxTokens: 64_000 },
	].map((model) => ({ ...model, available: true }));
	const pickerState = emptyModelPickerState();

	const lightlyUsed = buildPickerRows({
		models: limits,
		state: pickerState,
		projectKey,
		filter: "all",
		activeContextTokens: 1_000,
	});
	assert.deepEqual(
		lightlyUsed.map((row) => row.contextFit),
		["fits", "fits"],
		"a model whose output cap equals its window must still accept a small active context",
	);

	const boundary = (activeContextTokens) =>
		buildPickerRows({
			models: [
				{
					provider: "p",
					modelId: "boundary",
					name: "Boundary",
					contextWindow: 128_000,
					maxTokens: 16_000,
					available: true,
				},
			],
			state: pickerState,
			projectKey,
			filter: "all",
			activeContextTokens,
		})[0].contextFit;
	assert.equal(boundary(120_000), "fits");
	assert.equal(boundary(123_904), "fits");
	assert.equal(boundary(123_905), "too-small");
});

test("catalog-qualified identities prevent cross-catalog collisions while legacy pairs still resolve", () => {
	const catalogModels = [
		{
			catalogId: "ai.example.one",
			offeringId: "offering-1",
			provider: "shared",
			modelId: "same-model",
			name: "One",
			available: true,
		},
		{
			catalogId: "ai.example.two",
			offeringId: "offering-2",
			provider: "shared",
			modelId: "same-model",
			name: "Two",
			available: true,
		},
	];
	const catalogState = emptyModelPickerState();
	catalogState.favorites = catalogModels.map((model, index) => ({
		catalogId: model.catalogId,
		offeringId: model.offeringId,
		provider: model.provider,
		modelId: model.modelId,
		addedAt: `2026-08-23T00:00:0${index}.000Z`,
	}));
	const favorites = buildPickerRows({ models: catalogModels, state: catalogState, projectKey, filter: "favorite" });
	assert.deepEqual(
		favorites.map((row) => [row.model.catalogId, row.model.offeringId, row.model.available]),
		[
			["ai.example.one", "offering-1", true],
			["ai.example.two", "offering-2", true],
		],
	);

	catalogState.recents.global = [
		{
			provider: "shared",
			modelId: "same-model",
			lastUsedAt: "2026-08-23T00:01:00.000Z",
			useCount: 1,
		},
	];
	const legacy = buildPickerRows({ models: catalogModels, state: catalogState, projectKey });
	assert.equal(legacy[0].model.catalogId, "ai.example.one");
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

test("typed search normalizes Unicode while display text strips terminal controls", () => {
	const dirtyModels = [
		...models,
		{
			provider: "local\u001b[31m\u009bunsafe",
			modelId: "Ｑｗｅｎ-test",
			name: "Qwen\u0007\u009d Test",
			available: true,
		},
	];
	const first = buildPickerRows({ models: dirtyModels, state: state(), projectKey, query: "qwen", filter: "all" });
	const second = buildPickerRows({ models: dirtyModels, state: state(), projectKey, query: "ｑｗｅｎ", filter: "all" });
	assert.equal(first[0].model.modelId, "Ｑｗｅｎ-test");
	assert.equal(first[0].model.provider.includes("\u001b[31m\u009b"), true, "semantic identity must remain byte-exact");
	assert.equal(first[0].model.name.includes("\u0007\u009d"), true, "the source label must remain available");
	assert.equal(first[0].model.display.provider.includes("\u001b"), false);
	assert.equal(first[0].model.display.provider.includes("\u009b"), false);
	assert.equal(first[0].model.display.name.includes("\u0007"), false);
	assert.equal(first[0].model.display.name.includes("\u009d"), false);
	assert.deepEqual(first, second);
});

test("All-filter query ties use exact identity instead of inventory order", () => {
	const candidates = [
		{ provider: "b", modelId: "x1", name: "Same", available: true },
		{ provider: "a", modelId: "x2", name: "Same", available: true },
	];
	const rank = (inventory) =>
		buildPickerRows({ models: inventory, state: state(), projectKey, query: "x", filter: "all" }).map(
			(row) => `${row.model.provider}/${row.model.modelId}`,
		);
	assert.deepEqual(rank(candidates), ["a/x2", "b/x1"]);
	assert.deepEqual(rank([...candidates].reverse()), ["a/x2", "b/x1"]);
});
