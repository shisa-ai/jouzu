import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createFlowSession, deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { FlowModelInput } from "../dist/flow-control/model-input.js";
import { PiFlowSessionService } from "../dist/flow-control/pi-session-service.js";
import { openAIFlowPayload } from "../dist/flow-control/provider-payload.js";

function options(root) {
	return {
		root,
		maxInputBytes: 4096,
		maxResultBytes: 4096,
		host: { projections: new Map(), maxPayloadBytes: 100000, containsUserInput: () => true },
		policy: () => ({ userPending: false, recoveryBlocked: false, waitingWorkIds: [] }),
	};
}
async function fixture(t, config = {}) {
	const root = config.root ?? (await mkdtemp(join(tmpdir(), "jouzu-flow-service-")));
	let service;
	const treeScopes = [];
	const { session, requests } = await createFlowSession(t, {
		persist: true,
		sessionManager: config.manager,
		ingress: {
			version: 1,
			submit: async (submission, dispatch) => {
				if (!config.retainInputs) return dispatch();
				const branch = service.branch();
				const saved = await branch.attachment.submissions.retain(submission);
				return branch.native.dispatch(saved.id, saved.revision, submission.id, dispatch);
			},
			beforeBranchChange: () => service.beforeBranchChange(),
			branchChanged: () => service.branchChanged(),
			dispose: () => service?.close(),
		},
		extensions: [(pi) => pi.on("session_tree", () => treeScopes.push(service.branch().scope))],
	});
	const native = session.agent.streamFunction;
	session.agent.streamFunction = async (model, context, options) => {
		if (config.providerReceipts?.()) {
			for (const message of context.messages)
				if (message.role === "user") options?.onMessageConverted?.(message, message);
		}
		await options?.onPayload?.({ messages: context.messages }, model);
		await config.onRequest?.();
		return native(model, context, options);
	};
	service = await PiFlowSessionService.open(session, {
		...options(root),
		...(config.host ? { host: config.host } : {}),
		attachWaitSources: config.attachWaitSources,
	});
	t.after(async () => {
		await service.close();
		if (!config.root) await rm(root, { recursive: true, force: true });
	});
	return { root, session, service, requests, treeScopes };
}

test("session service binds initial metadata and exclusively owns its session", async (t) => {
	const { root, session, service, requests } = await fixture(t);
	assert.deepEqual(requests, []);
	assert.deepEqual(session.sessionManager.buildSessionContext().messages, []);
	assert.equal(service.branch().scope.sessionId, session.sessionId);
	assert.deepEqual(service.branch().recovery, { recovered: 0, unresolved: 0 });
	await assert.rejects(PiFlowSessionService.open(session, options(root)), { code: "busy" });
	await service.close();
	assert.throws(() => service.branch(), { code: "stale" });
});

test("native navigation replaces branch resources before tree events and survives reopen", async (t) => {
	const first = await fixture(t);
	const original = first.service.branch();
	await first.session.prompt("first question");
	const user = first.session.sessionManager
		.getBranch()
		.find((entry) => entry.type === "message" && entry.message.role === "user");
	const stalePrompt = first.session.prompt.bind(first.session);
	await first.session.navigateTree(user.id);
	const next = first.service.branch();
	assert.notEqual(next.scope.branchId, original.scope.branchId);
	assert.deepEqual(first.treeScopes, [next.scope]);
	assert.equal(original.controller.view().state, "closed");
	await assert.rejects(stalePrompt("stale"), { code: "stale" });
	await first.service.close();
	const manager = SessionManager.open(first.session.sessionManager.getSessionFile());
	const reopened = await fixture(t, { root: first.root, manager });
	assert.deepEqual(reopened.service.branch().scope, next.scope);
	assert.deepEqual(reopened.requests, []);
});

test("no-op native navigation keeps branch resources and emits no transition", async (t) => {
	const { session, service, treeScopes } = await fixture(t);
	const branch = service.branch();
	await session.navigateTree(session.sessionManager.getLeafId());
	assert.equal(service.branch(), branch);
	assert.deepEqual(treeScopes, []);
});

