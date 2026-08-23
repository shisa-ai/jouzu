import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
	fillTerminalColumns,
	fitTerminalText,
	padTerminalText,
	remainingTerminalColumns,
	renderTerminalFrameBorder,
	renderTerminalFrameRow,
	renderTerminalFrameTitle,
	terminalTextWidth,
} from "../dist/terminal-layout.js";

const ANSI_CYAN = (value) => `\u001b[38;2;34;211;238m${value}\u001b[0m`;
const ANSI_PINK = (value) => `\u001b[38;2;244;114;182m${value}\u001b[0m`;

const WIDTH_FIXTURES = [
	["ASCII", "Jouzu"],
	["Japanese", "日本語"],
	["full-width forms and ideographic space", "Ａ　Ｂ"],
	["combining mark", "e\u0301"],
	["emoji ZWJ sequence", "👩‍💻"],
	["ANSI plus CJK", ANSI_CYAN("日本語")],
];

test("measures CJK, full-width, combining, emoji, and ANSI text in terminal columns", () => {
	assert.equal(terminalTextWidth("日本語"), 6);
	assert.equal(terminalTextWidth("Ａ　Ｂ"), 6);
	assert.equal(terminalTextWidth("e\u0301"), 1);
	assert.equal(terminalTextWidth("👩‍💻"), 2);
	assert.equal(terminalTextWidth(ANSI_CYAN("日本語")), 6);
	assert.equal(remainingTerminalColumns(12, ANSI_CYAN("日本"), " · ", "A"), 4);
});

test("fit and padding stay within exact columns across the Unicode matrix", () => {
	for (const [name, value] of WIDTH_FIXTURES) {
		for (let columns = 0; columns <= 16; columns += 1) {
			const fitted = fitTerminalText(value, columns);
			assert.ok(terminalTextWidth(fitted) <= columns, `${name} fit at ${columns}`);
			for (const alignment of ["left", "center", "right"]) {
				const padded = padTerminalText(value, columns, { alignment });
				assert.equal(terminalTextWidth(padded), columns, `${name} ${alignment} pad at ${columns}`);
			}
		}
	}
	assert.equal(fitTerminalText("日本語", 5, "…"), "日本…");
	assert.equal(fitTerminalText("e\u0301", 1), "e\u0301");
	assert.equal(fitTerminalText("👩‍💻", 1), "");
	assert.doesNotMatch(fitTerminalText("日本語", 5, "…"), /\[0m/);
});

test("display-width fill handles narrow remainders and styled glyphs", () => {
	for (let columns = 0; columns <= 16; columns += 1) {
		assert.equal(terminalTextWidth(fillTerminalColumns("─", columns)), columns);
		assert.equal(terminalTextWidth(fillTerminalColumns("界", columns)), columns);
		assert.equal(terminalTextWidth(fillTerminalColumns(ANSI_PINK("─"), columns)), columns);
		assert.equal(terminalTextWidth(fillTerminalColumns("", columns)), columns);
	}
	assert.equal(fillTerminalColumns("界", 5), "界界 ");
});

test("framed titles, rows, and borders align at every practical narrow width", () => {
	const border = (value) => ANSI_CYAN(value);
	const title = `${ANSI_CYAN("JOUZU")} · 日本語モデル`;
	const row = `${ANSI_PINK("選択中")}　👩‍💻 e\u0301`;
	for (let columns = 0; columns <= 80; columns += 1) {
		const titleLine = renderTerminalFrameTitle(title, columns, { border });
		const rowLine = renderTerminalFrameRow(row, columns, { border });
		const bottomLine = renderTerminalFrameBorder(columns, { border, left: "╰", right: "╯" });
		assert.equal(terminalTextWidth(titleLine), columns, `title at ${columns}`);
		assert.equal(terminalTextWidth(rowLine), columns, `row at ${columns}`);
		assert.equal(terminalTextWidth(bottomLine), columns, `border at ${columns}`);
	}
	assert.match(renderTerminalFrameTitle(title, 48, { border }), /日本語モデル/);
	assert.match(renderTerminalFrameRow(row, 48, { border }), /選択中/);
});

test("TUI renderers use shared terminal layout instead of code-unit padding", () => {
	const sourceFiles = ["model-picker.ts", "palette.ts", "presentation.ts"];
	for (const filename of sourceFiles) {
		const source = readFileSync(new URL(`../src/${filename}`, import.meta.url), "utf8");
		assert.doesNotMatch(source, /\.pad(?:Start|End)\(/, `${filename} uses code-unit padding`);
	}
	const modelPickerSource = readFileSync(new URL("../src/model-picker.ts", import.meta.url), "utf8");
	const presentationSource = readFileSync(new URL("../src/presentation.ts", import.meta.url), "utf8");
	assert.match(modelPickerSource, /renderTerminalFrameTitle/);
	assert.match(modelPickerSource, /renderTerminalFrameRow/);
	assert.match(presentationSource, /fitTerminalText/);
});
