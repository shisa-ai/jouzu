import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { createFlowStatusExtension } from "../dist/flow-control/flow-status-extension.js";
import { awaitingNativeInput } from "../dist/flow-control/native-admission.js";
import { finishedUserWork } from "../dist/flow-control/user-work-retention.js";
import { capturedNotices } from "./fixtures/flow-assembly.mjs";
import { fixture } from "./fixtures/flow-session-ingress.mjs";

test("idle producer retirement reuses execution capacity beyond 1024 records", { timeout: 60000 }, async (t) => {
	const f = await fixture(t);
	const { waits, waitProducers } = f.ingress.branch().attachment;
	let listeners = 0,
		first;
	const registration = waitProducers.register(
		{
			version: 1,
			namespace: "bg",
			subscribe() {
				listeners++;
				return () => {
					listeners--;
				};
			},
			async snapshot(identity) {
				return { ...identity, revision: 1, predicates: [{ until: "exit", state: "satisfied" }] };
			},
			canRetireExecution: () => true,
		},
		(error) => {
			throw error;
		},
	);
	let sequence = 0;
	for (const count of [1024, 6]) {
		const work = await waits.registerWork(`batch-${sequence}`, "bg", 0);
		for (let i = 0; i < count; i++) {
			await registration.bind({ workId: work.id, handle: `job-${sequence}`, execution: `execution-${sequence}` }, 1);
			sequence++;
		}
		const records = (await waits.authoritySnapshot()).executions;
		first ??= records[0];
		assert.equal(records.length, count);
		assert.equal(listeners, count);
		if (count === 1024)
			await assert.rejects(registration.bind({ workId: work.id, handle: "overflow", execution: "overflow" }, 1), {
				code: "capacity",
			});
		assert.equal((await f.ingress.retireWaitHistory()).executions, 0);
		assert.equal(listeners, 0);
		await waits.changeWork(work.id, "bg", 1, "completed", "Finished", 1);
		assert.deepEqual(await f.ingress.retireWaitHistory(), { work: 1, executions: count, waits: 0 });
		assert.equal((await waits.authoritySnapshot()).executions.length, 0);
	}
	assert.equal(sequence, 1030);
	assert.equal(f.sent.length, 0);
	await assert.rejects(waits.registerExecution(first, 1, 2), { code: "stale" });
});

test("idle execution retirement preserves unresolved wait decisions and unread sibling output", async (t) => {
	const f = await fixture(t, { provider: true }),
		attachment = f.ingress.branch().attachment;
	const { waits, waitProducers } = attachment;
	const observed = new Set(["first"]);
	const registration = waitProducers.register(
		{
			version: 1,
			namespace: "bg",
			subscribe: () => () => {},
			async snapshot(identity) {
				return { ...identity, revision: 1, predicates: [{ until: "exit", state: "satisfied" }] };
			},
			canRetireExecution: (identity) => observed.has(identity.execution),
		},
		(error) => {
			throw error;
		},
	);
	await waits.registerWork("work", "bg", 0);
	for (const execution of ["first", "second"])
		await registration.bind({ workId: "work", handle: execution, execution }, 1);
	await waits.declareOwned(
		"bg",
		1,
		{
			scope: f.ingress.branch().scope,
			workId: "work",
			token: "decision",
			reason: "exit",
			mode: "all",
			on: [{ producer: "bg", handle: "first", execution: "first", until: "exit" }],
			expiresAt: Date.now() + 10000,
		},
		Date.now(),
		10000,
	);
	await waits.changeWork("work", "bg", 1, "completed", "Finished", Date.now());
	assert.equal((await f.ingress.retireWaitHistory()).executions, 0);
	// A successful status turn observes the decision; unread sibling output still owns the work.
	await f.session.prompt("Report the completed wait");
	assert.equal((await f.ingress.retireWaitHistory()).executions, 0);
	observed.add("second");
	assert.deepEqual(await f.ingress.retireWaitHistory(), { work: 1, executions: 2, waits: 0 });
});

test("archived user submissions retain native source evidence through later prompts and reopen", async (t) => {
	const f = await fixture(t, { provider: true });
	await f.session.prompt("first archived input");
	const store = f.ingress.branch().attachment.submissions;
	const before = await store.snapshot();
	assert.equal(await f.ingress.archiveSubmissionHistory(), 0);
	await f.ingress.retireWaitHistory(true);
	assert.equal(await f.ingress.archiveSubmissionHistory(), 1);
	assert.deepEqual(await store.snapshot(), before);
	assert.deepEqual(await store.snapshot(false), []);
	await f.ingress.retireRequestHistory();
	await f.session.prompt("second distinct input");
	assert.equal(f.sent.length, 2);
	await f.ingress.dispose();
	const next = await fixture(t, {
		root: f.root,
		provider: true,
		manager: SessionManager.open(f.session.sessionManager.getSessionFile()),
	});
	await next.session.prompt("third distinct input");
	assert.equal(next.sent.length, 1);
	assert.equal((await next.ingress.branch().attachment.submissionViews()).length, 3);
	assert.equal((await next.ingress.branch().attachment.nativeRequests.snapshot()).at(-1).outcome, "success");
});

