import assert from "node:assert/strict";
import { test } from "node:test";
import { assembledSession, installedProducerExtensions, syntheticProducer } from "./fixtures/flow-assembly.mjs";
import { campaignScript, liveWait } from "./fixtures/flow-campaign.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a settled descriptor is fenced against replay, and the fence outlives its attempt", async (t) => {
	const f = await assembledSession(t);
	const synthetic = syntheticProducer();
	const registration = f.ingress.registerProducer(synthetic.producer);
	t.after(() => registration.dispose());
	synthetic.offer([{ id: "intent-1", revision: "1" }]);
	await registration.changed();
	await settle();
	assert.equal(f.bodies.length, 1);
	const state = await f.ingress.branch().attachment.ledger.snapshot();
	assert.equal(state.attempts.length, 1);

	// The producer offers the same descriptor again after its attempt settled.
	synthetic.offer([{ id: "intent-1", revision: "1" }]);
	await registration.changed();
	await settle();
	assert.equal(f.bodies.length, 1, "the settled revision is fenced, not resurrected");

	// Retiring the attempt must keep that fence.
	await f.ingress.retireLedgerHistory(0);
	assert.deepEqual((await f.ingress.branch().attachment.ledger.snapshot()).attempts, []);
	synthetic.offer([{ id: "intent-1", revision: "1" }]);
	await registration.changed();
	await settle();
	assert.equal(f.bodies.length, 1, "the fence survives retirement");
});

test("cancelling an already dispatched submission is refused with the correct control named", async (t) => {
	const f = await assembledSession(t);
	await f.session.prompt("first");
	assert.equal(f.bodies.length, 1);
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	assert.equal(record.status, "retained");
	// A returned submission is already consumed; cancelling it is refused with a reason that names
	// the correct control rather than silently succeeding.
	await assert.rejects(
		f.ingress.cancelRetained(record.id, record.revision),
		(error) => error.code === "transition" && /native queue or request cancellation/.test(error.message),
	);
	assert.equal(f.bodies.length, 1);
});

test("ledger retirement is refused while controller work is active", async (t) => {
	const f = await assembledSession(t);
	const synthetic = syntheticProducer();
	const registration = f.ingress.registerProducer(synthetic.producer);
	t.after(() => registration.dispose());
	let release;
	synthetic.state.buildGate = new Promise((resolve) => {
		release = resolve;
	});
	synthetic.offer([{ id: "intent-1", revision: "1" }]);
	const scheduling = registration.changed();
	await settle();
	// Mid-build the attempt is reserved, so retirement must not run against a moving ledger.
	await assert.rejects(f.ingress.retireLedgerHistory(0), (error) => ["busy", "stale"].includes(error.code));
	release();
	await scheduling;
	await settle();
	assert.equal(f.bodies.length, 1);
});

test("a blocked lane holds its continuation across idle maintenance", async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: campaignScript({ goal: "Hold across maintenance" }),
	});
	await f.session.prompt("start the sweep and wait");
	const wait = await liveWait(f.ingress, "the lane is blocked on one live wait");
	const before = f.bodies.length;

	// Idle maintenance runs the full retirement pass; it must not release held work or the wait.
	await f.ingress.retireWaitHistory(true);
	await f.ingress.archiveSubmissionHistory();
	await f.ingress.retireRequestHistory();
	await f.ingress.retireLedgerHistory();
	await settle();

	assert.equal(f.bodies.length, before, "maintenance sends no continuation for the blocked lane");
	const held = await liveWait(f.ingress, "the wait is still live after maintenance");
	assert.equal(held.token, wait.token, "maintenance neither retires nor reissues the live wait");
	assert.equal(held.expiresAt, wait.expiresAt, "and does not restart its deadline");
	const work = (await f.ingress.branch().attachment.waits.authoritySnapshot()).work;
	assert.ok(
		work.some((record) => record.id === wait.workId && record.owner === "multiloop"),
		"the campaign work it depends on is not retired underneath it",
	);
	assert.deepEqual(f.errors, []);
});

test("a producer whose descriptor changes after retirement is admitted once", async (t) => {
	const f = await assembledSession(t);
	const synthetic = syntheticProducer();
	const registration = f.ingress.registerProducer(synthetic.producer);
	t.after(() => registration.dispose());
	synthetic.offer([{ id: "intent-1", revision: "1" }]);
	await registration.changed();
	await settle();
	await f.ingress.retireLedgerHistory(0);
	synthetic.offer([{ id: "intent-1", revision: "2" }]);
	await registration.changed();
	await settle();
	assert.equal(f.bodies.length, 2, "a new revision runs after retirement");
	assert.deepEqual(synthetic.state.builds, ["intent-1", "intent-1"]);
	// And the new revision is itself fenced afterwards.
	synthetic.offer([{ id: "intent-1", revision: "2" }]);
	await registration.changed();
	await settle();
	assert.equal(f.bodies.length, 2);
});
