import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assembledSession, installedProducerExtensions } from "./fixtures/flow-assembly.mjs";

const lane = { lane: "sweep", runTag: "retirement" };
async function attach(t, options) {
	let events, host;
	const f = await assembledSession(t, {
		...options,
		producerExtensions: [
			(await installedProducerExtensions())[1],
			{
				name: "retirement-continuations",
				factory(pi) {
					events = pi.events;
				},
			},
		],
	});
	events.emit("jouzu:multiloop-flow", {
		version: 1,
		sessionId: f.sessionManager.getSessionId(),
		accept(value) {
			host = value;
		},
		reject(error) {
			throw error;
		},
	});
	assert.ok(host, "the production multiloop bridge accepts the continuation source");
	return { ...f, host };
}

async function continueOnce(f) {
	let admitted = 0;
	f.host.submit({
		lane,
		reason: "continue",
		build: () => "Continue this campaign",
		admitted() {
			admitted++;
		},
	});
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		await f.ingress.wakeProducers();
		const state = await f.ingress.branch().attachment.ledger.snapshot();
		if (admitted === 1 && !state.activeAttemptId) break;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(admitted, 1, "native consumption accounts for exactly one continuation");
}

test("multiloop resumes at the next revision after all settled attempts are retired and the session reopens", async (t) => {
	const first = await attach(t, { persist: true });
	await first.host.transition(lane, "active");
	await continueOnce(first);
	await continueOnce(first);
	assert.equal(first.bodies.length, 2);
	const before = await first.ingress.branch().attachment.ledger.snapshot();
	assert.deepEqual(
		before.attempts.map((attempt) => attempt.admission.choice.intent.revision),
		["1", "2"],
	);
	first.host.changed([]);
	await first.ingress.wakeProducers();
	await first.ingress.retireLedgerHistory(0);
	assert.deepEqual((await first.ingress.branch().attachment.ledger.snapshot()).attempts, []);
	const history = first.sessionManager.getSessionFile();
	await first.shutdown("resume", history);
	const second = await attach(t, { root: first.root, persist: true, sessionManager: SessionManager.open(history) });
	await continueOnce(second);
	assert.equal(second.bodies.length, 1, "the next continuation is admitted, not fenced as an old revision");
	await second.ingress.wakeProducers();
	assert.equal(second.bodies.length, 1, "the new revision is itself fenced against duplicate admission");
	const after = await second.ingress.branch().attachment.ledger.snapshot();
	assert.equal(after.attempts[0].admission.choice.intent.revision, "3");
	assert.equal(after.attempts[0].outcome, "success");
	assert.deepEqual(first.errors, []);
	assert.deepEqual(second.errors, []);
});
