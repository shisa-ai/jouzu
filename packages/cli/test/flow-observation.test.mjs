import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
	flowObservationHash,
	flowObservationOf,
	flowObservations,
	selectedObservations,
} from "../dist/flow-control/observation.js";

const content = [{ type: "text", text: "task: completed" }];
const toolResult = { role: "toolResult", toolCallId: "read", toolName: "bg_task", isError: false, content };

test("a projection exposes what a producer needs and nothing of the host's message shape", () => {
	const [projected] = flowObservations([toolResult]);
	assert.deepEqual(projected, {
		index: 0,
		kind: "toolResult",
		failed: false,
		toolCallId: "read",
		toolName: "bg_task",
		contentHash: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
	});
	// Non-tool messages are still offered so indices line up with the host's own list.
	const mixed = flowObservations([{ role: "user", content: "hi" }, toolResult]);
	assert.deepEqual(
		mixed.map((item) => [item.index, item.kind]),
		[
			[0, "other"],
			[1, "toolResult"],
		],
	);
	// A host variant without content still projects, rather than throwing on the union's edge cases.
	assert.equal(flowObservations([{ role: "bashExecution" }])[0].contentHash, flowObservationHash(undefined));
	assert.equal(flowObservations([{ role: "toolResult", isError: true, content }])[0].failed, true);
});

test("stored evidence and live context project identically", () => {
	// The reconciliation path compares a retained message against a live one; they must agree.
	const { index, ...live } = flowObservations([toolResult])[0];
	assert.equal(index, 0);
	assert.deepEqual(flowObservationOf(toolResult), live);
});

test("a producer cannot name an observation outside the offered context", () => {
	assert.deepEqual(selectedObservations([2, 0, 0], 3), [0, 2], "duplicates collapse and order is stable");
	assert.deepEqual(selectedObservations([], 3), []);
	for (const invalid of [[3], [-1], [1.5], [Number.NaN], ["0"]])
		assert.throws(() => selectedObservations(invalid, 3), RangeError, `${JSON.stringify(invalid)}`);
	// Nothing may be selected from an empty context, which is what a producer sees before any turn.
	assert.throws(() => selectedObservations([0], 0), RangeError);
	assert.throws(() => selectedObservations("all", 3), TypeError);
});
