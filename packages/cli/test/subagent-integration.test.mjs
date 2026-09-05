import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkflowIntegration } from "../dist/subagents/integration.js";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "jouzu-agent-integration-"));
	const paths = { configDir: join(root, "config"), stateDir: join(root, "state") };
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
	let tool;
	let command;
	let selected;
	integration.register(
		{
			on: (name, handler) => handlers.set(name, handler),
			registerCommand: (name) => {
				command = name;
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
		async () => true,
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
		assert.ok(f.messages[0].message.content.length < 4300);
		const runs = await f.invoke({ op: "list" });
		assert.equal(runs.runs.length, 2);
		assert.equal(runs.runs[0].result, undefined);
		assert.equal((await f.invoke({ op: "read", id: b.id })).nextOffset !== null, true);
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
