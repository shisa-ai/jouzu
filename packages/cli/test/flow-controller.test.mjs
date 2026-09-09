import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const { createJiti } = await import(
	createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("jiti")
);

import { createFlowSession, deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { SessionFlowController } from "../dist/flow-control/controller.js";
import { createMultiloopControllerExtension } from "../dist/flow-control/multiloop-extension.js";
import { MultiloopFlowProducer, multiloopWorkBinding } from "../dist/flow-control/multiloop-producer.js";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { PiControllerHost } from "../dist/flow-control/pi-controller-host.js";
import { openAIFlowPayload } from "../dist/flow-control/provider-payload.js";
import { FlowReceiptLedger } from "../dist/flow-control/receipt-ledger.js";
import { orderFlowResultProducers } from "../dist/flow-control/result-order.js";
import { createFlowWaitDecisionProducer } from "../dist/flow-control/wait-decisions.js";

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
	const manifests = new Map();
	let host, ledger, session, attachment, storageRoot;
	if (native) {
		({ session } = await createFlowSession(t, {
			persist: true,
			ingress: options.ingress,
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
				consumedAttempt: options.consumedAttempt,
				results: options.aggregate ? attachment.results : undefined,
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
	if (!native && options.aggregate)
		host.retainResults = async (members) => {
			const reference = `flow-results:${createHash("sha256").update(JSON.stringify(members)).digest("hex")}`;
			manifests.set(reference, structuredClone(members));
			return reference;
		};
	const controller = new SessionFlowController(host, options.maxInputBytes ?? 4096, options.maxResultBytes);
	t.after(() => controller.close());
	return { controller, host, ledger, calls, payloads, policy, session, attachment, storageRoot, manifests };
}

test("Pi multiloop adapter holds three continuations and accounts once at native consumption", async (t) => {
	let adapter,
		admitted = 0,
		builds = 0;
	const f = await fixture(t, true, { consumedAttempt: (attempt) => adapter.admitted(attempt) });
	const work = await f.attachment.waits.registerWork("campaign", "multiloop", Date.now());
	const lane = { lane: "work", runTag: "run" };
	adapter = new MultiloopFlowProducer(
		f.attachment,
		async () => work,
		() => work.id,
		() => {},
	);
	t.after(() => adapter.close());
	f.controller.register(adapter);
	const input = {
		lane,
		reason: "continue",
		build() {
			builds++;
			return "Resume the campaign";
		},
		admitted() {
			admitted++;
		},
	};
	f.policy.waitingWorkIds = [work.id];
	for (let i = 0; i < 3; i++) {
		adapter.submit(input);
		await f.controller.wake();
	}
	assert.deepEqual(f.calls, []);
	assert.equal(builds, 0);
	assert.equal(admitted, 0);
	assert.equal((await adapter.snapshot(new AbortController().signal)).length, 1);
	f.policy.waitingWorkIds = [];
	await f.controller.wake();
	assert.equal(f.calls.length, 1);
	assert.equal(builds, 1);
	assert.equal(admitted, 1);
	await f.controller.wake();
	assert.equal(f.calls.length, 1);
	adapter.submit(input);
	await f.controller.wake();
	assert.equal(f.calls.length, 2);
	assert.equal(admitted, 2);
	adapter.lanesChanged([]);
	await f.controller.wake();
	assert.equal(f.calls.length, 2);
});

test("a synthetic second producer drives one owner-scoped binding campaign through the shared controller", async (t) => {
	const f = await fixture(t, true, {});
	const binding = { producer: "sweep", key: ["nightly", "scan"] };
	const campaign = await f.attachment.waits.activateWorkBinding(binding, Date.now(), ["bg"]);
	assert.deepEqual(campaign.participants, ["sweep", "bg"], "a bound campaign shares work like a lane campaign");
	const handle = { producer: "sweep", handle: "scan", execution: "exec-1" };
	await f.attachment.waits.registerExecution(
		{ ...handle, workId: campaign.id, revision: 1, predicates: [{ until: "done", state: "pending" }] },
		campaign.revision,
		Date.now(),
	);
	await f.attachment.waits.declareOwned(
		"sweep",
		campaign.revision,
		{
			scope: f.ledger.scope,
			workId: campaign.id,
			token: "sweep-wait",
			reason: "scan done",
			mode: "all",
			on: [{ ...handle, until: "done" }],
			expiresAt: Date.now() + 60000,
		},
		Date.now(),
		60000,
	);
	let builds = 0;
	const sweep = {
		version: 1,
		namespace: "sweep",
		async snapshot() {
			const work = f.attachment.waits.boundWork(binding);
			return work
				? [
						{
							id: `sweep:${work.id}`,
							revision: "1",
							producer: "sweep",
							sequence: 0,
							rank: 4,
							workId: work.id,
							workRevision: `${work.revision}:1`,
							independent: false,
							runnable: (work.lifecycle?.state ?? "active") === "active",
						},
					]
				: [];
		},
		async build(intent) {
			builds++;
			return { id: intent.id, revision: intent.revision, kind: "work", text: "Continue the nightly sweep" };
		},
	};
	f.controller.register(sweep);
	f.policy.waitingWorkIds = [campaign.id];
	await f.controller.wake();
	assert.deepEqual(f.calls, [], "a live wait holds the campaign's intent");
	assert.equal(builds, 0);
	f.policy.waitingWorkIds = [];
	await f.controller.wake();
	assert.deepEqual(f.calls, [`sweep:${campaign.id}`]);
	assert.equal(builds, 1);
	await f.controller.wake();
	assert.equal(builds, 1, "a settled descriptor revision does not replay");
	// Stopping the campaign ends the binding, so the producer withdraws its intent for good.
	await f.attachment.waits.changeWork(campaign.id, "sweep", campaign.revision, "stopped", "operator stop", Date.now());
	assert.equal(f.attachment.waits.boundWork(binding), undefined);
	await f.controller.wake();
	assert.equal(builds, 1);
	assert.equal((await f.ledger.snapshot()).attempts.length, 1);
});

test("Pi multiloop adapter preserves exhausted failure across reopen", async (t) => {
	const first = await fixture(t, true, { fetch: async () => new Response("unavailable", { status: 400 }) });
	await first.attachment.waits.registerWork("campaign", "multiloop", Date.now());
	const input = {
		lane: { lane: "lane", runTag: "run" },
		reason: "continue",
		build: () => "Resume campaign",
		admitted() {},
	};
	const make = (f) =>
		new MultiloopFlowProducer(
			f.attachment,
			async () => (await f.attachment.waits.authoritySnapshot()).work[0],
			() => "campaign",
			() => {},
		);
	const adapter = make(first);
	first.controller.register(adapter);
	adapter.submit(input);
	await first.controller.wake();
	assert.equal((await first.ledger.snapshot()).attempts[0].outcome, "failure");
	adapter.submit(input);
	await first.controller.wake();
	assert.equal((await first.ledger.snapshot()).attempts.length, 1);
	const history = first.session.sessionFile;
	adapter.close();
	await first.controller.close();
	await first.attachment.close();
	const second = await fixture(t, true, {
		storageRoot: first.storageRoot,
		sessionManager: SessionManager.open(history),
	});
	const resumed = make(second);
	t.after(() => resumed.close());
	second.controller.register(resumed);
	resumed.submit(input);
	await second.controller.wake();
	assert.equal((await second.ledger.snapshot()).attempts.length, 1);
	assert.deepEqual(second.calls, []);
	assert.equal((await resumed.snapshot(new AbortController().signal))[0].runnable, false);
});

for (const reverse of [false, true])
	test(`Pi loaded multiloop attaches through its event bus: reversed=${reverse}`, async (t) => {
		let f, ctx, attachedBranch;
		const tools = new Map(),
			errors = [],
			sends = [];
		const bridge = createMultiloopControllerExtension({
			ingress: () => ({ branch: () => attachedBranch, requestRelease() {} }),
			onError: (error) => errors.push(error),
		});
		const installed = {
			name: "installed-multiloop",
			async factory(pi) {
				const factory = await createJiti(import.meta.url, { moduleCache: false }).import(
					new URL("../node_modules/pi-multiloop/extensions/pi-multiloop/index.ts", import.meta.url).pathname,
					{ default: true },
				);
				pi.on("session_start", (_event, context) => {
					ctx = context;
				});
				factory({
					...pi,
					sendUserMessage: (text) => sends.push(text),
					registerTool(tool) {
						tools.set(tool.name, tool);
						pi.registerTool(tool);
					},
				});
			},
		};
		f = await fixture(t, true, {
			extensions: reverse ? [installed, bridge] : [bridge, installed],
			consumedAttempt: bridge.consumedAttempt,
			fetch: async () => answer(),
		});
		attachedBranch = { ...f, scope: f.ledger.scope };
		await f.session.bindExtensions({ onError: (error) => errors.push(error) });
		assert.ok(f.controller.view().producers.includes("multiloop"));
		await tools
			.get("multiloop_start")
			.execute(
				"start",
				{ lane: "test", runTag: "run", mode: "research", goal: "Finish fixture" },
				undefined,
				undefined,
				ctx,
			);
		const lane = { lane: "test", runTag: "run" };
		const campaign = f.attachment.waits.boundWork(multiloopWorkBinding(lane));
		assert.deepEqual(campaign.participants, ["multiloop", "bg"]);
		const handle = { producer: "multiloop", handle: "job", execution: "execution" };
		await f.attachment.waits.registerExecution(
			{ ...handle, workId: campaign.id, revision: 1, predicates: [{ until: "exit", state: "pending" }] },
			1,
			Date.now(),
		);
		await f.attachment.waits.declareOwned(
			"multiloop",
			1,
			{
				scope: f.ledger.scope,
				workId: campaign.id,
				token: "wait",
				reason: "job exit",
				mode: "all",
				on: [{ ...handle, until: "exit" }],
				expiresAt: Date.now() + 60000,
			},
			Date.now(),
			60000,
		);
		Object.defineProperty(f.policy, "waitingWorkIds", { get: () => f.attachment.waits.gate().waitingWorkIds });
		Object.defineProperty(f.policy, "inactiveWorkIds", { get: () => f.attachment.waits.gate().inactiveWorkIds });
		f.controller.register(
			createFlowWaitDecisionProducer(f.attachment.waits, {
				submissions: f.attachment.submissions,
				requests: f.attachment.nativeRequests,
			}),
		);
		for (let i = 0; i < 3; i++) {
			await f.session.prompt("status");
			await f.controller.wake();
		}
		assert.equal((await f.ledger.snapshot()).attempts.length, 0);
		assert.deepEqual(sends, []);
		const expiry = (await f.attachment.waits.snapshot())[0].expiresAt;
		await tools.get("multiloop_pause").execute("pause", { target: "test/run" }, undefined, undefined, ctx);
		assert.equal(f.attachment.waits.boundWork(multiloopWorkBinding(lane)).lifecycle.state, "paused");
		await f.controller.wake();
		assert.equal((await f.ledger.snapshot()).attempts.length, 0);
		await tools.get("multiloop_resume").execute("resume", { target: "test/run" }, undefined, undefined, ctx);
		assert.equal(f.attachment.waits.boundWork(multiloopWorkBinding(lane)).id, campaign.id);
		assert.equal((await f.attachment.waits.snapshot())[0].expiresAt, expiry);
		await f.session.prompt("status after resume");
		await f.attachment.waits.observeExecution(handle, 2, [{ until: "exit", state: "satisfied" }], Date.now());
		await f.controller.wake();
		const attempts = (await f.ledger.snapshot()).attempts;
		assert.equal(attempts.length, 1);
		assert.equal(attempts[0].outcome, "success");
		assert.deepEqual(
			attempts[0].members.map((member) => member.kind),
			["wait", "work"],
		);
		await f.controller.wake();
		assert.equal((await f.ledger.snapshot()).attempts.length, 1);
		assert.deepEqual(sends, []);
		await tools.get("multiloop_stop").execute("stop", { target: "test/run" }, undefined, undefined, ctx);
		assert.equal(f.attachment.waits.boundWork(multiloopWorkBinding(lane)), undefined);
		await tools.get("multiloop_resume").execute("new-generation", { target: "test/run" }, undefined, undefined, ctx);
		assert.notEqual(f.attachment.waits.boundWork(multiloopWorkBinding(lane)).id, campaign.id);
		assert.deepEqual(errors, []);
	});

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

for (const native of [false, true]) {
	const label = native ? "Pi" : "synthetic";
	test(`${label}: one requested work turn carries results from two producers during another work wait`, async (t) => {
		const { controller, ledger, policy } = await fixture(t, native);
		policy.waitingWorkIds = ["blocked"];
		controller.register(producer("work", [{ ...descriptor("work"), independent: true }]));
		controller.register(producer("alpha", [descriptor("alpha", "result-a", 6)]));
		controller.register(producer("beta", [descriptor("beta", "result-b", 6)]));
		await controller.wake();
		const state = await ledger.snapshot();
		assert.equal(state.attempts.length, 1);
		assert.deepEqual(
			state.attempts[0].members.map((item) => item.id),
			["work", "result-a", "result-b"],
		);
		assert.equal(state.attempts[0].phase, "settled");
		assert.equal(state.admission.revision, 1);
	});

	test(`${label}: result backlog is bounded and does not create automatic pagination turns`, async (t) => {
		const { controller, ledger } = await fixture(t, native, { maxInputBytes: 450 });
		controller.register(
			producer(
				"alpha",
				Array.from({ length: 10 }, (_, i) => descriptor("alpha", `alpha-${i}`, 6, i)),
			),
		);
		controller.register(producer("beta", [descriptor("beta", "beta", 6)]));
		await controller.wake();
		const state = await ledger.snapshot();
		assert.equal(state.attempts.length, 1);
		assert.deepEqual(
			state.attempts[0].members.map((item) => item.id),
			["alpha-0", "beta"],
		);
		assert.ok(controller.view().deferredResults.some((item) => item.id === "alpha-1"));
		await controller.wake();
		assert.equal((await ledger.snapshot()).attempts.length, 1);
		controller.register(producer("work"));
		await controller.wake();
		const later = await ledger.snapshot();
		assert.equal(later.attempts.length, 2);
		assert.deepEqual(
			later.attempts[1].members.map((item) => item.id),
			["work", "alpha-1"],
		);
	});

	test(`${label}: a failing result builder does not discard selected work or other results`, async (t) => {
		const { controller, ledger } = await fixture(t, native);
		controller.register(producer("work"));
		controller.register(
			producer("broken", [descriptor("broken", "bad", 6)], () => {
				throw new Error("result unavailable");
			}),
		);
		controller.register(producer("beta", [descriptor("beta", "good", 6)]));
		await controller.wake();
		const state = await ledger.snapshot();
		assert.equal(state.attempts.length, 1);
		assert.deepEqual(
			state.attempts[0].members.map((item) => item.id),
			["work", "good"],
		);
		assert.equal(controller.view().held[0].producer, "broken");
	});

	test(`${label}: work consumption does not coalesce a later result for that work`, async (t) => {
		const { controller, ledger } = await fixture(t, native);
		controller.register(producer("work"));
		await controller.wake();
		controller.register(producer("result", [{ ...descriptor("result", "result", 6), workId: "work" }]));
		await controller.wake();
		assert.equal((await ledger.snapshot()).attempts.length, 2);
	});
}

test("Pi: result revision changing at native claim cancels the entire unconsumed composition", async (t) => {
	const entered = deferred(),
		release = deferred();
	const { controller, ledger, calls } = await fixture(t, true, {
		checkpoints: {
			beforeQueueClaim: async () => {
				entered.resolve();
				await release.promise;
				return true;
			},
		},
	});
	controller.register(producer("work"));
	const result = producer("result", [descriptor("result", "result", 6)]);
	controller.register(result);
	const running = controller.wake();
	await entered.promise;
	result.items[0].revision = "2";
	release.resolve();
	await running;
	assert.deepEqual(calls, []);
	assert.equal((await ledger.snapshot()).attempts[0].consumed, false);
});

test("Pi: deferred result backlog survives reopen without authorizing another pagination wake", async (t) => {
	const first = await fixture(t, true, { maxInputBytes: 250 });
	const results = [descriptor("results", "first", 6), descriptor("results", "second", 6, 1)];
	first.controller.register(producer("results", results));
	await first.controller.wake();
	assert.equal((await first.ledger.snapshot()).attempts[0].members.length, 1);
	const history = first.session.sessionFile;
	await first.controller.close();
	await first.attachment.close();
	const second = await fixture(t, true, {
		storageRoot: first.storageRoot,
		sessionManager: SessionManager.open(history),
		maxInputBytes: 250,
	});
	second.controller.register(producer("results", results));
	await second.controller.wake();
	assert.deepEqual(second.calls, []);
	assert.equal((await second.ledger.snapshot()).attempts.length, 1);
});

for (const native of [false, true]) {
	test(`${native ? "Pi" : "synthetic"}: result sampling serves surviving producers before a busy producer's next result`, async (t) => {
		const { controller, ledger } = await fixture(t, native, { maxInputBytes: 450 });
		const work = producer("work");
		controller.register(work);
		const results = [
			...Array.from({ length: 8 }, (_, i) => descriptor("alpha", `alpha-${i}`, 6, i)),
			descriptor("beta", "beta-result", 6, 20),
			descriptor("gamma", "gamma-result", 6, 30),
		];
		for (const namespace of ["alpha", "beta", "gamma"])
			controller.register(
				producer(
					namespace,
					results.filter((item) => item.producer === namespace),
				),
			);
		for (let i = 1; i <= 3; i++) {
			if (i === 2) controller.register(producer("delta", [descriptor("delta", "delta-new", 6, 0)]));
			work.items[0] = { ...work.items[0], revision: String(i), workRevision: String(i) };
			await controller.wake();
		}
		const state = await ledger.snapshot();
		assert.deepEqual(
			state.attempts.map((attempt) => attempt.members.filter((item) => item.kind === "result").map((item) => item.id)),
			[["alpha-0"], ["beta-result"], ["gamma-result"]],
		);
		const first = structuredClone(state);
		first.attempts = first.attempts.slice(0, 1);
		assert.equal(orderFlowResultProducers(results, first)[0], "beta");
		first.attempts[0].requests.forEach((request) => {
			delete request.payload;
		});
		assert.equal(orderFlowResultProducers(results, first)[0], "alpha");
	});
}

test("Pi: producer sampling order survives a controller and storage reopen", async (t) => {
	const first = await fixture(t, true, { maxInputBytes: 450 });
	const results = [
		descriptor("alpha", "alpha-0", 6),
		descriptor("alpha", "alpha-1", 6, 1),
		descriptor("beta", "beta-result", 6, 2),
	];
	first.controller.register(producer("work"));
	for (const namespace of ["alpha", "beta"])
		first.controller.register(
			producer(
				namespace,
				results.filter((item) => item.producer === namespace),
			),
		);
	await first.controller.wake();
	const history = first.session.sessionFile;
	await first.controller.close();
	await first.attachment.close();
	const second = await fixture(t, true, {
		maxInputBytes: 450,
		storageRoot: first.storageRoot,
		sessionManager: SessionManager.open(history),
	});
	second.controller.register(producer("work", [{ ...descriptor("work"), revision: "2", workRevision: "2" }]));
	for (const namespace of ["alpha", "beta"])
		second.controller.register(
			producer(
				namespace,
				results.filter((item) => item.producer === namespace),
			),
		);
	await second.controller.wake();
	assert.deepEqual(
		(await second.ledger.snapshot()).attempts[1].members.map((item) => item.id),
		["work", "beta-result"],
	);
});

function describedResults(namespace, ids) {
	const p = producer(
		namespace,
		ids.map((id, sequence) => descriptor(namespace, id, 6, sequence)),
	);
	p.describeResult = async (intent) => ({
		id: intent.id,
		revision: intent.revision,
		producer: namespace,
		execution: `exec-${intent.id}`,
		status: "failure",
		title: `Failed ${intent.id}`,
		reference: `result:${intent.id}`,
		warnings: ["Review required"],
	});
	p.build = () => assert.fail("Aggregate results must use retained terminal metadata.");
	return p;
}
for (const native of [false, true]) {
	test(`${native ? "Pi" : "synthetic"}: controller combines work and a retained multi-producer aggregate`, async (t) => {
		const { controller, ledger, attachment, manifests, policy, payloads } = await fixture(t, native, {
			aggregate: true,
			maxInputBytes: 4096,
			maxResultBytes: 1600,
		});
		policy.waitingWorkIds = ["blocked"];
		controller.register(producer("work", [{ ...descriptor("work"), independent: true }]));
		controller.register(describedResults("alpha", ["alpha-0", "alpha-1", "alpha-2"]));
		controller.register(describedResults("beta", ["beta-0"]));
		await controller.wake();
		const state = await ledger.snapshot();
		assert.equal(state.attempts.length, 1);
		const attempt = state.attempts[0];
		assert.equal(attempt.members.length, 5);
		assert.equal(attempt.phase, "settled");
		assert.ok(attempt.admission.choice.resultSamples.length < 4);
		assert.ok(attempt.members.filter((member) => member.kind === "result").every((member) => member.inputFrame.intact));
		if (native) {
			const content = payloads[0].messages.findLast((message) => message.role === "user").content;
			const envelope = JSON.parse(JSON.parse(content.at(-1).text).content);
			const page = await attachment.results.page(envelope.manifest, { limit: 10, maxBytes: 10000 });
			assert.equal(page.total, 4);
			assert.deepEqual(page.counts, { success: 0, failure: 4, cancelled: 0 });
		} else assert.equal([...manifests.values()][0].length, 4);
	});

	test(`${native ? "Pi" : "synthetic"}: aggregate metadata overflow defers results without holding valid work`, async (t) => {
		const { controller, ledger } = await fixture(t, native, { aggregate: true, maxResultBytes: 10 });
		controller.register(producer("work"));
		controller.register(describedResults("alpha", ["alpha-0"]));
		await controller.wake();
		const state = await ledger.snapshot();
		assert.equal(state.attempts.length, 1);
		assert.deepEqual(
			state.attempts[0].members.map((item) => item.id),
			["work"],
		);
		assert.deepEqual(controller.view().held, []);
		assert.equal(controller.view().deferredResults[0].id, "alpha-0");
	});
}

test("Pi: aggregate sample fairness survives reopen without charging unsampled manifest members", async (t) => {
	const make = (namespace, id) => {
		const p = describedResults(namespace, [id]);
		const describe = p.describeResult;
		p.describeResult = async (intent) => ({ ...(await describe(intent)), title: "Result ".repeat(70) });
		return p;
	};
	const first = await fixture(t, true, { aggregate: true, maxResultBytes: 1600 });
	first.controller.register(make("alpha", "alpha-0"));
	first.controller.register(make("beta", "beta-0"));
	await first.controller.wake();
	const state = await first.ledger.snapshot();
	assert.equal(state.attempts[0].members.length, 2);
	assert.deepEqual(state.attempts[0].admission.choice.resultSamples, [{ id: "alpha-0", revision: "1" }]);
	const history = first.session.sessionFile;
	await first.controller.close();
	await first.attachment.close();
	const second = await fixture(t, true, {
		aggregate: true,
		maxResultBytes: 1600,
		storageRoot: first.storageRoot,
		sessionManager: SessionManager.open(history),
	});
	second.controller.register(producer("work"));
	second.controller.register(make("alpha", "alpha-next"));
	second.controller.register(make("beta", "beta-next"));
	await second.controller.wake();
	assert.deepEqual((await second.ledger.snapshot()).attempts[1].admission.choice.resultSamples, [
		{ id: "beta-next", revision: "1" },
	]);
});

test("Pi: changed retained terminal metadata cancels the aggregate at native claim", async (t) => {
	const entered = deferred(),
		release = deferred();
	const { controller, ledger, calls } = await fixture(t, true, {
		aggregate: true,
		checkpoints: {
			beforeQueueClaim: async () => {
				entered.resolve();
				await release.promise;
				return true;
			},
		},
	});
	const p = describedResults("alpha", ["alpha-0"]);
	p.warning = "Review required";
	const describe = p.describeResult;
	p.describeResult = async (intent) => ({ ...(await describe(intent)), warnings: [p.warning] });
	controller.register(p);
	const running = controller.wake();
	await entered.promise;
	p.warning = "Changed without a revision";
	release.resolve();
	await running;
	assert.deepEqual(calls, []);
	assert.equal((await ledger.snapshot()).attempts[0].consumed, false);
});

for (const navigate of [false, true]) {
	test(`Pi: a drained host can be replaced on the same AgentSession${navigate ? " after branch navigation" : ""}`, async (t) => {
		const first = await fixture(t, true);
		first.controller.register(producer("alpha"));
		await first.controller.wake();
		const stalePrompt = first.session.prompt.bind(first.session);
		const staleClaim = first.session.agent.flowCheckpoints.beforeQueueClaim;
		const before = await first.ledger.snapshot();
		if (navigate) {
			const user = first.session.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			await first.session.navigateTree(user.id);
		}
		await first.controller.close();
		await assert.rejects(stalePrompt("stale input"), { code: "stale" });
		await assert.rejects(staleClaim([], new AbortController().signal), { code: "stale" });
		const root = await mkdtemp(join(tmpdir(), "jouzu-controller-replace-"));
		const attachment = await PiFlowAttachment.open(root, {
			sessionId: first.session.sessionId,
			branchId: navigate ? "other" : "main",
		});
		const host = new PiControllerHost(
			first.session,
			attachment.ledger,
			{
				projections: new Map([["openai-completions", openAIFlowPayload("openai-completions")]]),
				maxPayloadBytes: 100000,
				containsUserInput: () => false,
			},
			() => ({ userPending: false, recoveryBlocked: false, waitingWorkIds: [] }),
		);
		const second = new SessionFlowController(host, 4096);
		t.after(async () => {
			await second.close();
			await attachment.close();
			await rm(root, { recursive: true, force: true });
		});
		second.register(producer("beta"));
		await second.wake();
		assert.deepEqual(first.calls, ["alpha", "beta"]);
		const state = await attachment.ledger.snapshot();
		assert.equal(state.attempts.length, 1);
		assert.equal(state.attempts[0].phase, "settled");
		assert.equal(state.attempts[0].requests[0].payload.inclusion[0].disposition, "included");
		assert.deepEqual(await first.ledger.snapshot(), before);
	});
}

for (const summarize of [false, "extension", "native"]) {
	test(`Pi: branch lifecycle hands off and attaches before tree events, summary=${summarize}`, async (t) => {
		let first, second, nextAttachment, navigationSignal;
		const events = [];
		const sent = [];
		const ingress = {
			version: 1,
			submit: (_input, dispatch) => dispatch(),
			async beforeBranchChange() {
				first.host.handoffNavigation();
				await first.controller.close();
				events.push("detached");
			},
			async branchChanged() {
				nextAttachment = await PiFlowAttachment.open(first.storageRoot, {
					sessionId: first.session.sessionId,
					branchId: "next",
				});
				const host = new PiControllerHost(
					first.session,
					nextAttachment.ledger,
					{
						projections: new Map([["openai-completions", openAIFlowPayload("openai-completions")]]),
						maxPayloadBytes: 100000,
						containsUserInput: () => false,
					},
					() => ({ userPending: false, recoveryBlocked: false, waitingWorkIds: [] }),
				);
				second = new SessionFlowController(host, 4096);
				second.register(producer("beta"));
				events.push("attached");
			},
		};
		first = await fixture(t, true, {
			ingress,
			fetch: async (_url, init) => {
				const body = JSON.parse(init.body);
				const content = body.messages.findLast((item) => item.role === "user").content;
				let frame;
				try {
					frame = JSON.parse(typeof content === "string" ? content : content[0].text);
				} catch {
					/* Native summary prompt. */
				}
				sent.push(frame?.flowInput?.[2] ?? "summary");
				return answer();
			},
			extensions: [
				(pi) =>
					pi.on("session_before_tree", ({ signal }) => {
						navigationSignal = signal;
						if (summarize === "extension") return { summary: { summary: "Retained branch summary" } };
					}),
				(pi) =>
					pi.on("session_tree", () => {
						events.push("tree");
					}),
			],
		});
		t.after(async () => {
			await second?.close();
			await nextAttachment?.close();
		});
		first.controller.register(producer("alpha"));
		await first.controller.wake();
		const oldState = await first.ledger.snapshot();
		const oldPrompt = first.session.prompt.bind(first.session);
		const target = first.session.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		const navigation = await first.session.navigateTree(target.id, { summarize: !!summarize });
		assert.equal(navigationSignal.aborted, false);
		if (summarize === "native") assert.match(navigation.summaryEntry.summary, /\n\nDone$/);
		else if (summarize) assert.equal(navigation.summaryEntry.summary, "Retained branch summary");
		assert.deepEqual(events, ["detached", "attached", "tree"]);
		await assert.rejects(oldPrompt("stale"), { code: "stale" });
		await second.wake();
		assert.deepEqual(sent, summarize === "native" ? ["alpha", "summary", "beta"] : ["alpha", "beta"]);
		assert.equal((await nextAttachment.ledger.snapshot()).attempts[0].phase, "settled");
		assert.deepEqual(await first.ledger.snapshot(), oldState);
		await first.host.close();
		await second.close();
	});
}

test("producer changes can await owner scheduling before admission", async (t) => {
	const { controller, calls } = await fixture(t, false);
	const item = producer("owned");
	const entered = deferred(),
		proceed = deferred();
	const handle = controller.register(item, async () => {
		entered.resolve();
		await proceed.promise;
		await controller.wake();
	});
	const changed = handle.changed();
	await entered.promise;
	assert.equal(item.builds.length, 0);
	assert.equal(calls.length, 0);
	proceed.resolve();
	await changed;
	assert.equal(item.builds.length, 1);
	assert.equal(calls.length, 1);
});

test("owner scheduler failure preserves producer work for a later notification", async (t) => {
	const { controller, calls } = await fixture(t, false);
	let fail = true;
	const item = producer("retry-owner");
	const handle = controller.register(item, () => {
		if (fail) throw new Error("scheduler unavailable");
		return controller.wake();
	});
	await assert.rejects(handle.changed(), /scheduler unavailable/);
	assert.equal(item.builds.length, 0);
	fail = false;
	await handle.changed();
	assert.equal(calls.length, 1);
	handle.dispose();
	await assert.rejects(handle.changed(), { code: "stale" });
});

test("disposed registration cannot notify an owner scheduler on the deferred callback", async (t) => {
	const { controller } = await fixture(t, false);
	let notifications = 0;
	const handle = controller.register(producer("disposed-owner"), async () => {
		notifications++;
	});
	const changed = handle.changed();
	handle.dispose();
	await assert.rejects(changed, { code: "stale" });
	assert.equal(notifications, 0);
});

const decisionProducer = (build) =>
	producer(
		"decisions",
		[descriptor("decisions", "decision", 3)],
		build ??
			((item) => ({
				id: item.id,
				revision: item.revision,
				kind: "wait",
				text: "dependency resolved",
			})),
	);

test("composed decision is revalidated after owning work builds", async (t) => {
	const f = await fixture(t, false);
	const decisions = decisionProducer();
	const work = producer("work", [descriptor("work")], (item) => {
		decisions.items = [];
		return { id: item.id, revision: item.revision, kind: "work", text: "work" };
	});
	f.controller.register(decisions);
	f.controller.register(work);
	await f.controller.wake();
	assert.deepEqual(f.calls, []);
	assert.deepEqual((await f.ledger.snapshot()).attempts, []);
});

test("a new owning-work wait during decision build prevents the composed request", async (t) => {
	const f = await fixture(t, false);
	f.controller.register(
		decisionProducer((item) => {
			f.policy.waitingWorkIds = ["work"];
			return { id: item.id, revision: item.revision, kind: "wait", text: "decision" };
		}),
	);
	f.controller.register(producer("work"));
	await f.controller.wake();
	assert.deepEqual(f.calls, []);
});

test("oversized owning instructions stay held while the terminal decision can be delivered", async (t) => {
	const f = await fixture(t, false);
	f.controller.register(decisionProducer());
	f.controller.register(
		producer("work", [descriptor("work")], (item) => ({
			id: item.id,
			revision: item.revision,
			kind: "work",
			text: "x".repeat(100_000),
		})),
	);
	await f.controller.wake();
	assert.deepEqual(f.calls, ["decision"]);
	assert.ok(f.controller.view().held.some((item) => item.producer === "work"));
	assert.deepEqual(
		(await f.ledger.snapshot()).attempts[0].members.map((item) => item.kind),
		["wait"],
	);
});

test("additional decisions that exceed capacity remain visible without excluding later fitting decisions", async (t) => {
	const f = await fixture(t, false);
	const decisions = producer(
		"decisions",
		["first", "huge", "last"].map((id, i) => descriptor("decisions", id, 3, i)),
		(item) => ({
			id: item.id,
			revision: item.revision,
			kind: "wait",
			text: item.id === "huge" ? "x".repeat(100_000) : item.id,
		}),
	);
	f.controller.register(decisions);
	let deferred;
	const run = f.host.run.bind(f.host);
	t.mock.method(f.host, "run", async () => {
		deferred = f.controller.view().deferredDecisions;
		await run();
	});
	await f.controller.wake();
	assert.deepEqual(f.calls, ["first"]);
	assert.deepEqual(
		(await f.ledger.snapshot()).attempts[0].members.map((member) => member.id),
		["first", "last"],
	);
	assert.equal(deferred[0].id, "huge");
	assert.ok(f.controller.view().held.some((item) => item.producer === "decisions"));
});

test("an additional decision withdrawn during composition prevents the combined request", async (t) => {
	const f = await fixture(t, false);
	const decisions = producer(
		"decisions",
		["first", "second"].map((id, i) => descriptor("decisions", id, 3, i)),
		(item) => {
			if (item.id === "second") decisions.items = decisions.items.filter((item) => item.id !== "second");
			return { id: item.id, revision: item.revision, kind: "wait", text: item.id };
		},
	);
	f.controller.register(decisions);
	await f.controller.wake();
	assert.deepEqual(f.calls, []);
	assert.deepEqual((await f.ledger.snapshot()).attempts, []);
});
