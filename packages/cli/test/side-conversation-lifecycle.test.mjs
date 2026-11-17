import assert from "node:assert/strict";
import { test } from "node:test";
import { InteractiveMode } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
import { initTheme } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { resolveCatalog } from "../dist/locale-catalog.js";
import { createSideConversationExtension, SideConversationComponent } from "../dist/side-conversation.js";
import { afterCleanup } from "./fixtures/cleanup.mjs";
import { fixture, waitForFlow } from "./fixtures/flow-session-ingress.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const completed = {
	id: "side",
	parentSessionId: "parent",
	task: "Side question",
	status: "completed",
	result: "Side answer",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null },
	model: { id: "fixture" },
};
const keys = { matches: (data, action) => data === action, getKeys: () => ["enter"] };

function componentFixture(t, overrides = {}) {
	const sent = [];
	let closed = false;
	const component = new SideConversationComponent(
		{
			catalog: resolveCatalog("en").bundle,
			tui: { terminal: { rows: 24 }, requestRender() {} },
			theme: { bold: (text) => text, fg: (_role, text) => text, bg: (_role, text) => text },
			keybindings: keys,
			close() {
				closed = true;
			},
		},
		{
			async ask(text) {
				sent.push(["question", text]);
			},
			bring() {},
			async beginInstruction() {},
			async send(text, delivery) {
				sent.push([delivery, text]);
			},
			async stop() {},
			fresh() {},
			runs: () => [completed],
			subscribe: () => () => {},
			...overrides,
		},
	);
	t.after(() => component.dispose());
	return { component, sent, closed: () => closed };
}

test("starting a fresh side conversation opens a focused question field", async (t) => {
	let fresh = 0;
	const { component, sent } = componentFixture(t, {
		fresh() {
			fresh++;
		},
	});
	component.focused = true;
	component.handleInput("tui.select.cancel");
	// Cancel side request does not apply without an active request, so it is skipped.
	for (let index = 0; index < 4; index++) component.handleInput("tui.select.down");
	component.handleInput("tui.select.confirm");
	assert.equal(fresh, 1);
	component.handleInput("NEW_QUESTION");
	component.handleInput("tui.input.submit");
	await tick();
	assert.deepEqual(sent, [["question", "NEW_QUESTION"]]);
});

for (const target of ["question", "steer", "followUp"]) {
	test(`cancelled question text never enters a new ${target} edit`, async (t) => {
		const { component, sent } = componentFixture(t);
		component.handleInput("CANCELLED_QUESTION");
		component.handleInput("tui.select.cancel");
		for (let index = 0; index < ["question", "bring", "steer", "followUp"].indexOf(target); index++)
			component.handleInput("tui.select.down");
		component.handleInput("tui.select.confirm");
		await tick();
		assert.ok(component.render(80).every((line) => !line.includes("CANCELLED_QUESTION")));
		component.handleInput("INTENDED_TEXT");
		component.handleInput("tui.input.submit");
		await tick();
		assert.deepEqual(sent, [[target, "INTENDED_TEXT"]]);
	});
}

test("cancelled asynchronous instruction preparation cannot reopen or mutate a closed panel", async (t) => {
	let release;
	const pending = new Promise((resolve) => {
		release = resolve;
	});
	let preparations = 0;
	const f = componentFixture(t, {
		async beginInstruction() {
			preparations++;
			await pending;
		},
	});
	f.component.handleInput("tui.select.cancel");
	f.component.handleInput("tui.select.down");
	f.component.handleInput("tui.select.down");
	f.component.handleInput("tui.select.confirm");
	f.component.handleInput("tui.select.cancel");
	f.component.handleInput("tui.select.confirm");
	assert.equal(preparations, 2, "cancelled preparation releases the panel before it settles");
	f.component.handleInput("tui.select.cancel");
	release();
	await tick();
	assert.equal(f.closed(), false, "cancel preparation returns to actions without closing");
	assert.ok(f.component.render(80).some((line) => line.includes("Send an instruction with this exchange as steering")));
	assert.ok(f.component.render(80).every((line) => line !== "Main instruction"));
	f.component.handleInput("tui.select.cancel");
	assert.equal(f.closed(), true);
});

