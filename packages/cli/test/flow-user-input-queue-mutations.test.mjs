import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deferred, tick } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { afterCleanup } from "./fixtures/cleanup.mjs";
import { fixture } from "./fixtures/flow-session-ingress.mjs";

/**
 * What the journal learns when the host mutates the native queue on its own.
 *
 * A receipt subscription only revisits records whose indexed evidence changed, so a mutation that
 * invalidates the identity or revision a sender was told about has to leave a newer journal revision.
 * The host removes queued input by identity (`cancelQueuedMessage`), by lane (`clearSteeringQueue`,
 * `clearFollowUpQueue`), through the session's identity-free clear, and re-revisions it by edit. Each
 * of those paths must publish an `unknown` correction at a strictly newer revision, must never read as
 * a confirmed cancellation, and must not be needed to repair an unrelated write.
 *
 * A destructive reset discards the journal those removals describe. Evidence a previous journal
 * lifetime still owes must not be able to re-arm the queue-failure gate afterwards.
 */

/** Bounded wait for a state the host reaches asynchronously, with the expectation in the failure. */
async function until(predicate, message) {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(message);
}

/** Real patched host with one authorized adapter, so every assertion reads the public adapter API. */
async function setup(t, options = {}) {
	const agentDir = await mkdtemp(join(tmpdir(), "jouzu-queue-mutations-"));
	afterCleanup(t, () => rm(agentDir, { recursive: true, force: true }));
	const path = join(agentDir, "extension.ts");
	await writeFile(path, "export default () => {};\n");
	const extensionId = await realpath(path);
	await writeFile(
		join(agentDir, "user-input-adapters.json"),
		JSON.stringify({ schemaVersion: 1, grants: [{ extensionPath: extensionId, adapterId: "fixture" }] }),
	);
	const f = await fixture(t, { agentDir, ...options });
	const adapter = await f.session._flowBinding.registerUserInputAdapter(extensionId, {
		id: "fixture",
		label: "Fixture",
	});
	const binding = await adapter.bind();
	return { ...f, adapter, binding };
}

const input = (f, messageId, text, deliverAs = "followUp") => ({
	binding: f.binding,
	messageId,
	text,
	deliverAs,
});
const lookup = (f, messageId) => f.adapter.lookup({ target: f.binding.target, messageId });
const recordFor = async (f, messageId) =>
	(await f.ingress.branch().attachment.submissions.snapshot()).find(
		(record) => record.submission.externalUser?.messageId === messageId,
	);

/** Hold one turn open and queue external input behind it, before the provider gate is released. */
async function queueBehindTurn(f, messageId, text, deliverAs = "followUp") {
	const turn = f.session.prompt("keep running").catch(() => {});
	await until(() => f.sent.length === 1, "native turn did not start");
	await f.adapter.submit(input(f, messageId, text, deliverAs));
	await until(async () => (await lookup(f, messageId)).state === "queued", "the external input was never queued");
	const [item] = f.session.agent.inspectQueuedMessages();
	return { turn, item };
}

/** Publish the queued receipt before the mutation, so the correction has a revision to advance. */
async function publishedQueued(seen, messageId) {
	await until(
		() => seen.some((receipt) => receipt.messageId === messageId && receipt.state === "queued"),
		"the queued receipt was never published",
	);
	return seen.filter((receipt) => receipt.messageId === messageId && receipt.state === "queued").at(-1);
}

/** The unknown correction for one message that is strictly newer than the queued receipt. */
const correctedUnknown = (seen, messageId, queued) =>
	seen.find(
		(receipt) => receipt.messageId === messageId && receipt.state === "unknown" && receipt.revision > queued.revision,
	);

test("a direct native cancellation publishes a strictly newer unknown receipt", async (t) => {
	const gate = deferred();
	t.after(() => gate.resolve());
	const f = await setup(t, { provider: true, admit: null, onRequest: async () => gate.promise });
	const seen = [];
	const stop = f.adapter.subscribe((receipt) => {
		if (receipt.messageId === "cancelled") seen.push(receipt);
	});
	t.after(stop);
	const { turn, item } = await queueBehindTurn(f, "cancelled", "queued then cancelled");
	const queued = await publishedQueued(seen, "cancelled");
	// The host removes the entry by identity, which is not the identity-free session clear.
	assert.deepEqual(f.session.agent.cancelQueuedMessage(item.id, item.revision), { kind: "cancelled" });
	await until(
		() => !!correctedUnknown(seen, "cancelled", queued),
		"the direct cancellation never reached the subscription",
	);
	const removed = correctedUnknown(seen, "cancelled", queued);
	assert.equal(removed.reason.code, "queue-evidence-missing");
	assert.equal(removed.generation, queued.generation);
	// The removal is durable evidence that the exact observed revision was not consumed. It is not a
	// cancellation, so the journal must never claim the host confirmed one.
	const record = await recordFor(f, "cancelled");
	assert.deepEqual(record.dispatch.queueClaims, [{ id: item.id, revision: item.revision, consumed: false }]);
	assert.equal(record.dispatch.queueCancellations, undefined);
	assert.equal(f.sent.length, 1, "the removed entry was dispatched again");
	gate.resolve();
	await turn;
});

