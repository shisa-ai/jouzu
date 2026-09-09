import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { stream } from "@earendil-works/pi-ai/api/pi-messages";
import { assistant, model as baseModel } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { NativePayloadSources } from "../dist/flow-control/native-payload-sources.js";
import { copyFlowPayload } from "../dist/flow-control/payload-copy.js";
import { piMessagesFlowPayload } from "../dist/flow-control/pi-messages-payload.js";

const model = { ...baseModel, api: "pi-messages", provider: "radius", baseUrl: "https://fixture.invalid" };
const user = (content = "hello") => ({ role: "user", content, timestamp: 1 });
const image = { type: "image", mimeType: "image/png", data: "YWJj" };
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function fixture(messages, change = () => {}) {
	const capture = { members: messages.flatMap((message, index) => (message.role === "assistant" ? [] : [{ index }])) };
	capture.model = { members: capture.members.map(({ index }) => ({ sourceIndex: index, index, status: "intact" })) };
	const sources = new NativePayloadSources(messages, capture, model.api);
	let receipts, wire;
	const observed = [];
	const result = await stream(
		model,
		{ messages },
		{
			apiKey: "fixture",
			onMessageConverted(source, output) {
				assert.equal(source, output);
				observed.push(source);
				sources.observe(source, output);
			},
			onPayload(payload) {
				const final = change(payload) ?? payload;
				const owned = copyFlowPayload(final, model.api).owned;
				receipts = sources.inspect(model.api, final, owned);
				return owned;
			},
			fetch: async (_url, init) => {
				wire = JSON.parse(init.body);
				return new Response(`data: ${JSON.stringify({ type: "done", reason: "stop", usage: assistant().usage })}\n\n`, {
					headers: { "content-type": "text/event-stream" },
				});
			},
		},
	).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	return { receipts, wire, observed };
}

test("Pi message receipts match transported equal text and inline images", async () => {
	const messages = [user(), user(), user([{ type: "text", text: "picture" }, image])];
	const f = await fixture(messages);
	assert.deepEqual(f.observed, messages);
	assert.deepEqual(f.wire.context.messages, messages);
	assert.deepEqual(
		f.receipts.map((row) => [row.sourceIndex, row.index, row.disposition]),
		[
			[0, 0, "included"],
			[1, 1, "included"],
			[2, 2, "included"],
		],
	);
	assert.deepEqual(
		f.receipts.map((row) => row.contentHash),
		piMessagesFlowPayload(f.wire).map((row) => digest(row.content)),
	);
});

for (const mode of [
	"edit",
	"image",
	"clone",
	"duplicate",
	"omit",
	"host-copy",
	"unsupported-part",
	"host-copy-accessor",
	"host-copy-to-json",
	"host-copy-proxy",
])
	test(`Pi messages ${mode} preserves nested source disposition`, async () => {
		const f = await fixture([user([{ type: "text", text: "picture" }, image])], (payload) => {
			const row = payload.context.messages[0];
			if (mode === "edit") row.content[0].text = "other";
			if (mode === "image") row.content[1].data = "b3RoZXI=";
			if (mode === "unsupported-part") row.content[0].extra = "other";
			if (mode === "clone") return JSON.parse(JSON.stringify(payload));
			if (mode === "host-copy") return copyFlowPayload(payload, model.api).owned;
			if (mode === "host-copy-accessor") {
				const context = payload.context;
				Object.defineProperty(payload, "context", { enumerable: true, get: () => context });
				return copyFlowPayload(payload, model.api).owned;
			}
			if (mode === "host-copy-to-json") {
				payload.context.toJSON = () => ({ messages: [row] });
				return copyFlowPayload(payload, model.api).owned;
			}
			if (mode === "host-copy-proxy") {
				payload.context = new Proxy(payload.context, {});
				return copyFlowPayload(payload, model.api).owned;
			}
			if (mode === "duplicate") payload.context.messages.push(row);
			if (mode === "omit") payload.context.messages.pop();
		});
		assert.equal(
			f.receipts[0].disposition,
			mode === "host-copy"
				? "included"
				: ["edit", "image", "unsupported-part"].includes(mode)
					? "changed"
					: "unresolved",
		);
	});

for (const field of [undefined, "toolCallId", "toolName", "isError"])
	test(`Pi tool-result receipt retains identity and error status: ${field ?? "intact"}`, async () => {
		const call = {
			...assistant(),
			content: [{ type: "toolCall", id: "call$1", name: "read", arguments: {} }],
			stopReason: "toolUse",
		};
		const tool = {
			role: "toolResult",
			toolCallId: "call$1",
			toolName: "read",
			content: [{ type: "text", text: " exact \n" }, image],
			isError: true,
			timestamp: 1,
		};
		const f = await fixture([call, tool], (payload) => {
			if (field) payload.context.messages[1][field] = field === "isError" ? false : "changed";
		});
		assert.deepEqual(f.observed, [tool]);
		assert.equal(f.receipts[0].disposition, field ? "changed" : "included");
		if (!field) {
			assert.deepEqual(f.wire.context.messages[1], tool);
			assert.equal(f.receipts[0].contentHash, digest(tool.content));
			assert.deepEqual(piMessagesFlowPayload(f.wire), []);
		}
	});

test("Pi payload projection rejects unmatched or missing tool results", () => {
	assert.throws(
		() =>
			piMessagesFlowPayload({ context: { messages: [{ role: "toolResult", toolCallId: "missing", content: [] }] } }),
		/unmatched/,
	);
	assert.throws(
		() =>
			piMessagesFlowPayload({
				context: { messages: [{ role: "assistant", content: [{ type: "toolCall", id: "pending" }] }] },
			}),
		/lacks required tool results/,
	);
});
