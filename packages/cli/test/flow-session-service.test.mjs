import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createFlowSession, deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { FlowModelInput } from "../dist/flow-control/model-input.js";
import { PiFlowSessionService } from "../dist/flow-control/pi-session-service.js";
import { legacyPathDigest, pathDigest } from "../dist/path-digest.js";
import { afterCleanup, cleanupContext } from "./fixtures/cleanup.mjs";

function options(root) {
	return {
		root,
		maxInputBytes: 4096,
		maxResultBytes: 4096,
		host: { maxPayloadBytes: 100000, containsUserInput: () => true },
		policy: () => ({ userPending: false, recoveryBlocked: false, waitingWorkIds: [] }),
	};
}
async function fixture(t, config = {}) {
	const root = config.root ?? (await mkdtemp(join(tmpdir(), "jouzu-flow-service-")));
	if (!config.root) afterCleanup(t, () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
	let service;
	const treeScopes = [];
	const { session, requests } = await createFlowSession(cleanupContext(t), {
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
		extensions: [
			(pi) => pi.on("session_tree", () => treeScopes.push(service.branch().scope)),
			...(config.summary
				? [(pi) => pi.on("session_before_tree", () => ({ summary: { summary: "Saved branch summary" } }))]
				: []),
			// Cloning before model conversion leaves required input unresolved there, which is what
			// holds a request now that provider bodies are not decoded.
			...(config.holdInput
				? [
						(pi) =>
							pi.on("context", ({ messages }) => ({
								messages: config.holdInput() ? structuredClone(messages) : messages,
							})),
					]
				: []),
		],
	});
	const native = session.agent.streamFunction;
	session.agent.streamFunction = async (model, context, options) => {
		await options?.onPayload?.({ messages: context.messages }, model);
		await config.onRequest?.();
		return native(model, context, options);
	};
	service = await PiFlowSessionService.open(session, {
		...options(root),
		...(config.host ? { host: config.host } : {}),
		attachWaitSources: config.attachWaitSources,
		onRebuiltRegistry: config.onRebuiltRegistry,
	});
	afterCleanup(t, async () => {
		await service.close();
	});
	return { root, session, service, requests, treeScopes };
}

// Model a pre-v0.1.15 journal: its header contains the full-digest directory, not
// merely a new journal moved beneath the old directory name.
async function legacyStorage(root, scope, move = true) {
	const current = join(root, pathDigest([scope.sessionId, scope.branchId]));
	const legacy = join(root, legacyPathDigest([scope.sessionId, scope.branchId]));
	const sessions = join(current, "sessions");
	const [folder] = await readdir(sessions);
	const [file] = await readdir(join(sessions, folder));
	const path = join(sessions, folder, file);
	const text = await readFile(path, "utf8");
	const end = text.indexOf("\n");
	const header = JSON.parse(text.slice(0, end));
	header.cwd = legacy;
	await writeFile(path, JSON.stringify(header) + text.slice(end));
	const legacyFolder = `--${legacy.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	await rename(join(sessions, folder), join(sessions, legacyFolder));
	if (move) await rename(current, legacy);
	return { path: join(current, "sessions", legacyFolder, file), header: JSON.stringify(header) };
}

for (const recovery of ["legacy registry", "rebuilt registry", "partially adopted branch"])
	test(`session service reopens full-digest storage with ${recovery}`, async (t) => {
		const first = await fixture(t);
		const scope = first.service.branch().scope;
		const input = FlowModelInput.compose(
			"saved",
			[{ id: "saved", revision: "1", kind: "work", text: "Do work" }],
			4096,
		);
		await first.service.branch().attachment.ledger.select(input.attemptId, input.members);
		const ledger = await first.service.branch().attachment.ledger.snapshot();
		await first.service.close();
		const stored = await legacyStorage(first.root, scope, recovery !== "partially adopted branch");
		if (recovery === "legacy registry")
			await legacyStorage(join(first.root, "session-registry-v1"), {
				sessionId: scope.sessionId,
				branchId: "registry",
			});
		else await rm(join(first.root, "session-registry-v1"), { recursive: true });
		const notices = [];
		const manager = SessionManager.open(first.session.sessionManager.getSessionFile());
		const reopened = await fixture(t, { root: first.root, manager, onRebuiltRegistry: (path) => notices.push(path) });
		assert.deepEqual(reopened.service.branch().scope, scope);
		// Ordinary reattachment cancels an unsent selection and advances the writer generation.
		// Migration must preserve its evidence rather than silently starting an empty ledger.
		delete ledger.activeAttemptId;
		ledger.generation++;
		ledger.revision++;
		ledger.attempts[0].phase = "cancelled";
		ledger.attempts[0].reason = "Unsent handoff cancelled on reattachment.";
		assert.deepEqual(await reopened.service.branch().attachment.ledger.snapshot(), ledger);
		assert.equal(notices.length, recovery === "legacy registry" ? 0 : 1);
		assert.deepEqual(reopened.requests, []);
		assert.equal((await readFile(stored.path, "utf8")).split("\n")[0], stored.header);
		await reopened.service.close();
		const again = await fixture(t, { root: first.root, manager: SessionManager.open(manager.getSessionFile()) });
		assert.deepEqual(again.service.branch().scope, scope);
		ledger.generation++;
		ledger.revision++;
		assert.deepEqual(await again.service.branch().attachment.ledger.snapshot(), ledger);
	});

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

test("resolving an interrupted turn releases the recovery gate it held after reopen", async (t) => {
	const first = await fixture(t);
	const ledger = first.service.branch().attachment.ledger;
	// The input is in the transcript exactly as the flow records it, so the reopen has no missing
	// history evidence: the adopted uncertainty is the only recovery gate left to release.
	const input = FlowModelInput.compose(
		"interrupted",
		[{ id: "work", revision: "1", kind: "work", text: "Interrupted work" }],
		4096,
	);
	await first.session.sendCustomMessage(
		{ customType: "jouzu-flow", content: input.content, display: false },
		{ triggerTurn: false },
	);
	await ledger.select(input.attemptId, input.members);
	await ledger.queued(input.attemptId, { id: "queue", revision: 1 });
	await ledger.claim(input.attemptId, { id: "queue", revision: 1 });
	await ledger.prepare(
		input.attemptId,
		"request",
		input.members.map((member) => ({
			id: member.id,
			revision: member.revision,
			disposition: "included",
			contentHash: member.contentHash,
		})),
		false,
	);
	await ledger.handoff(input.attemptId, "request");
	await first.service.close();
	const next = await fixture(t, {
		root: first.root,
		manager: SessionManager.open(first.session.sessionManager.getSessionFile()),
	});
	const branch = next.service.branch();
	assert.deepEqual(branch.recovery, { recovered: 1, unresolved: 0 });
	const state = await branch.attachment.ledger.snapshot();
	// The reopen adopts the interrupted handoff as uncertain, and its generation stays with the
	// attachment that created it, so resolving it must not require this attachment's ownership.
	assert.equal(state.attempts[0].phase, "uncertain");
	assert.notEqual(state.attempts[0].generation, state.generation);
	assert.equal(branch.host.gate().recoveryBlocked, true);
	await next.service.resolveUncertainAttempt(input.attemptId, "discard");
	const [resolved] = (await branch.attachment.ledger.snapshot()).attempts;
	assert.equal(resolved.phase, "settled");
	assert.equal(resolved.outcome, "failure");
	assert.equal(resolved.reason, "Resolved from /flow as spent.");
	assert.equal(branch.host.gate().recoveryBlocked, false);
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

test("failed navigation recovers its branch on reopen and releases the session lease", async (t) => {
	const { root, session, service } = await fixture(t);
	const original = service.branch().scope;
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
	// The handoff failed before the leaf moved, so the interrupted transition resolves back
	// to the branch that owns the transcript instead of holding the session.
	const reopened = await PiFlowSessionService.open(session, options(root));
	assert.deepEqual(reopened.branch().scope, original);
	await reopened.close();
});

test("session service updates native recovery gates and authorizes one reviewed retry", async (t) => {
	let receipts = false;
	const f = await fixture(t, { retainInputs: true, holdInput: () => !receipts });
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
	const f = await fixture(t, { retainInputs: true, holdInput: () => true });
	const branch = f.service.branch();
	await f.session.prompt("held");
	const [held] = await branch.attachment.nativeRequests.snapshot();
	t.mock.method(branch.host, "atIdle", async () => ({ kind: "busy" }));
	await assert.rejects(f.service.retryNativeRequest(held.id, held.withheldPayload.hash), { code: "busy" });
	assert.equal((await branch.attachment.nativeRequests.snapshot())[0].retryAuthorization, undefined);
	assert.equal(branch.host.gate().recoveryBlocked, true);
});

test("cancelled native input remains excluded after session-service reopen", async (t) => {
	const first = await fixture(t, { retainInputs: true, holdInput: () => true });
	await first.session.prompt("cancelled original");
	const [held] = await first.service.branch().attachment.nativeRequests.snapshot();
	await first.service.cancelNativeSources(held.id, held.withheldPayload.hash, [1]);
	assert.equal(first.service.branch().host.gate().recoveryBlocked, false);
	assert.equal(first.requests.length, 0);
	await first.service.close();
	const next = await fixture(t, {
		root: first.root,
		manager: SessionManager.open(first.session.sessionManager.getSessionFile()),
		retainInputs: true,
	});
	assert.equal(next.service.branch().host.gate().recoveryBlocked, false);
	await next.session.prompt("independent request");
	assert.equal(next.requests.length, 1);
	assert.ok(!JSON.stringify(next.requests).includes("cancelled original"));
	const [original, request] = await next.service.branch().attachment.nativeRequests.snapshot();
	assert.deepEqual(original.cancelledSources, [1]);
	assert.equal(getCurrentSystemPrompt(next.requests[0]), next.session.systemPrompt);
	assert.equal(original.payload, undefined);
	assert.equal(request.outcome, "success");
});

test("session service reconciles an idle queue edit without sending or duplicating history", async (t) => {
	const f = await fixture(t, { retainInputs: true });
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
	const f = await fixture(t, { retainInputs: true });
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
	const f = await fixture(t, { retainInputs: true });
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
	const f = await fixture(t, { retainInputs: true });
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
	const f = await fixture(t, { retainInputs: true });
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
	const f = await fixture(t, { retainInputs: true });
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
	});
	await next.service.cancelNativeQueue(item.id, 1);
	await next.session.prompt("new user input");
	assert.equal(next.requests.length, 1);
	assert.ok(!JSON.stringify(next.requests).includes("cancelled"));
	const [record] = await next.service.branch().attachment.submissions.snapshot();
	assert.equal(record.dispatch.queueCancellations[0].id, item.id);
	assert.equal(record.dispatch.queueClaims[0].consumed, false);
});

test("switching away and back preserves a branch's pending work and late results", async (t) => {
	const scopes = [];
	const f = await fixture(t, {
		attachWaitSources: async (attachment) => {
			scopes.push(attachment.ledger.scope);
			attachment.waitProducers.register(
				{
					version: 1,
					namespace: "bg",
					subscribe: () => () => {},
					snapshot: async (identity) => ({
						...identity,
						revision: 1,
						predicates: [{ until: "exit", state: "pending" }],
					}),
					close: () => {},
				},
				assert.ifError,
			);
		},
	});
	const original = f.service.branch();
	const handle = { producer: "bg", handle: "job", execution: "exec", until: "exit" };
	await original.attachment.waits.declare(
		{
			token: "wait",
			scope: original.scope,
			workId: "work",
			reason: "dependency",
			mode: "all",
			on: [handle],
			expiresAt: 100,
		},
		[{ ...handle, scope: original.scope, workId: "work", state: "pending" }],
		0,
		100,
	);
	// A late result retained against this branch stays readable only through it.
	const reference = await original.attachment.results.retain([
		{
			id: "late",
			producer: "bg",
			execution: "late-exec",
			revision: "1",
			status: "success",
			title: "late",
			reference: "bg-result:late",
			warnings: [],
		},
	]);
	await f.session.prompt("first question");
	const user = f.session.sessionManager
		.getBranch()
		.find((entry) => entry.type === "message" && entry.message.role === "user");
	const tip = f.session.sessionManager.getLeafId();
	// Switching away forks an empty branch: neither the wait nor the result follows.
	await f.session.navigateTree(user.id);
	const fork = f.service.branch();
	assert.notEqual(fork.scope.branchId, original.scope.branchId);
	assert.deepEqual(await fork.attachment.waits.snapshot(), []);
	await assert.rejects(fork.attachment.results.page(reference, { limit: 4, maxBytes: 4096 }), {
		code: "identity",
	});
	// Returning to the original branch's path reactivates it with its durable work intact.
	await f.session.navigateTree(tip);
	assert.deepEqual(f.service.branch().scope, original.scope);
	assert.deepEqual(scopes, [original.scope, fork.scope, original.scope]);
	const back = f.service.branch();
	const waits = await back.attachment.waits.snapshot();
	assert.equal(waits.length, 1);
	assert.equal(waits[0].token, "wait");
	assert.equal(waits[0].state, "waiting");
	assert.deepEqual(back.waitSourceRecovery.missing, []);
	assert.equal(back.host.gate().recoveryBlocked, false);
	const page = await back.attachment.results.page(reference, { limit: 4, maxBytes: 4096 });
	assert.equal(page.total, 1);
	assert.equal(page.members[0].id, "late");
	// The branch owning the newest transcript entry survives a keep-one retirement: append on
	// the reactivated branch, switch away again, retire, and reopen at the tip it owns.
	await f.session.prompt("more on the original branch");
	const forkMarker = f.session.sessionManager
		.getEntries()
		.find((entry) => entry.type === "custom" && entry.data?.branchId === fork.scope.branchId);
	await f.session.navigateTree(forkMarker.id);
	assert.deepEqual(f.service.branch().scope, fork.scope);
	await f.service.retireResultHistory(1, 1);
	await f.service.close();
	const reopened = await fixture(t, {
		root: f.root,
		manager: SessionManager.open(f.session.sessionManager.getSessionFile()),
	});
	assert.deepEqual(reopened.service.branch().scope, original.scope, "the tip owner rebinds after retirement");
});

for (const annotation of ["summary", "label"])
	for (const destination of ["rewind", "resume"])
		for (const interrupted of [false, true])
			test(`${annotation} ${destination} preserves navigation semantics, interrupted=${interrupted}`, async (t) => {
				const f = await fixture(t, { summary: true });
				const original = f.service.branch();
				await f.session.prompt("first turn");
				const early = f.session.sessionManager.getLeafId();
				await f.session.prompt("second turn");
				const departure = f.session.sessionManager.getLeafId();
				const handle = { producer: "bg", handle: "job", execution: "exec", until: "exit" };
				await original.attachment.waits.declare(
					{
						token: "later-wait",
						scope: original.scope,
						workId: "work",
						reason: "dependency",
						mode: "all",
						on: [handle],
						expiresAt: 100,
					},
					[{ ...handle, scope: original.scope, workId: "work", state: "pending" }],
					0,
					100,
				);
				await f.session.navigateTree(early);
				assert.deepEqual(await f.service.branch().attachment.waits.snapshot(), []);
				const target = destination === "rewind" ? early : departure;
				const navigation = annotation === "summary" ? { summarize: true } : { label: "Saved position" };
				let branch;
				if (interrupted) {
					t.mock.method(f.service, "branchChanged", async () => {
						throw new Error("interrupted before marker");
					});
					await assert.rejects(f.session.navigateTree(target, navigation), /interrupted before marker/);
					await f.service.close();
					const next = await fixture(t, {
						root: f.root,
						manager: SessionManager.open(f.session.sessionManager.getSessionFile()),
					});
					branch = next.service.branch();
				} else {
					await f.session.navigateTree(target, navigation);
					branch = f.service.branch();
				}
				assert.equal(branch.scope.branchId === original.scope.branchId, destination === "resume");
				assert.deepEqual(
					(await branch.attachment.waits.snapshot()).map((wait) => wait.token),
					destination === "resume" ? ["later-wait"] : [],
				);
			});

test("repeated unsummarized rewinds exclude work declared after the selected entry", async (t) => {
	const f = await fixture(t);
	const original = f.service.branch();
	await f.session.prompt("first turn");
	const early = f.session.sessionManager.getLeafId();
	await f.session.prompt("second turn");
	await original.attachment.waits.registerWork("later-work", "lane", 0);
	for (let visit = 0; visit < 3; visit++) {
		await f.session.navigateTree(early);
		assert.notEqual(f.service.branch().scope.branchId, original.scope.branchId);
		assert.deepEqual((await f.service.branch().attachment.waits.authoritySnapshot()).work, []);
	}
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
	const sourceErrors = [];
	const unavailable = await PiFlowSessionService.open(first.session, {
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
				(error) => sourceErrors.push(error),
			);
		},
	});
	t.after(() => unavailable.close());
	assert.deepEqual(unavailable.branch().waitSourceRecovery, { restored: 0, missing: ["bg"] });
	assert.equal(unavailable.branch().host.gate().recoveryBlocked, true);
	assert.equal(sourceErrors.length, 1);
	assert.match(sourceErrors[0].cause.message, /snapshot unavailable/);
	await unavailable.close();
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

for (const lane of ["steer", "followUp"])
	test(`consumed ${lane} input revokes selected work authority during the same native run`, async (t) => {
		let branch,
			calls = 0,
			authority;
		const f = await fixture(t, {
			retainInputs: true,
			host: {
				maxPayloadBytes: 100000,
				containsUserInput: () => calls > 0,
			},
			async onRequest() {
				calls++;
				if (calls === 1) {
					authority = branch.workContext.authorize("selected-work");
					await f.session.prompt("New user instructions", { streamingBehavior: lane });
					authority.assertActive();
				} else {
					assert.throws(() => authority.assertActive(), { code: "stale" });
					assert.throws(() => branch.workContext.current(), { code: "stale" });
				}
			},
		});
		branch = f.service.branch();
		await branch.attachment.waits.registerWork("selected-work", "lane", 0);
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
						workRevision: "1",
						independent: false,
						runnable: true,
					},
				];
			},
			async build() {
				return { id: "instruction", revision: "1", kind: "work", text: "Perform selected work" };
			},
		});
		await branch.controller.wake();
		assert.equal(calls, 2);
		assert.equal(f.requests.length, 2);
		assert.throws(() => authority.assertActive(), { code: "stale" });
	});
