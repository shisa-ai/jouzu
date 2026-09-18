import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { createBackgroundControllerExtension } from "../dist/flow-control/background-extension.js";
import { createMultiloopControllerExtension } from "../dist/flow-control/multiloop-extension.js";
import { multiloopWorkBinding } from "../dist/flow-control/multiloop-producer.js";
import { PiSessionFlowIngress } from "../dist/flow-control/pi-session-ingress.js";
import { consumedUserWork, retainUserWork } from "../dist/flow-control/user-work.js";
import { createFlowWaitExtension } from "../dist/flow-control/wait-tools.js";
import { afterCleanup } from "./fixtures/cleanup.mjs";
import { fixture, lifecycleProducer, waitForFlow } from "./fixtures/flow-session-ingress.mjs";

for (const boundary of ["build", "claim"]) {
	test(`work stop during ${boundary} prevents native provider dispatch and repeated producer replay`, {
		timeout: 10000,
	}, async (t) => {
		const entered = deferred(),
			proceed = deferred();
		const f = await fixture(t, {
			provider: true,
			checkpoints:
				boundary === "claim"
					? {
							beforeQueueClaim: async () => {
								entered.resolve();
								await proceed.promise;
								return true;
							},
						}
					: undefined,
		});
		const waits = f.ingress.branch().attachment.waits;
		await waits.registerWork("work", "lane", 0);
		const registration = f.ingress.registerProducer(
			lifecycleProducer(async (item) => {
				if (boundary === "build") {
					entered.resolve();
					await proceed.promise;
				}
				return { id: item.id, revision: item.revision, kind: "work", text: "owned continuation" };
			}),
		);
		const running = registration.changed();
		await entered.promise;
		await f.ingress.changeWork("work", "lane", 1, "stopped", "user stop");
		proceed.resolve();
		await running;
		assert.equal(f.sent.length, 0);
		await registration.changed();
		assert.equal(f.sent.length, 0);
		const attempts = (await f.ingress.branch().attachment.ledger.snapshot()).attempts;
		assert.ok(attempts.every((attempt) => attempt.phase === "cancelled" && attempt.consumed === false));
		await assert.rejects(f.ingress.changeWork("work", "lane", 2, "active", "replay"), { code: "transition" });
		const retired = (await waits.authoritySnapshot()).work;
		await waits.retire({ work: retired, waits: [], executions: [] });
		await registration.changed();
		assert.equal(f.sent.length, 0);
		await assert.rejects(waits.registerWork("work", "lane", Date.now()), { code: "stale" });
		const manager = SessionManager.open(f.session.sessionManager.getSessionFile());
		await f.ingress.dispose();
		const reopened = await fixture(t, { root: f.root, provider: true, manager });
		await reopened.ingress.registerProducer(lifecycleProducer()).changed();
		assert.equal(reopened.sent.length, 0);
	});
}

test("work pause survives restart and explicit resume schedules the retained continuation", {
	timeout: 10000,
}, async (t) => {
	const f = await fixture(t, { provider: true });
	await f.ingress.branch().attachment.waits.registerWork("work", "lane", 0);
	await f.ingress.changeWork("work", "lane", 1, "paused", "user pause");
	await f.ingress.registerProducer(lifecycleProducer()).changed();
	assert.equal(f.sent.length, 0);
	const manager = SessionManager.open(f.session.sessionManager.getSessionFile());
	await f.ingress.dispose();
	const errors = [],
		built = deferred();
	const reopened = await fixture(t, {
		root: f.root,
		provider: true,
		manager,
		autoRelease: { onError: (error) => errors.push(error) },
	});
	const registration = reopened.ingress.registerProducer(
		lifecycleProducer(async (item) => {
			built.resolve();
			return { id: item.id, revision: item.revision, kind: "work", text: "resumed continuation" };
		}),
	);
	await registration.changed();
	assert.equal(reopened.sent.length, 0);
	await reopened.ingress.changeWork("work", "lane", 2, "active", "user resume");
	await built.promise;
	await reopened.ingress.wakeProducers();
	assert.equal(reopened.sent.length, 1);
	assert.ok(JSON.stringify(reopened.sent).includes("resumed continuation"));
	await registration.changed();
	assert.equal(reopened.sent.length, 1);
	assert.deepEqual(errors, []);
});

