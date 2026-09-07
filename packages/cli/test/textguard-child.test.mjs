import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SubagentManager } from "../dist/subagents/manager.js";
import { defaultAgentConfig } from "../dist/subagents/roles.js";

for (const variant of ["clear-skill", "major-skill", "ordinary-file", "ordinary-file-opt-in"]) {
	test(`real child admission and restored expansion: ${variant}`, { timeout: 30000 }, async () => {
		const root = mkdtempSync(join(tmpdir(), "jouzu-child-textguard-"));
		const cwd = join(root, "workspace");
		mkdirSync(cwd);
		const path = join(cwd, variant.startsWith("ordinary-file") ? "reference.txt" : "SKILL.md");
		const body = `CHILD_SOURCE_MARKER${variant === "clear-skill" ? "" : "\u202e"}`;
		writeFileSync(path, body);
		const requests = [];
		const server = createServer(async (req, res) => {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			requests.push(JSON.parse(Buffer.concat(chunks).toString()));
			const first = requests.length === 1;
			const delta = first
				? {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "read-skill",
								type: "function",
								function: { name: "read", arguments: JSON.stringify({ path }) },
							},
						],
					}
				: { role: "assistant", content: "Finished." };
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
			res.write(
				`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
			);
			res.end("data: [DONE]\n\n");
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		let complete;
		const wait = () =>
			new Promise((resolve) => {
				complete = resolve;
			});
		const manager = new SubagentManager(
			{ configDir: join(root, "config"), stateDir: join(root, "state") },
			"parent",
			1,
			undefined,
			(result) => complete(result),
		);
		const launch = {
			cwd,
			textguardFiles: variant === "ordinary-file-opt-in",
			role: { ...defaultAgentConfig().roles[2], thinking: "off" },
			task: "Read the file",
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
		};
		try {
			const done = wait();
			manager.launch(launch);
			const result = await done;
			assert.equal(result.status, "completed", result.result);
			assert.equal(requests.length, 2);
			const visible = JSON.stringify(requests[1].messages);
			const blocked = variant === "major-skill" || variant === "ordinary-file-opt-in";
			assert.equal(visible.includes("CHILD_SOURCE_MARKER"), !blocked);
			if (blocked) {
				assert.match(visible, /TextGuard withheld/);
				assert.doesNotMatch(readFileSync(result.sessionFile, "utf8"), /CHILD_SOURCE_MARKER/);
			}
			assert.ok(requests[0].tools.every((tool) => ["read", "grep", "find", "ls"].includes(tool.function.name)));
			// Simulate history written before admission: resume must scan the persisted
			// expansion even though the child loader publishes no skills.
			const saved = SessionManager.open(result.sessionFile);
			saved.appendMessage({
				role: "user",
				content: '<skill name="restored">RESTORED_SECRET\u202e</skill>',
				timestamp: Date.now(),
			});
			assert.match(readFileSync(result.sessionFile, "utf8"), /RESTORED_SECRET/);
			const resumed = wait();
			manager.launch({ ...launch, task: "Continue" }, undefined, result.id);
			const followup = await resumed;
			assert.equal(followup.status, "completed", followup.result);
			assert.equal(requests.length, 3);
			assert.doesNotMatch(JSON.stringify(requests[2].messages), /RESTORED_SECRET/);
			assert.match(JSON.stringify(requests[2].messages), /TextGuard withheld/);
		} finally {
			await manager.dispose();
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
			rmSync(root, { recursive: true, force: true });
		}
	});
}
