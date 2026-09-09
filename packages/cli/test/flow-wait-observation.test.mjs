import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { convertMessages, stream } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assistant, createFlowSession, model, tick } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { validateNativeProjections } from "../dist/flow-control/native-context-projections.js";
import { PiSessionFlowIngress } from "../dist/flow-control/pi-session-ingress.js";
import { openAIFlowPayload } from "../dist/flow-control/provider-payload.js";
import { createFlowWaitDecisionProducer } from "../dist/flow-control/wait-decisions.js";
import { createFlowWaitExtension } from "../dist/flow-control/wait-tools.js";

const args = {
	work: "work",
	reason: "process exit",
	deadline: "1m",
	on: [{ producer: "bg", handle: "bg-1", execution: "exec-1", until: "exit" }],
};
async function fixture(
	t,
	{
		root: supplied,
		manager,
		change,
		failure = false,
		automatic = false,
		issueTool = true,
		api = "openai-completions",
		toolCount = 1,
	} = {},
) {
	const root = supplied ?? (await mkdtemp(join(tmpdir(), "jouzu-wait-observation-"))),
		errors = [],
		sent = [];
	const ingress = new PiSessionFlowIngress({
		root: join(root, "receipts"),
		maxInputBytes: 8192,
		maxResultBytes: 8192,
		autoRelease: automatic ? { onError: (error) => errors.push(error) } : undefined,
		host: {
			projections: new Map(api === "anthropic-messages" ? [] : [[api, openAIFlowPayload(api)]]),
			maxPayloadBytes: 1000000,
			containsUserInput: () => true,
		},
		policy: () => ({ userPending: false, recoveryBlocked: false, waitingWorkIds: [] }),
		async attachWaitSources(attachment) {
			const work = await attachment.waits.registerWork("work", "lane", Date.now());
			if (!work.participants.includes("bg"))
				await attachment.waits.shareWork("work", "lane", work.revision, "bg", Date.now());
			attachment.waitProducers.register(
				{
					version: 1,
					namespace: "bg",
					subscribe: () => () => {},
					snapshot: async (identity) => ({
						...identity,
						revision: 2,
						predicates: [{ until: "exit", state: "satisfied" }],
					}),
				},
				(error) => errors.push(error),
			);
		},
	});
	const extension = createFlowWaitExtension({
		attachment: () => ingress.branch().attachment,
		maxDurationMs: 60000,
		authorize(workId) {
			if (workId !== "work") throw new Error("unauthorized work");
			const branch = ingress.branch();
			return {
				actor: "lane",
				revision: 2,
				assertActive() {
					assert.equal(ingress.branch(), branch);
				},
			};
		},
	});
	let wrapped;
	const { session } = await createFlowSession(t, {
		persist: true,
		model: { ...model, api },
		sessionManager: manager,
		tools: ["agent_wait", "agent_wait_cancel"],
		extensions: [
			extension,
			...(change ? [(pi) => pi.on("before_provider_request", ({ payload }) => change(payload))] : []),
		],
		ingress: {
			version: 1,
			async attach(session) {
				session.agent.streamFunction = (model, context, options) =>
					(api === "anthropic-messages" ? streamAnthropic : api === "openai-responses" ? streamResponses : stream)(
						{ ...model, baseUrl: "https://fixture.invalid/v1" },
						context,
						{
							...options,
							apiKey: "fixture",
							maxRetries: 0,
							fetch: async (_url, init) => {
								sent.push(JSON.parse(init.body));
								if (failure && sent.length === 2) return new Response("fixture unavailable", { status: 503 });
								const tool = issueTool && sent.length === 1;
								if (api === "anthropic-messages") {
									const events = [
										{
											type: "message_start",
											message: {
												id: "fixture",
												type: "message",
												role: "assistant",
												model: model.id,
												content: [],
												usage: { input_tokens: 1, output_tokens: 1 },
											},
										},
									];
									for (let index = 0; index < (tool ? toolCount : 1); index++) {
										events.push({
											type: "content_block_start",
											index,
											content_block: tool
												? { type: "tool_use", id: `wait_${index}`, name: "agent_wait", input: {} }
												: { type: "text", text: "Done" },
										});
										if (tool)
											events.push({
												type: "content_block_delta",
												index,
												delta: { type: "input_json_delta", partial_json: JSON.stringify(args) },
											});
										events.push({ type: "content_block_stop", index });
									}
									events.push(
										{
											type: "message_delta",
											delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
											usage: { output_tokens: 1 },
										},
										{ type: "message_stop" },
									);
									return new Response(
										events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
										{ headers: { "content-type": "text/event-stream" } },
									);
								}
								if (api === "openai-responses") {
									const item = tool
										? {
												type: "function_call",
												id: "fc_wait",
												call_id: "wait_call",
												name: "agent_wait",
												arguments: JSON.stringify(args),
												status: "completed",
											}
										: {
												type: "message",
												id: "msg_done",
												role: "assistant",
												content: [{ type: "output_text", text: "Done", annotations: [] }],
												status: "completed",
											};
									const events = [
										{ type: "response.output_item.done", output_index: 0, item },
										{ type: "response.completed", response: { id: "fixture", status: "completed", output: [item] } },
									];
									return new Response(
										events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
										{ headers: { "content-type": "text/event-stream" } },
									);
								}
								const delta = tool
									? {
											tool_calls: [
												{
													index: 0,
													id: "wait|call$1",
													type: "function",
													function: { name: "agent_wait", arguments: JSON.stringify(args) },
												},
											],
										}
									: { content: "Done" };
								return new Response(
									`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
									{ headers: { "content-type": "text/event-stream" } },
								);
							},
						},
					);
				await ingress.attach(session);
				wrapped = session.agent.streamFunction;
			},
			submit: (...args) => ingress.submit(...args),
			beforeBranchChange: () => ingress.beforeBranchChange(),
			branchChanged: () => ingress.branchChanged(),
			dispose: () => ingress.dispose(),
		},
	});
	session.agent.streamFunction = wrapped;
	await session.bindExtensions({ onError: (error) => errors.push(error) });
	t.after(async () => {
		await ingress.dispose();
		if (!supplied) await rm(root, { recursive: true, force: true });
	});
	const decisions = () => {
		const attachment = ingress.branch().attachment;
		return createFlowWaitDecisionProducer(attachment.waits, {
			submissions: attachment.submissions,
			requests: attachment.nativeRequests,
		}).snapshot(new AbortController().signal);
	};
	return { root, session, ingress, sent, errors, decisions };
}

for (const api of ["openai-completions", "openai-responses", "anthropic-messages"]) {
	const payloadRows = (payload) => payload[api === "openai-responses" ? "input" : "messages"];
	const isTool = (message) =>
		api === "anthropic-messages"
			? message.type === "tool_result"
			: api === "openai-responses"
				? message.type === "function_call_output"
				: message.role === "tool";
	const toolRows = (payload) =>
		api === "anthropic-messages"
			? payloadRows(payload).flatMap((row) => (Array.isArray(row.content) ? row.content.filter(isTool) : []))
			: payloadRows(payload).filter(isTool);
	const omitTools = (payload) => {
		if (api === "anthropic-messages") {
			for (const row of payloadRows(payload))
				if (Array.isArray(row.content)) row.content = row.content.filter((block) => !isTool(block));
		} else
			payload[api === "openai-responses" ? "input" : "messages"] = payloadRows(payload).filter(
				(message) => !isTool(message),
			);
	};
	test(`${api}: successful tool observation absorbs immediate wait resolution without another wake and survives reopening`, async (t) => {
		const f = await fixture(t, { automatic: true, api });
		await f.session.prompt("wait for the finished process");
		await f.ingress.wakeProducers();
		await tick();
		await tick();
		assert.equal(f.sent.length, 2);
		const attachment = f.ingress.branch().attachment;
		assert.equal((await attachment.waits.snapshot())[0].state, "resolved");
		assert.equal((await attachment.waits.toolReceipts()).length, 1);
		const records = await attachment.nativeRequests.snapshot();
		assert.equal(records[1].projectionCapture.members[0].message.role, "toolResult");
		assert.deepEqual(records[1].requiredProjections, []);
		assert.equal(records[1].payload.projections[0].disposition, "included");
		assert.equal(toolRows(f.sent[1]).length, 1);
		assert.deepEqual(await f.decisions(), []);
		assert.deepEqual(f.errors, []);
		await f.ingress.dispose();
		const next = await fixture(t, {
			root: f.root,
			api,
			manager: SessionManager.open(f.session.sessionManager.getSessionFile()),
			automatic: true,
			issueTool: false,
		});
		await next.ingress.wakeProducers();
		await tick();
		assert.deepEqual(next.sent, []);
		assert.deepEqual(await next.decisions(), []);
		await next.session.prompt("status");
		assert.equal(next.sent.length, 1);
		assert.equal(
			payloadRows(next.sent[0]).filter(
				(message) => message.role === "user" && JSON.stringify(message.content).includes("waitDecisions"),
			).length,
			0,
		);
		await next.ingress.dispose();
	});

	test(`${api}: a later user prompt observes the pending decision through required wait context`, async (t) => {
		const f = await fixture(t, {
			api,
			change(payload) {
				omitTools(payload);
			},
		});
		await f.session.prompt("wait");
		assert.equal((await f.decisions()).length, 1);
		await f.session.prompt("status");
		assert.equal(f.sent.length, 3);
		assert.ok(
			payloadRows(f.sent[2]).some(
				(message) => message.role === "user" && JSON.stringify(message.content).includes("waitDecisions"),
			),
		);
		assert.deepEqual(await f.decisions(), []);
		assert.deepEqual(f.errors, []);
	});

	for (const mode of ["changed", "omitted", "cloned"])
		test(`${api}: ${mode} required user content is withheld before transport`, async (t) => {
			const f = await fixture(t, {
				api,
				issueTool: false,
				change(payload) {
					const row = payloadRows(payload).find((message) => message.role === "user");
					if (mode === "changed")
						row.content = [{ type: api === "openai-responses" ? "input_text" : "text", text: "replaced" }];
					if (mode === "omitted")
						payload[api === "openai-responses" ? "input" : "messages"] = payloadRows(payload).filter(
							(message) => message !== row,
						);
					if (mode === "cloned") return structuredClone(payload);
				},
			});
			await f.session.prompt("required user instruction");
			assert.deepEqual(f.sent, []);
			const [record] = await f.ingress.branch().attachment.nativeRequests.snapshot();
			assert.equal(record.outcome, "withheld");
			assert.ok(record.requiredSources.length > 0);
			assert.equal(record.withheldPayload.sources[0].disposition, mode === "changed" ? "changed" : "unresolved");
			assert.deepEqual(f.errors, []);
		});

	for (const mode of ["content", "identity", "omitted", "failed"])
		test(`${api}: ${mode} tool payload keeps its wait decision pending`, async (t) => {
			const f = await fixture(t, {
				api,
				failure: mode === "failed",
				change:
					mode === "failed"
						? undefined
						: (payload) => {
								const tool = toolRows(payload)[0];
								if (!tool) return;
								if (mode === "content") tool[api === "openai-responses" ? "output" : "content"] += " altered";
								if (mode === "identity")
									tool[
										api === "anthropic-messages"
											? "tool_use_id"
											: api === "openai-responses"
												? "call_id"
												: "tool_call_id"
									] += "-other";
								if (mode === "omitted") omitTools(payload);
							},
			});
			await f.session.prompt("wait");
			assert.equal(f.sent.length, 2);
			const record = (await f.ingress.branch().attachment.nativeRequests.snapshot())[1];
			assert.equal(record.outcome, mode === "failed" ? "failure" : "success");
			assert.equal(
				record.payload.projections[0].disposition,
				mode === "failed" ? "included" : mode === "omitted" ? "unresolved" : "changed",
			);
			assert.equal((await f.decisions()).length, 1);
			assert.deepEqual(f.errors, []);
		});
}

test("provider maps retained tool results and leaves synthetic orphan results unobserved", () => {
	const call = assistant();
	call.content = [{ type: "toolCall", id: "orphan", name: "agent_wait", arguments: args }];
	call.stopReason = "toolUse";
	const user = { role: "user", content: "continue", timestamp: 2 };
	const observed = [];
	const rows = convertMessages(
		model,
		{ messages: [call, user] },
		{},
		{
			onMessageConverted: (source, output) => observed.push({ source, output }),
		},
	);
	assert.equal(rows.filter((row) => row.role === "tool").length, 1);
	assert.equal(observed.length, 1);
	assert.equal(observed[0].source, user);
	assert.equal(observed[0].output.role, "user");
});

test("Anthropic grouped terminal waits retain distinct block receipts through reopening", async (t) => {
	const api = "anthropic-messages";
	const f = await fixture(t, { api, automatic: true, toolCount: 2 });
	await f.session.prompt("wait for both");
	await f.ingress.wakeProducers();
	await tick();
	assert.equal(f.sent.length, 2);
	const [row] = f.sent[1].messages.filter(
		(row) => Array.isArray(row.content) && row.content.some((block) => block.type === "tool_result"),
	);
	assert.equal(row.content.filter((block) => block.type === "tool_result").length, 2);
	assert.ok(
		row.content.every((block) => !block.is_error),
		JSON.stringify(row.content),
	);
	const record = (await f.ingress.branch().attachment.nativeRequests.snapshot())[1];
	assert.deepEqual(
		record.payload.projections.map(({ index, blockIndex, disposition }) => ({ index, blockIndex, disposition })),
		[
			{ index: f.sent[1].messages.indexOf(row), blockIndex: 0, disposition: "included" },
			{ index: f.sent[1].messages.indexOf(row), blockIndex: 1, disposition: "included" },
		],
	);
	assert.deepEqual(await f.decisions(), []);
	const validate = (payload) =>
		validateNativeProjections(record.projectionCapture, record.transformedHash, record.modelHash, payload);
	validate(record.payload);
	for (const mode of ["duplicate", "negative", "fractional", "unqualified", "whole-row", "source-overlap"]) {
		const payload = structuredClone(record.payload);
		if (mode === "duplicate") payload.projections[1].blockIndex = 0;
		if (mode === "negative") payload.projections[1].blockIndex = -1;
		if (mode === "fractional") payload.projections[1].blockIndex = 0.5;
		if (mode === "unqualified") payload.api = "openai-completions";
		if (mode === "whole-row") delete payload.projections[1].blockIndex;
		if (mode === "source-overlap") payload.sources = [{ ...payload.projections[0] }];
		assert.throws(() => validate(payload), { code: "identity" }, mode);
	}
	await f.ingress.dispose();
	const next = await fixture(t, {
		api,
		root: f.root,
		manager: SessionManager.open(f.session.sessionManager.getSessionFile()),
		automatic: true,
		issueTool: false,
	});
	await next.ingress.wakeProducers();
	await tick();
	assert.deepEqual(next.sent, []);
	assert.deepEqual(await next.decisions(), []);
	assert.deepEqual(f.errors, []);
	assert.deepEqual(next.errors, []);
});