for (const replay of [false, true]) {
	test(`producer subscription synchronization gates semantic dispatch until snapshot is committed: ${replay ? "replay" : "new"}`, {
		timeout: 10000,
	}, async (t) => {
		const errors = [],
			entered = deferred(),
			proceed = deferred(),
			built = deferred();
		const f = await fixture(t, { provider: true, autoRelease: { onError: (error) => errors.push(error) } });
		const branch = f.ingress.branch();
		await branch.attachment.waits.registerWork("work", "lane", 0);
		if (replay)
			await branch.attachment.waits.registerExecution(
				{
					producer: "lane",
					workId: "work",
					handle: "job",
					execution: "execution",
					revision: 1,
					predicates: [{ until: "exit", state: "pending" }],
				},
				1,
				0,
			);
		const source = branch.attachment.waitProducers.register(
			{
				version: 1,
				namespace: "lane",
				subscribe: () => () => {},
				async snapshot(identity) {
					entered.resolve();
					await proceed.promise;
					return { ...identity, revision: 1, predicates: [{ until: "exit", state: "pending" }] };
				},
			},
			(error) => errors.push(error),
		);
		const binding = source.bind({ workId: "work", handle: "job", execution: "execution" }, 1);
		await entered.promise;
		let builds = 0;
		const registration = f.ingress.registerProducer(
			lifecycleProducer(async (item) => {
				builds++;
				built.resolve();
				return { id: item.id, revision: item.revision, kind: "work", text: "after subscription" };
			}),
		);
		await registration.changed();
		assert.equal(builds, 0);
		assert.equal(f.sent.length, 0);
		proceed.resolve();
		await binding;
		await built.promise;
		await f.ingress.wakeProducers();
		assert.equal(f.sent.length, 1);
		assert.deepEqual(errors, []);
	});
}

test("missing retained producer prevents native user dispatch after reopening", async (t) => {
	const first = await fixture(t, { provider: true });
	const waits = first.ingress.branch().attachment.waits;
	await waits.registerWork("work", "lane", 0);
	await waits.shareWork("work", "lane", 1, "bg", 0);
	await waits.registerExecution(
		{
			producer: "bg",
			workId: "work",
			handle: "bg-1",
			execution: "exec",
			revision: 1,
			predicates: [{ until: "exit", state: "pending" }],
		},
		2,
		0,
	);
	await first.ingress.dispose();
	const reopened = await fixture(t, {
		root: first.root,
		manager: SessionManager.open(first.session.sessionManager.getSessionFile()),
		provider: true,
	});
	await reopened.session.prompt("status");
	assert.deepEqual(reopened.ingress.branch().waitSourceRecovery, { restored: 0, missing: ["bg"] });
	assert.equal((await reopened.ingress.heldInputs()).length, 1);
	assert.deepEqual(reopened.sent, []);
});

test("idle user prompts bind distinct durable work identities across equal text and reopening", async (t) => {
	const seen = [];
	let authority;
	const f = await fixture(t, {
		provider: true,
		onRequest() {
			const context = f.ingress.branch().workContext;
			const work = context.current();
			seen.push(work);
			authority = context.authorize(work.id);
		},
	});
	await f.session.prompt("same instruction");
	assert.throws(() => authority.assertActive(), { code: "stale" });
	const firstAttachment = f.ingress.branch().attachment;
	await firstAttachment.waits.shareWork(seen[0].id, "host-user", 1, "bg", Date.now());
	await firstAttachment.waits.registerExecution(
		{
			producer: "bg",
			handle: "bg-original",
			execution: "original-execution",
			workId: seen[0].id,
			revision: 1,
			predicates: [{ until: "exit", state: "pending" }],
		},
		2,
		Date.now(),
	);
	await f.session.prompt("same instruction");
	assert.equal(seen.length, 2);
	assert.notEqual(seen[0].id, seen[1].id);
	const branch = f.ingress.branch();
	const records = await branch.attachment.submissions.snapshot();
	const work = await retainUserWork(branch.attachment, records[0].id, records[0].revision);
	assert.equal(work.id, seen[0].id);
	assert.equal((await branch.attachment.waits.authoritySnapshot()).work.length, 2);
	await f.ingress.dispose();
	const next = await fixture(t, {
		root: f.root,
		provider: true,
		manager: SessionManager.open(f.session.sessionManager.getSessionFile()),
	});
	assert.deepEqual(await retainUserWork(next.ingress.branch().attachment, records[0].id, records[0].revision), work);
	assert.equal(next.sent.length, 0);
	assert.equal((await next.ingress.branch().attachment.waits.authoritySnapshot()).executions[0].workId, seen[0].id);
});

