import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, setValue, value } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { createFlowWaitDecisionProducer } from "../dist/flow-control/wait-decisions.js";
import { declareIngressWait, fixture, ingressWaitClock, waitForFlow } from "./fixtures/flow-session-ingress.mjs";

test("durable waits hold semantic work across reopen and allow independent work", async (t) => {
	const f = await fixture(t, { provider: true, admit: null });
	await declareIngressWait(f.ingress.branch());
	await f.ingress.dispose();
	const next = await fixture(t, {
		root: f.root,
		provider: true,
		admit: null,
		manager: SessionManager.open(f.session.sessionManager.getSessionFile()),
	});
	const branch = next.ingress.branch(),
		built = [];
	branch.controller.register({
		version: 1,
		namespace: "wait-test",
		snapshot: async () =>
			["work", "independent"].map((id, index) => ({
				id,
				revision: "1",
				producer: "wait-test",
				sequence: index,
				rank: 4,
				workId: id,
				workRevision: "1",
				independent: true,
				runnable: true,
			})),
		build: async (intent) => {
			built.push(intent.id);
			return { id: intent.id, revision: "1", kind: "work", text: `execute ${intent.id}` };
		},
	});
	await branch.controller.wake();
	assert.deepEqual(built, ["independent"]);
	assert.equal(next.sent.length, 1);
	await branch.attachment.waits.cancel("wait", "dependency no longer required", 20);
	await branch.controller.wake();
	assert.deepEqual(built, ["independent", "work"]);
	assert.equal(next.sent.length, 2);
});

test("durable wait permits user status input and holds unclassified automated input", async (t) => {
	const f = await fixture(t, { provider: true, admit: null });
	const branch = f.ingress.branch();
	await declareIngressWait(branch);
	await f.session.sendUserMessage("automated continuation");
	assert.equal(f.sent.length, 0);
	await f.session.prompt("status please");
	assert.equal(f.sent.length, 1);
	assert.equal((await branch.attachment.waits.snapshot())[0].expiresAt, 100);
	assert.deepEqual(branch.host.gate().waitingWorkIds, ["work"]);
});

test("a wait declared after semantic enqueue prevents native consumption", async (t) => {
	const f = await fixture(t, { provider: true, admit: null });
	const branch = f.ingress.branch(),
		queued = deferred(),
		proceed = deferred();
	const run = branch.host.run.bind(branch.host);
	t.mock.method(branch.host, "run", async () => {
		queued.resolve();
		await proceed.promise;
		await run();
	});
	branch.controller.register({
		version: 1,
		namespace: "wait-preemption",
		snapshot: async () => [
			{
				id: "work",
				revision: "1",
				producer: "wait-preemption",
				sequence: 1,
				rank: 4,
				workId: "work",
				workRevision: "1",
				independent: true,
				runnable: true,
			},
		],
		build: async () => ({ id: "work", revision: "1", kind: "work", text: "work before wait" }),
	});
	const waking = branch.controller.wake();
	await queued.promise;
	await declareIngressWait(branch);
	proceed.resolve();
	await waking;
	assert.equal(f.sent.length, 0);
	assert.equal(f.session.agent.inspectQueuedMessages().length, 0);
	const [attempt] = (await branch.attachment.ledger.snapshot()).attempts;
	assert.equal(attempt.phase, "cancelled");
	assert.equal(attempt.consumed, false);
	assert.equal(attempt.requests.length, 0);
});

test("host admission override cannot bypass a wait declared while the override is awaited", async (t) => {
	const entered = deferred(),
		proceed = deferred();
	const f = await fixture(t, {
		provider: true,
		admit: async () => {
			entered.resolve();
			await proceed.promise;
			return true;
		},
	});
	const sending = f.session.sendUserMessage("automated callback");
	await entered.promise;
	await declareIngressWait(f.ingress.branch());
	proceed.resolve();
	await sending;
	assert.equal(f.sent.length, 0);
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	assert.equal(record.dispatch, undefined);
});

for (const outcome of ["expired", "resolved", "failed"])
	test(`terminal wait ${outcome} uses one receipt identity across wake and reopen`, async (t) => {
		const f = await fixture(t, { provider: true, admit: null });
		const branch = f.ingress.branch();
		const wait = await declareIngressWait(branch);
		if (outcome === "expired") await branch.attachment.waits.expireDue(100);
		else
			await branch.attachment.waits.reconcile(
				"wait",
				wait.observations.map((item) => ({
					...item,
					state: outcome === "resolved" ? "satisfied" : "failed",
				})),
				20,
			);
		await branch.controller.wake();
		assert.equal(f.sent.length, 1);
		assert.ok(JSON.stringify(f.sent[0]).includes(outcome));
		const [attempt] = (await branch.attachment.ledger.snapshot()).attempts;
		assert.equal(attempt.outcome, "success");
		assert.equal(attempt.members[0].kind, "wait");
		assert.equal(attempt.admission.choice.intent.rank, 3);
		await branch.controller.wake();
		assert.equal(f.sent.length, 1);
		await f.ingress.dispose();
		const next = await fixture(t, {
			root: f.root,
			provider: true,
			admit: null,
			manager: SessionManager.open(f.session.sessionManager.getSessionFile()),
		});
		await next.ingress.branch().controller.wake();
		assert.equal(next.sent.length, 0);
		assert.equal((await next.ingress.branch().attachment.ledger.snapshot()).attempts.length, 1);
	});

