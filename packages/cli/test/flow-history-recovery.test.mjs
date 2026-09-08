import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assistant } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { FlowModelInput } from "../dist/flow-control/model-input.js";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { recoverPiHistory } from "../dist/flow-control/pi-history-recovery.js";

const user = (content) => ({ role: "user", content, timestamp: 1 });
async function fixture(
	t,
	{ custom = false, duplicate = false, alter = false, aggregate = false, legacy = false } = {},
) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-history-recover-"));
	let manager = SessionManager.create(root, join(root, "history"));
	manager.appendMessage(user("initial"));
	manager.appendMessage(assistant());
	const scope = { sessionId: manager.getSessionId(), branchId: "main" };
	let attachment = await PiFlowAttachment.open(join(root, "receipts"), scope);
	t.after(async () => {
		await attachment.close();
		await rm(root, { recursive: true, force: true });
	});
	const item = aggregate
		? {
				id: "aggregate",
				revision: "1",
				kind: "result",
				text: "Completed jobs",
				resultManifest: {
					reference: "results",
					members: Array.from({ length: 100 }, (_, i) => ({ id: `result-${i}`, revision: "1" })),
				},
			}
		: {
				id: "work",
				revision: "1",
				kind: "work",
				text: "Do work",
				images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
			};
	const composition = FlowModelInput.compose("attempt", [item], 4096);
	const members = composition.members;
	if (legacy) for (const member of members) delete member.inputFrame;
	await attachment.ledger.select("attempt", members);
	await attachment.ledger.queued("attempt", { id: "queue", revision: 1 });
	await attachment.ledger.claim("attempt", { id: "queue", revision: 1 });
	const content = composition.content;
	if (alter) content[1].data = "YWx0ZXJlZA==";
	const entry = custom ? manager.appendCustomMessageEntry("flow", content, true) : manager.appendMessage(user(content));
	if (duplicate) manager.appendMessage(user(content));
	const path = manager.getSessionFile();
	await attachment.close();
	attachment = await PiFlowAttachment.open(join(root, "receipts"), scope);
	manager = SessionManager.open(path);
	return { manager, ledger: attachment.ledger, entry, path, composition };
}

for (const custom of [false, true])
	test(`recovery proves original history without appending it, custom=${custom}`, async (t) => {
		const { manager, ledger, entry, path } = await fixture(t, { custom });
		const bytes = await readFile(path);
		assert.deepEqual(await recoverPiHistory(manager, ledger), { recovered: 1, unresolved: 0 });
		const state = await ledger.snapshot();
		assert.equal(state.activeAttemptId, undefined);
		assert.equal(state.attempts[0].phase, "cancelled");
		assert.equal(state.attempts[0].history[0].entryId, entry);
		assert.match(state.attempts[0].history[0].entryHash, /^[a-f0-9]{64}$/);
		assert.deepEqual(await recoverPiHistory(manager, ledger), { recovered: 0, unresolved: 0 });
		assert.deepEqual(await readFile(path), bytes);
	});
for (const mode of ["duplicate", "alter", "legacy"])
	test(`ambiguous or unprovable history remains unresolved: ${mode}`, async (t) => {
		const { manager, ledger, path } = await fixture(t, { [mode]: true });
		const bytes = await readFile(path);
		assert.deepEqual(await recoverPiHistory(manager, ledger), { recovered: 0, unresolved: 1 });
		assert.deepEqual((await ledger.snapshot()).attempts[0].history, []);
		assert.deepEqual(await readFile(path), bytes);
	});
test("aggregate history restores exact member receipts from one bounded frame", async (t) => {
	const { manager, ledger, entry } = await fixture(t, { aggregate: true });
	assert.deepEqual(await recoverPiHistory(manager, ledger), { recovered: 100, unresolved: 0 });
	const receipts = (await ledger.snapshot()).attempts[0].history;
	assert.equal(receipts.length, 100);
	assert.equal(new Set(receipts.map((receipt) => receipt.id)).size, 100);
	assert.ok(receipts.every((receipt) => receipt.entryId === entry));
});
test("a torn final append is not repaired or acknowledged", async (t) => {
	const { manager, ledger, path } = await fixture(t);
	const bytes = await readFile(path);
	await truncate(path, bytes.length - 1);
	assert.deepEqual(await recoverPiHistory(manager, ledger), { recovered: 0, unresolved: 1 });
	assert.deepEqual(await readFile(path), bytes.subarray(0, -1));
});
test("recovery refuses a new live attempt and cannot reopen the old reservation", async (t) => {
	const { manager, ledger } = await fixture(t);
	await ledger.select("new", [{ id: "new", revision: "1", kind: "work", required: true, contentHash: "a".repeat(64) }]);
	await assert.rejects(recoverPiHistory(manager, ledger), { code: "busy" });
	assert.equal((await ledger.snapshot()).activeAttemptId, "new");
});
