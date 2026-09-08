import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFlowSession, deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { PiQueueReceipts } from "../dist/flow-control/pi-queue-receipts.js";

const member = { id: "input", revision: "1", kind: "work", required: true, contentHash: "a".repeat(64) };
async function fixture(t, checkpoints) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-claims-"));
	const host = await createFlowSession(t, { checkpoints });
	const attachment = await PiFlowAttachment.open(root, { sessionId: host.session.sessionId, branchId: "main" });
	const receipts = new PiQueueReceipts(host.session.agent, attachment.ledger);
	t.after(async () => {
		receipts.close();
		await attachment.close();
		await rm(root, { recursive: true, force: true });
	});
	await host.session.prompt("initial user");
	host.requests.length = 0;
	await attachment.ledger.select("attempt", [member]);
	return { ...host, attachment, receipts };
}

test("native enqueue and exact consumption join one durable selected attempt", async (t) => {
	const { session, requests, attachment, receipts } = await fixture(t);
	const queued = await receipts.enqueue("attempt", () =>
		session.followUp("work", [{ type: "image", data: "YQ==", mimeType: "image/png" }]),
	);
	assert.deepEqual((await attachment.ledger.snapshot()).attempts[0].queue, queued);
	assert.equal((await attachment.ledger.snapshot()).attempts[0].phase, "queued");
	await session.agent.continue();
	assert.equal((await attachment.ledger.snapshot()).attempts[0].phase, "claimed");
	assert.equal(requests.length, 1);
	assert.equal(requests[0].at(-1).content[1].data, "YQ==");
});

for (const action of ["cancel", "edit", "clear"]) {
	test(`${action} during admission cannot persist a false claim or dispatch changed work`, async (t) => {
		const entered = deferred();
		const release = deferred();
		const { session, requests, attachment, receipts } = await fixture(t, {
			beforeQueueClaim: async () => {
				entered.resolve();
				await release.promise;
				return true;
			},
		});
		const item = await receipts.enqueue("attempt", () => session.followUp("automation"));
		const running = session.agent.continue();
		await entered.promise;
		if (action === "cancel") session.agent.cancelQueuedMessage(item.id, item.revision);
		if (action === "clear") session.agent.clearAllQueues();
		if (action === "edit")
			session.agent.editQueuedMessage(item.id, item.revision, { role: "user", content: "edited", timestamp: 1 });
		release.resolve();
		await running;
		assert.equal(requests.length, 0);
		assert.equal((await attachment.ledger.snapshot()).attempts[0].phase, "cancelled");
		if (action === "edit") {
			await session.agent.continue();
			assert.equal(requests.length, 0);
			assert.equal(session.agent.inspectQueuedMessages()[0].revision, 2);
		}
	});
}

test("a failed durable consumption receipt prevents provider work after native removal", async (t) => {
	const { session, requests, attachment, receipts } = await fixture(t);
	await receipts.enqueue("attempt", () => session.followUp("work"));
	t.mock.method(attachment.ledger, "claim", async () => {
		throw new Error("Receipt storage failed");
	});
	await session.agent.continue();
	assert.equal(requests.length, 0);
	assert.deepEqual(session.agent.inspectQueuedMessages(), []);
	assert.equal((await attachment.ledger.snapshot()).attempts[0].phase, "queued");
});

test("new user input survives cancellation of the offered automated item", async (t) => {
	const entered = deferred();
	const release = deferred();
	const { session, requests, attachment, receipts } = await fixture(t, {
		beforeQueueClaim: async () => {
			entered.resolve();
			await release.promise;
			return true;
		},
	});
	const item = await receipts.enqueue("attempt", () => session.followUp("same"));
	const running = session.agent.continue();
	await entered.promise;
	session.agent.cancelQueuedMessage(item.id, 1);
	await session.followUp("same");
	const user = session.agent.inspectQueuedMessages()[0];
	assert.notEqual(user.id, item.id);
	release.resolve();
	await running;
	assert.equal(requests.length, 0);
	assert.equal((await attachment.ledger.snapshot()).attempts[0].phase, "cancelled");
	assert.equal(session.agent.inspectQueuedMessages()[0].id, user.id);
	await session.agent.continue();
	assert.equal(requests.length, 1);
});

test("abort during durable claim does not start a provider request", async (t) => {
	const entered = deferred();
	const release = deferred();
	const { session, requests, attachment, receipts } = await fixture(t);
	await receipts.enqueue("attempt", () => session.followUp("work"));
	const claim = attachment.ledger.claim.bind(attachment.ledger);
	t.mock.method(attachment.ledger, "claim", async (...args) => {
		entered.resolve();
		await release.promise;
		await claim(...args);
	});
	const running = session.agent.continue();
	await entered.promise;
	session.agent.abort();
	release.resolve();
	await running;
	assert.equal(requests.length, 0);
	assert.equal((await attachment.ledger.snapshot()).attempts[0].phase, "claimed");
});

test("callbacks after a native dispatch permit returns cannot enqueue under its attempt", async (t) => {
	const { session, attachment, receipts } = await fixture(t);
	let late;
	const release = deferred();
	await receipts.enqueue("attempt", async () => {
		await session.followUp("owned");
		late = release.promise.then(() => {
			try {
				session.agent.followUp({ role: "user", content: "late", timestamp: 1 });
				return undefined;
			} catch (error) {
				return error;
			}
		});
	});
	release.resolve();
	assert.match((await late).message, /outlived/);
	assert.equal(session.agent.inspectQueuedMessages().length, 1);
	assert.equal((await attachment.ledger.snapshot()).attempts[0].phase, "queued");
});

test("retained ingress identity is the member of its native queue receipt", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-retained-claim-"));
	let attachment;
	const held = [];
	const { session } = await createFlowSession(t, {
		ingress: {
			version: 1,
			submit: async (input, dispatch) => {
				if (input.args[0] === "initial user") return dispatch();
				await attachment.submissions.retain(input);
				held.push({ input, dispatch });
			},
		},
	});
	attachment = await PiFlowAttachment.open(root, { sessionId: session.sessionId, branchId: "main" });
	const receipts = new PiQueueReceipts(session.agent, attachment.ledger);
	t.after(async () => {
		receipts.close();
		await attachment.close();
		await rm(root, { recursive: true, force: true });
	});
	await session.prompt("initial user");
	await session.followUp("retained instruction");
	const [{ input, dispatch }] = held;
	await attachment.ledger.select("retained-attempt", [{ ...member, id: input.id }]);
	const queue = await receipts.enqueue("retained-attempt", dispatch);
	await session.agent.continue();
	const [attempt] = (await attachment.ledger.snapshot()).attempts;
	assert.equal(attempt.phase, "claimed");
	assert.deepEqual(attempt.queue, queue);
	assert.equal(attempt.members[0].id, (await attachment.submissions.snapshot())[0].id);
});

test("an idle custom send cannot start a direct provider run under a queue permit", async (t) => {
	const { session, requests, attachment, receipts } = await fixture(t);
	await assert.rejects(
		receipts.enqueue("attempt", () =>
			session.sendCustomMessage(
				{ customType: "flow", content: "instruction", display: false },
				{ triggerTurn: true, deliverAs: "followUp" },
			),
		),
		/cannot start a direct native run/,
	);
	assert.equal(requests.length, 0);
	assert.equal((await attachment.ledger.snapshot()).attempts[0].phase, "selected");
	await assert.rejects(
		receipts.enqueue("attempt", () => session.agent.continue()),
		/cannot start a direct native run/,
	);
	assert.equal(requests.length, 0);
});