test("cancelled wait does not schedule a decision request", async (t) => {
	const f = await fixture(t, { provider: true, admit: null });
	const branch = f.ingress.branch();
	await declareIngressWait(branch);
	await branch.attachment.waits.cancel("wait", "user cancelled gate", 10);
	await branch.controller.wake();
	assert.equal(f.sent.length, 0);
});

test("a preempted wait decision retries its retained identity without repeating a successful request", async (t) => {
	let userPending = false;
	const f = await fixture(t, {
		provider: true,
		admit: null,
		policy: () => ({
			userPending,
			recoveryBlocked: false,
			waitingWorkIds: [],
		}),
	});
	const branch = f.ingress.branch(),
		queued = deferred(),
		proceed = deferred();
	await declareIngressWait(branch);
	await branch.attachment.waits.expireDue(100);
	const run = branch.host.run.bind(branch.host);
	let first = true;
	t.mock.method(branch.host, "run", async () => {
		if (first) {
			first = false;
			queued.resolve();
			await proceed.promise;
		}
		await run();
	});
	const waking = branch.controller.wake();
	await queued.promise;
	userPending = true;
	proceed.resolve();
	await waking;
	assert.equal(f.sent.length, 0);
	const [cancelled] = (await branch.attachment.ledger.snapshot()).attempts;
	assert.equal(cancelled.phase, "cancelled");
	assert.equal(cancelled.consumed, false);
	userPending = false;
	await branch.controller.wake();
	assert.equal(f.sent.length, 1);
	const attempts = (await branch.attachment.ledger.snapshot()).attempts;
	assert.equal(attempts.length, 2);
	assert.deepEqual(
		attempts[0].members.map(({ id, revision }) => ({ id, revision })),
		attempts[1].members.map(({ id, revision }) => ({ id, revision })),
	);
	await branch.controller.wake();
	assert.equal(f.sent.length, 1);
});

test("automatic deadline expiry delivers once without host activity or explicit wake", async (t) => {
	const clock = ingressWaitClock(),
		errors = [];
	const f = await fixture(t, {
		provider: true,
		admit: null,
		autoRelease: { clock, onError: (error) => errors.push(error) },
	});
	const branch = f.ingress.branch();
	await declareIngressWait(branch);
	await waitForFlow(() => clock.timers.size === 1);
	clock.advance(99);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(f.sent.length, 0);
	clock.advance(100);
	await waitForFlow(async () => (await branch.attachment.ledger.snapshot()).attempts[0]?.phase === "settled");
	assert.equal(f.sent.length, 1);
	await branch.attachment.waits.expireDue(200);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(f.sent.length, 1);
	assert.equal(clock.timers.size, 0);
	assert.deepEqual(errors, []);
});

test("a continuation the flow holds runs when its wait clears without host activity", async (t) => {
	const clock = ingressWaitClock(),
		errors = [];
	const f = await fixture(t, {
		provider: true,
		admit: null,
		autoRelease: { clock, onError: (error) => errors.push(error) },
	});
	const branch = f.ingress.branch();
	await declareIngressWait(branch);
	// An extension's continuation is held while the wait is open, so it produces no turn at all: nothing
	// reaches the host, and the extension that sent it has no turn boundary to re-drive from.
	await f.session.sendCustomMessage(
		{ customType: "continuation", content: "Continue the held work.", display: false },
		{ triggerTurn: true },
	);
	assert.equal(f.sent.length, 0);
	assert.deepEqual(branch.host.gate().waitingWorkIds, ["work"]);
	await waitForFlow(() => clock.timers.size === 1);
	// The deadline is the only thing that changes: no user turn, no host call, no explicit release.
	clock.advance(100);
	// The wait's own terminal decision is delivered first; the continuation follows it without any host
	// activity, which is the re-drive the extension that sent it cannot make for itself.
	await waitForFlow(async () => JSON.stringify(f.sent).includes("Continue the held work."));
	assert.deepEqual(errors, []);
});

test("automatic reattachment delivers an offline deadline and detach clears timers", async (t) => {
	const clock = ingressWaitClock(),
		errors = [];
	const autoRelease = { clock, onError: (error) => errors.push(error) };
	const f = await fixture(t, { provider: true, admit: null, autoRelease });
	await declareIngressWait(f.ingress.branch());
	await waitForFlow(() => clock.timers.size === 1);
	const callback = [...clock.timers][0].callback;
	await f.ingress.dispose();
	assert.equal(clock.timers.size, 0);
	clock.advance(150);
	callback();
	const next = await fixture(t, {
		root: f.root,
		provider: true,
		admit: null,
		autoRelease,
		manager: SessionManager.open(f.session.sessionManager.getSessionFile()),
	});
	await waitForFlow(
		async () => (await next.ingress.branch().attachment.ledger.snapshot()).attempts[0]?.phase === "settled",
	);
	assert.equal(next.sent.length, 1);
	assert.equal(f.sent.length, 0);
	assert.deepEqual(errors, []);
});

