import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkflowIntegration } from "../dist/subagents/integration.js";
import { afterFlowCleanup, assembledSession } from "./fixtures/flow-assembly.mjs";

for (const outcome of ["completed", "failed", "cancelled", "deadline"]) {
	test(`assembled child wait wakes on ${outcome} without polling`, { timeout: 15000 }, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "flow-child-wait-"));
		afterFlowCleanup(t, () => rm(root, { recursive: true, force: true }));
		const workers = [];
		const integration = createWorkflowIntegration(
			{ configDir: join(root, "config"), stateDir: join(root, "state") },
			(launch, emit, exit) => {
				const worker = {
					launch,
					emit,
					exit,
					send() {},
					async stop() {
						exit(false);
					},
				};
				workers.push(worker);
				return worker;
			},
		);
		const roles = integration.service.roles();
		roles.config.roles = roles.config.roles.map((role) => ({ ...role, model: "fixture/fixture", tools: ["read"] }));
		integration.service.save(roles);
		const wake = Promise.withResolvers();
		let dependency;
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
			script: async (_body, index) => {
				if (index === 0)
					return {
						toolCalls: [
							{ id: "launch", name: "subagent", arguments: { op: "launch", role: "coder", task: "Wait fixture" } },
						],
					};
				if (index === 1) {
					const result = f.sessionManager
						.getBranch()
						.find(
							(entry) =>
								entry.type === "message" &&
								entry.message.role === "toolResult" &&
								entry.message.toolCallId === "launch",
						).message;
					assert.equal(result.isError, false, JSON.stringify(result));
					dependency = result.details.waitDependency;
					assert.equal(dependency?.producer, "subagent");
					return {
						toolCalls: [
							{
								id: "wait",
								name: "agent_wait",
								arguments: {
									on: [dependency],
									reason: "Await child evidence",
									deadline: outcome === "deadline" ? "1s" : "10s",
								},
							},
						],
					};
				}
				if (index === 2) return { text: "Waiting for the child." };
				wake.resolve();
				return { text: "Wake received." };
			},
		});
		await f.session.prompt("Launch the child and wait for its result.");
		assert.equal(workers.length, 1);
		assert.equal((await f.ingress.branch().attachment.waits.snapshot())[0].state, "waiting");
		if (outcome === "cancelled") await integration.service.stop(dependency.handle);
		else if (outcome !== "deadline") {
			workers[0].emit({ type: "result", status: outcome, text: "Child evidence" });
			workers[0].exit(outcome === "completed");
		}
		await wake.promise;
		await f.session.agent.waitForIdle();
		const [wait] = await f.ingress.branch().attachment.waits.snapshot();
		assert.equal(wait.state, outcome === "deadline" ? "expired" : outcome === "completed" ? "resolved" : "failed");
		assert.equal(f.bodies.length, 4, "completion and wait decision share one wake");
		assert.equal(f.errors.length, 1);
		assert.match(f.errors[0].message, /^Background task waits are unavailable/);
	});
}
