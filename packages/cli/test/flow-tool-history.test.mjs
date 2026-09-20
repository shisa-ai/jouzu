import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { generateBranchSummary, generateSummaryWithUsage, SessionManager } from "@earendil-works/pi-coding-agent";
import { assistant, model } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { FlowModelInput } from "../dist/flow-control/model-input.js";
import { createPiLedgerStore } from "../dist/flow-control/pi-ledger-store.js";
import { PiQueueReceipts } from "../dist/flow-control/pi-queue-receipts.js";
import { PiRequestReceipts } from "../dist/flow-control/pi-request-receipts.js";
import { FlowReceiptLedger } from "../dist/flow-control/receipt-ledger.js";
import { afterCleanup } from "./fixtures/cleanup.mjs";
import { nativeRequests } from "./fixtures/native-requests.mjs";

const PLACEHOLDER = /This tool result is unavailable in the selected conversation history/;

const userMessage = (text, timestamp) => ({ role: "user", content: [{ type: "text", text }], timestamp });
const toolCallAssistant = (calls, timestamp = 2) => ({
	...assistant(),
	timestamp,
	stopReason: "toolUse",
	content: calls.map(({ id, name, arguments: args = {} }) => ({ type: "toolCall", id, name, arguments: args })),
});
const toolResultMessage = (toolCallId, toolName, text, timestamp = 3, isError = false) => ({
	role: "toolResult",
	toolCallId,
	toolName,
	content: [{ type: "text", text }],
	isError,
	timestamp,
});

const probeTool = (onRun) => ({
	name: "probe",
	label: "Probe",
	description: "Probe",
	parameters: { type: "object", properties: {} },
	execute: async () => {
		onRun();
		return { content: [{ type: "text", text: "ran" }], details: {} };
	},
});

/** Deterministic provider: one scripted assistant reply per stream call, no network. */
function scriptedNative(script, seen) {
	return async (requestModel, requestContext, options) => {
		seen.push(structuredClone(requestContext.messages));
		await options?.onPayload?.({ messages: requestContext.messages }, requestModel);
		const final = script.length > 0 ? script.shift() : assistant();
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "done", partial: final };
			},
			result: async () => final,
		};
	};
}

const placeholders = (messages) =>
	messages.filter(
		(message) =>
			message.role === "toolResult" && message.isError === true && PLACEHOLDER.test(message.content?.[0]?.text ?? ""),
	);

function assistantToolCallEntry(session) {
	return session.sessionManager
		.getBranch()
		.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some((part) => part.type === "toolCall"),
		);
}

test("ordinary request after navigating to an assistant tool call repairs the model projection", async (t) => {
	const seen = [];
	let runs = 0;
	const f = await nativeRequests(t, {
		native: scriptedNative([toolCallAssistant([{ id: "call-a", name: "probe" }]), assistant()], seen),
		tools: [probeTool(() => runs++)],
	});
	await f.session.prompt("start");
	assert.equal(runs, 1);

	const target = assistantToolCallEntry(f.session);
	assert.ok(target);
	await f.session.navigateTree(target.id);
	await f.session.prompt("continue");

	const projected = seen.at(-1);
	assert.equal(placeholders(projected).length, 1);
	assert.equal(placeholders(projected)[0].toolCallId, "call-a");
	assert.ok(
		projected.some(
			(message) =>
				message.role === "assistant" &&
				message.content.some((part) => part.type === "toolCall" && part.id === "call-a"),
		),
	);
	// The placeholder is a projection only; the branch keeps its original entries.
	assert.doesNotMatch(JSON.stringify(f.session.sessionManager.getEntries()), PLACEHOLDER);
});

test("projected placeholder never replays the missing tool", async (t) => {
	const seen = [];
	let runs = 0;
	const f = await nativeRequests(t, {
		native: scriptedNative([toolCallAssistant([{ id: "call-a", name: "probe" }]), assistant()], seen),
		tools: [probeTool(() => runs++)],
	});
	await f.session.prompt("start");
	const target = assistantToolCallEntry(f.session);
	await f.session.navigateTree(target.id);
	await f.session.prompt("continue");
	assert.equal(runs, 1, "only the original native execution ran");
	assert.equal(placeholders(seen.at(-1)).length, 1);
});

