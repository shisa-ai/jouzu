import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initialFlowAdmission } from "../dist/flow-control/admission.js";
import { emptyRetiredAttempts, retiredMemberHash, retiredWorkHash } from "../dist/flow-control/attempt-retention.js";
import { retainedByReceipt } from "../dist/flow-control/controller.js";
import { openLocalFlowSession } from "../dist/flow-control/local-storage.js";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { createPiLedgerStore } from "../dist/flow-control/pi-ledger-store.js";
import { FlowReceiptLedger } from "../dist/flow-control/receipt-ledger.js";
import { orderFlowResultProducers } from "../dist/flow-control/result-order.js";
import { MAX_RETIRED_FLOW_IDENTITIES } from "../dist/flow-control/retired-identities.js";
import { BACKGROUND_CONTEXT as context, MemorySessionRepo, setValue, value } from "./fixtures/flow-storage.mjs";

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

/** A legacy ledger at the retired-identity budget must migrate under ordinary limits. */
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
async function settledAttempt(ledger, attemptId, intentId, resultProducer, outcome = "success") {
	// One member must carry the selected intent's identity for the ledger to accept the choice.
	const work = { ...member(intentId), id: intentId, revision: "r1" };
	const items = [work];
	if (resultProducer) items.push(member(`result-${attemptId}`, "result"));
	// Each selection must quote the current admission revision and advance it.
	const revision = (await ledger.snapshot()).admission?.revision ?? 0;
	const choice = {
		revision,
		intent: intent(intentId),
		coalescedIds: [],
		next: { ...initialFlowAdmission(), revision: revision + 1 },
		...(resultProducer
			? {
					resultSnapshot: [
						{ id: items[1].id, revision: "r1", producer: resultProducer },
						{
							id: `pending-${resultProducer === "beta" ? "alpha" : "beta"}`,
							revision: "r1",
							producer: resultProducer === "beta" ? "alpha" : "beta",
						},
					],
				}
			: {}),
	};
	await ledger.select(attemptId, items, choice);
	const queue = { id: `queue-${attemptId}`, revision: 1 };
	await ledger.queued(attemptId, queue);
	await ledger.claim(attemptId, queue);
	await ledger.prepare(attemptId, `request-${attemptId}`, items.map(included), false);
	await ledger.handoff(attemptId, `request-${attemptId}`);
	await ledger.requestOutcome(attemptId, `request-${attemptId}`, outcome);
	await ledger.settle(attemptId, outcome);
	return items;
}

