import assert from "node:assert/strict";
import { test } from "node:test";

import { renderPromptFrameLines, SessionPromptEditor, terminalTextWidth } from "../dist/index.js";

const style = {
	border: (value) => `\u001b[38;5;240m${value}\u001b[0m`,
	rail: (value) => `\u001b[38;5;45m${value}\u001b[0m`,
};

const identity = (value) => value;
const editorTheme = {
	borderColor: identity,
	selectList: {
		selectedPrefix: identity,
		selectedText: identity,
		description: identity,
		scrollInfo: identity,
		noMatch: identity,
	},
};
const plainStyles = { apply: (_role, value) => value };
const tui = { terminal: { columns: 80, rows: 30 }, requestRender() {} };

function editorKeybindings(data, action) {
	return (
		(data === "model-key" && action === "app.model.select") ||
		(data === "\r" && action === "tui.input.submit") ||
		(data === "\t" && action === "tui.input.tab")
	);
}

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

test("replacement restoration preserves cursor and collapsed-paste state", async () => {
	let finishPicker;
	const editor = new SessionPromptEditor(
		tui,
		editorTheme,
		{ matches: editorKeybindings },
		plainStyles,
		() =>
			new Promise((resolve) => {
				finishPicker = resolve;
			}),
	);
	editor.onAction("app.model.select", () => assert.fail("the built-in selector should not run"));

	editor.setText("abc");
	editor.handleInput("\x1b[D");
	assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
	editor.handleInput("model-key");
	await Promise.resolve();
	editor.setText(editor.getText());
	assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
	finishPicker(true);
	await Promise.resolve();

	const pasted = "x".repeat(1001);
	editor.setText("");
	editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
	assert.equal(editor.getExpandedText(), pasted);
	editor.handleInput("model-key");
	await Promise.resolve();
	editor.setText(editor.getText());
	assert.equal(editor.getExpandedText(), pasted);
	finishPicker(true);
	await Promise.resolve();
});

test("model routing falls back when the Jouzu Palette cannot open", async () => {
	const editor = new SessionPromptEditor(
		tui,
		editorTheme,
		{ matches: editorKeybindings },
		plainStyles,
		async () => false,
	);
	let builtInCalls = 0;
	editor.onAction("app.model.select", () => {
		builtInCalls += 1;
	});
	editor.handleInput("model-key");
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(builtInCalls, 1);

	let submitted;
	editor.onSubmit = (value) => {
		submitted = value;
	};
	editor.setText("/model fallback");
	editor.handleInput("\r");
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(submitted, "/model fallback");
});

test("exact Pi autocomplete rows stay outside the prompt rail", async () => {
	const editor = new SessionPromptEditor(tui, editorTheme, { matches: editorKeybindings }, plainStyles);
	editor.setAutocompleteProvider({
		triggerCharacters: ["/"],
		async getSuggestions() {
			return { prefix: "/mo", items: [{ value: "/model", label: "Model command" }] };
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			return { lines, cursorLine, cursorCol };
		},
	});
	editor.setText("/mo");
	editor.handleInput("\t");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(editor.isShowingAutocomplete(), true);
	const suggestion = editor.render(40).find((line) => line.includes("Model command"));
	assert.ok(suggestion);
	assert.doesNotMatch(suggestion, /┃/);
});
