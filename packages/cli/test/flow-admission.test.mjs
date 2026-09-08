import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chooseFlowIntent, initialFlowAdmission, validateFlowChoice } from "../dist/flow-control/admission.js";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";

const gates = { hostReady: true, userPending: false, recoveryBlocked: false, waitingWorkIds: [] };
const intent = (id, rank = 4, producer = id, sequence = 0) => ({
	id,
	revision: "1",
	producer,
	sequence,
	rank,
	workId: id,
	workRevision: "1",
	independent: false,
	runnable: true,
});
const choose = (state, items, overrides = {}) => chooseFlowIntent(state, items, { ...gates, ...overrides });

test("user input, busy host, and recovery gates withhold automatic selection", () => {
	const state = initialFlowAdmission();
	for (const overrides of [{ userPending: true }, { hostReady: false }, { recoveryBlocked: true }])
		assert.equal(choose(state, [intent("work")], overrides), undefined);
	assert.deepEqual(state, initialFlowAdmission());
});

test("waits hold owning and unclassified work and ordinary results while allowing declared independent work", () => {
	const items = [
		intent("blocked"),
		intent("unknown"),
		intent("result", 6),
		{ ...intent("independent"), independent: true },
	];
	const selected = choose(initialFlowAdmission(), items, { waitingWorkIds: ["blocked"] });
	assert.equal(selected.intent.id, "independent");
	assert.equal(
		choose(initialFlowAdmission(), [{ ...intent("blocked"), independent: true }], { waitingWorkIds: ["blocked"] }),
		undefined,
	);
	for (const rank of [2, 3])
		assert.equal(
			choose(initialFlowAdmission(), [intent("decision", rank)], { waitingWorkIds: ["blocked"] }).intent.rank,
			rank,
		);
});

test("urgent and decision events precede work without consuming cadence debt", () => {
	const state = initialFlowAdmission();
	state.cadenceDebt = 4;
	const first = choose(state, [intent("work"), intent("cadence", 5), intent("decision", 3), intent("urgent", 2)]);
	assert.equal(first.intent.id, "urgent");
	assert.equal(first.next.cadenceDebt, 4);
	assert.equal(choose(first.next, [intent("work"), intent("cadence", 5), intent("decision", 3)]).intent.id, "decision");
});

test("oldest eligible intent and producer round-robin both hold", () => {
	let state = initialFlowAdmission();
	let items = [intent("a1", 4, "a", 1), intent("a2", 4, "a", 3), intent("b1", 4, "b", 2)];
	const order = [];
	while (items.length) {
		const choice = choose(state, items);
		order.push(choice.intent.id);
		state = choice.next;
		items = items.filter((item) => item.id !== choice.intent.id);
	}
	assert.deepEqual(order, ["a1", "b1", "a2"]);
});

test("continuous rank-four arrivals cannot displace an existing cadence round", () => {
	const producers = 3;
	let state = initialFlowAdmission();
	let items = [
		intent("work-0", 4, "work", 0),
		...Array.from({ length: producers }, (_, i) => intent(`cadence-${i}`, 5, `cadence-${i}`, 100 + i)),
	];
	const selected = new Map();
	for (let opportunity = 1; opportunity <= 5 * producers; opportunity++) {
		const choice = choose(state, items);
		state = choice.next;
		selected.set(choice.intent.id, opportunity);
		items = items.filter((item) => item.id !== choice.intent.id);
		if (choice.intent.rank === 4) items.push(intent(`work-${opportunity}`, 4, "work", opportunity));
		items.push(intent(`new-${opportunity}`, 5, `new-${opportunity}`, 1000 + opportunity));
	}
	assert.deepEqual(
		[0, 1, 2].map((i) => selected.get(`cadence-${i}`)),
		[5, 10, 15],
	);
});

test("duplicate work drivers coalesce while distinct occurrences remain separate", () => {
	const work = intent("task", 4, "task", 1);
	const duplicate = { ...intent("loop", 5, "loop", 2), workId: work.workId, workRevision: work.workRevision };
	const next = choose(initialFlowAdmission(), [work, duplicate, intent("schedule", 4, "schedule", 3)]);
	assert.equal(next.intent.id, "task");
	assert.deepEqual(next.coalescedIds, ["loop"]);
	assert.equal(next.next.cadenceDebt, 0);
});

