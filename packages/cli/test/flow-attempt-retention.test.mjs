import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { initialFlowAdmission } from "../dist/flow-control/admission.js";
import { retainedByReceipt } from "../dist/flow-control/controller.js";
import { createPiLedgerStore } from "../dist/flow-control/pi-ledger-store.js";
import { FlowReceiptLedger } from "../dist/flow-control/receipt-ledger.js";
import { orderFlowResultProducers } from "../dist/flow-control/result-order.js";

const scope = { sessionId: "parent", branchId: "branch-a" };
const hash = (id) => createHash("sha256").update(`content:${id}`).digest("hex");
const member = (id, kind = "work") => ({
	id,
	revision: "r1",
	kind,
	required: kind === "work" || kind === "wait",
	contentHash: hash(id),
});
const included = (item) => ({
	id: item.id,
	revision: item.revision,
	disposition: "included",
	contentHash: item.contentHash,
});

async function fixture(t) {
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, context);
	t.after(() => repo.close(context));
	return FlowReceiptLedger.attach(createPiLedgerStore(session), scope);
}

const intent = (id, overrides = {}) => ({
	id,
	revision: "r1",
	producer: "multiloop",
	sequence: 0,
	rank: 4,
	workId: "campaign",
	workRevision: "1:1",
	independent: false,
	runnable: true,
	...overrides,
});

/** Drive one attempt from selection to a settled successful outcome. */
async function settledAttempt(ledger, attemptId, intentId, resultProducer) {
	// One member must carry the selected intent's identity for the ledger to accept the choice.
	const work = { ...member(intentId), id: intentId, revision: "r1" };
	const items = [work];
	// Each selection must quote the current admission revision and advance it.
	const revision = (await ledger.snapshot()).admission?.revision ?? 0;
	const choice = {
		revision,
		intent: intent(intentId),
		coalescedIds: [],
		next: { ...initialFlowAdmission(), revision: revision + 1 },
		...(resultProducer ? { resultSnapshot: [{ id: work.id, revision: work.revision, producer: resultProducer }] } : {}),
	};
	await ledger.select(attemptId, items, choice);
	const queue = { id: `queue-${attemptId}`, revision: 1 };
	await ledger.queued(attemptId, queue);
	await ledger.claim(attemptId, queue);
	await ledger.prepare(attemptId, `request-${attemptId}`, items.map(included), false);
	await ledger.handoff(attemptId, `request-${attemptId}`);
	await ledger.requestOutcome(attemptId, `request-${attemptId}`, "success");
	await ledger.settle(attemptId, "success");
	return items;
}

test("retirement removes settled attempts and keeps the newest addressable", async (t) => {
	const ledger = await fixture(t);
	for (let index = 0; index < 5; index++) await settledAttempt(ledger, `a${index}`, "loop");
	assert.equal((await ledger.snapshot()).attempts.length, 5);
	assert.equal(await ledger.retire(2), 3);
	const state = await ledger.snapshot();
	assert.equal(state.attempts.length, 2);
	assert.deepEqual(
		state.attempts.map((attempt) => attempt.id),
		["a3", "a4"],
	);
	assert.equal(await ledger.retire(2), 0, "a second pass retires nothing new");
});

test("a retired attempt still fences its members and its cadence work", async (t) => {
	const ledger = await fixture(t);
	const [work] = await settledAttempt(ledger, "a0", "loop");
	const before = await ledger.snapshot();
	const memberIntent = {
		...intent("loop"),
		id: work.id,
		revision: work.revision,
		rank: 6,
		workId: undefined,
		workRevision: undefined,
	};
	assert.equal(retainedByReceipt(memberIntent, before), true);
	assert.equal(retainedByReceipt(intent("loop"), before), true);
	await ledger.retire(0);
	const after = await ledger.snapshot();
	assert.equal(after.attempts.length, 0);
	assert.equal(retainedByReceipt(memberIntent, after), true, "member replay stays fenced after retirement");
	assert.equal(retainedByReceipt(intent("loop"), after), true, "cadence replay stays fenced after retirement");
	// A later iteration carries a new descriptor revision and a new work revision; neither is fenced.
	assert.equal(
		retainedByReceipt(intent("loop", { revision: "r2", workRevision: "1:2" }), after),
		false,
		"a new iteration is admissible",
	);
	assert.equal(
		retainedByReceipt(intent("loop", { revision: "r2" }), after),
		true,
		"the same work revision stays fenced under a new descriptor revision",
	);
});

test("iteration numbering continues across retirement", async (t) => {
	const ledger = await fixture(t);
	for (let index = 0; index < 3; index++) await settledAttempt(ledger, `a${index}`, "loop");
	const before = await ledger.snapshot();
	const counted = (state) =>
		state.attempts.filter(
			(attempt) =>
				attempt.admission?.choice.intent.id === "loop" && attempt.phase === "settled" && attempt.outcome === "success",
		).length + (state.retiredAttempts?.settled.find((entry) => entry.id === "loop")?.count ?? 0);
	assert.equal(counted(before), 3);
	await ledger.retire(0);
	const after = await ledger.snapshot();
	assert.equal(after.attempts.length, 0);
	assert.equal(counted(after), 3, "the settled count survives pruning");
	assert.deepEqual(after.retiredAttempts.settled, [{ id: "loop", count: 3 }]);
});

test("the producer round carries past retirement so fairness does not restart", async (t) => {
	const ledger = await fixture(t);
	await settledAttempt(ledger, "a0", "loop", "alpha");
	const before = await ledger.snapshot();
	const served = orderFlowResultProducers([], before);
	await ledger.retire(0);
	const after = await ledger.snapshot();
	assert.deepEqual(after.retiredAttempts.round, served, "the carried round matches the replayed round");
	assert.deepEqual(orderFlowResultProducers([], after), served, "ordering is unchanged by retirement");
});

test("an active attempt is never retired", async (t) => {
	const ledger = await fixture(t);
	await settledAttempt(ledger, "a0", "loop");
	await ledger.select("live", [member("live-member")]);
	assert.equal((await ledger.snapshot()).activeAttemptId, "live");
	assert.equal(await ledger.retire(0), 1, "only the settled attempt retires");
	const state = await ledger.snapshot();
	assert.deepEqual(
		state.attempts.map((attempt) => attempt.id),
		["live"],
	);
});

test("retirement rejects an invalid window", async (t) => {
	const ledger = await fixture(t);
	assert.throws(
		() => ledger.retire(-1),
		(error) => error.code === "capacity",
	);
	assert.throws(
		() => ledger.retire(1.5),
		(error) => error.code === "capacity",
	);
});