test("disposing a panel fences pending instruction preparation", async (t) => {
	let release;
	const pending = new Promise((resolve) => {
		release = resolve;
	});
	const f = componentFixture(t, {
		async beginInstruction() {
			await pending;
		},
	});
	f.component.handleInput("tui.select.cancel");
	f.component.handleInput("tui.select.down");
	f.component.handleInput("tui.select.down");
	f.component.handleInput("tui.select.confirm");
	f.component.dispose();
	release();
	await tick();
	assert.ok(f.component.render(80).every((line) => line !== "Main instruction"));
	f.component.handleInput("tui.input.submit");
	assert.deepEqual(f.sent, []);
});

test("the question field stays focused after an answer and Esc backs out one level", async (t) => {
	const f = componentFixture(t);
	f.component.handleInput("FIRST");
	f.component.handleInput("tui.input.submit");
	await tick();
	f.component.handleInput("SECOND");
	f.component.handleInput("tui.input.submit");
	await tick();
	assert.deepEqual(f.sent, [
		["question", "FIRST"],
		["question", "SECOND"],
	]);
	f.component.handleInput("tui.select.cancel");
	assert.equal(f.closed(), false, "the first Esc opens the actions");
	assert.ok(f.component.render(80).some((line) => line.includes("→ Ask a question")));
	f.component.handleInput("tui.select.cancel");
	assert.equal(f.closed(), true);
});

test("actions that do not apply are dimmed and skipped", (t) => {
	let fresh = 0;
	const f = componentFixture(t, {
		runs: () => [],
		fresh() {
			fresh++;
		},
	});
	f.component.handleInput("tui.select.cancel");
	f.component.handleInput("tui.select.down");
	assert.ok(f.component.render(80).some((line) => line.includes("→ Close")));
	f.component.handleInput("tui.select.confirm");
	assert.equal(fresh, 0);
	assert.equal(f.closed(), true);
});

test("Esc while a question is being sent closes the panel and keeps the request", async (t) => {
	let release;
	const pending = new Promise((resolve) => {
		release = resolve;
	});
	const f = componentFixture(t, {
		async ask(text) {
			f.sent.push(["question", text]);
			await pending;
		},
	});
	f.component.handleInput("IN_FLIGHT");
	f.component.handleInput("tui.input.submit");
	assert.ok(f.component.render(80).some((line) => line.includes("Sending…")));
	f.component.handleInput("tui.select.cancel");
	assert.equal(f.closed(), true);
	release();
	await tick();
	assert.deepEqual(f.sent, [["question", "IN_FLIGHT"]]);
});

test("the panel header summarizes the thread and the footer shows the context time", (t) => {
	const reference = { capturedAt: "2026-11-18T03:12:00.000Z", entryId: "entry", truncated: true };
	const f = componentFixture(t, {
		runs: () => [
			{ ...completed, model: { id: "fixture", name: "Fixture Model" }, sideReference: reference },
			{
				...completed,
				id: "running",
				status: "running",
				result: undefined,
				model: { id: "fixture", name: "Fixture Model" },
			},
		],
	});
	const lines = f.component.render(120);
	assert.match(lines[0], /Fixture Model · 1\/20 answered · ↑0 ↓0 · cost unknown/);
	assert.match(lines.at(-1), /Context from (\d{4}-\d{2}-\d{2} )?\d{2}:\d{2} · truncated ─+ Enter ask · Enter actions/);
	assert.match(f.component.render(40).at(-1), /^╰─+ Enter ask/, "a narrow border keeps the key hints");
	assert.ok(lines.some((line) => line.includes("Answering…")));
	assert.ok(
		lines.every((line) => !line.includes("entry")),
		"internal entry IDs are not shown",
	);
	assert.match(f.component.render(48)[0], /1\/20 answered/, "a narrow header keeps the question count");
});

