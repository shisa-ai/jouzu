import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { SessionManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { afterCleanup } from "./fixtures/cleanup.mjs";
import { fixture } from "./fixtures/flow-session-ingress.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run the child until it reports the requested durable point, then kill it. */
async function crash(t, mode) {
	const child = fork(new URL("./fixtures/flow-external-crash.mjs", import.meta.url), [mode], {
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	const exited = once(child, "exit");
	afterCleanup(t, async () => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await exited;
		}
	});
	const [message] = await Promise.race([
		once(child, "message"),
		exited.then(() => {
			throw new Error(`External crash fixture exited before its ${mode} report`);
		}),
	]);
	assert.equal(message.phase, mode);
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		await exited;
	}
	assert.equal(child.signalCode, "SIGKILL", "the fixture did not die from an uncatchable signal");
	return message;
}

/** Reopen the crashed branch with the real ingress and adapter registration. */
async function reopen(t, message) {
	afterCleanup(t, () => rm(message.root, { recursive: true, force: true }));
	afterCleanup(t, () => rm(message.agentDir, { recursive: true, force: true }));
	const f = await fixture(t, {
		root: message.root,
		agentDir: message.agentDir,
		manager: SessionManager.open(message.sessionFile),
	});
	const adapter = await f.session._flowBinding.registerUserInputAdapter(message.extensionId, {
		id: "fixture",
		label: "Fixture",
	});
	const binding = await adapter.bind();
	return { ...f, adapter, binding };
}

const retry = (f, message) => ({
	binding: f.binding,
	messageId: message.messageId,
	text: message.text,
	deliverAs: message.deliverAs,
});
const receipt = (f, message) => f.adapter.lookup({ target: f.binding.target, messageId: message.messageId });

test("a crash after external retention reopens without replay and retries only on request", {
	timeout: 30000,
}, async (t) => {
	const message = await crash(t, "retained");
	const f = await reopen(t, message);
	// The stable target survives the process death, so the same client identity reattaches.
	assert.equal(f.binding.target, message.target);
	await f.session.waitForIdle();
	await delay(50);
	assert.equal(f.sent.length, 0, "reopening replayed the retained external message");
	const before = await receipt(f, message);
	assert.equal(before.state, "unknown");
	assert.equal(before.reason.code, "callback-ended");
	const [retained] = (await f.ingress.branch().attachment.submissions.snapshot(false)).filter(
		(item) => item.submission.externalUser,
	);
	assert.equal(retained.dispatch, undefined, "the crash left dispatch intent behind");
	assert.equal(retained.unavailable, "callback-ended");
	// The explicit retry is authorized by the same target and reattaches before any intent exists.
	const retried = await f.adapter.submit(retry(f, message));
	assert.notEqual(retried.state, "unknown");
	await f.ingress.joinPendingOperations();
	assert.equal((await receipt(f, message)).state, "consumed");
	assert.equal(f.sent.length, 1, "the explicit retry did not dispatch exactly once");
});

test("a crash after external dispatch intent stays unknown and is never resent", { timeout: 30000 }, async (t) => {
	const message = await crash(t, "intent");
	const f = await reopen(t, message);
	assert.equal(f.binding.target, message.target);
	await f.session.waitForIdle();
	await delay(50);
	assert.equal(f.sent.length, 0, "reopening dispatched a prior-intent external message");
	const before = await receipt(f, message);
	assert.equal(before.state, "unknown");
	assert.equal(before.reason.code, "dispatch-unconfirmed");
	const [pending] = (await f.ingress.branch().attachment.submissions.snapshot(false)).filter(
		(item) => item.submission.externalUser,
	);
	assert.equal(pending.dispatch.phase, "started");
	assert.equal(pending.dispatch.inputs, undefined);
	// A retry reports the same unconfirmed receipt and never writes a second intent or dispatches.
	const retried = await f.adapter.submit(retry(f, message));
	assert.equal(retried.state, "unknown");
	assert.equal(retried.reason.code, "dispatch-unconfirmed");
	await f.ingress.joinPendingOperations();
	await delay(50);
	assert.equal(f.sent.length, 0);
	const [unchanged] = (await f.ingress.branch().attachment.submissions.snapshot(false)).filter(
		(item) => item.submission.externalUser,
	);
	assert.equal(unchanged.revision, pending.revision);
	assert.equal(unchanged.dispatch.phase, "started");
});
