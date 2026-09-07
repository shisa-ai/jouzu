import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	observedSubagentResults,
	subagentCompletionBatch,
	terminalReadObservation,
} from "../dist/subagents/completion.js";
import { subagentComponent } from "../dist/subagents/render.js";

const run = (id = "run") => ({
	id,
	parentSessionId: "parent",
	status: "completed",
	role: { id: "coder" },
	result: "Done",
	completion: { revision: `revision-${id}`, handled: false },
});
const page = (item, start, end, total, overrides = {}) => {
	const content = [{ type: "text", text: `Terminal output ${start}-${end}` }];
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "subagent",
			content,
			details: { terminalRead: terminalReadObservation(item, start, { nextOffset: end, totalBytes: total }, content) },
			...overrides,
		},
	};
};
test("terminal observation requires exact revision, session, contiguous pages and unchanged content", () => {
	const item = run();
	const first = page(item, 0, 10, 20);
	const last = page(item, 10, 20, 20);
	assert.deepEqual([...observedSubagentResults([item], [last, first])], [item.id]);
	for (const entries of [
		[first],
		[last],
		[first, page(item, 11, 20, 20)],
		[first, page(item, 10, 20, 21)],
		[first, page({ ...item, parentSessionId: "other" }, 10, 20, 20)],
		[first, page({ ...item, completion: { revision: "new" } }, 10, 20, 20)],
		[first, page(item, 10, 20, 20, { isError: true })],
		[first, page(item, 10, 20, 20, { content: [{ type: "text", text: "Removed by policy" }] })],
		[first, page({ ...item, status: "running" }, 10, 20, 20)],
	]) {
		assert.equal(observedSubagentResults([item], entries).size, 0);
	}
	assert.equal(terminalReadObservation({ ...item, completion: undefined }, 0, { totalBytes: 20 }, []), undefined);
});
test("batch bounds the whole envelope, counts omitted failures and keeps review warnings", () => {
	const runs = Array.from({ length: 100 }, (_, i) => ({
		...run(`run-${i}`),
		status: i < 50 ? "completed" : "failed",
		role: { id: "日本語".repeat(100) },
		result: "結果✅".repeat(5000),
	}));
	runs[0].review = { status: "changed" };
	const records = runs.map((item) => ({ id: item.id, ...item.completion }));
	const message = subagentCompletionBatch("parent", "batch", records, runs);
	const envelope = {
		...message,
		customType: "jouzu-subagent-result",
		details: { ...message.details, inbox: { version: 1, sessionId: "parent", batchId: "batch" } },
	};
	assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 4096);
	assert.match(message.content, /completed 50, failed 50/);
	assert.equal(message.details.omitted, 100 - message.details.runs.length);
	assert.ok(message.details.omitted > 0);
	assert.match(message.content, /subagent list/);
	assert.match(message.content, /Review candidate changed/);
	assert.ok(message.details.runs.every((item) => item.status === "failed" || item.reviewWarning));
	const component = subagentComponent(message.details, { fg: (_role, text) => text }, true);
	for (const width of [48, 80]) {
		const lines = component.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(lines.join("\n"), /omitted/);
		assert.match(lines.join("\n"), /Review candidate/);
	}
});
