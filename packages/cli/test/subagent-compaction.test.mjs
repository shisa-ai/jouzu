import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureChildContext } from "../dist/subagents/context.js";
import { SubagentManager } from "../dist/subagents/manager.js";
import { defaultAgentConfig } from "../dist/subagents/roles.js";

test(
	"worker waits for requested VCC compaction, continues work, and recalls its pre-compaction history",
	{ timeout: 60000 },
	async () => {
		const root = mkdtempSync(join(tmpdir(), "jouzu-child-compact-"));
		writeFileSync(join(root, "long.txt"), "PRE_COMPACTION_EVIDENCE\n" + "reference material.\n".repeat(2600));
		const requests = [];
		const responses = [
			["read", { path: "long.txt" }],
			["read", { path: "long.txt" }],
			["read", { path: "long.txt" }],
			["compact_context", {}],
			"Compacting before the remaining work.",
			["vcc_recall", { query: "PRE_COMPACTION_EVIDENCE" }],
			"WORK_FINISHED_AFTER_COMPACTION",
		];
		const server = createServer(async (req, res) => {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			requests.push(JSON.parse(Buffer.concat(chunks).toString()));
			const response = responses.shift() ?? "Unexpected extra request";
			const delta =
				typeof response === "string"
					? { role: "assistant", content: response }
					: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: `call_${requests.length}`,
									type: "function",
									function: { name: response[0], arguments: JSON.stringify(response[1]) },
								},
							],
						};
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
			res.write(
				`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: typeof response === "string" ? "stop" : "tool_calls" }], usage: { prompt_tokens: 30000, completion_tokens: 5, total_tokens: 30005 } })}\n\n`,
			);
			res.end("data: [DONE]\n\n");
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
		const done = new Promise((resolve) => {
			complete = resolve;
		});
		const manager = new SubagentManager(
			{ stateDir: join(root, "state"), configDir: join(root, "config") },
			"parent",
			1,
			undefined,
			complete,
		);
		try {
			const branch = Array.from({ length: 12 }, (_, index) => ({
				type: "message",
				id: String(index),
				parentId: index ? String(index - 1) : null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "Earlier project work. ".repeat(500), timestamp: Date.now() },
			}));
			const started = manager.launch({
				role: { ...defaultAgentConfig().roles[1], thinking: "off" },
				model,
				auth: { apiKey: "fixture" },
				cwd: root,
				task: "Read the reference, compact, then finish the remaining work.",
				context: captureChildContext({ context: "fork" }, false, "parent", branch, "11"),
			});
			const run = await done;
			assert.equal(run.status, "completed", manager.read(started.id).text);
			assert.equal(
				run.result,
				"WORK_FINISHED_AFTER_COMPACTION",
				JSON.stringify({
					requests: requests.length,
					events: manager.read(started.id, 0, 32000).text.slice(-5000),
					kinds: readFileSync(run.sessionFile, "utf8")
						.trim()
						.split("\n")
						.map(JSON.parse)
						.map((entry) => entry.type),
				}),
			);
			assert.equal(requests.length, 7);
			const saved = readFileSync(run.sessionFile, "utf8").trim().split("\n").map(JSON.parse);
			const compactions = saved.filter((entry) => entry.type === "compaction");
			assert.ok(compactions.length > 0);
			assert.equal(compactions[0].details.compactor, "pi-vcc");
			const recall = saved.find(
				(entry) =>
					entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "vcc_recall",
			);
			assert.equal(recall.message.isError, false);
			assert.match(JSON.stringify(recall.message.content), /PRE_COMPACTION_EVIDENCE/);
		} finally {
			await manager.dispose();
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
			rmSync(root, { recursive: true, force: true });
		}
	},
);