test("committed resolution schedules a decision before its original deadline", async (t) => {
	const clock = ingressWaitClock(),
		errors = [];
	const f = await fixture(t, {
		provider: true,
		admit: null,
		autoRelease: { clock, onError: (error) => errors.push(error) },
	});
	const branch = f.ingress.branch(),
		wait = await declareIngressWait(branch);
	await waitForFlow(() => clock.timers.size === 1);
	await branch.attachment.waits.reconcile(
		"wait",
		wait.observations.map((item) => ({ ...item, state: "satisfied" })),
		20,
	);
	await waitForFlow(async () => (await branch.attachment.ledger.snapshot()).attempts[0]?.phase === "settled");
	assert.equal(f.sent.length, 1);
	assert.equal(clock.timers.size, 0);
	assert.deepEqual(errors, []);
});

for (const withUser of [false, true])
	test(`automatic expiry precedes retained automation${withUser ? " after user input" : ""}`, async (t) => {
		const clock = ingressWaitClock(),
			errors = [];
		let allow = false;
		const f = await fixture(t, {
			provider: true,
			autoRelease: { clock, onError: (error) => errors.push(error) },
			admit: async () => allow,
		});
		const branch = f.ingress.branch();
		await declareIngressWait(branch);
		await f.session.sendUserMessage("retained automation marker");
		if (withUser) await f.session.prompt("user priority marker");
		await waitForFlow(() => clock.timers.size === 1);
		assert.equal(f.sent.length, 0);
		allow = true;
		clock.advance(100);
		const expected = 2;
		await waitForFlow(() => f.sent.length === expected);
		if (withUser) {
			assert.ok(JSON.stringify(f.sent[0]).includes("user priority marker"));
			assert.ok(!JSON.stringify(f.sent[0]).includes("retained automation marker"));
		}
		const decision = JSON.stringify(f.sent[0]);
		assert.ok(decision.includes("expired"));
		assert.ok(!decision.includes("retained automation marker"));
		assert.ok(JSON.stringify(f.sent.at(-1)).includes("retained automation marker"));
		await f.ingress.dispose();
		assert.deepEqual(errors, []);
	});

test("expiry during awaited callback admission defers the callback for a fresh semantic pass", async (t) => {
	const clock = ingressWaitClock(),
		errors = [],
		entered = deferred(),
		proceed = deferred();
	let allow = false,
		first = true;
	const f = await fixture(t, {
		provider: true,
		autoRelease: { clock, onError: (error) => errors.push(error) },
		admit: async () => {
			if (allow && first) {
				first = false;
				entered.resolve();
				await proceed.promise;
			}
			return allow;
		},
	});
	await declareIngressWait(f.ingress.branch());
	await f.session.sendUserMessage("callback during expiry");
	await waitForFlow(() => clock.timers.size === 1);
	allow = true;
	f.ingress.requestRelease();
	await entered.promise;
	clock.advance(100);
	await waitForFlow(async () => (await f.ingress.branch().attachment.waits.snapshot())[0].state === "expired");
	proceed.resolve();
	await waitForFlow(() => f.sent.length === 2);
	assert.ok(JSON.stringify(f.sent[0]).includes("expired"));
	assert.ok(!JSON.stringify(f.sent[0]).includes("callback during expiry"));
	assert.ok(JSON.stringify(f.sent[1]).includes("callback during expiry"));
	await f.ingress.dispose();
	assert.deepEqual(errors, []);
});

test("terminal wait and eligible owning work share one request and survive reopen without replay", async (t) => {
	const f = await fixture(t, { provider: true, admit: null });
	const branch = f.ingress.branch(),
		wait = await declareIngressWait(branch);
	await branch.attachment.waits.reconcile(
		"wait",
		wait.observations.map((item) => ({ ...item, state: "satisfied" })),
		20,
	);
	const producer = {
		version: 1,
		namespace: "resumed-work",
		snapshot: async () => [
			{
				id: "resumed",
				revision: "1",
				producer: "resumed-work",
				sequence: 1,
				rank: 4,
				workId: "work",
				workRevision: "1",
				independent: false,
				runnable: true,
			},
		],
		build: async () => ({ id: "resumed", revision: "1", kind: "work", text: "resume owning work" }),
	};
	branch.controller.register(producer);
	await branch.controller.wake();
	assert.equal(f.sent.length, 1);
	const body = JSON.stringify(f.sent[0]);
	assert.ok(body.includes("resolved"));
	assert.ok(body.includes("resume owning work"));
	const [attempt] = (await branch.attachment.ledger.snapshot()).attempts;
	assert.deepEqual(
		attempt.members.map((member) => member.kind),
		["wait", "work"],
	);
	assert.equal(attempt.admission.choice.intent.rank, 4);
	assert.equal(attempt.admission.charged, true);
	await branch.controller.wake();
	assert.equal(f.sent.length, 1);
	await f.ingress.dispose();
	const next = await fixture(t, {
		root: f.root,
		provider: true,
		admit: null,
		manager: SessionManager.open(f.session.sessionManager.getSessionFile()),
	});
	next.ingress.branch().controller.register(producer);
	await next.ingress.branch().controller.wake();
	assert.equal(next.sent.length, 0);
});

