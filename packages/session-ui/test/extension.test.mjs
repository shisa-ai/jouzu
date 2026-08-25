import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createSessionUiExtension, SESSION_UI_RUNTIME_IDS, terminalTextWidth } from "../dist/index.js";

const theme = {
	fg: (_role, value) => value,
};

function context(cwd, calls) {
	return {
		mode: "tui",
		cwd,
		model: { provider: "codex", id: "gpt-test", name: "GPT Test", contextWindow: 100_000 },
		thinkingLevel: "high",
		scopedModels: [],
		isIdle: () => true,
		getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
		sessionManager: { getBranch: () => [] },
		ui: {
			theme,
			setWidget: (...args) => calls.widgets.push(args),
			setFooter: (value) => calls.footers.push(value),
			setEditorComponent: (value) => calls.editors.push(value),
		},
	};
}

test("installs one editor, Session Line, and Status Bar owner and cleans up", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-session-ui-extension-"));
	try {
		writeFileSync(join(root, "package.json"), "{}");
		const handlers = new Map();
		const execCalls = [];
		const modelQueries = [];
		const extension = createSessionUiExtension({
			colorEnabled: false,
			getHints: () => [{ id: "palette", text: "/model choose", priority: 10, role: "muted" }],
			onModelPicker: async (query) => {
				modelQueries.push(query);
				return true;
			},
		});
		extension.factory({
			on(name, handler) {
				handlers.set(name, handler);
			},
			async exec(command, args, options) {
				execCalls.push({ command, args, options });
				if (command === "git") return { stdout: "# branch.head main\n", stderr: "", code: 0, killed: false };
				return { stdout: "v24.16.0\n", stderr: "", code: 0, killed: false };
			},
		});
		const calls = { widgets: [], footers: [], editors: [] };
		const ctx = context(root, calls);
		await handlers.get("session_start")({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(extension.name, SESSION_UI_RUNTIME_IDS.extension);
		assert.equal(calls.widgets[0][0], SESSION_UI_RUNTIME_IDS.sessionLineWidget);
		assert.equal(typeof calls.widgets[0][1], "function");
		assert.deepEqual(calls.widgets[0][2], { placement: "aboveEditor" });
		assert.equal(typeof calls.footers[0], "function");
		assert.equal(typeof calls.editors[0], "function");
		assert.deepEqual(execCalls.map(({ command }) => command).sort(), ["git", "node"]);

		const tui = { requestRender() {} };
		const keybindings = {
			matches(data, action) {
				return (
					(data === "model-key" && action === "app.model.select") || (data === "enter" && action === "tui.input.submit")
				);
			},
		};
		const editor = calls.editors[0](tui, theme, keybindings);
		let builtInModelPickerCalls = 0;
		editor.onAction("app.model.select", () => {
			builtInModelPickerCalls += 1;
		});
		editor.handleInput("model-key");
		editor.setText("/model codex/gpt-test");
		editor.handleInput("enter");
		assert.deepEqual(modelQueries, [undefined, "codex/gpt-test"]);
		assert.equal(builtInModelPickerCalls, 0);

		const lineComponent = calls.widgets[0][1](tui, theme);
		const line = lineComponent.render(60)[0];
		assert.equal(terminalTextWidth(line), 60);
		assert.match(line, /\/model choose/);
		assert.match(line, /Codex gpt-test \(high\)/);
		ctx.model = { provider: "anthropic", id: "claude-new", name: "Claude New", contextWindow: 200_000 };
		ctx.thinkingLevel = "low";
		await handlers.get("model_select")({}, ctx);
		assert.match(lineComponent.render(60)[0], /Anthropic claude-new \(low\)/);
		let branchChanged;
		let branchUnsubscribed = false;
		const footer = calls.footers[0](tui, theme, {
			onBranchChange(handler) {
				branchChanged = handler;
				return () => {
					branchUnsubscribed = true;
				};
			},
		});
		assert.equal(terminalTextWidth(footer.render(80)[0]), 80);
		branchChanged();
		await Promise.resolve();
		footer.dispose();
		assert.equal(branchUnsubscribed, true);

		await handlers.get("session_shutdown")({}, ctx);
		assert.deepEqual(calls.widgets.at(-1), [SESSION_UI_RUNTIME_IDS.sessionLineWidget, undefined]);
		assert.equal(calls.footers.at(-1), undefined);
		assert.equal(calls.editors.at(-1), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("does not install terminal surfaces outside TUI mode", async () => {
	const handlers = new Map();
	createSessionUiExtension({ colorEnabled: false }).factory({
		on(name, handler) {
			handlers.set(name, handler);
		},
		exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
	});
	const calls = { widgets: [], footers: [], editors: [] };
	const ctx = context("/tmp", calls);
	ctx.mode = "rpc";
	await handlers.get("session_start")({}, ctx);
	assert.deepEqual(calls, { widgets: [], footers: [], editors: [] });
});
