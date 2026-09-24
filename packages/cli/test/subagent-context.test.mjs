import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureChildContext, inheritedContextText, parentContextTool } from "../dist/subagents/context.js";
import { SubagentManager } from "../dist/subagents/manager.js";
import { defaultAgentConfig } from "../dist/subagents/roles.js";

test("real child receives reference context, uses snapshot lookup, and retains it on resume", {
	timeout: 60000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-parent-worker-"));
	const requests = [];
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		requests.push(body);
		const lookup = requests.length === 1 || requests.length === 3;
		const delta = lookup
			? {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: `call_${requests.length}`,
							type: "function",
							function: { name: "parent_context", arguments: JSON.stringify({ query: "Requirement" }) },
						},
					],
				}
			: { role: "assistant", content: "DONE" };
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.write(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
		res.write(
			`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: {}, finish_reason: lookup ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\n`,
		);
		res.end("data: [DONE]\n\n");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	let complete;
	const manager = new SubagentManager(
		{ stateDir: join(root, "state"), configDir: join(root, "config") },
		"parent",
		1,
		undefined,
		(run) => complete(run),
	);
	const launch = {
		cwd: root,
		task: "Look up the requirement and report DONE.",
		role: { ...defaultAgentConfig().roles[1], thinking: "off" },
		auth: { apiKey: "fixture" },
		model: {
			provider: "fixture",
			id: "test",
			name: "Fixture",
			api: "openai-completions",
			baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
			reasoning: false,
			input: ["text"],
			contextWindow: 128000,
			maxTokens: 512,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
	};
	try {
		let done = new Promise((resolve) => {
			complete = resolve;
		});
		const started = manager.launch({
			...launch,
			context: captureChildContext({ context: "fork" }, false, "parent", branch),
		});
		let result = await done;
		assert.equal(result.status, "completed", result.result);
		assert.match(JSON.stringify(requests[0].messages), /Reference context from parent/);
		assert.ok(requests[0].tools.some((tool) => tool.function.name === "parent_context"));
		const saved = readFileSync(result.sessionFile, "utf8").trim().split("\n").map(JSON.parse);
		const lookup = saved.find(
			(entry) => entry.message?.role === "toolResult" && entry.message.toolName === "parent_context",
		);
		assert.equal(lookup.message.isError, false);
		assert.match(JSON.stringify(lookup.message.content), /Requirement/);
		const original = readFileSync(started.parentContextFile, "utf8");
		done = new Promise((resolve) => {
			complete = resolve;
		});
		const resumed = manager.launch(launch, undefined, result.id);
		result = await done;
		assert.equal(result.status, "completed", result.result);
		assert.equal(resumed.parentContextFile, started.parentContextFile);
		assert.equal(readFileSync(resumed.parentContextFile, "utf8"), original);
		assert.equal(requests.length, 4);
		assert.match(JSON.stringify(requests.at(-1).messages), /Requirement/);
	} finally {
		await manager.dispose();
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		rmSync(root, { recursive: true, force: true });
	}
});

const entry = (id, content) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-01-01",
	message: { role: "user", content },
});
const branch = [
	entry("u", "Requirement 日本語"),
	{
		...entry("a", []),
		message: {
			role: "assistant",
			usage: { secret: "USAGE" },
			providerMetadata: "PROVIDER_STATE",
			content: [
				{ type: "thinking", thinking: "PRIVATE_THINKING" },
				{ type: "image", data: "BINARY_IMAGE" },
				{ type: "text", text: "Decision" },
				{
					type: "toolCall",
					id: "call",
					name: "bash",
					arguments: { command: "echo evidence", details: "ARGUMENT_DETAILS", content: "ARGUMENT_CONTENT" },
				},
			],
		},
	},
	{ ...entry("system", "PARENT_SYSTEM_PROMPT"), message: { role: "system", content: "PARENT_SYSTEM_PROMPT" } },
	{ type: "tool", id: "tool", declaration: "PARENT_TOOL_DECLARATION" },
	{ type: "custom", id: "state", customType: "tasks", data: "PARENT_TASKS" },
	{ type: "compaction", id: "c", summary: "Saved summary", retainedTail: "PRIVATE_TAIL", details: "COMPACTOR_STATE" },
];

test("context snapshots preserve evidence and tool arguments without runtime instructions or private blocks", () => {
	const original = structuredClone(branch);
	const fork = captureChildContext({ context: "fork" }, false, "parent", branch, "c");
	const text = inheritedContextText(fork);
	assert.match(text, /Reference context.*parent/);
	assert.match(text, /echo evidence/);
	assert.match(text, /ARGUMENT_DETAILS/);
	assert.match(text, /ARGUMENT_CONTENT/);
	assert.doesNotMatch(
		JSON.stringify(fork),
		/PRIVATE_THINKING|BINARY_IMAGE|PARENT_SYSTEM_PROMPT|PARENT_TOOL_DECLARATION|PARENT_TASKS|PRIVATE_TAIL|COMPACTOR_STATE|PROVIDER_STATE|USAGE/,
	);
	assert.deepEqual(branch, original);
	branch[0].message.content = "changed after capture";
	assert.match(text, /Requirement/);
	branch[0].message.content = original[0].message.content;
});

test("fresh and review defaults, explicit sharing, splice validation and bounded references", () => {
	const fresh = captureChildContext({}, false, "parent", branch);
	assert.equal(inheritedContextText(fresh), undefined);
	assert.equal(fresh.parentLookup, true);
	const review = captureChildContext({}, true, "parent", branch);
	assert.equal(review.parentLookup, false);
	assert.deepEqual(review.entries, []);
	assert.equal(captureChildContext({ parentContext: true }, true, "p", branch).parentLookup, true);
	const splice = captureChildContext(
		{ context: "splice", entryIds: ["u", "u"], parentContext: false },
		false,
		"p",
		branch,
	);
	assert.deepEqual(splice.entryIds, ["u"]);
	assert.equal(splice.entries.length, 1);
	assert.match(inheritedContextText(splice), /Requirement/);
	assert.doesNotMatch(inheritedContextText(splice), /echo evidence/);
	for (const options of [
		{ context: "bad" },
		{ parentContext: "yes" },
		{ context: "fresh", entryIds: ["u"] },
		{ context: "splice" },
		{ context: "splice", entryIds: ["system"] },
		{ context: "splice", entryIds: ["missing"] },
	])
		assert.throws(() => captureChildContext(options, false, "p", branch), /Context:/);
	const large = captureChildContext(
		{ context: "fork" },
		false,
		"p",
		Array.from({ length: 100 }, (_, i) => entry(String(i), "日".repeat(10000))),
	);
	assert.ok(inheritedContextText(large).length < 65000);
	assert.match(inheritedContextText(large), /truncated/);
});

test("parent lookup reads only the saved snapshot and pages with trace cursors", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-parent-context-"));
	try {
		const snapshot = captureChildContext({}, false, "p", branch);
		const path = join(root, "parent.jsonl");
		writeFileSync(path, snapshot.entries.map(JSON.stringify).join("\n") + "\n");
		const tool = parentContextTool(path);
		const page = JSON.parse((await tool.execute("id", { limit: 1 })).content[0].text);
		assert.equal(page.records[0].entryId, "u");
		assert.ok(page.nextOffset > 0);
		const next = JSON.parse(
			(await tool.execute("id", { offset: page.nextOffset, query: "echo evidence" })).content[0].text,
		);
		assert.equal(next.records[0].entryId, "a");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
