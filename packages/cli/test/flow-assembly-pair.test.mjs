import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantToolCalls } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { assembledSession, installedProducerExtensions } from "./fixtures/flow-assembly.mjs";
import { waitDependencyFrom } from "./fixtures/flow-wait-dependency.mjs";

const idle = (ms = 1500) => new Promise((resolve) => setTimeout(resolve, ms));
const toolResults = (manager) =>
	manager
		.getEntries()
		.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
		.map((entry) => entry.message.content.map((part) => part.text ?? "").join("\n"));

test("the installed producer pair completes its handshakes inside the assembly", async (t) => {
	const f = await assembledSession(t, { producerExtensions: await installedProducerExtensions(t) });
	assert.deepEqual(f.errors, [], "no adapter reports an unavailable source when the real pair is loaded");
	const tools = f.session.getActiveToolNames();
	for (const name of ["multiloop_start", "bg_task", "agent_wait", "agent_wait_cancel", "agent_results"])
		assert.ok(tools.includes(name), `${name} is active`);
});

function blockedLaneScript(seen) {
	return (body, index) => {
		seen.push(index);
		if (index === 0)
			return assistantToolCalls({
				name: "multiloop_start",
				arguments: { lane: "sweep", runTag: "run", mode: "research", goal: "Wait for the sweep to finish" },
			});
		if (index === 1)
			return assistantToolCalls({
				name: "bg_task",
				arguments: { action: "spawn", command: "sleep 0.4 && echo finished" },
			});
		if (index === 2) {
			const dependency = waitDependencyFrom(body);
			assert.ok(dependency, "the task tool result carries exact wait evidence");
			return assistantToolCalls({
				name: "agent_wait",
				arguments: {
					work: dependency.work.id,
					reason: "the sweep must finish before the next measurement",
					deadline: "30m",
					on: [
						{
							producer: dependency.producer,
							handle: dependency.handle,
							execution: dependency.execution,
							until: dependency.until,
						},
					],
				},
			});
		}
		return { text: `turn ${index}` };
	};
}

test("a live wait blocks lane continuations and delivers its decision once", async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(t),
		script: blockedLaneScript([]),
	});
	await f.session.prompt("start the sweep and wait for it");
	const blocked = f.bodies.length;
	const waitResult = toolResults(f.sessionManager).find((text) => text.includes('"state":"waiting"'));
	assert.ok(waitResult?.includes('"token"'), "agent_wait returned a live wait with a reusable token");

	// The running lane would otherwise auto-continue at agent_end; the live wait must suppress it.
	await idle(250);
	assert.equal(f.bodies.length, blocked, "a blocked lane sends no continuation while its wait is live");

	await idle(1500);
	const wake = f.bodies.slice(blocked);
	assert.ok(wake.length >= 1, "the resolved dependency wakes the session");
	// Later requests replay the whole conversation, so only a newly appended message counts.
	const decisions = wake.filter((body) => JSON.stringify(body.messages.at(-1)).includes('kind\\":\\"wait'));
	assert.equal(decisions.length, 1, "the wait decision is delivered exactly once");
	assert.deepEqual(f.errors, []);

	const settled = f.bodies.length;
	await idle(600);
	assert.equal(f.bodies.length, settled, "a settled wait is not replayed");
});

test("wait resolution, the lane continuation, and the result compose one logical wake", async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: blockedLaneScript([]),
	});
	await f.session.prompt("start the sweep and wait for it");
	const blocked = f.bodies.length;
	await idle(1800);
	assert.equal(f.bodies.length - blocked, 1, "one composed wake, not a decision turn plus a continuation");
	const { attempts } = await f.ingress.branch().attachment.ledger.snapshot();
	const composed = attempts.filter((attempt) => attempt.admission);
	assert.equal(composed.length, 1, "one controller attempt carries the wake");
	assert.equal(composed[0].admission.choice.intent.producer, "multiloop", "the lane instruction is the selected work");
	assert.deepEqual(
		[...new Set(composed[0].members.map((member) => member.kind))].sort(),
		["result", "wait", "work"],
		"the decision, the lane instruction, and the background result share one turn",
	);
	assert.deepEqual(f.errors, []);
});