test("multiple terminal waits and eligible work share one request with separate required receipts", async (t) => {
	const f = await fixture(t, { provider: true, admit: null }),
		branch = f.ingress.branch();
	for (let i = 0; i < 3; i++) {
		const handle = { producer: "bg", handle: `job-${i}`, execution: `exec-${i}`, until: "exit" };
		await branch.attachment.waits.declare(
			{
				token: `wait-${i}`,
				scope: branch.scope,
				workId: `work-${i}`,
				reason: `dependency-${i}`,
				mode: "all",
				on: [handle],
				expiresAt: 100,
			},
			[{ ...handle, scope: branch.scope, workId: `work-${i}`, state: "pending" }],
			0,
			100,
		);
	}
	await branch.attachment.waits.expireDue(100);
	branch.controller.register({
		version: 1,
		namespace: "batch-work",
		snapshot: async () => [
			{
				id: "batch-work",
				producer: "batch-work",
				revision: "1",
				sequence: 1,
				rank: 4,
				workId: "work-0",
				workRevision: "1",
				independent: false,
				runnable: true,
			},
		],
		build: async () => ({ id: "batch-work", revision: "1", kind: "work", text: "decide next measurement" }),
	});
	await branch.controller.wake();
	assert.equal(f.sent.length, 1);
	const [attempt] = (await branch.attachment.ledger.snapshot()).attempts;
	assert.equal(attempt.members.filter((member) => member.kind === "wait").length, 3);
	assert.equal(attempt.members.filter((member) => member.kind === "work").length, 1);
	assert.ok(attempt.members.every((member) => member.required));
	for (let i = 0; i < 3; i++) assert.ok(JSON.stringify(f.sent[0]).includes(`dependency-${i}`));
	await f.ingress.dispose();
	const next = await fixture(t, {
		root: f.root,
		provider: true,
		admit: null,
		manager: SessionManager.open(f.session.sessionManager.getSessionFile()),
	});
	await next.ingress.branch().controller.wake();
	assert.equal(next.sent.length, 0);
});

for (const intact of [true, false])
	test(`native context ${intact ? "acknowledges exact" : "does not acknowledge altered"} terminal decision text`, async (t) => {
		const f = await fixture(t, { provider: true, admit: null }),
			branch = f.ingress.branch();
		await declareIngressWait(branch);
		await branch.attachment.waits.expireDue(100);
		const source = createFlowWaitDecisionProducer(branch.attachment.waits),
			signal = new AbortController().signal;
		const [intent] = await source.snapshot(signal),
			item = await source.build(intent, signal);
		if (!intact) item.text = item.text.replace("expired", "resolved");
		await f.session.sendCustomMessage(
			{ customType: "jouzu-wait-context", display: false, content: JSON.stringify({ waitDecisions: [item] }) },
			{ triggerTurn: false },
		);
		assert.equal(f.sent.length, 0);
		await f.session.sendUserMessage("native request next step");
		assert.equal(f.sent.length, 1);
		await branch.controller.wake();
		assert.equal(f.sent.length, intact ? 1 : 2);
		if (intact) {
			assert.deepEqual((await branch.attachment.ledger.snapshot()).attempts, []);
			await f.ingress.dispose();
			const next = await fixture(t, {
				root: f.root,
				provider: true,
				admit: null,
				manager: SessionManager.open(f.session.sessionManager.getSessionFile()),
			});
			await next.ingress.branch().controller.wake();
			assert.equal(next.sent.length, 0);
		}
	});

test("idle user prompt automatically includes terminal decisions without changing user text", async (t) => {
	const admitted = [];
	const f = await fixture(t, {
		provider: true,
		admit: async (submission) => {
			admitted.push(submission.api);
			return submission.api === "prompt";
		},
	});
	const branch = f.ingress.branch();
	await declareIngressWait(branch);
	await branch.attachment.waits.expireDue(100);
	const text = "次の手順を確認して。\nPreserve this user input exactly.";
	await f.session.prompt(text);
	assert.equal(f.sent.length, 1);
	const records = await branch.attachment.submissions.snapshot();
	const user = records.find((record) => record.submission.api === "prompt");
	assert.equal(user.submission.args[0], text);
	assert.ok(JSON.stringify(f.sent[0]).includes("expired"));
	assert.ok(
		records.some((record) => record.submission.api === "sendCustomMessage" && record.dispatch?.phase === "returned"),
	);
	assert.ok(admitted.every((api) => api === "prompt"));
	await branch.controller.wake();
	assert.equal(f.sent.length, 1);
	await f.ingress.dispose();
	const next = await fixture(t, {
		root: f.root,
		provider: true,
		admit: null,
		manager: SessionManager.open(f.session.sessionManager.getSessionFile()),
	});
	await next.ingress.branch().controller.wake();
	assert.equal(next.sent.length, 0);
});

