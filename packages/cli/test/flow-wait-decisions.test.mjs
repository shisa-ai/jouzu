import assert from "node:assert/strict";
import { test } from "node:test";
import { createFlowWaitDecisionProducer } from "../dist/flow-control/wait-decisions.js";
import { createFlowWait, expireFlowWait } from "../dist/flow-control/wait-state.js";

function terminal(branchId = "branch") {
	const scope = { sessionId: "session", branchId };
	const on = Array.from({ length: 64 }, (_, i) => ({
		producer: "bg",
		handle: `job-${i}`,
		execution: `exec-${i}`,
		until: "exit",
	}));
	return expireFlowWait(
		createFlowWait(
			{ token: "token", scope, workId: "work", reason: "dependency", mode: "all", on, expiresAt: 100 },
			on.map((handle) => ({ ...handle, scope, workId: "work", state: "pending" })),
			0,
			100,
		),
		100,
	);
}
const signal = () => new AbortController().signal;
test("wait decisions preserve full unmet evidence and isolate identical tokens in different branches", async () => {
	const wait = terminal();
	const producer = createFlowWaitDecisionProducer({ snapshot: async () => [wait] });
	const [intent] = await producer.snapshot(signal());
	const item = await producer.build(intent, signal());
	const body = JSON.parse(item.text).wait;
	assert.deepEqual(body.unmet, wait.unmet);
	assert.deepEqual(body.observations, wait.observations);
	assert.equal(body.expiresAt, 100);
	assert.ok(Buffer.byteLength(item.text) > 4096);
	const foreign = createFlowWaitDecisionProducer({ snapshot: async () => [terminal("other")] });
	assert.notEqual((await foreign.snapshot(signal()))[0].id, intent.id);
	await assert.rejects(foreign.build(intent, signal()), { code: "stale" });
	await assert.rejects(producer.build({ ...intent, revision: "2" }, signal()), { code: "stale" });
});
test("cancelled producer reads cannot return decision input after storage resumes", async () => {
	const controller = new AbortController();
	const producer = createFlowWaitDecisionProducer({
		snapshot: async () => {
			controller.abort(new Error("branch detached"));
			return [terminal()];
		},
	});
	await assert.rejects(producer.snapshot(controller.signal), /branch detached/);
});
