import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { FlowLedgerError } from "../dist/flow-control/receipt-ledger.js";
import { assembledSession, installedProducerExtensions, replacedSession } from "./fixtures/flow-assembly.mjs";

for (const release of [false, true])
	test(`compacted undelivered input recovers across clear and reopen: release=${release}`, async (t) => {
		const producers = await installedProducerExtensions();
		const f = await assembledSession(t, { persist: true, producerExtensions: producers });
		const store = f.ingress.branch().attachment.nativeRequests;
		const begin = store.begin.bind(store);
		store.begin = async () => {
			throw new FlowLedgerError("capacity", "Injected full native store");
		};
		await f.session.prompt("Old input that never reached the provider");
		store.begin = begin;
		assert.equal(f.bodies.length, 0);
		const undelivered = (await f.ingress.branch().attachment.submissions.snapshot()).find((record) =>
			JSON.stringify(record.submission).includes("Old input that never reached the provider"),
		);
		assert.ok(undelivered, "failed input remains available for inspection and explicit resubmission");
		assert.match(f.ingress.automatedPause(), /flow admission failed/);
		const manager = f.sessionManager;
		manager.appendCompaction("Earlier request failed before delivery.", manager.getLeafId(), 100);
		manager.flush();
		const file = manager.getSessionFile();
		const next = await replacedSession(t, f, {
			reason: "resume",
			persist: true,
			sessionManager: SessionManager.open(file),
			producerExtensions: producers,
		});
		if (release) await next.session.prompt("/flow clear");
		const recovered = (await next.ingress.branch().attachment.submissions.snapshot()).find(
			(record) => record.id === undelivered.id,
		);
		assert.deepEqual(
			recovered?.submission,
			undelivered.submission,
			"compaction/reset preserves the exact undelivered input",
		);
		await next.session.prompt("Continue with current input");
		await next.session.prompt("Another current input");
		assert.equal(next.bodies.length, 2);
		assert.ok(!JSON.stringify(next.bodies).includes("Old input that never reached the provider"));
		assert.equal((await next.ingress.branch().attachment.nativeRequests.reconciledSources()).size, 1);
		const after = await replacedSession(t, next, {
			reason: "resume",
			persist: true,
			sessionManager: SessionManager.open(file),
			producerExtensions: producers,
		});
		await after.session.prompt("Continue after another reopen");
		assert.equal(after.bodies.length, 1);
		const retained = (await after.ingress.branch().attachment.submissions.snapshot()).find(
			(record) => record.id === undelivered.id,
		);
		assert.deepEqual(
			retained?.submission,
			undelivered.submission,
			"a second reopen does not erase failed input or turn it into successful delivery",
		);
		assert.deepEqual(f.errors, []);
		assert.deepEqual(next.errors, []);
		assert.deepEqual(after.errors, []);
	});

test("terminal admission failure holds the next automated input without consuming retries", async (t) => {
	let endings = 0;
	const producers = await installedProducerExtensions();
	const f = await assembledSession(t, {
		producerExtensions: [
			...producers,
			{
				name: "retrying-producer",
				factory(pi) {
					pi.on("agent_end", () => {
						endings++;
						if (endings < 5) pi.sendUserMessage("Retry after failure", { deliverAs: "followUp" });
					});
				},
			},
		],
	});
	const store = f.ingress.branch().attachment.nativeRequests;
	const original = store.begin.bind(store);
	store.begin = async () => {
		throw new FlowLedgerError("capacity", "Injected full store");
	};
	await f.session.prompt("Trigger admission failure");
	await f.session.waitForIdle();
	assert.equal(endings, 1);
	assert.equal(f.bodies.length, 0);
	assert.match(f.ingress.automatedPause(), /flow admission failed/);
	const retained = await f.ingress.branch().attachment.submissions.snapshot();
	assert.ok(retained.some((record) => !record.dispatch?.promptClaims?.length));
	store.begin = original;
});

test("clear preserves successful receipts and records unresolved outcomes without claiming success", async (t) => {
	const f = await assembledSession(t, { persist: true, producerExtensions: await installedProducerExtensions() });
	await f.session.prompt("Delivered input");
	const store = f.ingress.branch().attachment.nativeRequests;
	const before = await store.snapshot();
	await f.session.prompt("/flow clear");
	assert.deepEqual(await store.snapshot(), before);
	await store.begin({
		id: "unfinished",
		sourceHash: "a".repeat(64),
		transformedHash: "b".repeat(64),
		modelHash: "c".repeat(64),
		systemHash: "d".repeat(64),
	});
	await f.session.prompt("/flow clear");
	const unresolved = (await store.snapshot()).find((record) => record.id === "unfinished");
	assert.equal(unresolved.reset, true);
	assert.equal(unresolved.outcome, undefined);
	assert.equal(store.recoveryBlocked, false);
	await f.session.prompt("Continue after unresolved recovery");
	await f.session.prompt("Continue again");
	assert.equal(f.bodies.length, 3);
	assert.deepEqual(f.errors, []);
});

