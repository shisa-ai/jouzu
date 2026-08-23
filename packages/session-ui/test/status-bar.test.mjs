import assert from "node:assert/strict";
import { test } from "node:test";

import { buildStatusBarSegments, renderStatusBar, renderStatusBarSegments, terminalTextWidth } from "../dist/index.js";

const theme = { fg: (_role, value) => value };

function snapshot(overrides = {}) {
	return {
		schemaVersion: 1,
		observedAt: 1,
		workspace: { label: "日本語 project" },
		activity: { idle: true, idleSince: 1 },
		model: { providerId: "codex", modelId: "gpt", scopedModelCount: 0 },
		context: { status: "known", observedAt: 1, value: { tokens: 38_000, window: 200_000, percent: 19 } },
		usage: {
			status: "known",
			observedAt: 1,
			value: { scope: "active_branch", inputTokens: 124_000, outputTokens: 9000, unknownMessageCount: 0 },
		},
		git: {
			status: "known",
			observedAt: 1,
			value: {
				branch: "main",
				dirty: true,
				ahead: 1,
				behind: 0,
				conflicted: 0,
				untracked: 1,
				stashed: 0,
				modified: 1,
				staged: 0,
				renamed: 0,
				deleted: 0,
				typeChanged: 0,
			},
		},
		runtime: { status: "known", observedAt: 1, value: { id: "node", version: "v24.16.0" } },
		...overrides,
	};
}

test("renders the useful provider-neutral status facts without cost or quota", () => {
	const rendered = renderStatusBar(snapshot(), 120, theme);
	assert.equal(terminalTextWidth(rendered), 120);
	assert.match(rendered, /日本語 project/);
	assert.match(rendered, /main \[!\?↑\]/);
	assert.match(rendered, /node v24\.16\.0/);
	assert.match(rendered, /19%\/200k/);
	assert.match(rendered, /↑124k ↓9k/);
	assert.doesNotMatch(rendered, /\$|5h:|7d:/);
});

test("degrades by semantic priority and never wraps or exceeds the terminal", () => {
	for (let width = 1; width <= 120; width += 1) {
		const rendered = renderStatusBar(snapshot(), width, theme);
		assert.equal(terminalTextWidth(rendered), width, `width ${width}`);
		assert.equal(rendered.includes("\n"), false);
	}
	const medium = renderStatusBar(snapshot(), 40, theme);
	assert.match(medium, /19%/);
	assert.doesNotMatch(medium, /v24\.16\.0/);
	const narrow = renderStatusBar(snapshot(), 5, theme);
	assert.equal(narrow.trim(), "19%");
});

test("protects health before context and strips controls from external labels", () => {
	const unhealthy = snapshot({
		workspace: { label: "危険\u001b[31m\n" },
		git: { status: "error", observedAt: 1 },
		runtime: { status: "unknown", observedAt: 1 },
	});
	assert.equal(renderStatusBar(unhealthy, 1, theme), "!");
	const wide = renderStatusBar(unhealthy, 80, theme);
	assert.match(wide, /! status/);
	assert.match(wide, /危険/);
	assert.doesNotMatch(wide, /\[31m/);
	assert.equal(wide.includes("\u001b"), false);
	assert.equal(wide.includes("\n"), false);
});

test("exposes reusable status segments with deterministic compaction", () => {
	const segments = buildStatusBarSegments(snapshot());
	assert.deepEqual(
		segments.map(({ id }) => id),
		["workspace", "git", "runtime", "context", "tokens"],
	);
	const custom = renderStatusBarSegments(
		[
			{ id: "low", side: "left", order: 0, priority: 1, role: "muted", value: "low-value", compactValue: "low" },
			{
				id: "required",
				side: "right",
				order: 0,
				priority: 100,
				role: "accent",
				value: "required",
				compactValue: "req",
				required: true,
			},
		],
		8,
		theme,
	);
	assert.equal(custom, "low  req");
});
