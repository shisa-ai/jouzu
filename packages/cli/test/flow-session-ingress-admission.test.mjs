import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { retainUserWork } from "../dist/flow-control/user-work.js";
import { finishedUserWork } from "../dist/flow-control/user-work-retention.js";
import { fixture, waitForFlow } from "./fixtures/flow-session-ingress.mjs";

test("idle request retention preserves native input receipts and subsequent admission", async (t) => {
	const f = await fixture(t, { provider: true });
	await f.session.prompt("first");
	await f.session.prompt("second");
	const store = f.ingress.branch().attachment.nativeRequests;
	const [first, second] = await store.snapshot();
	const ledger = f.ingress.branch().attachment.ledger;
	await ledger.select("pending", [
		{ id: "work", revision: "1", kind: "work", required: true, contentHash: "a".repeat(64) },
	]);
	await assert.rejects(f.ingress.retireRequestHistory(), { code: "busy" });
	assert.deepEqual(
		(await store.snapshot()).map((record) => record.id),
		[first.id, second.id],
	);
	await ledger.cancel("pending", "Cancelled before dispatch");
	assert.equal(await f.ingress.retireRequestHistory(), 1);
	assert.deepEqual(
		(await store.snapshot()).map((record) => record.id),
		[second.id],
	);
	assert.equal((await f.ingress.branch().attachment.submissionViews()).length, 2);
	await f.session.prompt("third");
	assert.equal(f.sent.length, 3);
	assert.equal((await store.snapshot()).at(-1).outcome, "success");
	await assert.rejects(store.begin(first), { code: "stale" });
	assert.equal(await f.ingress.retireRequestHistory(), 1);
});

test("automatic idle maintenance retires duplicate native receipts without another request", async (t) => {
	const errors = [];
	const f = await fixture(t, {
		provider: true,
		autoRelease: { retireHistory: true, onError: (error) => errors.push(error) },
	});
	await f.session.prompt("first");
	await f.session.prompt("second");
	await waitForFlow(async () => (await f.ingress.branch().attachment.nativeRequests.snapshot()).length === 1);
	assert.equal(f.sent.length, 2);
	assert.deepEqual(errors, []);
	assert.equal((await f.ingress.branch().attachment.submissionViews()).length, 2);
});

test("disposal joins automatic maintenance without closing its storage early", { timeout: 5000 }, async (t) => {
	const errors = [];
	const f = await fixture(t, {
		autoRelease: { retireHistory: true, onError: (error) => errors.push(error) },
	});
	const entered = deferred(),
		release = deferred();
	const ledger = f.ingress.branch().attachment.ledger;
	// Hold the first retirement phase; later phases still need an owned, open ledger.
	const waits = f.ingress.branch().attachment.waits;
	const original = waits.snapshot.bind(waits);
	let paused = false;
	t.mock.method(waits, "snapshot", async (...args) => {
		if (!paused) {
			paused = true;
			entered.resolve();
			await release.promise;
			await ledger.snapshot();
		}
		return original(...args);
	});
	f.ingress.requestRelease();
	await entered.promise;
	let closed = false;
	const closing = f.ingress.dispose().then(() => {
		closed = true;
	});
	try {
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(closed, false);
	} finally {
		release.resolve();
	}
	await closing;
	assert.deepEqual(errors, []);
});

test("idle wait maintenance releases terminal producer listeners without removing evidence", async (t) => {
	const f = await fixture(t);
	const attachment = f.ingress.branch().attachment;
	await attachment.waits.registerWork("background-work", "bg", 0);
	let listeners = 0;
	const registration = attachment.waitProducers.register(
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
		},
		(error) => {
			throw error;
		},
	);
	await registration.bind({ workId: "background-work", handle: "job", execution: "execution" }, 1);
	assert.equal(listeners, 1);
	const before = await attachment.waits.authoritySnapshot();
	assert.deepEqual(await f.ingress.retireWaitHistory(), { work: 0, waits: 0, executions: 0 });
	assert.equal(listeners, 0);
	assert.deepEqual(await attachment.waits.authoritySnapshot(), before);
	assert.equal(f.sent.length, 0);
});

