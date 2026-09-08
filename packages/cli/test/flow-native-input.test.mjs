import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFlowSession, deferred, tick } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { PiNativeDispatch } from "../dist/flow-control/pi-native-dispatch.js";
import { projectFlowSubmissions } from "../dist/flow-control/submission-view.js";

async function fixture(t, extensions = [], beforeNative) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-native-input-"));
	let attachment, native;
	const { session, requests } = await createFlowSession(t, {
		persist: true,
		extensions,
		ingress: {
			version: 1,
			async submit(input, dispatch) {
				const saved = await attachment.submissions.retain(input);
				await native.dispatch(saved.id, saved.revision, input.id, dispatch);
			},
		},
	});
	const scope = { sessionId: session.sessionId, branchId: "main" };
	attachment = await PiFlowAttachment.open(root, scope);
	beforeNative?.(session);
	native = new PiNativeDispatch(session, attachment.submissions);
	t.after(async () => {
		session.agent.clearAllQueues();
		await native.close();
		await attachment.close();
		await rm(root, { recursive: true, force: true });
	});
	return { root, scope, session, requests, native, attachment };
}

for (const handled of [false, true])
	test(`native prompt observation follows input handling once: handled=${handled}`, async (t) => {
		let transforms = 0;
		const f = await fixture(t, [
			(pi) => {
				pi.on("input", () => {
					transforms++;
					return handled ? { action: "handled" } : { action: "transform", text: "normalized" };
				});
				pi.on("before_agent_start", () => ({
					message: { customType: "context", content: "native context", display: false, details: { n: 1 } },
				}));
			},
		]);
		const images = [{ type: "image", data: "YQ==", mimeType: "image/png" }];
		await f.session.prompt("original", { images });
		const [record] = await f.attachment.submissions.snapshot();
		assert.equal(transforms, 1);
		assert.equal(record.submission.args[0], "original");
		assert.equal(record.dispatch.phase, "returned");
		assert.equal(f.requests.length, handled ? 0 : 1);
		if (handled) {
			assert.equal(record.dispatch.inputs, undefined);
			assert.equal(record.dispatch.promptHistory, undefined);
		} else {
			assert.equal(record.dispatch.inputs.length, 1);
			const input = record.dispatch.inputs[0];
			assert.equal(input.kind, "prompt");
			assert.equal(input.args[0][0].content[0].text, "normalized");
			assert.deepEqual(input.args[0][0].content[1], images[0]);
			assert.equal(input.args[0][1].customType, "context");
			assert.deepEqual(input.args[0][1].details, { n: 1 });
			assert.deepEqual(
				record.dispatch.promptHistory.map(({ inputIndex, messageIndex }) => ({ inputIndex, messageIndex })),
				[
					{ inputIndex: 0, messageIndex: 0 },
					{ inputIndex: 0, messageIndex: 1 },
				],
			);
			assert.notEqual(record.dispatch.promptHistory[0].entryId, record.dispatch.promptHistory[1].entryId);
			await f.native.close();
			await f.attachment.close();
			const reopened = await PiFlowAttachment.open(f.root, f.scope);
			assert.deepEqual((await reopened.submissions.snapshot())[0].dispatch.inputs, record.dispatch.inputs);
			assert.deepEqual(
				(await reopened.submissions.snapshot())[0].dispatch.promptHistory,
				record.dispatch.promptHistory,
			);
			await reopened.close();
		}
	});

test("native queue consumption waits for its exact input observation", async (t) => {
	const f = await fixture(t);
	const entered = deferred(),
		release = deferred();
	const dispatch = f.attachment.submissions.dispatch.bind(f.attachment.submissions);
	t.mock.method(f.attachment.submissions, "dispatch", (id, revision, operation, run) =>
		dispatch(id, revision, operation, (observer, submission) =>
			run(
				{
					observe: async (input) => {
						entered.resolve();
						await release.promise;
						return observer.observe(input);
					},
				},
				submission,
			),
		),
	);
	const enqueuing = f.session.followUp("queued");
	await entered.promise;
	const [item] = f.session.agent.inspectQueuedMessages();
	const running = f.session.continueQueued();
	await tick();
	assert.equal(f.requests.length, 0);
	release.resolve();
	await Promise.all([enqueuing, running]);
	assert.equal(f.requests.length, 1);
	const [record] = await f.attachment.submissions.snapshot();
	assert.deepEqual(record.dispatch.inputs[0].queue, { id: item.id, revision: item.revision });
	assert.equal(record.dispatch.inputs[0].args[0].content[0].text, "queued");
	assert.deepEqual(record.dispatch.queueClaims, [{ id: item.id, revision: item.revision, consumed: true }]);
	const [view] = projectFlowSubmissions([record], await f.attachment.ledger.snapshot());
	assert.equal(view.delivery, "history");
	assert.equal(view.admission, "held");
});

