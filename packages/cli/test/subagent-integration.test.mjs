import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { notificationHash } from "../dist/notifications/inbox.js";
import { pathDigest } from "../dist/path-digest.js";
import { createWorkflowIntegration } from "../dist/subagents/integration.js";

function fixture(realWorker = false, options = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "jouzu-agent-integration-")));
	const paths = { agentDir: join(root, "agent"), configDir: join(root, "config"), stateDir: join(root, "state") };
	const workers = [];
	const messages = [];
	const entries = [];
	const branch = [];
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
	const integration = createWorkflowIntegration(paths, realWorker ? undefined : workerFactory, options);
	const handlers = new Map();
	const commands = new Map();
	const opened = [];
	let tool;
	let messageRenderer;
	let command;
	let commandDefinition;
	let selected;
	integration.register(
		{
			on: (name, handler) => handlers.set(name, handler),
			registerMessageRenderer(name, renderer) {
				assert.equal(name, "jouzu-subagent-result");
				messageRenderer = renderer;
			},
			registerCommand: (name, definition) => {
				commands.set(name, definition);
				command = name;
				commandDefinition = definition;
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
		sessionManager: {
			getEntries: () => [
				...branch,
				...entries.map((entry) => ({ type: "custom", customType: entry.type, data: entry.data })),
			],
			getBranch: () => branch,
			getSessionId: () => "parent",
			getLeafId: () => "entry",
		},
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
		nextMessage,
		entries,
		branch,
		notifications,
		ctx,
		get command() {
			return command;
		},
		get commandDefinition() {
			return commandDefinition;
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
test("launch captures parent context before authentication and resume keeps its snapshot", async () => {
	const f = fixture();
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		f.branch.push({
			type: "message",
			id: "u",
			parentId: null,
			message: { role: "user", content: "ORIGINAL_REQUIREMENT" },
		});
		const started = await f.invoke({
			op: "launch",
			role: "coder",
			task: "Inspect",
			context: "splice",
			entryIds: ["u"],
			parentContext: true,
		});
		assert.equal(started.context.mode, "splice");
		const worker = f.workers[0];
		assert.match(readFileSync(worker.launch.parentContextFile, "utf8"), /ORIGINAL_REQUIREMENT/);
		f.branch[0].message.content = "LATER_REQUIREMENT";
		assert.doesNotMatch(readFileSync(worker.launch.parentContextFile, "utf8"), /LATER_REQUIREMENT/);
		const childFile = join(worker.launch.directory, "session.jsonl");
		writeFileSync(childFile, "{}\n");
		worker.emit({ type: "ready", sessionFile: childFile, sessionId: "child" });
		worker.emit({ type: "result", status: "completed", text: "Done" });
		worker.exit(true);
		await assert.rejects(f.invoke({ op: "resume", id: started.id, task: "Continue", context: "fork" }), /launch-only/);
		await f.invoke({ op: "resume", id: started.id, task: "Continue" });
		assert.equal(f.workers[1].launch.parentContextFile, worker.launch.parentContextFile);
		assert.deepEqual(f.workers[1].launch.context.entries, []);
		let authCalls = 0;
		f.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
			authCalls++;
			return { ok: true, apiKey: "secret" };
		};
		await assert.rejects(
			f.invoke({ op: "launch", role: "coder", task: "Inspect", context: "splice", entryIds: ["missing"] }),
			/Context:/,
		);
		assert.equal(authCalls, 0);
	} finally {
		await f.shutdown();
	}
});

test("dashboard command routes to Runs, hides without stopping, and clears across sessions", async () => {
	const f = fixture();
	const widgets = [];
	let component;
	f.ctx.ui.setWidget = (_key, factory) => {
		widgets.push(factory);
		component = factory?.({ requestRender() {}, terminal: { rows: 32 } }, { fg: (_role, text) => text });
	};
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		const command = f.commands.get("subagents");
		assert.deepEqual(command.getArgumentCompletions("h"), [{ value: "hide", label: "hide" }]);
		await command.handler("", f.ctx);
		assert.deepEqual(f.opened, ["runs"]);
		const run = await f.invoke({ op: "launch", role: "coder", task: "Inspect" });
		assert.ok(component);
		await command.handler("hide", f.ctx);
		assert.equal(component, undefined);
		assert.equal(f.integration.service.runs()[0].status, "starting");
		await command.handler("show", f.ctx);
		assert.ok(component);
		await command.handler("invalid", f.ctx);
		assert.match(f.notifications.at(-1)[0], /Use \/subagents/);
		await command.handler("", { ...f.ctx, mode: "rpc" });
		assert.equal(JSON.parse(f.notifications.at(-1)[0]).runs[0].id, run.id);
		const output = [];
		const log = console.log;
		try {
			console.log = (text) => output.push(text);
			await command.handler("", { ...f.ctx, mode: "print" });
		} finally {
			console.log = log;
		}
		assert.equal(JSON.parse(output[0]).runs[0].id, run.id);
		await f.handlers.get("session_start")({}, f.ctx);
		assert.ok(widgets.includes(undefined), "session replacement removes the old widget");
	} finally {
		await f.shutdown();
		assert.equal(component, undefined);
	}
});

test("trace reads parent and child sessions without acknowledging completion", async () => {
	const f = fixture();
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		const parentFile = join(f.root, "parent.jsonl");
		const content = `${JSON.stringify({ type: "message", id: "e", message: { role: "user", content: "Evidence" } })}\n`;
		writeFileSync(parentFile, content);
		f.ctx.sessionManager.getSessionFile = () => parentFile;
		assert.equal((await f.invoke({ op: "trace" })).records[0].text, "Evidence");
		const run = await f.invoke({ op: "launch", role: "coder", task: "Inspect" });
		assert.equal((await f.invoke({ op: "trace", id: run.id })).totalBytes, 0);
		const childFile = join(f.workers[0].launch.directory, "session.jsonl");
		writeFileSync(childFile, content);
		f.workers[0].emit({ type: "ready", sessionFile: childFile, sessionId: "child" });
		f.workers[0].emit({ type: "result", status: "completed", text: "Done" });
		f.workers[0].exit(true);
		const result = await f.tool.execute("trace", { op: "trace", id: run.id, entryId: "e" });
		assert.equal(JSON.parse(result.content[0].text).records[0].entryId, "e");
		assert.equal(result.details.terminalRead, undefined);
		assert.equal(f.integration.service.runs()[0].completion.handled, false);
		assert.equal(readFileSync(childFile, "utf8"), content);
		await f.integration.service.setSubagentsEnabled(false);
		assert.equal((await f.invoke({ op: "trace", id: run.id })).records.length, 1);
		await assert.rejects(f.invoke({ op: "trace", id: "unknown" }), /not found/);
	} finally {
		await f.shutdown();
	}
});