test("reopen holds automated admission when consumed input has no provable history", async (t) => {
	const first = await fixture(t);
	const ledger = first.service.branch().attachment.ledger;
	const input = FlowModelInput.compose("lost", [{ id: "lost", revision: "1", kind: "work", text: "Do work" }], 4096);
	await ledger.select(input.attemptId, input.members);
	await ledger.queued(input.attemptId, { id: "queue", revision: 1 });
	await ledger.claim(input.attemptId, { id: "queue", revision: 1 });
	await first.service.close();
	const manager = SessionManager.open(first.session.sessionManager.getSessionFile());
	const next = await fixture(t, { root: first.root, manager });
	const branch = next.service.branch();
	assert.deepEqual(branch.recovery, { recovered: 0, unresolved: 1 });
	assert.equal(branch.host.gate().recoveryBlocked, true);
	let builds = 0;
	branch.controller.register({
		version: 1,
		namespace: "fixture",
		async snapshot() {
			return [
				{
					id: "other",
					revision: "1",
					producer: "fixture",
					sequence: 0,
					rank: 4,
					workId: "other",
					workRevision: "1",
					independent: false,
					runnable: true,
				},
			];
		},
		async build() {
			builds++;
			throw new Error("Held work must not build");
		},
	});
	await branch.controller.wake();
	assert.equal(builds, 0);
	assert.deepEqual(next.requests, []);
});

test("session ownership remains held until the branch controller drains", async (t) => {
	const { root, session, service } = await fixture(t);
	const entered = deferred(),
		release = deferred();
	const controller = service.branch().controller;
	const close = controller.close.bind(controller);
	t.mock.method(controller, "close", async () => {
		entered.resolve();
		await release.promise;
		await close();
	});
	const closing = service.close();
	await entered.promise;
	await assert.rejects(PiFlowSessionService.open(session, options(root)), { code: "busy" });
	release.resolve();
	await closing;
	const successor = await PiFlowSessionService.open(session, options(root));
	await successor.close();
});

test("unsettled native requests hold automation after session-service reopen", async (t) => {
	const first = await fixture(t);
	const store = first.service.branch().attachment.nativeRequests;
	await store.begin({
		id: "unsettled",
		sourceHash: "a".repeat(64),
		transformedHash: "b".repeat(64),
		modelHash: "c".repeat(64),
		systemHash: "d".repeat(64),
	});
	await first.service.close();
	const next = await fixture(t, {
		root: first.root,
		manager: SessionManager.open(first.session.sessionManager.getSessionFile()),
	});
	assert.equal(next.service.branch().host.gate().recoveryBlocked, true);
	await next.session.prompt("must reconcile");
	assert.equal(next.requests.length, 0);
	assert.match(next.session.agent.state.errorMessage, /requires reconciliation/);
});

test("missing source history holds session-service automation after reopen", async (t) => {
	const first = await fixture(t, { retainInputs: true });
	t.mock.method(first.service.branch().attachment.submissions, "recordPromptHistory", async () => {});
	await first.session.prompt("source missing history");
	await first.service.close();
	const next = await fixture(t, {
		root: first.root,
		manager: SessionManager.open(first.session.sessionManager.getSessionFile()),
		retainInputs: true,
	});
	assert.deepEqual(next.service.branch().sourceRecovery, { recovered: 0, unresolved: 1 });
	assert.equal(next.service.branch().host.gate().recoveryBlocked, true);
	assert.equal(next.requests.length, 0);
});

test("failed navigation stays held on reopen and failed attachment releases its session lease", async (t) => {
	const { root, session, service } = await fixture(t);
	await session.prompt("first question");
	const user = session.sessionManager
		.getBranch()
		.find((entry) => entry.type === "message" && entry.message.role === "user");
	t.mock.method(service.branch().host, "handoffNavigation", () => {
		throw new Error("fixture handoff failure");
	});
	await assert.rejects(session.navigateTree(user.id), /fixture handoff failure/);
	assert.throws(() => service.branch(), { code: "stale" });
	await service.close();
	for (let attempt = 0; attempt < 2; attempt++) {
		await assert.rejects(PiFlowSessionService.open(session, options(root)), { code: "transition" });
	}
});

