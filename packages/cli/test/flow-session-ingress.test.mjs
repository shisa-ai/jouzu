import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, setValue, value } from "@earendil-works/pi-agent-core";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assistant, createFlowSession, deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { createBackgroundControllerExtension } from "../dist/flow-control/background-extension.js";
import { createMultiloopControllerExtension } from "../dist/flow-control/multiloop-extension.js";
import { multiloopWorkBinding } from "../dist/flow-control/multiloop-producer.js";
import { awaitingNativeInput } from "../dist/flow-control/native-admission.js";
import { PiSessionFlowIngress } from "../dist/flow-control/pi-session-ingress.js";
import { consumedUserWork, retainUserWork } from "../dist/flow-control/user-work.js";
import { finishedUserWork } from "../dist/flow-control/user-work-retention.js";
import { createFlowWaitDecisionProducer } from "../dist/flow-control/wait-decisions.js";
import { createFlowWaitExtension } from "../dist/flow-control/wait-tools.js";

async function fixture(
	t,
	{
		root: supplied,
		userWorkParticipants,
		admit = async () => true,
		policy,
		manager,
		nextTurnObserver,
		autoRelease,
		attachWaitSources,
		consumedAttempt,
		maxInputBytes = 4096,
		provider = false,
		shutdownExtensions = false,
		checkpoints,
		onRequest,
		response,
		tools = [],
		extensions = [],
	} = {},
) {
	const root = supplied ?? (await mkdtemp(join(tmpdir(), "jouzu-ingress-owner-")));
	const ingress = new PiSessionFlowIngress({
		root,
		autoRelease,
		attachWaitSources,
		userWorkParticipants,
		maxInputBytes,
		maxResultBytes: 4096,
		host: {
			consumedAttempt,
			maxPayloadBytes: 100000,
			containsUserInput: () => !provider,
		},
		policy: policy ?? (() => ({ userPending: false, recoveryBlocked: false, waitingWorkIds: [] })),
		admit,
	});
	const sent = [];
	let wrapped;
	const { session } = await createFlowSession(t, {
		persist: true,
		shutdownExtensions,
		tools,
		extensions,
		checkpoints,
		sessionManager: manager,
		ingress: {
			version: 1,
			async attach(session) {
				session.flowNextTurn = nextTurnObserver;
				session.agent.streamFunction = async (model, context, options) => {
					if (provider)
						return stream({ ...model, baseUrl: "https://fixture.invalid/v1" }, context, {
							...options,
							apiKey: "fixture",
							maxRetries: 0,
							fetch: async (_url, init) => {
								sent.push(JSON.parse(init.body).messages);
								await onRequest?.();
								if (response) return response();
								return new Response(
									`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: "Done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
									{ headers: { "content-type": "text/event-stream" } },
								);
							},
						});
					// The controller no longer maps per-message conversion outputs, so this callback is
					// optional the way Pi treats it.
					for (const message of context.messages)
						if (message.role === "user") options.onMessageConverted?.(message, message);
					await options.onPayload({ messages: context.messages }, model);
					sent.push(structuredClone(context.messages));
					return { async *[Symbol.asyncIterator]() {}, result: async () => assistant() };
				};
				await ingress.attach(session);
				wrapped = session.agent.streamFunction;
			},
			submit: (...args) => ingress.submit(...args),
			beforeBranchChange: () => ingress.beforeBranchChange(),
			branchChanged: () => ingress.branchChanged(),
			dispose: () => ingress.dispose(),
		},
	});
	// The generic fixture replaces its stream after SDK construction.
	session.agent.streamFunction = wrapped;
	t.after(async () => {
		await ingress.dispose();
		if (!supplied) await rm(root, { recursive: true, force: true });
	});
	return { root, session, ingress, sent };
}

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
		{ id: record.id, reason: "Input is held by host admission policy." },
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

test("idle non-waking custom context persists with native source identity and no model call", async (t) => {
	const f = await fixture(t, { admit: null });
	await f.session.sendCustomMessage(
		{ customType: "note", content: "remember this", display: true, details: { marker: 1 } },
		{ triggerTurn: false },
	);
	assert.equal(f.sent.length, 0);
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	assert.equal(record.dispatch.inputs[0].kind, "context");
	assert.equal(record.dispatch.promptClaims.length, 1);
	assert.equal(record.dispatch.promptHistory.length, 1);
	const members = await f.ingress.branch().native.sources(f.session.agent.state.messages);
	assert.equal(members.length, 1);
	assert.equal(members[0].operationId, record.dispatch.operationId);
	await f.session.prompt("use the note");
	assert.equal(f.sent.length, 1);
	assert.ok(JSON.stringify(f.sent).includes("remember this"));
});

test("non-waking context restores its source identity after reopen", async (t) => {
	const first = await fixture(t, { admit: null });
	await first.session.sendCustomMessage(
		{ customType: "note", content: "persist me", display: true },
		{ triggerTurn: false },
	);
	await first.ingress.dispose();
	const next = await fixture(t, {
		root: first.root,
		manager: SessionManager.open(first.session.sessionManager.getSessionFile()),
		admit: null,
	});
	assert.equal(next.ingress.branch().sourceRecovery.recovered, 1);
	const sources = await next.ingress.branch().native.sources(next.session.agent.state.messages);
	assert.equal(sources.length, 1);
	assert.equal(next.sent.length, 0);
	await next.session.prompt("continue");
	assert.equal(next.sent.length, 1);
});

test("failed non-waking append cannot leave unattributed context available to a request", async (t) => {
	const f = await fixture(t, { admit: null });
	const mock = t.mock.method(f.session.sessionManager, "appendCustomMessageEntry", () => {
		throw new Error("append failed");
	});
	await assert.rejects(
		f.session.sendCustomMessage(
			{ customType: "note", content: "must reconcile", display: true },
			{ triggerTurn: false },
		),
		/append failed/,
	);
	mock.mock.restore();
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	assert.equal(record.dispatch.inputs[0].kind, "context");
	assert.equal(record.dispatch.phase, "failed");
	await assert.rejects(f.ingress.branch().native.sources(f.session.agent.state.messages), /receipt reconciliation/);
	await f.session.prompt("later request");
	assert.equal(f.sent.length, 0);
});

test("non-waking receipt failure preserves the instruction and blocks later requests", async (t) => {
	const f = await fixture(t, { admit: null });
	const store = f.ingress.branch().attachment.submissions;
	t.mock.method(store, "recordPromptHistory", async () => {
		throw new Error("receipt failed");
	});
	await assert.rejects(
		f.session.sendCustomMessage({ customType: "note", content: "retained", display: true }, { triggerTurn: false }),
		/receipt failed/,
	);
	const [record] = await store.snapshot();
	assert.equal(record.dispatch.promptClaims.length, 1);
	assert.equal(record.dispatch.promptHistory, undefined);
	await assert.rejects(f.ingress.branch().native.sources(f.session.agent.state.messages));
	assert.equal(f.sent.length, 0);
	await f.ingress.dispose();
	const next = await fixture(t, {
		root: f.root,
		manager: SessionManager.open(f.session.sessionManager.getSessionFile()),
		admit: null,
	});
	assert.equal(next.ingress.branch().sourceRecovery.unresolved, 1);
	await next.session.prompt("held until repaired");
	assert.equal(next.sent.length, 0);
	assert.match((await next.ingress.heldInputs())[0].reason, /recovery/);
});

test("deliberate idle context can join a live wait without waking the model", async (t) => {
	const f = await fixture(t, {
		admit: null,
		policy: () => ({ userPending: false, recoveryBlocked: false, waitingWorkIds: ["work"] }),
	});
	await f.session.sendCustomMessage(
		{ customType: "note", content: "decision context", display: true },
		{ triggerTurn: false },
	);
	assert.equal(f.sent.length, 0);
	assert.equal((await f.ingress.branch().attachment.submissions.snapshot())[0].dispatch.promptHistory.length, 1);
});

test("a following request waits for a non-waking context receipt", async (t) => {
	const f = await fixture(t, { admit: null });
	const entered = deferred(),
		release = deferred();
	const store = f.ingress.branch().attachment.submissions;
	const record = store.recordPromptHistory.bind(store);
	let first = true;
	t.mock.method(store, "recordPromptHistory", async (...args) => {
		if (first) {
			first = false;
			entered.resolve();
			await release.promise;
		}
		return record(...args);
	});
	const appending = f.session.sendCustomMessage(
		{ customType: "note", content: "context before user", display: true },
		{ triggerTurn: false },
	);
	await entered.promise;
	const prompting = f.session.prompt("user instruction");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.sent.length, 0);
	release.resolve();
	await Promise.all([appending, prompting]);
	assert.equal(f.sent.length, 1);
	const sources = await f.ingress.branch().native.sources(f.session.agent.state.messages);
	assert.equal(sources.length, 2);
});

test("memory-only context has live source identity without a persisted history receipt", async (t) => {
	const manager = SessionManager.inMemory();
	const f = await fixture(t, { manager, admit: null });
	await f.session.sendCustomMessage(
		{ customType: "note", content: "memory context", display: true },
		{ triggerTurn: false },
	);
	assert.equal(f.sent.length, 0);
	assert.equal(manager.getSessionFile(), undefined);
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	assert.equal(record.dispatch.promptClaims.length, 1);
	assert.equal(record.dispatch.promptHistory, undefined);
	assert.equal((await f.ingress.branch().native.sources(f.session.agent.state.messages)).length, 1);
	const [view] = (await f.ingress.inspect()).submissions;
	assert.equal(view.delivery, "consumed");
	await f.session.prompt("use memory context");
	assert.equal(f.sent.length, 1);
	assert.ok(JSON.stringify(f.sent).includes("memory context"));
});

test("reattached memory-only context restores ownership from the same live manager", async (t) => {
	const manager = SessionManager.inMemory();
	const first = await fixture(t, { manager, admit: null });
	await first.session.sendCustomMessage(
		{ customType: "note", content: "memory context", display: true },
		{ triggerTurn: false },
	);
	await first.ingress.dispose();
	const next = await fixture(t, { root: first.root, manager, admit: null });
	assert.deepEqual(next.ingress.branch().sourceRecovery, { recovered: 1, unresolved: 0 });
	assert.equal((await next.ingress.branch().native.sources(next.session.agent.state.messages)).length, 1);
	const [record] = await next.ingress.branch().attachment.submissions.snapshot();
	assert.equal(record.dispatch.promptHistory, undefined);
	await next.session.prompt("use retained context");
	assert.equal(next.sent.length, 1);
});

test("memory source recovery separates duplicate next-turn inputs from their consuming prompt", async (t) => {
	const manager = SessionManager.inMemory();
	const first = await fixture(t, { manager, admit: null });
	for (let i = 0; i < 2; i++)
		await first.session.sendCustomMessage(
			{ customType: "note", content: "duplicate memory context", display: true },
			{ deliverAs: "nextTurn" },
		);
	await first.session.prompt("consume memory context");
	const records = await first.ingress.branch().attachment.submissions.snapshot();
	await first.ingress.dispose();
	const next = await fixture(t, { root: first.root, manager, admit: null });
	assert.deepEqual(next.ingress.branch().sourceRecovery, { recovered: 3, unresolved: 0 });
	const sources = await next.ingress.branch().native.sources(next.session.agent.state.messages);
	assert.deepEqual(
		sources.map((source) => source.operationId).sort(),
		records.map((record) => record.dispatch.operationId).sort(),
	);
	assert.ok(records.every((record) => record.dispatch.promptHistory === undefined));
	await next.session.prompt("continue memory session");
	assert.equal(next.sent.length, 1);
});

test("changed memory entry cannot inherit its retained source receipt", async (t) => {
	const manager = SessionManager.inMemory();
	const first = await fixture(t, { manager, admit: null });
	await first.session.sendCustomMessage(
		{ customType: "note", content: "original memory context", display: true },
		{ triggerTurn: false },
	);
	await first.ingress.dispose();
	const entry = manager.getBranch().find((entry) => entry.type === "custom_message");
	entry.content = "changed memory context";
	await assert.rejects(fixture(t, { root: first.root, manager, admit: null }), /differs from its retained receipt/);
	assert.equal(first.sent.length, 0);
});

test("next-turn context keeps duplicate submissions distinct from the consuming prompt", async (t) => {
	const f = await fixture(t, { admit: null });
	for (let i = 0; i < 2; i++)
		await f.session.sendCustomMessage(
			{ customType: "note", content: "same context", display: true },
			{ deliverAs: "nextTurn" },
		);
	const before = await f.ingress.branch().attachment.submissions.snapshot();
	assert.equal(f.sent.length, 0);
	assert.ok(before.every((record) => record.dispatch.inputs[0].kind === "context" && !record.dispatch.promptClaims));
	assert.equal(f.session.sessionManager.getBranch().filter((entry) => entry.type === "custom_message").length, 0);
	await f.session.prompt("use both notes");
	assert.equal(f.sent.length, 1);
	const after = await f.ingress.branch().attachment.submissions.snapshot();
	assert.ok(
		after.every((record) => record.dispatch.promptClaims.length === 1 && record.dispatch.promptHistory.length === 1),
	);
	assert.equal(after[2].dispatch.inputs[0].args[0].length, 1);
	const sources = await f.ingress.branch().native.sources(f.session.agent.state.messages);
	assert.deepEqual(
		sources.map((source) => source.operationId),
		[after[2].dispatch.operationId, ...before.map((record) => record.dispatch.operationId)],
	);
	assert.equal(new Set(after.map((record) => record.dispatch.promptHistory[0].entryId)).size, 3);
});

test("next-turn context joins an independently admitted automated turn without creating a wake", async (t) => {
	const f = await fixture(t, { admit: null });
	await f.session.sendCustomMessage(
		{ customType: "note", content: "context", display: false },
		{ deliverAs: "nextTurn" },
	);
	assert.equal(f.sent.length, 0);
	await f.session.sendUserMessage("independent instruction");
	assert.equal(f.sent.length, 1);
	assert.ok(JSON.stringify(f.sent).includes("context"));
});

test("consumed next-turn sources restore from persisted history", async (t) => {
	const first = await fixture(t, { admit: null });
	await first.session.sendCustomMessage(
		{ customType: "note", content: "restore", display: true },
		{ deliverAs: "nextTurn" },
	);
	await first.session.prompt("consume");
	await first.ingress.dispose();
	const next = await fixture(t, {
		root: first.root,
		manager: SessionManager.open(first.session.sessionManager.getSessionFile()),
		admit: null,
	});
	assert.deepEqual(next.ingress.branch().sourceRecovery, { recovered: 2, unresolved: 0 });
	assert.equal((await next.ingress.branch().native.sources(next.session.agent.state.messages)).length, 2);
	await next.session.prompt("later");
	assert.equal(next.sent.length, 1);
});

test("unconsumed next-turn context stays unresolved across reopen", async (t) => {
	const first = await fixture(t, { admit: null });
	await first.session.sendCustomMessage(
		{ customType: "note", content: "pending", display: true },
		{ deliverAs: "nextTurn" },
	);
	await first.ingress.dispose();
	const next = await fixture(t, {
		root: first.root,
		manager: SessionManager.open(first.session.sessionManager.getSessionFile()),
		admit: null,
	});
	assert.equal(next.ingress.branch().sourceRecovery.unresolved, 1);
	await next.session.prompt("held");
	assert.equal(next.sent.length, 0);
});

test("next-turn observation failure prevents Pi from retaining the message", async (t) => {
	const f = await fixture(t, {
		admit: null,
		nextTurnObserver: async () => {
			throw new Error("observation failed");
		},
	});
	await assert.rejects(
		f.session.sendCustomMessage({ customType: "note", content: "rejected", display: true }, { deliverAs: "nextTurn" }),
		/observation failed/,
	);
	await f.session.prompt("later");
	assert.equal(f.sent.length, 1);
	assert.ok(!JSON.stringify(f.sent).includes("rejected"));
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	assert.equal(record.dispatch.phase, "failed");
	assert.equal(record.dispatch.promptClaims, undefined);
});

test("mutated next-turn context cannot acquire another submission's history receipt", async (t) => {
	let message;
	const f = await fixture(t, {
		admit: null,
		nextTurnObserver: async (value) => {
			message = value;
		},
	});
	await f.session.sendCustomMessage(
		{ customType: "note", content: "original", display: true },
		{ deliverAs: "nextTurn" },
	);
	message.content = "changed";
	await assert.rejects(f.session.prompt("consume"), /Deferred context changed/);
	assert.equal(f.sent.length, 0);
	const records = await f.ingress.branch().attachment.submissions.snapshot();
	assert.ok(records.every((record) => !record.dispatch.promptClaims && !record.dispatch.promptHistory));
});

test("prompt-array mutation during observation cannot swap identical deferred source identities", async (t) => {
	const f = await fixture(t, { admit: null });
	for (let i = 0; i < 2; i++)
		await f.session.sendCustomMessage(
			{ customType: "note", content: "same", display: true },
			{ deliverAs: "nextTurn" },
		);
	const store = f.ingress.branch().attachment.submissions;
	const records = await store.snapshot();
	const prompt = f.session.agent.prompt.bind(f.session.agent);
	let batch;
	t.mock.method(f.session.agent, "prompt", (input, ...args) => {
		batch = input;
		return prompt(input, ...args);
	});
	const dispatch = store.dispatch.bind(store);
	t.mock.method(store, "dispatch", (id, revision, operation, run) =>
		dispatch(id, revision, operation, (observer, submission) =>
			run(
				{
					observe: async (input) => {
						const index = await observer.observe(input);
						if (input.kind === "prompt") [batch[1], batch[2]] = [batch[2], batch[1]];
						return index;
					},
				},
				submission,
			),
		),
	);
	await f.session.prompt("consume");
	assert.equal(f.sent.length, 1);
	const sources = await f.ingress.branch().native.sources(f.session.agent.state.messages);
	assert.deepEqual(
		sources.slice(1).map((source) => source.operationId),
		records.map((record) => record.dispatch.operationId),
	);
});

test("next-turn cancellation removes only the selected duplicate and preserves the other source", async (t) => {
	const f = await fixture(t, { admit: null });
	for (let i = 0; i < 2; i++)
		await f.session.sendCustomMessage(
			{ customType: "note", content: "same", display: true },
			{ deliverAs: "nextTurn" },
		);
	const records = await f.ingress.branch().attachment.submissions.snapshot();
	await assert.rejects(f.ingress.cancelNativeContext(records[0].id, 2, 0), { code: "stale" });
	await assert.rejects(f.ingress.cancelNativeContext(records[0].id, 1, 1), { code: "stale" });
	await f.ingress.cancelNativeContext(records[0].id, 1, 0);
	await f.ingress.cancelNativeContext(records[0].id, 1, 0);
	const view = (await f.ingress.inspect()).submissions[0];
	assert.equal(view.admission, "cancelled");
	assert.equal(view.delivery, "none");
	assert.deepEqual(view.nativeContextCancellations, [{ inputIndex: 0, removal: "confirmed" }]);
	assert.equal(f.sent.length, 0);
	await f.session.prompt("consume survivor");
	assert.equal(f.sent.length, 1);
	const sources = await f.ingress.branch().native.sources(f.session.agent.state.messages);
	assert.equal(sources.filter((source) => source.operationId === records[0].dispatch.operationId).length, 0);
	assert.equal(sources.filter((source) => source.operationId === records[1].dispatch.operationId).length, 1);
	await assert.rejects(f.ingress.cancelNativeContext(records[1].id, 1, 0), { code: "transition" });
});

test("confirmed next-turn cancellation survives reopen without a source-recovery hold", async (t) => {
	const first = await fixture(t, { admit: null });
	await first.session.sendCustomMessage(
		{ customType: "note", content: "cancel me", display: true },
		{ deliverAs: "nextTurn" },
	);
	const [record] = await first.ingress.branch().attachment.submissions.snapshot();
	await first.ingress.cancelNativeContext(record.id, 1, 0);
	await first.ingress.dispose();
	const next = await fixture(t, {
		root: first.root,
		manager: SessionManager.open(first.session.sessionManager.getSessionFile()),
		admit: null,
	});
	assert.deepEqual(next.ingress.branch().sourceRecovery, { recovered: 0, unresolved: 0 });
	await next.ingress.cancelNativeContext(record.id, 1, 0);
	assert.equal((await next.ingress.inspect()).submissions[0].admission, "cancelled");
	await next.session.prompt("continue");
	assert.equal(next.sent.length, 1);
	assert.ok(!JSON.stringify(next.sent).includes("cancel me"));
});

test("failed cancellation-intent write preserves next-turn delivery", async (t) => {
	const f = await fixture(t, { admit: null });
	await f.session.sendCustomMessage(
		{ customType: "note", content: "preserved", display: true },
		{ deliverAs: "nextTurn" },
	);
	const store = f.ingress.branch().attachment.submissions;
	const [record] = await store.snapshot();
	t.mock.method(store, "cancelContext", async () => {
		throw new Error("intent failed");
	});
	await assert.rejects(f.ingress.cancelNativeContext(record.id, 1, 0), /intent failed/);
	await f.session.prompt("consume");
	assert.equal(f.sent.length, 1);
	assert.ok(JSON.stringify(f.sent).includes("preserved"));
	assert.equal((await store.snapshot())[0].dispatch.contextCancellations, undefined);
});

test("live cancellation retries confirmation after successful native removal", async (t) => {
	const f = await fixture(t, { admit: null });
	await f.session.sendCustomMessage(
		{ customType: "note", content: "removed on first attempt", display: true },
		{ deliverAs: "nextTurn" },
	);
	const store = f.ingress.branch().attachment.submissions;
	const [record] = await store.snapshot();
	const confirmation = t.mock.method(store, "confirmContextCancellation", async () => {
		throw new Error("confirmation failed");
	});
	await assert.rejects(f.ingress.cancelNativeContext(record.id, 1, 0), /confirmation failed/);
	assert.deepEqual((await f.ingress.inspect()).submissions[0].nativeContextCancellations, [
		{ inputIndex: 0, removal: "unconfirmed" },
	]);
	confirmation.mock.restore();
	await f.ingress.cancelNativeContext(record.id, 1, 0);
	await f.ingress.cancelNativeContext(record.id, 1, 0);
	assert.equal((await f.ingress.inspect()).submissions[0].admission, "cancelled");
	assert.deepEqual((await f.ingress.inspect()).submissions[0].nativeContextCancellations, [
		{ inputIndex: 0, removal: "confirmed" },
	]);
	assert.equal(f.sent.length, 0);
	await f.session.prompt("continue after cancellation");
	assert.equal(f.sent.length, 1);
	assert.ok(!JSON.stringify(f.sent).includes("removed on first attempt"));
});

test("failed removal confirmation remains unresolved after restart", async (t) => {
	const first = await fixture(t, { admit: null });
	await first.session.sendCustomMessage(
		{ customType: "note", content: "removed", display: true },
		{ deliverAs: "nextTurn" },
	);
	const store = first.ingress.branch().attachment.submissions;
	const [record] = await store.snapshot();
	t.mock.method(store, "confirmContextCancellation", async () => {
		throw new Error("confirmation failed");
	});
	await assert.rejects(first.ingress.cancelNativeContext(record.id, 1, 0), /confirmation failed/);
	const view = (await first.ingress.inspect()).submissions[0];
	assert.equal(view.admission, "held");
	assert.deepEqual(view.nativeContextCancellations, [{ inputIndex: 0, removal: "unconfirmed" }]);
	assert.match(view.reason, /removal reconciliation/);
	await assert.rejects(
		store.recordPromptClaim(record.dispatch.operationId, { inputIndex: 0, messageIndex: 0 }),
		/retained cancellation/,
	);
	await first.ingress.dispose();
	const next = await fixture(t, {
		root: first.root,
		manager: SessionManager.open(first.session.sessionManager.getSessionFile()),
		admit: null,
	});
	assert.equal(next.ingress.branch().sourceRecovery.unresolved, 1);
	await assert.rejects(next.ingress.cancelNativeContext(record.id, 1, 0), /matching live input/);
	await next.session.prompt("held for reconciliation");
	assert.equal(next.sent.length, 0);
});

test("absent live next-turn input cannot be reported as confirmed removal", async (t) => {
	let remove;
	const f = await fixture(t, {
		admit: null,
		nextTurnObserver: async (_message, cancel) => {
			remove = cancel;
		},
	});
	await f.session.sendCustomMessage(
		{ customType: "note", content: "missing", display: true },
		{ deliverAs: "nextTurn" },
	);
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	assert.equal(remove(), true);
	await assert.rejects(f.ingress.cancelNativeContext(record.id, 1, 0), /removal reconciliation/);
	assert.deepEqual((await f.ingress.inspect()).submissions[0].nativeContextCancellations, [
		{ inputIndex: 0, removal: "unconfirmed" },
	]);
});

test("next-turn cancellation holds the host boundary through its intent write", async (t) => {
	const f = await fixture(t, { admit: null });
	await f.session.sendCustomMessage(
		{ customType: "note", content: "cancel before prompt", display: true },
		{ deliverAs: "nextTurn" },
	);
	const store = f.ingress.branch().attachment.submissions;
	const [record] = await store.snapshot();
	const entered = deferred(),
		release = deferred();
	t.after(() => release.resolve());
	const cancel = store.cancelContext.bind(store);
	t.mock.method(store, "cancelContext", async (...args) => {
		entered.resolve();
		await release.promise;
		return cancel(...args);
	});
	const cancelling = f.ingress.cancelNativeContext(record.id, 1, 0);
	await entered.promise;
	let started = false;
	const prompt = f.session.prompt("racing prompt").then(() => {
		started = true;
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(started, false);
	assert.equal(f.sent.length, 0);
	release.resolve();
	await Promise.all([cancelling, prompt]);
	assert.equal(f.sent.length, 1);
	assert.ok(!JSON.stringify(f.sent).includes("cancel before prompt"));
});

test("context cancellation requires a retained next-turn position and prior removal intent", async (t) => {
	const f = await fixture(t, { admit: null });
	await f.session.sendCustomMessage(
		{ customType: "note", content: "pending", display: true },
		{ deliverAs: "nextTurn" },
	);
	const store = f.ingress.branch().attachment.submissions;
	const [record] = await store.snapshot();
	const operation = record.dispatch.operationId;
	await assert.rejects(store.confirmContextCancellation(operation, 0), /no retained intent/);
	for (const index of [-1, 1, 0.5, NaN])
		await assert.rejects(store.cancelContext(operation, index), { code: "identity" });
	assert.equal((await store.snapshot())[0].dispatch.contextCancellations, undefined);
	await f.ingress.cancelNativeContext(record.id, 1, 0);
	await store.cancelContext(operation, 0);
	assert.deepEqual((await store.snapshot())[0].dispatch.contextCancellations, [{ inputIndex: 0, removed: true }]);
	await assert.rejects(store.recordPromptClaim(operation, { inputIndex: 0, messageIndex: 0 }), /retained cancellation/);
	await f.session.sendCustomMessage({ customType: "note", content: "appended", display: true }, { triggerTurn: false });
	const last = (await store.snapshot()).at(-1);
	await assert.rejects(store.cancelContext(last.dispatch.operationId, 0), /Consumed context/);
});

test("release passes coalesce and prioritize retained user input", async (t) => {
	let allowed = false;
	const entered = deferred(),
		proceed = deferred();
	let holdRelease = false;
	const f = await fixture(t, {
		admit: async () => {
			if (holdRelease) {
				entered.resolve();
				await proceed.promise;
			}
			return allowed;
		},
	});
	await f.session.sendUserMessage("automated input");
	await f.session.prompt("user input");
	const records = await f.ingress.branch().attachment.submissions.snapshot();
	allowed = true;
	holdRelease = true;
	const first = f.ingress.releaseReady();
	await entered.promise;
	const second = f.ingress.releaseReady();
	assert.equal(first, second);
	proceed.resolve();
	const result = await first;
	assert.deepEqual(result, { released: [records[1].id], held: [records[0].id] });
	assert.equal(f.sent.length, 1);
	assert.ok(JSON.stringify(f.sent[0]).includes("user input"));
	assert.ok(!JSON.stringify(f.sent[0]).includes("automated input"));
	assert.deepEqual(await f.ingress.releaseReady(), { released: [records[0].id], held: [] });
	assert.equal(f.sent.length, 2);
	assert.deepEqual(await f.ingress.releaseReady(), { released: [], held: [] });
});

test("release pass retains denied callbacks and rejects reentrant scheduling", async (t) => {
	let allow = false;
	let ingress;
	const f = await fixture(t, {
		admit: async () => {
			if (ingress) await assert.rejects(ingress.releaseReady(), { code: "busy" });
			return allow;
		},
	});
	ingress = f.ingress;
	await f.session.prompt("retained");
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	assert.deepEqual(await ingress.releaseReady(), { released: [], held: [record.id] });
	assert.equal(f.sent.length, 0);
	allow = true;
	assert.deepEqual(await ingress.releaseReady(), { released: [record.id], held: [] });
	assert.equal(f.sent.length, 1);
});

test("release pass skips cancelled members and defers new retained arrivals", async (t) => {
	let ready = false;
	const entered = deferred(),
		proceed = deferred();
	const f = await fixture(t, {
		admit: async (submission) => {
			if (!ready || submission.args[0] === "new arrival") return false;
			if (submission.args[0] === "first") {
				entered.resolve();
				await proceed.promise;
			}
			return true;
		},
	});
	await f.session.prompt("first");
	await f.session.prompt("cancel before release");
	const records = await f.ingress.branch().attachment.submissions.snapshot();
	ready = true;
	const pass = f.ingress.releaseReady();
	await entered.promise;
	await f.ingress.cancelRetained(records[1].id, 1);
	await f.session.prompt("new arrival");
	proceed.resolve();
	assert.deepEqual(await pass, { released: [records[0].id], held: [] });
	assert.equal(f.sent.length, 1);
	const latest = (await f.ingress.branch().attachment.submissions.snapshot()).at(-1);
	assert.deepEqual(await f.ingress.releaseReady(), { released: [], held: [latest.id] });
});

test("disposal fences a release pass before dispatch and drains it", async (t) => {
	let ready = false;
	const entered = deferred(),
		proceed = deferred();
	const f = await fixture(t, {
		admit: async () => {
			if (!ready) return false;
			entered.resolve();
			await proceed.promise;
			return true;
		},
	});
	await f.session.prompt("never dispatch");
	ready = true;
	const pass = f.ingress.releaseReady();
	await entered.promise;
	const rejected = assert.rejects(pass, { code: "stale" });
	const closing = f.ingress.dispose();
	proceed.resolve();
	await Promise.all([closing, rejected]);
	assert.equal(f.sent.length, 0);
	assert.throws(() => f.ingress.releaseReady(), { code: "stale" });
});

test("automatic release resumes held inputs after a host operation drains", async (t) => {
	let ready = false;
	const delivered = deferred();
	const failures = [];
	const f = await fixture(t, {
		autoRelease: { onError: (error) => failures.push(error) },
		admit: async (submission) => {
			if (ready && submission.args[0] === "held second") delivered.resolve();
			return ready;
		},
	});
	await f.session.prompt("held first");
	await f.session.prompt("held second");
	ready = true;
	await f.session.sendCustomMessage(
		{ customType: "signal", content: "context", display: true },
		{ triggerTurn: false },
	);
	await delivered.promise;
	// Join the running release, including native execution and receipts.
	await f.ingress.releaseReady();
	assert.equal(f.sent.length, 2);
	assert.deepEqual(failures, []);
});

test("policy notification releases held input and disposal cancels scheduled notifications", async (t) => {
	let ready = false;
	const admitted = deferred();
	const failures = [];
	const f = await fixture(t, {
		autoRelease: { onError: (error) => failures.push(error) },
		admit: async () => {
			if (ready) admitted.resolve();
			return ready;
		},
	});
	await f.session.prompt("held");
	ready = true;
	f.ingress.requestRelease();
	await admitted.promise;
	await f.ingress.releaseReady();
	assert.equal(f.sent.length, 1);
	ready = false;
	await f.session.prompt("discard live callback on close");
	ready = true;
	f.ingress.requestRelease();
	await f.ingress.dispose();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.sent.length, 1);
	assert.deepEqual(failures, []);
});

test("automatic release reports admission failure without dispatching or spinning", async (t) => {
	let fail = false;
	const reported = deferred();
	let reports = 0;
	const f = await fixture(t, {
		autoRelease: {
			onError: (error) => {
				reports++;
				reported.resolve(error);
			},
		},
		admit: async () => {
			if (fail) throw new Error("policy unavailable");
			return false;
		},
	});
	await f.session.prompt("held after failed policy");
	fail = true;
	f.ingress.requestRelease();
	assert.match((await reported.promise).message, /policy unavailable/);
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(reports, 1);
	assert.equal(f.sent.length, 0);
	assert.equal((await f.ingress.heldInputs()).length, 1);
});

test("automatic release reports synchronous lifecycle failure", async (t) => {
	const reported = deferred();
	const f = await fixture(t, { autoRelease: { onError: (error) => reported.resolve(error) } });
	t.mock.method(f.ingress, "releaseReady", () => {
		throw new Error("attachment changed");
	});
	f.ingress.requestRelease();
	assert.match((await reported.promise).message, /attachment changed/);
	assert.equal(f.sent.length, 0);
});

for (const manual of [false, true])
	test(`policy changes during ${manual ? "manual" : "automatic"} release retain another scheduling pass`, async (t) => {
		let phase = "initial";
		const entered = deferred(),
			proceed = deferred(),
			admitted = deferred();
		const failures = [];
		const f = await fixture(t, {
			autoRelease: { onError: (error) => failures.push(error) },
			admit: async () => {
				const captured = phase;
				if (captured === "checking") {
					entered.resolve();
					await proceed.promise;
				}
				if (captured === "ready") admitted.resolve();
				return captured === "ready";
			},
		});
		await f.session.prompt("retained until changed policy is checked");
		phase = "checking";
		const running = manual ? f.ingress.releaseReady() : undefined;
		if (!manual) f.ingress.requestRelease();
		await entered.promise;
		phase = "ready";
		for (let i = 0; i < 10; i++) f.ingress.requestRelease();
		// Let notification processing observe the still-running admission.
		await new Promise((resolve) => setImmediate(resolve));
		proceed.resolve();
		await running;
		await admitted.promise;
		await f.ingress.releaseReady();
		assert.equal(f.sent.length, 1);
		assert.deepEqual(failures, []);
	});

test("retained user input blocks semantic producer selection until cancellation", async (t) => {
	const f = await fixture(t, { admit: async () => false });
	await f.session.prompt("user must go first");
	const branch = f.ingress.branch();
	assert.equal(branch.host.gate().userPending, true);
	let builds = 0;
	branch.controller.register({
		version: 1,
		namespace: "priority-test",
		snapshot: async () => [
			{
				id: "work",
				revision: "1",
				producer: "priority-test",
				sequence: 1,
				rank: 4,
				workId: "work",
				workRevision: "1",
				independent: true,
				runnable: true,
			},
		],
		build: async () => {
			builds++;
			throw new Error("must not build before user");
		},
	});
	await branch.controller.wake();
	assert.equal(builds, 0);
	assert.equal(f.sent.length, 0);
	const [record] = await branch.attachment.submissions.snapshot();
	await f.ingress.cancelRetained(record.id, 1);
	assert.equal(branch.host.gate().userPending, false);
});

test("user priority covers retention writes and failed admission remains retained", async (t) => {
	const f = await fixture(t, {
		admit: async () => {
			throw new Error("admission failed");
		},
	});
	const branch = f.ingress.branch();
	const entered = deferred(),
		proceed = deferred();
	const store = branch.attachment.submissions;
	const retain = store.retain.bind(store);
	t.mock.method(store, "retain", async (...args) => {
		entered.resolve();
		await proceed.promise;
		return retain(...args);
	});
	const submitting = f.session.prompt("retain before producer work");
	const rejected = assert.rejects(submitting, /admission failed/);
	await entered.promise;
	assert.equal(branch.host.gate().userPending, true);
	proceed.resolve();
	await rejected;
	assert.equal(branch.host.gate().userPending, true);
	const [record] = await store.snapshot();
	await f.ingress.cancelRetained(record.id, 1);
	assert.equal(branch.host.gate().userPending, false);
	assert.equal(f.sent.length, 0);
});

test("retained user priority survives reopening without recreating its callback", async (t) => {
	const first = await fixture(t, { admit: async () => false });
	await first.session.prompt("retained across reopen");
	const [record] = await first.ingress.branch().attachment.submissions.snapshot();
	await first.ingress.dispose();
	const next = await fixture(t, {
		root: first.root,
		manager: SessionManager.open(first.session.sessionManager.getSessionFile()),
	});
	assert.equal(next.ingress.branch().host.gate().userPending, true);
	await next.ingress.cancelRetained(record.id, 1);
	assert.equal(next.ingress.branch().host.gate().userPending, false);
	assert.equal(next.sent.length, 0);
});

test("consumed user queue no longer blocks semantic work after automated dispatch settles", async (t) => {
	const f = await fixture(t);
	await f.session.followUp("queued user instruction");
	assert.equal(f.ingress.branch().host.gate().userPending, true);
	await f.session.sendUserMessage("start native consumption");
	assert.equal(f.ingress.branch().host.gate().userPending, false);
	assert.ok(f.sent.length > 0);
});

test("duplicate consumed submission does not recreate a pending user gate", async (t) => {
	const f = await fixture(t);
	await f.session.prompt("consumed once");
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	await f.ingress.submit(record.submission, async () => {
		assert.fail("duplicate dispatch");
	});
	assert.equal(f.ingress.branch().host.gate().userPending, false);
	assert.equal(f.sent.length, 1);
});

test("native user queue cancellation clears retained semantic priority", async (t) => {
	const f = await fixture(t);
	await f.session.followUp("cancel queued user");
	assert.equal(f.ingress.branch().host.gate().userPending, true);
	const [queued] = f.session.agent.inspectQueuedMessages();
	await f.ingress.cancelNativeQueue(queued.id, queued.revision);
	assert.equal(f.ingress.branch().host.gate().userPending, false);
	assert.equal(f.sent.length, 0);
});

for (const stage of ["enqueued", "eligibility"])
	test(`user arriving during semantic ${stage} preempts native consumption`, async (t) => {
		const f = await fixture(t, { admit: async () => false });
		const branch = f.ingress.branch();
		const queued = deferred(),
			proceed = deferred();
		let consuming = false;
		const run = branch.host.run.bind(branch.host);
		t.mock.method(branch.host, "run", async () => {
			if (stage === "enqueued") {
				queued.resolve();
				await proceed.promise;
			}
			consuming = true;
			await run();
		});
		branch.controller.register({
			version: 1,
			namespace: "preemption-test",
			snapshot: async () => {
				if (stage === "eligibility" && consuming) {
					queued.resolve();
					await proceed.promise;
				}
				return [
					{
						id: "work",
						revision: "1",
						producer: "preemption-test",
						sequence: 1,
						rank: 4,
						workId: "work",
						workRevision: "1",
						independent: true,
						runnable: true,
					},
				];
			},
			build: async () => ({ id: "work", revision: "1", kind: "work", text: "automated work" }),
		});
		const waking = branch.controller.wake();
		await queued.promise;
		assert.equal(f.session.agent.inspectQueuedMessages().length, 1);
		await f.session.prompt("user arrives before consumption");
		assert.equal(branch.host.gate().userPending, true);
		proceed.resolve();
		await waking;
		assert.equal(f.sent.length, 0);
		assert.equal(f.session.agent.inspectQueuedMessages().length, 0);
		const state = await branch.attachment.ledger.snapshot();
		assert.equal(state.attempts.length, 1);
		assert.equal(state.attempts[0].phase, "cancelled");
		assert.equal(state.attempts[0].consumed, false);
		assert.equal(state.attempts[0].requests.length, 0);
		const [user] = await branch.attachment.submissions.snapshot();
		assert.equal(user.dispatch, undefined);
	});

test("semantic producer request completes through installed ingress and provider conversion", async (t) => {
	const f = await fixture(t, { provider: true, admit: null });
	const branch = f.ingress.branch();
	const producer = {
		version: 1,
		namespace: "provider-test",
		snapshot: async () => [
			{
				id: "work",
				revision: "1",
				producer: "provider-test",
				sequence: 1,
				rank: 4,
				workId: "work",
				workRevision: "1",
				independent: true,
				runnable: true,
			},
		],
		build: async () => ({ id: "work", revision: "1", kind: "work", text: "complete semantic work" }),
	};
	branch.controller.register(producer);
	await branch.controller.wake();
	assert.equal(f.sent.length, 1);
	const state = await branch.attachment.ledger.snapshot();
	assert.equal(state.attempts.length, 1);
	assert.equal(state.attempts[0].phase, "settled");
	assert.equal(state.attempts[0].outcome, "success");
	assert.equal(state.attempts[0].requests[0].outcome, "success");
	const requests = await branch.attachment.nativeRequests.snapshot();
	assert.equal(requests.length, 1);
	assert.equal(requests[0].outcome, "success");
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
	const recovered = await next.ingress.branch().attachment.ledger.snapshot();
	assert.equal(recovered.attempts.length, 1);
	assert.equal(recovered.attempts[0].outcome, "success");
});

test("ingress producer scheduling releases retained user work before semantic work", async (t) => {
	let allow = false;
	const f = await fixture(t, { provider: true, admit: async () => allow });
	await f.session.prompt("retained user first");
	const handle = f.ingress.registerProducer({
		version: 1,
		namespace: "owned-producer",
		snapshot: async () => [
			{
				id: "work",
				revision: "1",
				producer: "owned-producer",
				sequence: 1,
				rank: 4,
				workId: "work",
				workRevision: "1",
				independent: true,
				runnable: true,
			},
		],
		build: async () => ({ id: "work", revision: "1", kind: "work", text: "semantic follows user" }),
	});
	await handle.changed();
	assert.equal(f.sent.length, 0);
	allow = true;
	await Promise.all([handle.changed(), handle.changed()]);
	assert.equal(f.sent.length, 2);
	assert.ok(JSON.stringify(f.sent[0]).includes("retained user first"));
	assert.ok(!JSON.stringify(f.sent[0]).includes("semantic follows user"));
	assert.ok(JSON.stringify(f.sent[1]).includes("semantic follows user"));
	handle.dispose();
	await assert.rejects(handle.changed(), { code: "stale" });
});

test("ingress disposal drains producer scheduling before closing its branch", async (t) => {
	let release = false;
	const entered = deferred(),
		proceed = deferred();
	const f = await fixture(t, {
		provider: true,
		admit: async () => {
			if (!release) return false;
			entered.resolve();
			await proceed.promise;
			return true;
		},
	});
	await f.session.prompt("pending user");
	let builds = 0;
	const handle = f.ingress.registerProducer({
		version: 1,
		namespace: "closing-producer",
		snapshot: async () => [],
		build: async () => {
			builds++;
			throw new Error("unexpected build");
		},
	});
	release = true;
	const changed = handle.changed();
	await entered.promise;
	const rejected = assert.rejects(changed, { code: "stale" });
	const closing = f.ingress.dispose();
	proceed.resolve();
	await Promise.all([closing, rejected]);
	assert.equal(builds, 0);
	assert.equal(f.sent.length, 0);
	assert.throws(() => f.ingress.wakeProducers(), { code: "stale" });
});

for (const trigger of ["policy", "operation"])
	test(`semantic work resumes on ${trigger} notification without empty wake loops`, async (t) => {
		let waiting = true;
		let snapshots = 0;
		const built = deferred();
		const failures = [];
		const f = await fixture(t, {
			provider: true,
			admit: null,
			autoRelease: { onError: (error) => failures.push(error) },
			policy: () => ({ userPending: false, recoveryBlocked: false, waitingWorkIds: waiting ? ["work"] : [] }),
		});
		const handle = f.ingress.registerProducer({
			version: 1,
			namespace: "idle-producer",
			snapshot: async () => {
				snapshots++;
				return [
					{
						id: "work",
						revision: "1",
						producer: "idle-producer",
						sequence: 1,
						rank: 4,
						workId: "work",
						workRevision: "1",
						independent: false,
						runnable: true,
					},
				];
			},
			build: async () => {
				built.resolve();
				return { id: "work", revision: "1", kind: "work", text: "resumed semantic work" };
			},
		});
		await handle.changed();
		assert.equal(f.sent.length, 0);
		waiting = false;
		if (trigger === "policy") f.ingress.requestRelease();
		else
			await f.session.sendCustomMessage(
				{ customType: "note", content: "host operation", display: true },
				{ triggerTurn: false },
			);
		await built.promise;
		await f.ingress.wakeProducers();
		assert.equal(f.sent.length, 1);
		// Wait for deferred owner notifications and their durable reads to settle.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const settled = snapshots;
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(snapshots, settled);
		assert.deepEqual(failures, []);
	});

async function declareIngressWait(branch, workId = "work") {
	const handle = { producer: "bg", handle: "job", execution: "exec", until: "exit" };
	return branch.attachment.waits.declare(
		{ token: "wait", scope: branch.scope, workId, reason: "dependency", mode: "all", on: [handle], expiresAt: 100 },
		[{ ...handle, scope: branch.scope, workId, state: "pending" }],
		0,
		100,
	);
}

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

function ingressWaitClock(now = 0) {
	const timers = new Set();
	return {
		timers,
		now: () => now,
		after(delay, callback) {
			const timer = { at: now + delay, callback };
			timers.add(timer);
			return () => timers.delete(timer);
		},
		advance(next) {
			now = next;
			for (const timer of [...timers])
				if (timer.at <= now) {
					timers.delete(timer);
					timer.callback();
				}
		},
	};
}
async function waitForFlow(predicate) {
	for (let i = 0; i < 200; i++) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail("automatic flow scheduling did not settle");
}

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

function lifecycleProducer(
	build = async (item) => ({ id: item.id, revision: item.revision, kind: "work", text: "owned continuation" }),
) {
	return {
		version: 1,
		namespace: "lane",
		build,
		snapshot: async () => [
			{
				id: "work",
				revision: "1",
				producer: "lane",
				sequence: 1,
				rank: 5,
				workId: "work",
				workRevision: "1",
				independent: true,
				runnable: true,
			},
		],
	};
}

for (const boundary of ["build", "claim"]) {
	test(`work stop during ${boundary} prevents native provider dispatch and repeated producer replay`, {
		timeout: 10000,
	}, async (t) => {
		const entered = deferred(),
			proceed = deferred();
		const f = await fixture(t, {
			provider: true,
			checkpoints:
				boundary === "claim"
					? {
							beforeQueueClaim: async () => {
								entered.resolve();
								await proceed.promise;
								return true;
							},
						}
					: undefined,
		});
		const waits = f.ingress.branch().attachment.waits;
		await waits.registerWork("work", "lane", 0);
		const registration = f.ingress.registerProducer(
			lifecycleProducer(async (item) => {
				if (boundary === "build") {
					entered.resolve();
					await proceed.promise;
				}
				return { id: item.id, revision: item.revision, kind: "work", text: "owned continuation" };
			}),
		);
		const running = registration.changed();
		await entered.promise;
		await f.ingress.changeWork("work", "lane", 1, "stopped", "user stop");
		proceed.resolve();
		await running;
		assert.equal(f.sent.length, 0);
		await registration.changed();
		assert.equal(f.sent.length, 0);
		const attempts = (await f.ingress.branch().attachment.ledger.snapshot()).attempts;
		assert.ok(attempts.every((attempt) => attempt.phase === "cancelled" && attempt.consumed === false));
		await assert.rejects(f.ingress.changeWork("work", "lane", 2, "active", "replay"), { code: "transition" });
		const retired = (await waits.authoritySnapshot()).work;
		await waits.retire({ work: retired, waits: [], executions: [] });
		await registration.changed();
		assert.equal(f.sent.length, 0);
		await assert.rejects(waits.registerWork("work", "lane", Date.now()), { code: "stale" });
		const manager = SessionManager.open(f.session.sessionManager.getSessionFile());
		await f.ingress.dispose();
		const reopened = await fixture(t, { root: f.root, provider: true, manager });
		await reopened.ingress.registerProducer(lifecycleProducer()).changed();
		assert.equal(reopened.sent.length, 0);
	});
}

test("work pause survives restart and explicit resume schedules the retained continuation", {
	timeout: 10000,
}, async (t) => {
	const f = await fixture(t, { provider: true });
	await f.ingress.branch().attachment.waits.registerWork("work", "lane", 0);
	await f.ingress.changeWork("work", "lane", 1, "paused", "user pause");
	await f.ingress.registerProducer(lifecycleProducer()).changed();
	assert.equal(f.sent.length, 0);
	const manager = SessionManager.open(f.session.sessionManager.getSessionFile());
	await f.ingress.dispose();
	const errors = [],
		built = deferred();
	const reopened = await fixture(t, {
		root: f.root,
		provider: true,
		manager,
		autoRelease: { onError: (error) => errors.push(error) },
	});
	const registration = reopened.ingress.registerProducer(
		lifecycleProducer(async (item) => {
			built.resolve();
			return { id: item.id, revision: item.revision, kind: "work", text: "resumed continuation" };
		}),
	);
	await registration.changed();
	assert.equal(reopened.sent.length, 0);
	await reopened.ingress.changeWork("work", "lane", 2, "active", "user resume");
	await built.promise;
	await reopened.ingress.wakeProducers();
	assert.equal(reopened.sent.length, 1);
	assert.ok(JSON.stringify(reopened.sent).includes("resumed continuation"));
	await registration.changed();
	assert.equal(reopened.sent.length, 1);
	assert.deepEqual(errors, []);
});

for (const replay of [false, true]) {
	test(`producer subscription synchronization gates semantic dispatch until snapshot is committed: ${replay ? "replay" : "new"}`, {
		timeout: 10000,
	}, async (t) => {
		const errors = [],
			entered = deferred(),
			proceed = deferred(),
			built = deferred();
		const f = await fixture(t, { provider: true, autoRelease: { onError: (error) => errors.push(error) } });
		const branch = f.ingress.branch();
		await branch.attachment.waits.registerWork("work", "lane", 0);
		if (replay)
			await branch.attachment.waits.registerExecution(
				{
					producer: "lane",
					workId: "work",
					handle: "job",
					execution: "execution",
					revision: 1,
					predicates: [{ until: "exit", state: "pending" }],
				},
				1,
				0,
			);
		const source = branch.attachment.waitProducers.register(
			{
				version: 1,
				namespace: "lane",
				subscribe: () => () => {},
				async snapshot(identity) {
					entered.resolve();
					await proceed.promise;
					return { ...identity, revision: 1, predicates: [{ until: "exit", state: "pending" }] };
				},
			},
			(error) => errors.push(error),
		);
		const binding = source.bind({ workId: "work", handle: "job", execution: "execution" }, 1);
		await entered.promise;
		let builds = 0;
		const registration = f.ingress.registerProducer(
			lifecycleProducer(async (item) => {
				builds++;
				built.resolve();
				return { id: item.id, revision: item.revision, kind: "work", text: "after subscription" };
			}),
		);
		await registration.changed();
		assert.equal(builds, 0);
		assert.equal(f.sent.length, 0);
		proceed.resolve();
		await binding;
		await built.promise;
		await f.ingress.wakeProducers();
		assert.equal(f.sent.length, 1);
		assert.deepEqual(errors, []);
	});
}

test("missing retained producer prevents native user dispatch after reopening", async (t) => {
	const first = await fixture(t, { provider: true });
	const waits = first.ingress.branch().attachment.waits;
	await waits.registerWork("work", "lane", 0);
	await waits.shareWork("work", "lane", 1, "bg", 0);
	await waits.registerExecution(
		{
			producer: "bg",
			workId: "work",
			handle: "bg-1",
			execution: "exec",
			revision: 1,
			predicates: [{ until: "exit", state: "pending" }],
		},
		2,
		0,
	);
	await first.ingress.dispose();
	const reopened = await fixture(t, {
		root: first.root,
		manager: SessionManager.open(first.session.sessionManager.getSessionFile()),
		provider: true,
	});
	await reopened.session.prompt("status");
	assert.deepEqual(reopened.ingress.branch().waitSourceRecovery, { restored: 0, missing: ["bg"] });
	assert.equal((await reopened.ingress.heldInputs()).length, 1);
	assert.deepEqual(reopened.sent, []);
});

test("idle user prompts bind distinct durable work identities across equal text and reopening", async (t) => {
	const seen = [];
	let authority;
	const f = await fixture(t, {
		provider: true,
		onRequest() {
			const context = f.ingress.branch().workContext;
			const work = context.current();
			seen.push(work);
			authority = context.authorize(work.id);
		},
	});
	await f.session.prompt("same instruction");
	assert.throws(() => authority.assertActive(), { code: "stale" });
	const firstAttachment = f.ingress.branch().attachment;
	await firstAttachment.waits.shareWork(seen[0].id, "host-user", 1, "bg", Date.now());
	await firstAttachment.waits.registerExecution(
		{
			producer: "bg",
			handle: "bg-original",
			execution: "original-execution",
			workId: seen[0].id,
			revision: 1,
			predicates: [{ until: "exit", state: "pending" }],
		},
		2,
		Date.now(),
	);
	await f.session.prompt("same instruction");
	assert.equal(seen.length, 2);
	assert.notEqual(seen[0].id, seen[1].id);
	const branch = f.ingress.branch();
	const records = await branch.attachment.submissions.snapshot();
	const work = await retainUserWork(branch.attachment, records[0].id, records[0].revision);
	assert.equal(work.id, seen[0].id);
	assert.equal((await branch.attachment.waits.authoritySnapshot()).work.length, 2);
	await f.ingress.dispose();
	const next = await fixture(t, {
		root: f.root,
		provider: true,
		manager: SessionManager.open(f.session.sessionManager.getSessionFile()),
	});
	assert.deepEqual(await retainUserWork(next.ingress.branch().attachment, records[0].id, records[0].revision), work);
	assert.equal(next.sent.length, 0);
	assert.equal((await next.ingress.branch().attachment.waits.authoritySnapshot()).executions[0].workId, seen[0].id);
});

test("user-work participants reject invalid configuration before attachment", () => {
	for (const userWorkParticipants of [
		null,
		"bg",
		["bg", "bg"],
		["Bad"],
		[1],
		new Array(1),
		Array.from({ length: 64 }, (_, i) => `p${i}`),
	])
		assert.throws(() => new PiSessionFlowIngress({ userWorkParticipants }), { code: "schema" });
});

test("user-work producer grants capture host configuration and remain idempotent", async (t) => {
	const participants = ["bg"];
	const f = await fixture(t, { provider: true, userWorkParticipants: participants });
	participants.push("foreign");
	await f.session.prompt("instruction");
	const attachment = f.ingress.branch().attachment;
	const [record] = await attachment.submissions.snapshot();
	const before = await attachment.waits.authoritySnapshot();
	assert.deepEqual(before.work[0].participants, ["host-user", "bg"]);
	await retainUserWork(attachment, record.id, record.revision, ["bg"]);
	assert.deepEqual(await attachment.waits.authoritySnapshot(), before);
});

test("user work rejects automated submissions, stale revisions, and cancelled input", async (t) => {
	const f = await fixture(t, { admit: async () => false });
	await f.session.sendUserMessage("automated instruction");
	await f.session.prompt("user instruction");
	const attachment = f.ingress.branch().attachment;
	const [automated, user] = await attachment.submissions.snapshot();
	await assert.rejects(retainUserWork(attachment, automated.id, automated.revision), { code: "identity" });
	await assert.rejects(retainUserWork(attachment, user.id, user.revision + 1), { code: "stale" });
	await attachment.submissions.cancel(user.id, user.revision);
	await assert.rejects(retainUserWork(attachment, user.id, user.revision), { code: "stale" });
	assert.deepEqual((await attachment.waits.authoritySnapshot()).work, []);
});

for (const lane of ["steer", "followUp"])
	for (const count of [1, 2])
		test(`consumed ${lane} user batch of ${count} selects fresh tool work without reviving older callbacks`, async (t) => {
			const seen = [],
				escaped = deferred();
			let oldCheck,
				oldContinuation,
				request = 0;
			const f = await fixture(t, {
				provider: true,
				userWorkParticipants: ["bg"],
				tools: ["inspect_work"],
				extensions: [
					{
						name: "inspect-work",
						factory(pi) {
							pi.registerTool({
								name: "inspect_work",
								label: "Inspect work",
								description: "Inspect owning work",
								parameters: { type: "object", properties: {}, additionalProperties: false },
								async execute() {
									const context = f.ingress.branch().workContext;
									const current = context.current();
									seen.push(current);
									if (seen.length === 1) {
										oldCheck = context.authorize(current.id);
										oldContinuation = escaped.promise.then(() =>
											assert.throws(() => context.current(), { code: "stale" }),
										);
										for (let i = 0; i < count; i++) await f.session.prompt(`queued ${i}`, { streamingBehavior: lane });
										oldCheck.assertActive();
									} else {
										assert.notEqual(current.id, seen[0].id);
										assert.throws(() => oldCheck.assertActive(), { code: "stale" });
										escaped.resolve();
										await oldContinuation;
									}
									return { content: [{ type: "text", text: current.id }], details: {} };
								},
							});
						},
					},
				],
				response() {
					request++;
					const callTool = request === 1 || request === (lane === "followUp" ? 3 : 2);
					const delta = callTool
						? {
								tool_calls: [
									{
										index: 0,
										id: `call-${request}`,
										type: "function",
										function: { name: "inspect_work", arguments: "{}" },
									},
								],
							}
						: { content: "Done" };
					return new Response(
						`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: callTool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					);
				},
			});
			await f.session.bindExtensions({
				onError: (error) => {
					throw error;
				},
			});
			f.session.setSteeringMode("all");
			f.session.setFollowUpMode("all");
			await f.session.prompt("initial instruction");
			assert.ok(
				f.session.agent.state.messages
					.filter((message) => message.role === "toolResult")
					.every((message) => !message.isError),
			);
			assert.equal(seen.length, 2);
			const attachment = f.ingress.branch().attachment;
			const authority = await attachment.waits.authoritySnapshot();
			for (const item of authority.work) assert.deepEqual(item.participants, ["host-user", "bg"]);
			const records = await attachment.submissions.snapshot();
			const queued = records.filter((record) => record.submission.args[0]?.startsWith?.("queued "));
			assert.equal(queued.length, count);
			if (count === 1)
				assert.equal((await retainUserWork(attachment, queued[0].id, queued[0].revision)).id, seen[1].id);
			else assert.match(seen[1].id, /^user-batch:/);
			const claims = queued.flatMap((record) => record.dispatch.queueClaims.filter((claim) => claim.consumed));
			assert.equal((await consumedUserWork(attachment, claims)).id, seen[1].id);
			assert.equal(await consumedUserWork(attachment, [{ id: "unknown", revision: 1 }, ...claims]), undefined);
			assert.equal(
				await consumedUserWork(
					attachment,
					claims.map((claim) => ({ ...claim, revision: claim.revision + 1 })),
				),
				undefined,
			);
			assert.equal(request, lane === "followUp" ? 4 : 3);
		});

for (const lane of ["steer", "followUp"])
	for (const cancel of [false, true])
		test(`idle ${lane} queue drain owns a neutral operation before consumption: cancel=${cancel}`, async (t) => {
			let request = 0,
				observed,
				authority;
			const f = await fixture(t, {
				provider: true,
				tools: ["inspect_work"],
				extensions: [
					{
						name: "inspect-work",
						factory(pi) {
							pi.registerTool({
								name: "inspect_work",
								label: "Inspect work",
								description: "Inspect owning work",
								parameters: { type: "object", properties: {}, additionalProperties: false },
								async execute() {
									const context = f.ingress.branch().workContext;
									observed = context.current();
									authority = context.authorize(observed.id);
									return { content: [{ type: "text", text: observed.id }], details: {} };
								},
							});
						},
					},
				],
				response() {
					request++;
					const delta =
						request === 1
							? {
									tool_calls: [
										{ index: 0, id: "inspect", type: "function", function: { name: "inspect_work", arguments: "{}" } },
									],
								}
							: { content: "Done" };
					return new Response(
						`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: request === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					);
				},
			});
			await f.session.bindExtensions({
				onError: (error) => {
					throw error;
				},
			});
			await f.session[lane]("queued instruction");
			assert.equal(f.sent.length, 0);
			assert.equal(f.ingress.branch().workContext.current(), undefined);
			const [record] = await f.ingress.branch().attachment.submissions.snapshot();
			const expected = await retainUserWork(f.ingress.branch().attachment, record.id, record.revision);
			if (cancel) {
				const [queued] = f.session.agent.inspectQueuedMessages();
				await f.ingress.cancelNativeQueue(queued.id, queued.revision);
			}
			await f.session.continueQueued();
			assert.equal(request, cancel ? 0 : 2);
			if (!cancel) {
				assert.equal(observed.id, expected.id);
				assert.throws(() => authority.assertActive(), { code: "stale" });
				assert.ok(
					f.session.agent.state.messages
						.filter((message) => message.role === "toolResult")
						.every((message) => !message.isError),
				);
			}
			await f.session.continueQueued();
			assert.equal(request, cancel ? 0 : 2);
		});

for (const mode of ["normal", "reversed", "reopen", "model-tools", "shared-results"])
	test(`loaded multiloop/background pair automatically composes after its wait (${mode})`, {
		skip: process.platform === "win32",
		timeout: 20000,
	}, async (t) => {
		const reverse = mode === "reversed";
		const root = await mkdtemp(join(tmpdir(), "jouzu-loaded-background-"));
		const releaseFile = join(root, "release-task");
		const command = `while test ! -e '${releaseFile.replaceAll("'", "'\\''")}'; do sleep 0.02; done; printf 'flow-result-marker\\n'`;
		const manager = SessionManager.create(root, join(root, "history"));
		const { createJiti } = await import(
			createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("jiti")
		);
		const jiti = createJiti(import.meta.url, { moduleCache: false });
		let loaded = await jiti.import(
			join(import.meta.dirname, "../node_modules/@vanillagreen/pi-background-tasks/extensions/background-tasks.ts"),
			{ default: true },
		);
		const loopFactory = await jiti.import(
			join(import.meta.dirname, "../node_modules/pi-multiloop/extensions/pi-multiloop/index.ts"),
			{ default: true },
		);
		const errors = [],
			tools = new Map();
		let f, ctx, task, token;
		let modelStage = 0;
		const loopBridge = createMultiloopControllerExtension({
			ingress: () => f.ingress,
			onError: (error) => errors.push(error),
		});
		const loop = {
			name: "loaded-multiloop",
			factory(pi) {
				const proxy = Object.create(pi);
				proxy.registerTool = (tool) => {
					tools.set(tool.name, tool);
					pi.registerTool(tool);
				};
				pi.on("session_start", (_event, context) => {
					ctx = context;
				});
				loopFactory(proxy);
			},
		};
		const bridge = createBackgroundControllerExtension({
			ingress: mode === "shared-results" ? () => f.ingress : undefined,
			currentWork: () => f.ingress.branch().workContext.current(),
			onError: (error) => errors.push(error),
		});
		const background = {
			name: "loaded-background",
			factory(pi) {
				const proxy = Object.create(pi);
				proxy.registerTool = (tool) => {
					tools.set(tool.name, tool);
					pi.registerTool(tool);
				};
				loaded(proxy);
			},
		};
		const wait = createFlowWaitExtension({
			attachment: () => f.ingress.branch().attachment,
			authorize: (work) => f.ingress.branch().workContext.authorize(work),
			maxDurationMs: 10000,
		});
		f = await fixture(t, {
			root,
			manager,
			provider: true,
			shutdownExtensions: true,
			maxInputBytes: mode === "shared-results" ? 8192 : 4096,
			admit: null,
			autoRelease: { onError: (error) => errors.push(error) },
			tools: ["model-tools", "shared-results"].includes(mode) ? ["multiloop_start", "bg_task", "agent_wait"] : [],
			consumedAttempt: loopBridge.consumedAttempt,
			response: !["model-tools", "shared-results"].includes(mode)
				? undefined
				: () => {
						let name, args;
						if (modelStage === 0) {
							name = "multiloop_start";
							args = { lane: "test", runTag: "run", mode: "research", goal: "Wait for task" };
						} else if (modelStage === 1) {
							name = "bg_task";
							args = {
								action: "spawn",
								command,
								notifyOnExit: mode === "shared-results",
								notifyOnOutput: false,
								timeoutSeconds: 5,
							};
						} else if (modelStage === 2) {
							const result = f.session.agent.state.messages.findLast(
								(message) => message.role === "toolResult" && message.toolName === "bg_task",
							);
							assert.equal(result.isError, false);
							task = result.details.task;
							name = "agent_wait";
							args = {
								work: task.flow.work.id,
								reason: "Await installed task",
								deadline: "10s",
								on: [{ producer: "bg", handle: task.id, execution: task.flow.execution, until: "exit" }],
							};
						}
						modelStage++;
						const delta = name
							? {
									tool_calls: [
										{
											index: 0,
											id: `call-${modelStage}`,
											type: "function",
											function: { name, arguments: JSON.stringify(args) },
										},
									],
								}
							: { content: "Done" };
						return new Response(
							`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: name ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
							{ headers: { "content-type": "text/event-stream" } },
						);
					},
			attachWaitSources: async (attachment) => bridge.attach(attachment, manager),
			extensions: [
				...(reverse ? [background, loop, bridge, loopBridge] : [loopBridge, bridge, loop, background]),
				{
					name: "wait-capture",
					factory(pi) {
						const proxy = Object.create(pi);
						proxy.registerTool = (tool) => {
							tools.set(tool.name, tool);
							pi.registerTool(tool);
						};
						wait.factory(proxy);
					},
				},
			],
		});
		t.after(() => rm(root, { recursive: true, force: true }));
		await f.session.bindExtensions({ onError: (error) => errors.push(error) });
		const branch = f.ingress.branch();
		if (["model-tools", "shared-results"].includes(mode)) {
			f.session.setActiveToolsByName(["multiloop_start", "bg_task", "agent_wait"]);
			assert.equal(f.session.agent.state.tools.length, 3, JSON.stringify(f.session.getAllTools()));
			await f.session.prompt("Start the lane, spawn its background process, and wait for its exit.");
			const results = f.session.agent.state.messages.filter((message) => message.role === "toolResult");
			assert.deepEqual(
				results.map((result) => [result.toolName, result.isError]),
				[
					["multiloop_start", false],
					["bg_task", false],
					["agent_wait", false],
				],
				JSON.stringify(results),
			);
			token = (await branch.attachment.waits.snapshot())[0].token;
		} else {
			await tools
				.get("multiloop_start")
				.execute(
					"start",
					{ lane: "test", runTag: "run", mode: "research", goal: "Wait for task" },
					undefined,
					undefined,
					ctx,
				);
			const campaign = branch.attachment.waits.boundWork(multiloopWorkBinding({ lane: "test", runTag: "run" }));
			await branch.workContext.run({ id: campaign.id, actor: "multiloop", revision: campaign.revision }, async () => {
				const result = await tools.get("bg_task").execute("spawn", {
					action: "spawn",
					command,
					notifyOnExit: mode === "shared-results",
					notifyOnOutput: false,
					timeoutSeconds: 5,
				});
				task = result.details.task;
				assert.deepEqual(task.flow.scope, branch.scope);
				assert.equal(task.flow.work.id, campaign.id);
				await tools.get("agent_wait").execute(
					"wait",
					{
						work: campaign.id,
						reason: "Await installed task",
						deadline: "10s",
						on: [{ producer: "bg", handle: task.id, execution: task.flow.execution, until: "exit" }],
					},
					undefined,
					undefined,
					{ sessionManager: manager },
				);
				token = (await branch.attachment.waits.snapshot())[0].token;
			});
		}
		for (let i = 0; i < 3; i++) await f.session.prompt("status?");
		assert.equal((await branch.attachment.ledger.snapshot()).attempts.length, 0);
		assert.equal(f.sent.length, ["model-tools", "shared-results"].includes(mode) ? 7 : 3);
		if (mode === "reopen") {
			const expiry = (await branch.attachment.waits.snapshot())[0].expiresAt;
			await f.ingress.dispose();
			await writeFile(releaseFile, "complete");
			await waitForFlow(
				async () =>
					(await tools.get("bg_status").execute("status", { action: "list" })).details.tasks[0]?.status === "completed",
			);
			loaded = await createJiti(import.meta.url, { moduleCache: false }).import(
				join(import.meta.dirname, "../node_modules/@vanillagreen/pi-background-tasks/extensions/background-tasks.ts"),
				{ default: true },
			);
			const reopenedManager = SessionManager.open(manager.getSessionFile());
			f = await fixture(t, {
				root,
				manager: reopenedManager,
				provider: true,
				shutdownExtensions: true,
				admit: null,
				attachWaitSources: async (attachment) => bridge.attach(attachment, reopenedManager),
				extensions: [bridge, background],
			});
			const reopened = f.ingress.branch();
			assert.deepEqual(reopened.waitSourceRecovery.missing, []);
			assert.equal(reopened.waitSourceRecovery.restored, 1);
			const restored = (await reopened.attachment.waits.snapshot())[0];
			assert.equal(restored.token, token);
			assert.equal(restored.expiresAt, expiry);
			assert.equal(restored.state, "resolved");
			assert.equal(f.sent.length, 0);
			assert.deepEqual(errors, []);
			await f.ingress.dispose();
			return;
		}
		await writeFile(releaseFile, "complete");
		for (let i = 0; i < 1000; i++) {
			if ((await branch.attachment.ledger.snapshot()).attempts.some((a) => a.phase === "settled")) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const attempts = (await branch.attachment.ledger.snapshot()).attempts;
		assert.equal(attempts.length, 1);
		assert.equal(
			attempts[0].outcome,
			"success",
			JSON.stringify({ attempts, errors: errors.map((error) => ({ message: error.message, stack: error.stack })) }),
		);
		assert.deepEqual(
			attempts[0].members.map((member) => member.kind),
			mode === "shared-results" ? ["wait", "work", "result"] : ["wait", "work"],
		);
		assert.equal((await branch.attachment.waits.snapshot())[0].token, token);
		assert.deepEqual(errors, []);
		assert.equal(f.sent.length, ["model-tools", "shared-results"].includes(mode) ? 8 : 4);
		if (mode === "shared-results") {
			assert.match(JSON.stringify(f.sent.at(-1)), /flow-results:/);
			assert.match(JSON.stringify(f.sent.at(-1)), /bg-result:/);
			await waitForFlow(
				async () =>
					(await tools.get("bg_status").execute("status", { action: "list" })).details.tasks[0]?.flow?.result
						?.delivered === true,
			);
			const recorded = (await tools.get("bg_status").execute("status", { action: "list" })).details.tasks[0];
			assert.equal(recorded.exitNotified, true);
			assert.equal(recorded.flow.result.metadata.execution, task.flow.execution);
			assert.equal(recorded.flow.result.metadata.reference, task.logFile);
			assert.match(await readFile(task.logFile, "utf8"), /flow-result-marker/);
			assert.equal(f.sent.length, 8);
			const reference = JSON.stringify(f.sent.at(-1)).match(/flow-results:[a-f0-9]{64}/)[0];
			await f.ingress.dispose();
			loaded = await createJiti(import.meta.url, { moduleCache: false }).import(
				join(import.meta.dirname, "../node_modules/@vanillagreen/pi-background-tasks/extensions/background-tasks.ts"),
				{ default: true },
			);
			const reopenedManager = SessionManager.open(manager.getSessionFile());
			f = await fixture(t, {
				root,
				manager: reopenedManager,
				provider: true,
				shutdownExtensions: true,
				admit: null,
				tools: ["agent_results"],
				autoRelease: { onError: (error) => errors.push(error) },
				attachWaitSources: async (attachment) => bridge.attach(attachment, reopenedManager),
				extensions: [bridge, background],
			});
			await f.session.bindExtensions({ onError: (error) => errors.push(error) });
			const readResults = f.session.getToolDefinition("agent_results");
			assert.ok(readResults);
			const result = await readResults.execute("results", { reference, limit: 1 }, undefined, undefined, {
				sessionManager: reopenedManager,
			});
			const page = JSON.parse(result.content[0].text);
			assert.equal(page.total, 1);
			assert.equal(page.members[0].execution, task.flow.execution);
			assert.equal(page.members[0].reference, task.logFile);
			await f.ingress.wakeProducers();
			assert.equal(f.sent.length, 0);
			assert.deepEqual(errors, []);
			await f.ingress.dispose();
		}
	});

for (const bindExecution of [true, false])
	for (const notifyOnExit of [true, false])
		for (const redacted of [false, true])
			test(`installed background terminal log observation follows final provider content (redacted=${redacted}, notify=${notifyOnExit}, wait=${bindExecution})`, {
				skip: process.platform === "win32",
				timeout: 20000,
			}, async (t) => {
				const root = await mkdtemp(join(tmpdir(), "jouzu-bg-observation-"));
				const manager = SessionManager.create(root, join(root, "history"));
				const { createJiti } = await import(
					createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("jiti")
				);
				let loaded = await createJiti(import.meta.url, { moduleCache: false }).import(
					join(import.meta.dirname, "../node_modules/@vanillagreen/pi-background-tasks/extensions/background-tasks.ts"),
					{ default: true },
				);
				const tools = new Map(),
					errors = [];
				let f,
					stage = 0,
					task;
				const bridge = createBackgroundControllerExtension({
					ingress: () => f.ingress,
					currentWork: () => f.ingress.branch().workContext.current(),
					onError: (error) => errors.push(error),
				});
				f = await fixture(t, {
					root,
					manager,
					provider: true,
					shutdownExtensions: true,
					userWorkParticipants: ["bg"],
					tools: ["bg_task"],
					maxInputBytes: 8192,
					attachWaitSources: async (attachment) => bridge.attach(attachment, manager),
					extensions: [
						bridge,
						{
							name: "background",
							factory(pi) {
								const proxy = Object.create(pi);
								proxy.registerTool = (tool) => {
									tools.set(tool.name, tool);
									pi.registerTool(tool);
								};
								loaded(proxy);
								if (redacted)
									pi.on("context", (event) => ({
										messages: event.messages.map((message) =>
											message.role === "toolResult" && message.details?.action === "log"
												? { ...message, content: [{ type: "text", text: "Removed" }] }
												: message,
										),
									}));
							},
						},
					],
					response: async () => {
						let args;
						if (stage === 0) args = { action: "spawn", command: "printf 'terminal-log-proof\\n'", notifyOnExit };
						if (stage === 1) {
							await waitForFlow(async () => {
								task = (await tools.get("bg_task").execute("inspect", { action: "list" })).details.tasks[0];
								return task?.status === "completed";
							});
							if (bindExecution)
								await f.ingress.branch().attachment.waitProducers.bindForWait(
									"bg",
									{
										workId: task.flow.work.id,
										handle: task.id,
										execution: task.flow.execution,
									},
									task.flow.work.revision,
								);
							args = { action: "log", id: task.id };
						}
						stage++;
						const delta = args
							? {
									tool_calls: [
										{
											index: 0,
											id: `read-${stage}`,
											type: "function",
											function: { name: "bg_task", arguments: JSON.stringify(args) },
										},
									],
								}
							: { content: "Done" };
						return new Response(
							`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: args ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
							{ headers: { "content-type": "text/event-stream" } },
						);
					},
				});
				t.after(() => rm(root, { recursive: true, force: true }));
				await f.session.bindExtensions({ onError: (error) => errors.push(error) });
				await f.session.prompt("Start the task and inspect its terminal output");
				assert.equal(f.sent.length, 3);
				const read = (await tools.get("bg_task").execute("inspect", { action: "list" })).details.tasks[0];
				assert.equal(read.flow.result.reads.length, 1);
				assert.equal(read.flow.result.observed, undefined);
				await f.ingress.wakeProducers();
				const settled = (await tools.get("bg_task").execute("inspect", { action: "list" })).details.tasks[0];
				assert.equal(settled.flow.result.observed, redacted ? undefined : true);
				assert.equal(settled.flow.result.delivered, redacted && notifyOnExit ? true : undefined);
				assert.equal(f.sent.length, redacted && notifyOnExit ? 4 : 3);
				const waits = f.ingress.branch().attachment.waits;
				assert.equal((await waits.authoritySnapshot()).executions.length, bindExecution ? 1 : 0);
				assert.equal((await f.ingress.retireWaitHistory()).executions, 0);
				if (bindExecution)
					await f.ingress.branch().attachment.waitProducers.bindForWait(
						"bg",
						{
							workId: task.flow.work.id,
							handle: task.id,
							execution: task.flow.execution,
						},
						task.flow.work.revision,
					);
				const retired = await f.ingress.retireWaitHistory(true);
				assert.equal(retired.executions, !redacted && bindExecution ? 1 : 0);
				assert.equal(retired.work, redacted ? 0 : 1);
				assert.equal((await waits.authoritySnapshot()).executions.length, redacted && bindExecution ? 1 : 0);
				assert.deepEqual(errors, []);
				await f.ingress.dispose();
				loaded = await createJiti(import.meta.url, { moduleCache: false }).import(
					join(import.meta.dirname, "../node_modules/@vanillagreen/pi-background-tasks/extensions/background-tasks.ts"),
					{ default: true },
				);
				const reopenedManager = SessionManager.open(manager.getSessionFile());
				f = await fixture(t, {
					root,
					manager: reopenedManager,
					provider: true,
					shutdownExtensions: true,
					attachWaitSources: async (attachment) => bridge.attach(attachment, reopenedManager),
					extensions: [
						bridge,
						{
							name: "background-reopened",
							factory(pi) {
								const proxy = Object.create(pi);
								proxy.registerTool = (tool) => {
									tools.set(tool.name, tool);
									pi.registerTool(tool);
								};
								loaded(proxy);
							},
						},
					],
				});
				await f.session.bindExtensions({ onError: (error) => errors.push(error) });
				const reopened = (await tools.get("bg_task").execute("inspect", { action: "list" })).details.tasks[0];
				assert.equal(reopened.flow.result.observed, redacted ? undefined : true);
				assert.equal(reopened.flow.result.delivered, redacted && notifyOnExit ? true : undefined);
				assert.equal(
					(await f.ingress.branch().attachment.waits.authoritySnapshot()).executions.length,
					redacted && bindExecution ? 1 : 0,
				);
				await f.ingress.wakeProducers();
				assert.equal(f.sent.length, 0);
				assert.deepEqual(errors, []);
				await f.ingress.dispose();
			});

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