for (const storage of ["memory", "disk"])
	test(`legacy archived result snapshots backfill trigger indexes once per generation: ${storage}`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "flow-trigger-migration-"));
		const repo = new MemorySessionRepo();
		let session = storage === "disk" ? await openLocalFlowSession(root) : await repo.create({}, context);
		t.after(async () => {
			await session.close(context);
			await repo.close(context);
			await rm(root, { recursive: true, force: true });
		});
		const ledger = await FlowReceiptLedger.attach(createPiLedgerStore(session), scope);
		await settledAttempt(ledger, "legacy", "loop", "alpha");
		const state = await ledger.snapshot();
		const { attempts, ...header } = state;
		await session.mutate(
			(mutation, ctx) =>
				mutation.commit(
					[
						setValue(value("jouzu.flow.receipts", "v1"), {
							...header,
							attemptIds: [],
							retiredAttempts: emptyRetiredAttempts(),
						}),
						setValue(value("jouzu.flow.attempt-history", JSON.stringify([0, "legacy"])), attempts[0]),
						setValue(value("jouzu.flow.attempt-history", JSON.stringify([1, "other"])), {
							...attempts[0],
							id: "other",
							admission: {
								...attempts[0].admission,
								choice: {
									...attempts[0].admission.choice,
									resultSnapshot: [{ id: "other-result", revision: "r1", producer: "beta" }],
								},
							},
						}),
					],
					ctx,
				),
			context,
		);
		let scans = 0;
		let rejectMigration = true;
		const wrapped = {
			mutate: (operation, ctx) =>
				session.mutate(
					(mutation, inner) =>
						operation(
							{
								getValue: (...args) => mutation.getValue(...args),
								scanValues: (...args) => {
									scans++;
									return mutation.scanValues(...args);
								},
								commit: (...args) => {
									if (rejectMigration) throw new Error("migration commit rejected");
									return mutation.commit(...args);
								},
							},
							inner,
						),
					ctx,
				),
		};
		const triggers = attempts[0].admission.choice.resultSnapshot.map(({ id, revision }) =>
			retiredMemberHash(id, revision),
		);
		const other = retiredMemberHash("other-result", "r1");
		const query = { triggers: [...triggers, other] };
		await assert.rejects(createPiLedgerStore(wrapped).retired(query), /migration commit rejected/);
		assert.equal(
			(await session.getValue(value("jouzu.flow.receipts", "v1"), context)).value.triggerIndexVersion,
			undefined,
		);
		assert.equal(
			await session.getValue(value("jouzu.flow.retired-triggers", JSON.stringify([0, triggers[0]])), context),
			undefined,
		);
		rejectMigration = false;
		assert.deepEqual((await createPiLedgerStore(wrapped).retired(query)).triggers, triggers);
		assert.equal(scans, 2);
		if (storage === "disk") {
			await session.close(context);
			session = await openLocalFlowSession(root);
		}
		assert.deepEqual((await createPiLedgerStore(wrapped).retired(query)).triggers, triggers);
		assert.equal(scans, 2, "a reopened adapter uses the durable migration marker");
		await (await FlowReceiptLedger.attach(createPiLedgerStore(session), scope)).reset();
		assert.deepEqual((await createPiLedgerStore(wrapped).retired(query)).triggers, []);
		assert.equal(scans, 2, "reset does not import another generation's history");
	});

test("retirement rechecks authorization after asynchronous archive reads", async (t) => {
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, context);
	t.after(() => repo.close(context));
	let revokeOnRead = false;
	let authorized = true;
	let checks = 0;
	const wrapped = {
		mutate: (operation, ctx) =>
			session.mutate(
				(mutation, inner) =>
					operation(
						{
							getValue: async (...args) => {
								const result = await mutation.getValue(...args);
								if (revokeOnRead) authorized = false;
								return result;
							},
							commit: (...args) => mutation.commit(...args),
						},
						inner,
					),
				ctx,
			),
	};
	const ledger = await FlowReceiptLedger.attach(createPiLedgerStore(wrapped), scope);
	await settledAttempt(ledger, "guarded", "guarded-work", "alpha");
	const before = await ledger.snapshot();
	await assert.rejects(
		ledger.retire(0, new Set(), () => {
			checks++;
			if (!authorized) throw new Error("retirement authority revoked");
			revokeOnRead = true;
		}),
		/retirement authority revoked/,
	);
	assert.equal(checks, 2, "authorization is checked before selection and immediately before commit");
	revokeOnRead = false;
	assert.deepEqual(await ledger.snapshot(), before);
	const retired = await ledger.retired({
		members: [retiredMemberHash("guarded-work", "r1")],
		settled: ["guarded-work"],
	});
	assert.deepEqual(retired.members, []);
	assert.deepEqual(retired.settled, []);
	assert.equal(await ledger.retire(0), 1, "a fresh retirement succeeds after rollback");
});

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
	after.retiredAttempts = await ledger.retired({
		members: [retiredMemberHash(work.id, work.revision)],
		work: [retiredWorkHash("campaign", "1:1")],
	});
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
	after.retiredAttempts = await ledger.retired({ settled: ["loop"] });
	assert.equal(after.attempts.length, 0);
	assert.equal(counted(after), 3, "the settled count survives pruning");
	assert.deepEqual(after.retiredAttempts.settled, [{ id: "loop", count: 3 }]);
});

test("the producer round carries past retirement so fairness does not restart", async (t) => {
	const ledger = await fixture(t);
	await settledAttempt(ledger, "a0", "loop", "alpha");
	const before = await ledger.snapshot();
	const eligible = [
		intent("next-alpha", { rank: 6, producer: "alpha", sequence: 0 }),
		intent("pending-beta", { rank: 6, producer: "beta", sequence: 1 }),
	];
	const served = orderFlowResultProducers(eligible, before);
	assert.deepEqual(served, ["beta", "alpha"]);
	await ledger.retire(0);
	const after = await ledger.snapshot();
	assert.deepEqual(after.retiredAttempts.round, ["beta"]);
	assert.deepEqual(orderFlowResultProducers(eligible, after), served, "ordering is unchanged by retirement");
});

