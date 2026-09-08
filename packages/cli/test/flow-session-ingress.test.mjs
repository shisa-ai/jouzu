import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assistant, createFlowSession, deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { PiSessionFlowIngress } from "../dist/flow-control/pi-session-ingress.js";

async function fixture(t, { root: supplied, admit = async () => true, policy, manager } = {}) {
	const root = supplied ?? (await mkdtemp(join(tmpdir(), "jouzu-ingress-owner-")));
	const ingress = new PiSessionFlowIngress({
		root,
		maxInputBytes: 4096,
		maxResultBytes: 4096,
		host: { projections: new Map(), maxPayloadBytes: 100000, containsUserInput: () => true },
		policy: policy ?? (() => ({ userPending: false, recoveryBlocked: false, waitingWorkIds: [] })),
		admit,
	});
	const sent = [];
	let wrapped;
	const { session } = await createFlowSession(t, {
		persist: true,
		sessionManager: manager,
		ingress: {
			version: 1,
			async attach(session) {
				session.agent.streamFunction = async (model, context, options) => {
					for (const message of context.messages)
						if (message.role === "user") options.onMessageConverted(message, message);
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
	assert.equal(request.payload.sources[0].disposition, "included");
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

test("default ingress keeps deferred custom context held without an implicit wake", async (t) => {
	const f = await fixture(t, { admit: null });
	await f.session.sendCustomMessage(
		{ customType: "status", content: "context", display: true },
		{ triggerTurn: false },
	);
	assert.equal(f.sent.length, 0);
	assert.match((await f.ingress.heldInputs())[0].reason, /persistence receipt/);
	assert.ok(!JSON.stringify(f.session.agent.state.messages).includes("context"));
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
