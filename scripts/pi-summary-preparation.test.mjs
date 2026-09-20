import assert from "node:assert/strict";
import { test } from "node:test";
import {
	compact,
	estimateTokens,
	generateBranchSummary,
	generateSummaryWithUsage,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { prepareSummaryToolHistory } from "../packages/cli/dist/flow-control/tool-history.js";
import { assistant, model } from "./fixtures/pi-flow-session.mjs";

const unknownOutcome = /execution outcome is unknown/;
const excerptBoundary = /The tool call is not included in this summary excerpt\./;
const user = (content = "Continue") => ({ role: "user", content, timestamp: 1 });
const call = (...ids) => ({
	...assistant(),
	stopReason: "toolUse",
	content: [
		{ type: "thinking", thinking: "", thinkingSignature: "signed", redacted: true },
		...ids.map((id) => ({ type: "toolCall", id, name: "probe", arguments: { id } })),
	],
});
const result = (id, text = "Retained execution evidence") => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "probe",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 2,
});

function transport() {
	const sources = [];
	const projections = [];
	const prompts = [];
	const streamFn = async (_model, context) => {
		assert.deepEqual(
			context.messages.map((message) => message.role),
			["system", "user"],
		);
		prompts.push(context.messages[1].content[0].text);
		return { result: async () => assistant() };
	};
	streamFn.flowPrepareSummaryMessages = (messages) => {
		const snapshot = structuredClone(messages);
		sources.push(messages);
		const prepared = prepareSummaryToolHistory(messages);
		assert.deepEqual(messages, snapshot, "summary projection must not mutate source messages");
		projections.push(prepared);
		return prepared;
	};
	return { streamFn, sources, projections, prompts };
}

function summarize(messages, streamFn) {
	return generateSummaryWithUsage(
		messages,
		model,
		1024,
		"fixture",
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		streamFn,
	);
}

function entries(messages) {
	const manager = SessionManager.inMemory();
	for (const message of messages) manager.appendMessage(message);
	return manager;
}

function splitPreparation(messagesToSummarize, turnPrefixMessages) {
	return {
		firstKeptEntryId: "retained-tail",
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: true,
		tokensBefore: 2000,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { enabled: true, reserveTokens: 1024, keepRecentTokens: 512 },
	};
}

function branch(manager, streamFn, overrides = {}) {
	return generateBranchSummary(manager.getBranch(), {
		model,
		apiKey: "fixture",
		signal: new AbortController().signal,
		reserveTokens: 1024,
		streamFn,
		...overrides,
	});
}

test("summary preparation repairs structured history before generateSummaryWithUsage serialization", async () => {
	const messages = [user(), call("completed", "missing"), result("completed"), user("After gap")];
	const snapshot = structuredClone(messages);
	const probe = transport();
	await summarize(messages, probe.streamFn);
	assert.equal(probe.sources.length, 1);
	assert.equal(probe.sources[0][1], messages[1], "signed assistant remains the original object");
	assert.equal(probe.projections[0][2], messages[2], "retain actual result evidence");
	assert.equal(probe.projections[0][3].toolCallId, "missing");
	assert.equal(probe.projections[0][3].isError, true);
	assert.match(probe.prompts[0], unknownOutcome);
	assert.match(probe.prompts[0], /Retained execution evidence/);
	assert.ok(probe.prompts[0].indexOf("execution outcome is unknown") < probe.prompts[0].indexOf("After gap"));
	assert.deepEqual(messages, snapshot);
	await summarize(messages, probe.streamFn);
	assert.deepEqual(probe.projections[1], probe.projections[0], "retry projection is deterministic");
	assert.equal(probe.prompts[1], probe.prompts[0]);
});

test("summary preparation runs separately on history and split-turn prefix through compact", async () => {
	const preparation = splitPreparation([user(), call("history")], [user(), call("prefix")]);
	const snapshot = structuredClone(preparation);
	const probe = transport();
	const outcome = await compact(
		preparation,
		model,
		"fixture",
		undefined,
		undefined,
		undefined,
		undefined,
		probe.streamFn,
	);
	assert.match(outcome.summary, /Turn Context \(split turn\)/);
	assert.equal(probe.sources.length, 2);
	assert.equal(probe.sources[0][1], preparation.messagesToSummarize[1]);
	assert.equal(probe.sources[1][1], preparation.turnPrefixMessages[1]);
	for (const prompt of probe.prompts) assert.match(prompt, unknownOutcome);
	assert.match(probe.prompts[1], /PREFIX of a turn/);
	assert.deepEqual(preparation, snapshot);
});

