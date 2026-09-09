import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assembledSession, installedProducerExtensions } from "./fixtures/flow-assembly.mjs";
import { campaignScript, liveWait } from "./fixtures/flow-campaign.mjs";

const idle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function persistentRoot(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-reopen-"));
	t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
	return root;
}

/** Drive one campaign to a live wait, then tear the session down the way a reopen does. */
async function campaignThenReopen(t) {
	const root = await persistentRoot(t);
	const producers = await installedProducerExtensions();
	const first = await assembledSession(t, {
		root,
		persist: true,
		producerExtensions: producers,
		script: campaignScript({ goal: "Survive a reopen" }),
	});
	await first.session.prompt("start the sweep and wait");

	const before = first.ingress.branch();
	const wait = await liveWait(first.ingress, "one live wait before the teardown");
	const authorityBefore = await before.attachment.waits.authoritySnapshot();
	const campaign = authorityBefore.work.find((work) => work.owner === "multiloop");
	assert.ok(campaign, "the lane registered campaign work");

	const sessionFile = first.session.sessionManager.getSessionFile();
	// `AgentSessionRuntime.teardownCurrent` emits this before it opens the next session file.
	await first.shutdown("resume", sessionFile);

	const next = await assembledSession(t, {
		root,
		persist: true,
		producerExtensions: producers,
		sessionManager: SessionManager.open(sessionFile),
	});
	return { root, first, next, campaign, wait, before };
}

test("a campaign, its wait, and its original deadline survive a reopen", async (t) => {
	const { first, next, campaign, wait, before } = await campaignThenReopen(t);
	const after = next.ingress.branch();
	assert.equal(after.scope.sessionId, before.scope.sessionId, "the reopened branch keeps its scope");

	const authorityAfter = await after.attachment.waits.authoritySnapshot();
	const restored = authorityAfter.work.find((work) => work.id === campaign.id);
	assert.ok(restored, "the campaign work survives reopen");
	assert.equal(restored.owner, "multiloop", "its owning producer survives with it");

	const waitsAfter = await after.attachment.waits.snapshot();
	const restoredWait = waitsAfter.find((record) => record.token === wait.token);
	assert.ok(restoredWait, "the wait token survives reopen");
	assert.equal(restoredWait.expiresAt, wait.expiresAt, "the original deadline is preserved, not restarted");
	assert.equal(restoredWait.workId, wait.workId, "the wait stays bound to the campaign work");
	assert.deepEqual(first.errors, []);
	assert.deepEqual(next.errors, []);
});

test("a shutdown-terminated dependency delivers one decision after reopen and never replays", async (t) => {
	const { next, wait } = await campaignThenReopen(t);
	// The task extension kills every running task on session_shutdown, whatever its reason, so the
	// wait is decided while no session can receive it. The decision must survive to the next one.
	await idle(500);
	const appended = next.bodies.map((body) => JSON.stringify(body.messages.at(-1)));
	const decisions = appended.filter((text) => text.includes('kind\\":\\"wait'));
	assert.equal(decisions.length, 1, "the pending wait decision is delivered exactly once after reopen");
	assert.ok(decisions[0].includes(wait.token), "it carries the original wait token");
	assert.ok(
		decisions[0].includes('kind\\":\\"result'),
		"the terminated execution's result composes into the same wake",
	);

	const delivered = next.bodies.length;
	await idle(600);
	assert.equal(next.bodies.length, delivered, "a delivered decision is not replayed on later turns");
	assert.deepEqual(next.errors, []);
});
