import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createFlowSession, deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { FlowModelInput } from "../dist/flow-control/model-input.js";
import { PiFlowSessionService } from "../dist/flow-control/pi-session-service.js";

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
		return native(model, context, options);
	};
	service = await PiFlowSessionService.open(session, options(root));
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
