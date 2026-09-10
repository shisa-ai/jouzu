import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FLOW_STATE_VERSION, reconcileFlowStateVersion } from "../dist/flow-control/local-storage.js";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";

const scope = { sessionId: "session", branchId: "branch" };
const member = { id: "work", revision: "1", kind: "work", required: true, contentHash: "a".repeat(64) };
const included = [
	{ id: member.id, revision: member.revision, disposition: "included", contentHash: member.contentHash },
];

async function attached(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-uncertain-"));
	const attachment = await PiFlowAttachment.open(root, scope);
	t.after(async () => {
		await attachment.close();
		await rm(root, { recursive: true, force: true });
	});
	return { root, ledger: attachment.ledger };
}

/** Drive one attempt to the point where the provider received it but its outcome is unknown. */
async function interrupted(ledger) {
	await ledger.select("attempt", [member]);
	await ledger.queued("attempt", { id: "queue", revision: 1 });
	await ledger.claim("attempt", { id: "queue", revision: 1 });
	await ledger.prepare("attempt", "request", included, false);
	await ledger.handoff("attempt", "request");
	await ledger.uncertain("attempt", "Host is inactive but the provider outcome is unknown.");
	const state = await ledger.snapshot();
	assert.equal(state.attempts[0].phase, "uncertain");
	assert.equal(state.activeAttemptId, undefined);
}

test("retrying an interrupted turn makes its work eligible again", async (t) => {
	const { ledger } = await attached(t);
	await interrupted(ledger);
	await ledger.resolveUncertain("attempt", "retry", "Resolved from /flow as undelivered.");
	const [attempt] = (await ledger.snapshot()).attempts;
	// Cancelled rather than settled: this attempt did not succeed, so the work behind it is offered
	// again. The user accepted that the provider may already have answered the first send.
	assert.equal(attempt.phase, "cancelled");
	assert.equal(attempt.outcome, undefined);
	assert.equal(attempt.reason, "Resolved from /flow as undelivered.");
	assert.equal(attempt.requests[0].handedOff, true, "the handed-off request stays on the record");
});

test("discarding an interrupted turn settles it so nothing runs again", async (t) => {
	const { ledger } = await attached(t);
	await interrupted(ledger);
	await ledger.resolveUncertain("attempt", "discard", "Resolved from /flow as spent.");
	const [attempt] = (await ledger.snapshot()).attempts;
	assert.equal(attempt.phase, "settled");
	assert.equal(attempt.outcome, "failure");
	assert.equal(attempt.reason, "Resolved from /flow as spent.");
});

test("only an uncertain attempt can be resolved, and only into a known resolution", async (t) => {
	const { ledger } = await attached(t);
	await ledger.select("attempt", [member]);
	await assert.rejects(ledger.resolveUncertain("attempt", "retry", "too early"), { code: "transition" });
	await ledger.queued("attempt", { id: "queue", revision: 1 });
	await ledger.claim("attempt", { id: "queue", revision: 1 });
	await ledger.prepare("attempt", "request", included, false);
	await ledger.handoff("attempt", "request");
	await ledger.uncertain("attempt", "unknown outcome");
	assert.throws(() => ledger.resolveUncertain("attempt", "guess", "invalid"), { code: "schema" });
	await assert.rejects(ledger.resolveUncertain("missing", "retry", "unknown attempt"), { code: "identity" });
	await ledger.resolveUncertain("attempt", "discard", "settled by the user");
	// One decision only: a resolved attempt is terminal and cannot be resolved a second way.
	await assert.rejects(ledger.resolveUncertain("attempt", "retry", "again"), { code: "transition" });
});

test("a resolved attempt survives reattachment with its decision", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-uncertain-reopen-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const first = await PiFlowAttachment.open(root, scope);
	await interrupted(first.ledger);
	await first.ledger.resolveUncertain("attempt", "retry", "Resolved from /flow as undelivered.");
	await first.close();
	const reopened = await PiFlowAttachment.open(root, scope);
	try {
		const [attempt] = (await reopened.ledger.snapshot()).attempts;
		assert.equal(attempt.phase, "cancelled");
		assert.equal(attempt.reason, "Resolved from /flow as undelivered.");
	} finally {
		await reopened.close();
	}
});

test("state written under an earlier version is isolated rather than read", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-state-version-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const first = await PiFlowAttachment.open(root, scope);
	await first.ledger.select("attempt", [member]);
	await first.close();
	const [key] = await readdir(root);
	const directory = join(root, key);
	assert.deepEqual(JSON.parse(await readFile(join(directory, "schema.json"), "utf8")), {
		version: FLOW_STATE_VERSION,
	});

	// Downgrade the marker the way an older build would have left it, then reattach.
	await writeFile(join(directory, "schema.json"), JSON.stringify({ version: FLOW_STATE_VERSION - 1 }));
	const isolated = [];
	const next = await PiFlowAttachment.open(root, scope, undefined, (path) => isolated.push(path));
	try {
		assert.equal(isolated.length, 1, "the isolation is reported once, naming where the state went");
		assert.ok(isolated[0].startsWith(join(directory, "sessions.v")));
		assert.ok((await readdir(isolated[0])).length > 0, "the earlier state is preserved for inspection");
		// The fresh store carries none of the isolated records.
		assert.deepEqual((await next.ledger.snapshot()).attempts, []);
		assert.deepEqual(JSON.parse(await readFile(join(directory, "schema.json"), "utf8")), {
			version: FLOW_STATE_VERSION,
		});
	} finally {
		await next.close();
	}
});

test("an unversioned directory with no state is adopted without isolating anything", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-state-adopt-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const isolated = [];
	const attachment = await PiFlowAttachment.open(root, scope, undefined, (path) => isolated.push(path));
	try {
		assert.deepEqual(isolated, []);
	} finally {
		await attachment.close();
	}
	const [key] = await readdir(root);
	// A second open at the same version reconciles to nothing.
	assert.equal(await reconcileFlowStateVersion(join(root, key)), undefined);
});
