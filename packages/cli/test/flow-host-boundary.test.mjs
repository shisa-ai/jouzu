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

test("idle reconciliation settles an unhanded follow-up after an earlier request started", async (t) => {
	const { ledger, boundary } = await fixture(t);
	const member = { id: "work", revision: "1", disposition: "included", contentHash: "a".repeat(64) };
	await ledger.prepare("attempt", "request-2", [member], false);

	const result = await boundary.reconcile(ledger, "attempt");
	assert.deepEqual(result, { kind: "idle", value: { kind: "settled", attemptId: "attempt" } });
	const attempt = (await ledger.snapshot()).attempts[0];
	assert.equal(attempt.phase, "settled");
	assert.equal(attempt.outcome, "failure");
	assert.equal(attempt.requests.at(-1).handedOff, false);
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

test("detached boundary restores native methods while retained wrappers remain fenced", async (t) => {
	const { session, requests } = await createFlowSession(t);
	const nativePrompt = session.prompt;
	const nativeQueue = session.agent.followUp;
	const boundary = new PiHostBoundary(session);
	const oldPrompt = session.prompt.bind(session);
	const oldQueue = session.agent.followUp.bind(session.agent);
	await boundary.abortAndJoin();
	boundary.close();
	assert.equal(session.prompt, nativePrompt);
	assert.equal(session.agent.followUp, nativeQueue);
	await assert.rejects(oldPrompt("stale"), { code: "stale" });
	assert.throws(() => oldQueue({ role: "user", content: "stale", timestamp: 1 }), { code: "stale" });
	await session.prompt("fresh");
	assert.equal(requests.length, 1);
});

test("detaching preserves methods installed by another owner", async (t) => {
	const { session } = await createFlowSession(t);
	const boundary = new PiHostBoundary(session);
	const replacement = async () => {};
	session.prompt = replacement;
	await boundary.abortAndJoin();
	boundary.close();
	assert.equal(session.prompt, replacement);
	boundary.close();
	assert.equal(session.prompt, replacement);
});

test("close retains the fence until active preflight exits before restoring methods", async (t) => {
	const { session, requests } = await createFlowSession(t);
	const nativePrompt = session.prompt;
	const boundary = new PiHostBoundary(session);
	const entered = deferred(),
		release = deferred();
	session.modelRuntime.hasConfiguredAuth = () => false;
	session.modelRuntime.checkAuth = async () => {
		entered.resolve();
		await release.promise;
		return "fixture-key";
	};
	const running = assert.rejects(session.prompt("late"), { code: "stale" });
	await entered.promise;
	boundary.close();
	assert.notEqual(session.prompt, nativePrompt);
	await assert.rejects(session.prompt("new while draining"), { code: "stale" });
	release.resolve();
	await running;
	assert.equal(session.prompt, nativePrompt);
	assert.deepEqual(requests, []);
});

test("navigation handoff rejects idle and ordinary-operation callers without fencing them", async (t) => {
	const { session, boundary, requests } = await fixture(t);
	assert.throws(() => boundary.handoffNavigation(), { code: "busy" });
	await boundary.atIdle(async () => assert.throws(() => boundary.handoffNavigation(), { code: "busy" }));
	const unsubscribe = session.agent.subscribe((event) => {
		if (event.type === "agent_end") assert.throws(() => boundary.handoffNavigation(), { code: "busy" });
	});
	t.after(unsubscribe);
	await session.prompt("ordinary");
	assert.equal(requests.length, 1);
});

test("navigation handoff preserves a concurrent model operation and refuses early detachment", async (t) => {
	const entered = deferred(),
		release = deferred();
	let boundary;
	const { session } = await createFlowSession(t, {
		ingress: {
			version: 1,
			submit: (_input, dispatch) => dispatch(),
			beforeBranchChange: () => boundary.handoffNavigation(),
		},
		extensions: [
			(pi) =>
				pi.on("model_select", async () => {
					entered.resolve();
					await release.promise;
				}),
		],
	});
	const target = session.sessionManager.appendMessage({ role: "user", content: "target", timestamp: 1 });
	session.sessionManager.appendMessage({ role: "user", content: "later", timestamp: 2 });
	boundary = new PiHostBoundary(session);
	t.after(() => boundary.close());
	const changing = session.setModel({ ...model, id: "other" });
	await entered.promise;
	await assert.rejects(session.navigateTree(target), { code: "busy" });
	assert.equal((await boundary.atIdle(async () => {})).kind, "busy");
	release.resolve();
	await changing;
	assert.equal((await boundary.atIdle(async () => {})).kind, "idle");
});

test("idle listeners run after maintenance exits and are removed on close", async (t) => {
	const { boundary } = await fixture(t);
	let inside = false;
	const notified = deferred();
	let calls = 0;
	boundary.onIdle(() => {
		assert.equal(inside, false);
		calls++;
		notified.resolve();
	});
	await boundary.atQueueMaintenance(async () => {
		inside = true;
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(calls, 0);
		inside = false;
	});
	await notified.promise;
	assert.equal(calls, 1);
	await boundary.atQueueMaintenance(async () => {});
	boundary.close();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls, 1);
});

test("idle listeners recheck streaming state before notification", async (t) => {
	const { boundary, session } = await fixture(t);
	let calls = 0;
	boundary.onIdle(() => calls++);
	await boundary.atQueueMaintenance(async () => {});
	session.agent.state.isStreaming = true;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls, 0);
	session.agent.state.isStreaming = false;
	await boundary.atQueueMaintenance(async () => {});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls, 1);
});