test("user history retirement observes native input and fences replay after reopen", async (t) => {
	const f = await fixture(t, { provider: true });
	await f.session.prompt("finish this input");
	const attachment = f.ingress.branch().attachment;
	const [record] = await attachment.submissions.snapshot();
	const [work] = (await attachment.waits.authoritySnapshot()).work;
	assert.deepEqual(work.userInputs, [{ id: record.id, revision: record.revision }]);
	assert.deepEqual(await f.ingress.retireWaitHistory(true), { work: 1, waits: 0, executions: 0 });
	assert.deepEqual(await f.ingress.retireWaitHistory(true), { work: 0, waits: 0, executions: 0 });
	await f.ingress.dispose();
	const next = await fixture(t, {
		root: f.root,
		provider: true,
		manager: SessionManager.open(f.session.sessionManager.getSessionFile()),
	});
	await assert.rejects(retainUserWork(next.ingress.branch().attachment, record.id, record.revision), { code: "stale" });
	await next.session.prompt("new input");
	assert.equal(next.sent.length, 1);
	assert.equal((await next.ingress.branch().attachment.waits.authoritySnapshot()).work.length, 1);
});

test("user retirement preserves pause, execution references, and unobserved source claims", async (t) => {
	const f = await fixture(t, { provider: true });
	await f.session.prompt("finished");
	const attachment = f.ingress.branch().attachment;
	const [work] = (await attachment.waits.authoritySnapshot()).work;
	const records = await attachment.submissions.snapshot();
	const requests = await attachment.nativeRequests.snapshot();
	assert.deepEqual(finishedUserWork([work], records, requests, new Set()), [work]);
	for (const mutate of [
		({ records }) => {
			records[0].dispatch.phase = "failed";
		},
		({ requests }) => {
			requests[0].outcome = "failure";
		},
		({ requests }) => {
			requests[0].outcome = "withheld";
		},
		({ requests }) => {
			delete requests[0].payload;
		},
		({ requests }) => {
			requests[0].sourceCapture.model.members[0].status = "removed";
		},
		({ records }) => {
			records[0].dispatch.promptClaims.push({ inputIndex: 0, messageIndex: 99 });
		},
		({ work }) => {
			work.userInputs[0].revision += 1;
		},
		({ work }) => {
			delete work.userInputs;
		},
	]) {
		const copy = structuredClone({ work, records, requests });
		mutate(copy);
		assert.deepEqual(finishedUserWork([copy.work], copy.records, copy.requests, new Set()), []);
	}
	const failedThenStatus = structuredClone(requests);
	failedThenStatus[0].outcome = "failure";
	failedThenStatus.push({ ...requests[0], id: "later-successful-status" });
	assert.deepEqual(finishedUserWork([work], records, failedThenStatus, new Set()), []);
	assert.deepEqual(finishedUserWork([work], records, requests, new Set([work.id])), []);
	await attachment.waits.changeWork(work.id, work.owner, work.revision, "paused", "User pause", Date.now());
	assert.equal((await f.ingress.retireWaitHistory(true)).work, 0);
	const resumed = await attachment.waits.changeWork(work.id, work.owner, 2, "active", "User resume", Date.now());
	await attachment.waits.registerExecution(
		{
			producer: "host-user",
			handle: "job",
			execution: "execution",
			workId: work.id,
			revision: 1,
			predicates: [{ until: "exit", state: "satisfied" }],
		},
		resumed.revision,
		Date.now(),
	);
	assert.equal((await f.ingress.retireWaitHistory(true)).work, 0);
});

test("automatic user history cleanup runs once after settled host input", async (t) => {
	const errors = [];
	const f = await fixture(t, {
		provider: true,
		autoRelease: { retireHistory: true, onError: (error) => errors.push(error) },
	});
	await f.session.prompt("first");
	for (let i = 0; i < 100 && (await f.ingress.branch().attachment.waits.authoritySnapshot()).work.length; i++)
		await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal((await f.ingress.branch().attachment.waits.authoritySnapshot()).work.length, 0);
	await f.session.prompt("second");
	for (let i = 0; i < 100 && (await f.ingress.branch().attachment.waits.authoritySnapshot()).work.length; i++)
		await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal((await f.ingress.branch().attachment.waits.authoritySnapshot()).work.length, 0);
	assert.equal(f.sent.length, 2);
	assert.deepEqual(errors, []);
});