test("an external wait-context label does not bypass host admission", async (t) => {
	const f = await fixture(t, { provider: true, admit: async () => false });
	await f.session.sendCustomMessage(
		{
			customType: "jouzu-wait-context",
			content: "external",
			display: false,
			details: { waitContextId: "external-id" },
		},
		{ triggerTurn: false },
	);
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	assert.equal(record.dispatch, undefined);
	assert.equal(f.sent.length, 0);
});

test("status prompts retain live wait identity and deadline and cancellation clears the next snapshot", async (t) => {
	const clock = ingressWaitClock(),
		errors = [];
	const f = await fixture(t, {
		provider: true,
		admit: null,
		autoRelease: { clock, onError: (error) => errors.push(error) },
	});
	const branch = f.ingress.branch();
	await declareIngressWait(branch);
	const contexts = () =>
		f.session.agent.state.messages.filter(
			(message) => message.role === "custom" && message.customType === "jouzu-wait-context",
		);
	clock.advance(20);
	await f.session.prompt("status one");
	let snapshot = JSON.parse(contexts().at(-1).content);
	assert.equal(snapshot.liveWaits[0].token, "wait");
	assert.equal(snapshot.liveWaits[0].expiresAt, 100);
	assert.equal(snapshot.liveWaits[0].elapsedMs, 20);
	assert.equal(snapshot.liveWaits[0].health, "deadline-only");
	assert.equal(snapshot.liveWaits[0].unmet[0].execution, "exec");
	clock.advance(40);
	await f.session.prompt("status two");
	snapshot = JSON.parse(contexts().at(-1).content);
	assert.equal(snapshot.liveWaits[0].elapsedMs, 40);
	assert.equal(snapshot.liveWaits[0].expiresAt, 100);
	assert.equal((await branch.attachment.waits.snapshot()).length, 1);
	assert.equal((await branch.attachment.waits.snapshot())[0].state, "waiting");
	clock.advance(60);
	await branch.attachment.waits.cancel("wait", "user redirected work", 60);
	await f.session.prompt("status after cancellation");
	snapshot = JSON.parse(contexts().at(-1).content);
	assert.deepEqual(snapshot.liveWaits, []);
	assert.equal(snapshot.remainingLiveWaits, 0);
	assert.equal(snapshot.capturedAt, 60);
	const count = contexts().length;
	await f.session.prompt("another question");
	assert.equal(contexts().length, count);
	assert.equal(f.sent.length, 4);
	await f.ingress.dispose();
	assert.deepEqual(errors, []);
});

test("oversized live wait context reports remaining count without truncating the reason", async (t) => {
	const f = await fixture(t, { provider: true, admit: null }),
		branch = f.ingress.branch();
	const wait = await declareIngressWait(branch);
	await branch.attachment.waits.declare(
		{ ...wait, token: "replacement", reason: "長".repeat(4000) },
		wait.observations,
		10,
		100,
		"wait",
	);
	await f.session.prompt("status with large dependency");
	const message = f.session.agent.state.messages.findLast(
		(item) => item.role === "custom" && item.customType === "jouzu-wait-context",
	);
	const snapshot = JSON.parse(message.content);
	assert.deepEqual(snapshot.liveWaits, []);
	assert.equal(snapshot.remainingLiveWaits, 1);
	assert.ok(Buffer.byteLength(message.content) <= 4096);
	assert.equal((await branch.attachment.waits.snapshot())[1].reason, "長".repeat(4000));
	assert.equal(f.sent.length, 1);
});

for (const lane of ["steer", "followUp"]) {
	test(`queued ${lane} user input receives live wait state at consumption without a context append`, async (t) => {
		const clock = ingressWaitClock(),
			errors = [];
		const f = await fixture(t, {
			provider: true,
			autoRelease: { clock, onError: (error) => errors.push(error) },
			admit: async (_submission, _branch, phase) => {
				if (phase === "queue") clock.advance(40);
				return true;
			},
		});
		await f.session.prompt("start queue consumption");
		const branch = f.ingress.branch();
		clock.advance(10);
		await f.session[lane]("queued status 日本語\nkeep original bytes");
		await declareIngressWait(branch);
		await f.session.agent.continue();
		const payload = f.sent.find((messages) => JSON.stringify(messages).includes("queued status"));
		assert.ok(payload);
		const text = JSON.stringify(payload);
		assert.ok(text.includes('\\"capturedAt\\":40'));
		assert.ok(text.includes('\\"elapsedMs\\":40'));
		assert.ok(text.includes('\\"expiresAt\\":100'));
		assert.ok(text.includes('\\"token\\":\\"wait\\"'));
		assert.equal(
			f.session.agent.state.messages.filter((message) => message.customType === "jouzu-wait-context").length,
			0,
		);
		assert.equal((await branch.attachment.waits.snapshot())[0].expiresAt, 100);
		const records = await branch.attachment.submissions.snapshot();
		const queued = records.find((record) => record.submission.api === lane);
		assert.equal(queued.submission.args[0], "queued status 日本語\nkeep original bytes");
		const requests = await branch.attachment.nativeRequests.snapshot();
		assert.ok(
			requests.some(
				(request) =>
					request.outcome === "success" &&
					request.sourceCapture?.members.some(
						(member) =>
							member.operationId === queued.dispatch.operationId &&
							member.queue &&
							request.sourceCapture?.model?.members.some(
								(item) => item.sourceIndex === member.index && ["intact", "converted"].includes(item.status),
							),
					),
			),
		);
		await f.ingress.dispose();
		assert.deepEqual(errors, []);
	});
}