test("a queued user message survives an abort and still holds automated input", async (t) => {
	// An abort ends the turn but leaves the queued message in the host's queue, so it is genuinely
	// pending for the next turn rather than discarded. Admission must keep holding automated input
	// behind it: treating "the turn ended" as "the message is gone" would deliver automated work
	// ahead of something the user typed and is still waiting on.
	const f = await fixture(t, { provider: true, admit: null });
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
	await f.session.prompt("the user interrupts", { streamingBehavior: "steer" });
	const aborting = f.session.abort();
	proceed.resolve();
	await aborting.catch(() => {});
	await running.catch(() => {});

	assert.equal(f.session.isIdle, true, "the host is idle, so only the queue says what is pending");
	assert.equal(f.session.agent.inspectQueuedMessages().length, 1, "the user's message is still queued");
	const record = (await f.ingress.branch().attachment.submissions.snapshot()).find(
		(item) => item.submission.args[0] === "the user interrupts",
	);
	assert.ok(record.dispatch, "dispatched into the queue");
	assert.ok(!record.dispatch.queueClaims?.length, "and not claimed, because the aborted turn never took it");
	// The queue is the evidence, and it still holds the entry, so this is pending work and not a discard.
	assert.equal(
		awaitingNativeInput(record, new Set(f.session.agent.inspectQueuedMessages().map((item) => item.id))),
		true,
	);
});

test("an interrupted turn pauses automated work until the next user turn is under way", async (t) => {
	// The host reserves its interrupt key, so the interrupt is not observable directly; a turn
	// ending aborted is the evidence for it. Pressing it means stop, so nothing automated starts
	// behind it, and the user's next turn releases the hold once it is actually running.
	const f = await fixture(t, { provider: true, admit: null });
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
	const running = f.session.prompt("a turn the user will interrupt");
	await started.promise;
	assert.equal(f.ingress.automatedPause(), undefined, "nothing is paused before the interrupt");

	const aborting = f.session.abort();
	proceed.resolve();
	await aborting.catch(() => {});
	await running.catch(() => {});
	assert.ok(f.ingress.automatedPause(), "the aborted turn paused automated work");

	// Automated input is held while paused, and the user's own input is not.
	await f.session.sendUserMessage("Continue by working on the next task", { deliverAs: "followUp" });
	const automated = (await f.ingress.branch().attachment.submissions.snapshot()).find(
		(record) => record.submission.args[0] === "Continue by working on the next task",
	);
	assert.equal(automated.dispatch, undefined, "the follow-up is held rather than sent into the gap");

	await f.session.prompt("the user's next instruction");
	// The user's turn ran, which releases the hold; the follow-up may go from the next boundary.
	assert.equal(f.ingress.automatedPause(), undefined, "the next user turn resumed automated work");
	// Releasing the pause does not itself dispatch: the follow-up still waits for an idle boundary,
	// which is what keeps it out of the turn the user just submitted. That the pause never holds the
	// user's own input is pinned directly in flow-native-admission.test.mjs.
});

test("a session pause holds automated work until it is resumed explicitly", async (t) => {
	const f = await fixture(t, { provider: true, admit: null });
	await f.session.prompt("first");
	assert.equal(f.ingress.pauseAutomated("held from /flow"), true);
	assert.equal(f.ingress.pauseAutomated("held again"), false, "pausing twice keeps the first reason");
	assert.equal(f.ingress.automatedPause(), "held from /flow");

	await f.session.sendUserMessage("Continue by working on the next task", { deliverAs: "followUp" });
	const held = (await f.ingress.branch().attachment.submissions.snapshot()).find(
		(record) => record.submission.args[0] === "Continue by working on the next task",
	);
	assert.equal(held.dispatch, undefined);

	assert.equal(f.ingress.resumeAutomated(), true);
	assert.equal(f.ingress.resumeAutomated(), false, "resuming twice is a no-op");
	await f.ingress.releaseReady();
	const released = (await f.ingress.branch().attachment.submissions.snapshot()).find(
		(record) => record.submission.args[0] === "Continue by working on the next task",
	);
	assert.ok(released.dispatch);
});

