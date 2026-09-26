import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedLabelTask, createSessionLabelsExtension } from "../dist/session-labels.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture({ entries = [], name, mode = "tui" } = {}) {
	const handlers = new Map(),
		events = new Map(),
		commands = new Map(),
		calls = [],
		notifications = [],
		panes = [];
	let id = entries.length;
	const ctx = {
		mode,
		cwd: "/workspace/folder",
		model: { provider: "test", id: "cheap" },
		sessionManager: {
			getSessionId: () => "session",
			getEntries: () => entries,
			getBranch: () => entries,
			getSessionName: () => name,
		},
		ui: { notify: (text) => notifications.push(text) },
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
					defer: (turns) =>
						resolve({
							stopReason: "stop",
							content: [{ type: "text", text: JSON.stringify({ action: "defer", revisitAfterTurns: turns }) }],
							usage: {},
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
	createSessionLabelsExtension(
		{
			update: async (...args) => {
				panes.push(args);
				return true;
			},
			release: async () => {},
		},
		async () => ({ folder: "folder", repository: "repository" }),
	).factory(pi);
	const emit = (event, data = {}) => handlers.get(event)?.(data, ctx);
	const command = (args) => commands.get("labels").handler(args, ctx);
	const finish = async (outcome = "completed") => {
		await emit("agent_before_settle", { outcome });
		await emit("agent_settled");
	};
	const input = async (text, complete = true) => {
		await emit("input", { source: "interactive", text });
		await emit("message_start", { message: { role: "user", content: text } });
		if (complete) await finish();
	};
	return {
		emit,
		command,
		input,
		calls,
		notifications,
		panes,
		pi,
		entries,
		ctx,
		name: () => name,
		finish,
		workflow: async (objective, complete = true) => {
			events.get("jouzu:workflow-start")({ session: "session", objective });
			if (complete) await finish();
		},
	};
}

test("empty startup, missing model, raw input, extension turns, and machine modes make no requests", async () => {
	const f = fixture();
	await f.emit("session_start");
	f.ctx.model = undefined;
	await f.input("Fix labels");
	assert.equal(f.calls.length, 0);
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

test("admitted input names by default and persists route, ownership, and usage", async () => {
	const f = fixture();
	await f.emit("session_start");
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
	await f.workflow("New objective");
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
	await f.workflow("Second task");
	await f.workflow("Third task");
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
		await f.workflow(`Objective ${i}`);
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
	await reopened.workflow("Other task");
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

test("bare labels reports status and every command without changing state or pending naming", async () => {
	const f = fixture();
	await f.emit("session_start");
	await f.command("");
	assert.equal(f.entries.length, 0);
	assert.equal(f.calls.length, 0);
	assert.equal(f.panes.length, 0);
	assert.match(f.notifications.at(-1), /Automatic naming: on/);
	for (const command of [
		"/labels —",
		"/labels on —",
		"/labels off —",
		"/labels pin —",
		"/labels auto —",
		"/labels pane pin —",
		"/labels pane auto —",
	])
		assert.ok(f.notifications.at(-1).includes(command));
	await f.input("Task");
	const before = structuredClone(f.entries);
	await f.command("   ");
	assert.deepEqual(f.entries, before);
	assert.equal(f.calls[0].options.signal.aborted, false);
	assert.match(f.notifications.at(-1), /test\/cheap/);
	assert.match(f.notifications.at(-1), /Naming requests: 1\/20/);
	f.calls[0].resolve();
	await settle();
});

test("explicit off survives reopen including saved states without an enabled field", async () => {
	const f = fixture();
	await f.emit("session_start");
	await f.command("off");
	for (const legacy of [false, true]) {
		const entries = structuredClone(f.entries);
		if (legacy) delete entries.at(-1).data.enabled;
		const resumed = fixture({ entries });
		await resumed.emit("session_start");
		await resumed.input("Task");
		await resumed.workflow("Goal");
		assert.equal(resumed.calls.length, 0);
		await resumed.command("");
		assert.match(resumed.notifications.at(-1), /Automatic naming: off/);
		await resumed.command("on");
		await resumed.input("New task");
		assert.equal(resumed.calls.length, 1);
		resumed.calls[0].resolve();
		await settle();
	}
});

test("default route selects the first task model and does not follow subsequent model switches", async () => {
	const f = fixture();
	await f.emit("session_start");
	f.ctx.model = { provider: "chosen", id: "first" };
	await f.input("Task");
	assert.deepEqual(f.calls[0].model, f.ctx.model);
	f.calls[0].resolve();
	await settle();
	f.ctx.model = { provider: "other", id: "second" };
	await f.workflow("Another task");
	assert.deepEqual(f.calls[1].model, { provider: "chosen", id: "first" });
	f.calls[1].resolve();
	await settle();
});

test("naming waits for completion, uses folder/repository/query, and ignores failed turns", async () => {
	const f = fixture();
	await f.emit("session_start");
	await f.input("Fix login", false);
	assert.equal(f.calls.length, 0);
	await f.emit("turn_end", {});
	assert.equal(f.calls.length, 0);
	await f.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	assert.equal(f.calls.length, 1);
	const data = JSON.parse(f.calls[0].context.messages[1].content);
	assert.deepEqual(data, { folder: "folder", repository: "repository", task: "Fix login" });
	await f.finish();
	assert.equal(f.calls.length, 1);
	f.calls[0].resolve();
	await settle();
	for (const outcome of ["aborted", "error"]) {
		const failed = fixture();
		await failed.emit("session_start");
		await failed.input("Task", false);
		await failed.emit("agent_end", { messages: [{ role: "assistant", stopReason: outcome }] });
		await failed.finish(outcome);
		assert.equal(failed.calls.length, 0);
	}
});

test("ambiguous tasks revisit after the requested completed user turns, not timers or automatic runs", async () => {
	const f = fixture();
	await f.emit("session_start");
	await f.input("Help me");
	f.calls[0].defer(2);
	await settle();
	await f.command("");
	assert.match(f.notifications.at(-1), /revisit after 2 more completed/);
	await f.finish();
	await f.finish();
	assert.equal(f.calls.length, 1);
	await f.input("The auth API");
	assert.equal(f.calls.length, 1);
	await f.input("Fix login validation");
	assert.equal(f.calls.length, 2);
	const data = JSON.parse(f.calls[1].context.messages[1].content);
	assert.equal(data.previousTask, "The auth API");
	assert.equal(data.task, "Fix login validation");
	f.calls[1].resolve();
	await settle();
});

test("resume checks missing names from completed history and retains deferred schedules", async () => {
	const resumed = fixture({
		entries: [
			{ type: "message", message: { role: "user", content: "Fix the parser" } },
			{ type: "message", message: { role: "assistant", stopReason: "stop" } },
		],
	});
	await resumed.emit("session_start");
	await settle();
	assert.equal(resumed.calls.length, 1);
	assert.equal(JSON.parse(resumed.calls[0].context.messages[1].content).task, "Fix the parser");
	resumed.calls[0].defer(1);
	await settle();
	const again = fixture({ entries: resumed.entries });
	await again.emit("session_start");
	assert.equal(again.calls.length, 0, "resume alone does not supply clarification");
	await again.input("Handle empty tokens");
	assert.equal(again.calls.length, 1);
	again.calls[0].resolve();
	await settle();
	const finished = fixture({ entries: again.entries, name: again.name() });
	await finished.emit("session_start");
	assert.equal(finished.calls.length, 0, "existing automatic labels are reused");
});

test("task data is byte-bounded and redacts absolute paths and common credential prefixes", () => {
	const task = boundedLabelTask("Read /home/private/file with sk-secret then " + "日本語".repeat(2000));
	assert.ok(Buffer.byteLength(task) <= 1800);
	assert.doesNotMatch(task, /home\/private|sk-secret|\ufffd/);
});
