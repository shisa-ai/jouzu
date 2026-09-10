/**
 * Offline fake-RPC fixtures for the live flow smoke's pure analysis. No provider, build, or packed
 * CLI is involved: these tests drive the exact event shapes the RPC stream emits (prompt responses,
 * tool ends, agent_settled, and composed wait wake frames) through the exported helpers, covering
 * the false positives the stage/wake correlation and budget accounting must reject.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	analyzeFlowEvents,
	composedWakeFrames,
	createUsageAccountant,
	declaredWaitTokens,
	successfulToolEnds,
	waitTokenFromToolEnd,
} from "./live-flow-smoke.mjs";

const token = "0a1b2c3d-4e5f-4a5b-8c9d-0e1f2a3b4c5d";
const renewed = "99887766-5544-4333-8222-1100aabbccdd";

const response = (id, success = true) => ({ type: "response", id, command: "prompt", success });
const settled = () => ({ type: "agent_settled" });
const agentEnd = () => ({ type: "agent_end", messages: [] });
const toolEnd = (name, result, isError = false) => ({
	toolCallId: `call-${name}`,
	type: "tool_execution_end",
	toolName: name,
	result,
	isError,
});
const waitEnd = (value = token, withDetails = true) =>
	toolEnd("agent_wait", {
		content: [{ type: "text", text: JSON.stringify({ token: value, state: "waiting" }) }],
		...(withDetails ? { details: { token: value, state: "waiting" } } : {}),
	});
const cancelEnd = () => toolEnd("agent_wait_cancel", { content: [{ type: "text", text: "cancelled" }] });
const resultsEnd = () => toolEnd("agent_results", { content: [{ type: "text", text: "[]" }] });
const taskEnd = () => toolEnd("bg_task", { ok: true, message: "started" });
const wakeText = (value = token, attempt = "attempt-1") =>
	JSON.stringify({
		flowInput: ["jouzu-flow", attempt, `wait-${value}`, "1"],
		kind: "wait",
		content: JSON.stringify({ wait: { token: value, state: "ended", reason: "exit" } }),
	});
const wakeMessage = (value = token, attempt = "attempt-1") => ({
	role: "user",
	content: [{ type: "text", text: wakeText(value, attempt) }],
});
const wakeStart = (value = token, attempt = "attempt-1") => ({
	type: "message_start",
	message: wakeMessage(value, attempt),
});
const wakeEnd = (value = token, attempt = "attempt-1") => ({
	type: "message_end",
	message: wakeMessage(value, attempt),
});

/** The controlled happy path up to (but excluding) the dependency release. */
function gated() {
	return [
		response("declare"),
		taskEnd(),
		waitEnd(),
		agentEnd(),
		agentEnd(), // retries, compaction, and continuations re-emit agent_end inside one run
		settled(),
		response("status"),
		agentEnd(),
		settled(),
	];
}
const analyze = (events, releaseIndex) => analyzeFlowEvents(events, { promptIds: ["declare", "status"], releaseIndex });

test("wait tokens come from details, then result text, and only successful agent_wait ends", () => {
	assert.equal(waitTokenFromToolEnd(waitEnd()), token);
	assert.equal(waitTokenFromToolEnd(waitEnd(renewed, false)), renewed);
	assert.equal(
		waitTokenFromToolEnd(toolEnd("agent_wait", { content: [{ type: "text", text: "waiting" }] })),
		undefined,
	);
	assert.equal(waitTokenFromToolEnd(toolEnd("agent_wait", { details: { token: "not-a-token" } })), undefined);
	assert.equal(waitTokenFromToolEnd(toolEnd("agent_wait", { details: { token } }, true)), undefined);
	assert.equal(waitTokenFromToolEnd(taskEnd()), undefined);
	assert.deepEqual(declaredWaitTokens([waitEnd(), waitEnd(), waitEnd(renewed)]), [token, renewed]);
	assert.equal(successfulToolEnds([waitEnd(), taskEnd(), toolEnd("agent_wait", {}, true)], "agent_wait").length, 1);
});

test("composed wakes correlate to the declared token and dedupe repeated message events", () => {
	const frames = composedWakeFrames([wakeStart(), wakeEnd(), wakeStart(token, "attempt-2")]);
	assert.deepEqual(
		frames.map((frame) => [frame.token, frame.marker, frame.index]),
		[
			[token, JSON.stringify(["jouzu-flow", "attempt-1", `wait-${token}`, "1"]), 0],
			[token, JSON.stringify(["jouzu-flow", "attempt-2", `wait-${token}`, "1"]), 2],
		],
	);
	assert.deepEqual(
		composedWakeFrames([
			{ type: "message_update", message: wakeMessage() },
			{ type: "message_start", message: { role: "user", content: wakeText() } },
			{
				type: "message_end",
				message: {
					role: "user",
					content: [
						{
							type: "text",
							text: JSON.stringify({
								flowInput: ["jouzu-flow", "a", "b", "1"],
								kind: "work",
								content: JSON.stringify({ wait: { token } }),
							}),
						},
					],
				},
			},
			{ type: "message_end", message: { role: "user", content: [{ type: "text", text: "not json" }] } },
			{
				type: "message_end",
				message: {
					role: "user",
					content: [
						{
							type: "text",
							text: JSON.stringify({
								flowInput: ["other-marker", "a", "b", "1"],
								kind: "wait",
								content: JSON.stringify({ wait: { token } }),
							}),
						},
					],
				},
			},
			{
				type: "message_end",
				message: { role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }] },
			},
		]),
		[],
	);
});