test("child launches and resumes snapshot the global warming setting", async () => {
	const f = fixture();
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		mkdirSync(f.paths.agentDir, { recursive: true });
		writeFileSync(join(f.paths.agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off" }));
		const run = await f.invoke({ op: "launch", role: "coder", task: "Inspect" });
		assert.equal(f.workers[0].launch.cacheWarming, "off");
		const childSession = join(f.workers[0].launch.directory, "session.jsonl");
		writeFileSync(childSession, "{}\n");
		f.workers[0].emit({ type: "ready", sessionFile: childSession, sessionId: "child" });
		f.workers[0].emit({ type: "result", status: "completed", text: "Done" });
		f.workers[0].exit(true);
		writeFileSync(join(f.paths.agentDir, "settings.json"), JSON.stringify({ cacheWarming: "idle" }));
		await f.invoke({ op: "resume", id: run.id, task: "Continue" });
		assert.equal(f.workers[1].launch.cacheWarming, "idle");
		assert.equal(f.workers[0].launch.cacheWarming, "off", "existing runs keep their launch snapshot");
	} finally {
		await f.shutdown();
	}
});

test("unreadable warming settings refuse launch instead of enabling refreshes", async () => {
	const f = fixture();
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		mkdirSync(f.paths.agentDir, { recursive: true });
		writeFileSync(join(f.paths.agentDir, "settings.json"), "broken");
		await assert.rejects(f.invoke({ op: "launch", role: "coder", task: "Inspect" }), /cache-warming settings/);
		assert.equal(f.workers.length, 0);
	} finally {
		await f.shutdown();
	}
});

