import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamAzure } from "@earendil-works/pi-ai/api/azure-openai-responses";
import { stream as streamGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";
import { stream as streamVertex } from "@earendil-works/pi-ai/api/google-vertex";
import { stream as streamMistral } from "@earendil-works/pi-ai/api/mistral-conversations";
import { convertMessages, stream } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as streamPiMessages } from "@earendil-works/pi-ai/api/pi-messages";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assistant, createFlowSession, model, tick } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { anthropicFlowPayload } from "../dist/flow-control/anthropic-payload.js";
import { bedrockFlowPayload } from "../dist/flow-control/bedrock-payload.js";
import { googleFlowPayload } from "../dist/flow-control/google-payload.js";
import { mistralFlowPayload } from "../dist/flow-control/mistral-payload.js";
import { validateNativeProjections } from "../dist/flow-control/native-context-projections.js";
import { piMessagesFlowPayload } from "../dist/flow-control/pi-messages-payload.js";
import { PiSessionFlowIngress } from "../dist/flow-control/pi-session-ingress.js";
import { openAIFlowPayload } from "../dist/flow-control/provider-payload.js";
import { createFlowWaitDecisionProducer } from "../dist/flow-control/wait-decisions.js";
import { createFlowWaitExtension } from "../dist/flow-control/wait-tools.js";
import { bedrockTransport } from "./fixtures/bedrock-transport.mjs";
import { codexTransport } from "./fixtures/codex-transport.mjs";

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
		pending = false,
		codexMode = "auto",
		vertexAuth = "key",
		credentialFailureAt = 0,
	} = {},
) {
	const root = supplied ?? (await mkdtemp(join(tmpdir(), "jouzu-wait-observation-"))),
		errors = [],
		sent = [];
	const codex =
		api === "openai-codex-responses"
			? codexTransport(t, {
					transport: codexMode,
					onRequest: (request) => sent.push(request.body),
					fail: (_request, count) => (failure && count === 2 ? "server_error" : undefined),
					reply: (_request, count) =>
						issueTool && count === 1
							? Array.from({ length: toolCount }, (_, index) => ({
									type: "function_call",
									id: `fc_wait_${index}`,
									call_id: `wait_${index}`,
									name: "agent_wait",
									arguments: JSON.stringify(args),
									status: "completed",
								}))
							: undefined,
				})
			: undefined;
	let authRequests = 0;
	if (api === "google-vertex" && vertexAuth === "adc") {
		const providerRequire = createRequire(import.meta.resolve("@earendil-works/pi-ai/api/google-vertex"));
		const { GoogleAuth } = createRequire(providerRequire.resolve("@google/genai"))("google-auth-library");
		t.mock.method(GoogleAuth.prototype, "getRequestHeaders", async () => {
			authRequests++;
			if (authRequests === credentialFailureAt) throw new Error("fixture credentials unavailable");
			return new Headers({ Authorization: "Bearer fixture" });
		});
	}
	let sourceState = pending ? "pending" : "satisfied",
		registration;
	const listeners = new Set();
	const evidence = (identity) => ({
		...identity,
		revision: sourceState === "pending" ? 1 : 2,
		predicates: [{ until: "exit", state: sourceState }],
	});
	const ingress = new PiSessionFlowIngress({
		root: join(root, "receipts"),
		maxInputBytes: 8192,
		maxResultBytes: 8192,
		autoRelease: automatic ? { onError: (error) => errors.push(error) } : undefined,
		host: {
			projections: new Map([
				[
					api,
					["google-generative-ai", "google-vertex"].includes(api)
						? googleFlowPayload
						: api === "bedrock-converse-stream"
							? bedrockFlowPayload
							: api === "pi-messages"
								? piMessagesFlowPayload
								: api === "mistral-conversations"
									? mistralFlowPayload
									: api === "anthropic-messages"
										? anthropicFlowPayload
										: openAIFlowPayload(
												["openai-codex-responses", "azure-openai-responses"].includes(api) ? "openai-responses" : api,
											),
				],
			]),
			maxPayloadBytes: 1000000,
			containsUserInput: () => false,
		},
		policy: () => ({ userPending: false, recoveryBlocked: false, waitingWorkIds: [] }),
		async attachWaitSources(attachment) {
			const work = await attachment.waits.registerWork("work", "lane", Date.now());
			if (!work.participants.includes("bg"))
				await attachment.waits.shareWork("work", "lane", work.revision, "bg", Date.now());
			registration = attachment.waitProducers.register(
				{
					version: 1,
					namespace: "bg",
					subscribe(identity, changed) {
						const listener = { identity, changed };
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
					snapshot: async (identity) => evidence(identity),
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
		model: {
			...model,
			api,
			...(["google-generative-ai", "google-vertex"].includes(api)
				? { id: "gemini-3.1-pro-preview", provider: api === "google-vertex" ? "google-vertex" : "google" }
				: {}),
			...(api === "openai-codex-responses" ? { id: "gpt-5.4", provider: "openai-codex" } : {}),
			...(api === "azure-openai-responses" ? { id: "gpt-4.1", provider: "azure-openai-responses" } : {}),
			...(api === "mistral-conversations" ? { id: "mistral-small-latest", provider: "mistral" } : {}),
			...(api === "pi-messages" ? { id: "fixture", provider: "radius" } : {}),
		},
		sessionManager: manager,
		tools: ["agent_wait", "agent_wait_cancel"],
		extensions: [
			extension,
			...(change ? [(pi) => pi.on("before_provider_request", ({ payload }) => change(payload))] : []),
		],
		ingress: {
			version: 1,
			async attach(session) {
				if (api === "bedrock-converse-stream")
					session.agent.streamFunction = bedrockTransport(t, {
						onRequest: (body) => sent.push(body),
						failure: (count) => failure && count === 2,
						reply(count) {
							const tool = issueTool && count === 1;
							const events = [["messageStart", { role: "assistant" }]];
							for (let index = 0; index < (tool ? toolCount : 1); index++) {
								if (tool)
									events.push([
										"contentBlockStart",
										{
											contentBlockIndex: index,
											start: { toolUse: { toolUseId: `wait_${index}`, name: "agent_wait" } },
										},
									]);
								events.push([
									"contentBlockDelta",
									{
										contentBlockIndex: index,
										delta: tool ? { toolUse: { input: JSON.stringify(args) } } : { text: "Done" },
									},
								]);
								events.push(["contentBlockStop", { contentBlockIndex: index }]);
							}
							events.push(["messageStop", { stopReason: tool ? "tool_use" : "end_turn" }]);
							return events;
						},
					});
				else if (codex) session.agent.streamFunction = codex.stream;
				else if (["google-generative-ai", "google-vertex"].includes(api)) {
					t.mock.method(globalThis, "fetch", async (_url, init) => {
						sent.push(JSON.parse(init.body));
						if (failure && sent.length === 2) return new Response("fixture unavailable", { status: 503 });
						const parts =
							issueTool && sent.length === 1
								? Array.from({ length: toolCount }, (_, index) => ({
										functionCall: { id: `wait_${index}`, name: "agent_wait", args },
									}))
								: [{ text: "Done" }];
						return new Response(
							`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }] })}\n\n`,
							{ headers: { "Content-Type": "text/event-stream" } },
						);
					});
					session.agent.streamFunction = (model, context, options) =>
						(api === "google-vertex" ? streamVertex : streamGoogle)(model, context, {
							...options,
							apiKey: api === "google-vertex" && vertexAuth === "adc" ? undefined : "fixture",
							...(api === "google-vertex" && vertexAuth === "adc"
								? { project: "fixture-project", location: "us-central1", env: {} }
								: {}),
							maxRetries: 0,
						});
				} else
					session.agent.streamFunction = (model, context, options) =>
						(api === "pi-messages"
							? streamPiMessages
							: api === "mistral-conversations"
								? streamMistral
								: api === "anthropic-messages"
									? streamAnthropic
									: api === "azure-openai-responses"
										? streamAzure
										: api === "openai-responses"
											? streamResponses
											: stream)({ ...model, baseUrl: "https://fixture.invalid/v1" }, context, {
							...options,
							apiKey: "fixture",
							maxRetries: 0,
							fetch: async (_url, init) => {
								sent.push(JSON.parse(init.body));
								if (failure && sent.length === 2) return new Response("fixture unavailable", { status: 503 });
								const tool = issueTool && sent.length === 1;
								if (api === "pi-messages") {
									const events = tool
										? [
												{ type: "toolcall_start", contentIndex: 0, id: "wait_call", toolName: "agent_wait" },
												{
													type: "toolcall_end",
													contentIndex: 0,
													toolCall: { type: "toolCall", id: "wait_call", name: "agent_wait", arguments: args },
												},
											]
										: [
												{ type: "text_start", contentIndex: 0 },
												{ type: "text_end", contentIndex: 0, content: "Done" },
											];
									events.push({ type: "done", reason: tool ? "toolUse" : "stop", usage: assistant().usage });
									return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
										headers: { "content-type": "text/event-stream" },
									});
								}
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
								if (["openai-responses", "azure-openai-responses"].includes(api)) {
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
						});
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
	return {
		root,
		session,
		ingress,
		sent,
		errors,
		decisions,
		codex,
		get authRequests() {
			return authRequests;
		},
		async complete(wake = true) {
			sourceState = "satisfied";
			for (const listener of listeners) listener.changed(evidence(listener.identity));
			await registration.flushExecution("exec-1");
			if (wake) await ingress.wakeProducers();
		},
	};
}

for (const api of [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"openai-codex-responses",
	"azure-openai-responses",
	"mistral-conversations",
	"pi-messages",
	"bedrock-converse-stream",
]) {
	const container = (payload) => (api === "pi-messages" ? payload.context : payload);
	const payloadRows = (payload) =>
		container(payload)[
			["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(api) ? "input" : "messages"
		];
	const isTool = (message) =>
		api === "bedrock-converse-stream"
			? !!message.toolResult
			: api === "pi-messages"
				? message.role === "toolResult"
				: api === "anthropic-messages"
					? message.type === "tool_result"
					: ["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(api)
						? message.type === "function_call_output"
						: message.role === "tool";
	const toolRows = (payload) =>
		["anthropic-messages", "bedrock-converse-stream"].includes(api)
			? payloadRows(payload).flatMap((row) => (Array.isArray(row.content) ? row.content.filter(isTool) : []))
			: payloadRows(payload).filter(isTool);
	const omitTools = (payload) => {
		if (["anthropic-messages", "bedrock-converse-stream"].includes(api)) {
			for (const row of payloadRows(payload))
				if (Array.isArray(row.content)) row.content = row.content.filter((block) => !isTool(block));
		} else
			container(payload)[
				["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(api) ? "input" : "messages"
			] = payloadRows(payload).filter((message) => !isTool(message));
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
		if (api === "openai-codex-responses") {
			assert.equal(f.sent[0].type, "response.create");
			assert.equal(f.sent[1].previous_response_id, "response_1");
		}
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
						row.content = [
							{
								type: ["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(api)
									? "input_text"
									: "text",
								text: "replaced",
							},
						];
					if (mode === "omitted")
						container(payload)[
							["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(api)
								? "input"
								: "messages"
						] = payloadRows(payload).filter((message) => message !== row);
					if (mode === "cloned")
						return api === "pi-messages" ? JSON.parse(JSON.stringify(payload)) : structuredClone(payload);
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
								const block = toolRows(payload)[0];
								const tool = api === "bedrock-converse-stream" ? block?.toolResult : block;
								if (!tool) return;
								if (mode === "content")
									tool[
										["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(api)
											? "output"
											: "content"
									] += " altered";
								if (mode === "identity")
									tool[
										api === "bedrock-converse-stream"
											? "toolUseId"
											: api === "anthropic-messages"
												? "tool_use_id"
												: ["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(api)
													? "call_id"
													: ["mistral-conversations", "pi-messages"].includes(api)
														? "toolCallId"
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

for (const api of [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
	"google-vertex",
	"openai-codex-responses",
])
	test(`${api}: later dependency completion dispatches one retained decision and survives reopening`, async (t) => {
		const f = await fixture(t, { api, automatic: true, pending: true });
		await f.session.prompt("wait until the process exits");
		assert.equal(f.sent.length, 2);
		assert.equal((await f.ingress.branch().attachment.waits.snapshot())[0].state, "waiting");
		await f.ingress.wakeProducers();
		await tick();
		assert.equal(f.sent.length, 2);
		await f.complete(false);
		const deadline = Date.now() + 5000;
		while (
			!(await f.ingress.branch().attachment.ledger.snapshot()).attempts.some((attempt) => attempt.phase === "settled")
		) {
			assert.ok(Date.now() < deadline, "automatic dependency delivery did not settle");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(f.sent.length, 3);
		const state = await f.ingress.branch().attachment.ledger.snapshot();
		assert.equal(state.attempts.length, 1);
		assert.equal(state.attempts[0].phase, "settled");
		assert.equal(state.attempts[0].outcome, "success");
		assert.equal(state.attempts[0].members[0].kind, "wait");
		assert.equal(state.attempts[0].requests[0].payload.api, api);
		assert.equal(state.attempts[0].requests[0].payload.inclusion[0].disposition, "included");
		if (api === "openai-codex-responses")
			assert.ok(
				f.codex.requests[2].input.some(
					(row) => row.role === "user" && row.content?.some((part) => part.text?.includes('"kind":"wait"')),
				),
			);
		await f.ingress.wakeProducers();
		await tick();
		assert.equal(f.sent.length, 3);
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
		await next.session.prompt("status");
		assert.equal(next.sent.length, 1);
		assert.equal((await next.ingress.branch().attachment.ledger.snapshot()).attempts.length, 1);
		assert.deepEqual(f.errors, []);
		assert.deepEqual(next.errors, []);
	});

for (const mode of ["replaced", "omitted", "tool-copy", "tool-gap"])
	test(`Anthropic ${mode} decision payload is withheld without losing its wait obligation`, async (t) => {
		const f = await fixture(t, {
			api: "anthropic-messages",
			pending: true,
			change(payload) {
				for (const [index, row] of payload.messages.entries()) {
					if (row.role !== "user" || !Array.isArray(row.content)) continue;
					const part = row.content.find(
						(part) => part.type === "text" && part.text.includes('"flowInput"') && part.text.includes('"kind":"wait"'),
					);
					if (!part) continue;
					if (mode === "replaced") {
						const frame = JSON.parse(part.text);
						frame.content = "changed";
						part.text = JSON.stringify(frame);
					}
					if (mode === "omitted") row.content = row.content.filter((candidate) => candidate !== part);
					if (mode === "tool-copy")
						payload.messages.splice(
							index,
							1,
							{ role: "assistant", content: [{ type: "tool_use", id: "copy", name: "read", input: {} }] },
							{ role: "user", content: [{ type: "tool_result", tool_use_id: "copy", content: [part] }, part] },
						);
					if (mode === "tool-gap")
						payload.messages.splice(index, 0, {
							role: "assistant",
							content: [{ type: "tool_use", id: "missing", name: "read", input: {} }],
						});
					break;
				}
			},
		});
		await f.session.prompt("wait");
		await f.complete();
		assert.equal(f.sent.length, 2);
		const [attempt] = (await f.ingress.branch().attachment.ledger.snapshot()).attempts;
		assert.equal(attempt.phase, "withheld");
		assert.equal(attempt.requests[0].handedOff, false);
		assert.equal(
			attempt.requests[0].payload.inclusion[0].disposition,
			mode === "replaced" ? "replaced" : mode === "tool-gap" ? "rejected" : "omitted",
		);
		assert.equal((await f.decisions()).length, 1);
		await f.ingress.wakeProducers();
		assert.equal(f.sent.length, 2);
		assert.deepEqual(f.errors, []);
	});

for (const api of ["google-generative-ai", "google-vertex"])
	for (const mode of ["intact", "content", "omitted", "failed"])
		test(`${api} grouped wait tool observation through SDK transport: ${mode}`, async (t) => {
			const f = await fixture(t, {
				api,
				toolCount: 2,
				automatic: mode === "intact",
				failure: mode === "failed",
				change(payload) {
					const row = payload.contents.find((row) => row.parts.some((part) => part.functionResponse));
					if (!row) return;
					if (mode === "content") row.parts[0].functionResponse.response.output += " changed";
					if (mode === "omitted") row.parts.shift();
				},
			});
			await f.session.prompt("wait for the finished process");
			if (mode === "intact") {
				await f.ingress.wakeProducers();
				await tick();
			}
			assert.equal(f.sent.length, 2);
			const attachment = f.ingress.branch().attachment;
			const records = await attachment.nativeRequests.snapshot();
			assert.deepEqual(
				records[1].payload.projections.map((p) => p.disposition),
				[mode === "content" ? "changed" : mode === "omitted" ? "unresolved" : "included", "included"],
			);
			assert.equal((await f.decisions()).length, mode === "intact" ? 0 : mode === "failed" ? 2 : 1);
			assert.deepEqual(f.errors, []);
			if (mode !== "intact") {
				await f.session.prompt("report the wait status");
				assert.deepEqual(await f.decisions(), []);
				return;
			}
			assert.deepEqual(
				records[1].payload.projections.map((p) => [p.index, p.blockIndex]),
				[
					[2, 0],
					[2, 1],
				],
			);
			for (const change of ["missing", "overlap", "unqualified"]) {
				const payload = structuredClone(records[1].payload);
				if (change === "missing") delete payload.projections[0].blockIndex;
				if (change === "overlap") payload.projections[1].blockIndex = 0;
				if (change === "unqualified") payload.api = "pi-messages";
				assert.throws(() =>
					validateNativeProjections(
						records[1].projectionCapture,
						records[1].transformedHash,
						records[1].modelHash,
						payload,
					),
				);
			}
			await f.ingress.dispose();
			const next = await fixture(t, {
				root: f.root,
				api,
				automatic: true,
				issueTool: false,
				manager: f.session.sessionManager,
			});
			await next.ingress.wakeProducers();
			assert.deepEqual(next.sent, []);
			assert.deepEqual(await next.decisions(), []);
			await next.session.prompt("continue");
			assert.equal(next.sent.length, 1);
			assert.deepEqual(await next.decisions(), []);
		});

for (const api of ["google-generative-ai", "google-vertex"])
	for (const mode of ["replaced", "omitted", "extra-body"])
		test(`${api} ${mode} decision is withheld and retained`, async (t) => {
			const f = await fixture(t, {
				api,
				pending: true,
				change(payload) {
					for (const row of payload.contents) {
						const part = row.parts.find(
							(part) =>
								typeof part.text === "string" &&
								part.text.includes('"flowInput"') &&
								part.text.includes('"kind":"wait"'),
						);
						if (!part) continue;
						if (mode === "replaced") {
							const frame = JSON.parse(part.text);
							frame.content = "changed";
							part.text = JSON.stringify(frame);
						}
						if (mode === "omitted") row.parts = row.parts.filter((candidate) => candidate !== part);
						if (mode === "extra-body") payload.config.httpOptions = { extraBody: { contents: [] } };
					}
				},
			});
			await f.session.prompt("wait");
			await f.complete();
			assert.equal(f.sent.length, 2);
			const [attempt] = (await f.ingress.branch().attachment.ledger.snapshot()).attempts;
			assert.equal(attempt.phase, "withheld");
			assert.equal(attempt.requests[0].handedOff, false);
			assert.equal(
				attempt.requests[0].payload.inclusion[0].disposition,
				mode === "replaced" ? "replaced" : mode === "omitted" ? "omitted" : "rejected",
			);
			assert.equal((await f.decisions()).length, 1);
			await f.ingress.wakeProducers();
			assert.equal(f.sent.length, 2);
		});

for (const codexMode of ["sse", "websocket", "websocket-cached"])
	for (const pending of [false, true])
		test(`Codex ${codexMode} ${pending ? "later" : "immediate"} wait delivery`, async (t) => {
			const f = await fixture(t, { api: "openai-codex-responses", codexMode, automatic: true, pending });
			await f.session.prompt("wait");
			if (pending) await f.complete();
			await f.ingress.wakeProducers();
			assert.equal(f.sent.length, pending ? 3 : 2);
			if (!pending) assert.deepEqual(await f.decisions(), []);
			else assert.equal((await f.ingress.branch().attachment.ledger.snapshot()).attempts[0].phase, "settled");
			assert.equal(f.codex.requests[0].transport, codexMode === "sse" ? "sse" : "websocket");
			assert.equal(f.sent[1].previous_response_id, codexMode === "websocket-cached" ? "response_1" : undefined);
			assert.deepEqual(f.errors, []);
		});

for (const mode of ["replaced", "omitted", "tool-copy", "tool-gap"])
	test(`Codex ${mode} decision is withheld before cached transport`, async (t) => {
		const f = await fixture(t, {
			api: "openai-codex-responses",
			pending: true,
			change(payload) {
				for (const [index, row] of payload.input.entries()) {
					if (row.role !== "user") continue;
					const part = row.content.find(
						(part) => part.text?.includes('"flowInput"') && part.text.includes('"kind":"wait"'),
					);
					if (!part) continue;
					if (mode === "replaced") {
						const frame = JSON.parse(part.text);
						frame.content = "changed";
						part.text = JSON.stringify(frame);
					}
					if (mode === "omitted") row.content = row.content.filter((candidate) => candidate !== part);
					if (mode === "tool-copy")
						payload.input.splice(
							index,
							1,
							{ type: "function_call", name: "read", call_id: "copy", arguments: "{}" },
							{ type: "function_call_output", call_id: "copy", output: part.text },
						);
					if (mode === "tool-gap")
						payload.input.splice(index, 0, {
							type: "function_call",
							name: "read",
							call_id: "missing",
							arguments: "{}",
						});
					break;
				}
			},
		});
		await f.session.prompt("wait");
		await f.complete();
		assert.equal(f.sent.length, 2);
		const [attempt] = (await f.ingress.branch().attachment.ledger.snapshot()).attempts;
		assert.equal(attempt.phase, "withheld");
		assert.equal(attempt.requests[0].handedOff, false);
		assert.equal((await f.decisions()).length, 1);
		await f.ingress.wakeProducers();
		assert.equal(f.sent.length, 2);
	});

for (const credentialFailureAt of [0, 2])
	test(`Vertex ADC wait observation with credential failure at ${credentialFailureAt}`, async (t) => {
		const f = await fixture(t, { api: "google-vertex", vertexAuth: "adc", credentialFailureAt });
		await f.session.prompt("wait");
		assert.equal(f.authRequests, 2);
		assert.equal(f.sent.length, credentialFailureAt ? 1 : 2);
		const records = await f.ingress.branch().attachment.nativeRequests.snapshot();
		assert.equal(records[1].outcome, credentialFailureAt ? "failure" : "success");
		assert.equal(records[1].payload.projections[0].disposition, "included");
		assert.equal((await f.decisions()).length, credentialFailureAt ? 1 : 0);
		if (credentialFailureAt) {
			await f.session.prompt("report the wait status");
			assert.equal(f.authRequests, 3);
			assert.equal(f.sent.length, 2);
			assert.deepEqual(await f.decisions(), []);
		}
		assert.deepEqual(f.errors, []);
	});

for (const observed of [true, false])
	test(`host wait retirement preserves unobserved decisions: observed=${observed}`, async (t) => {
		const f = await fixture(t, { failure: !observed });
		await f.session.prompt("wait");
		const original = (await f.ingress.branch().attachment.waits.snapshot())[0];
		assert.equal(original.state, "resolved");
		const result = await f.ingress.retireWaitHistory();
		assert.equal(result.waits, observed ? 1 : 0);
		assert.equal((await f.ingress.branch().attachment.waits.snapshot()).length, observed ? 0 : 1);
		assert.equal((await f.decisions()).length, observed ? 0 : 1);
		if (observed) assert.deepEqual(await f.ingress.retireWaitHistory(), { waits: 0, work: 0, executions: 0 });
		assert.deepEqual(f.errors, []);
	});

test("host wait retirement recognizes a settled composed decision", async (t) => {
	const f = await fixture(t, { automatic: true, pending: true });
	await f.session.prompt("wait");
	assert.equal((await f.ingress.branch().attachment.waits.snapshot())[0].state, "waiting");
	assert.equal((await f.ingress.retireWaitHistory()).waits, 0);
	await f.complete();
	for (let i = 0; i < 10; i++) await tick();
	assert.equal(f.sent.length, 3);
	assert.equal((await f.ingress.retireWaitHistory()).waits, 1);
	assert.deepEqual(await f.ingress.branch().attachment.waits.snapshot(), []);
	assert.deepEqual(f.errors, []);
});
