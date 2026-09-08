import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFlowSession, deferred, tick } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { PiNativeDispatch } from "../dist/flow-control/pi-native-dispatch.js";

async function fixture(t, extensions = []) {
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
		if (handled) assert.equal(record.dispatch.inputs, undefined);
		else {
			assert.equal(record.dispatch.inputs.length, 1);
			const input = record.dispatch.inputs[0];
			assert.equal(input.kind, "prompt");
			assert.equal(input.args[0][0].content[0].text, "normalized");
			assert.deepEqual(input.args[0][0].content[1], images[0]);
			assert.equal(input.args[0][1].customType, "context");
			assert.deepEqual(input.args[0][1].details, { n: 1 });
			await f.native.close();
			await f.attachment.close();
			const reopened = await PiFlowAttachment.open(f.root, f.scope);
			assert.deepEqual((await reopened.submissions.snapshot())[0].dispatch.inputs, record.dispatch.inputs);
			await reopened.close();
		}
	});

test("native queue consumption waits for its exact input observation", async (t) => {
	const f = await fixture(t);
	const entered = deferred(),
		release = deferred();
	const dispatch = f.attachment.submissions.dispatch.bind(f.attachment.submissions);
	t.mock.method(f.attachment.submissions, "dispatch", (id, revision, operation, run) =>
		dispatch(id, revision, operation, (observer) =>
			run({
				observe: async (input) => {
					entered.resolve();
					await release.promise;
					return observer.observe(input);
				},
			}),
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
});

for (const kind of ["prompt", "followUp"])
	test(`failed observation prevents native ${kind} consumption`, async (t) => {
		const f = await fixture(t);
		const dispatch = f.attachment.submissions.dispatch.bind(f.attachment.submissions);
		t.mock.method(f.attachment.submissions, "dispatch", (id, revision, operation, run) =>
			dispatch(id, revision, operation, () =>
				run({
					observe: async () => {
						throw new Error("observation storage failed");
					},
				}),
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
		dispatch(id, revision, operation, () =>
			run({
				observe: async () => {
					entered.resolve();
					await release.promise;
					throw new Error("write failed");
				},
			}),
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
	assert.deepEqual((await f.attachment.submissions.snapshot())[0], before);
	assert.equal(f.requests.length, 0);
});
