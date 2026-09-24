import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { captureChildContext, inheritedContextText } from "../dist/subagents/context.js";
import { SubagentManager } from "../dist/subagents/manager.js";
import { defaultAgentConfig } from "../dist/subagents/roles.js";

const entry = (id, text, parentId = null) => ({
	type: "message",
	id,
	parentId,
	timestamp: new Date().toISOString(),
	message: { role: "user", content: text, timestamp: Date.now() },
});

test("context inheritance is explicit reference material, strips thinking/state, and bounds injected text", () => {
	const branch = [
		entry("u", "Requirement"),
		{
			...entry("a", []),
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "PRIVATE_THINKING" },
					{ type: "image", data: "BINARY_IMAGE" },
					{
						type: "toolCall",
						name: "bash",
						id: "call",
						arguments: {
							command: "echo evidence",
							content: ["ARGUMENT_CONTENT"],
							details: { name: "ARGUMENT_DETAILS" },
						},
					},
				],
			},
		},
		{ type: "custom", customType: "task-state", data: "PARENT_TASKS", id: "state" },
	];
	const fresh = captureChildContext({}, false, "parent", branch, "a");
	assert.equal(inheritedContextText(fresh), undefined);
	const fork = captureChildContext({ context: "fork" }, false, "parent", branch, "a");
	const text = inheritedContextText(fork);
	assert.match(text, /Reference context.*parent/);
	assert.match(text, /echo evidence/);
	assert.match(text, /ARGUMENT_CONTENT/);
	assert.match(text, /ARGUMENT_DETAILS/);
	assert.doesNotMatch(JSON.stringify(fork), /PRIVATE_THINKING|BINARY_IMAGE|PARENT_TASKS/);
	const splice = captureChildContext({ context: "splice", entryIds: ["u"] }, false, "parent", branch, "a");
	assert.match(inheritedContextText(splice), /Requirement/);
	assert.doesNotMatch(inheritedContextText(splice), /echo evidence/);
	assert.throws(() => captureChildContext({ context: "fresh", entryIds: ["u"] }, false, "p", branch), /only valid/);
	const large = captureChildContext(
		{ context: "fork" },
		false,
		"p",
		Array.from({ length: 100 }, (_, index) => entry(String(index), "日".repeat(10000))),
	);
	assert.ok(inheritedContextText(large).length < 65000);
	assert.match(inheritedContextText(large), /truncated/);
});

