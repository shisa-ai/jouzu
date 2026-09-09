import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { stream } from "@earendil-works/pi-ai/api/mistral-conversations";
import { assistant, model as baseModel } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { mistralFlowPayload } from "../dist/flow-control/mistral-payload.js";
import { NativePayloadSources } from "../dist/flow-control/native-payload-sources.js";
import { copyFlowPayload } from "../dist/flow-control/payload-copy.js";

const model = {
	...baseModel,
	api: "mistral-conversations",
	provider: "mistral",
	id: "mistral-small-latest",
	baseUrl: "https://fixture.invalid",
	input: ["text", "image"],
};
const user = (content = "hello") => ({ role: "user", content, timestamp: 1 });
const picture = { type: "image", mimeType: "image/png", data: "YWJj" };
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function fixture(messages, change = () => {}, overrides = {}) {
	const capture = { members: messages.flatMap((message, index) => (message.role === "assistant" ? [] : [{ index }])) };
	capture.model = { members: capture.members.map(({ index }) => ({ sourceIndex: index, index, status: "intact" })) };
	const sources = new NativePayloadSources(messages, capture, model.api);
	let receipts, wire, projected;
	const observed = [];
	const result = await stream(
		{ ...model, ...overrides },
		{ messages },
		{
			apiKey: "fixture",
			maxRetries: 0,
			onMessageConverted(source, output) {
				observed.push(source);
				sources.observe(source, output);
			},
			onPayload(payload) {
				const final = change(payload) ?? payload;
				const owned = copyFlowPayload(final).owned;
				receipts = sources.inspect(model.api, final, owned);
				try {
					projected = mistralFlowPayload(owned);
				} catch {
					/* Invalid mutations are tested below. */
				}
				return owned;
			},
			fetch: async (_url, init) => {
				wire = JSON.parse(init.body);
				return new Response(
					`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		},
	).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	return { receipts, wire, observed, projected };
}

test("Mistral source receipts match transported equal text and inline images", async () => {
	const messages = [user(), user(), user([{ type: "text", text: "picture" }, picture])];
	const f = await fixture(messages);
	assert.deepEqual(f.observed, messages);
	assert.deepEqual(
		f.receipts.map((row) => [row.sourceIndex, row.index, row.disposition]),
		[
			[0, 0, "included"],
			[1, 1, "included"],
			[2, 2, "included"],
		],
	);
	assert.equal(f.wire.messages[2].content[1].image_url, "data:image/png;base64,YWJj");
	assert.equal(f.wire.messages[2].content[1].imageUrl, undefined);
	assert.deepEqual(
		f.receipts.map((row) => row.contentHash),
		f.projected.map((row) => digest(row.content)),
	);
});

for (const mode of ["edit", "image", "clone", "duplicate", "omit", "host-copy", "extra-content-field"])
	test(`Mistral ${mode} payload retains exact source disposition`, async () => {
		const f = await fixture([user([{ type: "text", text: "picture" }, picture])], (payload) => {
			const row = payload.messages[0];
			if (mode === "edit") row.content[0].text = "other";
			if (mode === "image") row.content[1].imageUrl = "data:image/png;base64,b3RoZXI=";
			if (mode === "extra-content-field") row.content[0].documentUrl = "https://fixture.invalid/document";
			if (mode === "clone") return structuredClone(payload);
			if (mode === "host-copy") return copyFlowPayload(payload).owned;
			if (mode === "duplicate") payload.messages.push(row);
			if (mode === "omit") payload.messages.pop();
		});
		assert.equal(
			f.receipts[0].disposition,
			mode === "host-copy"
				? "included"
				: ["edit", "image", "extra-content-field"].includes(mode)
					? "changed"
					: "unresolved",
		);
	});

test("Mistral observes normalized tool identities and images without adopting synthetic results", async () => {
	const call = {
		...assistant(),
		api: "openai-completions",
		provider: "foreign",
		stopReason: "toolUse",
		content: [
			{ type: "toolCall", id: "call$1|fc_one", name: "read", arguments: {} },
			{ type: "toolCall", id: "orphan|fc_two", name: "read", arguments: {} },
		],
	};
	const tool = {
		role: "toolResult",
		toolCallId: "call$1|fc_one",
		toolName: "read",
		content: [{ type: "text", text: "result" }, picture],
		isError: false,
		timestamp: 1,
	};
	const next = user("continue");
	const f = await fixture([call, tool, next]);
	assert.deepEqual(f.observed, [tool, next]);
	assert.deepEqual(
		f.receipts.map((row) => row.disposition),
		["included", "included"],
	);
	const row = f.wire.messages.find((row) => row.role === "tool" && row.content[0].text === "result");
	assert.match(row.tool_call_id, /^[a-zA-Z0-9]{9}$/);
	assert.equal(row.tool_call_id, f.wire.messages[0].tool_calls[0].id);
	assert.equal(row.content[1].image_url, "data:image/png;base64,YWJj");
	assert.equal(f.wire.messages.filter((row) => row.role === "tool").length, 2);
	assert.equal(f.receipts[0].contentHash, digest(tool.content));
	const changed = await fixture([call, tool, next], (payload) => {
		payload.messages[1].toolCallId = "other0000";
	});
	assert.equal(changed.receipts[0].disposition, "changed");
});

test("Mistral sanitation, image omission, and tool trimming do not prove exact content", async () => {
	const f = await fixture([user("bad\ud800"), user([picture]), user([])], undefined, { input: ["text"] });
	assert.deepEqual(
		f.receipts.map((row) => row.disposition),
		["changed", "changed", "unresolved"],
	);
	const call = {
		...assistant(),
		content: [{ type: "toolCall", id: "tool00001", name: "read", arguments: {} }],
		stopReason: "toolUse",
	};
	const tool = {
		role: "toolResult",
		toolCallId: "tool00001",
		toolName: "read",
		content: [{ type: "text", text: " trimmed " }],
		isError: false,
		timestamp: 1,
	};
	assert.equal((await fixture([call, tool])).receipts[0].disposition, "changed");
});