for (const kind of ["prompt", "followUp"])
	test(`failed observation prevents native ${kind} consumption`, async (t) => {
		const f = await fixture(t);
		const dispatch = f.attachment.submissions.dispatch.bind(f.attachment.submissions);
		t.mock.method(f.attachment.submissions, "dispatch", (id, revision, operation, run) =>
			dispatch(id, revision, operation, (_observer, submission) =>
				run(
					{
						observe: async () => {
							throw new Error("observation storage failed");
						},
					},
					submission,
				),
			),
		);
		await assert.rejects(f.session[kind]("must not run"), /observation storage failed/);
		assert.equal(f.requests.length, 0);
		assert.deepEqual(f.session.agent.inspectQueuedMessages(), []);
		assert.equal((await f.attachment.submissions.snapshot())[0].dispatch.phase, "failed");
	});

test("edited native queue input cannot reuse observation of its earlier revision", async (t) => {
	const f = await fixture(t);
	await f.session.followUp("original");
	const [item] = f.session.agent.inspectQueuedMessages();
	f.session.agent.editQueuedMessage(item.id, item.revision, { role: "user", content: "edited", timestamp: 1 });
	await f.session.continueQueued();
	assert.equal(f.requests.length, 0);
	assert.equal(f.session.agent.inspectQueuedMessages()[0].message.content, "edited");
	assert.match(f.native.heldInputs()[0].reason, /Edited native input/);
});

test("a failed write holds a concurrently edited queue entry without a retry loop", async (t) => {
	const f = await fixture(t);
	const entered = deferred(),
		release = deferred();
	const dispatch = f.attachment.submissions.dispatch.bind(f.attachment.submissions);
	t.mock.method(f.attachment.submissions, "dispatch", (id, revision, operation, run) =>
		dispatch(id, revision, operation, (_observer, submission) =>
			run(
				{
					observe: async () => {
						entered.resolve();
						await release.promise;
						throw new Error("write failed");
					},
				},
				submission,
			),
		),
	);
	const enqueuing = assert.rejects(f.session.followUp("original"), /write failed/);
	await entered.promise;
	const [item] = f.session.agent.inspectQueuedMessages();
	f.session.agent.editQueuedMessage(item.id, item.revision, { role: "user", content: "edited", timestamp: 1 });
	const running = f.session.continueQueued();
	release.resolve();
	await Promise.all([enqueuing, running]);
	assert.equal(f.requests.length, 0);
	assert.equal(f.session.agent.inspectQueuedMessages()[0].message.content, "edited");
	assert.match(f.native.heldInputs()[0].reason, /could not be retained/);
});

test("close cancels unconsumed native input while preserving its observation", async (t) => {
	const f = await fixture(t);
	await f.session.followUp("retained for reconciliation");
	const [before] = await f.attachment.submissions.snapshot();
	await f.native.close();
	assert.deepEqual(f.session.agent.inspectQueuedMessages(), []);
	const [after] = await f.attachment.submissions.snapshot();
	assert.deepEqual(after.submission, before.submission);
	assert.deepEqual(after.dispatch.inputs, before.dispatch.inputs);
	assert.deepEqual(after.dispatch.queueClaims, [{ ...before.dispatch.inputs[0].queue, consumed: false }]);
	assert.equal(projectFlowSubmissions([after], await f.attachment.ledger.snapshot())[0].delivery, "none");
	assert.equal(f.requests.length, 0);
});

