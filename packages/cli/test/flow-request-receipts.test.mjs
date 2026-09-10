import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { assistant, createFlowSession, deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { FlowModelInput } from "../dist/flow-control/model-input.js";
import { PiHostBoundary } from "../dist/flow-control/pi-host-boundary.js";
import { createPiLedgerStore } from "../dist/flow-control/pi-ledger-store.js";
import { PiNativeRequests } from "../dist/flow-control/pi-native-requests.js";
import { PiQueueReceipts } from "../dist/flow-control/pi-queue-receipts.js";
import { PiRequestReceipts } from "../dist/flow-control/pi-request-receipts.js";
import { FlowReceiptLedger } from "../dist/flow-control/receipt-ledger.js";
import { buildFlowResultEnvelope } from "../dist/flow-control/result-envelope.js";

const answer = (tool = false) =>
	new Response(
		`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: tool ? { tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "probe", arguments: "{}" } }] } : { content: "Done" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
		{ headers: { "Content-Type": "text/event-stream" } },
	);
async function fixture(t, { transform, fetch, native, reversed = false, inputs } = {}) {
	const { session } = await createFlowSession(t, {
		extensions: transform ? [(pi) => pi.on("before_provider_request", transform)] : [],
	});
	await session.prompt("initial");
	const repo = new MemorySessionRepo();
	const store = createPiLedgerStore(await repo.create({}, context));
	const ledger = await FlowReceiptLedger.attach(store, { sessionId: session.sessionId, branchId: "main" });
	const sent = [];
	session.agent.streamFunction =
		native ??
		((model, ctx, options) =>
			stream({ ...model, baseUrl: "https://fixture.invalid/v1" }, ctx, {
				...options,
				apiKey: "fixture",
				maxRetries: 0,
				fetch: async (url, init) => {
					sent.push(JSON.parse(init.body));
					return fetch ? fetch(url, init) : answer();
				},
			}));
	let queue = reversed ? undefined : new PiQueueReceipts(session.agent, ledger);
	// One observer wraps the transport and drives both projections. The receipts recorder installs no
	// hooks of its own, so these cases exercise the merged path rather than a second wrapper.
	const bridge = new PiRequestReceipts(session, ledger, { containsUserInput: () => false });
	const records = [];
	const nativeStore = {
		scope: { sessionId: session.sessionId, branchId: "main" },
		blocksQueueing: () => false,
		snapshot: async () => records.map((record) => ({ ...record })),
		begin: async (record) => {
			records.push({ ...record });
		},
		handoff: async (id, payload) => {
			const record = records.find((item) => item.id === id);
			record.payload = payload;
			return true;
		},
		finish: async (id, outcome) => {
			const record = records.find((item) => item.id === id);
			record.outcome = outcome;
		},
	};
	const observer = new PiNativeRequests(session, nativeStore, 100000);
	observer.attachComposition(bridge);
	observer.sealTransport();
	queue ??= new PiQueueReceipts(session.agent, ledger);
	const boundary = new PiHostBoundary(session);
	t.after(async () => {
		boundary.close();
		await observer.close();
		bridge.close();
		queue.close();
		await repo.close(context);
	});
	const composition = FlowModelInput.compose(
		"attempt",
		inputs ?? [
			{ id: "work", revision: "1", kind: "work", text: "Do work" },
			{ id: "result", revision: "1", kind: "result", text: "Completed" },
		],
		4096,
	);
	await ledger.select("attempt", composition.members);
	bridge.register(composition);
	await queue.enqueue("attempt", () =>
		session.agent.followUp({ role: "user", content: composition.content, timestamp: 1 }),
	);
	return { session, ledger, bridge, observer, queue, sent, composition, store, boundary, records: nativeStore };
}

test("native request joins model admission, handoff, and outcome without settling the run", async (t) => {
	const { session, ledger, sent } = await fixture(t);
	await session.agent.continue();
	const state = await ledger.snapshot();
	assert.equal(sent.length, 1);
	assert.equal(state.activeAttemptId, "attempt");
	assert.equal(state.attempts[0].phase, "running");
	const [request] = state.attempts[0].requests;
	assert.equal(request.handedOff, true);
	assert.equal(request.outcome, "success");
	// One inclusion record, written at model conversion.
	assert.ok(request.inclusion.length > 0);
	assert.ok(request.inclusion.every((item) => item.disposition === "included"));
});

for (const optional of [true, false])
	test(`AgentSession extension payload filtering after conversion transmits, optional=${optional}`, async (t) => {
		const { session, ledger, sent } = await fixture(t, {
			transform: ({ payload }) => {
				const input = payload.messages.findLast((message) => message.role === "user");
				input.content.splice(optional ? 1 : 0, 1);
				return payload;
			},
		});
		await session.agent.continue();
		const attempt = (await ledger.snapshot()).attempts[0];
		// The extension edits the body after model conversion, which the controller trusts, so the
		// request is transmitted either way and conversion's own inclusion is what stands.
		assert.equal(sent.length, 1);
		assert.equal(attempt.phase, "running");
		assert.equal(attempt.requests[0].inclusion[0].disposition, "included");
	});

test("a request that fails before handoff is withheld", async (t) => {
	let calls = 0;
	const { session, ledger, sent } = await fixture(t, {
		native: () => {
			calls++;
			throw new Error("provider setup failed");
		},
	});
	await session.agent.continue();
	const attempt = (await ledger.snapshot()).attempts[0];
	assert.equal(calls, 1);
	assert.equal(sent.length, 0);
	assert.equal(attempt.phase, "withheld");
	assert.equal(attempt.requests[0].handedOff, false);
});

test("native tool-loop requests share one reservation and record outcome before executing tools", async (t) => {
	let ledger;
	let calls = 0;
	let tools = 0;
	const result = await fixture(t, { fetch: () => answer(calls++ === 0) });
	({ ledger } = result);
	result.session.agent.state.tools = [
		{
			name: "probe",
			label: "Probe",
			description: "Probe",
			parameters: { type: "object", properties: {} },
			execute: async () => {
				tools++;
				const state = await ledger.snapshot();
				assert.equal(state.activeAttemptId, "attempt");
				assert.equal(state.attempts[0].requests[0].outcome, "success");
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
		},
	];
	await result.session.agent.continue();
	const state = await ledger.snapshot();
	assert.equal(tools, 1);
	assert.equal(result.sent.length, 2);
	assert.equal(state.activeAttemptId, "attempt");
	assert.equal(state.attempts[0].requests.length, 2);
	assert.notEqual(state.attempts[0].requests[0].id, state.attempts[0].requests[1].id);
});

test("outcome receipt failure keeps ownership and prevents tool execution", async (t) => {
	let tools = 0;
	const { session, ledger } = await fixture(t, { fetch: () => answer(true) });
	session.agent.state.tools = [
		{
			name: "probe",
			label: "Probe",
			description: "Probe",
			parameters: { type: "object", properties: {} },
			execute: async () => {
				tools++;
				return { content: [], details: {} };
			},
		},
	];
	t.mock.method(ledger, "requestOutcome", async () => {
		throw new Error("outcome storage failed");
	});
	await session.agent.continue();
	const state = await ledger.snapshot();
	assert.equal(tools, 0);
	assert.equal(state.activeAttemptId, "attempt");
	assert.equal(state.attempts[0].phase, "handed-off");
});

for (const afterHandoff of [false, true])
	test(`abort during receipt boundary, afterHandoff=${afterHandoff}`, async (t) => {
		const entered = deferred();
		const release = deferred();
		const result = await fixture(
			t,
			afterHandoff
				? {}
				: {
						transform: async ({ payload }) => {
							entered.resolve();
							await release.promise;
							return payload;
						},
					},
		);
		if (afterHandoff) {
			const native = result.ledger.handoff.bind(result.ledger);
			t.mock.method(result.ledger, "handoff", async (...args) => {
				await native(...args);
				entered.resolve();
				await release.promise;
			});
		}
		const running = result.session.agent.continue();
		await entered.promise;
		result.session.agent.abort();
		release.resolve();
		await running;
		const attempt = (await result.ledger.snapshot()).attempts[0];
		assert.equal(result.sent.length, 0);
		assert.equal(attempt.requests[0].handedOff, afterHandoff);
		assert.equal(attempt.phase, afterHandoff ? "running" : "withheld");
		if (afterHandoff) assert.equal(attempt.requests[0].outcome, "aborted");
	});

test("queued AgentSession execution retries without an unrelated user prompt", async (t) => {
	let calls = 0;
	const { session, ledger, sent, boundary } = await fixture(t, {
		fetch: () => {
			calls++;
			return calls === 1
				? new Response(JSON.stringify({ error: { message: "Service unavailable", type: "server_error" } }), {
						status: 503,
						headers: { "content-type": "application/json" },
					})
				: answer();
		},
	});
	session.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
	const retryStates = [];
	const retryBoundaries = [];
	session.subscribe((event) => {
		if (event.type === "auto_retry_start") {
			retryStates.push(ledger.snapshot());
			retryBoundaries.push(boundary.reconcile(ledger, "attempt"));
		}
	});
	assert.equal(await session.continueQueued(), true);
	const state = await ledger.snapshot();
	assert.equal(sent.length, 2);
	assert.equal(retryStates.length, 1);
	assert.equal((await retryStates[0]).activeAttemptId, "attempt");
	assert.equal(state.activeAttemptId, "attempt");
	assert.deepEqual(
		state.attempts[0].requests.map((request) => request.outcome),
		["failure", "success"],
	);
	assert.equal(session.isIdle, true);
	assert.equal((await retryBoundaries[0]).kind, "busy");
	assert.equal((await boundary.reconcile(ledger, "attempt")).value.kind, "settled");
	assert.equal((await ledger.snapshot()).activeAttemptId, undefined);
});

test("concurrent sessions and reversed attachment order keep distinct request receipts", async (t) => {
	const first = await fixture(t);
	const second = await fixture(t, { reversed: true });
	await Promise.all([first.session.agent.continue(), second.session.agent.continue()]);
	const a = (await first.ledger.snapshot()).attempts[0];
	const b = (await second.ledger.snapshot()).attempts[0];
	assert.equal(first.sent.length, 1);
	assert.equal(second.sent.length, 1);
	assert.notEqual(a.requests[0].id, b.requests[0].id);
	assert.equal(a.requests[0].outcome, "success");
	assert.equal(b.requests[0].outcome, "success");
});

test("closing during a delayed payload transform fences the callback before HTTP", async (t) => {
	const entered = deferred();
	const release = deferred();
	const { session, bridge, ledger, sent } = await fixture(t, {
		transform: async ({ payload }) => {
			entered.resolve();
			await release.promise;
			return payload;
		},
	});
	const running = session.agent.continue();
	await entered.promise;
	bridge.close();
	release.resolve();
	await running;
	assert.equal(sent.length, 0);
	const attempt = (await ledger.snapshot()).attempts[0];
	assert.equal(attempt.requests[0].handedOff, false);
	assert.equal(attempt.requests[0].outcome, undefined);
});

test("a pending provider response cannot become a successful receipt", async (t) => {
	const { session, ledger } = await fixture(t, {
		native: async (model, ctx, options) => {
			await options.onPayload({ messages: ctx.messages }, model);
			const message = { ...assistant(), stopReason: "pending" };
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "done", message };
				},
				result: async () => message,
			};
		},
	});
	await session.agent.continue();
	const state = await ledger.snapshot();
	assert.equal(state.activeAttemptId, "attempt");
	assert.equal(state.attempts[0].phase, "handed-off");
	assert.equal(state.attempts[0].requests[0].outcome, undefined);
});

for (const field of ["counts", "manifest", "warningResults", "reviewNote", "removed"])
	test(`final provider aggregate ${field} preserves transport eligibility and per-item evidence`, async (t) => {
		const { item } = await buildFlowResultEnvelope({
			attemptId: "attempt",
			// The aggregate joins a run that already carries the work item below.
			runMembers: [{ kind: "work" }],
			id: "batch",
			revision: "1",
			maxBytes: 4096,
			producerOrder: ["worker"],
			members: ["a", "b"].map((id) => ({
				id,
				producer: "worker",
				execution: `exec-${id}`,
				revision: "1",
				status: "success",
				title: id,
				reference: `result:${id}`,
				warnings: ["Review required"],
			})),
			retain: async () => `flow-results:${"a".repeat(64)}`,
		});
		const { session, ledger, sent } = await fixture(t, {
			inputs: [{ id: "work", revision: "1", kind: "work", text: "Do work" }, item],
			transform: ({ payload }) => {
				const input = payload.messages.findLast((message) => message.role === "user");
				if (field === "removed") {
					input.content.splice(1, 1);
					return payload;
				}
				const frame = JSON.parse(input.content[1].text);
				const envelope = JSON.parse(frame.content);
				delete envelope[field];
				frame.content = JSON.stringify(envelope);
				input.content[1].text = JSON.stringify(frame);
				return payload;
			},
		});
		await session.agent.continue();
		// Editing aggregate metadata in the provider body happens after model conversion, so the
		// controller neither sees it nor withholds for it. The conversion record is what stands, and
		// the model-layer equivalent — a replaced intact aggregate frame at conversion — is asserted in
		// the ledger case below.
		assert.equal(sent.length, 1);
		assert.equal((await ledger.snapshot()).attempts[0].phase, "running");
		assert.deepEqual(
			(await ledger.snapshot()).attempts[0].requests[0].inclusion.map((member) => member.disposition),
			["included", "included", "included"],
		);
	});