test("partial parallel batch repairs only the missing sibling", async (t) => {
	const seen = [];
	const f = await nativeRequests(t, { native: scriptedNative([assistant()], seen) });
	const manager = f.session.sessionManager;
	manager.appendMessage(userMessage("start", 1));
	const assistantId = manager.appendMessage(
		toolCallAssistant([
			{ id: "call-a", name: "probe" },
			{ id: "call-b", name: "probe" },
		]),
	);
	manager.appendMessage(toolResultMessage("call-a", "probe", "ran a"));
	const afterId = manager.appendMessage(userMessage("after", 4));
	// Pi rebuilds agent state on a real leaf change; land on the retained result only.
	await f.session.navigateTree(assistantId);
	await f.session.navigateTree(afterId);
	await f.session.prompt("continue");

	const projected = seen.at(-1);
	const inserted = placeholders(projected);
	assert.equal(inserted.length, 1);
	assert.equal(inserted[0].toolCallId, "call-b");
	assert.ok(projected.some((message) => message.role === "toolResult" && message.toolCallId === "call-a"));
});

test("historical gap is repaired in place before later turns", async (t) => {
	const seen = [];
	const f = await nativeRequests(t, { native: scriptedNative([assistant()], seen) });
	const manager = f.session.sessionManager;
	manager.appendMessage(userMessage("start", 1));
	manager.appendMessage(toolCallAssistant([{ id: "call-late", name: "probe" }]));
	manager.appendMessage(userMessage("after gap", 3));
	const stopId = manager.appendMessage(assistant());
	manager.appendMessage(userMessage("tail", 5));
	await f.session.navigateTree(stopId);
	await f.session.prompt("continue");

	const projected = seen.at(-1);
	const callIndex = projected.findIndex(
		(message) =>
			message.role === "assistant" &&
			message.content.some((part) => part.type === "toolCall" && part.id === "call-late"),
	);
	assert.ok(callIndex >= 0);
	assert.equal(projected[callIndex + 1].toolCallId, "call-late");
	assert.equal(projected[callIndex + 1].isError, true);
	assert.equal(projected[callIndex + 2].role, "user");
	assert.equal(projected.at(-1).role, "user");
});

test("retained input source attribution accounts for inserted placeholders", async (t) => {
	const seen = [];
	const f = await nativeRequests(t, {
		retainInputs: true,
		native: scriptedNative([toolCallAssistant([{ id: "call-a", name: "probe" }]), assistant()], seen),
	});
	f.session.agent.state.tools = [probeTool(() => {})];
	await f.session.prompt("start");
	const target = assistantToolCallEntry(f.session);
	await f.session.navigateTree(target.id);
	await f.session.prompt("continue");

	const request = (await f.store.snapshot()).at(-1);
	assert.ok(request.sourceCapture);
	assert.equal(request.sourceCapture.members.length, 2);
	const memberOffset = request.sourceCapture.members.length - 1;
	assert.equal(request.sourceCapture.model.members[memberOffset].status, "intact");
	const projected = seen.at(-1);
	const userIndex = projected.findLastIndex((message) => message.role === "user");
	assert.ok(userIndex > 0);
	assert.equal(request.sourceCapture.model.members[memberOffset].index, userIndex);
});

test("history repair cannot admit a filtered required user input", async (t) => {
	let filter = false;
	const f = await nativeRequests(t, {
		retainInputs: true,
		enforceRequiredSources: true,
		contextHandler: ({ messages }) => ({ messages: filter ? messages.slice(0, -1) : messages }),
	});
	await f.session.prompt("seed");
	const manager = f.session.sessionManager;
	const target = manager.appendMessage(toolCallAssistant([{ id: "missing", name: "probe" }]));
	manager.appendMessage(userMessage("branch child", 4));
	await f.session.navigateTree(target);
	filter = true;
	const sentBefore = f.sent.length;
	await f.session.prompt("required input");
	assert.equal(f.sent.length, sentBefore);
	const request = (await f.store.snapshot()).at(-1);
	assert.equal(request.outcome, "withheld");
	assert.equal(request.sourceCapture.model.count, request.sourceCapture.context.count + 1);
	assert.equal(request.sourceCapture.model.members.at(-1).status, "unresolved");
});

test("repeated requests are idempotent and the persisted transcript stays unchanged", async (t) => {
	const seen = [];
	const f = await nativeRequests(t, { native: scriptedNative([assistant()], seen) });
	const manager = f.session.sessionManager;
	manager.appendMessage(userMessage("start", 1));
	const assistantId = manager.appendMessage(toolCallAssistant([{ id: "call-a", name: "probe" }]));
	const afterId = manager.appendMessage(userMessage("after", 3));
	await f.session.navigateTree(assistantId);
	await f.session.navigateTree(afterId);
	await f.session.prompt("first");
	await f.session.prompt("second");

	assert.equal(placeholders(seen.at(-1)).length, 1);
	assert.equal(placeholders(seen.at(-1))[0].toolCallId, "call-a");
	const transcript = JSON.stringify(f.session.sessionManager.getEntries());
	assert.doesNotMatch(transcript, PLACEHOLDER);
	assert.equal(transcript.match(/call-a/g).length, 1, "the original call is recorded exactly once");
});