test("session service updates native recovery gates and authorizes one reviewed retry", async (t) => {
	let receipts = false;
	const f = await fixture(t, { retainInputs: true, providerReceipts: () => receipts });
	const branch = f.service.branch();
	assert.equal(branch.host.gate().recoveryBlocked, false);
	await f.session.prompt("held input");
	const [held] = await branch.attachment.nativeRequests.snapshot();
	assert.equal(branch.host.gate().recoveryBlocked, true);
	assert.equal(f.requests.length, 0);
	await assert.rejects(f.service.retryNativeRequest(held.id, "0".repeat(64)), { code: "stale" });
	assert.equal(branch.host.gate().recoveryBlocked, true);
	await f.service.retryNativeRequest(held.id, held.withheldPayload.hash);
	assert.equal(branch.host.gate().recoveryBlocked, false);
	assert.equal(f.requests.length, 0);
	receipts = true;
	await f.session.prompt("retry");
	assert.equal(f.requests.length, 1);
	assert.equal(branch.host.gate().recoveryBlocked, false);
	assert.equal((await branch.attachment.nativeRequests.snapshot())[1].retryOf, held.id);
});

test("session service reports busy retry without granting permission", async (t) => {
	const f = await fixture(t, { retainInputs: true });
	const branch = f.service.branch();
	await f.session.prompt("held");
	const [held] = await branch.attachment.nativeRequests.snapshot();
	t.mock.method(branch.host, "atIdle", async () => ({ kind: "busy" }));
	await assert.rejects(f.service.retryNativeRequest(held.id, held.withheldPayload.hash), { code: "busy" });
	assert.equal((await branch.attachment.nativeRequests.snapshot())[0].retryAuthorization, undefined);
	assert.equal(branch.host.gate().recoveryBlocked, true);
});

test("cancelled native input remains excluded after session-service reopen", async (t) => {
	const first = await fixture(t, { retainInputs: true });
	await first.session.prompt("cancelled original");
	const [held] = await first.service.branch().attachment.nativeRequests.snapshot();
	await first.service.cancelNativeSources(held.id, held.withheldPayload.hash, [0]);
	assert.equal(first.service.branch().host.gate().recoveryBlocked, false);
	assert.equal(first.requests.length, 0);
	await first.service.close();
	const next = await fixture(t, {
		root: first.root,
		manager: SessionManager.open(first.session.sessionManager.getSessionFile()),
		retainInputs: true,
		providerReceipts: () => true,
	});
	assert.equal(next.service.branch().host.gate().recoveryBlocked, false);
	await next.session.prompt("independent request");
	assert.equal(next.requests.length, 1);
	assert.ok(!JSON.stringify(next.requests).includes("cancelled original"));
	const [original, request] = await next.service.branch().attachment.nativeRequests.snapshot();
	assert.deepEqual(original.cancelledSources, [0]);
	assert.equal(original.payload, undefined);
	assert.equal(request.outcome, "success");
});

test("session service reconciles an idle queue edit without sending or duplicating history", async (t) => {
	const f = await fixture(t, { retainInputs: true, providerReceipts: () => true });
	await f.session.followUp("original");
	const [item] = f.session.agent.inspectQueuedMessages();
	f.session.agent.editQueuedMessage(item.id, 1, {
		role: "user",
		content: [{ type: "text", text: "edited" }],
		timestamp: 1,
	});
	await f.service.reconcileNativeQueueEdit(item.id, 2);
	assert.equal(f.requests.length, 0);
	await f.session.continueQueued();
	assert.equal(f.requests.length, 1);
	assert.ok(JSON.stringify(f.requests).includes("edited"));
	const [record] = await f.service.branch().attachment.submissions.snapshot();
	assert.equal(record.dispatch.queueHistory.length, 1);
	assert.equal(record.dispatch.queueHistory[0].revision, 2);
});

