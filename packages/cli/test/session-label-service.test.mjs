import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedLabelTask, createSessionLabelsExtension } from "../dist/session-labels.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture({ entries = [], name, mode = "tui" } = {}) {
	const handlers = new Map(),
		events = new Map(),
		commands = new Map(),
		calls = [],
		panes = [];
	let id = entries.length;
	const ctx = {
		mode,
		model: { provider: "test", id: "cheap" },
		sessionManager: { getSessionId: () => "session", getEntries: () => entries, getSessionName: () => name },
		ui: { notify() {} },
		modelRegistry: {
			find: (provider, model) => ({ provider, id: model }),
			streamSimple(model, context, options) {
				let resolve, reject;
				const response = new Promise((yes, no) => {
					resolve = yes;
					reject = no;
				});
				calls.push({
					model,
					context,
					options,
					resolve: (name = "Fix session labels", label = "label-fix") =>
						resolve({
							stopReason: "stop",
							content: [{ type: "text", text: JSON.stringify({ action: "rename", name, label }) }],
							usage: { input: 1, output: 1 },
						}),
					reject,
				});
				return { result: () => response };
			},
		},
	};
	const pi = {
		on: (event, handler) => handlers.set(event, handler),
		events: { on: (event, handler) => events.set(event, handler) },
		registerCommand: (name, definition) => commands.set(name, definition),
		appendEntry: (customType, data) =>
			entries.push({ type: "custom", id: String(++id), customType, data: structuredClone(data) }),
		setSessionName(value) {
			name = value;
			entries.push({ type: "session_info", name, id: String(++id) });
			handlers.get("session_info_changed")?.({ name }, ctx);
		},
	};
	createSessionLabelsExtension({
		update: async (...args) => {
			panes.push(args);
			return true;
		},
		release: async () => {},
	}).factory(pi);
	const emit = (event, data = {}) => handlers.get(event)?.(data, ctx);
	const command = (args) => commands.get("labels").handler(args, ctx);
	const input = async (text) => {
		await emit("input", { source: "interactive", text });
		await emit("message_start", { message: { role: "user", content: text } });
	};
	return {
		emit,
		command,
		input,
		calls,
		panes,
		pi,
		entries,
		ctx,
		name: () => name,
		workflow: (objective) => events.get("jouzu:workflow-start")({ session: "session", objective }),
	};
}

test("empty startup, unapproved model, raw input, extension turns, and machine modes make no requests", async () => {
	const f = fixture();
	await f.emit("session_start");
	await f.input("Fix labels");
	assert.equal(f.calls.length, 0);
	await f.command("on");
	await f.emit("input", { source: "interactive", text: "Not admitted" });
	assert.equal(f.calls.length, 0);
	await f.emit("input", { source: "extension", text: "Continue" });
	await f.emit("message_start", { message: { role: "user", content: "Continue" } });
	assert.equal(f.calls.length, 0);
	for (const mode of ["rpc", "print", "json"]) {
		const machine = fixture({ mode });
		await machine.emit("session_start");
		await machine.command("on");
		await machine.input("Fix labels");
		assert.equal(machine.calls.length, 0);
	}
});

test("admitted input generates bounded tool-free labels and persists route, ownership, and usage", async () => {
	const f = fixture();
	await f.emit("session_start");
	await f.command("on");
	await f.input("Fix labels");
	assert.equal(f.calls.length, 1);
	assert.equal(f.calls[0].context.tools, undefined);
	assert.equal(f.calls[0].options.maxTokens, 100);
	assert.equal(f.calls[0].options.maxRetries, 0);
	f.calls[0].resolve();
	await settle();
	assert.equal(f.name(), "Fix session labels");
	assert.deepEqual(f.panes, [["label-fix"]]);
	assert.equal(f.entries.filter((e) => e.customType === "jouzu-session-label-usage").length, 1);
	await f.input("Fix labels");
	assert.equal(f.calls.length, 1);
	await f.emit("session_shutdown");
	const resumed = fixture({ entries: f.entries, name: f.name() });
	await resumed.emit("session_start");
	await resumed.input("Fix labels");
	assert.equal(resumed.calls.length, 0);
	assert.deepEqual(resumed.panes, [["label-fix"]]);
});