test("queued user context clears a wait cancelled during queue admission", async (t) => {
	const f = await fixture(t, {
		provider: true,
		admit: async (_submission, branch, phase) => {
			if (phase === "queue") await branch.attachment.waits.cancel("wait", "redirected", 20);
			return true;
		},
	});
	await f.session.prompt("start queue consumption");
	await declareIngressWait(f.ingress.branch());
	await f.session.followUp("cancelled wait status");
	await f.session.agent.continue();
	const payload = f.sent.find((messages) => JSON.stringify(messages).includes("cancelled wait status"));
	assert.ok(payload);
	const text = JSON.stringify(payload);
	assert.ok(text.includes('\\"liveWaits\\":[]'));
	assert.ok(text.includes('\\"remainingLiveWaits\\":0'));
	assert.equal(f.sent.length, 2);
	await f.ingress.dispose();
});

for (const streamingBehavior of ["steer", "followUp"]) {
	test(`a user prompt enters the ${streamingBehavior} queue during an owned native request`, async (t) => {
		const clock = ingressWaitClock(),
			errors = [];
		const f = await fixture(t, {
			provider: true,
			admit: null,
			autoRelease: { clock, onError: (error) => errors.push(error) },
		});
		const started = deferred(),
			proceed = deferred();
		const stream = f.session.agent.streamFunction;
		let calls = 0;
		f.session.agent.streamFunction = async (...args) => {
			if (++calls === 1) {
				started.resolve();
				await proceed.promise;
			}
			return stream(...args);
		};
		const running = f.session.prompt("initial request");
		await started.promise;
		try {
			await declareIngressWait(f.ingress.branch());
			await waitForFlow(() => clock.timers.size === 1 && !f.ingress.branch().attachment.waits.gate().updating);
			clock.advance(10);
			await f.session.prompt("streaming queued status 日本語\nunchanged", { streamingBehavior });
			assert.equal(f.session.agent.inspectQueuedMessages().length, 1);
			assert.equal(f.sent.length, 0);
			assert.equal(f.ingress.branch().attachment.nativeRequests.recoveryBlocked, true);
			assert.equal(f.ingress.branch().requests.queueingBlocked, false);
			await f.session.sendUserMessage("automated input", { deliverAs: "followUp" });
			await f.session.prompt("user prompt without a queue lane");
			assert.equal(f.session.agent.inspectQueuedMessages().length, 1);
			const records = await f.ingress.branch().attachment.submissions.snapshot();
			for (const text of ["automated input", "user prompt without a queue lane"]) {
				const held = records.find((record) => record.submission.args[0] === text);
				assert.equal(held.dispatch, undefined);
				await f.ingress.cancelRetained(held.id, held.revision);
			}
			clock.advance(40);
		} finally {
			proceed.resolve();
		}
		await running;
		assert.equal(f.sent.length, 2);
		const text = JSON.stringify(f.sent[1]);
		assert.ok(text.includes("streaming queued status"));
		assert.ok(text.includes('\\"capturedAt\\":40'));
		assert.ok(text.includes('\\"expiresAt\\":100'));
		assert.equal(
			f.session.agent.state.messages.filter((message) => message.customType === "jouzu-wait-context").length,
			0,
		);
		await f.ingress.dispose();
		assert.deepEqual(errors, []);
	});
}

