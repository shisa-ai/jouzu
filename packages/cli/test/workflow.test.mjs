import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { JouzuPaletteRouter } from "../dist/palette.js";
import { defaultAgentConfig, digest } from "../dist/subagents/roles.js";
import { WorkflowComponent } from "../dist/workflow.js";

function fixture() {
	let config = defaultAgentConfig();
	let writes = 0;
	let closes = 0;
	const context = {
		tui: { requestRender() {}, terminal: { rows: 32, columns: 90 } },
		keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
		theme: { bg: (_role, text) => text, fg: (_role, text) => text, bold: (text) => text },
		styles: { apply: (_role, text) => text },
		close() {
			closes++;
		},
	};
	const service = {
		roles: () => ({ config: structuredClone(config), revision: digest(config) }),
		save: (snapshot) => {
			writes++;
			config = snapshot.config;
		},
		models: () => [{ provider: "test", id: "日本語-model", name: "Test" }],
		runs: () => [],
		activeRole: () => undefined,
		subscribe: () => () => {},
		activate: async () => {},
		launch: async () => {},
		read: () => ({ text: "", nextOffset: null, totalBytes: 0 }),
	};
	const view = new WorkflowComponent(context, service);
	view.focused = true;
	return {
		view,
		context,
		service,
		get writes() {
			return writes;
		},
		get closes() {
			return closes;
		},
		get config() {
			return config;
		},
		text: (width = 48) => view.render(width).join("\n"),
	};
}
const down = (view, n = 1) => {
	for (let i = 0; i < n; i++) view.handleInput("\x1b[B");
};
const enter = (view) => view.handleInput("\r");
const cancel = (view) => view.handleInput("\x1b");

test("Workflow shows definitions, navigates the view choice, and renders empty Runs", () => {
	const f = fixture();
	assert.match(f.text(), /Workflow/);
	assert.match(f.text(), /orchestrator/);
	f.view.handleInput("\x1b[C");
	assert.match(f.text(), /No child runs/);
	f.view.handleInput("\x1b[D");
	assert.match(f.text(), /orchestrator/);
	cancel(f.view);
	assert.equal(f.closes, 1);
});
test("definition edits cancel without saving and text arrows belong to the input", () => {
	const f = fixture();
	down(f.view);
	enter(f.view);
	assert.match(f.text(), /Edit agent/);
	f.view.handleInput("x");
	f.view.handleInput("\x1b[D");
	f.view.handleInput("y");
	assert.equal(f.view.allowsGlobalNavigation(), false);
	cancel(f.view);
	assert.equal(f.writes, 0);
	assert.equal(f.config.roles[0].id, "orchestrator");
});
test("model choice searches Japanese text and Escape preserves the definition draft", () => {
	const f = fixture();
	down(f.view);
	enter(f.view);
	down(f.view, 2);
	enter(f.view);
	assert.match(f.text(), /Search/);
	f.view.handleInput("日本");
	assert.match(f.text(), /日本語/);
	enter(f.view);
	assert.match(f.text(), /Edit agent/);
	assert.equal(f.writes, 0);
	down(f.view, 8);
	enter(f.view);
	assert.equal(f.writes, 1);
	assert.equal(f.config.roles[0].model, "test/日本語-model");
});
test("all rendered rows fit narrow and wide terminals including model search and forms", () => {
	const f = fixture();
	for (const stage of [0, 1, 2]) {
		if (stage === 1) {
			down(f.view);
			enter(f.view);
		}
		if (stage === 2) {
			down(f.view, 2);
			enter(f.view);
			f.view.handleInput("日本");
		}
		for (const width of [8, 24, 48, 80, 120])
			for (const line of f.view.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
	}
});
test("external routing and Tab cannot discard an active definition edit", () => {
	const f = fixture();
	const router = new JouzuPaletteRouter({
		context: f.context,
		initialRoute: { view: "workflow" },
		factories: {
			workflow: () => f.view,
			models: () => ({ render: () => ["model view"], invalidate() {}, route() {} }),
		},
	});
	down(f.view);
	enter(f.view);
	router.handleInput("\t");
	assert.match(router.render(48).join("\n"), /Edit agent/);
	router.route({ view: "models" });
	assert.match(router.render(48).join("\n"), /Edit agent/);
	assert.equal(f.writes, 0);
	cancel(f.view);
	router.handleInput("\t");
	assert.equal(router.render(48)[0], "model view");
});
test("hints use rebound primary and cancel keys", () => {
	const f = fixture();
	f.context.keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.confirm": ["ctrl+y"],
		"tui.select.cancel": ["ctrl+x"],
	});
	const text = f.text();
	assert.match(text, /Ctrl\+Y/);
	assert.match(text, /Ctrl\+X/);
});

