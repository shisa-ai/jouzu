import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock, test } from "node:test";

const providerRequire = createRequire(import.meta.resolve("@earendil-works/pi-ai/api/bedrock-converse-stream"));
const { BedrockRuntimeClient } = providerRequire("@aws-sdk/client-bedrock-runtime");

import { stream } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { assistant, model as baseModel } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { NativePayloadSources } from "../dist/flow-control/native-payload-sources.js";
import { copyFlowPayload } from "../dist/flow-control/payload-copy.js";

const model = {
	...baseModel,
	id: "anthropic.claude-sonnet-4-20250514-v1:0",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://fixture.invalid",
};
const user = (content = "hello") => ({ role: "user", content, timestamp: 1 });
const image = { type: "image", mimeType: "image/png", data: "YWJj" };
async function fixture(messages, change = () => {}) {
	const capture = { members: messages.flatMap((m, index) => (m.role === "assistant" ? [] : [{ index }])) };
	capture.model = { members: capture.members.map(({ index }) => ({ sourceIndex: index, index, status: "intact" })) };
	const sources = new NativePayloadSources(messages, capture, model.api);
	let receipts, wire;
	const observed = [];
	const send = BedrockRuntimeClient.prototype.send;
	const patched = mock.method(BedrockRuntimeClient.prototype, "send", function (command, ...args) {
		this.config.requestHandler = {
			async handle(request) {
				wire = JSON.parse(request.body);
				throw new Error("captured transport");
			},
			destroy() {},
		};
		return send.call(this, command, ...args);
	});
	try {
		const result = await stream(
			model,
			{ messages },
			{
				region: "us-east-1",
				cacheRetention: "long",
				env: {
					AWS_ACCESS_KEY_ID: "fixture",
					AWS_SECRET_ACCESS_KEY: "fixture",
					AWS_PROFILE: "",
					HTTP_PROXY: "",
					HTTPS_PROXY: "",
					ALL_PROXY: "",
					NO_PROXY: "*",
					no_proxy: "*",
				},
				onMessageConverted(source, output) {
					observed.push(source);
					sources.observe(source, output);
				},
				onPayload(payload) {
					const final = change(payload) ?? payload;
					const copied = copyFlowPayload(final, model.api);
					receipts = sources.inspect(model.api, final, copied.owned);
					return copied.owned;
				},
			},
		).result();
		assert.match(result.errorMessage, /captured transport/);
	} finally {
		patched.mock.restore();
	}
	assert.ok(wire);
	return { receipts, wire, observed };
}

test("Bedrock receipts follow equal text and binary images through AWS serialization", async () => {
	const messages = [user(), user(), user([{ type: "text", text: "picture" }, image])];
	const f = await fixture(messages);
	assert.deepEqual(f.observed, messages);
	assert.deepEqual(
		f.receipts.map((r) => [r.index, r.disposition]),
		[
			[0, "included"],
			[1, "included"],
			[2, "included"],
		],
	);
	assert.equal(f.wire.messages[2].content[1].image.source.bytes, "YWJj");
});

for (const mode of [
	"edit",
	"image",
	"clone",
	"duplicate",
	"omit",
	"host-copy",
	"cache-extra",
	"binary-string",
	"unsupported-part",
])
	test(`Bedrock source disposition after ${mode}`, async () => {
		const f = await fixture([user([{ type: "text", text: "picture" }, image])], (payload) => {
			const row = payload.messages[0];
			if (mode === "edit") row.content[0].text = "changed";
			if (mode === "binary-string") row.content[1].image.source.bytes = "YWJj";
			if (mode === "image") row.content[1].image.source.bytes[0] = 0;
			if (mode === "clone") return structuredClone(payload);
			if (mode === "host-copy") return copyFlowPayload(payload, model.api).owned;
			if (mode === "duplicate") payload.messages.push(row);
			if (mode === "omit") payload.messages.pop();
			if (mode === "cache-extra") row.content.push({ cachePoint: { type: "default", text: "hidden" } });
			if (mode === "unsupported-part") row.content[0].extra = "hidden";
		});
		assert.equal(
			f.receipts[0].disposition,
			mode === "host-copy" ? "included" : ["clone", "duplicate", "omit"].includes(mode) ? "unresolved" : "changed",
		);
	});

for (const field of [undefined, "toolUseId", "status", "content"])
	test(`Bedrock grouped tool results preserve independent receipts: ${field ?? "intact"}`, async () => {
		const call = {
			...assistant(),
			content: ["call$1", "call$2"].map((id) => ({ type: "toolCall", id, name: "read", arguments: {} })),
			stopReason: "toolUse",
		};
		const tools = ["call$1", "call$2"].map((toolCallId) => ({
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [{ type: "text", text: " exact \n" }, image],
			isError: true,
			timestamp: 1,
		}));
		const f = await fixture([call, ...tools], (payload) => {
			if (field)
				payload.messages[1].content[0].toolResult[field] =
					field === "status" ? "success" : field === "content" ? [{ text: "changed" }] : "other";
		});
		assert.deepEqual(f.observed, tools);
		assert.deepEqual(
			f.receipts.map((r) => r.disposition),
			[field ? "changed" : "included", "included"],
		);
		assert.equal(f.receipts[1].blockIndex, 1);
		assert.equal(f.wire.messages[1].content[1].toolResult.toolUseId, "call_2");
	});

test("Bedrock does not attribute synthetic orphan results", async () => {
	const call = {
		...assistant(),
		content: [{ type: "toolCall", id: "orphan", name: "read", arguments: {} }],
		stopReason: "toolUse",
	};
	const input = user();
	const f = await fixture([call, input]);
	assert.deepEqual(f.observed, [input]);
	assert.equal(f.receipts[0].disposition, "included");
});

for (const content of [
	"   ",
	[
		{ type: "text", text: "ok" },
		{ type: "text", text: " " },
	],
	"bad\ud800",
])
	test("Bedrock transformed source content cannot claim exact inclusion", async () => {
		const f = await fixture([user(content)]);
		assert.equal(f.receipts[0].disposition, "changed");
	});

test("Bedrock user projection preserves serialized images and validates tool ordering", async () => {
	const { bedrockFlowPayload } = await import("../dist/flow-control/bedrock-payload.js");
	const f = await fixture([user([{ type: "text", text: "picture" }, image])]);
	assert.deepEqual(bedrockFlowPayload(f.wire)[0].content, [{ type: "text", text: "picture" }, image]);
	assert.throws(
		() =>
			bedrockFlowPayload({
				messages: [
					{
						role: "user",
						content: [{ toolResult: { toolUseId: "missing", content: [{ text: "done" }], status: "success" } }],
					},
				],
			}),
		/unmatched/,
	);
	assert.throws(
		() => bedrockFlowPayload({ messages: [{ role: "assistant", content: [{ toolUse: { toolUseId: "pending" } }] }] }),
		/lacks required tool results/,
	);
});