test("a returning producer joins after the surviving round", () => {
	const a = intent("a", 5, "a", 0);
	const b = intent("b", 5, "b", 1);
	const c = intent("c", 5, "c", 2);
	const d = intent("d", 5, "d", 3);
	const first = choose(initialFlowAdmission(), [a, b, c, d]);
	assert.equal(first.intent.id, "a");
	const second = choose(first.next, [a, c, d]);
	assert.equal(second.intent.id, "c");
	const third = choose(second.next, [a, b, c, d]);
	assert.equal(third.intent.id, "d");
});

test("preview and rejected choices leave fairness state unchanged", () => {
	const state = initialFlowAdmission();
	const items = [intent("work"), intent("cadence", 5)];
	const first = choose(state, items);
	first.next.cadenceDebt = 4;
	first.intent.id = "mutated";
	const second = choose(state, items);
	assert.equal(second.intent.id, "work");
	assert.equal(second.next.cadenceDebt, 1);
	assert.equal(state.cadenceDebt, 0);
});

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-admission-"));
	let attachment = await PiFlowAttachment.open(root, { sessionId: "session", branchId: "main" });
	t.after(async () => {
		await attachment.close();
		await rm(root, { recursive: true, force: true });
	});
	return {
		get ledger() {
			return attachment.ledger;
		},
		async reopen() {
			await attachment.close();
			attachment = await PiFlowAttachment.open(root, { sessionId: "session", branchId: "main" });
		},
	};
}
const member = { id: "work", revision: "1", kind: "work", required: true, contentHash: "a".repeat(64) };
const included = [
	{ id: member.id, revision: member.revision, disposition: "included", contentHash: member.contentHash },
];
async function prepared(f, choice) {
	await f.ledger.select("attempt", [member], choice);
	await f.ledger.queued("attempt", { id: "queue", revision: 1 });
	await f.ledger.claim("attempt", { id: "queue", revision: 1 });
	await f.ledger.prepare("attempt", "request", included, false);
}

test("authoritative payload inclusion atomically charges once and survives reattachment", async (t) => {
	const f = await fixture(t);
	const choice = choose((await f.ledger.snapshot()).admission, [intent("work"), intent("cadence", 5)]);
	await prepared(f, choice);
	assert.equal((await f.ledger.snapshot()).admission.cadenceDebt, 0);
	await f.ledger.payload("attempt", "request", { api: "fixture", bytes: 1, hash: "a".repeat(64), inclusion: included });
	let state = await f.ledger.snapshot();
	assert.equal(state.admission.cadenceDebt, 1);
	assert.equal(state.attempts[0].admission.charged, true);
	await f.ledger.handoff("attempt", "request");
	await f.ledger.requestOutcome("attempt", "request", "success");
	await f.ledger.prepare("attempt", "tool-loop", included, false);
	await f.ledger.payload("attempt", "tool-loop", {
		api: "fixture",
		bytes: 1,
		hash: "a".repeat(64),
		inclusion: included,
	});
	assert.equal((await f.ledger.snapshot()).admission.cadenceDebt, 1);
	await f.reopen();
	state = await f.ledger.snapshot();
	assert.equal(state.admission.cadenceDebt, 1);
	assert.equal(state.admission.revision, 1);
});

test("payload rejection preserves the persisted service counter", async (t) => {
	const f = await fixture(t);
	const choice = choose((await f.ledger.snapshot()).admission, [intent("work"), intent("cadence", 5)]);
	await prepared(f, choice);
	await f.ledger.payload("attempt", "request", {
		api: "fixture",
		bytes: 1,
		hash: "a".repeat(64),
		inclusion: [{ id: "work", revision: "1", disposition: "omitted" }],
	});
	await f.reopen();
	assert.equal((await f.ledger.snapshot()).admission.cadenceDebt, 0);
	assert.equal((await f.ledger.snapshot()).admission.revision, 0);
});