test("role and run displays use catalog names without changing selectors or read content", async () => {
	const f = fixture();
	await f.handlers.get("session_start")({}, f.ctx);
	try {
		const provider = "catalog:office:local:8f5c5bb9e126e978";
		f.ctx.modelRegistry.getAvailable = () => [
			{ provider, id: "glm-5.3-flash", name: "Friendly Flash", api: "openai-completions" },
		];
		const roles = await f.invoke({ op: "roles" });
		assert.equal(roles.roles[1].model, "glm-5.3-flash");
		assert.equal(roles.roles[1].modelLabel, "Friendly Flash");
		const run = await f.invoke({ op: "launch", role: "coder", task: "Inspect" });
		assert.equal(run.model.provider, provider);
		assert.equal(run.model.name, "Friendly Flash");
		f.workers[0].emit({ type: "activity", tool: "read" });
		const result = await f.tool.execute("read", { op: "read", id: run.id });
		const original = result.content[0].text;
		const lines = f.tool
			.renderResult(result, { expanded: false }, { fg: (_role, value) => value }, { args: { op: "read" } })
			.render(80);
		assert.match(lines.join("\n"), /read × 1/);
		assert.doesNotMatch(lines.join("\n"), /\{"/);
		assert.equal(result.content[0].text, original);
		assert.match(JSON.parse(original).text, /"type":"activity"/);
	} finally {
		await f.shutdown();
	}
});

test("optional workspace placeholders do not block discovery or launch defaults", async () => {
	const f = fixture();
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		for (const extra of [{ workspace: "" }, { workspace: " \t" }, { workspace: "/unused" }]) {
			const result = await f.invoke({ op: "roles", ...extra });
			assert.equal(result.enabled, true);
			assert.equal(result.roles.length, 3);
		}
		const run = await f.invoke({ op: "launch", role: "reviewer", task: "Inspect", workspace: "" });
		assert.equal(run.workspace, f.root);
		assert.equal(run.model.id, "gpt-6-astra");
		const childSession = join(f.workers[0].launch.directory, "session.jsonl");
		writeFileSync(childSession, "{}\n");
		f.workers[0].emit({ type: "ready", sessionFile: childSession, sessionId: "child" });
		f.workers[0].emit({ type: "result", status: "completed", text: "Done" });
		f.workers[0].exit(true);
		const resumed = await f.invoke({ op: "resume", id: run.id, task: "Continue", workspace: "" });
		assert.equal(resumed.workspace, run.workspace);
		assert.deepEqual(resumed.model, run.model);
	} finally {
		await f.shutdown();
	}
});

test("delegation checklist reaches every parent model without requiring a skill", async () => {
	const f = fixture();
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		for (const id of ["gpt-6-astra", "glm-5.3-flash", "other-model"]) {
			const active = { ...f.ctx, model: { provider: "fixture", id } };
			const prompt = f.handlers.get("before_agent_start")({ systemPrompt: "Base" }, active).systemPrompt;
			assert.match(prompt, /complete sentences with normal spacing/);
			assert.match(prompt, /one objective, verified context and file paths, constraints, acceptance checks/);
			assert.match(prompt, /explicit stopping point and report/);
			assert.match(prompt, /state what changed and what remains authorized/);
			assert.match(prompt, /Diagnose provider, tool, and instruction failures/);
			assert.match(f.tool.parameters.properties.task.description, /stopping point\/report/);
		}
		await f.integration.service.setSubagentsEnabled(false);
		const prompt = f.handlers.get("before_agent_start")({ systemPrompt: "Base" }, f.ctx).systemPrompt;
		assert.doesNotMatch(prompt, /Write each assignment/);
		assert.match(prompt, /Work directly/);
	} finally {
		await f.shutdown();
	}
});

