import assert from "node:assert/strict";
import { test } from "node:test";

import { renderPromptFrameLines, terminalTextWidth } from "../dist/index.js";

const style = {
	border: (value) => `\u001b[38;5;240m${value}\u001b[0m`,
	rail: (value) => `\u001b[38;5;45m${value}\u001b[0m`,
};

test("frames CJK editor content at exact terminal widths", () => {
	const lines = renderPromptFrameLines(["─".repeat(18), "日本語の入力", "─".repeat(18)], 20, 0, style);
	assert.equal(lines.length, 3);
	assert.ok(lines.every((line) => terminalTextWidth(line) === 20));
	assert.match(lines[1], /┃.*日本語の入力/);
});

test("keeps autocomplete rows outside the prompt rail", () => {
	const lines = renderPromptFrameLines(["─".repeat(22), "draft", "─".repeat(22), "候補 one", "候補 two"], 24, 2, style);
	assert.equal(lines.length, 5);
	assert.ok(lines.slice(0, 3).every((line) => terminalTextWidth(line) === 24));
	assert.match(lines[1], /┃.*draft/);
	assert.match(lines[3], /^ {2}候補 one/);
	assert.doesNotMatch(lines[3], /┃/);
	assert.ok(lines.slice(3).every((line) => terminalTextWidth(line) <= 24));
});

test("keeps the no-color frame free of terminal styling", () => {
	const plainStyle = { border: (value) => value, rail: (value) => value };
	const lines = renderPromptFrameLines(["─".repeat(18), "draft", "─".repeat(18)], 20, 0, plainStyle);
	assert.equal(
		lines.some((line) => line.includes("\u001b")),
		false,
	);
});

test("degrades without a frame below the structural minimum", () => {
	const lines = renderPromptFrameLines(["abcdef", "日本語"], 3, 0, style);
	assert.ok(lines.every((line) => terminalTextWidth(line) <= 3));
});
