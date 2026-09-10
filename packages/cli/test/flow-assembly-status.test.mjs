import assert from "node:assert/strict";
import { test } from "node:test";
import { assembledSession, installedProducerExtensions } from "./fixtures/flow-assembly.mjs";
import { campaignScript, liveWait } from "./fixtures/flow-campaign.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the status command reads and repairs holds without reaching the model", async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: campaignScript({ goal: "Report status" }),
	});
	await f.session.prompt("start the sweep and wait");
	const wait = await liveWait(f.ingress, "the campaign leaves one live wait");
	const blocked = f.bodies.length;

	// Pi dispatches an extension command inside prompt, so this is the real user path.
	await f.session.prompt("/flow");
	await settle();
	assert.equal(f.bodies.length, blocked, "reading status sends no request and adds no model context");

	await f.session.prompt(`/flow cancel ${wait.token}`);
	const cancelled = (await f.ingress.branch().attachment.waits.snapshot()).find(
		(record) => record.token === wait.token,
	);
	assert.equal(cancelled?.state, "cancelled", "the wait is cancelled, with its reason recorded");
	assert.match(cancelled.cancellationReason ?? "", /\/flow/);
	await settle();
	assert.equal(f.bodies.length, blocked, "and cancelling it sends no request either");
	const live = (await f.ingress.branch().attachment.waits.snapshot()).filter((record) => record.state === "waiting");
	assert.deepEqual(live, [], "no live wait remains");

	// The campaign work outlives its wait: cancelling a gate does not complete or retire the work.
	const authority = await f.ingress.branch().attachment.waits.authoritySnapshot();
	assert.ok(
		authority.work.some((record) => record.id === wait.workId),
		"the owning work stays registered",
	);
	assert.deepEqual(f.errors, []);
});

test("the status command refuses unknown targets and states what it accepts", async (t) => {
	const f = await assembledSession(t, { producerExtensions: await installedProducerExtensions() });
	const before = f.bodies.length;
	await f.session.prompt("/flow retry no-such-request");
	await f.session.prompt("/flow cancel no-such-token");
	await f.session.prompt("/flow explode something");
	await f.session.prompt("/flow cancel one two");
	await settle();
	assert.equal(f.bodies.length, before, "a rejected control still sends nothing");
	// Command failures are reported to the user, never raised through the runtime's error channel.
	assert.deepEqual(f.errors, []);
});

test("a lane from an earlier session in the same process does not break the next one", async (t) => {
	const producers = await installedProducerExtensions();
	const first = await assembledSession(t, { producerExtensions: producers, script: campaignScript({ goal: "One" }) });
	await first.session.prompt("start the sweep and wait");
	await liveWait(first.ingress, "the first session leaves a live campaign");
	assert.deepEqual(first.errors, []);

	// The loaded multiloop instance outlives one session, so the next session sees its lane inventory
	// and its continuations while holding no campaign work for them.
	const next = await assembledSession(t, { producerExtensions: producers });
	await next.session.prompt("hello");
	await new Promise((resolve) => setTimeout(resolve, 600));
	assert.deepEqual(next.errors, [], "the unaccountable lane does not fail the session's producer");
	const sent = next.bodies.map((body) => JSON.stringify(body.messages));
	assert.equal(sent.length, 1, "and no continuation is sent for it");
	assert.ok(sent[0].includes("hello"));
});

test("pausing a campaign holds its turns and resuming releases them", async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: campaignScript({ command: "sleep 0.3 && echo swept", goal: "Pause and resume" }),
	});
	await f.session.prompt("start the sweep and wait");
	const wait = await liveWait(f.ingress, "the campaign is live");

	await f.session.prompt(`/flow pause ${wait.workId}`);
	await settle();
	const paused = (await f.ingress.branch().attachment.waits.authoritySnapshot()).work.find(
		(record) => record.id === wait.workId,
	);
	assert.equal(paused?.lifecycle?.state, "paused");
	assert.match(paused.lifecycle.reason, /\/flow/);
	// Pausing holds automated turns; it does not cancel the wait or stop the job.
	assert.equal((await f.ingress.branch().attachment.waits.snapshot())[0].state, "waiting");
	const held = f.bodies.length;
	await new Promise((resolve) => setTimeout(resolve, 900));
	assert.equal(f.bodies.length, held, "a paused campaign produces no automated turn when its job ends");

	await f.session.prompt(`/flow resume ${wait.workId}`);
	await settle();
	assert.equal(
		(await f.ingress.branch().attachment.waits.authoritySnapshot()).work.find((r) => r.id === wait.workId)?.lifecycle
			?.state,
		"active",
	);
	assert.deepEqual(f.errors, []);
});

test("stopping a campaign cancels its waits and refuses a second transition", async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: campaignScript({ goal: "Stop it" }),
	});
	await f.session.prompt("start the sweep and wait");
	const wait = await liveWait(f.ingress, "the campaign is live");

	await f.session.prompt(`/flow stop ${wait.workId}`);
	await settle();
	// Stopping cancels the work's live waits, and idle maintenance then retires the ended records, so
	// the observable end state is that no gate remains for it.
	assert.deepEqual(await f.ingress.branch().attachment.waits.snapshot(), [], "stopping work ends the gate it owns");
	const stopped = (await f.ingress.branch().attachment.waits.authoritySnapshot()).work.find(
		(record) => record.id === wait.workId,
	);
	assert.equal(stopped?.lifecycle?.state, "stopped");

	// Stopped work is terminal: pausing or resuming it afterwards is refused rather than silently
	// reopening a retired campaign.
	await assert.rejects(f.ingress.changeWorkStatus(wait.workId, "paused", "late"), { code: "transition" });
	await assert.rejects(f.ingress.changeWorkStatus(wait.workId, "active", "late"), { code: "transition" });
	await assert.rejects(f.ingress.changeWorkStatus("no-such-work", "paused", "late"), { code: "identity" });
	// Repeating the same state is a no-op rather than an error, so the control is idempotent.
	assert.equal((await f.ingress.changeWorkStatus(wait.workId, "stopped", "again")).lifecycle.state, "stopped");
	assert.deepEqual(f.errors, []);
});