test("session toggle stops children and queued work, reports live availability and restores on reload", async () => {
	const f = fixture();
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		const a = await f.invoke({ op: "launch", role: "coder", task: "First" });
		await f.invoke({ op: "launch", role: "coder", task: "Queued" });
		assert.equal(f.workers.length, 1);
		await f.integration.service.setSubagentsEnabled(false);
		assert.equal(f.workers.length, 1, "disabling never starts queued work");
		assert.ok(f.integration.service.runs().every((run) => run.status === "cancelled"));
		for (const op of ["launch", "resume", "steer"]) {
			await assert.rejects(f.invoke({ op, role: "coder", id: a.id, task: "Do work" }), /Subagents are off/);
		}
		await assert.rejects(f.integration.service.launch("coder", "Direct service"), /Subagents are off/);
		await assert.rejects(f.integration.service.resume(a.id, "Direct service"), /Subagents are off/);
		assert.throws(() => f.integration.service.steer(a.id, "Direct service"), /Subagents are off/);
		const roles = await f.invoke({ op: "roles" });
		assert.equal(roles.enabled, false);
		assert.match(roles.reason, /disabled by the user/);
		assert.equal((await f.invoke({ op: "list" })).runs.length, 2);
		assert.ok((await f.invoke({ op: "read", id: a.id })).text);
		await f.invoke({ op: "stop", id: a.id });
		assert.match(f.handlers.get("before_agent_start")({ systemPrompt: "Base" }, f.ctx).systemPrompt, /Work directly/);
		await f.handlers.get("session_start")({}, f.ctx);
		assert.equal(f.integration.service.subagentsEnabled(), false);
		await f.commandDefinition.handler("on", f.ctx);
		assert.equal(f.integration.service.subagentsEnabled(), true);
		assert.match(f.handlers.get("before_agent_start")({ systemPrompt: "Base" }, f.ctx).systemPrompt, /op:roles/);
		const snapshot = f.integration.service.roles();
		snapshot.config.roles = snapshot.config.roles.filter((role) => role.id !== "reviewer");
		f.integration.service.save(snapshot);
		assert.equal((await f.invoke({ op: "roles" })).roles.length, 2);
		await assert.rejects(f.invoke({ op: "launch", role: "reviewer", task: "Inspect" }), /not found/);
		await f.invoke({ op: "launch", role: "coder", task: "Allowed again" });
		await f.commandDefinition.handler("toggle", f.ctx);
		assert.equal(f.integration.service.subagentsEnabled(), false);
		await f.commandDefinition.handler("bad", f.ctx);
		assert.equal(f.notifications.at(-1)[1], "error");
		f.branch.length = 0;
		f.entries.length = 0;
		await f.handlers.get("session_start")(
			{},
			{ ...f.ctx, sessionManager: { ...f.ctx.sessionManager, getSessionId: () => "new-parent" } },
		);
		assert.equal(f.integration.service.subagentsEnabled(), true, "new sessions default to enabled");
	} finally {
		await f.shutdown();
	}
});

test("failed child shutdown remains visible and retryable while subagents stay disabled", async () => {
	const f = fixture();
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		await f.invoke({ op: "launch", role: "coder", task: "First" });
		const worker = f.workers[0];
		const stop = worker.stop;
		worker.stop = async () => {
			throw new Error("stop failed");
		};
		await assert.rejects(f.integration.service.setSubagentsEnabled(false), /could not be stopped/);
		assert.equal(f.integration.service.subagentsEnabled(), false);
		assert.equal(f.integration.service.runs()[0].status, "starting");
		worker.stop = stop;
		await f.integration.service.setSubagentsEnabled(false);
		assert.equal(f.integration.service.runs()[0].status, "cancelled");
	} finally {
		await f.shutdown();
	}
});

test("disabling while authentication is pending prevents late dispatch even after re-enabling", async () => {
	const f = fixture();
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		let finish;
		f.ctx.modelRegistry.getApiKeyAndHeaders = () =>
			new Promise((resolve) => {
				finish = resolve;
			});
		const launching = f.invoke({ op: "launch", role: "coder", task: "Late dispatch" });
		await f.integration.service.setSubagentsEnabled(false);
		await f.integration.service.setSubagentsEnabled(true);
		finish({ ok: true, apiKey: "secret" });
		await assert.rejects(launching, /setting changed/);
		assert.equal(f.workers.length, 0);
	} finally {
		await f.shutdown();
	}
});

test("agent calls cannot override configured models, including through stale tool arguments", async () => {
	const f = fixture();
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		f.ctx.model = { id: "gpt-6-astra", provider: "fixture", name: "Astra", api: "openai-completions" };
		assert.equal(f.tool.parameters.properties.model, undefined);
		assert.equal(f.tool.parameters.additionalProperties, false);
		let authentications = 0;
		f.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
			authentications++;
			return { ok: true, apiKey: "secret" };
		};
		for (const op of f.tool.parameters.properties.op.enum) {
			for (const model of ["same", "fixture/gpt-6-astra", "glm-5.3-flash", "", " \n", null, 42]) {
				await assert.rejects(
					f.invoke({ op, role: "coder", id: "unused", task: "Inspect", model }),
					/Only the user can change subagent models in Workflow/,
				);
			}
		}
		assert.equal(authentications, 0);
		assert.equal(f.workers.length, 0);
		assert.equal(f.integration.service.runs().length, 0);
		const run = await f.invoke({ op: "launch", role: "coder", task: "Inspect" });
		assert.equal(run.model.id, "glm-5.3-flash", "launch uses the configured role, not the parent model");
		assert.equal(authentications, 1);
		const prompt = f.handlers.get("before_agent_start")({ systemPrompt: "Base" }, f.ctx).systemPrompt;
		assert.match(prompt, /Only the user can change role models/);
	} finally {
		await f.shutdown();
	}
});

