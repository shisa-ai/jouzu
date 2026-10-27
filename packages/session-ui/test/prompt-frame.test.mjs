import assert from "node:assert/strict";
import { test } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, stripTerminalSequences } from "@earendil-works/pi-tui";

import {
	createSlashCommandLocalizer,
	formatSlashCommandDescription,
	renderPromptFrameLines,
	renderSessionLine,
	SessionPromptEditor,
	sessionUiText,
	terminalTextWidth,
} from "../dist/index.js";

const style = {
	border: (value) => `\u001b[38;5;240m${value}\u001b[39m`,
	leader: (value) => `\u001b[38;5;45m${value}\u001b[39m`,
};

const LEADER = "\u001b[38;5;45m❯\u001b[39m ";

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
	assert.ok(lines[1].startsWith(LEADER));
	assert.equal(stripTerminalSequences(lines[1]), "❯ 日本語の入力      ");
});

test("leads the prompt once and leaves continuation rows without a marker", () => {
	const lines = renderPromptFrameLines(["─".repeat(18), "first row", "second row", "─".repeat(18)], 20, 0, style);
	assert.equal(stripTerminalSequences(lines[1]), "❯ first row".padEnd(20));
	assert.equal(stripTerminalSequences(lines[2]), "  second row".padEnd(20));
	assert.equal(lines.filter((line) => line.includes("❯")).length, 1);
	assert.ok(lines.every((line) => terminalTextWidth(line) === 20));
});

test("keeps autocomplete rows outside the prompt leader", () => {
	const lines = renderPromptFrameLines(["─".repeat(22), "draft", "─".repeat(22), "候補 one", "候補 two"], 24, 2, style);
	assert.equal(lines.length, 5);
	assert.ok(lines.slice(0, 3).every((line) => terminalTextWidth(line) === 24));
	assert.ok(lines[1].startsWith(LEADER));
	assert.equal(lines[0].includes("❯"), false, "the top border carries no leader");
	assert.equal(lines[2].includes("❯"), false, "the bottom border carries no leader");
	assert.match(lines[3], /^ {2}候補 one/);
	assert.equal(
		lines.slice(3).some((line) => line.includes("❯")),
		false,
	);
	assert.ok(lines.slice(3).every((line) => terminalTextWidth(line) <= 24));
});