test("fork extraction at the assistant tool call repairs the forked session", async (t) => {
	const seen = [];
	const first = await nativeRequests(t, {
		native: scriptedNative([toolCallAssistant([{ id: "call-a", name: "probe" }]), assistant()], seen),
	});
	first.session.agent.state.tools = [probeTool(() => {})];
	await first.session.prompt("start");
	const target = assistantToolCallEntry(first.session);
	const forkedFile = first.session.sessionManager.createBranchedSession(target.id);
	assert.ok(forkedFile);
	await first.bridge.close();
	await first.attachment.close();

	const root = await mkdtemp(join(tmpdir(), "jouzu-tool-history-fork-"));
	afterCleanup(t, () => rm(root, { recursive: true, force: true }));
	const forkedSeen = [];
	const forked = await nativeRequests(t, {
		root,
		manager: SessionManager.open(forkedFile),
		native: scriptedNative([assistant()], forkedSeen),
	});
	await forked.session.prompt("continue after fork");
	assert.equal(placeholders(forkedSeen.at(-1)).length, 1);
	assert.equal(placeholders(forkedSeen.at(-1))[0].toolCallId, "call-a");
});

test("reopened persisted session repairs the projection without a new transcript entry", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-tool-history-reopen-"));
	afterCleanup(t, () => rm(root, { recursive: true, force: true }));
	const seen = [];
	const first = await nativeRequests(t, {
		root,
		native: scriptedNative([toolCallAssistant([{ id: "call-a", name: "probe" }]), assistant()], seen),
	});
	first.session.agent.state.tools = [probeTool(() => {})];
	await first.session.prompt("start");
	const target = assistantToolCallEntry(first.session);
	await first.session.navigateTree(target.id);
	// The incident shape persists as a later user entry whose parent is the assistant call.
	await first.session.prompt("continue");
	first.session.sessionManager.flush();
	const sessionFile = first.session.sessionManager.getSessionFile();
	assert.ok(sessionFile);
	await first.bridge.close();
	await first.attachment.close();

	const reopenedSeen = [];
	const reopened = await nativeRequests(t, {
		root,
		manager: SessionManager.open(sessionFile),
		native: scriptedNative([assistant()], reopenedSeen),
	});
	await reopened.session.prompt("continue after reopen");
	assert.equal(placeholders(reopenedSeen.at(-1)).length, 1);
	assert.doesNotMatch(JSON.stringify(reopened.session.sessionManager.getEntries()), PLACEHOLDER);
});

test("flow composed admission passes after the projection repair", async (t) => {
	const seen = [];
	const f = await nativeRequests(t, {
		retainInputs: true,
		native: scriptedNative([toolCallAssistant([{ id: "call-a", name: "probe" }]), assistant()], seen),
	});
	f.session.agent.state.tools = [probeTool(() => {})];
	await f.session.prompt("start");
	const target = assistantToolCallEntry(f.session);
	await f.session.navigateTree(target.id);

	const repo = new MemorySessionRepo();
	const ledger = await FlowReceiptLedger.attach(createPiLedgerStore(await repo.create({}, context)), {
		sessionId: f.session.sessionId,
		branchId: "main",
	});
	const receipts = new PiRequestReceipts(f.session, ledger);
	f.bridge.attachComposition(receipts);
	const queue = new PiQueueReceipts(f.session.agent, ledger);
	afterCleanup(t, async () => {
		queue.close();
		receipts.close();
		await repo.close(context);
	});

	const composition = FlowModelInput.compose(
		"attempt",
		[{ id: "work", revision: "1", kind: "work", text: "Do work" }],
		4096,
	);
	await ledger.select("attempt", composition.members);
	receipts.register(composition);
	await queue.enqueue("attempt", () =>
		f.session.agent.followUp({ role: "user", content: composition.content, timestamp: 10 }),
	);
	await f.session.agent.continue();

	const state = await ledger.snapshot();
	const attempt = state.attempts[0];
	assert.notEqual(attempt.phase, "withheld");
	assert.equal(attempt.requests[0].handedOff, true);
	assert.deepEqual(
		attempt.requests[0].inclusion.map((member) => member.disposition),
		["included"],
	);
	assert.equal(placeholders(seen.at(-1)).length, 1);
});

