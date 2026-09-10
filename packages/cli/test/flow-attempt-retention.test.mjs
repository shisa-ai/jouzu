import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context, MemorySessionRepo, setValue, value } from "@earendil-works/pi-agent-core";
import { initialFlowAdmission } from "../dist/flow-control/admission.js";
import { emptyRetiredAttempts, retiredMemberHash } from "../dist/flow-control/attempt-retention.js";
import { retainedByReceipt } from "../dist/flow-control/controller.js";
import { createPiLedgerStore } from "../dist/flow-control/pi-ledger-store.js";
import { FlowReceiptLedger } from "../dist/flow-control/receipt-ledger.js";
import { orderFlowResultProducers } from "../dist/flow-control/result-order.js";
import { MAX_RETIRED_FLOW_IDENTITIES } from "../dist/flow-control/retired-identities.js";

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

/** A ledger whose replay-fence quota is nearly spent, with room for the state that implies. */
async function fencedFixture(t, spent) {
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, context);
	t.after(() => repo.close(context));
	await session.mutate(
		(mutation, ctx) =>
			mutation.commit(
				[
					setValue(value("jouzu.flow.receipts", "v1"), {
						schemaVersion: 1,
						scope,
						generation: 0,
						revision: 0,
						attemptIds: [],
						retiredAttempts: { ...emptyRetiredAttempts(), members: spent },
					}),
				],
				ctx,
			),
		context,
	);
	return FlowReceiptLedger.attach(createPiLedgerStore(session), scope, {
		maxAttempts: 1024,
		maxBytes: 64 * 1024 * 1024,
	});
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
	await ledger.payload(attemptId, `request-${attemptId}`, {
		api: "fixture",
		hash: hash(attemptId),
		bytes: 1,
		inclusion: items.map(included),
	});
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

test("a successful request with an omitted result retains its context exclusion evidence", async (t) => {
	const ledger = await fixture(t);
	const work = member("instruction"),
		result = member("filtered-result", "result");
	await ledger.select("filtered", [work, result], {
		revision: 0,
		intent: intent(work.id),
		coalescedIds: [],
		next: { ...initialFlowAdmission(), revision: 1 },
	});
	const queue = { id: "filtered-queue", revision: 1 };
	await ledger.queued("filtered", queue);
	await ledger.claim("filtered", queue);
	const inclusion = [included(work), { id: result.id, revision: result.revision, disposition: "omitted" }];
	await ledger.prepare("filtered", "filtered-request", inclusion, false);
	await ledger.payload("filtered", "filtered-request", {
		api: "fixture",
		hash: hash("filtered"),
		bytes: 1,
		inclusion,
	});
	await ledger.handoff("filtered", "filtered-request");
	await ledger.requestOutcome("filtered", "filtered-request", "success");
	await ledger.settle("filtered", "success");
	assert.equal(await ledger.retire(0), 0, "success does not establish inclusion of every composed member");
	assert.equal((await ledger.snapshot()).attempts[0].members[1].id, result.id);
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

test("the retired-identity fence budget holds retirement fail-closed at its limit", async (t) => {
	// One slot short of the shared 16,384-identity safety budget: retiring both settled attempts
	// below would need two. The budget is a fail-closed bound, not a claim of infinite retention.
	const spent = Array.from({ length: MAX_RETIRED_FLOW_IDENTITIES - 1 }, (_, index) =>
		retiredMemberHash(`spent-${index}`, "r1"),
	);
	const ledger = await fencedFixture(t, spent);
	await settledAttempt(ledger, "one", "fence-one");
	await settledAttempt(ledger, "two", "fence-two");
	// A fold past the budget commits nothing, so the refusal is atomic: no attempt is dropped
	// without its replay fence being recorded.
	await assert.rejects(
		() => ledger.retire(0),
		(error) => ["schema", "capacity"].includes(error.code),
	);
	assert.deepEqual(
		(await ledger.snapshot()).attempts.map((attempt) => attempt.id),
		["one", "two"],
		"no attempt was dropped by the refused retirement",
	);
	// The last free slot still retires one attempt, which keeps the budget a bound on history
	// rather than a brick: the newest attempt stays addressable and its fence is recorded.
	assert.equal(await ledger.retire(1), 1);
	const after = await ledger.snapshot();
	assert.deepEqual(
		after.attempts.map((attempt) => attempt.id),
		["two"],
	);
	assert.equal(after.retiredAttempts.members.length, MAX_RETIRED_FLOW_IDENTITIES);
	// The budget is now spent, so retiring the survivor is refused the same fail-closed way.
	await assert.rejects(
		() => ledger.retire(0),
		(error) => ["schema", "capacity"].includes(error.code),
	);
	assert.equal((await ledger.snapshot()).attempts.length, 1);
	// The one recorded fence still blocks replay of the retired member.
	assert.equal(
		retainedByReceipt(
			{ ...intent("fence-one"), rank: 6, workId: undefined, workRevision: undefined, revision: "r1" },
			after,
		),
		true,
	);
});
