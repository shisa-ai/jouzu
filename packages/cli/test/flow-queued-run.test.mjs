import assert from "node:assert/strict";
import { test } from "node:test";
import { createFlowSession, deferred, message } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { PiHostBoundary } from "../dist/flow-control/pi-host-boundary.js";

test("an empty queue creates no history or provider request", async (t) => {
	const { session, requests } = await createFlowSession(t);
	const before = structuredClone(session.sessionManager.getEntries());
	assert.equal(await session.continueQueued(), false);
	assert.equal(requests.length, 0);
	assert.deepEqual(session.sessionManager.getEntries(), before);
});

for (const initialized of [false, true])
	test(`queued execution consumes exact input with no extra prompt, initialized=${initialized}`, async (t) => {
		const { session, requests } = await createFlowSession(t);
		if (initialized) await session.prompt("initial");
		requests.length = 0;
		const queued = message("retained work");
		session.agent.followUp(queued);
		assert.equal(await session.continueQueued(), true);
		assert.equal(requests.length, 1);
		const users = session.messages.filter((item) => item.role === "user");
		assert.equal(users.length, initialized ? 2 : 1);
		assert.deepEqual(users.at(-1), queued);
		assert.equal(session.isIdle, true);
		assert.equal(await session.continueQueued(), false);
		assert.equal(requests.length, 1);
	});

test("another queued run cannot enter during native execution", async (t) => {
	const { session, requests } = await createFlowSession(t);
	const entered = deferred(),
		release = deferred();
	const native = session.agent.streamFunction;
	session.agent.streamFunction = async (...args) => {
		entered.resolve();
		await release.promise;
		return native(...args);
	};
	session.agent.followUp(message("retained work"));
	const run = session.continueQueued();
	await entered.promise;
	await assert.rejects(session.continueQueued(), /requires an idle session/);
	release.resolve();
	await run;
	assert.equal(requests.length, 1);
});

test("a pending user transcript does not dispatch ahead of the selected queue item", async (t) => {
	const { session, requests } = await createFlowSession(t);
	session.agent.state.messages = [message("existing user input")];
	session.agent.followUp(message("retained work"));
	await session.continueQueued();
	assert.equal(requests.length, 1);
	assert.deepEqual(
		requests[0].filter((item) => item.role === "user").map((item) => item.content[0].text),
		["existing user input", "retained work"],
	);
});

test("cancel during claim preserves newly queued user input without dispatching it", async (t) => {
	const entered = deferred(),
		release = deferred();
	const { session, requests } = await createFlowSession(t, {
		checkpoints: {
			beforeQueueClaim: async () => {
				entered.resolve();
				await release.promise;
				return true;
			},
		},
	});
	const automatic = session.agent.followUp(message("automatic"));
	const run = session.continueQueued();
	await entered.promise;
	session.agent.cancelQueuedMessage(automatic.id, automatic.revision);
	const user = session.agent.followUp(message("user input"));
	release.resolve();
	await run;
	assert.equal(requests.length, 0);
	assert.equal(session.messages.length, 0);
	assert.equal(session.agent.inspectQueuedMessages()[0].id, user.id);
	assert.equal(session.isIdle, true);
});

test("queue additions from agent_end use the same AgentSession run", async (t) => {
	const { session, requests } = await createFlowSession(t);
	let ends = 0,
		settled = 0;
	session.subscribe((event) => {
		if (event.type === "agent_end" && ++ends === 1) session.agent.followUp(message("next work"));
		if (event.type === "agent_settled") settled++;
	});
	session.agent.followUp(message("first work"));
	await session.continueQueued();
	assert.equal(requests.length, 2);
	assert.equal(settled, 1);
	assert.equal(session.isIdle, true);
});

test("queued execution waits outside an idle transaction and is forbidden inside it", async (t) => {
	const { session, requests } = await createFlowSession(t);
	const boundary = new PiHostBoundary(session);
	t.after(() => boundary.close());
	const entered = deferred(),
		release = deferred();
	const transaction = boundary.atIdle(async () => {
		await assert.rejects(session.continueQueued(), { code: "busy" });
		entered.resolve();
		await release.promise;
	});
	await entered.promise;
	let finished = false;
	const waiting = session.continueQueued().then((result) => {
		finished = true;
		return result;
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(finished, false);
	release.resolve();
	await transaction;
	assert.equal(await waiting, false);
	assert.equal(requests.length, 0);
});