test("failed assistant turn and its contiguous results are omitted from the provider projection", async (t) => {
	const seen = [];
	const f = await nativeRequests(t, { native: scriptedNative([assistant()], seen) });
	const manager = f.session.sessionManager;
	manager.appendMessage(userMessage("start", 1));
	manager.appendMessage(toolCallAssistant([{ id: "call-ok", name: "probe" }]));
	const failedId = manager.appendMessage({
		...toolCallAssistant(
			[
				{ id: "", name: "probe" },
				{ id: "x".repeat(513), name: "probe" },
			],
			3,
		),
		stopReason: "aborted",
	});
	manager.appendMessage(toolResultMessage("", "probe", "synthetic failed result", 4));
	const afterId = manager.appendMessage(userMessage("after", 5));
	await f.session.navigateTree(failedId);
	await f.session.navigateTree(afterId);
	await f.session.prompt("continue");

	const projected = seen.at(-1);
	// The pending successful call is closed before the failed turn is dropped.
	assert.equal(placeholders(projected).length, 1);
	assert.equal(placeholders(projected)[0].toolCallId, "call-ok");
	assert.equal(
		projected.some((message) => message.stopReason === "aborted"),
		false,
	);
	assert.equal(
		projected.some((message) => message.toolCallId === ""),
		false,
	);
	assert.doesNotMatch(JSON.stringify(projected), /synthetic failed result/);
	// Disk keeps every original entry, including the failed turn and its result.
	const transcript = JSON.stringify(f.session.sessionManager.getEntries());
	assert.match(transcript, /synthetic failed result/);
	assert.equal(JSON.stringify(projected).includes("x".repeat(513)), false);
});

for (const kind of ["compaction", "branch"]) {
	test(`${kind} summary uses the shared bridge repair before serializing history`, async (t) => {
		const seen = [];
		const f = await nativeRequests(t, { native: scriptedNative([assistant()], seen) });
		const history = [
			userMessage("start", 1),
			toolCallAssistant([
				{ id: "known", name: "probe" },
				{ id: "missing", name: "probe" },
			]),
			toolResultMessage("known", "probe", "Actual completed result"),
		];
		const snapshot = structuredClone(history);
		const stream = f.session.agent.streamFunction;
		Object.defineProperty(f.session, "isCompacting", { configurable: true, get: () => true });
		try {
			if (kind === "compaction") {
				await generateSummaryWithUsage(
					history,
					model,
					512,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					stream,
				);
			} else {
				const entries = history.map((message, i) => ({
					type: "message",
					id: `entry-${i}`,
					parentId: i ? `entry-${i - 1}` : null,
					timestamp: new Date(i).toISOString(),
					message,
				}));
				const result = await generateBranchSummary(entries, { model, reserveTokens: 512, streamFn: stream });
				assert.equal(result.error, undefined);
			}
		} finally {
			delete f.session.isCompacting;
		}
		assert.equal(seen.length, 1);
		assert.deepEqual(history, snapshot);
		assert.deepEqual(
			seen[0].map((message) => message.role),
			["system", "user"],
		);
		assert.match(JSON.stringify(seen[0]), /outcome is unknown/);
		assert.match(JSON.stringify(seen[0]), /Actual completed result/);
		assert.equal(JSON.stringify(seen[0]).match(/outcome is unknown/g).length, 1);
		assert.equal((await f.store.snapshot())[0].outcome, "success");
	});
}

test("compaction maintenance projects placeholders before the provider call", async (t) => {
	const seen = [];
	const f = await nativeRequests(t, {
		native: async (requestModel, requestContext, options) => {
			seen.push(structuredClone(requestContext.messages));
			await options?.onPayload?.({ messages: requestContext.messages }, requestModel);
			return {
				async *[Symbol.asyncIterator]() {},
				result: async () => assistant(),
			};
		},
	});
	Object.defineProperty(f.session, "isCompacting", { configurable: true, get: () => true });
	try {
		const response = await f.session.agent.streamFunction(
			model,
			{ messages: [toolCallAssistant([{ id: "call-maintenance", name: "probe" }])], systemPrompt: "Summarize" },
			{},
		);
		await response.result();
	} finally {
		delete f.session.isCompacting;
	}
	assert.equal(placeholders(seen[0]).length, 1);
	assert.equal(placeholders(seen[0])[0].toolCallId, "call-maintenance");
	assert.equal(seen[0][0].role, "assistant");
});
