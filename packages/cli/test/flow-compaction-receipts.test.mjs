import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { assistant } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { FlowModelInput } from "../dist/flow-control/model-input.js";
import { compactedFlowMembers } from "../dist/flow-control/pi-compaction-receipts.js";

function fixture(keepTail = true) {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "system", content: "Preserve these instructions.", timestamp: 1 });
	const composition = FlowModelInput.compose(
		"attempt",
		[{ id: "work", revision: "1", kind: "work", text: "Do work" }],
		4096,
	);
	const entryId = manager.appendCustomMessageEntry("jouzu-flow", composition.content, true, { attemptId: "attempt" });
	const kept = manager.appendMessage(assistant());
	manager.appendCompaction("Continue the remaining work.", keepTail ? kept : "", 5000);
	const sourceMessages = manager.buildSessionContext().messages;
	const input = {
		sourceMessages,
		transformedMessages: structuredClone(sourceMessages),
		modelMessages: convertToLlm(sourceMessages),
		requestId: "request",
		systemPrompt: "",
	};
	const attempt = {
		id: "attempt",
		members: composition.members,
		history: [
			{
				id: "work",
				revision: "1",
				entryId,
				entryHash: createHash("sha256")
					.update(JSON.stringify(manager.getEntry(entryId)))
					.digest("hex"),
			},
		],
	};
	return { manager, composition, input, attempt, entryId };
}

for (const keepTail of [true, false])
	test(`compaction evidence survives repeated compaction: keepTail=${keepTail}`, () => {
		const f = fixture(keepTail);
		assert.deepEqual(compactedFlowMembers(f.manager, f.attempt, f.input), [{ id: "work", revision: "1" }]);
		const kept = f.manager.appendMessage(assistant());
		f.manager.appendCompaction("Continue after a second compaction.", keepTail ? kept : "", 6000);
		f.input.sourceMessages = f.manager.buildSessionContext().messages;
		f.input.modelMessages = convertToLlm(f.input.sourceMessages);
		assert.deepEqual(compactedFlowMembers(f.manager, f.attempt, f.input), [{ id: "work", revision: "1" }]);
	});

for (const keepTail of [true, false])
	for (const fault of [
		"invalid-boundary",
		"retained-frame",
		"missing-history",
		"changed-history",
		"changed-frame",
		"wrong-branch",
		"missing-summary",
		"filtered-summary",
		"changed-summary",
		"reinserted-source",
	])
		test(`compaction cannot excuse unverified omission: ${fault}, keepTail=${keepTail}`, () => {
			const f = fixture(keepTail);
			switch (fault) {
				case "invalid-boundary":
					f.manager.appendCompaction("Invalid boundary", "missing-entry", 6000);
					break;
				case "retained-frame":
					f.manager.appendCompaction("Keep work.", f.entryId, 5000);
					break;
				case "missing-history":
					f.attempt.history = [];
					break;
				case "changed-history":
					f.attempt.history[0].entryHash = "bad";
					break;
				case "changed-frame":
					f.attempt.members[0].contentHash = "bad";
					break;
				case "wrong-branch":
					f.manager.branch(f.entryId);
					break;
				case "missing-summary":
					f.input.sourceMessages = f.input.sourceMessages.filter((message) => message.role !== "compactionSummary");
					break;
				case "filtered-summary":
					f.input.modelMessages = f.input.modelMessages.filter((message) => message.role === "system");
					break;
				case "changed-summary":
					f.input.sourceMessages.find((message) => message.role === "compactionSummary").summary = "Altered summary";
					f.input.modelMessages = convertToLlm(f.input.sourceMessages);
					break;
				case "reinserted-source":
					f.input.sourceMessages.push({ role: "user", content: f.composition.content, timestamp: 1 });
					break;
			}
			assert.deepEqual(compactedFlowMembers(f.manager, f.attempt, f.input), []);
		});