test("usage accounting accumulates only finalized assistant responses and reports the total", () => {
	const accountant = createUsageAccountant({ maxRequests: 2, maxTokens: 100, maxUsd: 1 });
	const assistantEnd = (totalTokens, total) => ({
		type: "message_end",
		message: { role: "assistant", usage: { totalTokens, cost: { total } } },
	});
	assert.deepEqual(accountant.observe({ type: "message_update", message: assistantEnd(50, 0.5).message }), {
		ok: true,
	});
	assert.deepEqual(accountant.observe({ type: "message_end", message: { role: "user", content: "hi" } }), {
		ok: true,
	});
	assert.deepEqual(accountant.observe(assistantEnd(40, 0.2)), { ok: true });
	assert.deepEqual(accountant.observe(assistantEnd(40, 0.2)), { ok: true });
	assert.deepEqual(accountant.snapshot(), {
		requests: 2,
		tokens: 80,
		costUsd: 0.4,
		costKnown: true,
		maxRequests: 2,
		maxTokens: 100,
		maxUsd: 1,
	});
});

test("usage accounting enforces request, token, and dollar ceilings", () => {
	const limited = createUsageAccountant({ maxRequests: 2, maxTokens: 100, maxUsd: 1 });
	limited.observe({
		type: "message_end",
		message: { role: "assistant", usage: { totalTokens: 1, cost: { total: 0.1 } } },
	});
	limited.observe({
		type: "message_end",
		message: { role: "assistant", usage: { totalTokens: 1, cost: { total: 0.1 } } },
	});
	assert.equal(
		limited.observe({
			type: "message_end",
			message: { role: "assistant", usage: { totalTokens: 1, cost: { total: 0.1 } } },
		}).failure,
		"request-ceiling",
	);
	const tokens = createUsageAccountant({ maxRequests: 10, maxTokens: 100, maxUsd: 1 });
	tokens.observe({
		type: "message_end",
		message: { role: "assistant", usage: { totalTokens: 50, cost: { total: 0.1 } } },
	});
	assert.equal(
		tokens.observe({
			type: "message_end",
			message: { role: "assistant", usage: { totalTokens: 60, cost: { total: 0.1 } } },
		}).failure,
		"token-ceiling",
	);
	const dollars = createUsageAccountant({ maxRequests: 10, maxTokens: 10_000, maxUsd: 0.5 });
	dollars.observe({
		type: "message_end",
		message: { role: "assistant", usage: { totalTokens: 1, cost: { total: 0.2 } } },
	});
	assert.equal(
		dollars.observe({
			type: "message_end",
			message: { role: "assistant", usage: { totalTokens: 1, cost: { total: 0.4 } } },
		}).failure,
		"usd-ceiling",
	);
});

test("usage accounting fails responses whose cost cannot be verified", () => {
	const accountant = createUsageAccountant({ maxRequests: 10, maxTokens: 1000, maxUsd: 1 });
	const observed = accountant.observe({
		type: "message_end",
		message: { role: "assistant", usage: { totalTokens: 10, cost: { total: Number.NaN } } },
	});
	assert.equal(observed.ok, false);
	assert.equal(observed.failure, "unknown-cost");
	assert.equal(accountant.snapshot().costKnown, false);
	assert.equal(
		createUsageAccountant({ maxRequests: 10, maxTokens: 1000, maxUsd: 1 }).observe({
			type: "message_end",
			message: { role: "assistant" },
		}).failure,
		"unknown-cost",
	);
});

test("usage accounting rejects invalid ceilings", () => {
	for (const ceilings of [
		{ maxRequests: 0, maxTokens: 100, maxUsd: 1 },
		{ maxRequests: 1, maxTokens: Number.NaN, maxUsd: 1 },
		{ maxRequests: 1, maxTokens: 100, maxUsd: -1 },
	]) {
		assert.throws(() => createUsageAccountant(ceilings), /positive .* ceiling/);
	}
});

test("a clean controlled flow passes while agent_end decoys are ignored", () => {
	const { defects, summary } = analyze([...gated(), wakeStart(), wakeEnd(), agentEnd(), settled()], gated().length);
	assert.deepEqual(defects, []);
	assert.deepEqual(summary, {
		settledRuns: 3,
		backgroundTasks: 1,
		waitDeclarations: 1,
		waitCancellations: 0,
		resultQueries: 0,
		waitTokens: [token],
		composedWakes: [token],
		compactionEvents: 0,
		redirectionInputs: 0,
	});
});

