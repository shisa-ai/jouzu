import assert from "node:assert/strict";
import { test } from "node:test";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { assistant, model as baseModel } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { NativePayloadSources } from "../dist/flow-control/native-payload-sources.js";
import { copyFlowPayload } from "../dist/flow-control/payload-copy.js";

const model = {
	...baseModel,
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://fixture.invalid",
	compat: { supportsToolReferences: true },
};
const user = (content = "hello") => ({ role: "user", content, timestamp: 1 });
const tool = (id, text = "resolved") => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "agent_wait",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 1,
});
function calls(ids) {
	return {
		...assistant(),
		stopReason: "toolUse",
		content: ids.map((id) => ({ type: "toolCall", id, name: "agent_wait", arguments: {} })),
	};
}
async function fixture(messages, tools = []) {
	const members = messages.flatMap((message, index) => (message.role === "assistant" ? [] : [{ index }]));
	const sources = new NativePayloadSources(
		messages,
		{ members, model: { members: members.map(({ index }) => ({ sourceIndex: index, index, status: "intact" })) } },
		model.api,
	);
	const observed = [];
	let payload;
	const result = await stream(
		model,
		{ messages, tools, systemPrompt: "fixture" },
		{
			apiKey: "fixture",
			maxRetries: 0,
			onMessageConverted(source, output) {
				observed.push(source);
				sources.observe(source, output);
			},
			onPayload(value) {
				payload = value;
			},
			fetch: async () => {
				const events = [
					{
						type: "message_start",
						message: { id: "fixture", model: model.id, usage: { input_tokens: 1, output_tokens: 1 } },
					},
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "done" } },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
					{ type: "message_stop" },
				];
				return new Response(
					events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		},
	).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	return {
		payload,
		observed,
		inspect: (value = payload) => sources.inspect(model.api, value, copyFlowPayload(value).owned),
	};
}

test("Anthropic preserves equal-text identities, image content, and cache metadata", async () => {
	const messages = [
		user(),
		user(),
		user([
			{ type: "text", text: "image" },
			{ type: "image", mimeType: "image/png", data: "YWJj" },
		]),
	];
	const f = await fixture(messages);
	assert.deepEqual(f.observed, messages);
	assert.deepEqual(
		f.inspect().map((row) => [row.index, row.disposition]),
		[
			[0, "included"],
			[1, "included"],
			[2, "included"],
		],
	);
	assert.ok(f.payload.messages[2].content.at(-1).cache_control);
});

test("Anthropic filters whitespace and sanitizes invalid Unicode without acknowledging it", async () => {
	const f = await fixture([user(), user("  "), user("bad\ud800"), user([])]);
	assert.deepEqual(
		f.inspect().map((row) => row.disposition),
		["included", "unresolved", "changed", "unresolved"],
	);
	assert.equal(f.observed.length, 2);
});

for (const mode of [
	"content",
	"identity",
	"error",
	"parent",
	"clone",
	"duplicate",
	"omitted",
	"host-copy",
	"custom-copy",
])
	test(`Anthropic grouped tool block ${mode} preserves sibling disposition`, async () => {
		const f = await fixture([calls(["one|$", "two"]), tool("one|$"), tool("two")]);
		let payload = f.payload;
		const row = payload.messages[1];
		const block = row.content[0];
		assert.equal(block.tool_use_id, "one__");
		if (mode === "content") block.content = "other";
		if (mode === "identity") block.tool_use_id = "other";
		if (mode === "error") block.is_error = true;
		if (mode === "parent") row.role = "assistant";
		if (mode === "clone") row.content[0] = structuredClone(block);
		if (mode === "duplicate") row.content.push(block);
		if (mode === "omitted") row.content.shift();
		if (mode === "host-copy") payload = copyFlowPayload(payload).owned;
		if (mode === "custom-copy") {
			payload.toJSON = () => ({ messages: payload.messages });
			payload = copyFlowPayload(payload).owned;
		}
		const results = f.inspect(payload);
		assert.equal(
			results[0].disposition,
			mode === "host-copy"
				? "included"
				: ["content", "identity", "error", "parent"].includes(mode)
					? "changed"
					: "unresolved",
		);
		assert.equal(
			results[1].disposition,
			mode === "parent" ? "changed" : mode === "custom-copy" ? "unresolved" : "included",
		);
	});

test("Anthropic synthetic orphan results have no source observation", async () => {
	const result = tool("one");
	const prompt = user("continue");
	const f = await fixture([calls(["one", "orphan"]), result, prompt]);
	assert.deepEqual(f.observed, [result, prompt]);
	assert.equal(f.payload.messages[1].content.length, 2);
	assert.deepEqual(
		f.inspect().map((row) => row.disposition),
		["included", "included"],
	);
});

test("Anthropic deferred tool references and displaced text do not acknowledge a result", async () => {
	const result = { ...tool("one"), addedToolNames: ["helper"] };
	const tools = ["agent_wait", "helper"].map((name) => ({
		name,
		description: name,
		parameters: { type: "object", properties: {} },
	}));
	const f = await fixture([calls(["one"]), result, user("continue")], tools);
	assert.equal(f.payload.messages[1].content[0].content[0].type, "tool_reference");
	assert.equal(f.payload.messages[1].content[1].text, "resolved");
	assert.deepEqual(
		f.inspect().map((row) => row.disposition),
		["unresolved", "included"],
	);
});