test("user retirement retains dormant producer work and rejects changed snapshots", async (t) => {
	const f = await fixture(t, { provider: true });
	await f.session.prompt("producer-owned follow-through");
	const branch = f.ingress.branch();
	const [work] = (await branch.attachment.waits.authoritySnapshot()).work;
	let items = [
		{
			id: "intent",
			revision: "1",
			producer: "loop",
			sequence: 0,
			rank: 4,
			workId: work.id,
			workRevision: String(work.revision),
			independent: false,
			runnable: false,
		},
	];
	const registration = branch.controller.register(
		{
			version: 1,
			namespace: "loop",
			snapshot: async () => items,
			build: async () => assert.fail("retention must not build"),
		},
		async () => {},
	);
	assert.equal((await f.ingress.retireWaitHistory(true)).work, 0);
	items = [];
	const retire = branch.attachment.waits.retire.bind(branch.attachment.waits);
	t.mock.method(branch.attachment.waits, "retire", async (...args) => {
		await registration.changed();
		return retire(...args);
	});
	await assert.rejects(f.ingress.retireWaitHistory(true), { code: "stale" });
	assert.equal((await branch.attachment.waits.authoritySnapshot()).work.length, 1);
	t.mock.restoreAll();
	assert.equal((await f.ingress.retireWaitHistory(true)).work, 1);
	assert.equal(f.sent.length, 1);
});

test("session ingress retains original input before policy and native dispatch", async (t) => {
	let seen;
	const f = await fixture(t, {
		admit: async (submission, branch) => {
			const [saved] = await branch.attachment.submissions.snapshot();
			assert.deepEqual(saved.submission, submission);
			assert.equal(saved.dispatch, undefined);
			seen = submission;
			submission.args[0] = "policy mutation";
			return true;
		},
	});
	await f.session.prompt("original");
	assert.equal(seen.api, "prompt");
	assert.equal(f.sent.length, 1);
	assert.ok(JSON.stringify(f.sent).includes("original"));
	assert.ok(!JSON.stringify(f.sent).includes("policy mutation"));
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	assert.equal(record.dispatch.phase, "returned");
	assert.equal(record.dispatch.promptHistory.length, 1);
	assert.equal((await f.ingress.branch().attachment.nativeRequests.snapshot())[0].outcome, "success");
});

test("held ingress callbacks recheck policy and concurrent release dispatches once", async (t) => {
	let allowed = false;
	const entered = deferred(),
		release = deferred();
	const f = await fixture(t, {
		admit: async () => {
			if (!allowed) return false;
			entered.resolve();
			await release.promise;
			return true;
		},
	});
	await f.session.prompt("held");
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	assert.equal(record.dispatch, undefined);
	assert.equal(await f.ingress.release(record.id, record.revision), false);
	allowed = true;
	const one = f.ingress.release(record.id, record.revision);
	await entered.promise;
	const two = f.ingress.release(record.id, record.revision);
	release.resolve();
	assert.deepEqual(await Promise.all([one, two]), [true, true]);
	assert.equal(f.sent.length, 1);
	await assert.rejects(f.ingress.release(record.id, record.revision), { code: "stale" });
});

test("duplicate retained submission cannot replace its dispatch callback", async (t) => {
	const f = await fixture(t, { admit: async () => false });
	await f.session.prompt("held");
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	let replay = 0;
	await f.ingress.submit(record.submission, async () => {
		replay++;
	});
	assert.equal(replay, 0);
	assert.equal((await f.ingress.branch().attachment.submissions.snapshot()).length, 1);
});

test("disposal fences an in-flight admission and preserves retained work", async (t) => {
	const entered = deferred(),
		release = deferred();
	const f = await fixture(t, {
		admit: async () => {
			entered.resolve();
			await release.promise;
			return true;
		},
	});
	const prompt = f.session.prompt("held during shutdown");
	await entered.promise;
	const branch = f.ingress.branch();
	const closing = f.ingress.dispose();
	release.resolve();
	await assert.rejects(prompt, { code: "stale" });
	await closing;
	assert.equal(f.sent.length, 0);
	assert.throws(() => f.ingress.branch(), { code: "stale" });
	assert.equal(branch.controller.view().state, "closed");
});

test("ingress refuses self-disposal during admission without deadlock", async (t) => {
	let ingress;
	const f = await fixture(t, {
		admit: async () => {
			await assert.rejects(ingress.dispose(), { code: "busy" });
			return false;
		},
	});
	ingress = f.ingress;
	await f.session.prompt("held");
	assert.equal(f.sent.length, 0);
	assert.equal((await ingress.branch().attachment.submissions.snapshot()).length, 1);
});