test("manual names, same-value renames, and rename during a request stay pinned", async () => {
	const f = fixture({ name: "User name" });
	await f.emit("session_start");
	await f.command("on");
	await f.input("Task one");
	f.calls[0].resolve();
	await settle();
	assert.equal(f.name(), "User name");
	await f.command("auto");
	f.workflow("New objective");
	f.pi.setSessionName("User name");
	f.calls[1].resolve("Do not apply");
	await settle();
	assert.equal(f.name(), "User name");
	assert.equal(f.calls[1].options.signal.aborted, true);
});

test("newer intent coalesces behind one request and stale responses cannot apply", async () => {
	const f = fixture();
	await f.emit("session_start");
	await f.command("on");
	await f.input("First task");
	f.workflow("Second task");
	f.workflow("Third task");
	assert.equal(f.calls.length, 1);
	assert.equal(f.calls[0].options.signal.aborted, true);
	f.calls[0].resolve("Stale");
	await settle();
	assert.equal(f.name(), undefined);
	assert.equal(f.calls.length, 2);
	assert.match(f.calls[1].context.messages[1].content, /Third task/);
	f.calls[1].resolve("Third task");
	await settle();
	assert.equal(f.name(), "Third task");
});

test("shutdown, tree navigation, and disabled naming discard pending proposals", async () => {
	for (const action of ["session_shutdown", "session_tree", "off"]) {
		const f = fixture();
		await f.emit("session_start");
		await f.command("on");
		await f.input("Task");
		if (action === "off") await f.command("off");
		else await f.emit(action);
		f.calls[0].resolve();
		await settle();
		assert.equal(f.name(), undefined);
		assert.equal(f.panes.length, 0);
	}
});

test("request cap and provider failures do not affect the main turn", async () => {
	const f = fixture();
	await f.emit("session_start");
	await f.command("on");
	for (let i = 0; i < 25; i++) {
		f.workflow(`Objective ${i}`);
		f.calls.at(-1)?.reject(new Error("Provider unavailable"));
		await settle();
	}
	assert.equal(f.calls.length, 20);
	assert.equal(f.name(), undefined);
});

test("deadline aborts the request and a late response cannot rename", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	await f.emit("session_start");
	await f.command("on");
	await f.input("Task");
	t.mock.timers.tick(10_000);
	assert.equal(f.calls[0].options.signal.aborted, true);
	f.calls[0].resolve();
	await settle();
	assert.equal(f.name(), undefined);
});

test("invalid persisted state and an offline same-value rename do not grant name ownership", async () => {
	const f = fixture();
	await f.emit("session_start");
	await f.command("on");
	await f.input("Task");
	f.calls[0].resolve();
	await settle();
	f.entries.push({ type: "session_info", id: "offline-rename", name: f.name() });
	const reopened = fixture({ entries: f.entries, name: f.name() });
	await reopened.emit("session_start");
	reopened.workflow("Other task");
	reopened.calls[0].resolve("Must stay pinned");
	await settle();
	assert.equal(reopened.name(), "Fix session labels");
	const corrupt = fixture({
		entries: [
			{
				type: "custom",
				customType: "jouzu-session-labels-v1",
				data: { version: 1, session: "session", route: { provider: "unapproved", model: "secret" } },
			},
		],
		name: "User name",
	});
	await corrupt.emit("session_start");
	await corrupt.input("Task");
	assert.equal(corrupt.calls.length, 0);
});

test("task data is byte-bounded and redacts absolute paths and common credential prefixes", () => {
	const task = boundedLabelTask("Read /home/private/file with sk-secret then " + "日本語".repeat(2000));
	assert.ok(Buffer.byteLength(task) <= 1800);
	assert.doesNotMatch(task, /home\/private|sk-secret|\ufffd/);
});
