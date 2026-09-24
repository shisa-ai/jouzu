import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { SessionManager as RootSessionManager } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { createFlowSession } from "../../../scripts/fixtures/pi-flow-session.mjs";

for (const queued of [false, true])
	test(`custom message identity survives canonical request projection: queued=${queued}`, async (t) => {
		const manager = RootSessionManager.inMemory();
		const { session } = await createFlowSession(t, { sessionManager: manager });
		let emitted;
		session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "custom") emitted = event.message;
		});
		await session.sendCustomMessage(
			{ customType: "identity", content: "retained", display: false, details: { marker: 1 } },
			queued ? { deliverAs: "nextTurn" } : { triggerTurn: false },
		);
		if (queued) await session.prompt("consume");
		const entry = manager.getBranch().find((item) => item.type === "custom_message");
		assert.ok(emitted);
		assert.equal(sessionEntryToContextMessages(entry)[0], emitted);
		assert.equal(
			manager.buildSessionProjection().messages.find((item) => item.role === "custom"),
			emitted,
		);
		assert.equal(
			manager.buildSessionProjection().messages.find((item) => item.role === "custom"),
			emitted,
		);
		assert.equal(JSON.stringify(entry).includes("retainedCustomContextMessage"), false);
		assert.deepEqual(Object.keys(entry).sort(), [
			"content",
			"customType",
			"details",
			"display",
			"id",
			"parentId",
			"timestamp",
			"type",
		]);
	});

test("replayed custom entries share identity across installed copies without masking edits", () => {
	const manager = RootSessionManager.inMemory();
	const id = manager.appendCustomMessageEntry("note", "original", false);
	const entry = manager.getEntry(id);
	const raw = JSON.stringify(entry);
	const first = manager.buildSessionProjection().messages[0];
	assert.equal(sessionEntryToContextMessages(entry)[0], first);
	assert.equal(manager.buildSessionProjection().messages[0], first);
	assert.equal(JSON.stringify(entry), raw);
	manager.appendContextEdit(id, { content: "replacement" });
	assert.equal(manager.buildSessionProjection().messages[0].content, "replacement");
	assert.equal(entry.content, "original");
	manager.appendContextEdit(id, null);
	assert.deepEqual(manager.buildSessionProjection().messages, []);
	manager.branch(id);
	assert.equal(manager.buildSessionProjection().messages[0], first);
	entry.content = "changed raw entry";
	assert.notEqual(sessionEntryToContextMessages(entry)[0], first);
	assert.equal(sessionEntryToContextMessages(entry)[0].content, "changed raw entry");
});
