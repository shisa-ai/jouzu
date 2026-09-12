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

/**
 * A queued user message the host takes is pending work that automated input must wait behind. One
 * the host discards is not, and telling them apart is the only thing that stops a single dropped
 * steer from starving every automated send for the rest of the session.
 *
 * Shapes here mirror a real ledger: a dispatched `steer` carrying one queue input, with and without
 * the claim receipt the host writes when it actually takes the message.
 */
function queuedUser(id, { claimed = false } = {}) {
	const queue = { id: `queue-${id}`, revision: 1 };
	return {
		...record(id, { api: "steer", origin: { kind: "host", id: "terminal" }, args: ["a user message"] }),
		dispatch: {
			operationId: `op-${id}`,
			inputs: [{ kind: "steer", queue }],
			...(claimed ? { queueClaims: [{ ...queue, consumed: true }] } : {}),
		},
	};
}
const reason = (decision) => (decision.allowed ? undefined : decision.reason);

test("automated input waits behind a queued user message the host still holds", () => {
	const automated = record("automated");
	const user = queuedUser("user");
	const live = new Set(["queue-user"]);
	// With or without the live-queue evidence, a message the host still holds outranks automation.
	for (const queue of [undefined, live])
		assert.equal(
			reason(
				decideNativeAdmission(automated.submission, [user, automated], gates, host, "submission", undefined, queue),
			),
			"Input is waiting for queued user work.",
		);
});

test("a queued user message the host discarded stops holding automated input", () => {
	const automated = record("automated");
	const user = queuedUser("user");
	// The host no longer holds it and no claim was ever recorded: it was dropped, not delivered.
	// Without this evidence the record reads as pending forever and nothing automated ever runs.
	assert.equal(
		decideNativeAdmission(automated.submission, [user, automated], gates, host, "submission", undefined, new Set())
			.allowed,
		true,
	);
	// A claimed message is already terminal, so it never held anything either way.
	assert.equal(
		decideNativeAdmission(
			automated.submission,
			[queuedUser("user", { claimed: true }), automated],
			gates,
			host,
			"submission",
			undefined,
			new Set(),
		).allowed,
		true,
	);
});

test("an undispatched user message holds automated input whatever the queue says", () => {
	// Not yet dispatched means not yet offered to the host, so an empty queue is not evidence of
	// anything. Only a record the host was given and then dropped may stop holding.
	const automated = record("automated");
	const pending = record("pending", { api: "steer", origin: { kind: "host", id: "terminal" }, args: ["typed"] });
	for (const queue of [undefined, new Set()])
		assert.equal(
			reason(
				decideNativeAdmission(automated.submission, [pending, automated], gates, host, "submission", undefined, queue),
			),
			"Input is waiting for queued user work.",
		);
});

test("user input is admitted regardless of the queue evidence", () => {
	// The user's own input never waits on this gate; only its origin decides that.
	const user = record("typed", { api: "steer", origin: { kind: "host", id: "terminal" }, args: ["typed"] });
	const blocker = queuedUser("other");
	for (const queue of [undefined, new Set(["queue-other"]), new Set()])
		assert.equal(
			decideNativeAdmission(user.submission, [blocker, user], gates, host, "submission", undefined, queue).allowed,
			true,
		);
});

test("an interrupt pause holds automated input and never the user's own", () => {
	const automated = record("automated");
	const user = record("typed", { api: "steer", origin: { kind: "host", id: "terminal" }, args: ["typed"] });
	const paused = { ...gates, automatedPaused: true };
	assert.equal(
		reason(decideNativeAdmission(automated.submission, [automated], paused, host, "submission")),
		"Automated input is paused until the next user turn is under way.",
	);
	// The gesture means stop what is happening, not stop the user from speaking.
	assert.equal(decideNativeAdmission(user.submission, [user], paused, host, "submission").allowed, true);
	// And it holds on an idle host, where automated input would otherwise be admitted.
	assert.equal(decideNativeAdmission(automated.submission, [automated], gates, host, "submission").allowed, true);
});

test("only an explicit input-free completion releases pending user priority", () => {
	const user = record("user", { api: "prompt", origin: { kind: "host", id: "prompt" } });
	const automated = record("automated");
	for (const phase of ["started", "failed", "returned"]) {
		user.dispatch = { phase };
		assert.equal(decide(automated, [user, automated]).allowed, false);
	}
	user.dispatch = { phase: "returned", noInput: true };
	assert.equal(decide(automated, [user, automated]).allowed, true);
	user.dispatch.inputs = [{ kind: "prompt", args: ["real input"] }];
	assert.equal(decide(automated, [user, automated]).allowed, false);
});
