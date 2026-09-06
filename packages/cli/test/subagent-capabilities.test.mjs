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

test(
	"real children can read outside cwd, use skills/recall/web/tasks, consult parent context, and retain local tasks on resume",
	{ timeout: 60000 },
	async () => {
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
			const [name, args] = step;
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
		const role = { ...defaultAgentConfig().roles[1], thinking: "off" };
		const launch = {
			role,
			model,
			auth: { apiKey: "fixture-key" },
			cwd: workspace,
			task: "Use the assigned tools and report DONE.",
			context: captureChildContext(
				{},
				false,
				"parent",
				[entry("requirement", "PARENT_PROJECT_DECISION")],
				"requirement",
			),
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
			for (const name of [
				"vcc_recall",
				"compact_context",
				"TaskCreate",
				"web_fetch",
				"tff-search_web",
				"parent_context",
			])
				assert.ok(allTools.includes(name), name);
			assert.ok(!allTools.includes("subagent"));
			assert.ok(!allTools.includes("TaskExecute"));
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
		} finally {
			await manager.dispose();
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
			rmSync(root, { recursive: true, force: true });
		}
	},
);