test("reopened ingress retains work without reconstructing a dispatch callback", async (t) => {
	const first = await fixture(t, { admit: async () => false });
	await first.session.prompt("retained across restart");
	const [record] = await first.ingress.branch().attachment.submissions.snapshot();
	await first.ingress.dispose();
	const next = await fixture(t, {
		root: first.root,
		manager: SessionManager.open(first.session.sessionManager.getSessionFile()),
	});
	assert.equal((await next.ingress.branch().attachment.submissions.snapshot())[0].id, record.id);
	assert.deepEqual(await next.ingress.heldInputs(), [
		{ id: record.id, reason: "Input was not dispatched before the session ended. Submit it again to run it." },
	]);
	await assert.rejects(next.ingress.release(record.id, record.revision), { code: "stale" });
	assert.equal(next.sent.length, 0);
	assert.equal((await next.ingress.cancelRetained(record.id, record.revision)).kind, "cancelled");
	assert.deepEqual(await next.ingress.heldInputs(), []);
	assert.equal(next.sent.length, 0);
});

test("branch navigation drops old callbacks before attaching new branch resources", async (t) => {
	const f = await fixture(t, { admit: async (submission) => submission.args[0] !== "held" });
	await f.session.prompt("first question");
	const original = f.ingress.branch();
	const user = f.session.sessionManager
		.getBranch()
		.find((entry) => entry.type === "message" && entry.message.role === "user");
	await f.session.prompt("held");
	const held = (await original.attachment.submissions.snapshot()).find(
		(record) => record.submission.args[0] === "held",
	);
	await f.session.navigateTree(user.id);
	assert.notEqual(f.ingress.branch().scope.branchId, original.scope.branchId);
	await assert.rejects(f.ingress.release(held.id, held.revision), { code: "stale" });
	await f.session.prompt("new branch question");
	assert.equal(f.sent.length, 2);
	assert.ok(!JSON.stringify(f.sent).includes("held"));
});

test("failed admission retains data but cannot reuse the revoked Pi callback", async (t) => {
	let fail = true;
	const f = await fixture(t, {
		admit: async () => {
			if (fail) throw new Error("policy failure");
			return true;
		},
	});
	await assert.rejects(f.session.prompt("retained"), /policy failure/);
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	fail = false;
	await assert.rejects(f.ingress.release(record.id, record.revision), { code: "stale" });
	assert.equal(record.dispatch, undefined);
	assert.equal(f.sent.length, 0);
});

test("cancelled retained revisions cannot dispatch through an old callback", async (t) => {
	let allowed = false;
	const f = await fixture(t, { admit: async () => allowed });
	await f.session.prompt("held");
	const branch = f.ingress.branch();
	const [record] = await branch.attachment.submissions.snapshot();
	await branch.attachment.submissions.cancel(record.id, record.revision);
	allowed = true;
	await assert.rejects(f.ingress.release(record.id, record.revision));
	assert.equal(f.sent.length, 0);
	assert.equal((await branch.attachment.submissions.snapshot())[0].dispatch, undefined);
});

test("native recovery gates retain a submission even when host policy permits it", async (t) => {
	const f = await fixture(t);
	const branch = f.ingress.branch();
	await branch.attachment.nativeRequests.begin({
		id: "uncertain",
		sourceHash: "a".repeat(64),
		transformedHash: "b".repeat(64),
		modelHash: "c".repeat(64),
		systemHash: "d".repeat(64),
	});
	await f.session.prompt("held by recovery");
	const [record] = await branch.attachment.submissions.snapshot();
	assert.equal(record.dispatch, undefined);
	assert.equal(f.sent.length, 0);
	assert.equal(await f.ingress.release(record.id, record.revision), false);
});

test("admission rejects reentrant release instead of awaiting its own promise", async (t) => {
	let ingress;
	const f = await fixture(t, {
		admit: async (submission, branch) => {
			const [record] = await branch.attachment.submissions.snapshot();
			await assert.rejects(ingress.release(submission.id, record.revision), { code: "busy" });
			return true;
		},
	});
	ingress = f.ingress;
	await f.session.prompt("one instruction");
	assert.equal(f.sent.length, 1);
});

