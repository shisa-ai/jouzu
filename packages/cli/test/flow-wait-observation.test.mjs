import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { convertMessages, stream } from "@earendil-works/pi-ai/api/openai-completions";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assistant, createFlowSession, model, tick } from "../../../scripts/fixtures/pi-flow-session.mjs";
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
	{ root: supplied, manager, change, failure = false, automatic = false, issueTool = true } = {},
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
			projections: new Map([["openai-completions", openAIFlowPayload("openai-completions")]]),
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
					stream({ ...model, baseUrl: "https://fixture.invalid/v1" }, context, {
						...options,
						apiKey: "fixture",
						maxRetries: 0,
						fetch: async (_url, init) => {
							sent.push(JSON.parse(init.body));
							if (failure && sent.length === 2) return new Response("fixture unavailable", { status: 503 });
							const tool = issueTool && sent.length === 1;
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
	return { root, session, ingress, sent, errors, decisions };
}

test("successful tool observation absorbs immediate wait resolution without another wake and survives reopening", async (t) => {
	const f = await fixture(t, { automatic: true });
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
	assert.equal(f.sent[1].messages.filter((message) => message.role === "tool").length, 1);
	assert.deepEqual(await f.decisions(), []);
	assert.deepEqual(f.errors, []);
	await f.ingress.dispose();
	const next = await fixture(t, {
		root: f.root,
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
		next.sent[0].messages.filter(
			(message) => message.role === "user" && String(message.content).includes('"waitDecisions"'),
		).length,
		0,
	);
	await next.ingress.dispose();
});

for (const mode of ["content", "identity", "omitted", "failed"])
	test(`${mode} tool payload keeps its wait decision pending`, async (t) => {
		const f = await fixture(t, {
			failure: mode === "failed",
			change:
				mode === "failed"
					? undefined
					: (payload) => {
							const tool = payload.messages.find((message) => message.role === "tool");
							if (!tool) return;
							if (mode === "content") tool.content += " altered";
							if (mode === "identity") tool.tool_call_id += "-other";
							if (mode === "omitted") payload.messages = payload.messages.filter((message) => message !== tool);
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
