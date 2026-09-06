import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveJouzuPaths } from "../dist/paths.js";
import { createWorkflowIntegration } from "../dist/subagents/integration.js";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "jouzu-agent-integration-"));
	const paths = resolveJouzuPaths({ homeOverride: join(root, "config") });
	const workers = [];
	const messages = [];
	const entries = [];
	const notifications = [];
	const integration = createWorkflowIntegration(paths, (launch, emit, exit) => {
		const worker = {
			launch,
			emit,
			exit,
			send() {},
			async stop() {
				exit(false);
			},
		};
		workers.push(worker);
		return worker;
	});
	const handlers = new Map();
	const commands = new Map();
	const opened = [];
	let tool;
	let command;
	let selected;
	integration.register(
		{
			on: (name, handler) => handlers.set(name, handler),
			registerCommand: (name, definition) => {
				command = name;
				commands.set(name, definition);
			},
			registerTool: (value) => {
				tool = value;
			},
			setModel: async (model) => {
				selected = model;
				return true;
			},
			setThinkingLevel() {},
			appendEntry: (type, data) => entries.push({ type, data }),
			sendMessage: (message, options) => messages.push({ message, options }),
		},
		async (section) => {
			opened.push(section);
			return true;
		},
	);
	const models = ["gpt-6-astra", "glm-5.3-flash"].map((id) => ({
		id,
		provider: "fixture",
		name: id,
		api: "openai-completions",
	}));
	const ctx = {
		mode: "tui",
		cwd: root,
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: { getBranch: () => [], getSessionId: () => "parent", getLeafId: () => "entry" },
		modelRegistry: {
			getAvailable: () => models,
			getRegisteredProviderConfig: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret" }),
		},
		ui: { notify: (...args) => notifications.push(args) },
	};
	return {
		root,
		paths,
		integration,
		handlers,
		commands,
		opened,
		workers,
		messages,
		entries,
		notifications,
		ctx,
		get command() {
			return command;
		},
		get selected() {
			return selected;
		},
		invoke: async (params) => JSON.parse((await tool.execute("id", params)).content[0].text),
		shutdown: () => handlers.get("session_shutdown")(),
	};
}
test("Workflow registers a tool and command, applies main instructions, and coalesces bounded child results", async () => {
	const f = fixture();
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		assert.equal(f.command, "workflow");
		await f.commands.get("subagents").handler("", f.ctx);
		assert.deepEqual(f.opened, ["runs"]);
		await f.commands.get("subagents").handler("hide", f.ctx);
		assert.match(f.notifications.at(-1)[0], /pane hidden/);
		await f.commands.get("subagents").handler("show", f.ctx);
		assert.match(f.notifications.at(-1)[0], /pane enabled/);
		await f.integration.service.activate("orchestrator");
		assert.equal(f.selected.id, "gpt-6-astra");
		assert.equal(f.entries.length, 1);
		const prompt = f.handlers.get("before_agent_start")({ systemPrompt: "Base" }, f.ctx);
		assert.match(prompt.systemPrompt, /orchestrator/);
		const roles = await f.invoke({ op: "roles" });
		assert.equal(roles.length, 3);
		assert.equal(roles[0].instructions, undefined);
		const a = await f.invoke({ op: "launch", role: "reviewer", task: "Inspect requirements A" });
		const b = await f.invoke({ op: "launch", role: "reviewer", task: "Inspect requirements B" });
		assert.equal(a.task, undefined);
		assert.equal(f.workers[0].launch.auth.apiKey, "secret");
		for (const worker of f.workers) {
			worker.emit({ type: "result", status: "completed", text: "Evidence ".repeat(4000) });
			worker.exit(true);
		}
		await new Promise((resolve) => setTimeout(resolve, 130));
		assert.equal(f.messages.length, 1);
		assert.equal(f.messages[0].options.triggerTurn, true);
		assert.ok(f.messages[0].message.content.length < 4600);
		const runs = await f.invoke({ op: "list" });
		assert.equal(runs.runs.length, 2);
		assert.equal(runs.runs[0].result, undefined);
		assert.equal((await f.invoke({ op: "read", id: b.id })).nextOffset !== null, true);
	} finally {
		await f.shutdown();
	}
});
test("subagents command reports JSON without opening a non-interactive pane", async (t) => {
	const f = fixture();
	try {
		f.ctx.mode = "print";
		f.ctx.hasUI = false;
		await f.handlers.get("session_start")({}, f.ctx);
		const output = [];
		t.mock.method(console, "log", (text) => output.push(text));
		await f.commands.get("subagents").handler("", f.ctx);
		assert.deepEqual(JSON.parse(output[0]), { runs: [] });
		assert.deepEqual(f.opened, []);
	} finally {
		await f.shutdown();
	}
});