test("queue admission rechecks policy after a previously admitted send", async (t) => {
	let allowQueue = false;
	const phases = [];
	const f = await fixture(t, {
		admit: async (_submission, _branch, phase) => {
			phases.push(phase);
			return phase === "submission" || allowQueue;
		},
	});
	await f.session.followUp("queued instruction");
	await f.session.continueQueued();
	assert.equal(f.sent.length, 0);
	assert.equal(f.session.agent.inspectQueuedMessages().length, 1);
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	assert.equal(record.dispatch.queueClaims, undefined);
	assert.equal(f.session.agent.inspectQueuedMessages().length, 1);
	allowQueue = true;
	await f.session.continueQueued();
	assert.equal(f.sent.length, 1);
	assert.equal(f.session.agent.inspectQueuedMessages().length, 0);
	assert.deepEqual(phases, ["submission", "queue", "queue"]);
});

test("cancellation during queued policy prevents consumption and provider execution", async (t) => {
	const f = await fixture(t, {
		admit: async (submission, branch, phase) => {
			if (phase === "queue") {
				const record = (await branch.attachment.submissions.snapshot()).find((item) => item.id === submission.id);
				await branch.attachment.submissions.cancel(record.id, record.revision);
			}
			return true;
		},
	});
	await f.session.followUp("cancel before claim");
	await f.session.continueQueued();
	assert.equal(f.sent.length, 0);
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	assert.equal(record.status, "cancelled");
	assert.equal(record.dispatch.queueClaims, undefined);
	assert.equal(f.session.agent.inspectQueuedMessages().length, 1);
	assert.equal(record.dispatch.queueHistory, undefined);
});

test("queued cancellation after native removal keeps consumed evidence and prevents history", async (t) => {
	const f = await fixture(t);
	await f.session.followUp("cancel at claim");
	const store = f.ingress.branch().attachment.submissions;
	const [record] = await store.snapshot();
	const claim = store.recordQueueClaim.bind(store);
	t.mock.method(store, "recordQueueClaim", async (...args) => {
		await claim(...args);
		if (args[2]) await store.cancel(record.id, record.revision);
	});
	await f.session.continueQueued();
	assert.equal(f.sent.length, 0);
	const [cancelled] = await store.snapshot();
	assert.equal(cancelled.dispatch.queueClaims[0].consumed, true);
	assert.equal(cancelled.dispatch.queueHistory, undefined);
	assert.equal(f.session.agent.inspectQueuedMessages().length, 0);
	assert.match(f.session.agent.state.errorMessage, /cancelled during queue consumption/);
});

test("queue admission receives exact identity for duplicate sends", async (t) => {
	const ids = [];
	const f = await fixture(t, {
		admit: async (submission, _branch, phase) => {
			if (phase === "queue") ids.push(submission.id);
			return true;
		},
	});
	await f.session.followUp("same");
	await f.session.followUp("same");
	f.session.agent.followUpMode = "all";
	await f.session.continueQueued();
	assert.equal(ids.length, 2);
	assert.notEqual(ids[0], ids[1]);
	assert.equal(f.sent.length, 1);
	const records = await f.ingress.branch().attachment.submissions.snapshot();
	assert.deepEqual(
		ids,
		records.map((record) => record.id),
	);
});

test("one denied member holds the complete native queue candidate batch", async (t) => {
	const f = await fixture(t, {
		admit: async (submission, _branch, phase) => phase === "submission" || submission.args[0] !== "held",
	});
	await f.session.followUp("allowed");
	await f.session.followUp("held");
	f.session.agent.followUpMode = "all";
	await f.session.continueQueued();
	assert.equal(f.sent.length, 0);
	assert.equal(f.session.agent.inspectQueuedMessages().length, 2);
	assert.ok(
		(await f.ingress.branch().attachment.submissions.snapshot()).every(
			(record) => !record.dispatch.queueClaims && !record.dispatch.queueHistory,
		),
	);
});

test("queue policy errors retain native candidates without provider execution", async (t) => {
	const f = await fixture(t, {
		admit: async (_submission, _branch, phase) => {
			if (phase === "queue") throw new Error("queue policy failure");
			return true;
		},
	});
	await f.session.followUp("queued");
	await f.session.continueQueued();
	assert.equal(f.sent.length, 0);
	assert.equal(f.session.agent.inspectQueuedMessages().length, 1);
	assert.equal(f.ingress.branch().native.heldInputs()[0].reason, "Queue admission could not complete.");
});