for (const lane of ["steer", "followUp"]) {
	test(`terminal wait decisions join a consumed ${lane} user turn and stay acknowledged after reopen`, async (t) => {
		const f = await fixture(t, { provider: true, admit: null });
		await f.session.prompt("initial request");
		const branch = f.ingress.branch();
		await f.session[lane]("queued terminal status");
		const wait = await declareIngressWait(branch);
		await branch.attachment.waits.declare(
			{ ...wait, token: "other-wait", workId: "other-work" },
			wait.observations.map((observation) => ({ ...observation, workId: "other-work" })),
			0,
			100,
		);
		await branch.attachment.waits.expireDue(100);
		await f.session.agent.continue();
		assert.equal(f.sent.length, 2);
		const [request] = (await branch.attachment.nativeRequests.snapshot()).filter(
			(request) => request.projectionCapture,
		);
		assert.ok(request, f.session.agent.state.errorMessage);
		assert.equal(request.outcome, "success");
		assert.equal(request.projectionCapture.members.length, 1);
		assert.equal(request.projectionCapture.model.members[0].status, "converted");
		const snapshot = JSON.parse(request.projectionCapture.members[0].message.content);
		assert.equal(snapshot.waitDecisions.length, 2);
		assert.ok(snapshot.waitDecisions.every((item) => JSON.parse(item.text).wait.state === "expired"));
		const forged = structuredClone(request);
		forged.id = "forged-projection";
		forged.projectionCapture.members[0].message.content = "different context";
		forged.projectionCapture.members[0].messageHash = createHash("sha256")
			.update(JSON.stringify(forged.projectionCapture.members[0].message))
			.digest("hex");
		await assert.rejects(branch.attachment.nativeRequests.begin(forged), { code: "identity" });
		assert.ok(JSON.stringify(f.sent[1]).includes("waitDecisions"));
		assert.equal(
			f.session.agent.state.messages.filter((message) => message.customType === "jouzu-wait-context").length,
			0,
		);
		const decisions = createFlowWaitDecisionProducer(branch.attachment.waits, {
			submissions: branch.attachment.submissions,
			requests: branch.attachment.nativeRequests,
		});
		assert.deepEqual(await decisions.snapshot(new AbortController().signal), []);
		await f.ingress.dispose();
		const next = await fixture(t, {
			root: f.root,
			provider: true,
			admit: null,
			manager: SessionManager.open(f.session.sessionManager.getSessionFile()),
		});
		const restored = next.ingress.branch().attachment;
		assert.deepEqual(
			await createFlowWaitDecisionProducer(restored.waits, {
				submissions: restored.submissions,
				requests: restored.nativeRequests,
			}).snapshot(new AbortController().signal),
			[],
		);
		assert.equal(next.sent.length, 0);
	});
}

test("a wait context edited after conversion is transmitted and acknowledged", async (t) => {
	// The controller verifies what it passed to the provider adapter. An edit to the body after that
	// checkpoint is inside the trust boundary: the decision is delivered as far as the controller can
	// establish, so it is acknowledged and no hold is created.
	const f = await fixture(t, { provider: true, admit: null });
	await f.session.prompt("initial request");
	const branch = f.ingress.branch();
	await f.session.followUp("queued status with a payload change");
	await declareIngressWait(branch);
	await branch.attachment.waits.expireDue(100);
	const stream = f.session.agent.streamFunction;
	f.session.agent.streamFunction = (model, context, options) =>
		stream(model, context, {
			...options,
			onPayload: async (payload, model) => {
				const index = payload.messages.findIndex((message) => JSON.stringify(message).includes("waitDecisions"));
				assert.ok(index >= 0);
				payload.messages.splice(index, 1);
				return (await options.onPayload?.(payload, model)) ?? payload;
			},
		});
	await f.session.agent.continue();
	const [request] = (await branch.attachment.nativeRequests.snapshot()).filter((item) => item.projectionCapture);
	assert.ok(request, f.session.agent.state.errorMessage);
	assert.equal(request.outcome, "success");
	assert.equal(request.projectionCapture.model.members[0].status, "converted");
	assert.equal(branch.attachment.nativeRequests.recoveryBlocked, false);
	const decisions = createFlowWaitDecisionProducer(branch.attachment.waits, {
		ledger: branch.attachment.ledger,
		submissions: branch.attachment.submissions,
		requests: branch.attachment.nativeRequests,
	});
	assert.deepEqual(await decisions.snapshot(new AbortController().signal), []);
});

test("a required projection unresolved at conversion holds the request until it is cancelled", async (t) => {
	const f = await fixture(t, { provider: true, admit: null });
	await f.session.prompt("initial request");
	const branch = f.ingress.branch();
	await f.session.followUp("queued status");
	await declareIngressWait(branch);
	await branch.attachment.waits.expireDue(100);
	await f.session.agent.continue();
	const [delivered] = (await branch.attachment.nativeRequests.snapshot()).filter((item) => item.projectionCapture);
	assert.ok(delivered, f.session.agent.state.errorMessage);

	// A second request whose required projection conversion left `changed` cannot hand off, and its
	// repair path is the projection cancellation the user reaches through /flow.
	const input = structuredClone(delivered);
	input.id = "projection-hold";
	input.sourceCapture.members = [];
	input.sourceCapture.context.members = [];
	input.sourceCapture.model.members = [];
	input.projectionCapture.model.members[0] = {
		...input.projectionCapture.model.members[0],
		status: "changed",
	};
	delete input.payload;
	delete input.outcome;
	await branch.attachment.nativeRequests.begin(input);
	const payload = {
		hash: "b".repeat(64),
		bytes: 512,
		api: "openai-completions",
		provider: "fixture",
		model: "fixture",
	};
	assert.equal(await branch.attachment.nativeRequests.handoff(input.id, payload), false);
	assert.equal(branch.attachment.nativeRequests.recoveryBlocked, true);
	const [held] = (await branch.attachment.nativeRequests.snapshot()).filter((item) => item.id === input.id);
	assert.equal(held.outcome, "withheld");
	assert.deepEqual(held.requiredProjections, [input.projectionCapture.members[0].index]);
	await assert.rejects(f.ingress.cancelNativeProjections(input.id, payload.hash, [999]), { code: "identity" });
	await f.ingress.cancelNativeProjections(input.id, payload.hash, [input.projectionCapture.members[0].index]);
	assert.equal(branch.attachment.nativeRequests.recoveryBlocked, false);
});

