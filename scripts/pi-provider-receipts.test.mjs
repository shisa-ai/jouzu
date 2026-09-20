import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { applyProviderReceipts } from "./apply-pi-provider-receipts.mjs";

test("provider receipt patch is pinned and idempotent in both package resolutions", async () => {
	const path = "upstream/pi-provider-receipts/patch.lock.json";
	const bytes = await readFile(path);
	const pin = JSON.parse(await readFile("upstream/pi.lock.json", "utf8"));
	assert.deepEqual(
		pin.deviations.filter((record) => record.path === path),
		[{ path, sha256: createHash("sha256").update(bytes).digest("hex") }],
	);
	for (const root of [resolve("."), resolve("packages/cli")]) {
		assert.equal(await applyProviderReceipts(root, true), 0);
		assert.equal(await applyProviderReceipts(root), 0);
	}
});

test("provider receipt patch preserves unrecognized installed source", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-provider-patch-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const pkg = join(root, "node_modules/@earendil-works/pi-ai");
	await mkdir(join(pkg, "dist/api"), { recursive: true });
	await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.86.0" }));
	const path = join(pkg, "dist/api/transform-messages.js");
	await writeFile(path, "unrecognized");
	await assert.rejects(applyProviderReceipts(root), /hash mismatch/);
	assert.equal(await readFile(path, "utf8"), "unrecognized");
});

test("OpenAI-compatible usage preserves top-level reasoning and nested precedence", async (t) => {
	const { stream } = await import("@earendil-works/pi-ai/api/openai-completions");
	for (const [name, extra, expected] of [
		["SGLang top-level", { reasoning_tokens: 16 }, 16],
		["nested", { completion_tokens_details: { reasoning_tokens: 12 } }, 12],
		["nested wins", { reasoning_tokens: 16, completion_tokens_details: { reasoning_tokens: 12 } }, 12],
		["explicit nested zero", { reasoning_tokens: 16, completion_tokens_details: { reasoning_tokens: 0 } }, 0],
		["null nested fallback", { reasoning_tokens: 16, completion_tokens_details: null }, 16],
		["missing", {}, 0],
	]) {
		await t.test(name, async (t) => {
			const usage = {
				prompt_tokens: 100,
				completion_tokens: 20,
				total_tokens: 120,
				prompt_tokens_details: { cached_tokens: 64 },
				...extra,
			};
			const server = createServer((_req, res) => {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(
					`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`,
				);
			});
			await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
			t.after(() => new Promise((resolve) => server.close(resolve)));
			const model = {
				id: "fixture",
				name: "fixture",
				api: "openai-completions",
				provider: "fixture",
				baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
				reasoning: true,
				input: ["text"],
				contextWindow: 4096,
				maxTokens: 32,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			const result = await stream(
				model,
				{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
				{ apiKey: "fixture", maxTokens: 32 },
			).result();
			assert.notEqual(result.stopReason, "error", result.errorMessage);
			assert.equal(result.usage.reasoning, expected);
			assert.equal(result.usage.input, 36);
			assert.equal(result.usage.cacheRead, 64);
			assert.equal(result.usage.output, 20);
			assert.equal(result.usage.totalTokens, 120);
		});
	}
});
