import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkflowIntegration } from "../dist/subagents/integration.js";

function fixture(realWorker = false) {
	const root = mkdtempSync(join(tmpdir(), "jouzu-agent-integration-"));
	const paths = { configDir: join(root, "config"), stateDir: join(root, "state") };
	const workers = [];
	const messages = [];
	const entries = [];
	const notifications = [];
	let resolveMessage;
	const nextMessage = new Promise((resolve) => {
		resolveMessage = resolve;
	});
	const workerFactory = (launch, emit, exit) => {
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
	};
	const integration = createWorkflowIntegration(paths, realWorker ? undefined : workerFactory);
	const handlers = new Map();
	let tool;
	let messageRenderer;
	let command;
	let selected;
	integration.register(
		{
			on: (name, handler) => handlers.set(name, handler),
			registerMessageRenderer(name, renderer) {
				assert.equal(name, "jouzu-subagent-result");
				messageRenderer = renderer;
			},
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
			sendMessage: (message, options) => {
				messages.push({ message, options });
				resolveMessage({ message, options });
			},
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
		nextMessage,
		entries,
		notifications,
		ctx,
		get command() {
			return command;
		},
		get selected() {
			return selected;
		},
		get tool() {
			return tool;
		},
		get messageRenderer() {
			return messageRenderer;
		},
		invoke: async (params) => JSON.parse((await tool.execute("id", params)).content[0].text),
		shutdown: () => handlers.get("session_shutdown")(),
	};
}
test("explicit workspace routes child and review candidate away from the parent repository", async () => {
	const f = fixture();
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		const target = join(f.root, "target");
		mkdirSync(target);
		execFileSync("git", ["init", "-q", target]);
		execFileSync("git", [
			"-C",
			target,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"--allow-empty",
			"-qm",
			"fixture",
		]);
		const result = await f.tool.execute("id", {
			op: "launch",
			role: "reviewer",
			task: "Review target and sibling reference",
			workspace: target,
		});
		const parsed = JSON.parse(result.content[0].text);
		assert.equal(parsed.workspace, target);
		assert.equal(
			parsed.review.candidate.head,
			execFileSync("git", ["-C", target, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
		);
		assert.equal(f.workers[0].launch.cwd, target);
		assert.match(f.workers[0].launch.task, /identity covers only that workspace/);
		assert.equal(result.details.presentation.task, "Review target and sibling reference");
		assert.equal(parsed.task, undefined);
		assert.equal(typeof f.tool.renderResult, "function");
		await assert.rejects(f.invoke({ op: "resume", id: parsed.id, workspace: target }), /launch-only/);
		const childSession = join(f.workers[0].launch.directory, "session.jsonl");
		writeFileSync(childSession, "{}\n");
		f.workers[0].emit({ type: "ready", sessionFile: childSession, sessionId: "child" });
		f.workers[0].emit({ type: "result", status: "completed", text: "Scope inspected" });
		f.workers[0].exit(true);
		const resumed = await f.invoke({ op: "resume", id: parsed.id, task: "Follow up" });
		assert.equal(resumed.workspace, target);
		assert.equal(f.workers[1].launch.cwd, target);
		await assert.rejects(
			f.invoke({ op: "launch", role: "reviewer", task: "review", workspace: join(target, "missing") }),
			/does not exist/,
		);
	} finally {
		await f.shutdown();
	}
});

test("registered tool and message renderers handle persisted summaries and errors", async () => {
	const f = fixture();
	const theme = { fg: (_role, text) => text };
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		const launched = await f.tool.execute("id", { op: "launch", role: "coder", task: "Repair findings" });
		const lines = f.tool
			.renderResult(launched, { expanded: false }, theme, { args: { op: "launch" } })
			.render(80)
			.join("\n");
		assert.match(lines, /Repair findings/);
		assert.doesNotMatch(lines, /"usage"/);
		const failed = f.tool
			.renderResult({ content: [{ type: "text", text: "No such run" }] }, { expanded: false }, theme, {
				args: { op: "stop" },
				isError: true,
			})
			.render(80)
			.join("\n");
		assert.match(failed, /failed/);
		assert.doesNotMatch(failed, /cancellation requested/);
		const message = f
			.messageRenderer(
				{
					content: "legacy outcome",
					details: {
						presentation: {
							runs: [{ ...launched.details.presentation, status: "completed", outcome: "Review blocked" }],
						},
					},
				},
				{ expanded: true },
				theme,
			)
			.render(80)
			.join("\n");
		assert.match(message, /Completed/);
		assert.match(message, /Review blocked/);
		assert.doesNotMatch(message, /approved/);
	} finally {
		await f.shutdown();
	}
});

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
test("a real child's turn-limit failure reaches the parent after its context changes", { timeout: 20000 }, async () => {
	const { createServer } = await import("node:http");
	const { once } = await import("node:events");
	const f = fixture(true);
	const server = createServer(async (req, res) => {
		for await (const _chunk of req) {
		}
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const delta = {
			role: "assistant",
			tool_calls: [
				{
					index: 0,
					id: "call_read",
					type: "function",
					function: { name: "read", arguments: JSON.stringify({ path: "input.txt" }) },
				},
			],
		};
		res.write(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
		res.write(
			`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
		);
		res.end("data: [DONE]\n\n");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		writeFileSync(join(f.root, "input.txt"), "fixture input");
		const model = {
			provider: "fixture",
			id: "test",
			name: "Fixture",
			api: "openai-completions",
			baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32000,
			maxTokens: 512,
		};
		f.ctx.modelRegistry.getAvailable = () => [model];
		const snapshot = f.integration.service.roles();
		snapshot.config.roles[1] = {
			...snapshot.config.roles[1],
			model: "fixture/test",
			maxTurns: 1,
			thinking: "off",
			tools: ["read"],
		};
		f.integration.service.save(snapshot);
		await f.handlers.get("session_start")({}, f.ctx);
		const run = await f.invoke({ op: "launch", role: "coder", task: "Read input.txt repeatedly." });
		f.handlers.get("before_agent_start")({ systemPrompt: "Base" }, { ...f.ctx });
		const result = await f.nextMessage;
		assert.equal(result.message.details.runs[0].id, run.id);
		assert.equal(result.message.details.runs[0].status, "failed");
		assert.match(result.message.content, /Agent limit reached/);
		assert.equal(result.options.triggerTurn, true);
	} finally {
		await f.shutdown();
		server.closeAllConnections();
		server.close();
	}
});

test("terminal results survive fresh per-turn contexts and are delivered once", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		const run = await f.invoke({ op: "launch", role: "coder", task: "Implement a change" });
		f.handlers.get("before_agent_start")({ systemPrompt: "Base" }, { ...f.ctx });
		f.workers[0].emit({ type: "result", status: "failed", text: "Agent limit reached. Work is incomplete." });
		f.workers[0].exit(true);
		f.workers[0].exit(true);
		// The context can change again while the completion batch is waiting.
		f.handlers.get("before_agent_start")({ systemPrompt: "Base" }, { ...f.ctx });
		t.mock.timers.tick(100);
		assert.equal(f.messages.length, 1);
		assert.match(f.messages[0].message.content, /limit reached/);
		assert.equal(f.messages[0].message.details.runs[0].id, run.id);
		assert.equal(f.messages[0].message.details.runs[0].status, "failed");
		assert.equal(f.messages[0].options.triggerTurn, true);
	} finally {
		await f.shutdown();
	}
});

for (const terminal of ["completed", "crash", "timeout", "cancelled", "queued-cancelled"]) {
	test(`attributed terminal notification: ${terminal}`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const f = fixture();
		try {
			await f.handlers.get("session_start")({}, f.ctx);
			const first = await f.invoke({ op: "launch", role: "coder", task: "Implement a change" });
			const run =
				terminal === "queued-cancelled"
					? await f.invoke({ op: "launch", role: "coder", task: "Queued change" })
					: first;
			f.handlers.get("before_agent_start")({ systemPrompt: "Base" }, { ...f.ctx });
			if (terminal === "completed") {
				f.workers[0].emit({ type: "result", status: "completed", text: "Done." });
				f.workers[0].exit(true);
			} else if (terminal === "crash") {
				f.workers[0].exit(false);
			} else if (terminal === "timeout") {
				t.mock.timers.tick(f.workers[0].launch.role.timeoutSeconds * 1000);
				await Promise.resolve();
			} else {
				await f.invoke({ op: "stop", id: run.id });
			}
			t.mock.timers.tick(100);
			assert.equal(f.messages.length, 1);
			const status = terminal === "completed" ? "completed" : terminal.includes("cancelled") ? "cancelled" : "failed";
			assert.equal(f.messages[0].message.details.runs[0].id, run.id);
			assert.equal(f.messages[0].message.details.runs[0].status, status);
			assert.equal(f.messages[0].options.triggerTurn, true);
			if (terminal === "timeout") assert.match(f.messages[0].message.content, /timed out/);
		} finally {
			await f.shutdown();
		}
	});
}

test("session replacement discards old-session completion batches", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		await f.invoke({ op: "launch", role: "coder", task: "Implement a change" });
		f.workers[0].emit({ type: "result", status: "completed", text: "Old session result." });
		f.workers[0].exit(true);
		await f.handlers.get("session_start")(
			{},
			{ ...f.ctx, sessionManager: { ...f.ctx.sessionManager, getSessionId: () => "replacement" } },
		);
		t.mock.timers.tick(100);
		assert.deepEqual(f.messages, []);
	} finally {
		await f.shutdown();
	}
});

test("malformed definitions preserve session startup and cancellation notifies the main agent", async () => {
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
		assert.equal(f.messages[0].options.triggerTurn, true);
	} finally {
		await f.shutdown();
	}
});
