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

const until = async (predicate, label, timeoutMs = 5000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`timed out waiting for ${label}`);
};
const carrying = (bodies, text) => bodies.filter((body) => JSON.stringify(body.messages).includes(text)).length;

test("a provider retry holds automated work and the held work runs once afterwards", async (t) => {
	let failures = 0;
	const f = await assembledSession(t, {
		settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 500 } },
		script: (_body, index) => {
			if (index === 0) {
				failures++;
				return { httpStatus: 503 };
			}
			return { text: `turn ${index}` };
		},
	});
	const synthetic = syntheticProducer();
	const registration = f.ingress.registerProducer(synthetic.producer);
	t.after(() => registration.dispose());

	const prompted = f.session.prompt("user work that fails once");
	await until(() => f.session.isRetrying, "the host to enter its retry backoff");

	// Both paths are offered mid-retry: a producer descriptor and an unadapted extension-style send.
	synthetic.offer([{ id: "intent-1", revision: "1" }]);
	const scheduling = registration.changed();
	const note = f.session.sendCustomMessage("background note", { triggerTurn: true });
	let heldSend = false;
	while (f.session.isRetrying) {
		assert.equal(carrying(f.bodies, "work intent-1"), 0, "no producer work is sent while the host retries");
		assert.equal(carrying(f.bodies, "background note"), 0, "no unadapted send is dispatched while the host retries");
		const records = await f.ingress.branch().attachment.submissions.snapshot();
		const retained = records.find((record) => record.submission.api === "sendCustomMessage");
		heldSend ||= Boolean(retained?.holds?.length);
		await settle();
	}
	assert.ok(heldSend, "the unadapted send is retained under a recorded hold rather than dropped");

	await prompted;
	await scheduling;
	await note;
	assert.equal(failures, 1, "the fixture failed exactly once");
	await until(() => carrying(f.bodies, "work intent-1") === 1, "the held producer work to run after the retry");
	await settle();
	assert.equal(carrying(f.bodies, "work intent-1"), 1, "and to run exactly once");
	assert.deepEqual(synthetic.state.builds, ["intent-1"]);
});

// Compaction summarization calls the session stream function without a flow request checkpoint, so
// the request guard refuses it and manual and automatic compaction both fail while flow control is
// installed. This case states the behaviour the first candidate needs; see the plan's compaction item.
test("compaction holds automated work and the held work runs once afterwards", { todo: true }, async (t) => {
	let releaseSummary;
	const summarizing = new Promise((resolve) => {
		releaseSummary = resolve;
	});
	let summaryIndex;
	const f = await assembledSession(t, {
		// One recent entry is kept, so two turns are enough to give manual compaction something to do.
		settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
		script: (body, index) => {
			// Compaction issues its own summarization request; hold it open so isCompacting stays true.
			if (JSON.stringify(body).includes("summar")) {
				summaryIndex = index;
				return summarizing.then(() => ({ text: "summary" }));
			}
			return { text: `turn ${index}` };
		},
	});
	const synthetic = syntheticProducer();
	const registration = f.ingress.registerProducer(synthetic.producer);
	t.after(() => registration.dispose());
	await f.session.prompt("first");
	await f.session.prompt("second");
	const beforeCompaction = f.bodies.length;

	const compacted = f.session.compact();
	await until(() => f.session.isCompacting, "the host to start compacting");
	synthetic.offer([{ id: "intent-1", revision: "1" }]);
	const scheduling = registration.changed();
	while (f.session.isCompacting) {
		assert.equal(carrying(f.bodies, "work intent-1"), 0, "no producer work is sent while the host compacts");
		await settle();
	}
	assert.equal(summaryIndex, beforeCompaction, "compaction's own request is the only one it sends");

	releaseSummary();
	await compacted;
	await scheduling;
	await until(() => carrying(f.bodies, "work intent-1") === 1, "the held producer work to run after compaction");
	await settle();
	assert.equal(carrying(f.bodies, "work intent-1"), 1, "and to run exactly once");
});