test("result queries while the dependency is gated are polling; after the wake they are only counted", () => {
	const polled = analyze([...gated(), resultsEnd(), wakeStart(), agentEnd(), settled()], gated().length + 1);
	assert.ok(polled.defects.includes("polled-results"));
	assert.equal(polled.summary.resultQueries, 1);
	const retrieved = analyze([...gated(), wakeStart(), resultsEnd(), agentEnd(), settled()], gated().length);
	assert.ok(!retrieved.defects.includes("polled-results"));
	assert.equal(retrieved.summary.resultQueries, 1);
});

test("redeclaring, renewing, or cancelling during the status turn is a defect", () => {
	const redeclared = analyze(
		[
			response("declare"),
			taskEnd(),
			waitEnd(),
			settled(),
			response("status"),
			waitEnd(renewed),
			settled(),
			wakeStart(),
			settled(),
		],
		7,
	);
	assert.ok(redeclared.defects.includes("redeclared-wait-on-status-turn"));
	assert.ok(redeclared.defects.includes("renewed-wait-token"));
	const cancelled = analyze([...gated().slice(0, 7), cancelEnd(), settled(), wakeStart(), settled()], gated().length);
	assert.ok(cancelled.defects.includes("cancelled-wait"));
});

test("a wake delivered before the dependency release is misordered", () => {
	const stream = [response("declare"), taskEnd(), waitEnd(), settled(), response("status"), wakeStart(), settled()];
	const { defects } = analyze(stream, stream.length);
	assert.ok(defects.includes("wake-before-release"));
});

test("duplicate and unexpected composed wakes are defects", () => {
	const duplicate = analyze(
		[
			...gated(),
			wakeStart(token, "attempt-1"),
			wakeEnd(token, "attempt-1"),
			settled(),
			wakeStart(token, "attempt-2"),
			settled(),
		],
		gated().length,
	);
	assert.ok(duplicate.defects.includes("duplicate-composed-wake"));
	const unexpected = analyze([...gated(), wakeStart(renewed), agentEnd(), settled()], gated().length);
	assert.ok(unexpected.defects.includes("unexpected-wake-token"));
	assert.ok(unexpected.defects.includes("missing-composed-wake"));
	const missing = analyze(gated(), gated().length);
	assert.ok(missing.defects.includes("missing-composed-wake"));
	assert.ok(missing.defects.includes("settled-run-count-2"));
});

test("multiple declarations, missing declarations, and extra gated tasks are defects", () => {
	const multiple = analyze(
		[
			response("declare"),
			taskEnd(),
			waitEnd(),
			waitEnd(renewed),
			settled(),
			response("status"),
			settled(),
			wakeStart(),
			settled(),
		],
		7,
	);
	assert.ok(multiple.defects.includes("declared-multiple-waits"));
	const undeclared = analyze(
		[response("declare"), taskEnd(), settled(), response("status"), settled(), wakeStart(), settled()],
		5,
	);
	assert.ok(undeclared.defects.includes("missing-wait-declaration"));
	const extra = analyze(
		[
			response("declare"),
			taskEnd(),
			waitEnd(),
			settled(),
			response("status"),
			taskEnd(),
			settled(),
			wakeStart(),
			settled(),
		],
		7,
	);
	assert.ok(extra.defects.includes("background-task-count-2"));
});

test("compaction and redirection are recorded as confounders", () => {
	const compacted = analyze(
		[
			response("declare"),
			taskEnd(),
			waitEnd(),
			agentEnd(),
			{ type: "session_compact", compactionEntry: {} },
			settled(),
			response("status"),
			settled(),
			wakeStart(),
			settled(),
		],
		8,
	);
	assert.ok(compacted.defects.includes("compaction-during-flow"));
	assert.equal(compacted.summary.compactionEvents, 1);
	const redirected = analyze(
		[
			...gated(),
			{ type: "response", id: "aside", command: "steer", success: true },
			{ type: "input", text: "aside", streamingBehavior: "steer" },
			wakeStart(),
			settled(),
		],
		gated().length,
	);
	assert.ok(redirected.defects.includes("redirection-input"));
	assert.equal(redirected.summary.redirectionInputs, 2);
});

test("unanswered and unsettled prompts are reported per stage without status-turn false positives", () => {
	const unanswered = analyze([response("declare"), taskEnd(), waitEnd(), settled(), wakeStart(), settled()], 6);
	assert.ok(unanswered.defects.includes("unanswered-prompt-status"));
	assert.ok(!unanswered.defects.includes("redeclared-wait-on-status-turn"));
	const unsettled = analyze([response("declare"), taskEnd(), waitEnd(), settled(), response("status")], 5);
	assert.ok(unsettled.defects.includes("unsettled-prompt-status"));
	assert.throws(() => analyzeFlowEvents([], { promptIds: ["only-one"], releaseIndex: 0 }), /declare and status/);
	assert.throws(() => analyzeFlowEvents([], { promptIds: ["a", "b"], releaseIndex: -1 }), /release/);
});
