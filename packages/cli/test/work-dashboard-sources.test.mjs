import assert from "node:assert/strict";
import { test } from "node:test";
import { childWorkSnapshot, createChildWorkSource, flowWorkSnapshot } from "../dist/work-dashboard-sources.js";

const scope = { sessionId: "parent", branchId: "branch" };
const run = {
	id: "child",
	parentSessionId: "parent",
	role: { id: "coder" },
	status: "completed",
	task: "test",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:01:00Z",
	completion: { revision: "r", handled: false },
};
test("children remain parent-session scoped across branches and handling clears attention", () => {
	for (const branchId of ["branch", "other"]) {
		const result = childWorkSnapshot({ ...scope, branchId }, [run, { ...run, parentSessionId: "elsewhere" }]);
		assert.equal(result.units.length, 1);
		assert.equal(result.units[0].attention.length, 1);
		assert.equal(result.units[0].completedAt, Date.parse(run.updatedAt));
	}
	assert.equal(
		childWorkSnapshot(scope, [{ ...run, completion: { ...run.completion, handled: true } }]).units[0].attention.length,
		0,
	);
	assert.equal(childWorkSnapshot(scope, [{ ...run, status: "running" }]).units[0].attention.length, 0);
	assert.equal(
		createChildWorkSource({ runs: () => [], sessionId: () => undefined, subscribe: () => () => {} }).read(scope)
			.complete,
		false,
	);
});
test("flow alerts use branch identity and exclude ordinary waits and holds", () => {
	const status = {
		version: 1,
		scope,
		retryable: [],
		uncertain: [],
		unaccountable: [],
		held: [{ id: "held" }],
		waiting: [{ workId: "child" }],
		active: [{ id: "child" }],
		suspended: [{ id: "paused" }],
	};
	assert.deepEqual(flowWorkSnapshot(scope, status).units, []);
	status.retryable.push({ requestId: "r", hash: "hash" });
	status.uncertain.push({ id: "u" });
	status.unaccountable.push({ producer: "tasks", description: "task #1" });
	const result = flowWorkSnapshot(scope, status);
	assert.equal(result.units.length, 3);
	assert.ok(result.units.every((unit) => unit.attention[0].type === "authority"));
	assert.equal(flowWorkSnapshot({ ...scope, branchId: "other" }, status).complete, false);
	assert.equal(flowWorkSnapshot(scope, undefined).availability, "unknown");
	assert.doesNotThrow(() => JSON.stringify(result));
});