for (const reason of ["protected", "quarantined"])
	test(`nonprefix retirement preserves producer order across reopen: ${reason}`, async (t) => {
		const repo = new MemorySessionRepo();
		const session = await repo.create({}, context);
		t.after(() => repo.close(context));
		const durable = createPiLedgerStore(session);
		let failCommit = false;
		const store = {
			...durable,
			...(reason === "quarantined" ? { readContext: undefined } : {}),
			transact: (update) =>
				durable.transact((state) => {
					const next = update(state);
					if (failCommit) throw new Error("injected retirement failure");
					return next;
				}),
		};
		let ledger = await FlowReceiptLedger.attach(store, scope);
		const eligible = [
			intent("beta", { producer: "beta", sequence: 0 }),
			intent("alpha", { producer: "alpha", sequence: 1 }),
		];
		const outcome = reason === "quarantined" ? "failure" : "success";
		await settledAttempt(ledger, "first", "first-work", "beta", outcome);
		await settledAttempt(ledger, "second", "second-work", "alpha", outcome);
		await settledAttempt(ledger, "third", "third-work", "beta");
		const protectedMembers = new Set(reason === "protected" ? ["first-work", "second-work"] : []);
		const before = orderFlowResultProducers(eligible, await ledger.snapshot());
		assert.deepEqual(before, ["alpha", "beta"]);
		const checkpoint = await ledger.snapshot();
		failCommit = true;
		await assert.rejects(ledger.retire(0, protectedMembers), /injected retirement failure/);
		failCommit = false;
		assert.deepEqual(await ledger.snapshot(), checkpoint);
		assert.equal(await ledger.retire(0, protectedMembers), 1);
		assert.deepEqual(orderFlowResultProducers(eligible, await ledger.snapshot()), before);
		ledger = await FlowReceiptLedger.attach(store, scope);
		assert.deepEqual(orderFlowResultProducers(eligible, await ledger.snapshot()), before);
		const retired = await ledger.retired({
			settled: ["first-work", "second-work", "third-work"],
			members: [retiredMemberHash("third-work", "r1")],
		});
		assert.deepEqual(retired.settled, [{ id: "third-work", count: 1 }]);
		assert.deepEqual(retired.members, [retiredMemberHash("third-work", "r1")]);
		await settledAttempt(ledger, "fourth", "fourth-work", "alpha");
		const next = orderFlowResultProducers(eligible, await ledger.snapshot());
		assert.deepEqual(next, ["beta", "alpha"]);
		assert.equal(await ledger.retire(0, protectedMembers), 1);
		assert.deepEqual(orderFlowResultProducers(eligible, await ledger.snapshot()), next);
		if (reason === "protected") {
			assert.equal(await ledger.retire(0), 2);
			assert.deepEqual(orderFlowResultProducers(eligible, await ledger.snapshot()), next);
		}
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
	await ledger.handoff("filtered", "filtered-request");
	await ledger.requestOutcome("filtered", "filtered-request", "success");
	await ledger.settle("filtered", "success");
	assert.equal(await ledger.retire(0), 1, "indexed context evidence allows retirement without successful inclusion");
	assert.equal((await ledger.snapshot()).attempts.length, 0);
	assert.equal((await ledger.contextSnapshot(["filtered"])).attempts[0].members[1].id, result.id);
});

