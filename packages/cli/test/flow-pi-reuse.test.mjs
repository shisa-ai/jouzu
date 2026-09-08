import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentHarness, BACKGROUND_CONTEXT as context, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { createPiLedgerStore } from "../dist/flow-control/pi-ledger-store.js";
import { FlowReceiptLedger } from "../dist/flow-control/receipt-ledger.js";

test("Pi Harness retains duplicate prompts and images by stable queue identity alongside Jouzu receipts", async (t) => {
	t.mock.method(globalThis, "fetch", async () => {
		throw new Error("Network disabled in host reuse fixture.");
	});
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, context);
	const { harness } = await AgentHarness.create(
		{ session, models: {}, model: { id: "fixture", provider: "fixture" } },
		context,
	);
	t.after(async () => {
		await harness.close(context);
		await session.close(context);
		await repo.close(context);
	});
	const lane = await harness.lane("main", context);
	const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
	const first = await lane.followUp("same", [image], context);
	const second = await lane.followUp("same", [image], context);
	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	assert.notEqual(first.value.entryId, second.value.entryId);
	const watch = await lane.watch(context);
	// This fixture uses the native snapshot; it does not infer queue state from prompt text.
	assert.ok(watch);
	const cancelled = await lane.cancelQueued(first.value.entryId, context);
	assert.equal(cancelled.ok, true);
	assert.equal(cancelled.value.kind, "cancelled");
	const gone = await lane.cancelQueued(first.value.entryId, context);
	assert.equal(gone.value.kind, "not_found");
	const ledger = await FlowReceiptLedger.attach(createPiLedgerStore(session), {
		sessionId: session.metadata.id,
		branchId: "main",
	});
	assert.equal((await ledger.snapshot()).attempts.length, 0);
	// Independent namespaces preserve the other native queue item.
	const remaining = await lane.cancelQueued(second.value.entryId, context);
	assert.equal(remaining.value.kind, "cancelled");
});