test("native consumption is retained before model execution and survives reopen", async (t) => {
	const f = await fixture(t);
	await f.session.followUp("queue receipt");
	const entered = deferred(),
		release = deferred();
	const recordClaim = f.attachment.submissions.recordQueueClaim.bind(f.attachment.submissions);
	t.mock.method(f.attachment.submissions, "recordQueueClaim", async (...args) => {
		entered.resolve();
		await release.promise;
		return recordClaim(...args);
	});
	const running = f.session.continueQueued();
	await entered.promise;
	assert.equal(f.requests.length, 0);
	assert.deepEqual(f.session.agent.inspectQueuedMessages(), []);
	release.resolve();
	await running;
	const [before] = await f.attachment.submissions.snapshot();
	const [claim] = before.dispatch.queueClaims;
	await recordClaim(before.dispatch.operationId, claim, true);
	await assert.rejects(recordClaim(before.dispatch.operationId, claim, false), { code: "identity" });
	await assert.rejects(recordClaim(before.dispatch.operationId, { id: "foreign", revision: 1 }, true), {
		code: "identity",
	});
	await f.native.close();
	await f.attachment.close();
	const reopened = await PiFlowAttachment.open(f.root, f.scope);
	try {
		assert.deepEqual((await reopened.submissions.snapshot())[0].dispatch.queueClaims, before.dispatch.queueClaims);
		await assert.rejects(reopened.submissions.recordQueueClaim(before.dispatch.operationId, claim, true), {
			code: "stale",
		});
	} finally {
		await reopened.close();
	}
	assert.equal(f.requests.length, 1);
});

for (const phase of [
	"before",
	"after",
	"history-before",
	"history-after",
	"prompt-before",
	"prompt-after",
	"prompt-claim-before",
	"prompt-claim-after",
])
	test(`process death at native receipt checkpoint ${phase} cannot authorize replay`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "jouzu-native-claim-kill-"));
		let attachment;
		const child = fork(new URL("./fixtures/flow-native-claim-crash.mjs", import.meta.url), [root, phase], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		const exited = once(child, "exit");
		t.after(async () => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await exited;
			}
			await attachment?.close();
			await rm(root, { recursive: true, force: true });
		});
		const [saved] = await Promise.race([
			once(child, "message"),
			exited.then(() => {
				throw new Error("Native claim fixture exited before checkpoint");
			}),
		]);
		assert.equal(saved.requests, 0);
		assert.equal(saved.queued, 0);
		child.kill("SIGKILL");
		await exited;
		attachment = await PiFlowAttachment.open(join(root, "receipts"), saved.scope);
		const [record] = await attachment.submissions.snapshot();
		assert.equal(
			record.dispatch.queueClaims?.[0]?.consumed,
			phase === "before" || phase.startsWith("prompt-") ? undefined : true,
		);
		assert.equal(!!record.dispatch.queueHistory?.length, phase === "history-after");
		assert.equal(!!record.dispatch.promptHistory?.length, phase === "prompt-after");
		assert.equal(
			!!record.dispatch.promptClaims?.length,
			phase.startsWith("prompt-") && phase !== "prompt-claim-before",
		);
		await assert.rejects(
			attachment.submissions.dispatch(record.id, record.revision, "retry", async () => {
				throw new Error("replayed");
			}),
			{ code: "transition" },
		);
		assert.equal(
			projectFlowSubmissions([record], await attachment.ledger.snapshot())[0].delivery,
			["history-after", "prompt-after"].includes(phase)
				? "history"
				: ["before", "prompt-claim-before"].includes(phase)
					? "uncertain"
					: "consumed",
		);
	});

test("native queue history is durable before the provider and rejects conflicting receipts", async (t) => {
	const f = await fixture(t);
	await f.session.followUp("history receipt");
	const entered = deferred(),
		release = deferred();
	const recordHistory = f.attachment.submissions.recordQueueHistory.bind(f.attachment.submissions);
	t.mock.method(f.attachment.submissions, "recordQueueHistory", async (...args) => {
		entered.resolve();
		await release.promise;
		return recordHistory(...args);
	});
	const running = f.session.continueQueued();
	await entered.promise;
	assert.equal(f.requests.length, 0);
	const [consumed] = await f.attachment.submissions.snapshot();
	assert.equal(consumed.dispatch.queueClaims[0].consumed, true);
	assert.equal(consumed.dispatch.queueHistory, undefined);
	release.resolve();
	await running;
	const [saved] = await f.attachment.submissions.snapshot();
	const [receipt] = saved.dispatch.queueHistory;
	const entry = f.session.sessionManager.getEntry(receipt.entryId);
	assert.equal(entry.message.content[0].text, "history receipt");
	assert.equal(receipt.entryHash, createHash("sha256").update(JSON.stringify(entry)).digest("hex"));
	await recordHistory(saved.dispatch.operationId, receipt);
	await assert.rejects(recordHistory(saved.dispatch.operationId, { ...receipt, entryHash: "a".repeat(64) }), {
		code: "identity",
	});
	await assert.rejects(recordHistory(saved.dispatch.operationId, { ...receipt, id: "foreign" }), { code: "identity" });
	assert.equal(projectFlowSubmissions([saved], await f.attachment.ledger.snapshot())[0].delivery, "history");
	await f.native.close();
	await f.attachment.close();
	const reopened = await PiFlowAttachment.open(f.root, f.scope);
	try {
		assert.deepEqual((await reopened.submissions.snapshot())[0].dispatch.queueHistory, saved.dispatch.queueHistory);
		await assert.rejects(reopened.submissions.recordQueueHistory(saved.dispatch.operationId, receipt), {
			code: "stale",
		});
	} finally {
		await reopened.close();
	}
});

