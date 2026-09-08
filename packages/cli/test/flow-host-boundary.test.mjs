import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { createFlowSession, deferred, model, tick } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { PiHostBoundary } from "../dist/flow-control/pi-host-boundary.js";
import { createPiLedgerStore } from "../dist/flow-control/pi-ledger-store.js";
import { FlowReceiptLedger } from "../dist/flow-control/receipt-ledger.js";

async function fixture(t, phase = "running") {
	const host = await createFlowSession(t);
	await host.session.prompt("initial");
	host.requests.length = 0;
	const repo = new MemorySessionRepo();
	t.after(() => repo.close(context));
	const ledger = await FlowReceiptLedger.attach(createPiLedgerStore(await repo.create({}, context)), {
		sessionId: host.session.sessionId,
		branchId: "main",
	});
	const member = { id: "work", revision: "1", kind: "work", required: true, contentHash: "a".repeat(64) };
	await ledger.select("attempt", [member]);
	await ledger.queued("attempt", { id: "queue", revision: 1 });
	await ledger.claim("attempt", { id: "queue", revision: 1 });
	if (phase !== "claimed")
		await ledger.prepare(
			"attempt",
			"request",
			[{ id: "work", revision: "1", disposition: "included", contentHash: member.contentHash }],
			false,
		);
	if (["running", "handed-off"].includes(phase)) await ledger.handoff("attempt", "request");
	if (phase === "running") await ledger.requestOutcome("attempt", "request", "success");
	const boundary = new PiHostBoundary(host.session);
	t.after(() => boundary.close());
	return { ...host, ledger, boundary };
}

test("idle reconciliation settles known outcomes and is idempotent", async (t) => {
	const { ledger, boundary } = await fixture(t);
	assert.deepEqual(await boundary.reconcile(ledger, "attempt"), {
		kind: "idle",
		value: { kind: "settled", attemptId: "attempt" },
	});
	assert.equal((await ledger.snapshot()).attempts[0].outcome, "success");
	assert.equal((await ledger.snapshot()).activeAttemptId, undefined);
	assert.equal((await boundary.reconcile(ledger, "attempt")).value.kind, "inactive");
});

for (const phase of ["claimed", "prepared", "handed-off"])
	test(`idle reconciliation preserves unsent versus unknown evidence: ${phase}`, async (t) => {
		const { ledger, boundary } = await fixture(t, phase);
		const result = await boundary.reconcile(ledger, "attempt");
		assert.equal(result.value.kind, phase === "handed-off" ? "uncertain" : "cancelled");
		const attempt = (await ledger.snapshot()).attempts[0];
		assert.equal(attempt.phase, result.value.kind);
		assert.equal(attempt.outcome, undefined);
	});

test("new user input waits for the durable settlement transaction", async (t) => {
	const { session, ledger, boundary, requests } = await fixture(t);
	const entered = deferred(),
		release = deferred();
	const settle = ledger.settle.bind(ledger);
	t.mock.method(ledger, "settle", async (...args) => {
		entered.resolve();
		await release.promise;
		await settle(...args);
	});
	const reconciling = boundary.reconcile(ledger, "attempt");
	await entered.promise;
	const before = session.messages.length;
	const input = session.prompt("new user input");
	await tick();
	assert.equal(requests.length, 0);
	assert.equal(session.messages.length, before);
	assert.equal((await boundary.atIdle(async () => {})).kind, "busy");
	release.resolve();
	await reconciling;
	await input;
	assert.equal(requests.length, 1);
	assert.equal((await ledger.snapshot()).activeAttemptId, undefined);
});

test("failed settlement releases waiting input while preserving the reservation", async (t) => {
	const { session, ledger, boundary, requests } = await fixture(t);
	const entered = deferred(),
		release = deferred();
	t.mock.method(ledger, "settle", async () => {
		entered.resolve();
		await release.promise;
		throw new Error("storage failed");
	});
	const reconciling = boundary.reconcile(ledger, "attempt");
	await entered.promise;
	const input = session.prompt("new user input");
	release.resolve();
	await assert.rejects(reconciling, /storage failed/);
	await input;
	assert.equal(requests.length, 1);
	assert.equal((await ledger.snapshot()).activeAttemptId, "attempt");
});

test("direct Agent execution and awaited agent_end handlers are busy boundaries", async (t) => {
	const { session, ledger, boundary } = await fixture(t);
	const entered = deferred(),
		release = deferred();
	const unsubscribe = session.agent.subscribe(async (event) => {
		if (event.type === "agent_end") {
			entered.resolve();
			await release.promise;
		}
	});
	t.after(unsubscribe);
	const run = session.agent.prompt("direct user input");
	await entered.promise;
	assert.equal((await boundary.reconcile(ledger, "attempt")).kind, "busy");
	release.resolve();
	await run;
	assert.equal((await boundary.reconcile(ledger, "attempt")).value.kind, "settled");
});

