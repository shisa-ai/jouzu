import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelFlowWait, createFlowWait, expireFlowWait, reconcileFlowWait } from "../dist/flow-control/wait-state.js";

const scope = { sessionId: "session", branchId: "branch" };
const handles = ["a", "b"].map((handle) => ({ producer: "bg", handle, execution: `exec-${handle}`, until: "exit" }));
const observations = (...states) => states.map((state, index) => ({ ...handles[index], scope, workId: "work", state }));
const request = (mode = "all") => ({
	token: "wait",
	scope,
	workId: "work",
	reason: "Wait for measurements",
	mode,
	on: handles,
	expiresAt: 100,
});
const waiting = (mode = "all") => createFlowWait(request(mode), observations("pending", "pending"), 0, 100);

test("all and any waits use exact predicate states without changing deadlines", () => {
	assert.equal(reconcileFlowWait(waiting(), observations("satisfied", "pending"), 50).state, "waiting");
	assert.equal(reconcileFlowWait(waiting("any"), observations("satisfied", "pending"), 50).state, "resolved");
	assert.equal(reconcileFlowWait(waiting(), observations("satisfied", "satisfied"), 99).state, "resolved");
	assert.equal(reconcileFlowWait(waiting(), observations("pending", "pending"), 60).expiresAt, 100);
});
test("already completed dependencies resolve at declaration", () => {
	assert.equal(createFlowWait(request(), observations("satisfied", "satisfied"), 0, 100).state, "resolved");
});
for (const failure of ["failed", "cancelled", "missing"])
	test(`impossible dependencies end all waits but preserve possible any waits: ${failure}`, () => {
		assert.equal(reconcileFlowWait(waiting(), observations(failure, "pending"), 1).state, "failed");
		assert.equal(reconcileFlowWait(waiting("any"), observations(failure, "pending"), 1).state, "waiting");
		assert.equal(reconcileFlowWait(waiting("any"), observations(failure, failure), 1).state, "failed");
	});
test("expiry and cancellation retain one immutable terminal outcome", () => {
	const expired = reconcileFlowWait(waiting(), observations("pending", "satisfied"), 100);
	assert.equal(expired.state, "expired");
	assert.deepEqual(expired.unmet, [handles[0]]);
	assert.deepEqual(cancelFlowWait(expired, "late cancel", 101), expired);
	assert.deepEqual(reconcileFlowWait(expired, [], 200), expired);
	const cancelled = cancelFlowWait(waiting(), "redirected", 20);
	assert.deepEqual(reconcileFlowWait(cancelled, [], 200), cancelled);
	assert.deepEqual(cancelFlowWait(cancelled, "again", 21), cancelled);
});
test("foreign, reused, incomplete, and duplicate handle evidence is rejected", () => {
	for (const mutate of [
		(items) => {
			items[0].execution = "new-execution";
		},
		(items) => {
			items[0].scope = { ...scope, branchId: "foreign" };
		},
		(items) => {
			items[0].workId = "foreign";
		},
		(items) => {
			items[0].until = "unsupported";
		},
		(items) => {
			items[1] = items[0];
		},
		(items) => {
			items.pop();
		},
	]) {
		const items = observations("pending", "pending");
		mutate(items);
		assert.throws(() => createFlowWait(request(), items, 0, 100), { code: "identity" });
	}
});
test("declarations require bounded deadlines, check times, and nonempty unique handles", () => {
	for (const patch of [
		{ on: [] },
		{ on: [handles[0], handles[0]] },
		{ expiresAt: 0 },
		{ checkAt: 100 },
		{ checkAt: 0 },
		{ reason: " " },
	])
		assert.throws(() => createFlowWait({ ...request(), ...patch }, observations("pending", "pending"), 0, 100), {
			code: "schema",
		});
});
test("caller mutation cannot alter declared handles or terminal snapshots", () => {
	const input = structuredClone(request());
	const wait = createFlowWait(input, observations("pending", "pending"), 0, 100);
	input.on[0].execution = "changed";
	const next = reconcileFlowWait(wait, observations("pending", "pending"), 10);
	next.on[0].execution = "changed";
	assert.equal(wait.on[0].execution, "exec-a");
});

test("session policy caps the effective deadline returned by declaration", () => {
	const wait = createFlowWait({ ...request(), expiresAt: 1000 }, observations("pending", "pending"), 10, 50);
	assert.equal(wait.expiresAt, 60);
	assert.equal(reconcileFlowWait(wait, observations("pending", "pending"), 60).state, "expired");
});

test("expiry needs no new observation and late cancellation cannot suppress it", () => {
	const wait = waiting();
	assert.equal(expireFlowWait(wait, 99).state, "waiting");
	const expired = expireFlowWait(wait, 100);
	assert.equal(expired.state, "expired");
	assert.deepEqual(expired.observations, wait.observations);
	assert.deepEqual(expired.unmet, wait.unmet);
	assert.deepEqual(cancelFlowWait(wait, "too late", 100), expired);
	assert.deepEqual(expireFlowWait(expired, 200), expired);
});