test("duplicate native messages and an unowned queue entry retain distinct history identities", async (t) => {
	const f = await fixture(t);
	const images = [{ type: "image", data: "YQ==", mimeType: "image/png" }];
	await f.session.followUp("same", images);
	f.session.agent.followUp({ role: "user", content: [{ type: "text", text: "unowned" }], timestamp: 1 });
	await f.session.followUp("same", images);
	await f.session.continueQueued();
	const records = await f.attachment.submissions.snapshot();
	assert.equal(records.length, 2);
	const receipts = records.map((record) => record.dispatch.queueHistory[0]);
	assert.notEqual(receipts[0].id, receipts[1].id);
	assert.notEqual(receipts[0].entryId, receipts[1].entryId);
	for (const receipt of receipts) {
		const entry = f.session.sessionManager.getEntry(receipt.entryId);
		assert.equal(entry.message.content[0].text, "same");
		assert.deepEqual(entry.message.content[1], images[0]);
	}
});

test("native history write failure prevents provider execution without replay authority", async (t) => {
	const f = await fixture(t);
	await f.session.followUp("must persist");
	t.mock.method(f.attachment.submissions, "recordQueueHistory", async () => {
		throw new Error("receipt unavailable");
	});
	await f.session.continueQueued();
	assert.match(f.session.agent.state.errorMessage, /receipt unavailable/);
	assert.equal(f.requests.length, 0);
	const [saved] = await f.attachment.submissions.snapshot();
	assert.equal(saved.dispatch.queueClaims[0].consumed, true);
	assert.equal(saved.dispatch.queueHistory, undefined);
	await assert.rejects(
		f.native.dispatch(saved.id, saved.revision, "replay", async () => {}),
		{ code: "transition" },
	);
});

test("native history does not acknowledge a message changed after message_start", async (t) => {
	const f = await fixture(t, [], (session) => {
		session.agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "user") event.message.content[0].text = "changed";
		});
	});
	await f.session.followUp("original");
	await f.session.continueQueued();
	assert.equal(f.requests.length, 0);
	assert.match(f.session.agent.state.errorMessage, /changed before history persistence/);
	const [saved] = await f.attachment.submissions.snapshot();
	assert.equal(saved.dispatch.queueHistory, undefined);
});

test("buffered transcript input cannot become a native history receipt", async (t) => {
	const f = await fixture(t);
	t.mock.method(f.session.sessionManager, "flush", () => {});
	await f.session.followUp("buffered");
	await f.session.continueQueued();
	assert.equal(f.requests.length, 0);
	assert.match(f.session.agent.state.errorMessage, /was not persisted/);
	assert.equal((await f.attachment.submissions.snapshot())[0].dispatch.queueHistory, undefined);
});