test("user-saved role models affect new launches while resumes retain the saved model", async () => {
	const f = fixture();
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		const run = await f.invoke({ op: "launch", role: "coder", task: "First" });
		const childSession = join(f.workers[0].launch.directory, "session.jsonl");
		writeFileSync(childSession, "{}\n");
		f.workers[0].emit({ type: "ready", sessionFile: childSession, sessionId: "child" });
		f.workers[0].emit({ type: "result", status: "completed", text: "Done" });
		f.workers[0].exit(true);
		const snapshot = f.integration.service.roles();
		snapshot.config.roles.find((role) => role.id === "coder").model = "fixture/gpt-6-astra";
		f.integration.service.save(snapshot);
		const resumed = await f.invoke({ op: "resume", id: run.id, task: "Continue" });
		assert.equal(resumed.model.id, "glm-5.3-flash");
		await f.invoke({ op: "stop", id: resumed.id });
		const fresh = await f.invoke({ op: "launch", role: "coder", task: "New assignment" });
		assert.equal(fresh.model.id, "gpt-6-astra");
	} finally {
		await f.shutdown();
	}
});

test("same resolves against the session model only when saved in the role", async () => {
	const f = fixture();
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		const snapshot = f.integration.service.roles();
		snapshot.config.roles.find((role) => role.id === "reviewer").model = "same";
		f.integration.service.save(snapshot);
		await assert.rejects(f.invoke({ op: "launch", role: "reviewer", task: "Review" }), /no model selected/);
		f.ctx.model = { id: "gpt-6-astra", provider: "fixture", name: "Astra", api: "openai-completions" };
		const run = await f.invoke({ op: "launch", role: "reviewer", task: "Review" });
		assert.equal(run.model.id, "gpt-6-astra");
	} finally {
		await f.shutdown();
	}
});