test("withheld attempts retain full evidence after retirement", async (t) => {
	const ledger = await fixture(t);
	const item = member("withheld-work");
	await ledger.select("withheld", [item], {
		revision: 0,
		intent: intent(item.id),
		coalescedIds: [],
		next: { ...initialFlowAdmission(), revision: 1 },
	});
	const queue = { id: "withheld-queue", revision: 1 };
	await ledger.queued("withheld", queue);
	await ledger.claim("withheld", queue);
	assert.equal(
		await ledger.prepare(
			"withheld",
			"withheld-request",
			[{ id: item.id, revision: item.revision, disposition: "omitted" }],
			false,
		),
		false,
	);
	const before = (await ledger.snapshot()).attempts[0];
	assert.equal(before.phase, "withheld");
	assert.equal(await ledger.retire(0), 1);
	assert.deepEqual((await ledger.snapshot()).attempts, []);
	assert.deepEqual((await ledger.contextSnapshot([before.id])).attempts, [before]);
});

test("archived quarantine crosses the active attempt window and reset isolates context history", async (t) => {
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, context);
	t.after(() => repo.close(context));
	const store = createPiLedgerStore(session);
	const limits = { maxAttempts: 2, maxBytes: 1024 * 1024 };
	let ledger = await FlowReceiptLedger.attach(store, scope, limits);
	const ids = [];
	for (let index = 0; index < 8; index++) {
		const id = `failed-${index}`;
		ids.push(id);
		await settledAttempt(ledger, id, `work-${index}`, "alpha", "failure");
		assert.equal(await ledger.retire(0), 1);
		assert.deepEqual((await ledger.snapshot()).attempts, []);
	}
	ledger = await FlowReceiptLedger.attach(store, scope, limits);
	const state = await ledger.contextSnapshot(ids);
	const triggers = ids.map((id) => retiredMemberHash(`result-${id}`, "r1"));
	assert.deepEqual((await ledger.retired({ triggers })).triggers, triggers);
	assert.deepEqual(
		state.attempts.map((attempt) => attempt.id),
		ids,
	);
	assert.ok(state.attempts.every((attempt) => attempt.outcome === "failure"));
	assert.deepEqual(
		(await ledger.contextSnapshot([ids[0], ids[0], "missing"])).attempts.map((attempt) => attempt.id),
		[ids[0]],
	);
	await ledger.reset();
	assert.deepEqual((await ledger.retired({ triggers })).triggers, []);
	assert.deepEqual((await ledger.contextSnapshot(ids)).attempts, []);
	await ledger.select(ids[0], [member("reused-work")]);
	await ledger.cancel(ids[0], "Cancel reused identity");
	await ledger.retire(0);
	assert.equal((await ledger.contextSnapshot(ids)).attempts[0].members[0].id, "reused-work");
});

test("indexed retirement survives repeated attachments and reset starts a new replay epoch", async (t) => {
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, context);
	t.after(() => repo.close(context));
	const store = createPiLedgerStore(session);
	let ledger = await FlowReceiptLedger.attach(store, scope);
	await settledAttempt(ledger, "first", "loop");
	await ledger.retire(0);
	await assert.rejects(ledger.select("first", [member("different")]), { code: "identity" });
	for (let i = 0; i < 3; i++) ledger = await FlowReceiptLedger.attach(store, scope);
	const query = {
		members: [retiredMemberHash("loop", "r1")],
		work: [retiredWorkHash("campaign", "1:1")],
		settled: ["loop"],
	};
	let facts = await ledger.retired(query);
	assert.equal(facts.members.length, 1);
	assert.equal(facts.work.length, 1);
	assert.deepEqual(facts.settled, [{ id: "loop", count: 1 }]);
	assert.ok(await session.getValue(value("jouzu.flow.attempt-history", JSON.stringify([0, "first"])), context));
	await ledger.reset();
	facts = await ledger.retired(query);
	assert.equal(facts.members.length, 0);
	assert.equal(facts.work.length, 0);
	assert.equal(facts.settled.length, 0);
	await settledAttempt(ledger, "second", "loop");
	await ledger.retire(0);
	facts = await ledger.retired(query);
	assert.deepEqual(facts.settled, [{ id: "loop", count: 1 }]);
});

