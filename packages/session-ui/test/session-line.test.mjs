import assert from "node:assert/strict";
import { test } from "node:test";

import { createSessionUiStyles, renderSessionLine, selectSessionUiHint, terminalTextWidth } from "../dist/index.js";

const styles = createSessionUiStyles({ fg: (_role, value) => value }, { colorEnabled: false });

function snapshot(overrides = {}) {
	return {
		schemaVersion: 1,
		observedAt: 1,
		workspace: { label: "work" },
		activity: { idle: true, idleSince: 1 },
		model: {
			providerId: "codex",
			modelId: "gpt-5.6-sol",
			displayName: "GPT-5.6 Sol",
			thinkingLevel: "xhigh",
			scopedModelCount: 0,
		},
		context: { status: "unknown", observedAt: 1 },
		usage: {
			status: "known",
			observedAt: 1,
			value: { scope: "active_branch", inputTokens: 0, outputTokens: 0, unknownMessageCount: 0 },
		},
		git: { status: "unknown", observedAt: 1 },
		runtime: { status: "unknown", observedAt: 1 },
		...overrides,
	};
}

const hints = [
	{ id: "default", text: "Ctrl+L models", priority: 10, role: "muted" },
	{ id: "warning", text: "! recovery needed", priority: 100, role: "warning" },
];

test("selects one deterministic priority hint", () => {
	assert.equal(selectSessionUiHint(hints).id, "warning");
	assert.equal(
		selectSessionUiHint([
			{ ...hints[0], id: "z" },
			{ ...hints[0], id: "a" },
		]).id,
		"a",
	);
});

test("applies separate semantic styles to the hint, provider, and model identity", () => {
	const applied = [];
	const tracingStyles = {
		scheme: styles.scheme,
		apply(role, value) {
			applied.push({ role, value });
			return value;
		},
	};
	renderSessionLine(snapshot(), hints, 64, tracingStyles);
	assert.deepEqual(
		applied.map(({ role }) => role),
		["session.provider", "session.model", "session.hint.warning"],
	);
});

test("protects model identity and drops the left hint before overlap", () => {
	const wide = renderSessionLine(snapshot(), hints, 64, styles);
	assert.equal(terminalTextWidth(wide), 64);
	assert.match(wide, /^! recovery needed/);
	assert.match(wide, /Codex gpt-5\.6-sol \(xhigh\)$/);
	const narrow = renderSessionLine(snapshot(), hints, 27, styles);
	assert.equal(terminalTextWidth(narrow), 27);
	assert.doesNotMatch(narrow, /recovery/);
	assert.match(narrow, /Codex gpt-5\.6-sol/);
});

test("keeps CJK labels width-safe and strips terminal controls", () => {
	const rendered = renderSessionLine(
		snapshot({
			model: {
				providerId: "危険\u001b[31m",
				modelId: "提供者/日本語モデル\n",
				thinkingLevel: "high\t",
				scopedModelCount: 0,
			},
		}),
		[{ id: "hint", text: "モデルを選択", priority: 1, role: "accent" }],
		48,
		styles,
	);
	assert.equal(terminalTextWidth(rendered), 48);
	assert.match(rendered, /モデルを選択/);
	assert.match(rendered, /日本語モデル/);
	assert.equal(rendered.includes("\u001b"), false);
	assert.equal(rendered.includes("\n"), false);
	assert.equal(rendered.includes("\t"), false);
});
