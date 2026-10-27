import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { applyProviderReceipts } from "./apply-pi-provider-receipts.mjs";
import { assistant } from "./fixtures/pi-flow-session.mjs";
import "./pi-oauth-branding.test.mjs";

for (const api of [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
	"bedrock-converse-stream",
	"mistral-conversations",
]) {
	test(`normalized transcript keeps exact user and tool-result receipt identities: ${api}`, async () => {
		const { stream } = await import(`@earendil-works/pi-ai/api/${api}`);
		const model = {
			id: "fixture",
			name: "fixture",
			api,
			provider: "fixture",
			baseUrl: "https://fixture.invalid/v1",
			reasoning: false,
			input: ["text"],
			contextWindow: 4096,
			maxTokens: 32,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const users = [1, 2].map(() => ({ role: "user", content: [{ type: "text", text: "same input" }], timestamp: 1 }));
		const results = ["call_a", "call_b"].map((toolCallId) => ({
			role: "toolResult",
			toolCallId,
			toolName: "probe",
			content: [{ type: "text", text: "same result" }],
			isError: false,
			timestamp: 3,
		}));
		const messages = [
			{ role: "system", content: "Follow instructions.", sections: { project: "Project context." }, timestamp: 0 },
			...users,
			{
				...assistant(),
				api,
				provider: model.provider,
				model: model.id,
				stopReason: "toolUse",
				content: results.map(({ toolCallId }) => ({ type: "toolCall", id: toolCallId, name: "probe", arguments: {} })),
			},
			...results,
		];
		const original = structuredClone(messages);
		const receipts = [];
		let payload;
		const response = await stream(
			model,
			{ messages },
			{
				apiKey: "fixture-key",
				region: "us-east-1",
				maxTokens: 32,
				onMessageConverted(source, output) {
					receipts.push({ source, output });
				},
				onPayload(value) {
					payload = value;
					throw new Error("fixture-before-network");
				},
			},
		).result();
		assert.ok(payload, response.errorMessage);
		assert.match(response.errorMessage, /fixture-before-network/);
		assert.deepEqual(messages, original);
		const contains = (value, target) =>
			value === target ||
			(value !== null && typeof value === "object" && Object.values(value).some((child) => contains(child, target)));
		for (const source of [...users, ...results]) {
			const matches = receipts.filter((receipt) => receipt.source === source);
			assert.equal(matches.length, 1, `one receipt for source index ${messages.indexOf(source)}`);
			assert.ok(contains(payload, matches[0].output), "receipt points into the final payload");
		}
	});
}

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
	await writeFile(
		join(pkg, "package.json"),
		JSON.stringify({
			name: "@earendil-works/pi-ai",
			version: JSON.parse(await readFile(new URL("../upstream/pi-provider-receipts/patch.lock.json", import.meta.url)))
				.version,
		}),
	);
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

for (const signatureTiming of ["first", "last"])
	test(`OpenAI-compatible Gemini tool calls replay signatures received in the ${signatureTiming} delta`, async () => {
		const { stream } = await import("@earendil-works/pi-ai/api/openai-completions");
		const model = {
			id: "gemini-4-argon",
			name: "Gemini 4 Argon",
			api: "openai-completions",
			provider: "fixture-gateway",
			baseUrl: "https://fixture.invalid/v1",
			reasoning: true,
			input: ["text"],
			contextWindow: 4096,
			maxTokens: 32,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const signature = "Z2VtaW5pLXRvb2wtc2lnbmF0dXJl";
		const extra_content = { google: { thought_signature: signature } };
		const deltas = [
			{
				tool_calls: [
					{
						index: 0,
						id: "call_read",
						type: "function",
						function: { name: "read", arguments: "{}" },
						...(signatureTiming === "first" ? { extra_content } : {}),
					},
				],
			},
			{ tool_calls: [{ index: 1, id: "call_other", type: "function", function: { name: "read", arguments: "{}" } }] },
			{ tool_calls: [{ index: 0, ...(signatureTiming === "last" ? { extra_content } : {}) }] },
			{ tool_calls: [{ index: 0, extra_content: { google: { thought_signature: "" } } }] },
		];
		const result = await stream(
			model,
			{ messages: [{ role: "user", content: "Read files", timestamp: 1 }] },
			{
				apiKey: "fixture",
				fetch: async () =>
					new Response(
						`${deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`).join("")}data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
						{ headers: { "Content-Type": "text/event-stream" } },
					),
			},
		).result();
		assert.equal(result.stopReason, "toolUse", result.errorMessage);
		assert.equal(result.content[0].thoughtSignature, signature);
		assert.equal(result.content[1].thoughtSignature, undefined);
		// Session persistence must retain metadata without requiring live adapter state.
		const saved = JSON.parse(JSON.stringify(result));
		const messages = [
			saved,
			...saved.content.map((call) => ({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: "File contents" }],
				isError: false,
				timestamp: 2,
			})),
		];
		for (const selected of [model, { ...model, id: "another-model" }, { ...model, provider: "another-provider" }]) {
			let payload;
			await stream(
				selected,
				{ messages },
				{
					apiKey: "fixture",
					onPayload(value) {
						payload = value;
						throw new Error("fixture-before-network");
					},
				},
			).result();
			const calls = payload.messages.find((message) => message.role === "assistant").tool_calls;
			assert.deepEqual(calls[0].extra_content, selected === model ? extra_content : undefined);
			assert.equal(calls[1].extra_content, undefined);
		}
		const encrypted = { type: "reasoning.encrypted", id: "call_read", data: "opaque-provider-state" };
		saved.content[0].thoughtSignature = JSON.stringify(encrypted);
		let payload;
		await stream(
			model,
			{ messages },
			{
				apiKey: "fixture",
				onPayload(value) {
					payload = value;
					throw new Error("fixture-before-network");
				},
			},
		).result();
		const replayed = payload.messages.find((message) => message.role === "assistant");
		assert.deepEqual(replayed.reasoning_details, [encrypted]);
		assert.equal(replayed.tool_calls[0].extra_content, undefined);
	});
