import assert from "node:assert/strict";
import { test } from "node:test";
import { FLOW_OFF_MESSAGE } from "../dist/flow-control/flow-off-message.js";
import { createFlowNoReplyExtension } from "../dist/flow-control/no-reply-tool.js";
import { createFlowResultExtension } from "../dist/flow-control/result-tools.js";
import { createFlowWaitExtension } from "../dist/flow-control/wait-tools.js";

/** Flow control is off, so every tool that needs it refuses before it touches an attachment. */
const off = () => false;
const tools = (extension) => {
	const registered = new Map();
	extension.factory({
		on() {},
		registerTool(tool) {
			registered.set(tool.name, tool);
		},
		getActiveTools: () => [],
	});
	return registered;
};
const refusal = (error) => {
	assert.equal(error?.code, "stale");
	return error.message;
};
const ctx = { sessionManager: { getSessionId: () => "session" } };

test("every flow tool refuses with one message while flow control is off", async () => {
	// The attachment getter throws: a refusal that got as far as reading it would be a different failure.
	const attachment = () => assert.fail("a refused tool must not read its attachment");
	const waits = tools(createFlowWaitExtension({ attachment, maxDurationMs: 5000, enabled: off }));
	await assert.rejects(
		waits
			.get("agent_wait")
			.execute("call", { work: "work", reason: "why", deadline: "5m", on: [] }, undefined, undefined, ctx),
		(error) => refusal(error) === FLOW_OFF_MESSAGE,
	);
	await assert.rejects(
		waits.get("agent_wait_cancel").execute("call", { token: "t", reason: "why" }, undefined, undefined, ctx),
		(error) => refusal(error) === FLOW_OFF_MESSAGE,
	);
	const noReply = tools(createFlowNoReplyExtension({ ingress: attachment, enabled: off }));
	await assert.rejects(
		noReply.get("agent_no_reply").execute("call", { permission: "no-reply:x" }, undefined, undefined, ctx),
		(error) => refusal(error) === FLOW_OFF_MESSAGE,
	);
	const results = tools(createFlowResultExtension({ attachment, enabled: off }));
	await assert.rejects(
		results
			.get("agent_results")
			.execute("call", { reference: `flow-results:${"a".repeat(64)}` }, undefined, undefined, ctx),
		(error) => refusal(error) === FLOW_OFF_MESSAGE,
	);
});

test("the wait guidance is withheld while flow control is off", async () => {
	// Instructions telling the model to use tools that refuse would be instructions it cannot follow.
	let before;
	const wait = createFlowWaitExtension({ attachment: () => assert.fail("unused"), maxDurationMs: 5000, enabled: off });
	wait.factory({
		on(name, handler) {
			if (name === "before_agent_start") before = handler;
		},
		registerTool() {},
		getActiveTools: () => ["agent_wait"],
	});
	assert.equal(before({ systemPrompt: "Base prompt" }), undefined);
});
