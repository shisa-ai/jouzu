import assert from "node:assert/strict";
import { test } from "node:test";
import { formatFlowStatus, projectFlowStatus } from "../dist/flow-control/flow-status.js";

const scope = { sessionId: "session", branchId: "branch" };
const wait = (overrides = {}) => ({
	version: 1,
	token: "token-1",
	scope,
	workId: "multiloop-work:1",
	reason: "the sweep must finish",
	mode: "all",
	on: [],
	createdAt: 0,
	expiresAt: 1_800_000,
	state: "waiting",
	unmet: [{ producer: "bg", handle: "bg-1", execution: "e1", until: "exit" }],
	observations: [],
	...overrides,
});

test("status reports only holds a user can act on", () => {
	const status = projectFlowStatus(
		scope,
		[
			{ id: "s1", revision: 1, admission: "held", delivery: "none", attemptIds: [], reason: "Waiting for user work." },
			{ id: "s2", revision: 3, admission: "pending", delivery: "none", attemptIds: [] },
			// Held with no recorded reason: nothing actionable to show, so it is not listed.
			{ id: "s3", revision: 1, admission: "held", delivery: "none", attemptIds: [] },
			{ id: "s4", revision: 1, admission: "cancelled", delivery: "none", attemptIds: [], reason: "Cancelled." },
		],
		[],
		[],
	);
	assert.deepEqual(status.held, [{ id: "s1", revision: 1, reason: "Waiting for user work." }]);
	assert.deepEqual(status.retryable, []);
	assert.deepEqual(status.waiting, []);
	assert.deepEqual(status.scope, scope);
});

test("a withheld request is offered for retry until one exists", () => {
	const request = (overrides = {}) => ({
		requestId: "r1",
		operationId: "o1",
		outcome: "withheld",
		hold: { hash: "a".repeat(64), reason: "required-input" },
		sources: [],
		...overrides,
	});
	const view = (requests) => [
		{ id: "s1", revision: 1, admission: "held", delivery: "none", attemptIds: [], nativeRequests: requests },
	];
	assert.deepEqual(projectFlowStatus(scope, view([request()]), [], []).retryable, [
		{ submissionId: "s1", requestId: "r1", hash: "a".repeat(64), reason: "required-input" },
	]);
	// Once a retry is authorized the hold is someone else's turn, so it is not offered twice.
	assert.deepEqual(projectFlowStatus(scope, view([request({ retryRequestId: "r2" })]), [], []).retryable, []);
	// A settled request carries no hold.
	assert.deepEqual(
		projectFlowStatus(scope, view([request({ outcome: "success", hold: undefined })]), [], []).retryable,
		[],
	);
});

test("waits report their owner, their original deadline, and unmet dependencies", () => {
	const status = projectFlowStatus(
		scope,
		[],
		[wait(), wait({ token: "token-2", state: "resolved" }), wait({ token: "token-3", workId: "unowned" })],
		[
			{
				id: "multiloop-work:1",
				owner: "multiloop",
				participants: [],
				revision: 2,
				createdAt: 0,
			},
		],
	);
	assert.deepEqual(status.waiting, [
		{
			token: "token-1",
			workId: "multiloop-work:1",
			owner: "multiloop",
			reason: "the sweep must finish",
			expiresAt: 1_800_000,
			unmet: 1,
		},
		{
			token: "token-3",
			workId: "unowned",
			reason: "the sweep must finish",
			expiresAt: 1_800_000,
			unmet: 1,
		},
	]);
});

test("the rendered status names the deadline and the retry command", () => {
	const status = projectFlowStatus(
		scope,
		[
			{
				id: "s1",
				revision: 1,
				admission: "held",
				delivery: "none",
				attemptIds: [],
				reason: "Input is waiting for host retry or compaction.",
				nativeRequests: [
					{
						requestId: "r1",
						operationId: "o1",
						outcome: "withheld",
						hold: { hash: "b".repeat(64), reason: "required-context" },
						sources: [],
					},
				],
			},
		],
		[wait()],
		[],
	);
	const text = formatFlowStatus(status, 0);
	assert.match(text, /expires in 30m/);
	assert.match(text, /1 unmet/);
	assert.match(text, /token token-1/);
	assert.match(text, /Input is waiting for host retry or compaction\./);
	assert.match(text, /\/flow retry r1/);
	// A past deadline is stated rather than shown as negative time.
	assert.match(formatFlowStatus(status, 3_600_000), /past its deadline/);
	assert.equal(
		formatFlowStatus(projectFlowStatus(scope, [], [], []), 0),
		"Nothing is held, withheld, waiting, or unresolved.",
	);
	// Work a producer still names but this session cannot run is stated rather than dropped silently.
	const stranded = projectFlowStatus(scope, [], [], [], [{ producer: "multiloop", description: "lane sweep (run)" }]);
	assert.deepEqual(stranded.unaccountable, [{ producer: "multiloop", description: "lane sweep (run)" }]);
	assert.match(formatFlowStatus(stranded, 0), /Not accounted for in this session\n- multiloop: lane sweep \(run\)/);
});