test("production attachment queries indexed retirement after disk reopen and reset", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "flow-retired-index-"));
	let attachment;
	t.after(async () => {
		await attachment?.close();
		await rm(root, { recursive: true, force: true });
	});
	attachment = await PiFlowAttachment.open(root, scope);
	await settledAttempt(attachment.ledger, "first", "loop");
	await attachment.ledger.retire(0);
	await attachment.close();
	attachment = await PiFlowAttachment.open(root, scope);
	const query = {
		members: [retiredMemberHash("loop", "r1")],
		work: [retiredWorkHash("campaign", "1:1")],
		settled: ["loop"],
	};
	const facts = await attachment.ledger.retired(query);
	assert.deepEqual(facts.members, query.members);
	assert.deepEqual(facts.work, query.work);
	assert.deepEqual(facts.settled, [{ id: "loop", count: 1 }]);
	await attachment.ledger.reset();
	assert.deepEqual(await attachment.ledger.retired(query), emptyRetiredAttempts());
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

test("indexed retirement crosses the old lifetime budget without growing the operational snapshot", async (t) => {
	const spent = Array.from({ length: MAX_RETIRED_FLOW_IDENTITIES }, (_, index) =>
		retiredMemberHash(`spent-${index}`, "r1"),
	);
	const ledger = await fencedFixture(t, spent);
	for (let i = 0; i < 12; i++) {
		await settledAttempt(ledger, `a-${i}`, "loop");
		assert.equal(await ledger.retire(0), 1);
	}
	const state = await ledger.snapshot();
	assert.equal(state.attempts.length, 0);
	assert.equal(state.retiredAttempts.members.length, 0);
	assert.equal(state.retiredAttempts.settled.length, 0);
	assert.ok(Buffer.byteLength(JSON.stringify(state)) < 2000);
	const facts = await ledger.retired({
		members: [spent[0], spent.at(-1), retiredMemberHash("loop", "r1"), retiredMemberHash("fresh", "r1")],
		settled: ["loop"],
	});
	assert.deepEqual(facts.members, [spent[0], spent.at(-1), retiredMemberHash("loop", "r1")]);
	assert.deepEqual(facts.settled, [{ id: "loop", count: 12 }]);
});

/** Drive one attempt to a claimed or prepared state that no provider received, then cancel it. */
async function unsentAttempt(ledger, attemptId, items, { prepare = true, stopped = true } = {}) {
	const revision = (await ledger.snapshot()).admission?.revision ?? 0;
	await ledger.select(attemptId, items, {
		revision,
		intent: intent(items[0].id),
		coalescedIds: [],
		next: { ...initialFlowAdmission(), revision: revision + 1 },
	});
	const queue = { id: `queue-${attemptId}`, revision: 1 };
	await ledger.queued(attemptId, queue);
	await ledger.claim(attemptId, queue);
	if (prepare) await ledger.prepare(attemptId, `request-${attemptId}`, items.map(included), false);
	await ledger.cancel(attemptId, "Host became idle before transport handoff.", stopped);
	return (await ledger.snapshot()).attempts.find((attempt) => attempt.id === attemptId);
}

test("a stopped attempt no provider received offers its work again and keeps its context evidence", async (t) => {
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, context);
	t.after(() => repo.close(context));
	const store = createPiLedgerStore(session);
	let ledger = await FlowReceiptLedger.attach(store, scope);
	const work = member("continuation");
	const stopped = await unsentAttempt(ledger, "stopped", [work]);
	assert.equal(stopped.phase, "cancelled");
	assert.equal(stopped.consumed, true);
	assert.equal(stopped.undelivered, true);
	const memberIntent = { ...intent(work.id), rank: 6, workId: undefined, workRevision: undefined };
	assert.equal(retainedByReceipt(intent(work.id), await ledger.snapshot()), false, "its cadence work is offered again");
	assert.equal(retainedByReceipt(memberIntent, await ledger.snapshot()), false, "its member is offered again");

	// The decision is durable: a new attachment reads the same undelivered attempt.
	ledger = await FlowReceiptLedger.attach(store, scope);
	assert.equal((await ledger.snapshot()).attempts[0].undelivered, true);
	assert.equal(retainedByReceipt(intent(work.id), await ledger.snapshot()), false);

	// Retirement folds no fence for it, and archived context still identifies the copy to exclude.
	assert.equal(await ledger.retire(0), 1);
	const after = await ledger.snapshot();
	after.retiredAttempts = await ledger.retired({
		members: [retiredMemberHash(work.id, work.revision)],
		work: [retiredWorkHash("campaign", "1:1")],
	});
	assert.deepEqual(after.retiredAttempts.members, []);
	assert.deepEqual(after.retiredAttempts.work, []);
	assert.equal(retainedByReceipt(intent(work.id), after), false, "retirement does not fence it");
	const [archived] = (await ledger.contextSnapshot(["stopped"])).attempts;
	assert.equal(archived.undelivered, true);
	assert.deepEqual(archived.members, [work]);
});

