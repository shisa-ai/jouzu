import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { applyInstalledMultiloopWaitSkill } from "../../../scripts/apply-multiloop-wait-skill.mjs";

const root = resolve(import.meta.dirname, "../../..");
async function fixture(t) {
	await applyInstalledMultiloopWaitSkill(true);
	const outputDir = await mkdtemp(join(root, "packages/cli/node_modules/.jouzu-loop-test-"));
	const cwd = await mkdtemp(join(tmpdir(), "jouzu-loop-flow-"));
	t.after(async () => {
		await rm(outputDir, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	});
	const installed = join(root, "packages/cli/node_modules/pi-multiloop/extensions/pi-multiloop");
	const output = join(outputDir, "loop.mjs");
	await build({
		stdin: {
			contents: `export { default } from ${JSON.stringify(join(installed, "index.ts"))}; export * from ${JSON.stringify(join(installed, "jouzu-flow.ts"))};`,
			resolveDir: root,
			loader: "ts",
		},
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		outfile: output,
		logLevel: "silent",
	});
	const module = await import(pathToFileURL(output).href);
	const tools = new Map(),
		handlers = new Map(),
		commands = new Map(),
		sends = [],
		notifications = [];
	const pi = {
		on(name, handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		registerCommand(name, command) {
			commands.set(name, command);
		},
		registerMessageRenderer() {},
		sendMessage() {},
		sendUserMessage(text) {
			sends.push(text);
		},
	};
	module.default(pi);
	const ctx = {
		cwd,
		hasUI: false,
		hasPendingMessages: () => false,
		sessionManager: { getSessionId: () => "session", getEntries: () => [], getBranch: () => [] },
		ui: {
			setStatus() {},
			setWidget() {},
			notify(text) {
				notifications.push(text);
			},
		},
	};
	const emit = async (name, event = {}) => {
		for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
	};
	const execute = (name, args) => tools.get(name).execute("tool", args, undefined, undefined, ctx);
	return {
		...module,
		ctx,
		emit,
		execute,
		sends,
		notifications,
		command: (name, args) => commands.get(name).handler(args, ctx),
	};
}

test("installed multiloop submits lazy per-lane continuations and preserves live waits on status turns", async (t) => {
	const f = await fixture(t),
		intents = new Map(),
		changes = [];
	let waiting = true,
		submits = 0;
	const detach = f.attachMultiloopFlow("session", {
		version: 1,
		submit(intent) {
			submits++;
			intents.set(intent.lane.lane, intent);
		},
		waiting: (lane) => waiting && lane.lane === "waiting",
		changed: (lanes) => changes.push(lanes),
	});
	t.after(detach);
	assert.throws(() => f.attachMultiloopFlow("session", {}));
	await f.execute("multiloop_start", { lane: "waiting", runTag: "run", mode: "research", goal: "Wait for process" });
	await f.emit("agent_start");
	await f.emit("tool_call");
	await f.emit("agent_end");
	assert.equal(submits, 1);
	assert.deepEqual(f.sends, []);
	const first = intents.get("waiting");
	assert.match(first.build(), /Wait for process/);
	first.admitted();
	for (let i = 0; i < 3; i++) {
		await f.emit("input", { source: "interactive", text: "status?" });
		await f.emit("agent_start");
		await f.emit("agent_end");
	}
	assert.equal(changes.at(-1)[0].lane, "waiting");
	assert.equal(
		f.notifications.some((text) => text.includes("no tool calls")),
		false,
	);
	assert.deepEqual(f.sends, []);
	waiting = false;
	intents.get("waiting").admitted();
	await f.emit("agent_start");
	await f.emit("agent_end");
	assert.deepEqual(changes.at(-1), []);
	assert.match(f.notifications.at(-1), /no tool calls/);
	assert.throws(() => first.build(), /no longer active/);
	assert.throws(() => first.admitted(), /no longer active/);
});

test("installed multiloop keeps explicit pause authoritative while waiting", async (t) => {
	const f = await fixture(t),
		changes = [];
	const detach = f.attachMultiloopFlow("session", {
		version: 1,
		submit() {},
		waiting: () => true,
		changed: (lanes) => changes.push(lanes),
	});
	t.after(detach);
	await f.execute("multiloop_start", { lane: "waiting", runTag: "run", mode: "research", goal: "Wait" });
	await f.execute("multiloop_pause", { target: "waiting/run" });
	assert.deepEqual(changes.at(-1), []);
	assert.equal(f.multiloopFlow("another-session"), undefined);
});

test("installed multiloop suspends only waiting lanes and submits compaction intent without sending", async (t) => {
	const f = await fixture(t),
		intents = [],
		changes = [];
	const detach = f.attachMultiloopFlow("session", {
		version: 1,
		submit: (intent) => intents.push(intent),
		waiting: (lane) => lane.lane === "blocked",
		changed: (lanes) => changes.push(lanes),
	});
	t.after(detach);
	for (const lane of ["blocked", "stalled"])
		await f.execute("multiloop_start", { lane, runTag: "run", mode: "research", goal: lane });
	await f.emit("agent_start");
	await f.emit("tool_call");
	await f.emit("agent_end");
	assert.equal(intents.length, 2);
	intents[0].admitted();
	await f.emit("agent_start");
	await f.emit("agent_end");
	assert.deepEqual(changes.at(-1), [{ lane: "blocked", runTag: "run" }]);
	await f.emit("input", { source: "interactive", text: "status?" });
	await f.emit("agent_start");
	await f.emit("session_before_compact", { reason: "threshold", willRetry: false });
	await f.emit("session_compact", { reason: "threshold", willRetry: false, compactionEntry: { id: "compacted" } });
	await f.emit("agent_end");
	assert.equal(intents.at(-1).reason, "compaction-resume");
	assert.match(intents.at(-1).build(), /compacted/);
	assert.deepEqual(f.sends, []);
});

test("installed commands await campaign transitions and route explicit resumes through admission", async (t) => {
	const f = await fixture(t),
		transitions = [],
		intents = [];
	const detach = f.attachMultiloopFlow("session", {
		version: 1,
		submit: (intent) => intents.push(intent),
		waiting: () => true,
		changed() {},
		async transition(lane, status) {
			transitions.push({ ...lane, status });
		},
	});
	t.after(detach);
	await f.execute("multiloop_start", { lane: "command", runTag: "run", mode: "research", goal: "Await result" });
	await f.command("multiloop", "pause command/run");
	await f.command("multiloop", "resume command/run");
	assert.equal(intents.at(-1).reason, "explicit-resume");
	assert.match(intents.at(-1).build(), /Await result/);
	await f.command("multiloop", "archive command/run");
	assert.deepEqual(
		transitions.map((x) => x.status),
		["active", "paused", "active", "stopped"],
	);
	await f.command("goal", "Test campaign commands");
	assert.equal(intents.at(-1).reason, "goal-start");
	await f.command("goal", "pause");
	await f.command("goal", "resume");
	assert.equal(intents.at(-1).reason, "goal-resume");
	await f.command("goal", "clear");
	assert.equal(transitions.at(-1).status, "paused");
	const lane = transitions.at(-1);
	await f.command("multiloop", `rm ${lane.lane}/${lane.runTag}`);
	assert.equal(transitions.at(-1).status, "stopped");
	assert.deepEqual(f.sends, []);
});