test("the assembly rejects a transport replaced after sealing", async (t) => {
	const f = await assembledSession(t, { producerExtensions: await installedProducerExtensions(t) });
	await f.session.prompt("first");
	assert.equal(f.bodies.length, 1);
	f.session.agent.streamFunction = async () => {
		throw new Error("must not be invoked");
	};
	await f.session.prompt("second");
	assert.equal(f.bodies.length, 1, "the replaced transport sends nothing");
	const held = f.sessionManager
		.getEntries()
		.some((entry) => entry.type === "message" && /transport changed/.test(entry.message.errorMessage ?? ""));
	assert.ok(held, "the request is held with a visible reason");
});

test("a running background task offers its liveness policy and a wait can use it", async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: (body, index) => {
			if (index === 0)
				return assistantToolCalls({
					name: "multiloop_start",
					arguments: { lane: "sweep", runTag: "run", mode: "research", goal: "Watch liveness" },
				});
			if (index === 1)
				return assistantToolCalls({ name: "bg_task", arguments: { action: "spawn", command: "sleep 20" } });
			if (index === 2) {
				const dependency = waitDependencyFrom(body);
				assert.ok(dependency, "the task tool result carries wait evidence");
				assert.equal(dependency.health, "bg-process-alive-v1", "the result names the policy the model may request");
				return assistantToolCalls({
					name: "agent_wait",
					arguments: {
						work: dependency.work.id,
						reason: "the sweep must stay alive",
						deadline: "30m",
						// The policy the producer registers for a live process, requested by name.
						on: [
							{
								producer: dependency.producer,
								handle: dependency.handle,
								execution: dependency.execution,
								until: dependency.until,
								health: dependency.health,
							},
						],
					},
				});
			}
			return { text: `turn ${index}` };
		},
	});
	await f.session.prompt("start the sweep and watch it");

	const [wait] = (await f.ingress.branch().attachment.waits.snapshot()).filter((item) => item.state === "waiting");
	assert.ok(wait, "the monitored wait was accepted rather than refused");
	assert.equal(wait.on[0].health, "bg-process-alive-v1");
	// The producer reported liveness for the real spawned process alongside its predicates.
	const [execution] = (await f.ingress.branch().attachment.waits.authoritySnapshot()).executions;
	assert.equal(execution.healthEvidence?.policy, "bg-process-alive-v1");
	assert.equal(execution.healthEvidence?.state, "healthy");
	assert.match(execution.healthEvidence?.marker ?? "", /^[0-9]+$/, "the marker names the process it checked");
	assert.deepEqual(f.errors, []);
});

test("a policy the background producer does not register is refused", async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: (body, index) => {
			if (index === 0)
				return assistantToolCalls({
					name: "multiloop_start",
					arguments: { lane: "sweep", runTag: "run", mode: "research", goal: "Refuse an invented policy" },
				});
			if (index === 1)
				return assistantToolCalls({ name: "bg_task", arguments: { action: "spawn", command: "sleep 20" } });
			if (index === 2) {
				const dependency = waitDependencyFrom(body);
				return assistantToolCalls({
					name: "agent_wait",
					arguments: {
						work: dependency.work.id,
						reason: "invented policy",
						deadline: "30m",
						on: [
							{
								producer: dependency.producer,
								handle: dependency.handle,
								execution: dependency.execution,
								until: dependency.until,
								health: "sweep-progress-v1",
							},
						],
					},
				});
			}
			return { text: `turn ${index}` };
		},
	});
	await f.session.prompt("start the sweep and invent a policy");
	// The model cannot install liveness semantics by naming them; no wait is parked.
	assert.deepEqual(
		(await f.ingress.branch().attachment.waits.snapshot()).filter((item) => item.state === "waiting"),
		[],
	);
});
