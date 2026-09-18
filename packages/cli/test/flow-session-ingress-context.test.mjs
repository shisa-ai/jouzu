import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { afterCleanup } from "./fixtures/cleanup.mjs";
import { fixture } from "./fixtures/flow-session-ingress.mjs";

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
					...observer,
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
	afterCleanup(t, () => release.resolve());
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

test("unavailable user input stays inspectable without blocking work after reopen", async (t) => {
	const first = await fixture(t, { admit: async () => false });
	await first.session.prompt("retained across reopen");
	const [record] = await first.ingress.branch().attachment.submissions.snapshot();
	await first.ingress.dispose();
	const next = await fixture(t, {
		root: first.root,
		manager: SessionManager.open(first.session.sessionManager.getSessionFile()),
	});
	assert.equal(next.ingress.branch().host.gate().userPending, false);
	const [recovered] = await next.ingress.branch().attachment.submissions.snapshot();
	assert.equal(recovered.unavailable, "callback-ended");
	assert.deepEqual(recovered.submission, record.submission);
	assert.match((await next.ingress.heldInputs())[0].reason, /Submit it again/);
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