test("unsaved definitions cannot launch or apply, and Save keeps its receipt", () => {
	const f = fixture();
	down(f.view);
	enter(f.view);
	f.view.handleInput("x");
	down(f.view, 11);
	enter(f.view);
	assert.match(f.text(80), /Save or cancel your edits/);
	assert.equal(f.writes, 0);
	f.view.handleInput("\x1b[A");
	enter(f.view);
	assert.equal(f.writes, 1);
	assert.match(f.text(80), /Saved/);
});
test("multiline instructions stay in the enclosing draft and fit a short terminal", () => {
	const f = fixture();
	f.context.tui.terminal.rows = 16;
	down(f.view, 2);
	enter(f.view);
	down(f.view, 9);
	enter(f.view);
	assert.match(f.text(80), /Edit instructions/);
	f.view.handleInput("\r");
	f.view.handleInput("Additional instruction");
	assert.ok(f.view.render(48).length <= 16);
	cancel(f.view);
	assert.match(f.text(), /Edit agent/);
	assert.equal(f.writes, 0);
	cancel(f.view);
	assert.equal(f.writes, 0);
});

test("model search receives the hardware cursor marker while focused", () => {
	const f = fixture();
	down(f.view);
	enter(f.view);
	down(f.view, 2);
	enter(f.view);
	assert.match(f.text(), /Search/);
	assert.ok(
		f.text().includes(CURSOR_MARKER),
		"the focused model search renders the hardware cursor marker for IME anchoring",
	);
	f.view.focused = false;
	assert.ok(!f.text().includes(CURSOR_MARKER), "an unfocused palette drops the cursor marker from the search field");
	f.view.focused = true;
	cancel(f.view);
	assert.match(f.text(), /Edit agent/);
	assert.ok(!f.text().includes(CURSOR_MARKER), "exiting the search to the Model row drops the cursor marker");
	enter(f.view);
	assert.match(f.text(), /Search/);
	assert.ok(f.text().includes(CURSOR_MARKER), "reopening the model search restores the cursor marker");
});

test("every run status stays fully visible beside unbounded metadata at 48 columns", () => {
	const f = fixture();
	const statuses = ["queued", "starting", "running", "completed", "failed", "cancelled", "interrupted"];
	const longIdentity = "とても長いエージェント識別子".repeat(3);
	const longTool = "非常に長いツール名".repeat(6);
	const longTask = "長い割り当て。".repeat(24);
	f.view.handleInput("\x1b[C");
	down(f.view);
	for (const status of statuses) {
		for (const meta of ["currentTool", "task"]) {
			const run = {
				id: `fixture-${status}-${meta}`,
				role: { id: longIdentity },
				model: { provider: "fixture", id: "test" },
				status,
				...(meta === "currentTool" ? { currentTool: longTool, task: "Inspect" } : { task: longTask }),
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: null },
			};
			f.service.runs = () => [run];
			const lines = f.view.render(48);
			const text = lines.join("\n");
			assert.ok(text.includes(status), `48: ${status} stays fully visible with a long ${meta} and CJK identity`);
			for (const line of lines) assert.ok(visibleWidth(line) <= 48, `48: ${line}`);
			if (status === "interrupted") {
				const metaText = meta === "currentTool" ? longTool : longTask;
				assert.ok(text.includes(metaText.slice(0, 4)), "metadata still renders when spare space allows");
				for (const width of [24, 80, 120]) {
					for (const line of f.view.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
				}
			}
		}
	}
});

test("Runs opens output, requires Stop confirmation, and exposes Resume after cancellation", async () => {
	const f = fixture();
	let stops = 0;
	const run = {
		id: "fixture-run",
		role: f.config.roles[1],
		model: { provider: "fixture", id: "test" },
		status: "running",
		task: "Inspect fixture",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: null },
	};
	f.service.runs = () => [run];
	f.service.read = () => ({
		text: JSON.stringify({ type: "message", role: "assistant", text: "Output evidence" }),
		nextOffset: null,
		totalBytes: 80,
	});
	f.service.stop = async () => {
		stops++;
		run.status = "cancelled";
	};
	f.view.handleInput("\x1b[C");
	down(f.view);
	enter(f.view);
	assert.match(f.text(80), /Read output/);
	enter(f.view);
	assert.match(f.text(80), /Output evidence/);
	cancel(f.view);
	down(f.view, 2);
	enter(f.view);
	assert.match(f.text(80), /Changes already made remain/);
	assert.equal(stops, 0);
	cancel(f.view);
	down(f.view, 2);
	enter(f.view);
	enter(f.view);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(stops, 1);
	assert.match(f.text(80), /Resume with a task/);
});
