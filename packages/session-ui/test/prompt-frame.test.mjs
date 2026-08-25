import assert from "node:assert/strict";
import { test } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "@earendil-works/pi-tui";

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
		(data === "cycle-forward-key" && action === "app.model.cycleForward") ||
		(data === "cycle-backward-key" && action === "app.model.cycleBackward") ||
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

test("Pi's directly copied model actions route to Jouzu instead of stock handlers", async () => {
	const keybindings = new KeybindingsManager({
		"app.model.select": { defaultKeys: "ctrl+l", description: "Open model selector" },
		"app.model.cycleForward": { defaultKeys: "ctrl+p", description: "Cycle forward" },
		"app.model.cycleBackward": { defaultKeys: "alt+p", description: "Cycle backward" },
	});
	const defaultEditor = new CustomEditor(tui, editorTheme, keybindings);
	const stockCalls = [];
	for (const action of ["app.model.select", "app.model.cycleForward", "app.model.cycleBackward"]) {
		defaultEditor.onAction(action, () => stockCalls.push(action));
	}

	let jouzuPickerCalls = 0;
	const cycleDirections = [];
	const editor = new SessionPromptEditor(tui, editorTheme, keybindings, plainStyles, {
		onModelPicker: async () => {
			jouzuPickerCalls += 1;
			return true;
		},
		onModelCycle: async (direction) => {
			cycleDirections.push(direction);
			return true;
		},
	});
	for (const [action, handler] of defaultEditor.actionHandlers) {
		editor.actionHandlers.set(action, handler);
	}

	editor.setText("favorite-cycle draft");
	editor.handleInput("\x1b[D");
	const cursorBeforeCycle = editor.getCursor();
	editor.handleInput("\x0c");
	editor.handleInput("\x10");
	editor.handleInput("\x1bp");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(editor.getText(), "favorite-cycle draft");
	assert.deepEqual(editor.getCursor(), cursorBeforeCycle);
	assert.equal(jouzuPickerCalls, 1);
	assert.deepEqual(cycleDirections, ["forward", "backward"]);
	assert.deepEqual(stockCalls, []);
});

test("extension shortcuts retain precedence over favorite cycling", async () => {
	let cycleCalls = 0;
	let extensionCalls = 0;
	const editor = new SessionPromptEditor(tui, editorTheme, { matches: editorKeybindings }, plainStyles, {
		onModelCycle: async () => {
			cycleCalls += 1;
			return true;
		},
	});
	editor.onExtensionShortcut = (data) => {
		if (data !== "cycle-forward-key") return false;
		extensionCalls += 1;
		return true;
	};
	editor.handleInput("cycle-forward-key");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(extensionCalls, 1);
	assert.equal(cycleCalls, 0);
});

test("an explicit editor-history binding retains precedence over favorite cycling", async () => {
	const keybindings = new KeybindingsManager({
		"app.model.cycleForward": { defaultKeys: "ctrl+p", description: "Cycle forward" },
		"tui.editor.historyPrevious": { defaultKeys: "ctrl+p", description: "Previous history" },
	});
	let cycleCalls = 0;
	let stockCycleCalls = 0;
	const editor = new SessionPromptEditor(tui, editorTheme, keybindings, plainStyles, {
		onModelCycle: async () => {
			cycleCalls += 1;
			return true;
		},
	});
	editor.onAction("app.model.cycleForward", () => {
		stockCycleCalls += 1;
	});
	editor.handleInput("\x10");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(cycleCalls, 0);
	assert.equal(stockCycleCalls, 0);
});

test("replacement restoration preserves cursor and collapsed-paste state", async () => {
	let finishPicker;
	const editor = new SessionPromptEditor(tui, editorTheme, { matches: editorKeybindings }, plainStyles, {
		onModelPicker: () =>
			new Promise((resolve) => {
				finishPicker = resolve;
			}),
	});
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
	const editor = new SessionPromptEditor(tui, editorTheme, { matches: editorKeybindings }, plainStyles, {
		onModelPicker: async () => false,
		onModelCycle: async () => false,
		onScopedModelsCommand: async () => false,
	});
	let builtInCalls = 0;
	editor.onAction("app.model.select", () => {
		builtInCalls += 1;
	});
	editor.onAction("app.model.cycleForward", () => {
		builtInCalls += 1;
	});
	editor.handleInput("model-key");
	editor.handleInput("cycle-forward-key");
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(builtInCalls, 2);

	let submitted;
	editor.onSubmit = (value) => {
		submitted = value;
	};
	editor.setText("/model fallback");
	editor.handleInput("\r");
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(submitted, "/model fallback");

	editor.setText("/scoped-models");
	editor.handleInput("\r");
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(submitted, "/scoped-models");
});

test("exact /model submission opens the Jouzu picker while slash autocomplete is visible", async () => {
	const pickerQueries = [];
	let submitted;
	const editor = new SessionPromptEditor(tui, editorTheme, { matches: editorKeybindings }, plainStyles, {
		onModelPicker: async (query) => {
			pickerQueries.push(query);
			return true;
		},
	});
	editor.onSubmit = (value) => {
		submitted = value;
	};
	editor.setAutocompleteProvider({
		triggerCharacters: ["/"],
		async getSuggestions() {
			return { prefix: "/model", items: [{ value: "/model", label: "Model command" }] };
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			return { lines, cursorLine, cursorCol };
		},
	});
	editor.setText("/model");
	editor.handleInput("\t");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(editor.isShowingAutocomplete(), true);

	editor.handleInput("\r");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(pickerQueries, [undefined]);
	assert.equal(submitted, undefined);
	assert.equal(editor.getText(), "");
});

test("removes /scoped-models from autocomplete and intercepts exact manual submission", async () => {
	let commandCalls = 0;
	let submitted;
	const editor = new SessionPromptEditor(tui, editorTheme, { matches: editorKeybindings }, plainStyles, {
		onScopedModelsCommand: async () => {
			commandCalls += 1;
			return true;
		},
	});
	editor.onSubmit = (value) => {
		submitted = value;
	};
	editor.setAutocompleteProvider({
		triggerCharacters: ["/"],
		async getSuggestions() {
			return { prefix: "/sc", items: [{ value: "scoped-models", label: "scoped-models" }] };
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			return { lines, cursorLine, cursorCol };
		},
	});
	editor.setText("/sc");
	editor.handleInput("\t");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(editor.isShowingAutocomplete(), false);
	assert.doesNotMatch(editor.render(40).join("\n"), /scoped-models/);

	editor.setText("/scoped-models");
	editor.handleInput("\r");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(commandCalls, 1);
	assert.equal(submitted, undefined);
	assert.equal(editor.getText(), "");
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