test("direct prompt history waits before provider execution and validates exact batch positions", async (t) => {
	const f = await fixture(t);
	const entered = deferred(),
		release = deferred();
	const write = f.attachment.submissions.recordPromptHistory.bind(f.attachment.submissions);
	t.mock.method(f.attachment.submissions, "recordPromptHistory", async (...args) => {
		entered.resolve();
		await release.promise;
		return write(...args);
	});
	const running = f.session.prompt("direct");
	await entered.promise;
	assert.equal(f.requests.length, 0);
	assert.equal((await f.attachment.submissions.snapshot())[0].dispatch.promptHistory, undefined);
	assert.deepEqual((await f.attachment.submissions.snapshot())[0].dispatch.promptClaims, [
		{ inputIndex: 0, messageIndex: 0 },
	]);
	release.resolve();
	await running;
	const [saved] = await f.attachment.submissions.snapshot();
	const [receipt] = saved.dispatch.promptHistory;
	const entry = f.session.sessionManager.getEntry(receipt.entryId);
	assert.equal(receipt.entryHash, createHash("sha256").update(JSON.stringify(entry)).digest("hex"));
	await write(saved.dispatch.operationId, receipt);
	await f.attachment.submissions.recordPromptClaim(saved.dispatch.operationId, receipt);
	await assert.rejects(
		f.attachment.submissions.recordPromptClaim(saved.dispatch.operationId, { inputIndex: 0, messageIndex: 10 }),
		{ code: "identity" },
	);
	for (const change of [
		{ inputIndex: -1 },
		{ inputIndex: 1 },
		{ messageIndex: 1 },
		{ entryHash: "bad" },
		{ entryId: "different" },
	])
		await assert.rejects(write(saved.dispatch.operationId, { ...receipt, ...change }), { code: "identity" });
	assert.equal(projectFlowSubmissions([saved], await f.attachment.ledger.snapshot())[0].delivery, "history");
	await f.native.close();
	await f.attachment.close();
	const reopened = await PiFlowAttachment.open(f.root, f.scope);
	try {
		assert.deepEqual((await reopened.submissions.snapshot())[0].dispatch.promptHistory, saved.dispatch.promptHistory);
		await assert.rejects(reopened.submissions.recordPromptHistory(saved.dispatch.operationId, receipt), {
			code: "stale",
		});
	} finally {
		await reopened.close();
	}
});

test("failed direct prompt history stops the provider and a later prompt gets its own receipt", async (t) => {
	const f = await fixture(t);
	const write = f.attachment.submissions.recordPromptHistory.bind(f.attachment.submissions);
	let fail = true;
	t.mock.method(f.attachment.submissions, "recordPromptHistory", (...args) => {
		if (fail) throw new Error("prompt history unavailable");
		return write(...args);
	});
	await f.session.prompt("failed");
	assert.equal(f.requests.length, 0);
	assert.match(f.session.agent.state.errorMessage, /prompt history unavailable/);
	fail = false;
	await f.session.prompt("later");
	const [failed, later] = await f.attachment.submissions.snapshot();
	assert.equal(failed.dispatch.promptHistory, undefined);
	assert.equal(later.dispatch.promptHistory.length, 1);
	assert.equal(
		f.session.sessionManager.getEntry(later.dispatch.promptHistory[0].entryId).message.content[0].text,
		"later",
	);
	assert.equal(f.requests.length, 1);
});

test("native string prompts preserve Pi normalization and image history", async (t) => {
	const f = await fixture(t);
	await f.session.prompt("seed");
	const [seed] = await f.attachment.submissions.snapshot();
	const saved = await f.attachment.submissions.retain({ ...seed.submission, id: "string-prompt" });
	const images = [{ type: "image", data: "YQ==", mimeType: "image/png" }];
	await f.native.dispatch(saved.id, saved.revision, "string-operation", () => f.session.agent.prompt("string", images));
	const record = (await f.attachment.submissions.snapshot())[1];
	const entry = f.session.sessionManager.getEntry(record.dispatch.promptHistory[0].entryId);
	assert.deepEqual(entry.message.content, [{ type: "text", text: "string" }, ...images]);
	assert.ok(entry.message.timestamp > 0);
});

test("a rejected concurrent native prompt cannot acquire the active prompt's history", async (t) => {
	const f = await fixture(t);
	const entered = deferred(),
		release = deferred();
	const stream = f.session.agent.streamFunction;
	f.session.agent.streamFunction = async (...args) => {
		entered.resolve();
		await release.promise;
		return stream(...args);
	};
	const running = f.session.prompt("active");
	await entered.promise;
	const [active] = await f.attachment.submissions.snapshot();
	const rejected = await f.attachment.submissions.retain({ ...active.submission, id: "concurrent" });
	await assert.rejects(
		f.native.dispatch(rejected.id, rejected.revision, "concurrent-operation", () =>
			f.session.agent.prompt("concurrent"),
		),
		/already processing/,
	);
	release.resolve();
	await running;
	await f.session.prompt("later");
	const records = await f.attachment.submissions.snapshot();
	assert.equal(records[0].dispatch.promptHistory.length, 1);
	assert.equal(records[1].dispatch.promptClaims, undefined);
	assert.equal(records[1].dispatch.promptHistory, undefined);
	assert.equal(records[2].dispatch.promptHistory.length, 1);
	assert.equal(f.requests.length, 2);
});

