import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createFlowSession, deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { SessionFlowController } from "../dist/flow-control/controller.js";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { PiControllerHost } from "../dist/flow-control/pi-controller-host.js";
import { openAIFlowPayload } from "../dist/flow-control/provider-payload.js";
import { FlowReceiptLedger } from "../dist/flow-control/receipt-ledger.js";

const descriptor = (producer, id = producer, rank = 4, sequence = 0) => ({
	id,
	producer,
	rank,
	sequence,
	revision: "1",
	workId: id,
	workRevision: "1",
	independent: false,
	runnable: true,
});
function producer(namespace, items = [descriptor(namespace)], build) {
	return {
		version: 1,
		namespace,
		items,
		builds: [],
		async snapshot() {
			return this.items;
		},
		async build(item) {
			this.builds.push(item.id);
			return build
				? build(item)
				: { id: item.id, revision: item.revision, kind: item.rank === 6 ? "result" : "work", text: item.id };
		},
	};
}
const answer = () =>
	new Response(
		`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: "Done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);

async function fixture(t, native, options = {}) {
	const policy = { userPending: false, recoveryBlocked: false, waitingWorkIds: [] };
	const calls = [];
	const payloads = [];
	let host, ledger, session, attachment, storageRoot;
	if (native) {
		({ session } = await createFlowSession(t, {
			persist: true,
			checkpoints: options.checkpoints,
			sessionManager: options.sessionManager,
			extensions: options.extensions,
		}));
		const root = options.storageRoot ?? (await mkdtemp(join(tmpdir(), "jouzu-controller-state-")));
		storageRoot = root;
		attachment = await PiFlowAttachment.open(root, { sessionId: session.sessionId, branchId: "main" });
		ledger = attachment.ledger;
		session.agent.streamFunction = (model, context, streamOptions) =>
			stream({ ...model, baseUrl: "https://fixture.invalid/v1" }, context, {
				...streamOptions,
				apiKey: "fixture",
				maxRetries: 0,
				fetch: async (_url, init) => {
					if (options.fetch) return options.fetch(_url, init);
					const body = JSON.parse(init.body);
					payloads.push(body);
					const content = body.messages.findLast((item) => item.role === "user").content;
					calls.push(JSON.parse(typeof content === "string" ? content : content[0].text).flowInput[2]);
					return answer();
				},
			});
		host = new PiControllerHost(
			session,
			ledger,
			{
				projections: new Map([["openai-completions", openAIFlowPayload("openai-completions")]]),
				maxPayloadBytes: 100000,
				containsUserInput: () => false,
			},
			() => policy,
		);
		t.after(async () => {
			await attachment.close();
			await rm(root, { recursive: true, force: true });
		});
	} else {
		let state;
		const store = {
			async read() {
				return structuredClone(state);
			},
			async transact(update) {
				const owned = structuredClone(state);
				const result = update(owned);
				state = result.state;
				return result.result;
			},
		};
		ledger = await FlowReceiptLedger.attach(store, { sessionId: "synthetic", branchId: "main" });
		let pending,
			busy = false;
		host = {
			ledger,
			gate: () => ({ ...policy, hostReady: !busy }),
			async atIdle(run) {
				if (busy) return { kind: "busy" };
				return { kind: "idle", value: await run() };
			},
			async enqueue(input, valid) {
				pending = { input, valid, revoked: false };
				await ledger.queued(input.attemptId, { id: input.attemptId, revision: 1 });
			},
			async run() {
				busy = true;
				try {
					if (pending.revoked || !(await pending.valid())) return;
					const input = pending.input;
					await ledger.claim(input.attemptId, { id: input.attemptId, revision: 1 });
					const inclusion = input.members.map(({ id, revision, contentHash }) => ({
						id,
						revision,
						contentHash,
						disposition: "included",
					}));
					await ledger.prepare(input.attemptId, input.attemptId, inclusion, false);
					await ledger.payload(input.attemptId, input.attemptId, {
						api: "synthetic",
						bytes: 1,
						hash: "a".repeat(64),
						inclusion,
					});
					await ledger.handoff(input.attemptId, input.attemptId);
					calls.push(input.members[0].id);
					await ledger.requestOutcome(input.attemptId, input.attemptId, "success");
				} finally {
					busy = false;
				}
			},
			async reconcile(id) {
				const attempt = (await ledger.snapshot()).attempts.find((item) => item.id === id);
				if (attempt.phase === "running") await ledger.settle(id, "success");
				else if (["selected", "queued"].includes(attempt.phase)) await ledger.cancel(id, "Input changed.");
				pending = undefined;
			},
			invalidate() {
				if (pending) pending.revoked = true;
			},
			async abort() {},
			async close() {},
		};
	}
	const controller = new SessionFlowController(host, options.maxInputBytes ?? 4096);
	t.after(() => controller.close());
	return { controller, host, ledger, calls, payloads, policy, session, attachment, storageRoot };
}

for (const native of [false, true]) {
	const label = native ? "Pi" : "synthetic";
	test(`${label}: producers share one serialized controller and repeated revisions do not replay`, async (t) => {
		const { controller, calls, ledger } = await fixture(t, native);
		const a = producer("alpha"),
			b = producer("beta");
		const first = controller.register(a),
			second = controller.register(b);
		await Promise.all([first.changed(), second.changed(), first.changed()]);
		assert.deepEqual(calls, ["alpha", "beta"]);
		await first.changed();
		assert.deepEqual(calls, ["alpha", "beta"]);
		assert.equal((await ledger.snapshot()).activeAttemptId, undefined);
		assert.ok((await ledger.snapshot()).attempts.every((item) => item.phase === "settled"));
	});
	test(`${label}: a blocked work revision creates no prompt and an independent producer can proceed`, async (t) => {
		const { controller, calls, policy } = await fixture(t, native);
		const a = producer("alpha"),
			b = producer("beta", [{ ...descriptor("beta"), independent: true }]);
		controller.register(a);
		controller.register(b);
		policy.waitingWorkIds = ["alpha"];
		await controller.wake();
		assert.deepEqual(calls, ["beta"]);
		assert.deepEqual(a.builds, []);
		policy.waitingWorkIds = [];
		await controller.wake();
		assert.deepEqual(calls, ["beta", "alpha"]);
	});
	test(`${label}: same-work drivers coalesce and a newer work revision remains eligible`, async (t) => {
		const { controller, calls } = await fixture(t, native);
		const a = producer("alpha"),
			b = producer("beta", [{ ...descriptor("beta", "beta", 5), workId: "alpha" }]);
		controller.register(a);
		const handle = controller.register(b);
		await controller.wake();
		assert.deepEqual(calls, ["alpha"]);
		b.items = [{ ...b.items[0], revision: "2", workRevision: "2" }];
		await handle.changed();
		assert.deepEqual(calls, ["alpha", "beta"]);
	});
	test(`${label}: build failure is visible and does not block unrelated work`, async (t) => {
		const { controller, calls } = await fixture(t, native);
		controller.register(
			producer("alpha", undefined, () => {
				throw new Error("Instruction unavailable.");
			}),
		);
		controller.register(producer("beta"));
		await controller.wake();
		assert.deepEqual(calls, ["beta"]);
		assert.deepEqual(controller.view().held, [{ producer: "alpha", reason: "Instruction unavailable." }]);
	});
	test(`${label}: user arrival while building prevents reservation and content dispatch`, async (t) => {
		const { controller, calls, policy, ledger } = await fixture(t, native);
		const entered = deferred(),
			release = deferred();
		controller.register(
			producer("alpha", undefined, async (item) => {
				entered.resolve();
				await release.promise;
				return { id: item.id, revision: item.revision, kind: "work", text: "work" };
			}),
		);
		const running = controller.wake();
		await entered.promise;
		policy.userPending = true;
		const changed = controller.wake();
		release.resolve();
		await Promise.all([running, changed]);
		assert.deepEqual(calls, []);
		assert.equal((await ledger.snapshot()).attempts.length, 0);
	});
}

test("Pi: user arrival during native claim cancels automation before the provider request", async (t) => {
	const entered = deferred(),
		release = deferred();
	const { controller, calls, policy, ledger } = await fixture(t, true, {
		checkpoints: {
			beforeQueueClaim: async () => {
				entered.resolve();
				await release.promise;
				return true;
			},
		},
	});
	controller.register(producer("alpha"));
	const running = controller.wake();
	await entered.promise;
	policy.userPending = true;
	const changed = controller.wake();
	release.resolve();
	await Promise.all([running, changed]);
	assert.deepEqual(calls, []);
	const attempt = (await ledger.snapshot()).attempts[0];
	assert.equal(attempt.phase, "cancelled");
	assert.equal(attempt.consumed, false);
});

test("duplicate namespaces and disposed producer callbacks are rejected", async (t) => {
	const { controller, host } = await fixture(t, false);
	assert.throws(() => new SessionFlowController(host, 4096), { code: "identity" });
	const handle = controller.register(producer("alpha"));
	assert.throws(() => controller.register(producer("alpha")), { code: "identity" });
	handle.dispose();
	await assert.rejects(handle.changed(), { code: "stale" });
	controller.register(producer("alpha"));
});

test("closing cancels an unresponsive builder and fences its late result", async (t) => {
	const { controller, calls, ledger } = await fixture(t, true);
	const entered = deferred(),
		release = deferred();
	let signal;
	const p = producer("alpha");
	p.build = async (item, abortSignal) => {
		signal = abortSignal;
		entered.resolve();
		await release.promise;
		return { id: item.id, revision: item.revision, kind: "work", text: "late work" };
	};
	controller.register(p);
	const running = controller.wake();
	await entered.promise;
	await controller.close();
	assert.equal(signal.aborted, true);
	release.resolve();
	await running;
	assert.deepEqual(calls, []);
	assert.equal((await ledger.snapshot()).attempts.length, 0);
	assert.equal(controller.view().state, "closed");
});

test("Pi: a changed descriptor at claim is retained without consuming an iteration", async (t) => {
	const entered = deferred(),
		release = deferred();
	const { controller, calls, ledger } = await fixture(t, true, {
		checkpoints: {
			beforeQueueClaim: async () => {
				entered.resolve();
				await release.promise;
				return true;
			},
		},
	});
	const p = producer("alpha");
	controller.register(p);
	const running = controller.wake();
	await entered.promise;
	p.items[0].runnable = false;
	release.resolve();
	await running;
	assert.deepEqual(calls, []);
	const state = await ledger.snapshot();
	assert.equal(state.attempts[0].consumed, false);
	assert.equal(state.admission.revision, 0);
});

test("Pi: final filtering withholds a revision and producer replay cannot resend it", async (t) => {
	const { controller, calls, ledger } = await fixture(t, true, {
		extensions: [
			(pi) =>
				pi.on("before_provider_request", ({ payload }) => ({
					...payload,
					messages: payload.messages.filter((item) => item.role !== "user"),
				})),
		],
	});
	const handle = controller.register(producer("alpha"));
	await handle.changed();
	await handle.changed();
	assert.deepEqual(calls, []);
	const state = await ledger.snapshot();
	assert.equal(state.attempts.length, 1);
	assert.equal(state.attempts[0].phase, "withheld");
	assert.equal(state.admission.revision, 0);
});

test("Pi: restart joins replayed producer revisions with durable receipts", async (t) => {
	const first = await fixture(t, true);
	first.controller.register(producer("alpha"));
	await first.controller.wake();
	const history = first.session.sessionFile;
	await first.controller.close();
	await first.attachment.close();
	const second = await fixture(t, true, {
		storageRoot: first.storageRoot,
		sessionManager: SessionManager.open(history),
	});
	const p = producer("alpha"),
		handle = second.controller.register(p);
	await handle.changed();
	assert.deepEqual(second.calls, []);
	p.items[0] = { ...p.items[0], revision: "2", workRevision: "2" };
	await handle.changed();
	assert.deepEqual(second.calls, ["alpha"]);
	assert.equal((await second.ledger.snapshot()).attempts.length, 2);
});

test("Pi: navigating a branch fences admission through the old controller", async (t) => {
	const { controller, session, calls } = await fixture(t, true);
	controller.register(producer("alpha"));
	await controller.wake();
	const user = session.sessionManager
		.getBranch()
		.find((entry) => entry.type === "message" && entry.message.role === "user");
	await session.navigateTree(user.id);
	await assert.rejects(controller.wake(), { code: "scope" });
	await session.prompt("input after navigation");
	assert.deepEqual(calls, ["alpha"]);
});

test("Pi: unrelated work excludes a rejected instruction and its image without rewriting history", async (t) => {
	let first = true;
	const { controller, calls, payloads, session, ledger } = await fixture(t, true, {
		extensions: [
			(pi) =>
				pi.on("before_provider_request", ({ payload }) => {
					if (!first) return payload;
					first = false;
					return { ...payload, messages: payload.messages.filter((item) => item.role !== "user") };
				}),
		],
	});
	controller.register(
		producer("alpha", undefined, (item) => ({
			id: item.id,
			revision: item.revision,
			kind: "work",
			text: "withheld instruction",
			images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
		})),
	);
	controller.register(producer("beta"));
	await controller.wake();
	assert.deepEqual(calls, ["beta"]);
	assert.equal(JSON.stringify(payloads[0]).includes("withheld instruction"), false);
	assert.equal(JSON.stringify(payloads[0]).includes("aGVsbG8="), false);
	assert.equal(JSON.stringify(session.sessionManager.getBranch()).includes("withheld instruction"), true);
	assert.equal((await ledger.snapshot()).attempts[0].phase, "withheld");
	assert.equal((await ledger.snapshot()).attempts[1].phase, "settled");
});

test("Pi: changed inactive frames reintroduced by a transform withhold the next request", async (t) => {
	let saved,
		first = true;
	const { controller, calls, ledger } = await fixture(t, true, {
		extensions: [
			(pi) => {
				pi.on("context", ({ messages }) => {
					if (!saved) {
						saved = structuredClone(messages.find((item) => item.role === "user"));
						return;
					}
					const changed = structuredClone(saved);
					const frame = JSON.parse(changed.content[0].text);
					frame.content = "altered instruction";
					changed.content[0].text = JSON.stringify(frame);
					return { messages: [changed, ...messages] };
				});
				pi.on("before_provider_request", ({ payload }) => {
					if (!first) return payload;
					first = false;
					return { ...payload, messages: payload.messages.filter((item) => item.role !== "user") };
				});
			},
		],
	});
	controller.register(producer("alpha"));
	controller.register(producer("beta"));
	await controller.wake();
	assert.deepEqual(calls, []);
	assert.equal((await ledger.snapshot()).attempts.length, 2);
	assert.ok((await ledger.snapshot()).attempts.every((item) => item.consumed));
});

test("Pi: controller disposal aborts and joins an ordinary user run before closing receipts", async (t) => {
	const entered = deferred(),
		aborted = deferred(),
		release = deferred();
	const { controller, session, ledger } = await fixture(t, true, {
		fetch: async (_url, init) => {
			entered.resolve();
			await new Promise((resolve) => {
				if (init.signal.aborted) resolve();
				else init.signal.addEventListener("abort", resolve, { once: true });
			});
			aborted.resolve();
			await release.promise;
			throw init.signal.reason;
		},
	});
	const running = session.prompt("ordinary user request");
	await entered.promise;
	let closed = false;
	const closing = controller.close().then(() => {
		closed = true;
	});
	await aborted.promise;
	assert.equal(closed, false);
	await assert.rejects(session.prompt("late user input"), { code: "stale" });
	release.resolve();
	await Promise.all([running, closing]);
	assert.equal(session.isIdle, true);
	assert.equal(session.messages.at(-1).stopReason, "aborted");
	assert.deepEqual((await ledger.snapshot()).attempts, []);
	await controller.close();
});
