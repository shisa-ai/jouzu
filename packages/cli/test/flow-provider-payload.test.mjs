import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { model } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { anthropicFlowPayload } from "../dist/flow-control/anthropic-payload.js";
import { googleFlowPayload } from "../dist/flow-control/google-payload.js";
import { FlowModelInput } from "../dist/flow-control/model-input.js";
import { createPiLedgerStore } from "../dist/flow-control/pi-ledger-store.js";
import { admitFlowPayload, openAIFlowPayload } from "../dist/flow-control/provider-payload.js";
import { FlowReceiptLedger } from "../dist/flow-control/receipt-ledger.js";

async function fixture(t) {
	const repo = new MemorySessionRepo();
	t.after(() => repo.close(context));
	const session = await repo.create({}, context);
	const ledger = await FlowReceiptLedger.attach(createPiLedgerStore(session), { sessionId: "test", branchId: "main" });
	const composition = FlowModelInput.compose(
		"attempt",
		[
			{
				id: "work",
				revision: "1",
				kind: "work",
				text: "Perform the next step",
				images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
			},
			{ id: "result", revision: "1", kind: "result", text: "Completed" },
		],
		4096,
	);
	await ledger.select("attempt", composition.members);
	await ledger.queued("attempt", { id: "queue", revision: 1 });
	await ledger.claim("attempt", { id: "queue", revision: 1 });
	await ledger.prepare(
		"attempt",
		"request",
		composition.inspect([{ role: "user", content: composition.content, timestamp: 1 }]),
		false,
	);
	return { ledger, composition };
}

for (const api of ["openai-completions", "anthropic-messages"])
	for (const transform of [
		"unchanged",
		"optional-removed",
		"required-changed",
		"image-removed",
		"role-changed",
		"duplicate",
		"oversized",
	]) {
		test(`${api} HTTP conversion admits only verified payload: ${transform}`, async (t) => {
			const { ledger, composition } = await fixture(t);
			const sent = [];
			let payload;
			const result = await (api === "anthropic-messages" ? streamAnthropic : stream)(
				{ ...model, api, baseUrl: "https://fixture.invalid/v1" },
				{ messages: [{ role: "user", content: composition.content, timestamp: 1 }] },
				{
					apiKey: "fixture",
					maxRetries: 0,
					onPayload: async (converted) => {
						payload = converted;
						const user = payload.messages.find((message) => message.role === "user");
						if (transform === "optional-removed") user.content.pop();
						if (transform === "required-changed")
							user.content[0].text = user.content[0].text.replace("Perform", "Skip");
						if (transform === "image-removed") user.content.splice(1, 1);
						if (transform === "role-changed") user.role = "assistant";
						if (transform === "duplicate") payload.messages.push(structuredClone(user));
						const owned = await admitFlowPayload(
							ledger,
							composition,
							"request",
							api,
							payload,
							api === "anthropic-messages" ? anthropicFlowPayload : openAIFlowPayload("openai-completions"),
							transform === "oversized" ? 1 : 100000,
						);
						await ledger.handoff("attempt", "request");
						// Mutating the extension-owned payload after admission cannot change transport bytes.
						user.content = [];
						return owned;
					},
					fetch: async (_url, init) => {
						sent.push(JSON.parse(init.body));
						if (api === "anthropic-messages") {
							const events = [
								{
									type: "message_start",
									message: { id: "fixture", model: model.id, usage: { input_tokens: 1, output_tokens: 1 } },
								},
								{ type: "content_block_start", index: 0, content_block: { type: "text", text: "Done" } },
								{ type: "content_block_stop", index: 0 },
								{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
								{ type: "message_stop" },
							];
							return new Response(
								events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
								{ headers: { "content-type": "text/event-stream" } },
							);
						}
						return new Response(
							'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":null}]}\n\ndata: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
							{ headers: { "Content-Type": "text/event-stream" } },
						);
					},
				},
			).result();
			const [attempt] = (await ledger.snapshot()).attempts;
			const request = attempt.requests[0];
			const allowed = ["unchanged", "optional-removed"].includes(transform);
			assert.equal(sent.length, allowed ? 1 : 0);
			assert.equal(request.handedOff, allowed);
			assert.equal(result.stopReason, allowed ? "stop" : "error");
			assert.equal(request.inclusion[0].disposition, "included");
			if (allowed) {
				assert.equal(request.payload.hash, createHash("sha256").update(JSON.stringify(sent[0])).digest("hex"));
				assert.equal(request.payload.bytes, Buffer.byteLength(JSON.stringify(sent[0])));
				assert.equal(
					request.payload.inclusion[1].disposition,
					transform === "optional-removed" ? "omitted" : "included",
				);
			} else assert.equal(attempt.phase, "withheld");
		});
	}

test("Responses projection checks image bytes and excludes assistant and metadata copies", async (t) => {
	const { ledger, composition } = await fixture(t);
	const content = composition.content.map((part) =>
		part.type === "text"
			? { type: "input_text", text: part.text }
			: { type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}` },
	);
	const payload = { input: [{ role: "user", content }], metadata: { copy: content } };
	await admitFlowPayload(
		ledger,
		composition,
		"request",
		"openai-responses",
		payload,
		openAIFlowPayload("openai-responses"),
		100000,
	);
	await assert.rejects(
		admitFlowPayload(
			ledger,
			composition,
			"request",
			"openai-responses",
			payload,
			openAIFlowPayload("openai-responses"),
			100000,
		),
		{ code: "identity" },
	);
	assert.equal(
		composition.inspect(
			openAIFlowPayload("openai-responses")({ ...payload, input: [{ role: "assistant", content }] }),
		)[0].disposition,
		"omitted",
	);
});

test("payload storage failure prevents Pi HTTP transmission", async (t) => {
	const { ledger, composition } = await fixture(t);
	let sent = 0;
	t.mock.method(ledger, "payload", async () => {
		throw new Error("storage unavailable");
	});
	const result = await stream(
		{ ...model, baseUrl: "https://fixture.invalid/v1" },
		{ messages: [{ role: "user", content: composition.content, timestamp: 1 }] },
		{
			apiKey: "fixture",
			maxRetries: 0,
			onPayload: (payload) =>
				admitFlowPayload(
					ledger,
					composition,
					"request",
					"openai-completions",
					payload,
					openAIFlowPayload("openai-completions"),
					100000,
				),
			fetch: async () => {
				sent++;
				throw new Error("unexpected transport");
			},
		},
	).result();
	assert.equal(sent, 0);
	assert.equal(result.stopReason, "error");
	assert.equal((await ledger.snapshot()).attempts[0].requests[0].payload, undefined);
});

for (const api of ["openai-completions", "openai-responses"]) {
	test(`${api} payload filtering cannot remove or rebind tool results`, async (t) => {
		const { composition } = await fixture(t);
		const user = {
			role: "user",
			content: composition.content.map((part) =>
				part.type === "text"
					? { type: api === "openai-completions" ? "text" : "input_text", text: part.text }
					: api === "openai-completions"
						? { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } }
						: { type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}` },
			),
		};
		const call =
			api === "openai-completions"
				? {
						role: "assistant",
						content: null,
						tool_calls: [{ id: "call", type: "function", function: { name: "read", arguments: "{}" } }],
					}
				: { type: "function_call", call_id: "call", name: "read", arguments: "{}" };
		const output =
			api === "openai-completions"
				? { role: "tool", tool_call_id: "call", content: "done" }
				: { type: "function_call_output", call_id: "call", output: "done" };
		const project = (items) => openAIFlowPayload(api)({ [api === "openai-completions" ? "messages" : "input"]: items });
		assert.equal(composition.inspect(project([call, output, user]))[0].disposition, "included");
		assert.throws(() => project([call, user]), { code: "schema" });
		assert.throws(() => project([call, { ...output, tool_call_id: "wrong", call_id: "wrong" }, user]), {
			code: "schema",
		});
		assert.throws(() => project([call, output, output, user]), { code: "schema" });
	});
}

