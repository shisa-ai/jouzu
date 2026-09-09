import assert from "node:assert/strict";
import { test } from "node:test";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { assistant, model as baseModel } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { NativePayloadSources } from "../dist/flow-control/native-payload-sources.js";
import { copyFlowPayload } from "../dist/flow-control/payload-copy.js";

const model = { ...baseModel, provider: "openai", api: "openai-responses" };
const user = (content = "hello") => ({ role: "user", content, timestamp: 1 });
function fixture(messages) {
	const capture = {
		members: messages.flatMap((message, index) => (message.role === "assistant" ? [] : [{ index }])),
	};
	capture.model = { members: capture.members.map(({ index }) => ({ sourceIndex: index, index, status: "intact" })) };
	const sources = new NativePayloadSources(messages, capture, model.api);
	const observed = [];
	const input = convertResponsesMessages(model, { messages, systemPrompt: "fixture" }, new Set(["openai"]), {
		onMessageConverted(source, output) {
			observed.push(source);
			sources.observe(source, output);
		},
	});
	const payload = { input };
	return {
		payload,
		observed,
		inspect(value = payload, api = model.api) {
			return sources.inspect(api, value, copyFlowPayload(value).owned);
		},
	};
}

test("Responses receipts preserve source identity for equal text and text/image content", () => {
	const messages = [
		user(),
		user(),
		user([
			{ type: "text", text: "image" },
			{ type: "image", mimeType: "image/png", data: "YWJj" },
		]),
	];
	const f = fixture(messages);
	assert.deepEqual(f.observed, messages);
	assert.deepEqual(
		f.inspect().map((row) => [row.sourceIndex, row.index, row.disposition]),
		[
			[0, 1, "included"],
			[1, 2, "included"],
			[2, 3, "included"],
		],
	);
	assert.ok(f.inspect().every((row) => /^[a-f0-9]{64}$/.test(row.contentHash)));
	assert.ok(f.inspect(f.payload, "openai-completions").every((row) => row.disposition === "unresolved"));
});

for (const mode of ["edit", "image", "clone", "duplicate", "omit", "host-copy"])
	test(`Responses ${mode} payload preserves exact source disposition`, () => {
		const f = fixture([
			user([
				{ type: "text", text: "image" },
				{ type: "image", mimeType: "image/png", data: "YWJj" },
			]),
		]);
		const row = f.payload.input[1];
		let payload = f.payload;
		if (mode === "edit") row.content[0].text = "other";
		if (mode === "image") row.content[1].image_url = "data:image/png;base64,b3RoZXI=";
		if (mode === "clone") payload = structuredClone(payload);
		if (mode === "host-copy") payload = copyFlowPayload(payload).owned;
		if (mode === "duplicate") payload.input.push(row);
		if (mode === "omit") payload.input.pop();
		assert.equal(
			f.inspect(payload)[0].disposition,
			mode === "host-copy" ? "included" : ["edit", "image"].includes(mode) ? "changed" : "unresolved",
		);
	});

test("Responses sanitation and empty messages cannot prove exact observation", () => {
	const f = fixture([user("bad\ud800"), user([])]);
	assert.deepEqual(
		f.inspect().map((row) => row.disposition),
		["changed", "unresolved"],
	);
});

test("Responses observes normalized retained tool results but excludes synthetic orphan results", () => {
	const call = {
		...assistant(),
		...{ api: "openai-completions", provider: "foreign", model: model.id },
		stopReason: "toolUse",
	};
	call.content = [
		{ type: "toolCall", id: "call$1|fc_one", name: "agent_wait", arguments: {} },
		{ type: "toolCall", id: "orphan|fc_two", name: "agent_wait", arguments: {} },
	];
	const tool = {
		role: "toolResult",
		toolCallId: "call$1|fc_one",
		toolName: "agent_wait",
		content: [{ type: "text", text: "resolved" }],
		isError: false,
		timestamp: 1,
	};
	const f = fixture([call, tool, user("continue")]);
	assert.deepEqual(f.observed, [tool, user("continue")]);
	assert.equal(f.payload.input.filter((row) => row.type === "function_call_output").length, 2);
	assert.deepEqual(
		f.inspect().map((row) => row.disposition),
		["included", "included"],
	);
	const row = f.payload.input.find((row) => row.type === "function_call_output" && row.output === "resolved");
	assert.equal(row.call_id, "call_1");
	row.call_id = "other";
	assert.equal(f.inspect()[0].disposition, "changed");
});
