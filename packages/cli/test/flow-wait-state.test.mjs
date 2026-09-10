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

const monitored = ["a", "b"].map((handle) => ({
	producer: "bg",
	handle,
	execution: `exec-${handle}`,
	until: "exit",
	health: "sweep-progress-v1",
}));
const monitoredObservations = (...states) =>
	states.map((state, index) => ({ ...monitored[index], scope, workId: "work", state }));
const monitoredRequest = (mode = "all", overrides = {}) => ({
	token: "wait",
	scope,
	workId: "work",
	reason: "Wait for measurements",
	mode,
	on: monitored,
	expiresAt: 100,
	...overrides,
});
const monitoredWaiting = (mode = "all", overrides = {}) =>
	createFlowWait(monitoredRequest(mode, overrides), monitoredObservations("pending", "pending"), 0, 100);

test("a health decision ends the wait with its own outcome rather than a generic failure", () => {
	// The distinction a decision turn needs: a job that failed, versus one that stopped proving it works.
	assert.equal(
		reconcileFlowWait(monitoredWaiting(), monitoredObservations("unhealthy", "pending"), 50).state,
		"unhealthy",
	);
	assert.equal(
		reconcileFlowWait(monitoredWaiting(), monitoredObservations("health-unknown", "pending"), 50).state,
		"health-unknown",
	);
	assert.equal(reconcileFlowWait(monitoredWaiting(), monitoredObservations("failed", "pending"), 50).state, "failed");
	// An explicit unhealthy report outranks an execution that merely stopped reporting.
	assert.equal(
		reconcileFlowWait(monitoredWaiting(), monitoredObservations("health-unknown", "unhealthy"), 50).state,
		"unhealthy",
	);
	// Resolution and expiry still outrank any health decision.
	assert.equal(
		reconcileFlowWait(monitoredWaiting("any"), monitoredObservations("satisfied", "unhealthy"), 50).state,
		"resolved",
	);
	assert.equal(
		reconcileFlowWait(monitoredWaiting(), monitoredObservations("unhealthy", "pending"), 100).state,
		"expired",
	);
});

test("an any-mode wait keeps waiting while a healthy dependency is still pending", () => {
	const wait = monitoredWaiting("any");
	assert.equal(reconcileFlowWait(wait, monitoredObservations("unhealthy", "pending"), 50).state, "waiting");
	assert.equal(reconcileFlowWait(wait, monitoredObservations("unhealthy", "failed"), 50).state, "unhealthy");
	assert.equal(reconcileFlowWait(wait, monitoredObservations("health-unknown", "failed"), 50).state, "health-unknown");
});

test("a health decision requires the dependency to have requested a policy", () => {
	// Deadline-only dependencies cannot be ended by a health state they never opted into.
	for (const state of ["unhealthy", "health-unknown"])
		assert.throws(() => reconcileFlowWait(waiting(), observations(state, "pending"), 50), { code: "identity" });
});

test("an expected check time must fall between now and the effective deadline", () => {
	assert.equal(monitoredWaiting("all", { checkAt: 40 }).checkAt, 40);
	for (const checkAt of [0, -1, 100, 101, 1.5])
		assert.throws(() => monitoredWaiting("all", { checkAt }), { code: "schema" });
	// The session cap lowers the effective deadline, so a check inside the requested one can still fail.
	assert.throws(
		() => createFlowWait(monitoredRequest("all", { checkAt: 80 }), monitoredObservations("pending", "pending"), 0, 50),
		{ code: "schema" },
	);
	// Health requested with an unusable name is refused with the rest of the identity checks.
	assert.throws(
		() =>
			createFlowWait(
				{ ...monitoredRequest(), on: [{ ...monitored[0], health: "" }] },
				[{ ...monitored[0], health: "", scope, workId: "work", state: "pending" }],
				0,
				100,
			),
		{ code: "schema" },
	);
});