test("queue maintenance fences edits and cancellation while retaining the reviewed revision", async (t) => {
	const f = await fixture(t, { retainInputs: true, providerReceipts: () => true });
	await f.session.followUp("original");
	const [item] = f.session.agent.inspectQueuedMessages();
	f.session.agent.editQueuedMessage(item.id, 1, {
		role: "user",
		content: [{ type: "text", text: "edited" }],
		timestamp: 1,
	});
	const entered = deferred(),
		release = deferred();
	const store = f.service.branch().attachment.submissions;
	const write = store.recordQueueEdit.bind(store);
	t.mock.method(store, "recordQueueEdit", async (...args) => {
		entered.resolve();
		await release.promise;
		return write(...args);
	});
	const reconciling = f.service.reconcileNativeQueueEdit(item.id, 2);
	await entered.promise;
	assert.throws(
		() => f.session.agent.editQueuedMessage(item.id, 2, { role: "user", content: "racing", timestamp: 1 }),
		{ code: "busy" },
	);
	assert.throws(() => f.session.agent.cancelQueuedMessage(item.id, 2), { code: "busy" });
	release.resolve();
	await reconciling;
	assert.equal(f.session.agent.inspectQueuedMessages()[0].revision, 2);
	assert.equal(f.requests.length, 0);
	await f.session.continueQueued();
	assert.equal(f.requests.length, 1);
});

test("native queue cancellation preserves duplicate input identity and unrelated work", async (t) => {
	const f = await fixture(t, { retainInputs: true, providerReceipts: () => true });
	await f.session.followUp("duplicate");
	await f.session.followUp("duplicate");
	const [first, second] = f.session.agent.inspectQueuedMessages();
	await f.service.cancelNativeQueue(first.id, first.revision);
	await f.service.cancelNativeQueue(first.id, first.revision);
	assert.deepEqual(
		f.session.agent.inspectQueuedMessages().map((item) => item.id),
		[second.id],
	);
	assert.equal(f.requests.length, 0);
	const [cancelled] = await f.service.branch().attachment.submissions.snapshot();
	assert.deepEqual(cancelled.dispatch.queueCancellations, [{ id: first.id, revision: 1 }]);
	assert.deepEqual(cancelled.dispatch.queueClaims, [{ id: first.id, revision: 1, consumed: false }]);
	const [view] = await f.service.branch().attachment.submissionViews();
	assert.equal(view.admission, "cancelled");
	assert.equal(view.delivery, "none");
	assert.deepEqual(view.nativeQueueCancellations, [{ id: first.id, revision: 1, removal: "confirmed" }]);
	await f.session.continueQueued();
	assert.equal(f.requests.length, 1);
	const records = await f.service.branch().attachment.submissions.snapshot();
	assert.equal(records[0].dispatch.queueHistory, undefined);
	assert.equal(records[1].dispatch.queueHistory.length, 1);
});

test("native cancellation retains the edited revision and rejects stale controls", async (t) => {
	const f = await fixture(t, { retainInputs: true, providerReceipts: () => true });
	await f.session.followUp("original");
	const [item] = f.session.agent.inspectQueuedMessages();
	f.session.agent.editQueuedMessage(item.id, 1, { role: "user", content: "edited", timestamp: 1 });
	await assert.rejects(f.service.cancelNativeQueue(item.id, 1), { code: "stale" });
	await f.service.cancelNativeQueue(item.id, 2);
	const [record] = await f.service.branch().attachment.submissions.snapshot();
	assert.equal(record.dispatch.inputs[1].args[0].content, "edited");
	assert.deepEqual(record.dispatch.queueCancellations, [{ id: item.id, revision: 2 }]);
	assert.deepEqual(
		record.dispatch.queueClaims.map((item) => item.consumed),
		[false, false],
	);
	assert.equal(f.requests.length, 0);
});

