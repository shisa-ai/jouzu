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

test("wait resolution and the lane continuation compose one logical wake", {
	todo: "the resolved wait and the multiloop continuation currently dispatch as two requests",
}, async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(t),
		script: blockedLaneScript([]),
	});
	await f.session.prompt("start the sweep and wait for it");
	const blocked = f.bodies.length;
	await idle(1800);
	assert.equal(f.bodies.length - blocked, 1, "one composed wake carries both the decision and the continuation");
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
