import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FlowModelInput } from "../dist/flow-control/model-input.js";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { projectFlowSubmissions } from "../dist/flow-control/submission-view.js";

const scope = { sessionId: "parent", branchId: "main" };
const input = {
	version: 1,
	id: "source",
	api: "followUp",
	origin: { kind: "extension", id: "fixture" },
	scope: { sessionId: "parent", attachmentId: "attachment", leafId: null },
	args: ["work"],
};
async function fixture(t, kind = "work") {
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-view-"));
	let attachment = await PiFlowAttachment.open(root, scope);
	t.after(async () => {
		await attachment.close();
		await rm(root, { recursive: true, force: true });
	});
	await attachment.submissions.retain(input);
	const composition = FlowModelInput.compose(
		"attempt",
		[{ id: "member", revision: "1", kind, text: "work", sourceSubmission: { id: "source", revision: 1 } }],
		4096,
	);
	return {
		get attachment() {
			return attachment;
		},
		composition,
		async reopen() {
			await attachment.close();
			attachment = await PiFlowAttachment.open(root, scope);
		},
		async view() {
			return projectFlowSubmissions(await attachment.submissions.snapshot(), await attachment.ledger.snapshot())[0];
		},
	};
}
async function select(f) {
	await f.attachment.ledger.select("attempt", f.composition.members);
}

test("a returned native operation without receipts stays held and uncertain", async (t) => {
	const f = await fixture(t);
	await f.attachment.submissions.dispatch("source", 1, "operation", async () => {});
	const view = await f.view();
	assert.equal(view.admission, "held");
	assert.equal(view.delivery, "uncertain");
	assert.deepEqual(view.attemptIds, []);
	await f.reopen();
	assert.deepEqual(await f.view(), view);
});
async function queue(f) {
	await select(f);
	await f.attachment.ledger.queued("attempt", { id: "queue", revision: 1 });
}
async function claim(f) {
	await queue(f);
	await f.attachment.ledger.claim("attempt", { id: "queue", revision: 1 });
}
async function prepare(f) {
	await claim(f);
	const inclusion = f.composition.inspect([{ role: "user", content: f.composition.content, timestamp: 1 }]);
	await f.attachment.ledger.prepare("attempt", "request", inclusion, false);
}

test("unconsumed cancellation returns retained input to pending after reopen", async (t) => {
	const f = await fixture(t);
	assert.equal((await f.view()).admission, "pending");
	await queue(f);
	assert.equal((await f.view()).admission, "reserved");
	await f.attachment.ledger.cancel("attempt", "queue cancelled");
	await f.reopen();
	assert.equal((await f.view()).admission, "pending");
	assert.equal((await f.view()).delivery, "none");
});

test("consumption survives cancellation and restart without permitting input replay", async (t) => {
	const f = await fixture(t);
	await claim(f);
	await f.reopen();
	const attempt = (await f.attachment.ledger.snapshot()).attempts[0];
	assert.equal(attempt.phase, "cancelled");
	assert.equal(attempt.consumed, true);
	assert.equal((await f.view()).admission, "held");
	assert.equal((await f.view()).delivery, "consumed");
});

test("history presence stays separate from successful provider inclusion", async (t) => {
	const f = await fixture(t);
	await claim(f);
	await f.attachment.ledger.history("attempt", [
		{ id: "member", revision: "1", entryId: "entry", entryHash: "a".repeat(64) },
	]);
	await f.attachment.ledger.cancel("attempt", "aborted before request");
	assert.equal((await f.view()).delivery, "history");
	assert.equal((await f.view()).admission, "held");
});

test("handoff intent alone is uncertain and cannot acknowledge provider inclusion", async (t) => {
	const f = await fixture(t);
	await prepare(f);
	await f.attachment.ledger.handoff("attempt", "request");
	assert.equal((await f.view()).delivery, "uncertain");
	await f.reopen();
	assert.equal((await f.view()).delivery, "uncertain");
	assert.equal((await f.view()).admission, "held");
});

test("successful inclusion is retained without treating submission as runnable again", async (t) => {
	const f = await fixture(t);
	await prepare(f);
	await f.attachment.ledger.handoff("attempt", "request");
	await f.attachment.ledger.requestOutcome("attempt", "request", "success");
	await f.attachment.ledger.settle("attempt", "success");
	await f.reopen();
	assert.equal((await f.view()).delivery, "included");
	assert.equal((await f.view()).admission, "held");
	await f.attachment.submissions.cancel("source", 1);
	assert.equal((await f.view()).admission, "cancelled");
	assert.equal((await f.view()).delivery, "included");
});

test("legacy cancelled queue records without consumption proof remain held", async (t) => {
	const f = await fixture(t);
	await queue(f);
	await f.attachment.ledger.cancel("attempt", "cancelled");
	const state = await f.attachment.ledger.snapshot();
	delete state.attempts[0].consumed;
	const [view] = projectFlowSubmissions(await f.attachment.submissions.snapshot(), state);
	assert.equal(view.admission, "held");
	assert.equal(view.delivery, "uncertain");
});