test("failed cancellation persistence preserves the live queue for retry", async (t) => {
	const f = await fixture(t, { retainInputs: true, providerReceipts: () => true });
	await f.session.followUp("preserved");
	const [item] = f.session.agent.inspectQueuedMessages();
	const store = f.service.branch().attachment.submissions;
	const mock = t.mock.method(store, "cancelQueue", async () => {
		throw new Error("write failure");
	});
	await assert.rejects(f.service.cancelNativeQueue(item.id, 1), /write failure/);
	assert.equal(f.session.agent.inspectQueuedMessages().length, 1);
	assert.equal((await store.snapshot())[0].dispatch.queueCancellations, undefined);
	mock.mock.restore();
	await f.service.cancelNativeQueue(item.id, 1);
	assert.equal(f.session.agent.inspectQueuedMessages().length, 0);
	assert.equal(f.requests.length, 0);
});

test("persisted cancellation blocks consumption after native removal fails", async (t) => {
	const f = await fixture(t, { retainInputs: true, providerReceipts: () => true });
	await f.session.followUp("must not run");
	const [item] = f.session.agent.inspectQueuedMessages();
	const mock = t.mock.method(f.session.agent, "cancelQueuedMessage", () => {
		throw new Error("removal failed");
	});
	await assert.rejects(f.service.cancelNativeQueue(item.id, 1), /removal failed/);
	const [view] = await f.service.branch().attachment.submissionViews();
	assert.equal(view.admission, "held");
	assert.equal(view.nativeQueueCancellations[0].removal, "unconfirmed");
	assert.match(view.reason, /removal reconciliation/);
	mock.mock.restore();
	await f.session.continueQueued();
	assert.equal(f.requests.length, 0);
	assert.equal(f.session.agent.inspectQueuedMessages().length, 1);
	await f.service.cancelNativeQueue(item.id, 1);
	assert.equal(f.session.agent.inspectQueuedMessages().length, 0);
});

test("native queue cancellation evidence survives session-service reopen", async (t) => {
	const first = await fixture(t, { retainInputs: true, providerReceipts: () => true });
	await first.session.followUp("cancelled");
	const [item] = first.session.agent.inspectQueuedMessages();
	await first.service.cancelNativeQueue(item.id, 1);
	await first.service.close();
	const next = await fixture(t, {
		root: first.root,
		manager: SessionManager.open(first.session.sessionManager.getSessionFile()),
		retainInputs: true,
		providerReceipts: () => true,
	});
	await next.service.cancelNativeQueue(item.id, 1);
	await next.session.prompt("new user input");
	assert.equal(next.requests.length, 1);
	assert.ok(!JSON.stringify(next.requests).includes("cancelled"));
	const [record] = await next.service.branch().attachment.submissions.snapshot();
	assert.equal(record.dispatch.queueCancellations[0].id, item.id);
	assert.equal(record.dispatch.queueClaims[0].consumed, false);
});

test("branch startup awaits source registration and closes each source on navigation", async (t) => {
	const scopes = [],
		closed = [];
	const f = await fixture(t, {
		attachWaitSources: async (attachment) => {
			scopes.push(attachment.ledger.scope);
			attachment.waitProducers.register(
				{
					version: 1,
					namespace: "bg",
					subscribe: () => () => {},
					snapshot: async () => {
						throw new Error("unused");
					},
					close: () => {
						closed.push(attachment.ledger.scope);
					},
				},
				assert.ifError,
			);
		},
	});
	assert.deepEqual(scopes, [f.service.branch().scope]);
	await f.session.prompt("question");
	const user = f.session.sessionManager
		.getBranch()
		.find((entry) => entry.type === "message" && entry.message.role === "user");
	await f.session.navigateTree(user.id);
	assert.equal(scopes.length, 2);
	assert.deepEqual(closed, [scopes[0]]);
	assert.deepEqual(f.service.branch().waitSourceRecovery, { restored: 0, missing: [] });
	await f.service.close();
	assert.deepEqual(closed, scopes);
});