test("summary preparation preserves branch results and fills only the missing batch member", async () => {
	const manager = entries([user(), call("completed", "missing"), result("completed"), user("After gap")]);
	const snapshot = structuredClone(manager.getEntries());
	const probe = transport();
	await branch(manager, probe.streamFn);
	assert.equal(probe.sources.length, 1);
	assert.deepEqual(
		probe.sources[0].map((message) => message.role),
		["user", "assistant", "toolResult", "user"],
	);
	const projectedResults = probe.projections[0].filter((message) => message.role === "toolResult");
	assert.deepEqual(
		projectedResults.map((message) => [message.toolCallId, message.isError]),
		[
			["completed", false],
			["missing", true],
		],
	);
	assert.match(probe.prompts[0], unknownOutcome);
	assert.match(probe.prompts[0], /Retained execution evidence/);
	assert.deepEqual(manager.getEntries(), snapshot, "no synthetic session entries");
});

test("summary preparation labels leading result excerpts without inventing calls", async () => {
	const messages = [result("outside-excerpt"), user(), call("missing")];
	const snapshot = structuredClone(messages);
	const probe = transport();
	await summarize(messages, probe.streamFn);
	assert.equal(probe.sources[0][0], messages[0]);
	assert.match(probe.prompts[0], excerptBoundary);
	assert.match(probe.prompts[0], /Retained execution evidence/);
	assert.match(probe.prompts[0], unknownOutcome);
	assert.deepEqual(
		probe.projections[0]
			.filter((message) => message.role === "assistant")
			.flatMap((message) => message.content.filter((part) => part.type === "toolCall").map((part) => part.id)),
		["missing"],
	);
	assert.deepEqual(messages, snapshot);
});

test("summary preparation handles a branch budget cut starting at a retained result", async () => {
	const retained = [result("outside-budget"), user("Recent message")];
	const manager = entries([user("Older"), call("outside-budget"), ...retained]);
	const snapshot = structuredClone(manager.getEntries());
	const probe = transport();
	const budget = retained.reduce((total, message) => total + estimateTokens(message), 0);
	await branch(manager, probe.streamFn, { model: { ...model, contextWindow: 1024 + budget } });
	assert.deepEqual(probe.sources[0], retained, "budget excludes the call, not its selected result evidence");
	assert.match(probe.prompts[0], excerptBoundary);
	assert.match(probe.prompts[0], /Retained execution evidence/);
	assert.doesNotMatch(probe.prompts[0], /\[Assistant tool calls\]/);
	assert.doesNotMatch(probe.prompts[0], unknownOutcome);
	assert.deepEqual(manager.getEntries(), snapshot);
});

test("summary preparation handles a branch excerpt whose common ancestor owns the call", async () => {
	const manager = entries([result("ancestor-call"), user()]);
	const snapshot = structuredClone(manager.getEntries());
	const probe = transport();
	await branch(manager, probe.streamFn);
	assert.equal(probe.sources[0][0].role, "toolResult");
	assert.match(probe.prompts[0], excerptBoundary);
	assert.match(probe.prompts[0], /Retained execution evidence/);
	assert.doesNotMatch(probe.prompts[0], /\[Assistant tool calls\]/);
	assert.deepEqual(manager.getEntries(), snapshot);
});

test("summary preparation refuses ambiguous suffix results before transport", async () => {
	for (const messages of [
		[user(), result("orphan")],
		[user(), call("a"), result("a"), result("a")],
		[user(), call("a"), { ...result("a"), toolName: "other" }],
	]) {
		const probe = transport();
		await assert.rejects(summarize(messages, probe.streamFn), { code: "schema" });
		assert.equal(probe.prompts.length, 0);
		const branchProbe = transport();
		await assert.rejects(branch(entries(messages), branchProbe.streamFn), { code: "schema" });
		assert.equal(branchProbe.prompts.length, 0);
	}
});

test("summary preparation is opt-in and leaves unhooked summary behavior unchanged", async () => {
	const probe = transport();
	delete probe.streamFn.flowPrepareSummaryMessages;
	const messages = [user(), call("completed"), result("completed")];
	await summarize(messages, probe.streamFn);
	await branch(entries(messages), probe.streamFn);
	assert.equal(probe.sources.length, 0);
	assert.match(probe.prompts[0], /Retained execution evidence/);
	assert.doesNotMatch(probe.prompts[1], /Retained execution evidence/);
	for (const prompt of probe.prompts) assert.doesNotMatch(prompt, unknownOutcome);
});