test("queue edits during policy cannot consume the original observed revision", async (t) => {
	let session;
	const f = await fixture(t, {
		admit: async (_submission, _branch, phase) => {
			if (phase === "queue") {
				const [item] = session.agent.inspectQueuedMessages();
				session.agent.editQueuedMessage(item.id, item.revision, {
					role: "user",
					content: [{ type: "text", text: "edited" }],
					timestamp: 1,
				});
			}
			return true;
		},
	});
	session = f.session;
	await session.followUp("original");
	await session.continueQueued();
	assert.equal(f.sent.length, 0);
	assert.equal(session.agent.inspectQueuedMessages()[0].revision, 2);
	await session.continueQueued();
	assert.equal(f.sent.length, 0);
	assert.equal(f.ingress.branch().native.heldInputs()[0].reason, "Edited native input requires a new observation.");
	const [edited] = session.agent.inspectQueuedMessages();
	session.agent.cancelQueuedMessage(edited.id, edited.revision);
});

test("queue policy receives the reconciled native revision and edited content", async (t) => {
	let checked;
	const f = await fixture(t, {
		admit: async (_submission, _branch, phase, input) => {
			if (phase === "queue") checked = structuredClone(input);
			return true;
		},
	});
	await f.session.followUp("original");
	const [item] = f.session.agent.inspectQueuedMessages();
	f.session.agent.editQueuedMessage(item.id, 1, {
		role: "user",
		content: [{ type: "text", text: "edited" }],
		timestamp: 1,
	});
	await f.ingress.branch().native.reconcileQueueEdit(item.id, 2);
	await f.session.continueQueued();
	assert.equal(checked.queue.revision, 2);
	assert.equal(checked.args[0].content[0].text, "edited");
	assert.equal(f.sent.length, 1);
	assert.ok(!JSON.stringify(f.sent).includes("original"));
	const [request] = await f.ingress.branch().attachment.nativeRequests.snapshot();
	assert.equal(request.sourceCapture.members[0].queue.revision, 2);
	assert.equal(request.sourceCapture.model.members[0].status, "intact");
});

test("default ingress holds opaque automation during waits while user input proceeds", async (t) => {
	let waiting = true;
	const f = await fixture(t, {
		admit: null,
		policy: () => ({ userPending: false, recoveryBlocked: false, waitingWorkIds: waiting ? ["campaign"] : [] }),
	});
	await f.session.sendUserMessage("opaque instruction with urgent user labels");
	const [held] = await f.ingress.branch().attachment.submissions.snapshot();
	assert.equal(f.sent.length, 0);
	assert.match((await f.ingress.heldInputs())[0].reason, /independence/);
	await f.session.prompt("manual status");
	assert.equal(f.sent.length, 1);
	assert.ok(!JSON.stringify(f.sent).includes("opaque instruction"));
	waiting = false;
	assert.equal(await f.ingress.release(held.id, held.revision), true);
	assert.equal(f.sent.length, 2);
	assert.ok(JSON.stringify(f.sent[1]).includes("opaque instruction"));
	assert.equal((await f.ingress.branch().attachment.submissions.snapshot())[0].holds, undefined);
	assert.deepEqual(await f.ingress.heldInputs(), []);
});

test("default ingress preserves opaque lane order on explicit release", async (t) => {
	let waiting = true;
	const f = await fixture(t, {
		admit: null,
		policy: () => ({ userPending: false, recoveryBlocked: false, waitingWorkIds: waiting ? ["campaign"] : [] }),
	});
	await f.session.sendUserMessage("first");
	await f.session.sendUserMessage("second");
	const [first, second] = await f.ingress.branch().attachment.submissions.snapshot();
	waiting = false;
	assert.equal(await f.ingress.release(second.id, second.revision), false);
	assert.match((await f.ingress.heldInputs()).find((item) => item.id === second.id).reason, /earlier/);
	assert.equal(await f.ingress.release(first.id, first.revision), true);
	assert.equal(await f.ingress.release(second.id, second.revision), true);
	assert.equal(f.sent.length, 2);
	assert.ok(!JSON.stringify(f.sent[0]).includes("second"));
});

