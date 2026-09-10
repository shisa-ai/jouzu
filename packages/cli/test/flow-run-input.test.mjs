import assert from "node:assert/strict";
import { test } from "node:test";
import { flowRunContainsUserInput } from "../dist/flow-control/run-input.js";

const assistant = { role: "assistant" };
const user = { role: "user" };
const hash = "a".repeat(64);
/**
 * One retained source per entry, placed at the model-input index the entry names. Controller-composed
 * input is never a retained source, so it never appears here at all; `users()` names the operations
 * the host verified as user submissions.
 */
function capture(sources) {
	return {
		hash,
		count: sources.length,
		members: sources.map((source, index) => ({
			index,
			operationId: source.operation,
			messageHash: hash,
			prompt: { inputIndex: 0, messageIndex: 0 },
		})),
		model: {
			hash,
			count: sources.length,
			members: sources.map((source, index) =>
				source.at === undefined
					? { sourceIndex: index, status: "unresolved" }
					: { sourceIndex: index, status: "intact", index: source.at, messageHash: hash },
			),
		},
	};
}
const users = (...operations) => new Set(operations);

test("only sources at or after the last assistant turn count as this run's input", () => {
	// History replays on every request, so an answered question must not withhold permission.
	const messages = [user, assistant, user];
	assert.equal(flowRunContainsUserInput(messages, capture([{ operation: "old", at: 0 }]), users("old")), false);
	assert.equal(flowRunContainsUserInput(messages, capture([{ operation: "new", at: 2 }]), users("new")), true);
	// With no assistant turn yet, every source is this run's input.
	assert.equal(flowRunContainsUserInput([user], capture([{ operation: "first", at: 0 }]), users("first")), true);
	// A run whose only content is controller-composed carries no retained source at all.
	assert.equal(flowRunContainsUserInput([assistant, user], capture([]), users("any")), false);
});

test("a source the host did not mark as user cannot withhold permission", () => {
	const messages = [assistant, user];
	const carried = capture([{ operation: "extension", at: 1 }]);
	// Origin is what the host assigned. An automated send inside this run's block is not instruction,
	// and no label or marker in its content can change that.
	assert.equal(flowRunContainsUserInput(messages, carried, users("someone-else")), false);
	assert.equal(flowRunContainsUserInput(messages, carried, users("extension")), true);
});

test("user input joining a composed wake withholds permission from either side", () => {
	const messages = [assistant, user, user, user];
	assert.equal(flowRunContainsUserInput(messages, capture([{ operation: "typed", at: 3 }]), users("typed")), true);
	assert.equal(flowRunContainsUserInput(messages, capture([{ operation: "typed", at: 1 }]), users("typed")), true);
});

test("missing or unplaceable evidence withholds permission", () => {
	const messages = [assistant, user];
	// No conversion record: nothing establishes where a source landed.
	assert.equal(flowRunContainsUserInput(messages, { hash, count: 0, members: [] }, users("typed")), true);
	assert.equal(flowRunContainsUserInput(messages, undefined, users("typed")), true);
	// No resolved origins to compare against.
	assert.equal(flowRunContainsUserInput(messages, capture([{ operation: "typed", at: 1 }]), undefined), true);
	// A user source conversion could not place is treated as inside this run.
	assert.equal(flowRunContainsUserInput(messages, capture([{ operation: "typed" }]), users("typed")), true);
	assert.equal(flowRunContainsUserInput(undefined, capture([{ operation: "typed", at: 1 }]), users("typed")), true);
});

test("a mismatched conversion position cannot silence a user source", () => {
	const carried = capture([{ operation: "typed", at: 0 }]);
	// The model record must describe the member it sits beside; a mismatch is not evidence of place.
	carried.model.members[0].sourceIndex = 99;
	assert.equal(flowRunContainsUserInput([user, assistant], carried, users("typed")), true);
});
