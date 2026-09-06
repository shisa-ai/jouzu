import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SubagentManager } from "../dist/subagents/manager.js";
import { defaultAgentConfig } from "../dist/subagents/roles.js";

test("real reviewer reads a sibling file with role-limited tools", { timeout: 20_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-child-access-"));
	const cwd = join(root, "workspace");
	mkdirSync(cwd);
	const outside = join(root, "reference.txt");
	writeFileSync(outside, "SIBLING_REFERENCE_EVIDENCE");
	const requests = [];
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		requests.push(JSON.parse(Buffer.concat(chunks).toString()));
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const first = requests.length === 1;
		const delta = first
			? {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: "read-sibling",
							type: "function",
							function: { name: "read", arguments: JSON.stringify({ path: outside }) },
						},
					],
				}
			: { role: "assistant", content: "Sibling read completed." };
		res.write(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
		res.write(
			`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
		);
		res.end("data: [DONE]\n\n");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	let resolveRun;
	const done = new Promise((resolve) => {
		resolveRun = resolve;
	});
	const manager = new SubagentManager(
		{ configDir: join(root, "config"), stateDir: join(root, "state") },
		"parent",
		1,
		undefined,
		resolveRun,
	);
	try {
		manager.launch({
			cwd,
			role: { ...defaultAgentConfig().roles[2], thinking: "off" },
			task: "Read the sibling reference",
			auth: { apiKey: "fixture" },
			model: {
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
			},
		});
		const result = await done;
		assert.equal(result.status, "completed", result.result);
		assert.equal(requests.length, 2);
		assert.ok(JSON.stringify(requests[1].messages).includes("SIBLING_REFERENCE_EVIDENCE"));
		assert.ok(requests[0].tools.every((tool) => ["read", "grep", "find", "ls"].includes(tool.function.name)));
		assert.match(readFileSync(result.sessionFile, "utf8"), /SIBLING_REFERENCE_EVIDENCE/);
	} finally {
		await manager.dispose();
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		rmSync(root, { recursive: true, force: true });
	}
});