function respond(res, delta, finish = "tool_calls") {
	res.writeHead(200, { "Content-Type": "text/event-stream" });
	res.write(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
	res.write(
		`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\n`,
	);
	res.end("data: [DONE]\n\n");
}

test("real children can read outside cwd, use skills/recall/web/tasks, consult parent context, and retain local tasks on resume", {
	timeout: 60000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-child-capabilities-"));
	const workspace = join(root, "workspace");
	mkdirSync(workspace);
	writeFileSync(join(root, "reference.txt"), "EXTERNAL_REFERENCE_EVIDENCE");
	writeFileSync(join(workspace, "AGENTS.md"), "PROJECT_GUIDANCE_EVIDENCE");
	mkdirSync(join(workspace, ".pi"));
	writeFileSync(
		join(workspace, ".pi", "tasks-config.json"),
		JSON.stringify({ taskScope: "project", autoMode: "cascade" }),
	);
	writeFileSync(join(workspace, ".pi", "tasks.json"), "PARENT_TASK_FILE_UNCHANGED");
	const requests = [];
	const steps = [];
	const server = createServer(async (req, res) => {
		if (req.url === "/page") {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(
				"<html><body><article><h1>Local evidence</h1><p>WEB_FIXTURE_EVIDENCE from a deterministic local source.</p></article></body></html>",
			);
			return;
		}
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		requests.push(body);
		const step = steps.shift();
		if (!step) {
			respond(res, { role: "assistant", content: "DONE" }, "stop");
			return;
		}
		const [name, suppliedArgs] = step;
		let args = suppliedArgs;
		if (name === "agent_wait" && suppliedArgs === "background") {
			const result = [...body.messages]
				.reverse()
				.find(
					(message) =>
						message.role === "tool" &&
						typeof message.content === "string" &&
						message.content.includes("Wait dependency: "),
				);
			const dependency = JSON.parse(result.content.split("Wait dependency: ")[1].split("\n")[0]);
			args = { on: [dependency], mode: "all", deadline: "10s", reason: "Wait for the child fixture execution." };
		}
		if (name === "reply") {
			respond(res, { role: "assistant", content: args }, "stop");
			return;
		}
		respond(res, {
			role: "assistant",
			tool_calls: [
				{
					index: 0,
					id: `call_${requests.length}`,
					type: "function",
					function: { name, arguments: JSON.stringify(args) },
				},
			],
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const model = {
		id: "test",
		provider: "fixture",
		name: "Fixture",
		api: "openai-completions",
		baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 512,
	};
	let complete;
	const manager = new SubagentManager(
		{ configDir: join(root, "config"), stateDir: join(root, "state") },
		"parent",
		2,
		undefined,
		(run) => complete(run),
	);
	const role = { ...defaultAgentConfig().roles[1], thinking: "off", timeoutSeconds: 10 };
	const launch = {
		role,
		model,
		auth: { apiKey: "fixture-key" },
		cwd: workspace,
		task: "Use the assigned tools and report DONE.",
		context: captureChildContext({}, false, "parent", [entry("requirement", "PARENT_PROJECT_DECISION")], "requirement"),
	};
	try {
		steps.push(
			["read", { path: join(root, "reference.txt") }],
			["TaskCreate", { subject: "Child work", description: "Keep this task for resume" }],
			["TaskUpdate", { taskId: "1", status: "in_progress" }],
			["TaskList", {}],
			["parent_context", { query: "PARENT_PROJECT_DECISION" }],
			["vcc_recall", { query: "EXTERNAL_REFERENCE_EVIDENCE" }],
			["web_fetch", { url: `http://127.0.0.1:${server.address().port}/page`, format: "text", timeoutMs: 5000 }],
		);
		const done = new Promise((resolve) => {
			complete = resolve;
		});
		const started = manager.launch(launch);
		steps.splice(1, 0, [
			"read",
			{ path: join(dirname(started.parentContextFile), "skills", "jouzu-clear-writing", "SKILL.md") },
		]);
		const run = await done;
		assert.equal(run.status, "completed", manager.read(started.id).text);
		assert.equal(run.result, "DONE");
		const allTools = requests[0].tools.map((tool) => tool.function.name);
		for (const name of ["vcc_recall", "compact_context", "TaskCreate", "web_fetch", "tff-search_web", "parent_context"])
			assert.ok(allTools.includes(name), `${name}: ${JSON.stringify(allTools)}`);
		assert.ok(allTools.includes("TaskExecute"));
		assert.ok(allTools.includes("bg_task"));
		assert.ok(!allTools.includes("schedule_prompt"));
		assert.ok(!allTools.includes("subagent"));
		assert.ok(allTools.includes("multiloop_start"));
		assert.ok(allTools.includes("agent_wait"));
		const prompt = JSON.stringify(requests[0].messages);
		assert.match(prompt, /PROJECT_GUIDANCE_EVIDENCE/);
		assert.match(prompt, /jouzu-clear-writing/);
		assert.match(prompt, /Jouzu capability routing/);
		const saved = readFileSync(run.sessionFile, "utf8").trim().split("\n").map(JSON.parse);
		const results = saved
			.filter((item) => item.type === "message" && item.message.role === "toolResult")
			.map((item) => item.message);
		for (const result of results) assert.equal(result.isError, false, JSON.stringify(result));
		assert.match(JSON.stringify(results.find((result) => result.toolName === "read")), /EXTERNAL_REFERENCE_EVIDENCE/);
		assert.match(
			JSON.stringify(results.find((result) => result.toolName === "parent_context")),
			/PARENT_PROJECT_DECISION/,
		);
		assert.match(
			JSON.stringify(results.find((result) => result.toolName === "vcc_recall")),
			/EXTERNAL_REFERENCE_EVIDENCE/,
		);
		// The bundled web tool deliberately blocks private addresses. Exercise its real validation without external network access.
		assert.match(JSON.stringify(results.find((result) => result.toolName === "web_fetch")), /blocked_ssrf/);
		assert.equal(readFileSync(join(workspace, ".pi", "tasks.json"), "utf8"), "PARENT_TASK_FILE_UNCHANGED");
		assert.equal(requests.length, 9, "project task auto-mode must not start extra work");
		assert.ok(
			results.some(
				(result) => result.toolName === "read" && JSON.stringify(result.content).includes("Clear Technical Writing"),
			),
		);
		const schedulePath = join(dirname(run.sessionFile), ".pi", "schedule-prompts.json");
		mkdirSync(dirname(schedulePath), { recursive: true });
		writeFileSync(
			schedulePath,
			JSON.stringify({
				version: 1,
				jobs: [
					{
						id: "legacy",
						name: "legacy",
						type: "interval",
						schedule: "1s",
						prompt: "LEGACY_CHILD_SCHEDULE",
						enabled: true,
						createdAt: "2026-01-01T00:00:00Z",
						runCount: 0,
					},
				],
			}),
		);
		const continuation = new Promise((resolve) => {
			complete = resolve;
		});
		steps.push(["TaskList", {}]);
		manager.launch(
			{ ...launch, context: undefined, task: "List your saved tasks and report DONE." },
			undefined,
			run.id,
		);
		const resumed = await continuation;
		assert.equal(resumed.status, "completed", resumed.result);
		assert.equal(resumed.childSessionId, run.childSessionId);
		assert.equal(JSON.parse(readFileSync(schedulePath, "utf8")).jobs[0].enabled, false);
		assert.match(resumed.result, /1 pending child schedule cancelled/);
		assert.equal(resumed.cancelledSchedules, 1);
		assert.equal(requests.length, 11, "resume must not run a saved child schedule");
		assert.match(
			JSON.stringify(
				requests
					.at(-1)
					.messages.filter((message) => message.role === "tool")
					.at(-1),
			),
			/Child work/,
		);
		assert.match(
			JSON.stringify(
				requests
					.at(-1)
					.messages.filter((message) => message.role === "tool")
					.at(-1),
			),
			/in_progress/,
		);
		writeFileSync(schedulePath, "{invalid");
		const recovery = new Promise((resolve) => {
			complete = resolve;
		});
		steps.push(["reply", "RECOVERED"]);
		manager.launch({ ...launch, context: undefined, task: "Report recovery." }, undefined, resumed.id);
		const recovered = await recovery;
		assert.equal(recovered.status, "completed", recovered.result);
		assert.match(recovered.result, /Saved child schedules could not be read/);
		assert.match(recovered.result, /RECOVERED/);
		assert.match(recovered.scheduleWarning, /Preserved at .*\.invalid-/);
		for (const [label, automation] of [
			[
				"task execution",
				[
					["TaskCreate", { subject: "Scheduled child work", description: "Finish after the first response" }],
					["TaskExecute", { task_ids: ["1"] }],
					["reply", "TASK_QUEUED"],
					["TaskUpdate", { taskId: "1", status: "completed" }],
					["reply", "AUTOMATION_DONE"],
				],
			],
			[
				"background completion",
				[
					[
						"bg_task",
						{
							action: "spawn",
							command: "node -e 'setTimeout(() => console.log(42), 400)'",
							notifyOnExit: true,
							timeoutSeconds: 5,
						},
					],
					["reply", "BACKGROUND_PENDING"],
					["reply", "AUTOMATION_DONE"],
				],
			],
			[
				"quiet background completion",
				[
					[
						"bg_task",
						{
							action: "spawn",
							command: "node -e 'setTimeout(() => console.log(42), 400)'",
							notifyOnExit: false,
							timeoutSeconds: 5,
						},
					],
					["reply", "AUTOMATION_DONE"],
				],
			],
			[
				"multiloop gate recovery",
				[
					[
						"multiloop_start",
						{
							lane: "child-fixture",
							runTag: "gate",
							mode: "research",
							goal: "Wait for the job and then stop the lane.",
						},
					],
					[
						"bg_task",
						{
							action: "spawn",
							command: "node -e 'setTimeout(() => console.log(42), 400)'",
							notifyOnExit: false,
							timeoutSeconds: 5,
						},
					],
					["agent_wait", "background"],
					["reply", "LOOP_WAITING"],
					["multiloop_stop", { target: "child-fixture/gate" }],
					["reply", "AUTOMATION_DONE"],
				],
			],
			[
				"rejected child scheduling",
				[
					[
						"schedule_prompt",
						{ action: "add", type: "once", schedule: "+1d", model: "fixture/test", prompt: "Launch another agent." },
					],
					["subagent", { op: "launch", role: "coder", task: "Recursive work" }],
					["reply", "AUTOMATION_DONE"],
				],
			],
		]) {
			steps.push(...automation);
			const finished = new Promise((resolve) => {
				complete = resolve;
			});
			const automated = manager.launch({
				...launch,
				context: undefined,
				task: `Exercise ${label} and finish the admitted follow-up.`,
			});
			const terminal = await finished;
			assert.equal(terminal.status, "completed", manager.read(automated.id).text);
			assert.equal(
				terminal.result,
				"AUTOMATION_DONE",
				`${label} must drain before reporting completion: ${manager.read(automated.id).text}`,
			);
			assert.equal(steps.length, 0, label);
			if (label === "multiloop gate recovery") {
				const messages = readFileSync(terminal.sessionFile, "utf8").trim().split("\n").map(JSON.parse);
				for (const result of messages.filter((entry) => entry.message?.role === "toolResult"))
					assert.equal(result.message.isError, false, JSON.stringify(result.message));
				const waitResult = messages.find((entry) => entry.message?.toolName === "agent_wait");
				assert.match(JSON.stringify(waitResult?.message.content), /agent_wait waiting/);
				assert.ok(messages.some((entry) => JSON.stringify(entry).includes("LOOP_WAITING")));
			}
			if (label === "rejected child scheduling") {
				const messages = readFileSync(terminal.sessionFile, "utf8").trim().split("\n").map(JSON.parse);
				for (const tool of ["schedule_prompt", "subagent"]) {
					assert.equal(messages.find((entry) => entry.message?.toolName === tool)?.message.isError, true);
				}
			}
			if (label.includes("background")) {
				const messages = readFileSync(terminal.sessionFile, "utf8").trim().split("\n").map(JSON.parse);
				const task = messages.find((entry) => entry.message?.toolName === "bg_task").message.details.task;
				assert.match(readFileSync(task.logFile, "utf8"), /42/, "background work must finish before the worker closes");
			}
		}
		steps.push(
			["TaskCreate", { subject: "Bounded work", description: "Exercise the total turn limit" }],
			["TaskExecute", { task_ids: ["1"] }],
			["reply", "LIMIT_PENDING"],
		);
		const requestCount = requests.length;
		const limited = new Promise((resolve) => {
			complete = resolve;
		});
		manager.launch({
			...launch,
			context: undefined,
			role: { ...role, maxTurns: 3 },
			task: "Schedule work within the turn limit.",
		});
		const limitResult = await limited;
		assert.equal(limitResult.status, "failed", limitResult.result);
		assert.match(limitResult.result, /Agent limit reached/);
		assert.equal(requests.length - requestCount, 3, "automatic continuations share the original turn limit");
	} finally {
		await manager.dispose();
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		rmSync(root, { recursive: true, force: true });
	}
});