test("legacy optional projection receipts remain readable after reopen", async (t) => {
	const f = await fixture(t, { provider: true, admit: null });
	await f.session.prompt("seed");
	const branch = f.ingress.branch();
	await f.session.followUp("queued status");
	await declareIngressWait(branch);
	await branch.attachment.waits.expireDue(100);
	await f.session.agent.continue();
	const legacy = (await branch.attachment.nativeRequests.snapshot()).find((request) => request.projectionCapture);
	delete legacy.requiredProjections;
	// Write the prior optional-projection schema through Pi storage to exercise reopen validation.
	await branch.attachment.nativeRequests.session.mutate(async (mutation, context) => {
		await mutation.commit([setValue(value("jouzu.flow.native-request", legacy.id), legacy)], context);
	}, BACKGROUND_CONTEXT);
	await f.ingress.dispose();
	const next = await fixture(t, {
		root: f.root,
		provider: true,
		admit: null,
		manager: SessionManager.open(f.session.sessionManager.getSessionFile()),
	});
	const restored = next.ingress.branch().attachment;
	assert.equal(restored.nativeRequests.recoveryBlocked, false);
	const decisions = createFlowWaitDecisionProducer(restored.waits, {
		submissions: restored.submissions,
		requests: restored.nativeRequests,
	});
	// The legacy record still carries its model-conversion status, which is what decides delivery, so
	// the decision it delivered is acknowledged. Only the wire receipt was downgraded here, and the
	// contract no longer reads it.
	assert.equal((await decisions.snapshot(new AbortController().signal)).length, 0);
});

for (const action of ["retry", "retry-with-new-user", "cancel"]) {
	test(`automatic scheduling after native repair preserves user priority: ${action}`, async (t) => {
		const clock = ingressWaitClock(),
			errors = [];
		// The hold is created before model conversion, which is the checkpoint that decides required
		// content. A later edit to the provider body would be inside the trust boundary and invisible.
		let reject = true;
		const f = await fixture(t, {
			provider: true,
			admit: null,
			autoRelease: { clock, onError: (error) => errors.push(error) },
			extensions: [
				(pi) =>
					pi.on("context", ({ messages }) => ({
						messages: reject
							? messages.filter((message) => !JSON.stringify(message).includes("held user status"))
							: messages,
					})),
			],
		});
		await f.session.prompt("seed");
		const branch = f.ingress.branch();
		await f.session.followUp("held user status 日本語");
		await declareIngressWait(branch);
		await branch.attachment.waits.expireDue(100);
		await f.session.agent.continue();
		const prior = await branch.attachment.nativeRequests.snapshot();
		const held = prior.find((request) => request.outcome === "withheld");
		assert.ok(held, f.session.agent.state.errorMessage);
		assert.equal(f.sent.length, 1);
		reject = false;
		if (action === "retry-with-new-user") {
			await f.session.prompt("newer user instruction");
			assert.equal(f.sent.length, 1);
		}
		if (action === "cancel")
			await f.ingress.cancelNativeSources(held.id, held.withheldPayload.hash, held.requiredSources);
		else await f.ingress.retryNativeRequest(held.id, held.withheldPayload.hash);
		await waitForFlow(async () =>
			(await branch.attachment.nativeRequests.snapshot()).some(
				(request) =>
					!prior.some((previous) => previous.id === request.id) &&
					request.outcome === "success" &&
					(action === "cancel" || request.retryOf === held.id),
			),
		);
		assert.equal(f.sent.length, 2);
		assert.equal(JSON.stringify(f.sent[1]).includes("held user status 日本語"), action !== "cancel");
		if (action === "retry-with-new-user") assert.ok(JSON.stringify(f.sent[1]).includes("newer user instruction"));
		assert.ok(JSON.stringify(f.sent[1]).includes("expired"));
		const requests = await branch.attachment.nativeRequests.snapshot();
		const retry = action === "cancel" ? requests.at(-1) : requests.find((request) => request.retryOf === held.id);
		if (action !== "cancel") assert.ok(retry.requiredSources.length > 0);
		// The repaired request delivered every required source, which conversion is what records.
		assert.ok(
			retry.requiredSources.every((index) =>
				retry.sourceCapture.model.members.some(
					(member) => member.sourceIndex === index && ["intact", "converted"].includes(member.status),
				),
			),
		);
		await f.ingress.wakeProducers();
		assert.equal(f.sent.length, 2);
		await f.ingress.dispose();
		assert.deepEqual(errors, []);
	});
}