test("held work is listed with the reason it was held, and finished work is not", () => {
	const work = (id, state, reason) => ({
		id,
		owner: "multiloop",
		participants: [],
		revision: 2,
		createdAt: 0,
		...(state ? { lifecycle: { state, changedAt: 10, reason } } : {}),
	});
	const status = projectFlowStatus(
		scope,
		[],
		[],
		[
			work("sweep", "paused", "Set paused from /flow."),
			work("retired", "stopped", "Set stopped from /flow."),
			// A completed campaign is finished rather than held, and it can take no further turn.
			work("finished", "completed", "done"),
			work("running"),
		],
	);
	assert.deepEqual(status.suspended, [
		{ id: "sweep", owner: "multiloop", state: "paused", reason: "Set paused from /flow." },
		{ id: "retired", owner: "multiloop", state: "stopped", reason: "Set stopped from /flow." },
	]);
	const text = formatFlowStatus(status, 0);
	assert.match(text, /Held work\n- multiloop sweep: paused \(Set paused from \/flow\.\)/);
	assert.equal(text.includes("finished"), false);
	// Work that is neither held nor waiting still takes turns, so its identity stays listed.
	assert.deepEqual(status.active, [{ id: "running", owner: "multiloop", waits: 0 }]);
});

test("active work is a nameable pause and stop target, waiting or not", () => {
	const campaign = (id, lane, overrides = {}) => ({
		id,
		owner: "multiloop",
		participants: ["multiloop"],
		revision: 2,
		createdAt: 0,
		binding: { producer: "multiloop", key: [lane, "run-3"] },
		...overrides,
	});
	const status = projectFlowStatus(
		scope,
		[],
		[
			wait({ workId: "gated" }),
			wait({ token: "token-2", workId: "gated" }),
			wait({ token: "token-3", state: "resolved", workId: "quiet" }),
		],
		[
			campaign("gated", "sweep"),
			campaign("quiet", "report"),
			campaign("held", "stalled", { lifecycle: { state: "paused", changedAt: 10, reason: "Set paused from /flow." } }),
			// One user turn's work identity is not a campaign, and a session accumulates one per turn.
			{
				id: "user:1",
				owner: "host-user",
				participants: ["host-user"],
				revision: 1,
				createdAt: 0,
				userInputs: [{ id: "s1", revision: 1 }],
			},
		],
	);
	assert.deepEqual(status.active, [
		{ id: "gated", owner: "multiloop", campaign: ["sweep", "run-3"], waits: 2 },
		{ id: "quiet", owner: "multiloop", campaign: ["report", "run-3"], waits: 0 },
	]);
	const text = formatFlowStatus(status, 0);
	// The campaign with no live wait is exactly the one the controls could not name before.
	assert.match(text, /Active work\n- multiloop gated \(sweep run-3\): 2 live waits/);
	assert.match(
		text,
		/- multiloop quiet \(report run-3\): no live wait\n {2}pause with: \/flow pause quiet\n {2}stop with: \/flow stop quiet/,
	);
	assert.equal(text.includes("user:1"), false);
	assert.equal(text.includes("/flow pause held"), false);
});

test("an interrupted turn is listed with both decisions the user can make", () => {
	const status = projectFlowStatus(
		scope,
		[],
		[],
		[],
		[],
		[{ id: "attempt-1", reason: "Host is inactive but the provider outcome is unknown." }],
	);
	assert.deepEqual(status.uncertain, [
		{ id: "attempt-1", reason: "Host is inactive but the provider outcome is unknown." },
	]);
	const text = formatFlowStatus(status, 0);
	assert.match(text, /Interrupted, outcome unknown\n- attempt-1: Host is inactive/);
	// Both resolutions are offered because neither is safe to choose automatically: retrying may
	// repeat a turn the provider answered, and discarding may drop one it never received.
	assert.match(text, /\/flow resolve attempt-1 retry/);
	assert.match(text, /\/flow resolve attempt-1 discard/);
});

test("inputs sharing one cause are listed under it once", () => {
	const held = (id, reason) => ({ id, revision: 1, admission: "held", delivery: "none", attemptIds: [], reason });
	const status = projectFlowStatus(
		scope,
		[held("s1", "Waiting for user work."), held("s2", "Waiting for user work."), held("s3", "Queue is revised.")],
		[],
		[],
	);
	const text = formatFlowStatus(status, 0);
	// The cause is stated once and the identities stay whole beneath it, so a reader sees two problems
	// rather than three lines of the same sentence.
	assert.match(text, /Held input\n- Waiting for user work\.\n {2}2 inputs: s1, s2\n- s3: Queue is revised\./);
});