test("a scrolled-up transcript stays in place while new lines arrive", (t) => {
	const runs = [{ ...completed, result: Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n") }];
	const f = componentFixture(t, { runs: () => runs });
	f.component.handleInput("tui.select.pageUp");
	const before = f.component.render(80)[1];
	runs.push({ ...completed, id: "next", task: "Next", result: "More\nlines\narrive" });
	assert.equal(f.component.render(80)[1], before);
});

function realUi(t, presentation) {
	initTheme("dark");
	const saved = process.env.JOUZU_PALETTE_PRESENTATION;
	process.env.JOUZU_PALETTE_PRESENTATION = presentation;
	t.after(() => {
		if (saved === undefined) delete process.env.JOUZU_PALETTE_PRESENTATION;
		else process.env.JOUZU_PALETTE_PRESENTATION = saved;
	});
	let text = "EXISTING_DRAFT";
	let component;
	let mounted;
	const ready = new Promise((resolve) => {
		mounted = resolve;
	});
	const notices = [];
	const owner = {
		editor: {
			getText: () => text,
			setText: (value) => {
				text = value;
			},
		},
		ui: {
			terminal: { rows: 40 },
			requestRender() {},
			showOverlay(value) {
				component = value;
				mounted();
				return { hide() {}, focus() {} };
			},
		},
		keybindings: keys,
		extensionOverlays: new Map(),
		extensionDialogs: [],
		clearExtensionTerminalInputListeners() {},
		setExtensionFooter() {},
		setExtensionHeader() {},
		clearExtensionWidgets() {},
		footerDataProvider: { clearExtensionStatuses() {} },
		footer: { invalidate() {} },
		setCustomEditorComponent() {},
		setupAutocompleteProvider() {},
		defaultEditor: {},
		updateTerminalTitle() {},
		setWorkingIndicator() {},
		setHiddenThinkingLabel() {},
		showTopExtensionDialog() {},
		pushExtensionDialog(value) {
			this.extensionDialogs.push({ component: value });
			component = value;
			mounted();
		},
		removeExtensionDialog(value) {
			this.extensionDialogs = this.extensionDialogs.filter((dialog) => dialog.component !== value);
		},
	};
	const ui = {
		notify: (...args) => notices.push(args),
		getEditorText: () => text,
		pasteToEditor: (value) => {
			text += value;
		},
		custom: (factory, options) => InteractiveMode.prototype.showExtensionCustom.call(owner, factory, options),
	};
	afterCleanup(t, async () => {
		component?.handleInput("tui.select.cancel");
		component?.handleInput("tui.select.cancel");
		await tick();
	});
	return {
		ui,
		ready,
		notices,
		component: () => component,
		text: () => text,
		reset: () => InteractiveMode.prototype.resetExtensionUI.call(owner),
	};
}

for (const presentation of ["replace", "floating"]) {
	for (const transition of ["reload", "replacement"]) {
		test(`open ${presentation} side panel can reopen after ${transition} teardown`, async (t) => {
			const ui = realUi(t, presentation);
			let active;
			let subscriptions = 0;
			const extension = createSideConversationExtension({
				sideRuns: () => [completed],
				sessionId: () => active.session.sessionId,
				subscribe: () => {
					subscriptions++;
					return () => subscriptions--;
				},
			});
			active = await fixture(t, { extensions: [extension] });
			await active.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
			await active.session.prompt("/btw");
			await ui.ready;
			const retired = ui.component();
			retired.handleInput("DISCARDED_DRAFT");
			ui.reset();
			assert.equal(subscriptions, 0);
			if (transition === "reload") await active.session.reload();
			else {
				await active.session.extensionRunner.emit({ type: "session_shutdown", reason: "switch" });
				await active.session.dispose();
				active = await fixture(t, { extensions: [extension] });
				await active.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
			}
			await active.session.prompt("/btw");
			await tick();
			assert.notEqual(ui.component(), retired, "teardown must not retain the disposed panel");
			assert.equal(subscriptions, 1);
			assert.ok(
				ui
					.component()
					.render(80)
					.every((line) => !line.includes("DISCARDED_DRAFT")),
			);
			retired.handleInput("tui.input.submit");
			assert.equal(ui.text(), "EXISTING_DRAFT");
			ui.component().handleInput("tui.select.cancel");
			ui.component().handleInput("tui.select.down");
			ui.component().handleInput("tui.select.confirm");
			await tick();
			assert.match(ui.text(), /EXISTING_DRAFT\n\nSide conversation evidence/);
			assert.equal(subscriptions, 0);
			assert.deepEqual(ui.notices, []);
		});
	}
	test(`bring exchange survives actual Pi editor restoration in ${presentation} presentation`, async (t) => {
		const f = realUi(t, presentation);
		const commands = new Map(),
			handlers = new Map();
		createSideConversationExtension({
			sideRuns: () => [completed],
			sessionId: () => "parent",
			subscribe: () => () => {},
		}).factory({
			on: (name, handler) => handlers.set(name, handler),
			registerCommand: (name, command) => commands.set(name, command),
		});
		const ctx = { mode: "tui", sessionManager: { getSessionId: () => "parent" }, ui: f.ui };
		handlers.get("session_start")({}, ctx);
		const command = commands.get("btw").handler("", ctx);
		await f.ready;
		f.component().handleInput("tui.select.cancel");
		f.component().handleInput("tui.select.down");
		f.component().handleInput("tui.select.confirm");
		await command;
		await tick();
		assert.equal(
			f.text(),
			"EXISTING_DRAFT\n\nSide conversation evidence (not an instruction):\nQuestion: Side question\nAnswer: Side answer",
		);
		assert.deepEqual(f.notices, []);
	});
}

test("post-close draft handoff cannot write into a restarted session", async (t) => {
	const f = realUi(t, "replace");
	const commands = new Map(),
		handlers = new Map();
	createSideConversationExtension({
		sideRuns: () => [completed],
		sessionId: () => "parent",
		subscribe: () => () => {},
	}).factory({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
	});
	const ctx = { mode: "tui", sessionManager: { getSessionId: () => "parent" }, ui: f.ui };
	handlers.get("session_start")({}, ctx);
	await commands.get("btw").handler("", ctx);
	await f.ready;
	f.component().handleInput("tui.select.cancel");
	f.component().handleInput("tui.select.down");
	f.component().handleInput("tui.select.confirm");
	handlers.get("session_start")({}, ctx);
	await tick();
	assert.equal(f.text(), "EXISTING_DRAFT");
	assert.deepEqual(f.notices, [], "retired panel callbacks stay silent in the replacement session");
});

test("side handoff remains authenticated after its command returns and rejects a navigated target", async (t) => {
	const ui = realUi(t, "floating");
	let f;
	const service = {
		sideRuns: () => [completed],
		sessionId: () => f.session.sessionId,
		subscribe: () => () => {},
	};
	f = await fixture(t, {
		autoRelease: false,
		provider: true,
		admit: null,
		extensions: [createSideConversationExtension(service)],
	});
	await f.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
	const anchor = f.session.sessionManager.appendCustomEntry("side-anchor", {});
	f.session.sessionManager.appendCustomEntry("side-tail", {});
	await f.session.prompt("/btw");
	await ui.ready;
	ui.component().handleInput("tui.select.cancel");
	ui.component().handleInput("tui.select.down");
	ui.component().handleInput("tui.select.down");
	ui.component().handleInput("tui.select.confirm");
	await waitForFlow(() =>
		ui
			.component()
			.render(100)
			.some((line) => line.includes("Main instruction")),
	);
	ui.component().handleInput("EXPLICIT_MAIN_INSTRUCTION");
	ui.component().handleInput("tui.input.submit");
	await waitForFlow(() => f.sent.length > 0);
	assert.equal(f.sent.length, 1);
	assert.match(JSON.stringify(f.sent[0]), /EXPLICIT_MAIN_INSTRUCTION/);
	assert.match(JSON.stringify(f.sent[0]), /Side conversation evidence/);
	await f.session.waitForIdle();
	await waitForFlow(
		() =>
			!ui
				.component()
				.render(100)
				.some((line) => line.includes("Main instruction")),
	);
	// A sent instruction returns to the question field; Esc reaches the same action again.
	ui.component().handleInput("tui.select.cancel");
	ui.component().handleInput("tui.select.confirm");
	await waitForFlow(() =>
		ui
			.component()
			.render(100)
			.some((line) => line.includes("Main instruction")),
	);
	assert.equal((await f.session.navigateTree(anchor, { summarize: false })).cancelled, false);
	ui.component().handleInput("MUST_NOT_RETARGET");
	ui.component().handleInput("tui.input.submit");
	await waitForFlow(() =>
		ui
			.component()
			.render(100)
			.some((line) => /changed|target|attachment/i.test(line)),
	);
	assert.equal(f.sent.length, 1);
});

test("real /btw command releases host ownership while the panel stays open and main work wakes", async (t) => {
	const ui = realUi(t, "floating");
	const f = await fixture(t, {
		autoRelease: false,
		provider: true,
		admit: null,
		extensions: [createSideConversationExtension({ sideRuns: () => [], subscribe: () => () => {} })],
	});
	await f.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
	let returned = false;
	const command = f.session.prompt("/btw").then(() => {
		returned = true;
	});
	afterCleanup(t, async () => {
		ui.component()?.handleInput("tui.select.cancel");
		await command;
	});
	await ui.ready;
	await tick();
	assert.equal(returned, true, "UI lifetime must not retain the command's host operation");
	const branch = f.ingress.branch();
	assert.equal((await branch.host.atIdle(async () => "available")).kind, "idle");
	await branch.attachment.waits.registerWork("work", "side-probe", 0);
	branch.controller.register({
		version: 1,
		namespace: "side-probe",
		snapshot: async () => [
			{
				id: "work",
				revision: "1",
				producer: "side-probe",
				sequence: 0,
				rank: 4,
				workId: "work",
				workRevision: "1",
				independent: true,
				runnable: true,
			},
		],
		build: async () => ({ id: "work", revision: "1", kind: "work", text: "Continue main work" }),
	});
	await branch.controller.wake();
	assert.equal(f.sent.length, 1, "main work must start without closing the side panel");
});

test("bring uses the latest completed exchange while a later question is running", async (t) => {
	const f = realUi(t, "replace");
	const commands = new Map(),
		handlers = new Map();
	const running = {
		...completed,
		id: "later",
		task: "Later",
		status: "running",
		result: undefined,
		previousRunId: "side",
	};
	createSideConversationExtension({
		sideRuns: () => [running, completed],
		sessionId: () => "parent",
		subscribe: () => () => {},
	}).factory({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
	});
	const ctx = { mode: "tui", sessionManager: { getSessionId: () => "parent" }, ui: f.ui };
	handlers.get("session_start")({}, ctx);
	await commands.get("btw").handler("", ctx);
	await f.ready;
	f.component().handleInput("tui.select.cancel");
	f.component().handleInput("tui.select.down");
	f.component().handleInput("tui.select.confirm");
	await tick();
	assert.match(f.text(), /Question: Side question\nAnswer: Side answer/);
	assert.deepEqual(f.notices, []);
});

test("/btw with a question keeps it as a draft when it cannot be sent, and the limit counts answers only", async (t) => {
	const f = realUi(t, "replace");
	const commands = new Map(),
		handlers = new Map();
	const asks = [];
	let runs = [];
	const chain = (statuses) =>
		statuses.map((status, index) => ({
			...completed,
			id: `run-${index}`,
			previousRunId: index ? `run-${index - 1}` : undefined,
			status,
			result: status === "completed" ? "Answer" : "Provider error",
		}));
	createSideConversationExtension({
		sideRuns: () => [...runs].reverse(),
		sessionId: () => "parent",
		subscribe: () => () => {},
		async askSide(text, previousRunId) {
			asks.push(text);
			const run = { ...completed, id: `asked-${asks.length}`, task: text, previousRunId };
			runs.push(run);
			return run;
		},
	}).factory({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
	});
	const ctx = { mode: "tui", sessionManager: { getSessionId: () => "parent" }, ui: f.ui };
	runs = chain([...Array(20).fill("completed")]);
	handlers.get("session_start")({}, ctx);
	await commands.get("btw").handler("KEPT_QUESTION", ctx);
	await f.ready;
	assert.deepEqual(asks, []);
	const lines = f.component().render(100);
	assert.ok(
		lines.some((line) => line.includes("KEPT_QUESTION")),
		"the rejected question stays in the field",
	);
	assert.ok(lines.some((line) => line.includes("20 answered questions")));
	f.component().handleInput("tui.select.cancel");
	f.component().handleInput("tui.select.cancel");
	await tick();
	runs = chain([...Array(19).fill("completed"), "failed", "cancelled"]);
	handlers.get("session_start")({}, ctx);
	await commands.get("btw").handler("ALLOWED", ctx);
	assert.deepEqual(asks, ["ALLOWED"], "failed and cancelled requests do not use up the thread");
});
