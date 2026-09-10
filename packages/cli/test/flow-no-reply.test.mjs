import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFlowNoReply, flowNoReplyPermission, flowNoReplyToken } from "../dist/flow-control/no-reply.js";

const member = (kind, id = kind) => ({ id, revision: "1", kind, required: true, contentHash: "a".repeat(64) });
const request = (id = "r1", containsUserInput = false) => ({ id, inclusion: [], containsUserInput, handedOff: true });
const attempt = (overrides = {}) => ({
	id: "attempt-1",
	generation: 1,
	phase: "settled",
	members: [member("result")],
	history: [],
	requests: [request()],
	...overrides,
});
const state = (current = attempt()) => ({
	schemaVersion: 1,
	scope: { sessionId: "s", branchId: "b" },
	generation: 1,
	revision: 1,
	activeAttemptId: current.id,
	attempts: [current],
});

test("only a run carrying nothing the user is owed an answer about gets permission", () => {
	assert.equal(flowNoReplyPermission(attempt()), flowNoReplyToken("attempt-1"));
	// Requested work and wait decisions are things the model was asked to act on.
	for (const kind of ["work", "wait", "user", "alert"])
		assert.equal(flowNoReplyPermission(attempt({ members: [member(kind)] })), undefined, kind);
	// One result beside requested work does not make the run notification-only.
	assert.equal(flowNoReplyPermission(attempt({ members: [member("result"), member("work")] })), undefined);
	// User input is judged when the tool runs rather than when the offer is composed, so nothing
	// here inspects requests. A run with no members has nothing to notify about, so silence would
	// say nothing about nothing.
	assert.equal(flowNoReplyPermission(attempt({ members: [] })), undefined);
});

test("permission is bound to one attempt and refuses user input anywhere in its run", () => {
	const current = attempt();
	const token = flowNoReplyPermission(current);
	assert.deepEqual(checkFlowNoReply(state(current), token), { allowed: true, attemptId: "attempt-1" });

	// Queued user input joining the run appends a request. The offer was already made, so the
	// withdrawal has to happen at call time rather than by changing the token.
	const joined = attempt({ requests: [request("r1"), request("r2", true)] });
	assert.equal(checkFlowNoReply(state(joined), token).reason, "carries-user-input");
	// A user message that joined mid-run stays behind the assistant turns that followed it, so
	// the newest request alone can no longer see it. Every request of the run is owed a reply.
	const trailed = attempt({ requests: [request("r1", true), request("r2"), request("r3")] });
	assert.equal(checkFlowNoReply(state(trailed), token).reason, "carries-user-input");

	// A token from another attempt, or for an attempt that is no longer current, cannot terminate.
	assert.equal(checkFlowNoReply(state(current), flowNoReplyToken("attempt-2")).reason, "stale-run");
	const superseded = { ...state(current), activeAttemptId: "attempt-2" };
	assert.equal(checkFlowNoReply(superseded, token).reason, "unknown-run");
});

test("a malformed or absent token is refused rather than trusted", () => {
	const current = attempt();
	for (const token of [undefined, null, "", 0, {}, ["x"], "not-a-token"])
		assert.equal(checkFlowNoReply(state(current), token).allowed, false, JSON.stringify(token) ?? "undefined");
	// The refusal names why, so a model can tell a stale permission from an ineligible run.
	assert.equal(
		checkFlowNoReply(state(attempt({ requests: [request("r1", true)] })), flowNoReplyToken("attempt-1")).reason,
		"carries-user-input",
	);
	assert.equal(
		checkFlowNoReply(state(attempt({ members: [member("work")] })), flowNoReplyToken("attempt-1")).reason,
		"carries-requested-work",
	);
});

test("tokens differ across attempts", () => {
	// Binding is what stops a permission being replayed, so distinct runs must not collide.
	const tokens = new Set(["a", "b", "a1", "ab", ""].map((id) => flowNoReplyToken(id)));
	assert.equal(tokens.size, 5, "no two attempts share a token, including ambiguous concatenations");
});