test("clear preserves live queued input and does not replay a delivered request", async (t) => {
	const f = await assembledSession(t, { producerExtensions: await installedProducerExtensions() });
	await f.session.prompt("Delivered once");
	await f.session.followUp("Still queued");
	const queued = structuredClone(f.session.agent.inspectQueuedMessages());
	assert.equal(queued.length, 1);
	await f.session.prompt("/flow clear");
	assert.deepEqual(f.session.agent.inspectQueuedMessages(), queued);
	assert.equal(f.bodies.length, 1);
	await f.session.prompt("Start next work");
	await f.session.waitForIdle();
	assert.equal(f.bodies.length, 3);
	assert.deepEqual(f.errors, []);
});

test("compaction inside a running session rebinds kept sources and reconciles excluded failures", async (t) => {
	const f = await assembledSession(t, { persist: true, producerExtensions: await installedProducerExtensions() });
	const store = f.ingress.branch().attachment.nativeRequests;
	const begin = store.begin.bind(store);
	store.begin = async () => {
		throw new FlowLedgerError("capacity", "Injected admission failure");
	};
	await f.session.prompt("Excluded failed input");
	await f.session.prompt("Retained failed input");
	store.begin = begin;
	const manager = f.sessionManager;
	const kept = manager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user");
	manager.appendCompaction("An earlier input was not delivered.", kept.id, 100);
	manager.flush();
	f.session.agent.state.messages = manager.buildSessionContext().messages;
	await f.session.prompt("Continue after compaction");
	await f.session.prompt("Continue once more");
	assert.equal(f.bodies.length, 2);
	assert.ok(JSON.stringify(f.bodies[0]).includes("Retained failed input"));
	assert.ok(!JSON.stringify(f.bodies[0]).includes("Excluded failed input"));
	assert.equal((await store.reconciledSources()).size, 1);
	assert.deepEqual(f.errors, []);
});

test("source reconciliation rejects malformed identities and altered compacted history", async (t) => {
	const f = await assembledSession(t, { persist: true, producerExtensions: await installedProducerExtensions() });
	const store = f.ingress.branch().attachment.nativeRequests;
	await assert.rejects(store.reconcileSources([{ operationId: "x", queue: { id: "q", revision: 0 } }], "compacted"), {
		code: "identity",
	});
	await assert.rejects(
		store.reconcileSources([{ operationId: "x", prompt: { inputIndex: 0, messageIndex: 0 } }], "invented"),
		{ code: "identity" },
	);
	await f.session.prompt("Original source");
	const before = await store.snapshot();
	const manager = f.sessionManager;
	const source = manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
	manager.appendCompaction("Summary", manager.getLeafId(), 100);
	manager.flush();
	source.timestamp = "2000-01-01T00:00:00.000Z";
	f.session.agent.state.messages = manager.buildSessionContext().messages;
	await f.session.prompt("Do not accept changed history");
	assert.equal(f.bodies.length, 1);
	assert.match(f.session.agent.state.errorMessage, /Source recovery history differs/);
	assert.equal((await store.reconciledSources()).size, 0);
	assert.deepEqual(await store.snapshot(), before);
});

test("compacted failed input recovers within a memory-only session", async (t) => {
	const f = await assembledSession(t, { producerExtensions: await installedProducerExtensions() });
	const store = f.ingress.branch().attachment.nativeRequests;
	const begin = store.begin.bind(store);
	store.begin = async () => {
		throw new FlowLedgerError("capacity", "Injected admission failure");
	};
	await f.session.prompt("Undelivered memory input");
	store.begin = begin;
	const manager = f.sessionManager;
	assert.equal(manager.isPersisted(), false);
	manager.appendCompaction("Earlier request failed.", manager.getLeafId(), 100);
	f.session.agent.state.messages = manager.buildSessionContext().messages;
	await f.session.prompt("Continue");
	await f.session.prompt("Continue again");
	assert.equal(f.bodies.length, 2);
	assert.equal((await store.reconciledSources()).size, 1);
	assert.ok(!JSON.stringify(f.bodies).includes("Undelivered memory input"));
	assert.deepEqual(f.errors, []);
});
