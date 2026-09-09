import assert from "node:assert/strict";
import { test } from "node:test";
import { assembledSession, installedProducerExtensions, syntheticProducer } from "./fixtures/flow-assembly.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Every store on the automated path appends one record per admitted turn and each has a hard limit
 * that throws and holds all work when reached. Retirement is what keeps a long session alive, so
 * this drives enough turns to pass those limits and asserts the session is still working at the end.
 */
test("a long automated session stays under every retention limit and still admits work", async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: () => ({ text: "ack" }),
	});
	const synthetic = syntheticProducer();
	const registration = f.ingress.registerProducer(synthetic.producer);
	t.after(() => registration.dispose());

	const turns = 150;
	for (let turn = 0; turn < turns; turn++) {
		synthetic.offer([{ id: "intent", revision: String(turn + 1) }]);
		await registration.changed();
		await settle();
		// The launcher runs this pass at idle; running it here keeps the case deterministic.
		if (turn % 10 === 9) {
			await f.ingress.retireWaitHistory(true);
			await f.ingress.archiveSubmissionHistory();
			await f.ingress.retireRequestHistory();
			await f.ingress.retireLedgerHistory();
			await f.ingress.retireResultHistory();
		}
	}
	assert.equal(f.bodies.length, turns, "every offered revision reached the model exactly once");
	assert.deepEqual(f.errors, [], "no store reported a capacity failure along the way");

	const branch = f.ingress.branch();
	const [ledger, requests, submissions] = await Promise.all([
		branch.attachment.ledger.snapshot(),
		branch.attachment.nativeRequests.snapshot(),
		branch.attachment.submissions.snapshot(),
	]);
	// Retained records are bounded by the keep sizes, not by how long the session ran.
	assert.ok(ledger.attempts.length <= 40, `attempts stay bounded: ${ledger.attempts.length}`);
	assert.ok(submissions.length <= 64, `submissions stay bounded: ${submissions.length}`);
	assert.ok(ledger.retiredAttempts, "retirement actually ran rather than the limits never being neared");
	// Native requests are the exception, and the reason the next case is a todo: retirement only
	// removes evidence a later success already covers, and every turn here carries distinct input.
	assert.equal(requests.length, turns, "every distinct input keeps its own request receipt");

	// The point of all of it: the session is still usable.
	synthetic.offer([{ id: "intent", revision: String(turns + 1) }]);
	await registration.changed();
	await settle();
	assert.equal(f.bodies.length, turns + 1, "work after a long session is still admitted");
	await f.session.prompt("and the user is still served");
	assert.equal(f.bodies.length, turns + 2);
	assert.deepEqual(f.errors, []);
});

// `supersededNativeRequests` retires a request only when a later retained success already covers
// every one of its inputs, so a session whose turns carry distinct input retains one record per
// turn and walks toward the 1,024-record limit in `native-request-store.ts`. Bounding it needs a
// policy that keeps the fact of an observed input without its full per-source evidence, which is
// the open half of the plan's retention item.
test("distinct-input turns keep the native request store bounded", { todo: true }, async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: () => ({ text: "ack" }),
	});
	const synthetic = syntheticProducer();
	const registration = f.ingress.registerProducer(synthetic.producer);
	t.after(() => registration.dispose());
	for (let turn = 0; turn < 60; turn++) {
		synthetic.offer([{ id: "intent", revision: String(turn + 1) }]);
		await registration.changed();
		await settle();
		await f.ingress.retireRequestHistory();
	}
	const requests = await f.ingress.branch().attachment.nativeRequests.snapshot();
	assert.ok(requests.length <= 40, `native requests stay bounded: ${requests.length}`);
});
