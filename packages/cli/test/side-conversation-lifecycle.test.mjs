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
			theme: { bold: (text) => text },
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
			runs: () => [],
			subscribe: () => () => {},
			...overrides,
		},
	);
	t.after(() => component.dispose());
	return { component, sent, closed: () => closed };
}

for (const target of ["question", "steer", "followUp"]) {
	test(`cancelled question text never enters a new ${target} edit`, async (t) => {
		const { component, sent } = componentFixture(t);
		component.handleInput("tui.select.confirm");
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
	const f = componentFixture(t, {
		async beginInstruction() {
			await pending;
		},
	});
	f.component.handleInput("tui.select.down");
	f.component.handleInput("tui.select.down");
	f.component.handleInput("tui.select.confirm");
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
		pushExtensionDialog(value) {
			component = value;
			mounted();
		},
		removeExtensionDialog() {},
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
	return { ui, ready, notices, component: () => component, text: () => text };
}

for (const presentation of ["replace", "floating"]) {
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
	ui.component().handleInput("tui.select.down");
	ui.component().handleInput("tui.select.down");
	ui.component().handleInput("tui.select.confirm");
	await waitForFlow(() => ui.component().render(100).includes("Main instruction"));
	ui.component().handleInput("EXPLICIT_MAIN_INSTRUCTION");
	ui.component().handleInput("tui.input.submit");
	await waitForFlow(() => f.sent.length > 0);
	assert.equal(f.sent.length, 1);
	assert.match(JSON.stringify(f.sent[0]), /EXPLICIT_MAIN_INSTRUCTION/);
	assert.match(JSON.stringify(f.sent[0]), /Side conversation evidence/);
	await f.session.waitForIdle();
	await waitForFlow(() => !ui.component().render(100).includes("Main instruction"));
	ui.component().handleInput("tui.select.confirm");
	await waitForFlow(() => ui.component().render(100).includes("Main instruction"));
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