test("stale or unrelated admission choices cannot reserve another member", async (t) => {
	const f = await fixture(t);
	const choice = choose((await f.ledger.snapshot()).admission, [intent("work")]);
	choice.revision = 1;
	choice.next.revision = 2;
	await assert.rejects(f.ledger.select("attempt", [member], choice), { code: "stale" });
	const unrelated = choose((await f.ledger.snapshot()).admission, [intent("other")]);
	await assert.rejects(f.ledger.select("attempt", [member], unrelated), { code: "stale" });
});

test("filtering the selected optional trigger does not charge another included result", async (t) => {
	const f = await fixture(t);
	const choice = choose((await f.ledger.snapshot()).admission, [intent("work", 6)]);
	const members = [
		{ ...member, kind: "result", required: false },
		{ ...member, id: "other", kind: "result", required: false },
	];
	const receipts = members.map(({ id, revision, contentHash }) => ({
		id,
		revision,
		contentHash,
		disposition: "included",
	}));
	await f.ledger.select("attempt", members, choice);
	await f.ledger.queued("attempt", { id: "queue", revision: 1 });
	await f.ledger.claim("attempt", { id: "queue", revision: 1 });
	await f.ledger.prepare("attempt", "request", receipts, false);
	await f.ledger.payload("attempt", "request", {
		api: "fixture",
		bytes: 1,
		hash: "a".repeat(64),
		inclusion: [{ id: "work", revision: "1", disposition: "omitted" }, receipts[1]],
	});
	await f.ledger.handoff("attempt", "request");
	await f.reopen();
	const state = await f.ledger.snapshot();
	assert.equal(state.admission.revision, 0);
	assert.equal(state.attempts[0].admission.charged, false);
	assert.equal(state.attempts[0].requests[0].handedOff, true);
});

test("result boundary snapshots accept legacy absence and reject corrupt or repeated identities", () => {
	const choice = choose(initialFlowAdmission(), [intent("work")]);
	validateFlowChoice(choice);
	validateFlowChoice({ ...choice, resultSnapshot: [{ id: "result", revision: "1" }] });
	for (const resultSnapshot of [
		null,
		{},
		[{ id: "", revision: "1" }],
		[{ id: "result", revision: "1", producer: "" }],
		[
			{ id: "a", revision: "1" },
			{ id: "a", revision: "2" },
		],
	])
		assert.throws(() => validateFlowChoice({ ...choice, resultSnapshot }), { code: "schema" });
});

test("aggregate sample membership must be unique and belong to the boundary snapshot", () => {
	const choice = {
		...choose(initialFlowAdmission(), [intent("work")]),
		resultSnapshot: [{ id: "a", revision: "1", producer: "alpha" }],
	};
	validateFlowChoice({ ...choice, resultSamples: [] });
	validateFlowChoice({ ...choice, resultSamples: [{ id: "a", revision: "1" }] });
	for (const resultSamples of [
		[{ id: "b", revision: "1" }],
		[{ id: "a", revision: "2" }],
		[
			{ id: "a", revision: "1" },
			{ id: "a", revision: "1" },
		],
	])
		assert.throws(() => validateFlowChoice({ ...choice, resultSamples }), { code: "schema" });
});

test("inactive work cannot request or continue, while independent work and retained outcomes remain eligible", () => {
	for (const rank of [4, 5]) {
		assert.equal(
			choose(initialFlowAdmission(), [{ ...intent("retired", rank), independent: true }], {
				inactiveWorkIds: ["retired"],
			}),
			undefined,
		);
	}
	assert.equal(
		choose(initialFlowAdmission(), [intent("retired"), intent("independent")], {
			inactiveWorkIds: ["retired"],
		}).intent.id,
		"independent",
	);
	for (const rank of [2, 3, 6])
		assert.equal(
			choose(initialFlowAdmission(), [intent("retired", rank)], {
				inactiveWorkIds: ["retired"],
			}).intent.rank,
			rank,
		);
	assert.throws(() => choose(initialFlowAdmission(), [intent("work")], { inactiveWorkIds: [42] }), { code: "schema" });
});