test("user-work participants reject invalid configuration before attachment", () => {
	for (const userWorkParticipants of [
		null,
		"bg",
		["bg", "bg"],
		["Bad"],
		[1],
		new Array(1),
		Array.from({ length: 64 }, (_, i) => `p${i}`),
	])
		assert.throws(() => new PiSessionFlowIngress({ userWorkParticipants }), { code: "schema" });
});

test("user-work producer grants capture host configuration and remain idempotent", async (t) => {
	const participants = ["bg"];
	const f = await fixture(t, { provider: true, userWorkParticipants: participants });
	participants.push("foreign");
	await f.session.prompt("instruction");
	const attachment = f.ingress.branch().attachment;
	const [record] = await attachment.submissions.snapshot();
	const before = await attachment.waits.authoritySnapshot();
	assert.deepEqual(before.work[0].participants, ["host-user", "bg"]);
	await retainUserWork(attachment, record.id, record.revision, ["bg"]);
	assert.deepEqual(await attachment.waits.authoritySnapshot(), before);
});

test("user work rejects automated submissions, stale revisions, and cancelled input", async (t) => {
	const f = await fixture(t, { admit: async () => false });
	await f.session.sendUserMessage("automated instruction");
	await f.session.prompt("user instruction");
	const attachment = f.ingress.branch().attachment;
	const [automated, user] = await attachment.submissions.snapshot();
	await assert.rejects(retainUserWork(attachment, automated.id, automated.revision), { code: "identity" });
	await assert.rejects(retainUserWork(attachment, user.id, user.revision + 1), { code: "stale" });
	await attachment.submissions.cancel(user.id, user.revision);
	await assert.rejects(retainUserWork(attachment, user.id, user.revision), { code: "stale" });
	assert.deepEqual((await attachment.waits.authoritySnapshot()).work, []);
});