test("malformed definitions preserve session startup and a cancelled child does not wake the main agent", async () => {
	const f = fixture();
	try {
		mkdirSync(f.paths.configDir);
		writeFileSync(join(f.paths.configDir, "agents.json"), "broken");
		await f.handlers.get("session_start")({}, f.ctx);
		assert.equal(f.notifications.length, 1);
		// Repair explicitly; a failed parse never overwrites the user's file.
		writeFileSync(
			join(f.paths.configDir, "agents.json"),
			JSON.stringify((await import("../dist/subagents/roles.js")).defaultAgentConfig()),
		);
		const a = await f.invoke({ op: "launch", role: "coder", task: "Do assigned work" });
		await f.invoke({ op: "stop", id: a.id });
		await new Promise((resolve) => setTimeout(resolve, 130));
		assert.equal(f.messages[0].options.triggerTurn, false);
	} finally {
		await f.shutdown();
	}
});

test("launch routes workspace before authentication and resume retains the original folder and context", async () => {
	const f = fixture();
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		let authCalls = 0;
		f.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
			authCalls++;
			return { ok: true, apiKey: "secret" };
		};
		await assert.rejects(
			f.invoke({ op: "launch", role: "coder", task: "Work", workspace: "missing" }),
			/Workspace:.*does not exist/,
		);
		assert.equal(authCalls, 0);
		assert.equal(f.workers.length, 0);
		const workspace = join(f.root, "worktree");
		mkdirSync(workspace);
		const launched = await f.invoke({ op: "launch", role: "coder", task: "Work", workspace: "worktree" });
		assert.equal(launched.workspace, workspace);
		assert.equal(launched.context.mode, "fresh");
		assert.equal(launched.context.parentLookup, true);
		assert.equal(f.workers[0].launch.cwd, workspace);
		assert.ok(f.workers[0].launch.parentContextFile);
		const sessionFile = join(f.workers[0].launch.directory, "session.jsonl");
		writeFileSync(sessionFile, "{}");
		f.workers[0].emit({ type: "ready", sessionFile, sessionId: "child" });
		f.workers[0].emit({ type: "result", status: "completed", text: "Done" });
		f.workers[0].exit(true);
		f.ctx.cwd = f.root;
		await assert.rejects(
			f.invoke({ op: "resume", id: launched.id, task: "Continue", workspace: f.root }),
			/launch-only/,
		);
		const resumed = await f.invoke({ op: "resume", id: launched.id, task: "Continue" });
		assert.equal(resumed.workspace, workspace);
		assert.equal(f.workers[1].launch.parentContextFile, f.workers[0].launch.parentContextFile);
		assert.equal(f.workers[1].launch.context.parentLookup, true);
		assert.equal((await f.invoke({ op: "list" })).runs[0].workspace, workspace);
	} finally {
		await f.shutdown();
	}
});

test("fresh reviewers get no parent lookup unless explicitly requested; splice validates selected entries", async () => {
	const f = fixture();
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		f.ctx.sessionManager.getBranch = () => [
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "Project requirement", timestamp: Date.now() },
			},
		];
		const fresh = await f.invoke({ op: "launch", role: "reviewer", task: "Review" });
		assert.equal(fresh.context.parentLookup, false);
		assert.equal(f.workers[0].launch.parentContextFile, undefined);
		await assert.rejects(
			f.invoke({ op: "launch", role: "reviewer", task: "Review", context: "splice", entryIds: ["not-found"] }),
			/splice requires/,
		);
		const shared = await f.invoke({
			op: "launch",
			role: "reviewer",
			task: "Review",
			context: "splice",
			entryIds: ["user-1"],
			parentContext: true,
		});
		assert.equal(shared.context.mode, "splice");
		assert.equal(shared.context.parentLookup, true);
		assert.equal(f.workers[1].launch.context.entries[0].message.content, "Project requirement");
		assert.ok(f.workers[1].launch.parentContextFile);
	} finally {
		await f.shutdown();
	}
});
