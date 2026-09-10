import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowModelInput } from "../dist/flow-control/model-input.js";
import { flowRunContainsUserInput } from "../dist/flow-control/run-input.js";

const assistant = { role: "assistant", content: [{ type: "text", text: "done" }] };
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const composed = (...kinds) =>
	FlowModelInput.compose(
		"a",
		kinds.map((kind) => ({ id: kind, revision: "1", kind, text: "{}" })),
		4096,
	);
const flowText = (composition, kind) =>
	composition.content.find((part) => part.type === "text" && JSON.parse(part.text).kind === kind)?.text;
const flow = (kind = "result", composition = composed(kind)) => ({
	role: "user",
	content: [{ type: "text", text: flowText(composition, kind) }],
});

test("only the block after the last assistant turn counts as this run's input", () => {
	const composition = composed("result");
	// History is replayed on every request, so an answered question must not withhold permission.
	assert.equal(
		flowRunContainsUserInput([user("earlier question"), assistant, flow("result", composition)], composition),
		false,
	);
	assert.equal(flowRunContainsUserInput([user("earlier"), assistant, user("new question")], composition), true);
	// With no assistant turn yet, everything is this run's input.
	assert.equal(flowRunContainsUserInput([user("first ever")], composition), true);
	assert.equal(flowRunContainsUserInput([flow("result", composition)], composition), false);
	assert.equal(flowRunContainsUserInput([], composition), false);
});

test("user text joining a composed wake withholds permission", () => {
	const composition = composed("wait", "result");
	// The ordering that matters: the user typed while a wake was composing, either side of it.
	assert.equal(
		flowRunContainsUserInput([assistant, flow("result", composition), user("actually, stop")], composition),
		true,
	);
	assert.equal(
		flowRunContainsUserInput([assistant, user("actually, stop"), flow("result", composition)], composition),
		true,
	);
	assert.equal(
		flowRunContainsUserInput([assistant, flow("wait", composition), flow("result", composition)], composition),
		false,
	);
});

test("anything not in the active composition counts as user input", () => {
	const composition = composed("result");
	// Wrongly granting silence loses a reply the user asked for, so every doubtful shape withholds.
	for (const content of [
		"plain string content",
		[],
		[{ type: "image", image: "x" }],
		[{ type: "text", text: "not json" }],
		[{ type: "text", text: "{}" }],
		[{ type: "text", text: '{"flowInput":' }],
		[{ type: "text", text: JSON.stringify({ other: 1 }) }],
		[{ type: "text", text: JSON.stringify({ flowInput: 1 }) }],
		undefined,
	])
		assert.equal(
			flowRunContainsUserInput([assistant, { role: "user", content }], composition),
			true,
			JSON.stringify(content),
		);
	// A partly flow-injected message is still user input: one ordinary part is instruction.
	assert.equal(
		flowRunContainsUserInput(
			[
				assistant,
				{ role: "user", content: [...flow("result", composition).content, { type: "text", text: "and also" }] },
			],
			composition,
		),
		true,
	);
	assert.equal(flowRunContainsUserInput("not a list", composition), true);
});

test("a marker from another attempt or composition does not authorize silence", () => {
	const active = composed("result");
	const otherAttempt = FlowModelInput.compose(
		"other",
		[{ id: "result", revision: "1", kind: "result", text: "{}" }],
		4096,
	);
	const otherItem = composed("wait");
	assert.equal(flowRunContainsUserInput([assistant, flow("result", otherAttempt)], active), true);
	assert.equal(flowRunContainsUserInput([assistant, flow("wait", otherItem)], active), true);
});

test("non-user roles in the trailing block are ignored", () => {
	const composition = composed("result");
	// Tool results and system notices are not instruction and must not withhold permission.
	assert.equal(
		flowRunContainsUserInput(
			[assistant, { role: "toolResult", content: [{ type: "text", text: "x" }] }, flow("result", composition)],
			composition,
		),
		false,
	);
});