test("next-turn custom context can wait alongside a live wait without an implicit wake", async (t) => {
	const f = await fixture(t, {
		admit: null,
		policy: () => ({ userPending: false, recoveryBlocked: false, waitingWorkIds: ["work"] }),
	});
	await f.session.sendCustomMessage(
		{ customType: "status", content: "context", display: true },
		{ triggerTurn: false, deliverAs: "nextTurn" },
	);
	assert.equal(f.sent.length, 0);
	assert.deepEqual(await f.ingress.heldInputs(), []);
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	assert.equal(record.dispatch.inputs[0].kind, "context");
	assert.equal(record.dispatch.promptClaims, undefined);
	assert.ok(!JSON.stringify(f.session.agent.state.messages).includes("context"));
	await f.session.prompt("manual status");
	assert.equal(f.sent.length, 1);
	assert.ok(JSON.stringify(f.sent).includes("context"));
});

test("failed diagnostic persistence cannot release an admitted input", async (t) => {
	let allowed = false;
	const f = await fixture(t, { admit: async () => allowed });
	await f.session.prompt("held");
	const store = f.ingress.branch().attachment.submissions;
	const [record] = await store.snapshot();
	allowed = true;
	t.mock.method(store, "recordAdmission", async () => {
		throw new Error("write failure");
	});
	await assert.rejects(f.ingress.release(record.id, record.revision), /write failure/);
	assert.equal(f.sent.length, 0);
	assert.equal((await store.snapshot())[0].holds[0].reason, "Input is held by host admission policy.");
});

test("queue policy failures retain a bounded diagnostic without persisting exception text", async (t) => {
	const f = await fixture(t, {
		admit: async (_submission, _branch, phase) => {
			if (phase === "queue") throw new Error("private exception details");
			return true;
		},
	});
	await f.session.followUp("queued instruction");
	await f.session.continueQueued();
	assert.equal(f.sent.length, 0);
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	assert.equal(record.holds[0].phase, "queue");
	assert.equal(record.holds[0].queue.revision, 1);
	assert.match((await f.ingress.heldInputs())[0].reason, /policy failed/);
	assert.ok(!JSON.stringify(record).includes("private exception"));
});

test("cancelled retained inputs no longer present active admission holds", async (t) => {
	const f = await fixture(t, { admit: async () => false });
	await f.session.prompt("held");
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	await f.ingress.branch().attachment.submissions.cancel(record.id, record.revision);
	assert.deepEqual(await f.ingress.heldInputs(), []);
	const [view] = await f.ingress.branch().attachment.submissionViews();
	assert.equal(view.admission, "cancelled");
	assert.equal(view.reason, undefined);
});

test("edited queue admission keeps revision diagnostics separate and retires superseded holds", async (t) => {
	let allowed = false;
	const f = await fixture(t, { admit: async (_submission, _branch, phase) => phase === "submission" || allowed });
	await f.session.followUp("original");
	await f.session.continueQueued();
	const [queued] = f.session.agent.inspectQueuedMessages();
	f.session.agent.editQueuedMessage(queued.id, 1, {
		role: "user",
		content: [{ type: "text", text: "edited" }],
		timestamp: 1,
	});
	await f.ingress.branch().native.reconcileQueueEdit(queued.id, 2);
	assert.deepEqual(await f.ingress.heldInputs(), []);
	await f.session.continueQueued();
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	assert.deepEqual(
		record.holds.map((hold) => hold.queue.revision),
		[1, 2],
	);
	assert.equal((await f.ingress.heldInputs()).length, 1);
	allowed = true;
	await f.session.continueQueued();
	assert.equal(f.sent.length, 1);
	assert.deepEqual(await f.ingress.heldInputs(), []);
	assert.ok(!JSON.stringify(f.sent).includes("original"));
});

test("policy argument mutation cannot redirect the durable hold identity", async (t) => {
	const f = await fixture(t, {
		admit: async (submission, _branch, phase, input) => {
			if (phase === "queue") {
				submission.id = "another input";
				input.queue.id = "another queue";
				return false;
			}
			return true;
		},
	});
	await f.session.followUp("original");
	const [queued] = f.session.agent.inspectQueuedMessages();
	await f.session.continueQueued();
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	assert.equal(record.holds[0].queue.id, queued.id);
	assert.equal((await f.ingress.heldInputs())[0].id, record.id);
	assert.equal(f.sent.length, 0);
});

