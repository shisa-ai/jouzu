import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkflowIntegration } from "../dist/subagents/integration.js";
import { afterFlowCleanup, assembledSession } from "./fixtures/flow-assembly.mjs";

test("tree navigation releases unread child completions without blocking later results", {
	timeout: 15000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "flow-child-tree-"));
	afterFlowCleanup(t, () => rm(root, { recursive: true, force: true }));
	const workers = [];
	const integration = createWorkflowIntegration(
		{ agentDir: join(root, "agent"), configDir: join(root, "config"), stateDir: join(root, "state") },
		(launch, emit, exit) => {
			const w = {
				launch,
				emit,
				exit,
				send() {},
				async stop() {
					exit(false);
				},
			};
			workers.push(w);
			return w;
		},
	);
	const roles = integration.service.roles();
	roles.config.maxConcurrent = 2;
	roles.config.roles = roles.config.roles.map((r) => ({ ...r, model: "fixture/fixture", tools: ["read"] }));
	integration.service.save(roles);
	const f = await assembledSession(t, {
		root,
		producerExtensions: [
			{
				name: "fixture-subagents",
				factory(pi) {
					integration.register(pi, async () => false);
				},
			},
		],
		script: async (_body, i) =>
			i === 0
				? {
						toolCalls: [0, 1].map((n) => ({
							id: `launch${n}`,
							name: "subagent",
							arguments: { op: "launch", role: "coder", task: `child ${n}` },
						})),
					}
				: { text: "Done" },
	});
	await f.session.prompt("Launch two children.");
	assert.equal(workers.length, 2);
	f.ingress.pauseAutomated("navigation hold");
	workers[0].emit({ type: "result", status: "completed", text: "First evidence" });
	workers[0].exit(true);
	await new Promise((r) => setTimeout(r, 80));
	const before = integration.service.runs();
	assert.ok(before.find((r) => r.completion)?.completion.batchId);
	assert.equal(before.find((r) => r.completion)?.completion.handled, false);
	assert.equal(f.bodies.length, 2, "the first completion is still held before navigation");
	const user = f.sessionManager.getBranch().find((e) => e.type === "message" && e.message.role === "user");
	await f.session.navigateTree(user.id);
	await f.session.prompt("Continue on the new branch.");
	assert.equal(f.ingress.automatedPause(), undefined, "new user turn must release the navigation hold");
	workers[1].emit({ type: "result", status: "completed", text: "Second evidence" });
	workers[1].exit(true);
	await new Promise((r) => setTimeout(r, 150));
	await f.session.agent.waitForIdle();
	const runs = integration.service.runs();

	assert.equal(runs.filter((r) => r.completion?.handled).length, 2);
	assert.equal(runs.filter((r) => r.completion?.batchId).length, 2);
	assert.ok(f.bodies.length > 3, "unread completions reach the provider on the new branch");
	assert.ok(JSON.stringify(f.bodies.slice(2)).includes("First evidence"));
	assert.ok(JSON.stringify(f.bodies.slice(2)).includes("Second evidence"));
});

for (const transform of ["included", "replaced", "omitted"])
	test(`terminal read observation requires final-input inclusion: ${transform}`, { timeout: 15000 }, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "flow-child-real-"));
		afterFlowCleanup(t, () => rm(root, { recursive: true, force: true }));
		const workers = [];
		const integration = createWorkflowIntegration(
			{ agentDir: join(root, "agent"), configDir: join(root, "config"), stateDir: join(root, "state") },
			(launch, emit, exit) => {
				const w = {
					launch,
					emit,
					exit,
					send() {},
					async stop() {
						exit(false);
					},
				};
				workers.push(w);
				return w;
			},
		);
		const roles = integration.service.roles();
		roles.config.roles = roles.config.roles.map((r) => ({ ...r, model: "fixture/fixture", tools: ["read"] }));
		integration.service.save(roles);
		const fixture = await assembledSession(t, {
			root,
			producerExtensions: [
				{
					name: "fixture-subagents",
					factory(pi) {
						integration.register(pi, async () => false);
						pi.on("context", (event) => ({
							messages: event.messages.flatMap((m) =>
								m.role === "toolResult" && m.details?.terminalRead
									? transform === "omitted"
										? []
										: transform === "replaced"
											? [{ ...m, content: [{ type: "text", text: "TERMINAL OUTPUT WITHHELD" }] }]
											: [m]
									: [m],
							),
						}));
					},
				},
			],
			script: async (body, index) => {
				if (index === 0)
					return {
						toolCalls: [
							{ name: "subagent", arguments: { op: "launch", role: "coder", task: "fixture child" }, id: "launch" },
						],
					};
				if (index === 1) {
					assert.equal(workers.length, 1, JSON.stringify(body));
					workers[0].emit({ type: "result", status: "completed", text: "SECRET_CHILD_EVIDENCE" });
					workers[0].exit(true);
					return {
						toolCalls: [
							{ name: "subagent", arguments: { op: "read", id: integration.service.runs()[0].id }, id: "read" },
						],
					};
				}
				return { text: "Finished" };
			},
		});
		await fixture.session.prompt("Run the fixture child and read its evidence.");
		await new Promise((r) => setTimeout(r, 50));
		await fixture.session.agent.waitForIdle();
		const runs = integration.service.runs();
		assert.ok(JSON.stringify(fixture.session.sessionManager.getBranch()).includes("SECRET_CHILD_EVIDENCE"));
		assert.equal(fixture.bodies.length, transform === "included" ? 3 : 4);
		if (transform === "replaced") assert.ok(JSON.stringify(fixture.bodies[2]).includes("TERMINAL OUTPUT WITHHELD"));
		assert.equal(JSON.stringify(fixture.bodies[2]).includes("SECRET_CHILD_EVIDENCE"), transform === "included");
		assert.equal(runs[0].completion.handled, true);
		const batches = fixture.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom_message" && e.customType === "jouzu-subagent-result");
		assert.equal(batches.length, transform === "included" ? 0 : 1);
	});
