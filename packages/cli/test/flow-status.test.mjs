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
	assert.equal(formatFlowStatus(projectFlowStatus(scope, [], [], []), 0), "Nothing is held, withheld, or waiting.");
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
			// A completed campaign is finished, not held; an active one needs no mention.
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
	assert.equal(text.includes("running"), false);
});