test("idle callbacks cannot dispatch or synchronously enqueue native input", async (t) => {
	const { session, boundary } = await fixture(t);
	await boundary.atIdle(async () => {
		await assert.rejects(session.prompt("nested"), { code: "busy" });
		assert.throws(() => session.agent.followUp({ role: "user", content: "nested", timestamp: 1 }), { code: "busy" });
	});
	assert.equal(session.agent.hasQueuedMessages(), false);
});

test("a closed boundary rejects queued operations after the transaction exits", async (t) => {
	const { session, boundary, requests } = await fixture(t);
	const entered = deferred(),
		release = deferred();
	const running = boundary.atIdle(async () => {
		entered.resolve();
		await release.promise;
	});
	await entered.promise;
	const input = session.prompt("late input");
	boundary.close();
	release.resolve();
	await assert.rejects(running, { code: "stale" });
	await assert.rejects(input, { code: "stale" });
	assert.equal(requests.length, 0);
});

test("native queued input prevents settlement until it is consumed or cancelled", async (t) => {
	const { session, ledger, boundary } = await fixture(t);
	const queued = session.agent.followUp({ role: "user", content: "waiting", timestamp: 1 });
	assert.equal((await boundary.reconcile(ledger, "attempt")).kind, "busy");
	session.agent.cancelQueuedMessage(queued.id, queued.revision);
	assert.equal((await boundary.reconcile(ledger, "attempt")).value.kind, "settled");
});

test("branch navigation invalidates the original settlement attachment", async (t) => {
	const { session, ledger, boundary } = await fixture(t);
	const target = session.sessionManager
		.getBranch()
		.find((entry) => entry.type === "message" && entry.message.role === "user");
	assert.ok(target);
	await session.navigateTree(target.id);
	await assert.rejects(boundary.reconcile(ledger, "attempt"), { code: "scope" });
	assert.equal((await ledger.snapshot()).activeAttemptId, "attempt");
});

test("nested host operations remain busy after their parent stops awaiting them", async (t) => {
	const entered = deferred(),
		release = deferred();
	const { session } = await createFlowSession(t, {
		extensions: [
			(pi) =>
				pi.on("model_select", async () => {
					entered.resolve();
					await release.promise;
				}),
		],
	});
	const boundary = new PiHostBoundary(session);
	t.after(() => boundary.close());
	let modelChange;
	const unsubscribe = session.agent.subscribe((event) => {
		if (event.type === "agent_end") modelChange = session.setModel({ ...model, id: "other" });
	});
	t.after(unsubscribe);
	await session.prompt("start");
	await entered.promise;
	assert.equal(session.isIdle, true);
	assert.equal((await boundary.atIdle(async () => {})).kind, "busy");
	release.resolve();
	await modelChange;
	assert.equal((await boundary.atIdle(async () => {})).kind, "idle");
});

test("shutdown joins delayed user preflight and fences its eventual native run", async (t) => {
	const { session, boundary, requests } = await fixture(t);
	const entered = deferred(),
		release = deferred();
	session.modelRuntime.hasConfiguredAuth = () => false;
	session.modelRuntime.checkAuth = async () => {
		entered.resolve();
		await release.promise;
		return "fixture-key";
	};
	const running = assert.rejects(session.prompt("user input"), { code: "stale" });
	await entered.promise;
	let closed = false;
	const closing = boundary.abortAndJoin().then(() => {
		closed = true;
	});
	await tick();
	assert.equal(closed, false);
	await assert.rejects(session.prompt("new input"), { code: "stale" });
	assert.throws(() => session.agent.followUp({ role: "user", content: "new queued input", timestamp: 1 }), {
		code: "stale",
	});
	release.resolve();
	await Promise.all([running, closing]);
	assert.equal(closed, true);
	assert.deepEqual(requests, []);
});

test("shutdown joins an idle transaction and rejects operations already waiting behind it", async (t) => {
	const { session, boundary, requests } = await fixture(t);
	const entered = deferred(),
		release = deferred();
	const transaction = boundary.atIdle(async () => {
		entered.resolve();
		await release.promise;
	});
	await entered.promise;
	const waiting = assert.rejects(session.prompt("waiting user"), { code: "stale" });
	let closed = false;
	const closing = boundary.abortAndJoin().then(() => {
		closed = true;
	});
	await tick();
	assert.equal(closed, false);
	release.resolve();
	await Promise.all([transaction, waiting, closing]);
	assert.deepEqual(requests, []);
	await boundary.abortAndJoin();
});

test("shutdown refuses to join its own idle callback without fencing the session", async (t) => {
	const { session, boundary, requests } = await fixture(t);
	await boundary.atIdle(async () => {
		await assert.rejects(boundary.abortAndJoin(), { code: "busy" });
	});
	await session.prompt("still usable");
	assert.equal(requests.length, 1);
});