test("explicit workspace and file scanning carry into child launch and resume", async () => {
	const f = fixture(false, { textguardFiles: true });
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
		assert.equal(f.workers[0].launch.textguardFiles, true);
		assert.match(f.workers[0].launch.task, /identity covers only that workspace/);
		assert.equal(result.details.presentation.task, "Review target and sibling reference");
		assert.equal(parsed.task, undefined);
		assert.equal(typeof f.tool.renderResult, "function");
		await assert.rejects(
			f.invoke({ op: "resume", id: parsed.id, workspace: f.root }),
			/Resume keeps the original workspace/,
		);
		await assert.rejects(
			f.invoke({ op: "resume", id: parsed.id, model: "glm-5.3-flash" }),
			/Only the user can change subagent models in Workflow/,
		);
		const childSession = join(f.workers[0].launch.directory, "session.jsonl");
		writeFileSync(childSession, "{}\n");
		f.workers[0].emit({ type: "ready", sessionFile: childSession, sessionId: "child" });
		f.workers[0].emit({ type: "result", status: "completed", text: "Scope inspected" });
		f.workers[0].exit(true);
		const resumed = await f.invoke({
			op: "resume",
			id: parsed.id,
			task: "Follow up",
			workspace: target,
		});
		assert.equal(resumed.workspace, target);
		assert.equal(f.workers[1].launch.cwd, target);
		assert.equal(f.workers[1].launch.textguardFiles, true);
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
		assert.equal(roles.enabled, true);
		assert.equal(roles.roles.length, 3);
		assert.equal(roles.roles[0].instructions, undefined);
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

test("terminal reads withdraw pending results only after complete model-visible coverage", async () => {
	const f = fixture();
	f.ctx.isIdle = () => false;
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		const run = await f.invoke({ op: "launch", role: "coder", task: "Read terminal output" });
		f.workers[0].emit({ type: "result", status: "completed", text: "Output ".repeat(4000) });
		f.workers[0].exit(true);
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(f.messages.length, 0, "completion stays outside the Pi queue while busy");
		let offset = 0;
		while (offset !== null) {
			const result = await f.tool.execute("read", { op: "read", id: run.id, offset });
			const toolCallId = `read-${offset}`;
			f.branch.push({ type: "message", message: { role: "toolResult", toolCallId, toolName: "subagent", ...result } });
			await f.handlers.get("turn_end")({}, f.ctx);
			assert.equal(f.integration.service.runs()[0].completion.handled, false, "history alone is not observation");
			f.branch.push({
				type: "custom",
				customType: "jouzu-subagent-read-receipt",
				data: {
					toolCallId,
					contentHash: notificationHash(result.content),
					markerHash: notificationHash(result.details.terminalRead),
				},
			});
			offset = JSON.parse(result.content[0].text).nextOffset;
			await f.handlers.get("turn_end")({}, f.ctx);
			assert.equal(f.integration.service.runs()[0].completion.handled, offset === null);
		}
		f.ctx.isIdle = () => true;
		f.handlers.get("agent_settled")({}, f.ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(f.messages.length, 0);
	} finally {
		await f.shutdown();
	}
});

for (const altered of ["error", "redacted", "list", "ui"]) {
	test(`${altered} reads do not withdraw a completion`, async () => {
		const f = fixture();
		f.ctx.isIdle = () => false;
		try {
			await f.handlers.get("session_start")({}, f.ctx);
			const run = await f.invoke({ op: "launch", role: "coder", task: "Unread completion" });
			f.workers[0].emit({ type: "result", status: "completed", text: "Done" });
			f.workers[0].exit(true);
			const result = await f.tool.execute("read", { op: altered === "list" ? "list" : "read", id: run.id });
			if (altered === "error") result.isError = true;
			if (altered === "redacted") result.content = [{ type: "text", text: "Content removed" }];
			if (altered !== "ui")
				f.branch.push({ type: "message", message: { role: "toolResult", toolName: "subagent", ...result } });
			f.ctx.isIdle = () => true;
			f.handlers.get("agent_settled")({}, f.ctx);
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(f.messages.length, 1);
		} finally {
			await f.shutdown();
		}
	});
}

test("delivered membership survives manager restart and no-reply permission is current-run only", async () => {
	const f = fixture();
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		await f.invoke({ op: "launch", role: "coder", task: "Recover receipt" });
		f.workers[0].emit({ type: "result", status: "completed", text: "Done" });
		f.workers[0].exit(true);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const message = f.messages[0].message;
		const batchId = message.details.inbox.batchId;
		f.handlers.get("agent_start")();
		f.handlers.get("message_start")({ message: { role: "custom", ...message } }, f.ctx);
		f.branch.push({ type: "custom_message", ...message });
		const result = await f.tool.execute("ack", { op: "acknowledge", batchId });
		assert.equal(result.terminate, true);
		await assert.rejects(f.tool.execute("ack", { op: "acknowledge", batchId }));
		// Restart before turn_end reconciles the receipt: membership is in run.json.
		await f.handlers.get("session_start")({}, f.ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(f.messages.length, 1);
		assert.equal(f.integration.service.runs()[0].completion.handled, true);
		await assert.rejects(f.tool.execute("ack", { op: "acknowledge", batchId }));
	} finally {
		await f.shutdown();
	}
});

test("queued user messages take priority over unread child completions", async () => {
	const f = fixture();
	f.ctx.hasPendingMessages = () => true;
	try {
		await f.handlers.get("session_start")({}, f.ctx);
		await f.invoke({ op: "launch", role: "coder", task: "Wait behind user" });
		f.workers[0].exit(false);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(f.messages.length, 0);
		f.ctx.hasPendingMessages = () => false;
		f.handlers.get("agent_settled")({}, f.ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(f.messages.length, 1);
	} finally {
		await f.shutdown();
	}
});

for (const legacy of [false, true]) {
	test(`${legacy ? "legacy terminal" : "unreceived terminal"} records restore without duplicate historical notifications`, async () => {
		const f = fixture();
		f.ctx.isIdle = () => false;
		try {
			await f.handlers.get("session_start")({}, f.ctx);
			const run = await f.invoke({ op: "launch", role: "coder", task: "Restart pending result" });
			f.workers[0].emit({ type: "result", status: "completed", text: "Retained result" });
			f.workers[0].exit(true);
			await f.shutdown();
			if (legacy) {
				const file = join(f.paths.stateDir, "subagents", pathDigest("parent"), run.id, "run.json");
				const saved = JSON.parse(readFileSync(file, "utf8"));
				delete saved.completion;
				writeFileSync(file, JSON.stringify(saved));
			}
			f.ctx.isIdle = () => true;
			await f.handlers.get("session_start")({}, f.ctx);
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(f.messages.length, legacy ? 0 : 1);
			assert.equal(f.integration.service.runs()[0].result, "Retained result");
		} finally {
			await f.shutdown();
		}
	});
}

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
