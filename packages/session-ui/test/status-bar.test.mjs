import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildStatusBarSegments,
	createSessionUiStyles,
	renderStatusBar,
	renderStatusBarSegments,
	terminalTextWidth,
} from "../dist/index.js";

const styles = createSessionUiStyles({ fg: (_role, value) => value }, { colorEnabled: false });

// The status bar's own text, resolved once for the active catalog.
const text = {
	noModel: "no model",
	attention: "attention",
	statusHealth: "! status",
	statusContextUnknown: "ctx ?",
	statusDetached: "detached",
};

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

test("renders usage and cache share without unavailable cost or quota claims", () => {
	const rendered = renderStatusBar(snapshot(), 120, styles, text);
	assert.equal(terminalTextWidth(rendered), 120);
	assert.match(rendered, /日本語 project/);
	assert.match(rendered, /main \[!\?↑\]/);
	assert.match(rendered, /node v24\.16\.0/);
	assert.match(rendered, /19%\/200k/);
	assert.match(rendered, /↑124k ↓9k/);
	assert.match(rendered, /C\?$/);
	assert.doesNotMatch(rendered, /\$|5h:|7d:/);
});

test("renders the agreed format and preserves cost qualifiers at every width", () => {
	const value = {
		scope: "active_branch",
		inputTokens: 397000,
		outputTokens: 5000,
		unknownMessageCount: 0,
		cacheReadPercent: 95,
		cacheComplete: true,
		cost: 24.532,
		costEstimated: true,
		costComplete: true,
	};
	const make = (changes = {}) =>
		snapshot({
			context: { status: "known", observedAt: 1, value: { window: 272000, percent: 19 } },
			usage: { status: "known", observedAt: 1, value: { ...value, ...changes } },
		});
	assert.match(renderStatusBar(make(), 140, styles, text), /19%\/272k \| ↑397k ↓5k \| C95% \| ~\$24\.532$/);
	for (const [changes, cache, cost] of [
		[{ costEstimated: false }, "C95%", "$24.532"],
		[{ costComplete: false }, "C95%", "~$24.532 + ?"],
		[{ cost: null, cacheComplete: false }, "C?", undefined],
		[{ cost: undefined }, "C95%", undefined],
		[{ inputTokens: 0, cacheReadPercent: undefined }, "C—", "~$24.532"],
		[{ cacheReadPercent: 0, cost: 0, costEstimated: false }, "C0%", "$0.000"],
	]) {
		const state = make(changes);
		const segments = buildStatusBarSegments(state, text);
		assert.equal(segments.find(({ id }) => id === "cache").value, cache);
		assert.equal(segments.find(({ id }) => id === "cost")?.value, cost);
		for (let width = 1; width <= 160; width++) {
			const rendered = renderStatusBar(state, width, styles, text);
			assert.equal(terminalTextWidth(rendered), width);
			if (rendered.includes("$")) assert.ok(rendered.endsWith(cost));
		}
	}
});

test("marks approximate context in full and narrow displays", () => {
	const estimated = snapshot({
		context: {
			status: "partial",
			observedAt: 1,
			value: { tokens: 38000, window: 1000000, percent: 3.8, approximate: true },
		},
	});
	const segment = buildStatusBarSegments(estimated, text).find(({ id }) => id === "context");
	assert.equal(segment.value, "~4%/1m");
	assert.equal(segment.compactValue, "~4%");
	assert.equal(renderStatusBar(estimated, 5, styles, text).trim(), "~4%");
	assert.match(renderStatusBar(estimated, 48, styles, text), /~4%/);
	for (let width = 1; width <= 120; width += 1) {
		assert.equal(terminalTextWidth(renderStatusBar(estimated, width, styles, text)), width);
	}
});

