import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SubagentManager } from "../dist/subagents/manager.js";
import { defaultAgentConfig } from "../dist/subagents/roles.js";

for (const mode of [undefined, "off", "streaming", "idle"])
	test(`child warming usage and configured mode stay isolated: ${mode ?? "default"}`, { timeout: 20_000 }, async () => {
		const root = mkdtempSync(join(tmpdir(), "jouzu-child-warming-"));
		const requests = [];
		const server = createServer(async (req, res) => {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const body = JSON.parse(Buffer.concat(chunks).toString());
			requests.push(body);
			const first = requests.length === 1;
			const warm = body.max_tokens === 1 || body.max_completion_tokens === 1;
			const delta = first
				? {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "hold",
								type: "function",
								function: {
									name: "bash",
									arguments: JSON.stringify({
										command: `${JSON.stringify(process.execPath)} -e 'setTimeout(() => {}, 2500)'`,
									}),
								},
							},
						],
					}
				: { role: "assistant", content: warm ? "WARM_ONLY" : "Completed." };
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
			res.write(
				`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: warm ? 1 : 5, total_tokens: warm ? 11 : 15 } })}\n\n`,
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
				...(mode ? { cacheWarming: mode } : {}),
				cwd: root,
				role: { ...defaultAgentConfig().roles[1], thinking: "off", maxTurns: 3 },
				task: "Run the tool and finish.",
				auth: { apiKey: "fixture" },
				model: {
					provider: "fixture",
					id: "test",
					name: "Fixture",
					api: "openai-completions",
					baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
					reasoning: false,
					input: ["text"],
					// Synthetic prices make the automatic decision eligible; all requests stay on loopback.
					cost: { input: 10000, output: 1, cacheRead: 1, cacheWrite: 0 },
					promptCache: { short: 11 },
					contextWindow: 32000,
					maxTokens: 512,
				},
			});
			const result = await done;
			assert.equal(result.status, "completed", result.result);
			const readEntries = (file) => readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
			// Parent totals are fixed when the child reports its result, so read the usage the
			// parent could have received before stopping the child.
			const reported = readEntries(result.sessionFile);
			// The refresh ledger is final only after the child stops: a refresh still in flight
			// when the child finishes is aborted during shutdown and settles then.
			await manager.dispose();
			const entries = readEntries(result.sessionFile);
			const warms = entries.filter((entry) => entry.type === "usage" && entry.kind === "cache_warm");
			const reportedWarms = reported.filter((entry) => entry.type === "usage" && entry.kind === "cache_warm");
			// A refresh still in flight when the warming run is replaced is aborted, so the provider
			// can serve a refresh whose usage is never recorded. Correlate served traffic with the
			// child's own admission ledger instead of assuming every served refresh completes.
			const warmRequests = requests.filter((body) => body.max_tokens === 1 || body.max_completion_tokens === 1);
			const admissions = entries.filter(
				(entry) => entry.type === "custom" && entry.customType === "jouzu-cache-warm-request",
			);
			const handoffs = admissions.filter((entry) => entry.data?.phase === "handoff");
			const settled = admissions.filter((entry) => entry.data?.phase === "settled");
			const completed = settled.filter((entry) => entry.data?.outcome === "stop");
			const aborted = settled.filter((entry) => entry.data?.outcome === "aborted");
			const handoffIds = handoffs.map((entry) => entry.data.id);
			const settledIds = settled.map((entry) => entry.data.id);
			const handoffIdSet = new Set(handoffIds);
			assert.equal(new Set(handoffIds).size, handoffIds.length, "each refresh is admitted once");
			assert.equal(new Set(settledIds).size, settledIds.length, "each refresh settles once");
			assert.ok(
				settledIds.every((id) => handoffIdSet.has(id)),
				"every refresh outcome must belong to an admitted refresh",
			);
			assert.equal(completed.length + aborted.length, settled.length, "refresh outcomes must be stop or aborted");
			assert.equal(settled.length, handoffs.length, "every admitted refresh must settle before the child stops");
			if (mode === undefined || mode === "off") {
				assert.equal(warms.length, 0, "default and disabled children must not refresh");
				assert.equal(handoffs.length, 0, "default and disabled children must not admit a refresh");
			} else assert.ok(warms.length > 0, "worker should perform at least one automatic refresh during the tool");
			assert.equal(
				requests.length - warmRequests.length,
				2,
				"the child makes only its first and final conversational requests",
			);
			assert.ok(
				handoffs.length >= warmRequests.length,
				"every refresh the provider served must be admitted by the child",
			);
			assert.ok(
				warmRequests.length >= completed.length && warmRequests.length <= completed.length + aborted.length,
				`served refreshes must be completed or aborted: ${warmRequests.length} served, ${completed.length} completed, ${aborted.length} aborted`,
			);
			assert.equal(
				completed.length,
				warms.length,
				"each completed refresh must persist exactly one cache-warm usage entry",
			);
			for (const warm of warms) {
				assert.equal(warm.usage.input, 10);
				assert.equal(warm.usage.output, 1);
			}
			for (const warm of requests.slice(1, -1)) {
				assert.deepEqual(warm.messages, requests[0].messages);
				assert.deepEqual(warm.tools, requests[0].tools);
				assert.equal(warm.model, requests[0].model);
				assert.ok(warm.max_tokens === 1 || warm.max_completion_tokens === 1);
			}
			assert.equal(
				result.usage.input,
				(2 + reportedWarms.length) * 10,
				"parent totals must include cache-warming input",
			);
			assert.equal(result.usage.output, 10 + reportedWarms.length);
			assert.equal(result.result, "Completed.");
			assert.ok(!JSON.stringify(requests.at(-1).messages).includes("WARM_ONLY"));
			assert.equal(entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length, 2);
			const usage = reported.flatMap((entry) =>
				entry.type === "usage"
					? [entry.usage]
					: entry.type === "message" && entry.message.role === "assistant"
						? [entry.message.usage]
						: [],
			);
			assert.equal(result.usage.costComplete, true);
			assert.equal(result.usage.costSource, "estimate");
			assert.ok(Math.abs(result.usage.cost - usage.reduce((sum, item) => sum + item.cost.total, 0)) < 1e-9);
		} finally {
			await manager.dispose();
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
			rmSync(root, { recursive: true, force: true });
		}
	});