test("cancellation during payload inspection cannot acquire a handoff", async (t) => {
	const { ledger, composition } = await fixture(t);
	const payload = { messages: [{ role: "user", content: composition.content.filter((part) => part.type === "text") }] };
	await ledger.cancel("attempt", "User preempted request.");
	await assert.rejects(
		admitFlowPayload(
			ledger,
			composition,
			"request",
			"openai-completions",
			payload,
			openAIFlowPayload("openai-completions"),
			100000,
		),
		{ code: "transition" },
	);
	assert.equal((await ledger.snapshot()).attempts[0].requests[0].payload, undefined);
});

test("Anthropic excludes grouped output, displaced sibling text, assistant copies, and metadata", async (t) => {
	const { composition } = await fixture(t);
	const content = composition.content.map((part) =>
		part.type === "text"
			? part
			: { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } },
	);
	const call = { role: "assistant", content: [{ type: "tool_use", id: "call", name: "read", input: {} }] };
	const result = { type: "tool_result", tool_use_id: "call", content };
	const grouped = { role: "user", content: [result, ...content] };
	const payload = { messages: [call, grouped, { role: "assistant", content }], metadata: { copy: content } };
	assert.ok(composition.inspect(anthropicFlowPayload(payload)).every((item) => item.disposition === "omitted"));
	payload.messages.push({ role: "user", content });
	assert.ok(composition.inspect(anthropicFlowPayload(payload)).every((item) => item.disposition === "included"));
});