for (const lane of ["steer", "followUp"])
	for (const count of [1, 2])
		test(`consumed ${lane} user batch of ${count} selects fresh tool work without reviving older callbacks`, async (t) => {
			const seen = [],
				escaped = deferred();
			let oldCheck,
				oldContinuation,
				request = 0;
			const f = await fixture(t, {
				provider: true,
				userWorkParticipants: ["bg"],
				tools: ["inspect_work"],
				extensions: [
					{
						name: "inspect-work",
						factory(pi) {
							pi.registerTool({
								name: "inspect_work",
								label: "Inspect work",
								description: "Inspect owning work",
								parameters: { type: "object", properties: {}, additionalProperties: false },
								async execute() {
									const context = f.ingress.branch().workContext;
									const current = context.current();
									seen.push(current);
									if (seen.length === 1) {
										oldCheck = context.authorize(current.id);
										oldContinuation = escaped.promise.then(() =>
											assert.throws(() => context.current(), { code: "stale" }),
										);
										for (let i = 0; i < count; i++) await f.session.prompt(`queued ${i}`, { streamingBehavior: lane });
										oldCheck.assertActive();
									} else {
										assert.notEqual(current.id, seen[0].id);
										assert.throws(() => oldCheck.assertActive(), { code: "stale" });
										escaped.resolve();
										await oldContinuation;
									}
									return { content: [{ type: "text", text: current.id }], details: {} };
								},
							});
						},
					},
				],
				response() {
					request++;
					const callTool = request === 1 || request === (lane === "followUp" ? 3 : 2);
					const delta = callTool
						? {
								tool_calls: [
									{
										index: 0,
										id: `call-${request}`,
										type: "function",
										function: { name: "inspect_work", arguments: "{}" },
									},
								],
							}
						: { content: "Done" };
					return new Response(
						`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: callTool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					);
				},
			});
			await f.session.bindExtensions({
				onError: (error) => {
					throw error;
				},
			});
			f.session.setSteeringMode("all");
			f.session.setFollowUpMode("all");
			await f.session.prompt("initial instruction");
			assert.ok(
				f.session.agent.state.messages
					.filter((message) => message.role === "toolResult")
					.every((message) => !message.isError),
			);
			assert.equal(seen.length, 2);
			const attachment = f.ingress.branch().attachment;
			const authority = await attachment.waits.authoritySnapshot();
			for (const item of authority.work) assert.deepEqual(item.participants, ["host-user", "bg"]);
			const records = await attachment.submissions.snapshot();
			const queued = records.filter((record) => record.submission.args[0]?.startsWith?.("queued "));
			assert.equal(queued.length, count);
			if (count === 1)
				assert.equal((await retainUserWork(attachment, queued[0].id, queued[0].revision)).id, seen[1].id);
			else assert.match(seen[1].id, /^user-batch:/);
			const claims = queued.flatMap((record) => record.dispatch.queueClaims.filter((claim) => claim.consumed));
			assert.equal((await consumedUserWork(attachment, claims)).id, seen[1].id);
			assert.equal(await consumedUserWork(attachment, [{ id: "unknown", revision: 1 }, ...claims]), undefined);
			assert.equal(
				await consumedUserWork(
					attachment,
					claims.map((claim) => ({ ...claim, revision: claim.revision + 1 })),
				),
				undefined,
			);
			assert.equal(request, lane === "followUp" ? 4 : 3);
		});

for (const lane of ["steer", "followUp"])
	for (const cancel of [false, true])
		test(`idle ${lane} queue drain owns a neutral operation before consumption: cancel=${cancel}`, async (t) => {
			let request = 0,
				observed,
				authority;
			const f = await fixture(t, {
				provider: true,
				tools: ["inspect_work"],
				extensions: [
					{
						name: "inspect-work",
						factory(pi) {
							pi.registerTool({
								name: "inspect_work",
								label: "Inspect work",
								description: "Inspect owning work",
								parameters: { type: "object", properties: {}, additionalProperties: false },
								async execute() {
									const context = f.ingress.branch().workContext;
									observed = context.current();
									authority = context.authorize(observed.id);
									return { content: [{ type: "text", text: observed.id }], details: {} };
								},
							});
						},
					},
				],
				response() {
					request++;
					const delta =
						request === 1
							? {
									tool_calls: [
										{ index: 0, id: "inspect", type: "function", function: { name: "inspect_work", arguments: "{}" } },
									],
								}
							: { content: "Done" };
					return new Response(
						`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: request === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					);
				},
			});
			await f.session.bindExtensions({
				onError: (error) => {
					throw error;
				},
			});
			await f.session[lane]("queued instruction");
			assert.equal(f.sent.length, 0);
			assert.equal(f.ingress.branch().workContext.current(), undefined);
			const [record] = await f.ingress.branch().attachment.submissions.snapshot();
			const expected = await retainUserWork(f.ingress.branch().attachment, record.id, record.revision);
			if (cancel) {
				const [queued] = f.session.agent.inspectQueuedMessages();
				await f.ingress.cancelNativeQueue(queued.id, queued.revision);
			}
			await f.session.continueQueued();
			assert.equal(request, cancel ? 0 : 2);
			if (!cancel) {
				assert.equal(observed.id, expected.id);
				assert.throws(() => authority.assertActive(), { code: "stale" });
				assert.ok(
					f.session.agent.state.messages
						.filter((message) => message.role === "toolResult")
						.every((message) => !message.isError),
				);
			}
			await f.session.continueQueued();
			assert.equal(request, cancel ? 0 : 2);
		});