test("maps context pressure and unknown usage to distinct semantic styles", () => {
	for (const [percent, style] of [
		[69, "status.context.normal"],
		[70, "status.context.warning"],
		[90, "status.context.error"],
	]) {
		const segments = buildStatusBarSegments(
			snapshot({ context: { status: "known", observedAt: 1, value: { tokens: 1, window: 100, percent } } }),
			text,
		);
		assert.equal(segments.find(({ id }) => id === "context").style, style);
	}
	const partial = buildStatusBarSegments(
		snapshot({
			usage: {
				status: "partial",
				observedAt: 1,
				value: { scope: "active_branch", inputTokens: 1, outputTokens: 2, unknownMessageCount: 1 },
			},
		}),
		text,
	);
	assert.deepEqual(
		partial.find(({ id }) => id === "tokens").fragments.map(({ style }) => style),
		["status.tokens", "status.unknown"],
	);
});

test("degrades by semantic priority and never wraps or exceeds the terminal", () => {
	for (let width = 1; width <= 120; width += 1) {
		const rendered = renderStatusBar(snapshot(), width, styles, text);
		assert.equal(terminalTextWidth(rendered), width, `width ${width}`);
		assert.equal(rendered.includes("\n"), false);
	}
	const medium = renderStatusBar(snapshot(), 40, styles, text);
	assert.match(medium, /19%/);
	assert.doesNotMatch(medium, /v24\.16\.0/);
	const narrow = renderStatusBar(snapshot(), 5, styles, text);
	assert.equal(narrow.trim(), "19%");
});

test("protects health before context and strips controls from external labels", () => {
	const unhealthy = snapshot({
		workspace: { label: "危険\u001b[31m\n" },
		git: { status: "error", observedAt: 1 },
		runtime: { status: "unknown", observedAt: 1 },
	});
	assert.equal(renderStatusBar(unhealthy, 1, styles, text), "!");
	const wide = renderStatusBar(unhealthy, 80, styles, text);
	assert.match(wide, /! status/);
	assert.match(wide, /危険/);
	assert.doesNotMatch(wide, /\[31m/);
	assert.equal(wide.includes("\u001b"), false);
	assert.equal(wide.includes("\n"), false);
	const malformedFragments = renderStatusBarSegments(
		[
			{
				id: "external",
				side: "left",
				order: 0,
				priority: 1,
				style: "status.text",
				value: "safe",
				fragments: [{ value: "unsafe\u001b[31m", style: "status.error" }],
			},
		],
		4,
		styles,
	);
	assert.equal(malformedFragments, "safe");
});

test("exposes reusable status segments with deterministic compaction", () => {
	const segments = buildStatusBarSegments(snapshot(), text);
	assert.deepEqual(
		segments.map(({ id }) => id),
		["workspace", "git", "runtime", "context", "tokens", "cache"],
	);
	assert.equal(segments.find(({ id }) => id === "workspace").style, "status.workspace");
	assert.deepEqual(
		segments.find(({ id }) => id === "git").fragments.map(({ style }) => style),
		["status.git.branch", "status.git.changes"],
	);
	assert.equal(segments.find(({ id }) => id === "runtime").style, "status.runtime.node");
	assert.equal(segments.find(({ id }) => id === "context").style, "status.context.normal");
	assert.equal(segments.find(({ id }) => id === "tokens").style, "status.tokens");
	const custom = renderStatusBarSegments(
		[
			{
				id: "low",
				side: "left",
				order: 0,
				priority: 1,
				style: "status.muted",
				value: "low-value",
				compactValue: "low",
			},
			{
				id: "required",
				side: "right",
				order: 0,
				priority: 100,
				style: "status.accent",
				value: "required",
				compactValue: "req",
				required: true,
			},
		],
		8,
		styles,
	);
	assert.equal(custom, "low  req");
});

test("keeps the status bar on session context and leaves loop state to the Session Line", () => {
	for (let width = 1; width <= 120; width++) {
		const line = renderStatusBar(snapshot(), width, styles, text);
		assert.equal(terminalTextWidth(line), width);
		assert.equal(line.includes("multiloop"), false);
		assert.equal(line.includes("\n"), false);
		assert.equal(line.includes("\x1b"), false);
	}
});
