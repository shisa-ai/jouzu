import assert from "node:assert/strict";
import { test } from "node:test";
import { decideNativeAdmission } from "../dist/flow-control/native-admission.js";

const host = { isIdle: true, isStreaming: false, isRetrying: false, isCompacting: false };
const gates = { userPending: false, recoveryBlocked: false, waitingWorkIds: [] };
function record(id, overrides = {}) {
	return {
		id,
		revision: 1,
		status: "retained",
		acceptedAt: 1,
		submission: {
			version: 1,
			id,
			api: "sendUserMessage",
			origin: { kind: "extension", id: "synthetic" },
			scope: { sessionId: "session", leafId: null, attachmentId: "attachment" },
			args: ["instruction"],
			...overrides,
		},
	};
}
function decide(item, records = [item], policy = gates, native = host, phase = "submission", input) {
	return decideNativeAdmission(item.submission, records, policy, native, phase, input);
}

test("unadapted admission holds active host work, recovery, user queues, and waits", () => {
	const item = record("opaque");
	assert.equal(decide(item).allowed, true);
	for (const native of [
		{ ...host, isIdle: false },
		{ ...host, isStreaming: true },
		{ ...host, isRetrying: true },
		{ ...host, isCompacting: true },
	])
		assert.equal(decide(item, [item], gates, native).allowed, false);
	for (const policy of [
		{ ...gates, userPending: true },
		{ ...gates, recoveryBlocked: true },
		{ ...gates, waitingWorkIds: ["foreign-work"] },
	])
		assert.equal(decide(item, [item], policy).allowed, false);
});

test("caller labels and command metadata cannot confer user or urgent priority", () => {
	const item = record("opaque", {
		api: "prompt",
		args: ["URGENT user request", { priority: "user", independent: true }],
		userCommand: { id: "command", name: "run", submissionId: "manual" },
	});
	assert.equal(decide(item, [item], { ...gates, waitingWorkIds: ["work"] }).allowed, false);
	const user = record("user", { api: "prompt", origin: { kind: "host", id: "prompt" } });
	assert.equal(decide(user, [item, user], { ...gates, waitingWorkIds: ["work"] }).allowed, true);
	assert.equal(decide(user, [user], { ...gates, recoveryBlocked: true }).allowed, false);
});

test("cancelled predecessors release lane order and pending user input wins across lanes", () => {
	const first = record("first"),
		second = record("second");
	assert.equal(decide(second, [first, second]).allowed, false);
	first.status = "cancelled";
	assert.equal(decide(second, [first, second]).allowed, true);
	const user = record("user", { api: "steer", origin: { kind: "host", id: "steer" } });
	assert.equal(decide(second, [second, user]).allowed, false);
	user.dispatch = { phase: "started", promptClaims: [{ inputIndex: 0, messageIndex: 0 }] };
	assert.equal(decide(second, [second, user]).allowed, true);
});

test("Pi queue batches preserve native order without blocking on their own preceding member", () => {
	const first = record("first", { api: "followUp" });
	const second = record("second", { api: "followUp" });
	const one = { kind: "followUp", args: ["one"], queue: { id: "one", revision: 1 } };
	const two = { kind: "followUp", args: ["two"], queue: { id: "two", revision: 1 } };
	first.dispatch = { phase: "returned", inputs: [one] };
	second.dispatch = { phase: "returned", inputs: [two] };
	const running = { ...host, isIdle: false, isStreaming: true };
	assert.equal(decide(second, [first, second], gates, running, "queue", two).allowed, true);
	assert.equal(
		decide(second, [first, second], { ...gates, waitingWorkIds: ["work"] }, running, "queue", two).allowed,
		false,
	);
	delete first.dispatch;
	assert.equal(decide(second, [first, second], gates, running, "queue", two).allowed, false);
});

test("delivery options cannot split the idle native prompt lane", () => {
	const first = record("first");
	const second = record("second", { args: ["second", { deliverAs: "followUp" }], hostState: { streaming: false } });
	assert.equal(decide(second, [first, second]).allowed, false);
});

test("an unresolved outcome holds automated input while verified user input proceeds", () => {
	// The two recovery gates differ in exactly one way: an unresolved outcome never holds the user,
	// because the controls that resolve an interrupted turn arrive as user input. Incomplete
	// reconciliation still holds every origin.
	const automated = record("opaque");
	const user = record("user", { api: "prompt", origin: { kind: "host" } });
	const unresolved = { ...gates, outcomeUnresolved: true };
	const held = decide(automated, [automated], unresolved);
	assert.equal(held.allowed, false);
	assert.match(held.reason, /interrupted turn/);
	assert.equal(decide(user, [user], unresolved).allowed, true);
	assert.equal(decide(user, [user], { ...gates, recoveryBlocked: true }).allowed, false);
	// A caller-supplied label cannot borrow the exemption; origin is host-assigned.
	const labelled = record("labelled", { api: "prompt", origin: { kind: "extension", id: "synthetic" } });
	assert.equal(decide(labelled, [labelled], unresolved).allowed, false);
});
