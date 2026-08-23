import assert from "node:assert/strict";
import { test } from "node:test";

import { renderSessionLine, renderStatusBar, terminalTextWidth } from "../dist/index.js";

const plainTheme = { fg: (_role, value) => value };
const ansiTheme = { fg: (role, value) => `\u001b[3${role.length % 8}m${value}\u001b[0m` };

function stripSgr(value) {
	return value
		.split("\u001b")
		.map((segment, index) => (index === 0 ? segment : segment.replace(/^\[[0-9;]*m/, "")))
		.join("");
}

const snapshot = {
	schemaVersion: 1,
	observedAt: 1,
	workspace: { label: "日本語 project" },
	activity: { idle: true, idleSince: 1 },
	model: { providerId: "codex", modelId: "gpt-5.6-sol", thinkingLevel: "xhigh", scopedModelCount: 0 },
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
			branch: "feat/v0.1.2",
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
};
const hints = [{ id: "palette", text: "/model choose", priority: 10, role: "muted" }];

test("keeps wide and compact Session UI lines stable", () => {
	assert.equal(renderSessionLine(snapshot, hints, 48, plainTheme), "/model choose          Codex gpt-5.6-sol (xhigh)");
	assert.equal(renderStatusBar(snapshot, 48, plainTheme), "日本語 project · [!?↑] · node   19%/200k | ↑124k");
	assert.equal(
		renderStatusBar(snapshot, 80, plainTheme),
		"日本語 project · feat/v0.1.2 [!?↑] · node v24.16.0          19%/200k | ↑124k ↓9k",
	);
});

test("color and no-color lanes carry identical text and display width", () => {
	for (const width of [24, 48, 80, 120]) {
		const plainLine = renderSessionLine(snapshot, hints, width, plainTheme);
		const colorLine = renderSessionLine(snapshot, hints, width, ansiTheme);
		const plainBar = renderStatusBar(snapshot, width, plainTheme);
		const colorBar = renderStatusBar(snapshot, width, ansiTheme);
		assert.equal(stripSgr(colorLine), plainLine);
		assert.equal(stripSgr(colorBar), plainBar);
		assert.equal(terminalTextWidth(colorLine), width);
		assert.equal(terminalTextWidth(colorBar), width);
	}
});
