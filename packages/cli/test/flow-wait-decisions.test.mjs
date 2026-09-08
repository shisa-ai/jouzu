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

for (const variant of ["success", "failure", "changed", "wrong-operation", "wrong-input", "wrong-message"])
	test(`native decision evidence requires successful exact source inclusion: ${variant}`, async () => {
		const wait = terminal(),
			store = { snapshot: async () => [wait] };
		const source = createFlowWaitDecisionProducer(store);
		const [intent] = await source.snapshot(signal()),
			item = await source.build(intent, signal());
		const operationId = "operation";
		const submissions = [
			{
				dispatch: {
					operationId,
					inputs: [
						{
							kind: "context",
							args: [
								{
									customType: "jouzu-wait-context",
									content: JSON.stringify({ waitDecisions: [item] }),
								},
							],
						},
					],
				},
			},
		];
		const requests = [
			{
				outcome: variant === "failure" ? "failure" : "success",
				sourceCapture: {
					members: [
						{
							index: 0,
							operationId: variant === "wrong-operation" ? "other" : operationId,
							prompt: {
								inputIndex: variant === "wrong-input" ? 1 : 0,
								messageIndex: variant === "wrong-message" ? 1 : 0,
							},
						},
					],
				},
				payload: { sources: [{ sourceIndex: 0, disposition: variant === "changed" ? "changed" : "included" }] },
			},
		];
		const producer = createFlowWaitDecisionProducer(store, {
			submissions: { snapshot: async () => submissions },
			requests: { snapshot: async () => requests },
		});
		assert.equal((await producer.snapshot(signal())).length, variant === "success" ? 0 : 1);
	});