for (const lane of ["steer", "followUp"])
	test(`a ${lane} lane clear records the removal its own bracket observed`, async (t) => {
		const gate = deferred();
		t.after(() => gate.resolve());
		const f = await setup(t, { provider: true, admit: null, onRequest: async () => gate.promise });
		const seen = [];
		const stop = f.adapter.subscribe((receipt) => {
			if (receipt.messageId === "lane") seen.push(receipt);
		});
		t.after(stop);
		const { turn, item } = await queueBehindTurn(f, "lane", "queued then lane-cleared", lane);
		const queued = await publishedQueued(seen, "lane");
		assert.equal(item.lane, lane);
		if (lane === "steer") f.session.agent.clearSteeringQueue();
		else f.session.agent.clearFollowUpQueue();
		await until(() => !!correctedUnknown(seen, "lane", queued), "the lane clear never reached the subscription");
		const removed = correctedUnknown(seen, "lane", queued);
		assert.equal(removed.reason.code, "queue-evidence-missing");
		const record = await recordFor(f, "lane");
		assert.deepEqual(record.dispatch.queueClaims, [{ id: item.id, revision: item.revision, consumed: false }]);
		assert.equal(f.sent.length, 1, "the cleared entry was dispatched again");
		gate.resolve();
		await turn;
	});

test("an edit and the clear that follows publish unknown, never cancellation", async (t) => {
	const gate = deferred();
	t.after(() => gate.resolve());
	const f = await setup(t, { provider: true, admit: null, onRequest: async () => gate.promise });
	const seen = [];
	const stop = f.adapter.subscribe((receipt) => {
		if (receipt.messageId === "edited") seen.push(receipt);
	});
	t.after(stop);
	const { turn, item } = await queueBehindTurn(f, "edited", "queued then edited");
	const queued = await publishedQueued(seen, "edited");
	// The host replaces the message it queued. The flow never reviewed revision 2, so the receipt for
	// revision 1 cannot stay `queued` at the revision the sender already accepted.
	assert.deepEqual(
		f.session.agent.editQueuedMessage(item.id, item.revision, { role: "user", content: "edited", timestamp: 1 }),
		{ kind: "edited", revision: 2 },
	);
	await until(() => !!correctedUnknown(seen, "edited", queued), "the edit never reached the subscription");
	const edited = correctedUnknown(seen, "edited", queued);
	assert.equal(edited.reason.code, "queue-evidence-missing");
	// The clear removes the edited entry. It must not turn the unknown receipt into a confirmed
	// cancellation, and it must not regress the revision the client already saw.
	f.session.clearQueue();
	await tick();
	const latest = await lookup(f, "edited");
	assert.equal(latest.state, "unknown");
	assert.equal(latest.reason.code, "queue-evidence-missing");
	assert.ok(latest.revision >= edited.revision, "the clear regressed the receipt revision");
	const record = await recordFor(f, "edited");
	assert.deepEqual(record.dispatch.queueClaims, [{ id: item.id, revision: item.revision, consumed: false }]);
	assert.equal(record.dispatch.queueCancellations, undefined);
	assert.equal(f.sent.length, 1, "the edited entry was dispatched again");
	gate.resolve();
	await turn;
});

