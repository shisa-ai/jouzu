import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { FlowWaitHealthMonitor } from "../dist/flow-control/wait-health-monitor.js";

const scope = { sessionId: "session", branchId: "branch" };
const policy = {
	name: "sweep-progress-v1",
	evidence: "sweep step counter",
	freshnessMs: 60_000,
	probeTimeoutMs: 5_000,
	graceMs: 10_000,
	cadenceMs: 30_000,
};
const monitored = { producer: "bg", handle: "display", execution: "exec", until: "exit", health: policy.name };

/** A controllable clock so a check fires when the test says, not when the wall clock drifts there. */
function clock(start = 0) {
	let now = start;
	const timers = [];
	return {
		now: () => now,
		after(delayMs, callback) {
			const timer = { at: now + delayMs, callback, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		/** Advance and fire every timer that came due, the way a real clock would. */
		async advance(ms) {
			now += ms;
			for (const timer of [...timers]) {
				if (timer.cancelled || timer.at > now) continue;
				timers.splice(timers.indexOf(timer), 1);
				timer.callback();
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		},
		get pending() {
			return timers.filter((timer) => !timer.cancelled).length;
		},
	};
}

async function fixture(t, { policyFor = () => policy, onProbe } = {}) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-health-monitor-"));
	const attachment = await PiFlowAttachment.open(root, scope);
	const errors = [];
	const time = clock();
	const store = attachment.waits;
	await store.registerWork("work", "lane", 0);
	await store.shareWork("work", "lane", 1, "bg", 0);
	await store.registerExecution(
		{
			producer: "bg",
			handle: "display",
			execution: "exec",
			workId: "work",
			revision: 1,
			predicates: [{ until: "exit", state: "pending" }],
		},
		2,
		0,
	);
	await store.declareOwned(
		"lane",
		2,
		{
			token: "token",
			scope,
			workId: "work",
			reason: "sweep must keep moving",
			mode: "all",
			on: [monitored],
			expiresAt: 10_000_000,
		},
		0,
		10_000_000,
	);
	const probes = [];
	const monitor = new FlowWaitHealthMonitor({
		store,
		policy: policyFor,
		// The producer answers a probe by reporting fresh evidence, the way a real one would.
		probe: async (handle) => {
			probes.push(handle.execution);
			await onProbe?.(store, time.now());
		},
		clock: time,
		onError: (error) => errors.push(error),
	});
	t.after(async () => {
		await monitor.stop();
		await attachment.close();
		await rm(root, { recursive: true, force: true });
	});
	return { attachment, store, monitor, errors, time, probes };
}
const waitState = async (store) => (await store.snapshot())[0].state;

test("fresh evidence keeps the wait live and reschedules by cadence", async (t) => {
	const f = await fixture(t);
	await f.store.observeExecutionHealth(
		monitored,
		{ policy: policy.name, revision: 1, observedAt: 0, state: "healthy" },
		0,
	);
	await f.monitor.refresh();
	assert.equal(await waitState(f.store), "waiting");
	assert.equal(f.time.pending, 1, "a check is scheduled rather than the monitor going idle");

	// Cadence is 30s and freshness 60s, so a check at 30s still finds the evidence fresh.
	await f.time.advance(30_000);
	assert.equal(await waitState(f.store), "waiting");
	assert.deepEqual(f.errors, []);
});

test("an execution that stops reporting ends the wait after its probe and grace", async (t) => {
	const f = await fixture(t);
	await f.store.observeExecutionHealth(
		monitored,
		{ policy: policy.name, revision: 1, observedAt: 0, state: "healthy" },
		0,
	);
	await f.monitor.refresh();

	// Stale at 60s; the probe timeout and grace push the decision to 75s. Nothing before it decides.
	await f.time.advance(60_000);
	assert.equal(await waitState(f.store), "waiting");
	await f.time.advance(14_999);
	assert.equal(await waitState(f.store), "waiting", "grace has not run out");
	await f.time.advance(1);
	assert.equal(await waitState(f.store), "health-unknown");
	// The decision is recorded on the execution itself, which is what makes it survive a reopen.
	const [execution] = (await f.store.authoritySnapshot()).executions;
	assert.deepEqual(execution.predicates, [{ until: "exit", state: "health-unknown" }]);
	assert.deepEqual(f.errors, []);
});

test("an explicit unhealthy report decides without waiting out grace", async (t) => {
	const f = await fixture(t);
	await f.store.observeExecutionHealth(
		monitored,
		{ policy: policy.name, revision: 1, observedAt: 0, state: "unhealthy", detail: "counter went backwards" },
		0,
	);
	await f.monitor.refresh();
	assert.equal(await waitState(f.store), "unhealthy");
	assert.equal(f.time.pending, 0, "a decided wait schedules no further check");
});

test("a replayed report cannot refresh health or postpone the decision", async (t) => {
	const f = await fixture(t);
	await f.store.observeExecutionHealth(
		monitored,
		{ policy: policy.name, revision: 4, observedAt: 0, state: "healthy" },
		0,
	);
	await f.time.advance(70_000);
	// A lower revision arriving late carries a newer timestamp but is still a replay.
	await f.store.observeExecutionHealth(
		monitored,
		{ policy: policy.name, revision: 3, observedAt: 70_000, state: "healthy" },
		70_000,
	);
	const [execution] = (await f.store.authoritySnapshot()).executions;
	assert.equal(execution.healthEvidence.revision, 4);
	assert.equal(execution.healthEvidence.observedAt, 0, "the replay did not refresh the observation time");
	await f.monitor.refresh();
	await f.time.advance(5_001);
	assert.equal(await waitState(f.store), "health-unknown");
});

test("a terminal result wins over a pending health decision", async (t) => {
	const f = await fixture(t);
	await f.store.observeExecutionHealth(
		monitored,
		{ policy: policy.name, revision: 1, observedAt: 0, state: "healthy" },
		0,
	);
	await f.monitor.refresh();
	// The job finishes before its evidence goes stale.
	await f.store.observeExecution(
		{ producer: "bg", handle: "display", execution: "exec" },
		2,
		[{ until: "exit", state: "satisfied" }],
		10_000,
	);
	await f.time.advance(120_000);
	assert.equal(await waitState(f.store), "resolved", "health never displaces a real result");
	assert.deepEqual(f.errors, []);
});

test("a detached producer leaves the wait on its deadline rather than deciding", async (t) => {
	const f = await fixture(t, { policyFor: () => undefined });
	await f.monitor.refresh();
	await f.time.advance(1_000_000);
	assert.equal(await waitState(f.store), "waiting", "the hard deadline is the guarantee that never needs a producer");
	assert.deepEqual(f.errors, []);
});

test("a quiet execution is probed before grace decides, and fresh evidence keeps it alive", async (t) => {
	let reported = 1;
	const f = await fixture(t, {
		// A live but quiet task reports nothing on its own; asked directly, it answers.
		onProbe: async (store, now) =>
			store.observeExecutionHealth(
				monitored,
				{ policy: policy.name, revision: ++reported, observedAt: now, state: "healthy" },
				now,
			),
	});
	await f.store.observeExecutionHealth(
		monitored,
		{ policy: policy.name, revision: 1, observedAt: 0, state: "healthy" },
		0,
	);
	await f.monitor.refresh();

	// Evidence goes stale at 60s. Without a probe the wait would be called health-unknown at 75s.
	await f.time.advance(60_000);
	assert.deepEqual(f.probes, ["exec"], "the producer is asked exactly once for this stale window");
	assert.equal(await waitState(f.store), "waiting");
	await f.time.advance(30_000);
	assert.equal(await waitState(f.store), "waiting", "the answer refreshed health rather than ending the wait");
	assert.deepEqual(f.errors, []);
});

test("a producer that cannot answer its probe still ends the wait when grace runs out", async (t) => {
	const f = await fixture(t, {
		onProbe: async () => {
			throw new Error("producer is gone");
		},
	});
	await f.store.observeExecutionHealth(
		monitored,
		{ policy: policy.name, revision: 1, observedAt: 0, state: "healthy" },
		0,
	);
	await f.monitor.refresh();
	await f.time.advance(60_000);
	assert.deepEqual(f.probes, ["exec"]);
	// A throwing producer is reported, not swallowed, and grace still decides on its own schedule.
	assert.equal(f.errors.length, 1);
	await f.time.advance(15_000);
	assert.equal(await waitState(f.store), "health-unknown");
});
