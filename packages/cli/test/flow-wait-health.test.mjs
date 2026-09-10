import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assessFlowHealth,
	nextFlowHealthCheck,
	retainFlowHealthEvidence,
	validateFlowHealthPolicy,
} from "../dist/flow-control/wait-health.js";

const policy = (overrides = {}) => ({
	name: "sweep-progress-v1",
	evidence: "sweep step counter",
	freshnessMs: 60_000,
	probeTimeoutMs: 5_000,
	graceMs: 10_000,
	cadenceMs: 30_000,
	...overrides,
});
const evidence = (overrides = {}) => ({
	policy: "sweep-progress-v1",
	revision: 1,
	observedAt: 1_000,
	state: "healthy",
	...overrides,
});

test("a policy the host cannot act on is rejected at registration", () => {
	assert.deepEqual(validateFlowHealthPolicy(policy()), policy());
	for (const [field, value] of [
		["name", ""],
		["evidence", "   "],
		["freshnessMs", 0],
		["probeTimeoutMs", -1],
		["cadenceMs", 1.5],
		["graceMs", -1],
	])
		assert.throws(() => validateFlowHealthPolicy(policy({ [field]: value })), { code: "schema" }, `${field}`);
	// A cadence past freshness would call every healthy execution stale at its own next check.
	assert.throws(() => validateFlowHealthPolicy(policy({ cadenceMs: 60_001 })), {
		code: "schema",
		message: /cadence must not exceed/,
	});
	assert.doesNotThrow(() => validateFlowHealthPolicy(policy({ cadenceMs: 60_000, graceMs: 0 })));
	// Extra producer fields are dropped rather than retained, so stored policies stay comparable.
	assert.equal(validateFlowHealthPolicy({ ...policy(), extra: "x" }).extra, undefined);
});

test("replayed or reordered evidence cannot refresh health", () => {
	const first = retainFlowHealthEvidence(undefined, evidence({ revision: 4, observedAt: 4_000 }));
	assert.equal(first.revision, 4);
	// Equal and lower revisions are replays; the retained observation stands.
	assert.equal(retainFlowHealthEvidence(first, evidence({ revision: 4, observedAt: 9_000 })), first);
	assert.equal(retainFlowHealthEvidence(first, evidence({ revision: 3, observedAt: 9_000 })), first);
	assert.equal(retainFlowHealthEvidence(first, evidence({ revision: 5, observedAt: 5_000 })).revision, 5);
	assert.throws(() => retainFlowHealthEvidence(first, evidence({ policy: "other" })), { code: "identity" });
	for (const invalid of [
		{ revision: -1 },
		{ observedAt: 1.5 },
		{ state: "maybe" },
		{ marker: "" },
		{ detail: "x".repeat(4097) },
	])
		assert.throws(() => retainFlowHealthEvidence(undefined, evidence(invalid)), { code: "schema" });
});

test("fresh evidence keeps the wait live and schedules the next check by cadence", () => {
	const verdict = assessFlowHealth(policy(), evidence({ observedAt: 1_000 }), 1_000, 0, 1_000_000);
	assert.equal(verdict.state, "healthy");
	assert.equal(verdict.evidence, "sweep step counter");
	// Cadence first, but never past the moment the evidence itself goes stale.
	assert.equal(verdict.nextCheckAt, 31_000);
	assert.equal(assessFlowHealth(policy({ cadenceMs: 60_000 }), evidence(), 55_000, 0, 1_000_000).nextCheckAt, 61_000);
});

test("an explicit producer failure ends the wait without waiting out its grace", () => {
	const verdict = assessFlowHealth(
		policy(),
		evidence({ state: "unhealthy", detail: "step counter went backwards" }),
		1_000,
		0,
		1_000_000,
	);
	assert.deepEqual(verdict, {
		state: "unhealthy",
		evidence: "sweep step counter",
		reason: "step counter went backwards",
	});
	// Without detail the decision still names the evidence it acted on.
	assert.match(assessFlowHealth(policy(), evidence({ state: "unhealthy" }), 1_000, 0, 1_000_000).reason, /unhealthy/);
});

test("stale evidence ends the wait only after its bounded probe and grace", () => {
	const stale = evidence({ observedAt: 1_000 });
	// Stale at 61_000; probe 5_000 and grace 10_000 push the decision to 76_000.
	assert.equal(assessFlowHealth(policy(), stale, 60_999, 0, 1_000_000).state, "healthy");
	const probing = assessFlowHealth(policy(), stale, 61_000, 0, 1_000_000);
	assert.equal(probing.state, "healthy", "staleness alone is not a decision");
	assert.equal(probing.nextCheckAt, 76_000, "the next check is when grace runs out");
	assert.equal(assessFlowHealth(policy(), stale, 75_999, 0, 1_000_000).state, "healthy");
	const unknown = assessFlowHealth(policy(), stale, 76_000, 0, 1_000_000);
	assert.equal(unknown.state, "health-unknown");
	assert.match(unknown.reason, /last reported at 1000/);
});

test("an execution that never reports is judged from when evidence was first expected", () => {
	// `since` is registration or reattachment, so a restart does not restart the grace from zero.
	const never = assessFlowHealth(policy(), undefined, 76_000, 0, 1_000_000);
	assert.equal(never.state, "health-unknown");
	assert.match(never.reason, /never reported/);
	assert.equal(assessFlowHealth(policy(), undefined, 76_000, 10_000, 1_000_000).state, "healthy");
	// Evidence older than the moment the policy started applying cannot backdate the grace window.
	const backdated = assessFlowHealth(policy(), evidence({ observedAt: 0 }), 80_000, 20_000, 1_000_000);
	assert.equal(backdated.state, "healthy");
});

test("health never renews the hard deadline", () => {
	const expiresAt = 20_000;
	const verdict = assessFlowHealth(policy(), evidence({ observedAt: 1_000 }), 1_000, 0, expiresAt);
	assert.equal(verdict.state, "healthy");
	// The check itself is scheduled by cadence, but nothing past expiry is ever scheduled.
	assert.equal(nextFlowHealthCheck(verdict, expiresAt), undefined, "no check is scheduled past the deadline");
	assert.equal(nextFlowHealthCheck(verdict, 40_000), 31_000);
	for (const state of ["unhealthy", "health-unknown"])
		assert.equal(nextFlowHealthCheck({ state, reason: "r", evidence: "e" }, 1_000_000), undefined);
});

test("assessment refuses evidence from another policy or an invalid clock", () => {
	assert.throws(() => assessFlowHealth(policy(), evidence({ policy: "other" }), 1, 0, 2), { code: "identity" });
	for (const [now, since, expires] of [
		[-1, 0, 2],
		[1, -1, 2],
		[1, 0, -2],
	])
		assert.throws(() => assessFlowHealth(policy(), undefined, now, since, expires), { code: "schema" });
	assert.throws(() => assessFlowHealth(policy({ freshnessMs: 0 }), undefined, 1, 0, 2), { code: "schema" });
});