test("keeps the no-color frame free of terminal styling", () => {
	const plainStyle = { border: (value) => value, leader: (value) => value };
	const lines = renderPromptFrameLines(["─".repeat(18), "draft", "─".repeat(18)], 20, 0, plainStyle);
	assert.equal(
		lines.some((line) => line.includes("\u001b")),
		false,
	);
	assert.equal(stripTerminalSequences(lines[1]), "❯ draft             ");
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

test("maps an exact /exit submission to /quit and leaves other text alone", () => {
	const submitted = [];
	const editor = new SessionPromptEditor(tui, editorTheme, { matches: editorKeybindings }, plainStyles);
	editor.onSubmit = (value) => submitted.push(value);
	for (const text of ["/exit", "/quit", "/exit now", "exit", "／exit"]) {
		editor.setText(text);
		editor.handleInput("\r");
	}
	assert.deepEqual(submitted, ["/quit", "/quit", "/exit now", "exit", "/quit"]);
});

test("offers a localized /exit alias in slash autocomplete and maps its completion", async () => {
	let description = "Quit Jouzu";
	let submitted;
	const editor = new SessionPromptEditor(tui, editorTheme, { matches: editorKeybindings }, plainStyles, {
		exitAliasDescription: () => description,
	});
	editor.onSubmit = (value) => {
		submitted = value;
	};
	editor.setAutocompleteProvider({
		triggerCharacters: ["/"],
		async getSuggestions() {
			return null;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const line = lines[cursorLine] ?? "";
			const before = line.slice(0, cursorCol - prefix.length);
			return {
				lines: [`${before}/${item.value} `],
				cursorLine,
				cursorCol: before.length + item.value.length + 2,
			};
		},
	});
	const signal = new AbortController().signal;
	const english = await editor.autocompleteProvider.getSuggestions(["/ex"], 0, 3, { signal });
	assert.deepEqual(
		english.items.find((item) => item.value === "exit"),
		{ value: "exit", label: "exit", description: "Quit Jouzu" },
	);
	description = "Jouzu を終了";
	const japanese = await editor.autocompleteProvider.getSuggestions(["/ex"], 0, 3, { signal });
	assert.equal(japanese.items.find((item) => item.value === "exit")?.description, "Jouzu を終了");

	editor.setText("/ex");
	editor.handleInput("\t");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(editor.isShowingAutocomplete(), true);
	editor.handleInput("\r");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(submitted, "/quit");
	assert.equal(editor.getText(), "");
});

test("keeps another /exit owner and maps only while the alias is available", async () => {
	let enabled = false;
	let submitted;
	const ownerItem = { value: "exit", label: "exit", description: "My own exit command" };
	const editor = new SessionPromptEditor(tui, editorTheme, { matches: editorKeybindings }, plainStyles, {
		exitAlias: () => enabled,
		exitAliasDescription: () => "Quit Jouzu",
	});
	editor.onSubmit = (value) => {
		submitted = value;
	};
	editor.setAutocompleteProvider({
		triggerCharacters: ["/"],
		async getSuggestions() {
			return { prefix: "/ex", items: [ownerItem] };
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			return { lines, cursorLine, cursorCol };
		},
	});
	const signal = new AbortController().signal;
	const suggestions = await editor.autocompleteProvider.getSuggestions(["/ex"], 0, 3, { signal });
	assert.deepEqual(suggestions.items, [ownerItem]);

	editor.setText("/exit");
	editor.handleInput("\r");
	assert.equal(submitted, "/exit");

	enabled = true;
	const enabledSuggestions = await editor.autocompleteProvider.getSuggestions(["/ex"], 0, 3, { signal });
	assert.deepEqual(enabledSuggestions.items, [ownerItem]);
	editor.setText("/exit");
	editor.handleInput("\r");
	assert.equal(submitted, "/quit");
});

test("exact Pi autocomplete rows stay outside the prompt leader", async () => {
	const markedStyles = {
		apply: (role, value) => (role === "prompt.leader" ? `<leader>${value}</leader>` : value),
	};
	const editor = new SessionPromptEditor(tui, editorTheme, { matches: editorKeybindings }, markedStyles);
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
	const rows = editor.render(40);
	const suggestion = rows.find((line) => line.includes("Model command"));
	assert.ok(suggestion);
	assert.doesNotMatch(suggestion, /<leader>/);
	assert.equal(rows.filter((line) => line.includes("<leader>")).length, 1);
});

const INSTALLED_REFERENCE_DESCRIPTION =
	"Look up Jouzu settings, language, models/catalogs, profiles, session and trace locations, controls, and troubleshooting. Use for product questions or authorized configuration changes.";
const INSTALLED_MULTILOOP_DESCRIPTION =
	"Run and manage autonomous work — quick goals through /goal, and measured optimization, punchlist, research, and development loops through /multiloop. Use when the user sets a persistent objective, or requests repeated measured improvement, a bounded development loop, a research sweep, or punch-list completion.";
const JA_TRUST = "今後のセッション用にプロジェクトの信頼設定を保存";
const EN_TRUST = "Save project trust decision for future sessions";
const JA_CATALOGS = "Jouzu カタログ設定を開く";
const EN_CATALOGS = "Open Jouzu catalog settings";
const JA_GOAL = "目標を 1 つ設定して達成まで作業を実行（軽量な multiloop 実行）";
const EN_GOAL = "Set one objective and work toward it; a lightweight multiloop run";
const JA_MULTILOOP = "自律反復ループを開始・再開・管理";
const EN_MULTILOOP = "Run and manage autonomous work — quick goals through /goal and measured loops through /multiloop";
const JA_REFERENCE =
	"Jouzu の設定、言語、モデル/カタログ、プロファイル、セッション・トレースの場所、操作、トラブルシューティングを参照";
const EN_REFERENCE =
	"Look up Jouzu settings, language, models/catalogs, profiles, session and trace locations, controls, and troubleshooting";

function createMutableCatalog(initial = "ja") {
	let locale = initial;
	const messages = {
		ja: {
			"jouzu.cli.session.slash.trust": JA_TRUST,
			"jouzu.cli.session.slash.catalogs": JA_CATALOGS,
			"jouzu.cli.session.slash.goal": JA_GOAL,
			"jouzu.cli.session.slash.skillMultiloop": JA_MULTILOOP,
			"jouzu.cli.session.slash.skillJouzuReference": JA_REFERENCE,
			"jouzu.cli.session.line.fast": "高速",
			"jouzu.cli.session.status.health": "状態",
			"jouzu.cli.session.dashboard.section.agent": "エージェント",
		},
		en: {
			"jouzu.cli.session.slash.trust": EN_TRUST,
			"jouzu.cli.session.slash.catalogs": EN_CATALOGS,
			"jouzu.cli.session.slash.goal": EN_GOAL,
			"jouzu.cli.session.slash.skillMultiloop": EN_MULTILOOP,
			"jouzu.cli.session.slash.skillJouzuReference": EN_REFERENCE,
			"jouzu.cli.session.line.fast": "Fast",
			"jouzu.cli.session.status.health": "Health",
			"jouzu.cli.session.dashboard.section.agent": "Agents",
		},
	};
	return {
		get locale() {
			return locale;
		},
		format(id) {
			return messages[locale][id] ?? id;
		},
		setLocale(next) {
			locale = next;
		},
	};
}

const slashCommandRegistrations = [
	{
		name: "catalogs",
		description: JA_CATALOGS,
		source: "extension",
		sourceInfo: { source: "inline", scope: "temporary" },
	},
	{
		name: "catalogs",
		description: "My own catalogs command",
		source: "extension",
		sourceInfo: { source: "cli", scope: "temporary" },
	},
	{
		name: "goal",
		description: EN_GOAL,
		source: "extension",
		sourceInfo: { source: "cli", scope: "temporary" },
	},
	{
		name: "goal",
		description: "My own goal command",
		source: "prompt",
		sourceInfo: { source: "local", scope: "user" },
	},
	{
		name: "goal",
		description: "My own goal extension",
		source: "extension",
		sourceInfo: { source: "cli", scope: "temporary" },
	},
	{
		name: "skill:multiloop",
		description: INSTALLED_MULTILOOP_DESCRIPTION,
		source: "skill",
		sourceInfo: { source: "cli", scope: "temporary" },
	},
	{
		name: "skill:multiloop",
		description: "My own loop skill",
		source: "skill",
		sourceInfo: { source: "local", scope: "user" },
	},
	{
		name: "skill:multiloop",
		description: "My own CLI loop skill",
		source: "skill",
		sourceInfo: { source: "cli", scope: "temporary" },
	},
	{
		name: "skill:jouzu-reference",
		description: INSTALLED_REFERENCE_DESCRIPTION,
		source: "skill",
		sourceInfo: { source: "local", scope: "user" },
	},
	{
		name: "skill:jouzu-reference",
		description: "My own reference skill",
		source: "skill",
		sourceInfo: { source: "local", scope: "user" },
	},
];

test("preserves complete argument hints and source tags in slash-command descriptions", () => {
	assert.equal(
		formatSlashCommandDescription("<provider> — Configure provider authentication", "プロバイダー認証を設定"),
		"<provider> — プロバイダー認証を設定",
	);
	assert.equal(formatSlashCommandDescription("<task> — [p] Description", "説明"), "<task> — [p] 説明");
	assert.equal(formatSlashCommandDescription("<first> <second> — Description", "説明"), "<first> <second> — 説明");
	assert.equal(formatSlashCommandDescription("[u]", "説明"), "[u] 説明");
	assert.equal(formatSlashCommandDescription("<task> — [p]", "説明"), "<task> — [p] 説明");
	assert.equal(
		formatSlashCommandDescription("[u] Look up Jouzu settings", "Jouzu の設定を参照"),
		"[u] Jouzu の設定を参照",
	);
	assert.equal(
		formatSlashCommandDescription("Save project trust decision for future sessions", "プロジェクトの信頼設定を保存"),
		"プロジェクトの信頼設定を保存",
	);
	assert.equal(formatSlashCommandDescription("Manage tasks — view, create", "タスク管理"), "タスク管理");
	assert.equal(formatSlashCommandDescription(undefined, "説明"), "説明");
});

test("localizes only owned slash commands and leaves same-name user commands alone", () => {
	const catalog = createMutableCatalog("ja");
	const localize = createSlashCommandLocalizer(catalog, slashCommandRegistrations);
	const userCatalogs = "[t] My own catalogs command";
	const bundledCatalogs = `[t] ${JA_CATALOGS}`;
	const userGoal = "[u] My own goal command";
	const cliUserGoal = "[t] My own goal command";
	const cliUserGoalExtension = "[t] My own goal extension";
	const bundledGoal = `[t] ${EN_GOAL}`;
	const userLoop = "[u] My own loop skill";
	const cliUserLoop = "[t] My own CLI loop skill";
	const bundledLoop = `[t] ${INSTALLED_MULTILOOP_DESCRIPTION}`;
	const installedReference = `[u] ${INSTALLED_REFERENCE_DESCRIPTION}`;
	const userReference = "[u] My own reference skill";
	const userTrust = "[u] My own trust command";

	assert.equal(localize("catalogs", userCatalogs), undefined);
	assert.equal(localize("catalogs", bundledCatalogs), bundledCatalogs);
	assert.equal(localize("goal", userGoal), undefined);
	assert.equal(localize("goal", cliUserGoal), undefined);
	assert.equal(localize("goal", cliUserGoalExtension), undefined);
	assert.equal(localize("goal", bundledGoal), `[t] ${JA_GOAL}`);
	assert.equal(localize("skill:multiloop", userLoop), undefined);
	assert.equal(localize("skill:multiloop", cliUserLoop), undefined);
	assert.equal(localize("skill:multiloop", bundledLoop), `[t] ${JA_MULTILOOP}`);
	assert.equal(localize("skill:jouzu-reference", installedReference), `[u] ${JA_REFERENCE}`);
	assert.equal(localize("skill:jouzu-reference", userReference), undefined);
	assert.equal(localize("trust", userTrust), undefined);
	assert.equal(localize("trust", EN_TRUST), JA_TRUST);

	catalog.setLocale("en");
	assert.equal(localize("catalogs", userCatalogs), undefined);
	assert.equal(localize("catalogs", bundledCatalogs), `[t] ${EN_CATALOGS}`);
	assert.equal(localize("goal", userGoal), undefined);
	assert.equal(localize("goal", cliUserGoal), undefined);
	assert.equal(localize("goal", cliUserGoalExtension), undefined);
	assert.equal(localize("goal", bundledGoal), bundledGoal);
	assert.equal(localize("skill:multiloop", userLoop), undefined);
	assert.equal(localize("skill:multiloop", cliUserLoop), undefined);
	assert.equal(localize("skill:multiloop", bundledLoop), `[t] ${EN_MULTILOOP}`);
	assert.equal(localize("skill:jouzu-reference", installedReference), `[u] ${EN_REFERENCE}`);
	assert.equal(localize("skill:jouzu-reference", userReference), undefined);
	assert.equal(localize("trust", userTrust), undefined);
	assert.equal(localize("trust", EN_TRUST), EN_TRUST);
});

test("updates slash descriptions and chrome without resetting editor input", async () => {
	const catalog = createMutableCatalog("ja");
	const localize = createSlashCommandLocalizer(catalog, slashCommandRegistrations);
	const editor = new SessionPromptEditor(tui, editorTheme, { matches: editorKeybindings }, plainStyles, {
		slashCommandLocalizer: localize,
	});
	editor.setText("keep this draft");

	const userGoal = { value: "goal", label: "goal", description: "[u] My own goal command", extra: "keep" };
	const bundledGoal = { value: "goal", label: "goal", description: `[t] ${EN_GOAL}`, extra: "keep" };
	const builtinTrust = { value: "trust", label: "trust", description: EN_TRUST };
	const items = [userGoal, bundledGoal, builtinTrust];
	let suggestions = { prefix: "/", items };
	const provider = {
		triggerCharacters: ["/"],
		async getSuggestions() {
			return suggestions;
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			return { lines, cursorLine, cursorCol };
		},
		shouldTriggerFileCompletion() {
			return true;
		},
	};
	editor.setAutocompleteProvider(provider);
	const signal = new AbortController().signal;

	const japanese = await editor.autocompleteProvider.getSuggestions(["/"], 0, 1, { signal });
	assert.equal(japanese.items[0], userGoal);
	assert.equal(japanese.items[1].description, `[t] ${JA_GOAL}`);
	assert.equal(japanese.items[1].extra, "keep");
	assert.equal(japanese.items[2].description, JA_TRUST);
	assert.equal(editor.getText(), "keep this draft");

	catalog.setLocale("en");
	const english = await editor.autocompleteProvider.getSuggestions(["/"], 0, 1, { signal });
	assert.equal(english.items[0], userGoal);
	assert.equal(english.items[1].description, bundledGoal.description);
	assert.equal(english.items[2], builtinTrust);
	assert.equal(editor.getText(), "keep this draft");

	assert.deepEqual(editor.autocompleteProvider.triggerCharacters, ["/"]);
	assert.equal(editor.autocompleteProvider.shouldTriggerFileCompletion([], 0, 0), true);
	assert.deepEqual(editor.autocompleteProvider.applyCompletion(["x"], 0, 0, {}, "/"), {
		lines: ["x"],
		cursorLine: 0,
		cursorCol: 0,
	});

	const argumentItem = { value: "on", label: "on", description: "Turn Fast mode on" };
	const argumentSuggestions = { prefix: "on", items: [argumentItem] };
	suggestions = argumentSuggestions;
	const argumentResult = await editor.autocompleteProvider.getSuggestions(["/fast on"], 0, 8, { signal });
	assert.equal(argumentResult, argumentSuggestions);
	assert.equal(argumentResult.items[0], argumentItem);

	suggestions = { prefix: "/", items: [{ value: "scoped-models", label: "scoped-models" }] };
	const filtered = await editor.autocompleteProvider.getSuggestions(["/"], 0, 1, { signal });
	assert.deepEqual(filtered.items, [{ value: "exit", label: "exit" }]);
});

test("reads localized Session UI chrome from the current catalog", () => {
	const catalog = createMutableCatalog("ja");
	const text = sessionUiText(catalog);
	const snapshot = { model: { providerId: "openai", modelId: "gpt-example", thinkingLevel: "off" } };
	const japanese = renderSessionLine(snapshot, [], 80, plainStyles, text, undefined, undefined, true);
	assert.match(japanese, /高速/u);
	assert.equal(text.statusHealth, "状態");
	assert.equal(text.dashboard.sections.agent, "エージェント");
	assert.equal(text.slashCommands.trust, JA_TRUST);

	catalog.setLocale("en");
	const english = renderSessionLine(snapshot, [], 80, plainStyles, text, undefined, undefined, true);
	assert.match(english, /Fast/u);
	assert.doesNotMatch(english, /高速/u);
	assert.equal(text.statusHealth, "Health");
	assert.equal(text.dashboard.sections.agent, "Agents");
	assert.equal(text.slashCommands.trust, EN_TRUST);
});