test("reconciled queue edits retain both revisions and consume only edited input", async (t) => {
	const f = await fixture(t);
	await f.session.followUp("original");
	const [item] = f.session.agent.inspectQueuedMessages();
	f.session.agent.editQueuedMessage(item.id, item.revision, { role: "user", content: "edited", timestamp: 1 });
	await f.native.reconcileQueueEdit(item.id, 2);
	await f.native.reconcileQueueEdit(item.id, 2);
	const [before] = await f.attachment.submissions.snapshot();
	assert.equal(before.dispatch.inputs.length, 2);
	assert.equal(before.submission.args[0], "original");
	assert.equal(before.dispatch.inputs[1].args[0].content, "edited");
	assert.deepEqual(before.dispatch.queueClaims, [{ id: item.id, revision: 1, consumed: false }]);
	assert.equal(f.requests.length, 0);
	await f.session.continueQueued();
	assert.equal(f.requests.length, 1);
	assert.ok(JSON.stringify(f.requests).includes("edited"));
	assert.ok(!JSON.stringify(f.requests).includes("original"));
	const [after] = await f.attachment.submissions.snapshot();
	assert.deepEqual(after.dispatch.queueClaims, [
		{ id: item.id, revision: 1, consumed: false },
		{ id: item.id, revision: 2, consumed: true },
	]);
	assert.equal(after.dispatch.queueHistory[0].revision, 2);
	await assert.rejects(
		f.attachment.submissions.recordQueueEdit(
			after.dispatch.operationId,
			{ id: item.id, revision: 2 },
			{
				kind: "followUp",
				args: [{ role: "user", content: "after consumption", timestamp: 1 }],
				queue: { id: item.id, revision: 3 },
			},
		),
		{ code: "transition" },
	);
});

test("a second edit during persistence stays held without overwriting either observation", async (t) => {
	const f = await fixture(t);
	await f.session.followUp("original");
	const [item] = f.session.agent.inspectQueuedMessages();
	f.session.agent.editQueuedMessage(item.id, 1, { role: "user", content: "second", timestamp: 1 });
	const record = f.attachment.submissions.recordQueueEdit.bind(f.attachment.submissions);
	let mutate = true;
	t.mock.method(f.attachment.submissions, "recordQueueEdit", async (...args) => {
		await record(...args);
		if (mutate) f.session.agent.editQueuedMessage(item.id, 2, { role: "user", content: "third", timestamp: 1 });
	});
	await assert.rejects(f.native.reconcileQueueEdit(item.id, 2), { code: "stale" });
	await f.session.continueQueued();
	assert.equal(f.requests.length, 0);
	mutate = false;
	await f.native.reconcileQueueEdit(item.id, 3);
	await f.session.continueQueued();
	const [saved] = await f.attachment.submissions.snapshot();
	assert.equal(saved.dispatch.inputs.length, 3);
	assert.deepEqual(
		saved.dispatch.queueClaims.map((claim) => claim.consumed),
		[false, false, true],
	);
	assert.equal(saved.dispatch.queueHistory[0].revision, 3);
	assert.ok(JSON.stringify(f.requests).includes("third"));
});

test("failed edit persistence cannot authorize queue consumption", async (t) => {
	const f = await fixture(t);
	await f.session.followUp("original");
	const [item] = f.session.agent.inspectQueuedMessages();
	f.session.agent.editQueuedMessage(item.id, 1, { role: "user", content: "edited", timestamp: 1 });
	t.mock.method(f.attachment.submissions, "recordQueueEdit", async () => {
		throw new Error("edit write failure");
	});
	await assert.rejects(f.native.reconcileQueueEdit(item.id, 2), /edit write failure/);
	await f.session.continueQueued();
	assert.equal(f.requests.length, 0);
	assert.equal((await f.attachment.submissions.snapshot())[0].dispatch.inputs.length, 1);
});

test("native close retains an edited pending revision before removing its live queue entry", async (t) => {
	const f = await fixture(t);
	await f.session.followUp("original");
	const [item] = f.session.agent.inspectQueuedMessages();
	f.session.agent.editQueuedMessage(item.id, 1, { role: "user", content: "edited before exit", timestamp: 1 });
	await f.native.close();
	assert.equal(f.requests.length, 0);
	assert.equal(f.session.agent.inspectQueuedMessages().length, 0);
	const [saved] = await f.attachment.submissions.snapshot();
	assert.equal(saved.dispatch.inputs[1].args[0].content, "edited before exit");
	assert.deepEqual(
		saved.dispatch.queueClaims.map((claim) => [claim.revision, claim.consumed]),
		[
			[1, false],
			[2, false],
		],
	);
	assert.equal(saved.dispatch.queueHistory, undefined);
});