for (const phase of ["selected", "prepared", "handed-off", "partial"])
	test(`/flow clear releases ${phase} work and permits the next user turn`, async (t) => {
		let ingress;
		const status = createFlowStatusExtension({ ingress: () => ingress });
		const f = await fixture(t, { provider: true, extensions: [status.factory] });
		ingress = f.ingress;
		const ledger = ingress.branch().attachment.ledger;
		const member = { id: "work", revision: "1", kind: "work", required: true, contentHash: "a".repeat(64) };
		await ledger.select("stuck", [member]);
		if (phase !== "selected") {
			const queue = { id: "queue", revision: 1 };
			await ledger.queued("stuck", queue);
			await ledger.claim("stuck", queue);
			const inclusion = [
				{ id: member.id, revision: member.revision, disposition: "included", contentHash: member.contentHash },
			];
			await ledger.prepare("stuck", "request", inclusion, false);
			if (phase !== "prepared") await ledger.handoff("stuck", "request");
			if (phase === "partial") {
				await ledger.requestOutcome("stuck", "request", "success");
				await ledger.prepare("stuck", "request2", inclusion, false);
			}
		}
		const before = await ledger.snapshot();
		const notices = capturedNotices(f.session);
		ingress.pauseAutomated("interrupted");
		await f.session.prompt("/flow clear");
		const after = await ledger.snapshot();
		assert.equal(after.activeAttemptId, undefined);
		assert.equal(
			after.attempts[0].phase,
			phase === "handed-off" ? "uncertain" : phase === "partial" ? "settled" : "cancelled",
		);
		assert.deepEqual(after.attempts[0].requests, before.attempts[0].requests);
		assert.equal(ingress.automatedPause(), undefined);
		// A reset that leaves the provider outcome unknown preserves the decision the user still owes,
		// and the controller gate holds automated work until they make it.
		assert.match(
			notices[0].text,
			phase === "handed-off"
				? /preserved pending evidence that still needs reconciliation/
				: /Cleared flow reservation stuck/,
		);
		assert.equal(f.sent.length, 0);
		if (phase === "handed-off") {
			await f.session.prompt("/flow resolve stuck discard");
			assert.equal(ingress.branch().host.gate().recoveryBlocked, false);
		}
		await f.session.prompt("hello after reset");
		assert.equal(f.sent.length, 1);
	});

test("clear management refuses a running turn and /flow clear succeeds at idle", async (t) => {
	let ingress;
	const entered = deferred(),
		release = deferred();
	const status = createFlowStatusExtension({ ingress: () => ingress });
	const f = await fixture(t, {
		provider: true,
		extensions: [status.factory],
		onRequest: async () => {
			entered.resolve();
			await release.promise;
		},
	});
	ingress = f.ingress;
	const ledger = ingress.branch().attachment.ledger;
	await ledger.select("stuck", [
		{ id: "work", revision: "1", kind: "work", required: true, contentHash: "a".repeat(64) },
	]);
	const running = f.session.prompt("start");
	await entered.promise;
	ingress.pauseAutomated("manual pause");
	const before = await ledger.snapshot();
	const notices = capturedNotices(f.session);
	try {
		await assert.rejects(ingress.resetFlow(), { code: "busy" });
		assert.equal(ingress.automatedPause(), "manual pause");
		assert.deepEqual(await ledger.snapshot(), before);
	} finally {
		release.resolve();
		await running;
	}
	await f.session.prompt("/flow clear");
	assert.equal((await ledger.snapshot()).activeAttemptId, undefined);
	assert.match(notices[0].text, /Cleared flow reservation stuck/);
});

test("completed command user work retires without waiting for a provider receipt", async (t) => {
	const f = await fixture(t, {
		extensions: [
			(pi) =>
				pi.registerCommand("local", {
					description: "Handle a local command",
					handler: async () => {},
				}),
		],
	});
	await f.session.prompt("/local");
	const branch = f.ingress.branch();
	const records = await branch.attachment.submissions.snapshot();
	const work = (await branch.attachment.waits.authoritySnapshot()).work;
	assert.equal(records[0].dispatch.noInput, true);
	assert.equal(finishedUserWork(work, records, [], new Set()).length, 1);
	assert.deepEqual(finishedUserWork(work, records, [], new Set(work.map((item) => item.id))), []);
	await f.ingress.retireWaitHistory(true);
	assert.equal(await f.ingress.archiveSubmissionHistory(), 1);
	assert.deepEqual(await branch.attachment.submissions.snapshot(false), []);
});