test("reopening reconciles retained executions before exposing the branch and holds missing producers", async (t) => {
	const first = await fixture(t);
	const attachment = first.service.branch().attachment;
	await attachment.waits.registerWork("work", "lane", 0);
	await attachment.waits.shareWork("work", "lane", 1, "bg", 0);
	await attachment.waits.registerExecution(
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
	await first.service.close();
	let failedSourceClosed = 0;
	await assert.rejects(
		PiFlowSessionService.open(first.session, {
			...options(first.root),
			attachWaitSources: async (attachment) => {
				attachment.waitProducers.register(
					{
						version: 1,
						namespace: "bg",
						subscribe: () => () => {},
						snapshot: async () => {
							throw new Error("snapshot unavailable");
						},
						close: () => {
							failedSourceClosed++;
						},
					},
					assert.ifError,
				);
			},
		}),
		/snapshot unavailable/,
	);
	assert.equal(failedSourceClosed, 1);
	const manager = () => SessionManager.open(first.session.sessionManager.getSessionFile());
	const missing = await fixture(t, { root: first.root, manager: manager() });
	assert.deepEqual(missing.service.branch().waitSourceRecovery, { restored: 0, missing: ["bg"] });
	assert.equal(missing.service.branch().host.gate().recoveryBlocked, true);
	await missing.service.close();
	const entered = deferred(),
		proceed = deferred();
	const opening = fixture(t, {
		root: first.root,
		manager: manager(),
		attachWaitSources: async (attachment) => {
			attachment.waitProducers.register(
				{
					version: 1,
					namespace: "bg",
					subscribe: () => () => {},
					snapshot: async (identity) => {
						entered.resolve();
						await proceed.promise;
						return { ...identity, revision: 2, predicates: [{ until: "exit", state: "satisfied" }] };
					},
				},
				assert.ifError,
			);
		},
	});
	await entered.promise;
	let opened = false;
	void opening.then(() => {
		opened = true;
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(opened, false);
	proceed.resolve();
	const restored = await opening;
	assert.deepEqual(restored.service.branch().waitSourceRecovery, { restored: 1, missing: [] });
	assert.equal(restored.service.branch().host.gate().recoveryBlocked, false);
	assert.equal(
		(await restored.service.branch().attachment.waits.authoritySnapshot()).executions[0].predicates[0].state,
		"satisfied",
	);
	assert.deepEqual(restored.requests, []);
});

for (const ownership of ["owned", "foreign", "unclassified"])
	test(`session controller binds ${ownership} selected work through native execution`, async (t) => {
		let branch, observed, authority;
		const f = await fixture(t, {
			host: {
				projections: new Map([["openai-completions", openAIFlowPayload("openai-completions")]]),
				maxPayloadBytes: 100000,
				containsUserInput: () => false,
			},
			onRequest() {
				observed = branch.workContext.current();
				if (observed) authority = branch.workContext.authorize(observed.id);
			},
		});
		branch = f.service.branch();
		if (ownership !== "unclassified")
			await branch.attachment.waits.registerWork(
				"selected-work",
				ownership === "foreign" ? "another-owner" : "lane",
				0,
			);
		branch.controller.register({
			version: 1,
			namespace: "lane",
			async snapshot() {
				return [
					{
						id: "instruction",
						revision: "1",
						producer: "lane",
						sequence: 1,
						rank: 4,
						workId: "selected-work",
						workRevision: "producer-revision",
						independent: false,
						runnable: true,
					},
				];
			},
			async build() {
				return { id: "instruction", revision: "1", kind: "work", text: "Perform the selected work" };
			},
		});
		if (ownership === "foreign") {
			await assert.rejects(branch.controller.wake(), { code: "identity" });
			assert.equal(f.requests.length, 0);
		} else {
			await branch.controller.wake();
			assert.equal(f.requests.length, 1);
			assert.deepEqual(observed, ownership === "owned" ? { id: "selected-work", revision: 1 } : undefined);
		}
		assert.equal(branch.workContext.current(), undefined);
		if (authority) assert.throws(() => authority.assertActive(), { code: "stale" });
	});
