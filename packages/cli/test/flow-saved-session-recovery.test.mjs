import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	afterFlowCleanup,
	assembledSession,
	capturedNotices,
	installedProducerExtensions,
	replacedSession,
} from "./fixtures/flow-assembly.mjs";
import { copyFlowSession } from "./fixtures/flow-session-copy.mjs";

const sourceSession = process.env.JOUZU_FLOW_RECOVERY_SESSION;
const sourceRoot = process.env.JOUZU_FLOW_RECOVERY_ROOT;
test("saved session recovers on a disposable copy, clears the hold, and resumes again", {
	skip:
		!sourceSession &&
		!sourceRoot &&
		"Set JOUZU_FLOW_RECOVERY_SESSION and JOUZU_FLOW_RECOVERY_ROOT to qualify saved state.",
	timeout: 120000,
}, async (t) => {
	assert.ok(sourceSession && sourceRoot, "Both recovery source paths are required");
	const directory = await mkdtemp(join(tmpdir(), "jouzu-saved-recovery-"));
	afterFlowCleanup(t, () => rm(directory, { recursive: true, force: true }));
	const { root, sessionFile } = await copyFlowSession(sourceSession, sourceRoot, directory);
	const producerExtensions = await installedProducerExtensions();
	const f = await assembledSession(t, {
		root,
		persist: true,
		sessionManager: SessionManager.open(sessionFile),
		producerExtensions,
	});
	if (f.ingress.branch().attachment.nativeRequests.recoveryBlocked) {
		const notices = capturedNotices(f.session);
		await f.session.prompt("/flow");
		assert.ok(notices.length, "saved recovery state must not block inspection");
		assert.match(notices.map((notice) => notice.text).join("\n"), /\/flow clear/);
		const before = await f.ingress.branch().attachment.nativeRequests.snapshot();
		await f.session.prompt("/flow clear");
		assert.equal(f.ingress.branch().attachment.nativeRequests.recoveryBlocked, false);
		assert.equal(f.bodies.length, 0, "clear itself does not call the provider");
		const after = await f.ingress.branch().attachment.nativeRequests.snapshot();
		for (const receipt of before.filter((record) => record.outcome === "withheld")) {
			const preserved = after.find((record) => record.id === receipt.id);
			assert.equal(preserved?.reset, true);
			assert.deepEqual(preserved.withheldPayload, receipt.withheldPayload);
			assert.equal(preserved.outcome, "withheld");
		}
	}
	await f.session.prompt("continue");
	assert.equal(f.bodies.length, 1, JSON.stringify(await f.ingress.inspect()));
	await f.session.prompt("/flow reset");
	await f.session.prompt("Continue after reset");
	await f.session.prompt("Continue again");
	assert.equal(f.bodies.length, 3);
	const next = await replacedSession(t, f, {
		reason: "resume",
		persist: true,
		sessionManager: SessionManager.open(sessionFile),
		producerExtensions,
	});
	await next.session.prompt("Continue after reopening");
	assert.equal(next.bodies.length, 1);
	assert.deepEqual(f.errors, []);
	assert.deepEqual(next.errors, []);
	assert.equal(next.ingress.branch().host.gate().userPending, false);
});