test("missing or changed retained source revisions fail instead of inventing pending work", async (t) => {
	const f = await fixture(t);
	await select(f);
	const state = await f.attachment.ledger.snapshot();
	const records = await f.attachment.submissions.snapshot();
	assert.throws(() => projectFlowSubmissions([], state), { code: "identity" });
	state.attempts[0].members[0].sourceSubmission.revision = 2;
	assert.throws(() => projectFlowSubmissions(records, state), { code: "identity" });
});

test("partial optional input cannot acknowledge the whole retained submission", async (t) => {
	const f = await fixture(t, "result");
	const composition = FlowModelInput.compose(
		"attempt",
		["one", "two"].map((id) => ({
			id,
			revision: "1",
			kind: "result",
			text: id,
			sourceSubmission: { id: "source", revision: 1 },
		})),
		4096,
	);
	const ledger = f.attachment.ledger;
	await ledger.select("attempt", composition.members);
	await ledger.queued("attempt", { id: "queue", revision: 1 });
	await ledger.claim("attempt", { id: "queue", revision: 1 });
	const inclusion = composition.inspect([{ role: "user", content: composition.content.slice(0, 1), timestamp: 1 }]);
	await ledger.prepare("attempt", "request", inclusion, false);
	await ledger.handoff("attempt", "request");
	await ledger.requestOutcome("attempt", "request", "success");
	await ledger.settle("attempt", "success");
	assert.equal((await f.view()).delivery, "partial");
	assert.equal((await f.view()).admission, "held");
});

test("unlinked consumed history cannot make an unidentified retained input pending", async (t) => {
	const f = await fixture(t);
	await claim(f);
	const state = await f.attachment.ledger.snapshot();
	delete state.attempts[0].members[0].sourceSubmission;
	const [view] = projectFlowSubmissions(await f.attachment.submissions.snapshot(), state);
	assert.equal(view.admission, "held");
	assert.equal(view.delivery, "uncertain");
});

test("partial native cancellation cannot mark a mixed submission cancelled", async (t) => {
	const f = await fixture(t);
	const store = f.attachment.submissions;
	await store.dispatch("source", 1, "operation", async (observer) => {
		await observer.observe({ kind: "followUp", args: ["one"], queue: { id: "one", revision: 1 } });
		await observer.observe({ kind: "followUp", args: ["two"], queue: { id: "two", revision: 1 } });
	});
	await store.cancelQueue("operation", { id: "one", revision: 1 });
	await store.recordQueueClaim("operation", { id: "one", revision: 1 }, false);
	let view = await f.view();
	assert.equal(view.admission, "held");
	assert.deepEqual(view.nativeQueueCancellations, [{ id: "one", revision: 1, removal: "confirmed" }]);
	await store.recordQueueClaim("operation", { id: "two", revision: 1 }, true);
	view = await f.view();
	assert.equal(view.admission, "held");
	assert.equal(view.delivery, "consumed");
});

test("a consumed claim cannot be reported as successful native cancellation", async (t) => {
	const f = await fixture(t);
	const store = f.attachment.submissions;
	await store.dispatch("source", 1, "operation", async (observer) => {
		await observer.observe({ kind: "followUp", args: ["one"], queue: { id: "one", revision: 1 } });
	});
	await store.cancelQueue("operation", { id: "one", revision: 1 });
	await store.recordQueueClaim("operation", { id: "one", revision: 1 }, true);
	const view = await f.view();
	assert.equal(view.admission, "held");
	assert.equal(view.delivery, "consumed");
	assert.deepEqual(view.nativeQueueCancellations, [{ id: "one", revision: 1, removal: "consumed" }]);
});

test("input the model received is held without a reason, and unknown delivery carries one", async (t) => {
	// Every dispatched record is held, because none of it may be sent a second time. That is not a
	// problem a reader can act on, so a status view must not offer it as one: only a hold whose cause
	// is recorded, or a send whose delivery is unknown, states a reason.
	const interrupted = await fixture(t);
	await prepare(interrupted);
	await interrupted.attachment.ledger.handoff("attempt", "request");
	// Reopening drops the active attempt, so this is what a later reader sees: sent, outcome unknown.
	await interrupted.reopen();
	assert.equal((await interrupted.view()).reason, "Sent, but whether the model received it is not known.");

	const delivered = await fixture(t);
	await prepare(delivered);
	await delivered.attachment.ledger.handoff("attempt", "request");
	await delivered.attachment.ledger.requestOutcome("attempt", "request", "success");
	await delivered.attachment.ledger.settle("attempt", "success");
	await delivered.reopen();
	const view = await delivered.view();
	assert.equal(view.admission, "held");
	assert.equal(view.delivery, "included");
	assert.ok(!("reason" in view), "delivered input is spent, not a hold to report");
});

test("a recorded admission hold is still reported over the generic states", async (t) => {
	const f = await fixture(t);
	await f.attachment.submissions.recordAdmission("source", 1, { phase: "submission" }, "Waiting for user work.");
	const view = await f.view();
	assert.equal(view.admission, "held");
	assert.equal(view.reason, "Waiting for user work.");
});
