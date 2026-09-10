import assert from "node:assert/strict";
import { test } from "node:test";
import { flowRunContainsUserInput } from "../dist/flow-control/run-input.js";

const assistant = { role: "assistant", content: [{ type: "text", text: "done" }] };
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const flow = (kind = "result") => ({
	role: "user",
	content: [{ type: "text", text: JSON.stringify({ flowInput: ["jouzu-flow", "a", "b", "1"], kind, content: "{}" }) }],
});

test("only the block after the last assistant turn counts as this run's input", () => {
	// History is replayed on every request, so an answered question must not withhold permission.
	assert.equal(flowRunContainsUserInput([user("earlier question"), assistant, flow()]), false);
	assert.equal(flowRunContainsUserInput([user("earlier"), assistant, user("new question")]), true);
	// With no assistant turn yet, everything is this run's input.
	assert.equal(flowRunContainsUserInput([user("first ever")]), true);
	assert.equal(flowRunContainsUserInput([flow()]), false);
	assert.equal(flowRunContainsUserInput([]), false);
});

test("user text joining a composed wake withholds permission", () => {
	// The ordering that matters: the user typed while a wake was composing, either side of it.
	assert.equal(flowRunContainsUserInput([assistant, flow(), user("actually, stop")]), true);
	assert.equal(flowRunContainsUserInput([assistant, user("actually, stop"), flow()]), true);
	assert.equal(flowRunContainsUserInput([assistant, flow("wait"), flow("result")]), false);
});

test("anything not provably flow-injected counts as user input", () => {
	// Wrongly granting silence loses a reply the user asked for, so every doubtful shape withholds.
	for (const content of [
		"plain string content",
		[],
		[{ type: "image", image: "x" }],
		[{ type: "text", text: "not json" }],
		[{ type: "text", text: "{}" }],
		[{ type: "text", text: '{"flowInput":' }],
		[{ type: "text", text: JSON.stringify({ other: 1 }) }],
		undefined,
	])
		assert.equal(flowRunContainsUserInput([assistant, { role: "user", content }]), true, JSON.stringify(content));
	// A partly flow-injected message is still user input: one ordinary part is instruction.
	assert.equal(
		flowRunContainsUserInput([
			assistant,
			{ role: "user", content: [...flow().content, { type: "text", text: "and also" }] },
		]),
		true,
	);
	assert.equal(flowRunContainsUserInput("not a list"), true);
});

test("non-user roles in the trailing block are ignored", () => {
	// Tool results and system notices are not instruction and must not withhold permission.
	assert.equal(
		flowRunContainsUserInput([assistant, { role: "toolResult", content: [{ type: "text", text: "x" }] }, flow()]),
		false,
	);
});
