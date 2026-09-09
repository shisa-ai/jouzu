import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assembledSession, installedProducerExtensions } from "./fixtures/flow-assembly.mjs";

async function sharedRoot(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-shared-"));
	// Storage flushes after dispose returns, so a single rmdir can race it.
	t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
	return root;
}

test("two assemblies on one storage root keep separate scopes and receipts", async (t) => {
	const root = await sharedRoot(t);
	// The same bundled extension factories are reused by both sessions.
	const producers = await installedProducerExtensions();
	const first = await assembledSession(t, { root, producerExtensions: producers });
	const second = await assembledSession(t, { root, producerExtensions: producers });
	assert.notEqual(first.session.sessionId, second.session.sessionId);
	assert.equal(first.root, second.root, "both assemblies own the same storage root");

	await Promise.all([first.session.prompt("first session"), second.session.prompt("second session")]);
	for (const [entry, text] of [
		[first, "first session"],
		[second, "second session"],
	]) {
		const branch = entry.ingress.branch();
		assert.equal(branch.scope.sessionId, entry.session.sessionId);
		const requests = await branch.attachment.nativeRequests.snapshot();
		assert.equal(requests.length, 1);
		assert.equal(requests[0].outcome, "success");
		const submissions = await branch.attachment.submissions.snapshot();
		assert.equal(submissions.length, 1);
		assert.ok(JSON.stringify(entry.bodies).includes(text));
		assert.deepEqual(entry.errors, []);
	}
	assert.ok(!JSON.stringify(first.bodies).includes("second session"));
	assert.ok(!JSON.stringify(second.bodies).includes("first session"));
});

test("a shared root does not leak waits or work between assemblies", async (t) => {
	const root = await sharedRoot(t);
	const producers = await installedProducerExtensions();
	const first = await assembledSession(t, { root, producerExtensions: producers });
	const second = await assembledSession(t, { root, producerExtensions: producers });
	await first.session.prompt("only in the first");
	const firstAuthority = await first.ingress.branch().attachment.waits.authoritySnapshot();
	const secondAuthority = await second.ingress.branch().attachment.waits.authoritySnapshot();
	assert.ok(firstAuthority.work.length > 0, "the first assembly registered user work");
	assert.deepEqual(secondAuthority.work, [], "the second assembly sees none of it");
	assert.deepEqual(await second.ingress.branch().attachment.submissions.snapshot(), []);
});

test("reusing the loaded producer extensions leaves each assembly's tool surface intact", async (t) => {
	const root = await sharedRoot(t);
	const producers = await installedProducerExtensions();
	const first = await assembledSession(t, { root, producerExtensions: producers });
	const second = await assembledSession(t, { root, producerExtensions: producers });
	for (const entry of [first, second]) {
		const tools = entry.session.getActiveToolNames();
		for (const name of ["multiloop_start", "bg_task", "agent_wait", "agent_wait_cancel", "agent_results"])
			assert.ok(tools.includes(name), `${name} is active`);
		assert.deepEqual(entry.errors, [], "the background handshake succeeds for both");
	}
});
