import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chooseFlowIntent } from "../dist/flow-control/admission.js";
import { retiredMemberHash, retiredWorkHash } from "../dist/flow-control/attempt-retention.js";
import { retainedByReceipt } from "../dist/flow-control/controller.js";
import { FlowModelInput } from "../dist/flow-control/model-input.js";
import { MultiloopFlowProducer, multiloopWorkBinding } from "../dist/flow-control/multiloop-producer.js";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-loop-revisions-"));
	const attachment = await PiFlowAttachment.open(root, { sessionId: "session", branchId: "branch" });
	const lane = { lane: "sweep", runTag: "revision" };
	const work = await attachment.waits.activateWorkBinding(multiloopWorkBinding(lane), Date.now());
	const producer = new MultiloopFlowProducer(
		attachment,
		async () => work,
		() => work.id,
		() => {},
	);
	t.after(async () => {
		producer.close();
		await attachment.close();
		await rm(root, { recursive: true, force: true });
	});
	const ledger = attachment.ledger;
	const signal = new AbortController().signal;
	const admitted = [];
	const submit = (text) =>
		producer.submit({ lane, reason: text, build: () => text, admitted: () => admitted.push(text) });
	const snapshot = async () => (await producer.snapshot(signal))[0];
	const fenced = async (intent) => {
		const state = await ledger.snapshot();
		state.retiredAttempts = await ledger.retired({
			members: [retiredMemberHash(intent.id, intent.revision)],
			work: [retiredWorkHash(intent.workId, intent.workRevision)],
		});
		return retainedByReceipt(intent, state);
	};
	const queue = async (id) => {
		const intent = await snapshot();
		const choice = chooseFlowIntent((await ledger.snapshot()).admission, [intent], {
			hostReady: true,
			userPending: false,
			recoveryBlocked: false,
			waitingWorkIds: [],
		});
		assert.ok(choice);
		const input = FlowModelInput.compose(id, [await producer.build(intent, signal)], 4096);
		await ledger.select(id, input.members, choice);
		const queue = { id: `queue-${id}`, revision: 1 };
		await ledger.queued(id, queue);
		assert.deepEqual(await snapshot(), intent, "selection and queueing do not change the offered revision");
		return { intent, input, queue };
	};
	const begin = async (id, outcome = "success") => {
		const selected = await queue(id);
		await ledger.claim(id, selected.queue);
		producer.admitted((await ledger.snapshot()).attempts.find((attempt) => attempt.id === id));
		assert.equal(producer.retained(lane), false);
		await ledger.prepare(
			id,
			`request-${id}`,
			selected.input.members.map((member) => ({
				id: member.id,
				revision: member.revision,
				contentHash: member.contentHash,
				disposition: "included",
			})),
			false,
		);
		await ledger.handoff(id, `request-${id}`);
		await ledger.requestOutcome(id, `request-${id}`, outcome);
		return selected.intent;
	};
	return { producer, lane, ledger, signal, admitted, submit, snapshot, fenced, queue, begin };
}

for (const earlySnapshot of [false, true])
	for (const retire of [false, true])
		test(`a pending multiloop revision advances after settlement: early snapshot=${earlySnapshot}, retire=${retire}`, async (t) => {
			const f = await fixture(t);
			f.submit("first");
			const first = await f.begin("first");
			f.submit("second");
			if (earlySnapshot) {
				const pending = await f.snapshot();
				assert.equal(pending.revision, first.revision);
				assert.equal(f.producer.retained(f.lane), true);
			}
			await f.ledger.settle("first", "success");
			if (retire) assert.equal(await f.ledger.retire(0), 1);
			const next = await f.snapshot();
			assert.equal(next.revision, "2", "an early read must not freeze the predecessor's revision");
			assert.equal(next.runnable, true);
			assert.equal(await f.fenced(next), false);
			assert.equal((await f.producer.build(next, f.signal)).text, "second");
			await assert.rejects(f.producer.build(first, f.signal), { code: "stale" });
			await f.begin("second");
			await f.ledger.settle("second", "success");
			assert.equal((await f.snapshot()).revision, "2", "consumption freezes the revision against replay");
			assert.equal(await f.fenced(await f.snapshot()), true);
			assert.equal(f.producer.retained(f.lane), false);
			assert.deepEqual(f.admitted, ["first", "second"]);
		});

for (const outcome of ["failure", "aborted"])
	test(`a pending multiloop continuation preserves the ${outcome} receipt`, async (t) => {
		const f = await fixture(t);
		f.submit("first");
		await f.begin("first", outcome);
		f.submit("second");
		await f.snapshot();
		await f.ledger.settle("first", outcome);
		const next = await f.snapshot();
		assert.equal(next.revision, "1");
		assert.equal(next.runnable, false);
		assert.equal(await f.fenced(next), true);
		await assert.rejects(f.producer.build(next, f.signal), { code: "stale" });
		assert.equal(await f.ledger.retire(0), 1);
		assert.equal((await f.snapshot()).revision, "1");
		assert.equal(await f.fenced(await f.snapshot()), true, "retirement preserves the failed revision's fence");
		assert.deepEqual(f.admitted, ["first"]);
	});

test("an unconsumed cancelled multiloop continuation can reuse its revision", async (t) => {
	const f = await fixture(t);
	f.submit("first");
	const first = await f.queue("first");
	f.submit("replacement");
	await f.ledger.cancel("first", "Superseded before consumption");
	const next = await f.snapshot();
	assert.equal(next.revision, first.intent.revision);
	assert.equal(next.runnable, true);
	assert.equal(await f.fenced(next), false);
	assert.equal((await f.producer.build(next, f.signal)).text, "replacement");
	await f.begin("replacement");
	await f.ledger.settle("replacement", "success");
	assert.deepEqual(f.admitted, ["replacement"]);
});

test("a consumed cancelled multiloop continuation remains fenced", async (t) => {
	const f = await fixture(t);
	f.submit("first");
	const first = await f.queue("first");
	await f.ledger.claim("first", first.queue);
	f.producer.admitted((await f.ledger.snapshot()).attempts[0]);
	f.submit("second");
	await f.snapshot();
	await f.ledger.cancel("first", "Consumed but not sent");
	const next = await f.snapshot();
	assert.equal(next.revision, "1");
	assert.equal(next.runnable, false);
	assert.equal(await f.fenced(next), true);
	assert.deepEqual(f.admitted, ["first"]);
});

for (const accounted of [true, false])
	test(`a multiloop continuation stopped before any provider received it is sent again and counted once: accounted=${accounted}`, async (t) => {
		const f = await fixture(t);
		f.submit("first");
		const first = await f.queue("first");
		await f.ledger.claim("first", first.queue);
		// A Stop can also land between the durable claim and the producer's accounting callback.
		if (accounted) f.producer.admitted((await f.ledger.snapshot()).attempts[0]);
		await f.ledger.cancel("first", "Host became idle before transport handoff.", true);
		assert.equal((await f.ledger.snapshot()).attempts[0].undelivered, true);
		const next = await f.snapshot();
		assert.equal(next.revision, first.intent.revision, "the same continuation is offered again");
		assert.equal(next.runnable, true);
		assert.equal(await f.fenced(next), false);
		await f.begin("again");
		await f.ledger.settle("again", "success");
		assert.deepEqual(f.admitted, ["first"], "the loop turn is counted once");
		assert.equal(await f.fenced(await f.snapshot()), true, "the delivered continuation is fenced");
	});