test("retained cancellation removes the callback and permits the next instruction in its lane", async (t) => {
	let waiting = true;
	const f = await fixture(t, {
		admit: null,
		policy: () => ({ userPending: false, recoveryBlocked: false, waitingWorkIds: waiting ? ["work"] : [] }),
	});
	await f.session.sendUserMessage("cancel me");
	await f.session.sendUserMessage("keep me");
	const [first, second] = await f.ingress.branch().attachment.submissions.snapshot();
	assert.deepEqual(await f.ingress.cancelRetained(first.id, first.revision), { kind: "cancelled", revision: 2 });
	assert.deepEqual(await f.ingress.cancelRetained(first.id, 2), { kind: "cancelled", revision: 2 });
	await assert.rejects(f.ingress.release(first.id, first.revision), { code: "stale" });
	assert.equal(f.sent.length, 0);
	waiting = false;
	assert.equal(await f.ingress.release(second.id, second.revision), true);
	assert.equal(f.sent.length, 1);
	assert.ok(!JSON.stringify(f.sent).includes("cancel me"));
});

test("retained cancellation wins during awaited admission without a provider request", async (t) => {
	const entered = deferred(),
		proceed = deferred();
	let hold = true;
	const f = await fixture(t, {
		admit: async () => {
			if (hold) return false;
			entered.resolve();
			await proceed.promise;
			return true;
		},
	});
	await f.session.prompt("held");
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	hold = false;
	const release = f.ingress.release(record.id, record.revision);
	const rejected = assert.rejects(release, { code: "stale" });
	await entered.promise;
	assert.equal((await f.ingress.cancelRetained(record.id, record.revision)).kind, "cancelled");
	proceed.resolve();
	await rejected;
	assert.equal(f.sent.length, 0);
	assert.deepEqual(await f.ingress.heldInputs(), []);
});

test("failed or conflicting cancellation preserves the live retained callback", async (t) => {
	let allowed = false;
	const f = await fixture(t, { admit: async () => allowed });
	await f.session.prompt("preserve");
	const store = f.ingress.branch().attachment.submissions;
	const [record] = await store.snapshot();
	assert.equal((await f.ingress.cancelRetained(record.id, 99)).kind, "conflict");
	const mocked = t.mock.method(store, "cancelPending", async () => {
		throw new Error("storage failed");
	});
	await assert.rejects(f.ingress.cancelRetained(record.id, record.revision), /storage failed/);
	mocked.mock.restore();
	allowed = true;
	assert.equal(await f.ingress.release(record.id, record.revision), true);
	assert.equal(f.sent.length, 1);
});

test("retained cancellation refuses input already owned by the native queue", async (t) => {
	const f = await fixture(t);
	await f.session.followUp("queued");
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	await assert.rejects(f.ingress.cancelRetained(record.id, record.revision), { code: "transition" });
	assert.equal((await f.ingress.branch().attachment.submissions.snapshot())[0].status, "retained");
	assert.equal(f.session.agent.inspectQueuedMessages().length, 1);
	await f.session.continueQueued();
	assert.equal(f.sent.length, 1);
});

test("ingress management inspects and cancels an edited native queue without a model call", async (t) => {
	const f = await fixture(t);
	await f.session.followUp("original");
	const [item] = f.session.agent.inspectQueuedMessages();
	f.session.agent.editQueuedMessage(item.id, 1, {
		role: "user",
		content: [{ type: "text", text: "edited" }],
		timestamp: 1,
	});
	await f.ingress.reconcileNativeQueueEdit(item.id, 2);
	await f.ingress.cancelNativeQueue(item.id, 2);
	const view = await f.ingress.inspect();
	assert.equal(view.version, 1);
	assert.equal(view.scope.sessionId, f.session.sessionId);
	assert.equal(view.submissions[0].admission, "cancelled");
	assert.deepEqual(view.submissions[0].nativeQueueCancellations, [{ id: item.id, revision: 2, removal: "confirmed" }]);
	view.submissions[0].nativeQueueCancellations[0].removal = "unconfirmed";
	assert.equal((await f.ingress.inspect()).submissions[0].nativeQueueCancellations[0].removal, "confirmed");
	assert.equal(f.sent.length, 0);
	await f.ingress.dispose();
	await assert.rejects(f.ingress.inspect(), { code: "stale" });
	assert.throws(() => f.ingress.cancelNativeQueue(item.id, 2), { code: "stale" });
});