test("cancellations other than a Stop of automated input stay fenced", async (t) => {
	const ledger = await fixture(t);
	// Not a Stop: the work is not offered again.
	const failed = await unsentAttempt(ledger, "not-stopped", [member("failed-before-send")], { stopped: false });
	assert.equal(failed.undelivered, undefined);
	assert.equal(retainedByReceipt(intent("failed-before-send"), await ledger.snapshot()), true);
	// A Stop of an attempt that carries a user member: the user's cancellation is final.
	const user = await unsentAttempt(
		ledger,
		"user",
		[member("with-user-input"), { ...member("typed", "user"), required: true }],
		{
			prepare: false,
		},
	);
	assert.equal(user.undelivered, undefined);
	assert.equal(retainedByReceipt(intent("with-user-input"), await ledger.snapshot()), true);
	// A Stop before the queue claim consumed nothing, so there is nothing to mark.
	await ledger.select("unclaimed", [member("queued-only")], {
		revision: (await ledger.snapshot()).admission?.revision ?? 0,
		intent: intent("queued-only"),
		coalescedIds: [],
		next: { ...initialFlowAdmission(), revision: ((await ledger.snapshot()).admission?.revision ?? 0) + 1 },
	});
	await ledger.cancel("unclaimed", "Controller input was not consumed by the native run.", true);
	const unclaimed = (await ledger.snapshot()).attempts.find((attempt) => attempt.id === "unclaimed");
	assert.equal(unclaimed.consumed, false);
	assert.equal(unclaimed.undelivered, undefined);
});

test("only a consumed cancelled attempt can be undelivered", async () => {
	for (const attempt of [
		{ phase: "settled", outcome: "success", consumed: true, undelivered: true },
		{ phase: "cancelled", consumed: false, undelivered: true },
		{ phase: "cancelled", consumed: true, undelivered: false },
	]) {
		let state = {
			schemaVersion: 1,
			scope,
			generation: 1,
			revision: 0,
			attempts: [{ id: "a", generation: 1, members: [member("work")], history: [], requests: [], ...attempt }],
		};
		const store = {
			read: async () => structuredClone(state),
			transact: async (update) => {
				const result = update(structuredClone(state));
				state = result.state;
				return result.result;
			},
		};
		await assert.rejects(
			FlowReceiptLedger.attach(store, scope),
			/Invalid undelivered flow attempt/,
			JSON.stringify(attempt),
		);
	}
});

test("a stopped result no provider received does not count as serving its producer", async (t) => {
	const ledger = await fixture(t);
	const work = member("loop"),
		result = member("result-stopped", "result");
	await ledger.select("stopped", [work, result], {
		revision: 0,
		intent: intent(work.id),
		coalescedIds: [],
		next: { ...initialFlowAdmission(), revision: 1 },
		resultSnapshot: [
			{ id: result.id, revision: "r1", producer: "alpha" },
			{ id: "pending-beta", revision: "r1", producer: "beta" },
		],
	});
	const queue = { id: "queue-stopped", revision: 1 };
	await ledger.queued("stopped", queue);
	await ledger.claim("stopped", queue);
	await ledger.prepare("stopped", "request-stopped", [included(work), included(result)], false);
	await ledger.cancel("stopped", "Host became idle before transport handoff.", true);
	const eligible = [
		intent("next-alpha", { rank: 6, producer: "alpha", sequence: 0 }),
		intent("pending-beta", { rank: 6, producer: "beta", sequence: 1 }),
	];
	// A delivered alpha result would put beta first; the stopped one leaves the round where it was.
	assert.deepEqual(orderFlowResultProducers(eligible, await ledger.snapshot()), ["alpha", "beta"]);
});