for (const mode of ["normal", "reversed", "reopen", "model-tools", "shared-results"])
	test(`loaded multiloop/background pair automatically composes after its wait (${mode})`, {
		skip: process.platform === "win32",
		timeout: 20000,
	}, async (t) => {
		const reverse = mode === "reversed";
		const root = await mkdtemp(join(tmpdir(), "jouzu-loaded-background-"));
		afterCleanup(t, () => rm(root, { recursive: true, force: true }));
		const releaseFile = join(root, "release-task");
		const command = `while test ! -e '${releaseFile.replaceAll("'", "'\\''")}'; do sleep 0.02; done; printf 'flow-result-marker\\n'`;
		const manager = SessionManager.create(root, join(root, "history"));
		const { createJiti } = await import(
			createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("jiti")
		);
		const jiti = createJiti(import.meta.url, { moduleCache: false });
		let loaded = await jiti.import(
			join(import.meta.dirname, "../node_modules/@vanillagreen/pi-background-tasks/extensions/background-tasks.ts"),
			{ default: true },
		);
		const loopFactory = await jiti.import(
			join(import.meta.dirname, "../node_modules/pi-multiloop/extensions/pi-multiloop/index.ts"),
			{ default: true },
		);
		const errors = [],
			tools = new Map();
		let f, ctx, task, token;
		let modelStage = 0;
		const loopBridge = createMultiloopControllerExtension({
			ingress: () => f.ingress,
			onError: (error) => errors.push(error),
		});
		const loop = {
			name: "loaded-multiloop",
			factory(pi) {
				const proxy = Object.create(pi);
				proxy.registerTool = (tool) => {
					tools.set(tool.name, tool);
					pi.registerTool(tool);
				};
				pi.on("session_start", (_event, context) => {
					ctx = context;
				});
				loopFactory(proxy);
			},
		};
		const bridge = createBackgroundControllerExtension({
			ingress: mode === "shared-results" ? () => f.ingress : undefined,
			currentWork: () => f.ingress.branch().workContext.current(),
			onError: (error) => errors.push(error),
		});
		const background = {
			name: "loaded-background",
			factory(pi) {
				const proxy = Object.create(pi);
				proxy.registerTool = (tool) => {
					tools.set(tool.name, tool);
					pi.registerTool(tool);
				};
				loaded(proxy);
			},
		};
		const wait = createFlowWaitExtension({
			attachment: () => f.ingress.branch().attachment,
			authorize: (work) => f.ingress.branch().workContext.authorize(work),
			maxDurationMs: 10000,
		});
		f = await fixture(t, {
			root,
			manager,
			provider: true,
			shutdownExtensions: true,
			maxInputBytes: mode === "shared-results" ? 8192 : 4096,
			admit: null,
			autoRelease: { onError: (error) => errors.push(error) },
			tools: ["model-tools", "shared-results"].includes(mode) ? ["multiloop_start", "bg_task", "agent_wait"] : [],
			consumedAttempt: loopBridge.consumedAttempt,
			response: !["model-tools", "shared-results"].includes(mode)
				? undefined
				: () => {
						let name, args;
						if (modelStage === 0) {
							name = "multiloop_start";
							args = { lane: "test", runTag: "run", mode: "research", goal: "Wait for task" };
						} else if (modelStage === 1) {
							name = "bg_task";
							args = {
								action: "spawn",
								command,
								notifyOnExit: mode === "shared-results",
								notifyOnOutput: false,
								timeoutSeconds: 5,
							};
						} else if (modelStage === 2) {
							const result = f.session.agent.state.messages.findLast(
								(message) => message.role === "toolResult" && message.toolName === "bg_task",
							);
							assert.equal(result.isError, false);
							task = result.details.task;
							name = "agent_wait";
							args = {
								work: task.flow.work.id,
								reason: "Await installed task",
								deadline: "10s",
								on: [{ producer: "bg", handle: task.id, execution: task.flow.execution, until: "exit" }],
							};
						}
						modelStage++;
						const delta = name
							? {
									tool_calls: [
										{
											index: 0,
											id: `call-${modelStage}`,
											type: "function",
											function: { name, arguments: JSON.stringify(args) },
										},
									],
								}
							: { content: "Done" };
						return new Response(
							`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: name ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
							{ headers: { "content-type": "text/event-stream" } },
						);
					},
			attachWaitSources: async (attachment) => bridge.attach(attachment, manager),
			extensions: [
				...(reverse ? [background, loop, bridge, loopBridge] : [loopBridge, bridge, loop, background]),
				{
					name: "wait-capture",
					factory(pi) {
						const proxy = Object.create(pi);
						proxy.registerTool = (tool) => {
							tools.set(tool.name, tool);
							pi.registerTool(tool);
						};
						wait.factory(proxy);
					},
				},
			],
		});
		await f.session.bindExtensions({ onError: (error) => errors.push(error) });
		const branch = f.ingress.branch();
		if (["model-tools", "shared-results"].includes(mode)) {
			f.session.setActiveToolsByName(["multiloop_start", "bg_task", "agent_wait"]);
			assert.equal(f.session.agent.state.tools.length, 3, JSON.stringify(f.session.getAllTools()));
			await f.session.prompt("Start the lane, spawn its background process, and wait for its exit.");
			const results = f.session.agent.state.messages.filter((message) => message.role === "toolResult");
			assert.deepEqual(
				results.map((result) => [result.toolName, result.isError]),
				[
					["multiloop_start", false],
					["bg_task", false],
					["agent_wait", false],
				],
				JSON.stringify(results),
			);
			token = (await branch.attachment.waits.snapshot())[0].token;
		} else {
			await tools
				.get("multiloop_start")
				.execute(
					"start",
					{ lane: "test", runTag: "run", mode: "research", goal: "Wait for task" },
					undefined,
					undefined,
					ctx,
				);
			const campaign = branch.attachment.waits.boundWork(multiloopWorkBinding({ lane: "test", runTag: "run" }));
			await branch.workContext.run({ id: campaign.id, actor: "multiloop", revision: campaign.revision }, async () => {
				const result = await tools.get("bg_task").execute("spawn", {
					action: "spawn",
					command,
					notifyOnExit: mode === "shared-results",
					notifyOnOutput: false,
					timeoutSeconds: 5,
				});
				task = result.details.task;
				assert.deepEqual(task.flow.scope, branch.scope);
				assert.equal(task.flow.work.id, campaign.id);
				await tools.get("agent_wait").execute(
					"wait",
					{
						work: campaign.id,
						reason: "Await installed task",
						deadline: "10s",
						on: [{ producer: "bg", handle: task.id, execution: task.flow.execution, until: "exit" }],
					},
					undefined,
					undefined,
					{ sessionManager: manager },
				);
				token = (await branch.attachment.waits.snapshot())[0].token;
			});
		}
		for (let i = 0; i < 3; i++) await f.session.prompt("status?");
		assert.equal((await branch.attachment.ledger.snapshot()).attempts.length, 0);
		assert.equal(f.sent.length, ["model-tools", "shared-results"].includes(mode) ? 7 : 3);
		if (mode === "reopen") {
			const expiry = (await branch.attachment.waits.snapshot())[0].expiresAt;
			await f.ingress.dispose();
			await writeFile(releaseFile, "complete");
			await waitForFlow(
				async () =>
					(await tools.get("bg_status").execute("status", { action: "list" })).details.tasks[0]?.status === "completed",
			);
			loaded = await createJiti(import.meta.url, { moduleCache: false }).import(
				join(import.meta.dirname, "../node_modules/@vanillagreen/pi-background-tasks/extensions/background-tasks.ts"),
				{ default: true },
			);
			const reopenedManager = SessionManager.open(manager.getSessionFile());
			f = await fixture(t, {
				root,
				manager: reopenedManager,
				provider: true,
				shutdownExtensions: true,
				admit: null,
				attachWaitSources: async (attachment) => bridge.attach(attachment, reopenedManager),
				extensions: [bridge, background],
			});
			const reopened = f.ingress.branch();
			assert.deepEqual(reopened.waitSourceRecovery.missing, []);
			assert.equal(reopened.waitSourceRecovery.restored, 1);
			const restored = (await reopened.attachment.waits.snapshot())[0];
			assert.equal(restored.token, token);
			assert.equal(restored.expiresAt, expiry);
			assert.equal(restored.state, "resolved");
			assert.equal(f.sent.length, 0);
			assert.deepEqual(errors, []);
			await f.ingress.dispose();
			return;
		}
		await writeFile(releaseFile, "complete");
		for (let i = 0; i < 1000; i++) {
			if ((await branch.attachment.ledger.snapshot()).attempts.some((a) => a.phase === "settled")) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const attempts = (await branch.attachment.ledger.snapshot()).attempts;
		assert.equal(attempts.length, 1);
		assert.equal(
			attempts[0].outcome,
			"success",
			JSON.stringify({ attempts, errors: errors.map((error) => ({ message: error.message, stack: error.stack })) }),
		);
		assert.deepEqual(
			attempts[0].members.map((member) => member.kind),
			mode === "shared-results" ? ["wait", "work", "result"] : ["wait", "work"],
		);
		assert.equal((await branch.attachment.waits.snapshot())[0].token, token);
		assert.deepEqual(errors, []);
		assert.equal(f.sent.length, ["model-tools", "shared-results"].includes(mode) ? 8 : 4);
		if (mode === "shared-results") {
			assert.match(JSON.stringify(f.sent.at(-1)), /flow-results:/);
			assert.match(JSON.stringify(f.sent.at(-1)), /bg-result:/);
			await waitForFlow(
				async () =>
					(await tools.get("bg_status").execute("status", { action: "list" })).details.tasks[0]?.flow?.result
						?.delivered === true,
			);
			const recorded = (await tools.get("bg_status").execute("status", { action: "list" })).details.tasks[0];
			assert.equal(recorded.exitNotified, true);
			assert.equal(recorded.flow.result.metadata.execution, task.flow.execution);
			assert.equal(recorded.flow.result.metadata.reference, task.logFile);
			assert.match(await readFile(task.logFile, "utf8"), /flow-result-marker/);
			assert.equal(f.sent.length, 8);
			const reference = JSON.stringify(f.sent.at(-1)).match(/flow-results:[a-f0-9]{64}/)[0];
			await f.ingress.dispose();
			loaded = await createJiti(import.meta.url, { moduleCache: false }).import(
				join(import.meta.dirname, "../node_modules/@vanillagreen/pi-background-tasks/extensions/background-tasks.ts"),
				{ default: true },
			);
			const reopenedManager = SessionManager.open(manager.getSessionFile());
			f = await fixture(t, {
				root,
				manager: reopenedManager,
				provider: true,
				shutdownExtensions: true,
				admit: null,
				tools: ["agent_results"],
				autoRelease: { onError: (error) => errors.push(error) },
				attachWaitSources: async (attachment) => bridge.attach(attachment, reopenedManager),
				extensions: [bridge, background],
			});
			await f.session.bindExtensions({ onError: (error) => errors.push(error) });
			const readResults = f.session.getToolDefinition("agent_results");
			assert.ok(readResults);
			const result = await readResults.execute("results", { reference, limit: 1 }, undefined, undefined, {
				sessionManager: reopenedManager,
			});
			const page = JSON.parse(result.content[0].text);
			assert.equal(page.total, 1);
			assert.equal(page.members[0].execution, task.flow.execution);
			assert.equal(page.members[0].reference, task.logFile);
			await f.ingress.wakeProducers();
			assert.equal(f.sent.length, 0);
			assert.deepEqual(errors, []);
			await f.ingress.dispose();
		}
	});

for (const bindExecution of [true, false])
	for (const notifyOnExit of [true, false])
		for (const redacted of [false, true])
			test(`installed background terminal log observation follows final provider content (redacted=${redacted}, notify=${notifyOnExit}, wait=${bindExecution})`, {
				skip: process.platform === "win32",
				timeout: 20000,
			}, async (t) => {
				const root = await mkdtemp(join(tmpdir(), "jouzu-bg-observation-"));
				afterCleanup(t, () => rm(root, { recursive: true, force: true }));
				const manager = SessionManager.create(root, join(root, "history"));
				const { createJiti } = await import(
					createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("jiti")
				);
				let loaded = await createJiti(import.meta.url, { moduleCache: false }).import(
					join(import.meta.dirname, "../node_modules/@vanillagreen/pi-background-tasks/extensions/background-tasks.ts"),
					{ default: true },
				);
				const tools = new Map(),
					errors = [];
				let f,
					stage = 0,
					task;
				const bridge = createBackgroundControllerExtension({
					ingress: () => f.ingress,
					currentWork: () => f.ingress.branch().workContext.current(),
					onError: (error) => errors.push(error),
				});
				f = await fixture(t, {
					root,
					manager,
					provider: true,
					shutdownExtensions: true,
					userWorkParticipants: ["bg"],
					tools: ["bg_task"],
					maxInputBytes: 8192,
					attachWaitSources: async (attachment) => bridge.attach(attachment, manager),
					extensions: [
						bridge,
						{
							name: "background",
							factory(pi) {
								const proxy = Object.create(pi);
								proxy.registerTool = (tool) => {
									tools.set(tool.name, tool);
									pi.registerTool(tool);
								};
								loaded(proxy);
								if (redacted)
									pi.on("context", (event) => ({
										messages: event.messages.map((message) =>
											message.role === "toolResult" && message.details?.action === "log"
												? { ...message, content: [{ type: "text", text: "Removed" }] }
												: message,
										),
									}));
							},
						},
					],
					response: async () => {
						let args;
						if (stage === 0) args = { action: "spawn", command: "printf 'terminal-log-proof\\n'", notifyOnExit };
						if (stage === 1) {
							await waitForFlow(async () => {
								task = (await tools.get("bg_task").execute("inspect", { action: "list" })).details.tasks[0];
								return task?.status === "completed";
							});
							if (bindExecution)
								await f.ingress.branch().attachment.waitProducers.bindForWait(
									"bg",
									{
										workId: task.flow.work.id,
										handle: task.id,
										execution: task.flow.execution,
									},
									task.flow.work.revision,
								);
							args = { action: "log", id: task.id };
						}
						stage++;
						const delta = args
							? {
									tool_calls: [
										{
											index: 0,
											id: `read-${stage}`,
											type: "function",
											function: { name: "bg_task", arguments: JSON.stringify(args) },
										},
									],
								}
							: { content: "Done" };
						return new Response(
							`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: args ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
							{ headers: { "content-type": "text/event-stream" } },
						);
					},
				});
				await f.session.bindExtensions({ onError: (error) => errors.push(error) });
				await f.session.prompt("Start the task and inspect its terminal output");
				assert.equal(f.sent.length, 3);
				const read = (await tools.get("bg_task").execute("inspect", { action: "list" })).details.tasks[0];
				assert.equal(read.flow.result.reads.length, 1);
				assert.equal(read.flow.result.observed, undefined);
				await f.ingress.wakeProducers();
				const settled = (await tools.get("bg_task").execute("inspect", { action: "list" })).details.tasks[0];
				assert.equal(settled.flow.result.observed, redacted ? undefined : true);
				assert.equal(settled.flow.result.delivered, redacted && notifyOnExit ? true : undefined);
				assert.equal(f.sent.length, redacted && notifyOnExit ? 4 : 3);
				const waits = f.ingress.branch().attachment.waits;
				assert.equal((await waits.authoritySnapshot()).executions.length, bindExecution ? 1 : 0);
				assert.equal((await f.ingress.retireWaitHistory()).executions, 0);
				if (bindExecution)
					await f.ingress.branch().attachment.waitProducers.bindForWait(
						"bg",
						{
							workId: task.flow.work.id,
							handle: task.id,
							execution: task.flow.execution,
						},
						task.flow.work.revision,
					);
				const retired = await f.ingress.retireWaitHistory(true);
				assert.equal(retired.executions, !redacted && bindExecution ? 1 : 0);
				assert.equal(retired.work, redacted ? 0 : 1);
				assert.equal((await waits.authoritySnapshot()).executions.length, redacted && bindExecution ? 1 : 0);
				assert.deepEqual(errors, []);
				await f.ingress.dispose();
				loaded = await createJiti(import.meta.url, { moduleCache: false }).import(
					join(import.meta.dirname, "../node_modules/@vanillagreen/pi-background-tasks/extensions/background-tasks.ts"),
					{ default: true },
				);
				const reopenedManager = SessionManager.open(manager.getSessionFile());
				f = await fixture(t, {
					root,
					manager: reopenedManager,
					provider: true,
					shutdownExtensions: true,
					attachWaitSources: async (attachment) => bridge.attach(attachment, reopenedManager),
					extensions: [
						bridge,
						{
							name: "background-reopened",
							factory(pi) {
								const proxy = Object.create(pi);
								proxy.registerTool = (tool) => {
									tools.set(tool.name, tool);
									pi.registerTool(tool);
								};
								loaded(proxy);
							},
						},
					],
				});
				await f.session.bindExtensions({ onError: (error) => errors.push(error) });
				const reopened = (await tools.get("bg_task").execute("inspect", { action: "list" })).details.tasks[0];
				assert.equal(reopened.flow.result.observed, redacted ? undefined : true);
				assert.equal(reopened.flow.result.delivered, redacted && notifyOnExit ? true : undefined);
				assert.equal(
					(await f.ingress.branch().attachment.waits.authoritySnapshot()).executions.length,
					redacted && bindExecution ? 1 : 0,
				);
				await f.ingress.wakeProducers();
				assert.equal(f.sent.length, 0);
				assert.deepEqual(errors, []);
				await f.ingress.dispose();
			});