test("a clear records an edited entry the observer never reconciled", async (t) => {
	const gate = deferred();
	t.after(() => gate.resolve());
	const f = await setup(t, { provider: true, admit: null, onRequest: async () => gate.promise });
	const seen = [];
	const stop = f.adapter.subscribe((receipt) => {
		if (receipt.messageId === "unhooked") seen.push(receipt);
	});
	t.after(stop);
	const { turn, item } = await queueBehindTurn(f, "unhooked", "queued then edited elsewhere");
	const queued = await publishedQueued(seen, "unhooked");
	// A revision can also change through a path this observer does not hook. The pinned lane stands in
	// for that path, and the clear that follows must record the entry instead of skipping it because its
	// live revision no longer matches the observed one.
	const lane = f.session.agent.followUpQueue;
	assert.ok(lane && typeof lane.change === "function", "the pinned Pi follow-up lane is not reachable");
	assert.deepEqual(lane.change(item.id, item.revision, { role: "user", content: "edited", timestamp: 1 }), {
		kind: "edited",
		revision: 2,
	});
	f.session.clearQueue();
	await until(
		() => !!correctedUnknown(seen, "unhooked", queued),
		"the edited entry the clear removed never reached the subscription",
	);
	const removed = correctedUnknown(seen, "unhooked", queued);
	assert.equal(removed.reason.code, "queue-evidence-missing");
	const record = await recordFor(f, "unhooked");
	assert.deepEqual(record.dispatch.queueClaims, [{ id: item.id, revision: item.revision, consumed: false }]);
	assert.equal(record.dispatch.queueCancellations, undefined);
	assert.equal(f.sent.length, 1, "the edited entry was dispatched again");
	gate.resolve();
	await turn;
});

test("an unrelated queue clear cannot invalidate a claim whose receipt is still being written", async (t) => {
	const gate = deferred();
	const entered = deferred();
	const release = deferred();
	t.after(() => {
		gate.resolve();
		release.resolve();
	});
	let requests = 0;
	const f = await setup(t, {
		provider: true,
		admit: null,
		onRequest: async () => {
			if (++requests === 1) await gate.promise;
		},
	});
	const { turn, item } = await queueBehindTurn(f, "claimed", "queued then claimed");
	const store = f.ingress.branch().attachment.submissions;
	const recordQueueClaim = store.recordQueueClaim.bind(store);
	const claims = [];
	t.mock.method(store, "recordQueueClaim", async (...args) => {
		if (args[1]?.id === item.id) {
			claims.push(args[2]);
			if (args[2] === true) {
				entered.resolve();
				await release.promise;
			}
		}
		return recordQueueClaim(...args);
	});
	gate.resolve();
	await entered.promise;
	try {
		assert.equal(f.session.agent.inspectQueuedMessages().length, 0);
		f.session.agent.clearFollowUpQueue();
		await tick();
		assert.deepEqual(claims, [true], "the clear must not record removal of an already claimed entry");
	} finally {
		release.resolve();
		await turn;
	}
	await f.ingress.joinPendingOperations();
	assert.equal((await lookup(f, "claimed")).state, "consumed");
	assert.equal(f.sent.length, 2);
});

test("a reset with an outstanding removal write does not pause the new journal lifetime", async (t) => {
	const gate = deferred();
	t.after(() => gate.resolve());
	// Refusing the queue phase ends the turn with the entry still queued, which is what leaves the
	// session idle while a removal write can still be outstanding.
	const f = await setup(t, {
		provider: true,
		admit: async (_submission, _branch, phase) => phase !== "queue",
		onRequest: async () => gate.promise,
	});
	const turn = f.session.prompt("keep running").catch(() => {});
	await until(() => f.sent.length === 1, "native turn did not start");
	await f.adapter.submit(input(f, "outstanding", "queued then cleared"));
	await until(async () => (await lookup(f, "outstanding")).state === "queued", "the input was never queued");
	gate.resolve();
	await turn;
	await until(() => f.session.isIdle, "the turn never became idle");
	const [item] = f.session.agent.inspectQueuedMessages();
	const store = f.ingress.branch().attachment.submissions;
	const entered = deferred(),
		release = deferred(),
		finished = deferred();
	t.after(() => release.resolve());
	let parked = false,
		released = false;
	const recordQueueClaim = store.recordQueueClaim.bind(store);
	t.mock.method(store, "recordQueueClaim", async (...args) => {
		if (!parked && args[1]?.id === item.id && args[2] === false) {
			parked = true;
			entered.resolve();
			await release.promise;
		}
		try {
			return await recordQueueClaim(...args);
		} finally {
			if (released) finished.resolve();
		}
	});
	// The host discards the queue entry. Its removal evidence is now an outstanding write.
	f.session.clearQueue();
	await entered.promise;
	// The destructive reset discards the journal those records live in.
	const reset = await f.ingress.resetFlow();
	assert.equal(reset.recoveryHeld, false);
	released = true;
	release.resolve();
	await finished.promise;
	await tick();
	// The pre-reset write fails against the emptied journal. It belongs to the discarded lifetime, so it
	// must not re-arm the queue-failure gate the reset cleared for unrelated work.
	await assert.doesNotReject(f.ingress.branch().native.consumedSources());
	assert.deepEqual(await store.snapshot(), []);
});
