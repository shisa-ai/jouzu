import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assembledSession, installedProducerExtensions, syntheticProducer } from "./fixtures/flow-assembly.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));
async function maintain(f) {
	for (const invoke of [
		() => f.ingress.retireWaitHistory(true),
		() => f.ingress.archiveSubmissionHistory(),
		() => f.ingress.retireRequestHistory(),
		() => f.ingress.retireLedgerHistory(),
		() => f.ingress.retireResultHistory(),
	]) {
		const deadline = Date.now() + 5000;
		for (;;) {
			try {
				await invoke();
				break;
			} catch (error) {
				if (!["stale", "busy"].includes(error.code) || Date.now() >= deadline) throw error;
				await settle();
			}
		}
	}
}

test("150 distinct-input turns retire history, preserve live receipts, and remain usable after reopen", async (t) => {
	const producerExtensions = await installedProducerExtensions();
	const f = await assembledSession(t, { persist: true, producerExtensions, script: () => ({ text: "ack" }) });
	const synthetic = syntheticProducer();
	const registration = f.ingress.registerProducer(synthetic.producer);
	t.after(() => registration.dispose());
	const turns = 150;
	for (let turn = 0; turn < turns; turn++) {
		synthetic.offer([{ id: "intent", revision: String(turn + 1) }]);
		await registration.changed();
		await settle();
		if (turn % 10 === 9) {
			await maintain(f);
		}
	}
	assert.equal(f.bodies.length, turns);
	assert.deepEqual(f.errors, []);
	await f.session.prompt("Check that my retained input still has a request receipt");
	await f.ingress.retireRequestHistory();
	const branch = f.ingress.branch();
	const [ledger, requests, submissions] = await Promise.all([
		branch.attachment.ledger.snapshot(),
		branch.attachment.nativeRequests.snapshot(),
		branch.attachment.submissions.snapshot(),
	]);
	assert.ok(ledger.attempts.length <= 40, `attempts stay bounded: ${ledger.attempts.length}`);
	assert.ok(submissions.length <= 64, `submissions stay bounded: ${submissions.length}`);
	assert.ok(ledger.retiredAttempts);
	assert.ok(requests.length <= 80, `native requests stay bounded: ${requests.length}`);
	assert.ok(requests.length < turns, "the test crosses the retention window and actually removes requests");
	const live = submissions.map((record) => record.dispatch?.operationId).filter(Boolean);
	assert.ok(live.length > 0, "live-operation preservation is exercised, not vacuously true");
	for (const operation of live)
		assert.ok(
			requests.some((request) => request.sourceCapture?.members.some((source) => source.operationId === operation)),
			`live operation ${operation} keeps its receipt`,
		);
	registration.dispose();
	const history = f.sessionManager.getSessionFile();
	await f.shutdown("resume", history);
	const reopened = await assembledSession(t, {
		root: f.root,
		persist: true,
		producerExtensions,
		sessionManager: SessionManager.open(history),
	});
	try {
		const resumed = syntheticProducer();
		const resumedRegistration = reopened.ingress.registerProducer(resumed.producer);
		t.after(() => resumedRegistration.dispose());
		resumed.offer([{ id: "intent", revision: "1" }]);
		await resumedRegistration.changed();
		assert.equal(reopened.bodies.length, 0, "retired work does not replay after reopen");
		resumed.offer([{ id: "intent", revision: String(turns + 1) }]);
		await resumedRegistration.changed();
		assert.equal(reopened.bodies.length, 1, "new work is still admitted after reopen");
		await reopened.session.prompt("and the user is still served");
		assert.equal(reopened.bodies.length, 2);
		assert.deepEqual(reopened.errors, []);
	} finally {
		await reopened.shutdown();
	}
});
