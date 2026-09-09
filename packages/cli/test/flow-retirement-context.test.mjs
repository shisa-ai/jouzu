import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assembledSession, syntheticProducer } from "./fixtures/flow-assembly.mjs";

test("failed automated instructions stay excluded after retirement and a later user request", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-retirement-context-"));
	t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
	const f = await assembledSession(t, {
		root,
		persist: true,
		script: (_body, index) => (index === 0 ? { httpStatus: 400 } : { text: "user answer" }),
	});
	const source = syntheticProducer();
	const registration = f.ingress.registerProducer(source.producer);
	t.after(() => registration.dispose());
	source.offer([{ id: "failed-instruction", revision: "1" }]);
	await registration.changed();
	assert.equal(f.bodies.length, 1);
	assert.ok(JSON.stringify(f.bodies[0].messages).includes("work failed-instruction"));
	const before = await f.ingress.branch().attachment.ledger.snapshot();
	assert.equal(before.attempts.length, 1);
	assert.equal(before.attempts[0].phase, "settled");
	assert.notEqual(before.attempts[0].outcome, "success");
	source.offer([]);
	await f.ingress.retireLedgerHistory(0);
	await f.session.prompt("answer only this new user request");
	assert.equal(f.bodies.length, 2);
	assert.ok(JSON.stringify(f.bodies[1].messages).includes("answer only this new user request"));
	assert.equal(
		JSON.stringify(f.bodies[1].messages).includes("work failed-instruction"),
		false,
		"retirement must not restore failed automated instructions to provider context",
	);
	registration.dispose();
	const sessionFile = f.sessionManager.getSessionFile();
	await f.shutdown("resume", sessionFile);
	const reopened = await assembledSession(t, {
		root: f.root,
		persist: true,
		sessionManager: SessionManager.open(sessionFile),
	});
	await reopened.ingress.retireLedgerHistory(0);
	await reopened.session.prompt("answer after reopening");
	assert.equal(reopened.bodies.length, 1);
	assert.equal(
		JSON.stringify(reopened.bodies[0].messages).includes("work failed-instruction"),
		false,
		"reopening must preserve the exclusion after another retirement pass",
	);
});