test("ordinary prompt preflight cannot enter idle maintenance", async (t) => {
	let boundary;
	const results = [];
	const { session } = await createFlowSession(t, {
		extensions: [
			(pi) =>
				pi.on("input", async () => {
					results.push(await boundary.atIdle(async () => "entered"));
					return { action: "continue" };
				}),
		],
	});
	boundary = new PiHostBoundary(session);
	t.after(() => boundary.close());
	await session.prompt("ordinary input");
	assert.deepEqual(results, [{ kind: "busy" }]);
});

test("registered commands can maintain an idle session but literal command text cannot", async (t) => {
	let boundary;
	const commands = [],
		inputs = [];
	const { session } = await createFlowSession(t, {
		extensions: [
			(pi) => {
				pi.registerCommand("repair", {
					description: "Repair fixture state",
					handler: async () => {
						commands.push(await boundary.atIdle(async () => "repaired"));
					},
				});
				pi.on("input", async () => {
					inputs.push(await boundary.atIdle(async () => "entered"));
					return { action: "continue" };
				});
			},
		],
	});
	boundary = new PiHostBoundary(session);
	t.after(() => boundary.close());
	await session.prompt("/repair argument");
	await session.prompt("/repair", { expandPromptTemplates: false });
	await session.prompt("/unknown");
	assert.deepEqual(commands, [{ kind: "idle", value: "repaired" }]);
	assert.deepEqual(inputs, [{ kind: "busy" }, { kind: "busy" }]);
});

test("a registered command cannot enter maintenance during another host turn", async (t) => {
	let boundary;
	const entered = deferred(),
		release = deferred();
	const results = [];
	const { session } = await createFlowSession(t, {
		extensions: [
			(pi) =>
				pi.registerCommand("repair", {
					description: "Repair fixture state",
					handler: async () => {
						results.push(await boundary.atIdle(async () => "repaired"));
					},
				}),
		],
	});
	boundary = new PiHostBoundary(session);
	t.after(() => boundary.close());
	const unsubscribe = session.agent.subscribe(async (event) => {
		if (event.type === "agent_end") {
			entered.resolve();
			await release.promise;
		}
	});
	t.after(unsubscribe);
	const running = session.prompt("start");
	await entered.promise;
	try {
		await session.prompt("/repair");
		assert.deepEqual(results, [{ kind: "busy" }]);
	} finally {
		release.resolve();
		await running;
	}
	await session.prompt("/repair");
	assert.deepEqual(results.at(-1), { kind: "idle", value: "repaired" });
});