test("Anthropic validates grouped tool ordering and permits completed batches to reuse IDs", () => {
	const call = {
		role: "assistant",
		content: [
			{ type: "tool_use", id: "one", name: "read", input: {} },
			{ type: "tool_use", id: "two", name: "read", input: {} },
		],
	};
	const outputs = {
		role: "user",
		content: [
			{ type: "tool_result", tool_use_id: "one", content: "a" },
			{ type: "tool_result", tool_use_id: "two", content: "b" },
		],
	};
	const user = { role: "user", content: "continue" };
	const project = (messages) => anthropicFlowPayload({ messages });
	assert.equal(project([call, outputs, call, outputs, user]).length, 1);
	assert.equal(
		project([{ role: "system", content: [], output_config: { effort: "high" } }, call, outputs, user]).length,
		1,
	);
	for (const messages of [
		[call],
		[call, user],
		[call, { ...outputs, content: outputs.content.slice(0, 1) }],
		[call, { ...outputs, role: "assistant" }],
		[outputs],
		[call, { ...outputs, content: [outputs.content[0], outputs.content[0]] }],
		[call, { ...outputs, content: [{ type: "text", text: "copy" }, ...outputs.content] }],
		[call, { ...outputs, content: [...outputs.content, outputs.content[0]] }],
		[{ ...call, content: [call.content[0], call.content[0]] }, outputs],
		[call, { ...outputs, content: [{ ...outputs.content[0], tool_use_id: "wrong" }, outputs.content[1]] }],
		[call, { ...outputs, content: [{ ...outputs.content[0], is_error: "false" }, outputs.content[1]] }],
		[call, { role: "system", content: [] }, outputs],
	])
		assert.throws(() => project(messages), { code: "schema" });
});

for (const transform of [
	"unchanged",
	"optional-removed",
	"required-changed",
	"image-removed",
	"role-changed",
	"duplicate",
	"oversized",
	"extra-body",
	"tool-copy",
	"tool-gap",
])
	test(`Google SDK composed admission: ${transform}`, async (t) => {
		const { ledger, composition } = await fixture(t);
		let sent, admitted;
		t.mock.method(globalThis, "fetch", async (_url, init) => {
			sent = JSON.parse(init.body);
			return new Response(
				`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Done" }] }, finishReason: "STOP" }] })}\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		});
		const api = "google-generative-ai";
		const result = await streamGoogle(
			{ ...model, api, provider: "google", id: "gemini-3.1-pro-preview" },
			{ messages: [{ role: "user", content: composition.content, timestamp: 1 }] },
			{
				apiKey: "fixture",
				maxRetries: 0,
				signal: new AbortController().signal,
				async onPayload(payload) {
					const user = payload.contents[0];
					if (transform === "optional-removed") user.parts.pop();
					if (transform === "required-changed") user.parts[0].text = user.parts[0].text.replace("Perform", "Skip");
					if (transform === "image-removed") user.parts.splice(1, 1);
					if (transform === "role-changed") user.role = "model";
					if (transform === "duplicate") payload.contents.push(structuredClone(user));
					if (transform === "extra-body") payload.config.httpOptions = { extraBody: { contents: [] } };
					if (["tool-copy", "tool-gap"].includes(transform)) {
						payload.contents.unshift({
							role: "model",
							parts: [{ functionCall: { name: "fixture", id: "one", args: {} } }],
						});
						if (transform === "tool-copy")
							user.parts = [{ functionResponse: { name: "fixture", id: "one", response: { output: user.parts } } }];
					}
					admitted = await admitFlowPayload(
						ledger,
						composition,
						"request",
						api,
						payload,
						googleFlowPayload,
						transform === "oversized" ? 1 : 100000,
					);
					await ledger.handoff("attempt", "request");
					user.parts = [];
					return admitted;
				},
			},
		).result();
		const [attempt] = (await ledger.snapshot()).attempts;
		const request = attempt.requests[0];
		const allowed = ["unchanged", "optional-removed"].includes(transform);
		assert.equal(Boolean(sent), allowed);
		assert.equal(result.stopReason, allowed ? "stop" : "error");
		if (allowed) {
			assert.deepEqual(sent.contents, admitted.contents);
			assert.deepEqual(composition.inspect(googleFlowPayload(sent)), request.payload.inclusion);
			assert.equal(request.payload.inclusion[0].disposition, "included");
			assert.equal(request.payload.inclusion[1].disposition, transform === "optional-removed" ? "omitted" : "included");
		} else assert.equal(attempt.phase, "withheld");
	});

test("Google composition respects ID-free function order and displaced tool images", () => {
	const call = (name) => ({ functionCall: { name, args: {} } });
	const result = (name) => ({ functionResponse: { name, response: { output: "done" } } });
	const payload = {
		contents: [
			{ role: "model", parts: [call("one"), call("two")] },
			{ role: "user", parts: [result("one")] },
			{
				role: "user",
				parts: [{ text: "Tool result image:" }, { inlineData: { mimeType: "image/png", data: "YWJj" } }],
			},
			{ role: "user", parts: [result("two"), { text: "displaced sibling" }] },
			{ role: "user", parts: [{ text: "next" }] },
		],
	};
	assert.deepEqual(googleFlowPayload(payload), [
		{ role: "user", content: [{ type: "text", text: "next" }], timestamp: 0 },
	]);
	payload.contents[1].parts[0] = result("two");
	assert.throws(() => googleFlowPayload(payload), /unmatched function response/);
});
