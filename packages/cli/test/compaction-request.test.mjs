import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	COMPACTION_CONTINUE_CUSTOM_TYPE,
	COMPACTION_TOOL_DESCRIPTION,
	COMPACTION_TOOL_NAME,
	COMPACTION_TOOL_PROMPT_SNIPPET,
	CompactionRequestController,
	describeCompactionFailure,
	describeCompactionOutcome,
	PI_VCC_COMPACT_MARKER,
	registerCompactionRequest,
} from "../dist/compaction-request.js";

function installTool() {
	const handlers = new Map();
	const tools = new Map();
	const sent = [];
	const pi = {
		on: (event, handler) => handlers.set(event, handler),
		registerTool: (tool) => tools.set(tool.name, tool),
		sendMessage: async (message, options) => {
			sent.push({ message, options });
		},
	};
	const controller = registerCompactionRequest(pi);
	return { handlers, tools, sent, controller };
}

function settledContext({ hasPendingMessages = false } = {}) {
	const compactCalls = [];
	const notifications = [];
	return {
		compactCalls,
		notifications,
		ctx: {
			hasPendingMessages: () => hasPendingMessages,
			compact: (options) => compactCalls.push(options),
			ui: { notify: (message, level) => notifications.push([message, level]) },
		},
	};
}

test("a request is held until the run settles, then dispatched once", async () => {
	const { handlers, tools, sent, controller } = installTool();
	const tool = tools.get(COMPACTION_TOOL_NAME);
	assert.ok(tool, "the compaction tool is registered");

	const first = await tool.execute();
	assert.match(first.content[0].text, /runs once this turn ends/);
	assert.equal(controller.getState(), "requested");

	// A second call in the same turn must not queue a second compaction.
	const second = await tool.execute();
	assert.match(second.content[0].text, /already requested/);

	const { ctx, compactCalls, notifications } = settledContext();
	await handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
	assert.equal(compactCalls.length, 1);
	assert.equal(compactCalls[0].customInstructions, PI_VCC_COMPACT_MARKER);
	assert.equal(controller.getState(), "dispatching");

	compactCalls[0].onComplete({ details: { compactor: "pi-vcc" } });
	assert.equal(controller.getState(), "idle");
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0][1], "info");
	assert.match(notifications[0][0], /pi-vcc summary/);

	assert.equal(sent.length, 1);
	assert.equal(sent[0].message.customType, COMPACTION_CONTINUE_CUSTOM_TYPE);
	assert.deepEqual(sent[0].message.content, []);
	assert.equal(sent[0].message.display, false);
	assert.equal(sent[0].options.triggerTurn, true);
	assert.equal(sent[0].options.deliverAs, "followUp");
});

test("a settled run with no request does not compact", async () => {
	const { handlers } = installTool();
	const { ctx, compactCalls } = settledContext();
	await handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
	assert.equal(compactCalls.length, 0);
});

test("a queued user message takes priority over a pending request", async () => {
	const { handlers, tools, controller } = installTool();
	await tools.get(COMPACTION_TOOL_NAME).execute();

	const pending = settledContext({ hasPendingMessages: true });
	await handlers.get("agent_settled")({ type: "agent_settled" }, pending.ctx);
	assert.equal(pending.compactCalls.length, 0);
	assert.equal(controller.getState(), "requested", "the request survives for the next settled run");

	const idle = settledContext();
	await handlers.get("agent_settled")({ type: "agent_settled" }, idle.ctx);
	assert.equal(idle.compactCalls.length, 1);
});

test("a failed compaction reports to the user and does not resume the agent", async () => {
	const { handlers, tools, sent, controller } = installTool();
	await tools.get(COMPACTION_TOOL_NAME).execute();

	const { ctx, compactCalls, notifications } = settledContext();
	await handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
	compactCalls[0].onError(new Error("Already compacted"));

	assert.equal(controller.getState(), "idle");
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0][1], "warning");
	assert.match(notifications[0][0], /Nothing to compact/);
	assert.equal(sent.length, 0, "no resume after a failed compaction");
});

test("the resume message is filtered out of the model payload", () => {
	const { handlers } = installTool();
	const context = handlers.get("context");

	const carrier = { role: "custom", customType: COMPACTION_CONTINUE_CUSTOM_TYPE, content: [] };
	const user = { role: "user", content: "hello" };
	const other = { role: "custom", customType: "something-else", content: [] };

	const filtered = context({ type: "context", messages: [user, carrier, other] });
	assert.deepEqual(filtered.messages, [user, other]);

	assert.equal(context({ type: "context", messages: [user, other] }), undefined);
});

test("model-facing compaction text carries no usage, budget, or context figures", () => {
	const modelFacing = [
		COMPACTION_TOOL_DESCRIPTION,
		COMPACTION_TOOL_PROMPT_SNIPPET,
		new CompactionRequestController().request(),
	];
	for (const text of modelFacing) {
		assert.doesNotMatch(text, /token/i, text);
		assert.doesNotMatch(text, /budget/i, text);
		assert.doesNotMatch(text, /\d+\s*%/, text);
		assert.doesNotMatch(text, /remaining/i, text);
	}
});

test("compaction outcomes are described honestly", () => {
	assert.match(describeCompactionOutcome({ compactor: "pi-vcc" }), /pi-vcc summary/);
	assert.doesNotMatch(describeCompactionOutcome(undefined), /pi-vcc/);
	assert.match(describeCompactionFailure(new Error("Compaction cancelled")), /Nothing to compact/);
	assert.match(describeCompactionFailure(new Error("Nothing to compact (session too small)")), /Nothing to compact/);
	assert.match(describeCompactionFailure(new Error("network down")), /failed: network down/);
});

test("the bundled pi-vcc still recognizes the compaction marker", () => {
	const candidates = [
		join(import.meta.dirname, "../node_modules/@sting8k/pi-vcc/src/core/compact-args.ts"),
		join(import.meta.dirname, "../../../node_modules/@sting8k/pi-vcc/src/core/compact-args.ts"),
	];
	const source = candidates.find((candidate) => existsSync(candidate));
	assert.ok(source, "pi-vcc must be installed for this gate to mean anything");

	const declaration = readFileSync(source, "utf8").match(/export const PI_VCC_COMPACT_INSTRUCTION\s*=\s*"([^"]+)"/);
	assert.ok(declaration, "pi-vcc must still declare PI_VCC_COMPACT_INSTRUCTION");
	assert.equal(
		declaration[1],
		PI_VCC_COMPACT_MARKER,
		"pi-vcc changed its compaction marker; requested compactions would fall back to Pi's summarizer",
	);
});
