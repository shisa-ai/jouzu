import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assembledSession, installedProducerExtensions } from "./fixtures/flow-assembly.mjs";

test("continuous tools cross native byte and record quotas after compaction without waiting for idle", {
	timeout: 120000,
}, async (t) => {
	const turns = 1120;
	let tools = 0;
	let compactions = 0;
	let endings = 0;
	let peak = 0;
	const observed = new Map();
	const producers = await installedProducerExtensions();
	const f = await assembledSession(t, {
		persist: true,
		settings: { compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 7505 } },
		producerExtensions: [
			...producers,
			{
				name: "tool-retention",
				factory(pi) {
					pi.registerTool({
						name: "step",
						label: "Step",
						description: "Return fixture data.",
						parameters: { type: "object", properties: {} },
						async execute() {
							tools++;
							const records = await f.ingress.branch().attachment.nativeRequests.snapshot();
							peak = Math.max(peak, records.length);
							for (const record of records) observed.set(record.id, record);
							return {
								content: [{ type: "text", text: tools % 20 === 1 ? "data ".repeat(6000) : "done" }],
								details: {},
							};
						},
					});
					pi.on("agent_end", () => {
						endings++;
					});
					pi.on("session_before_compact", (event) => {
						compactions++;
						return {
							compaction: {
								summary: "Continue the tool sequence.",
								firstKeptEntryId: "",
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			},
		],
		script: (_body, index) =>
			index < turns ? { toolCalls: [{ id: `step-${index}`, name: "step", arguments: {} }] } : { text: "Finished." },
	});
	await f.session.prompt("Run the tool sequence.");
	await f.session.waitForIdle();
	assert.equal(f.bodies.length, turns + 1, f.session.agent.state.errorMessage);
	assert.equal(tools, turns);
	assert.equal(endings, 1, "there was no idle turn boundary during the tool sequence");
	assert.ok(compactions > 1);
	const empty = [...observed.values()].filter(
		(r) => !r.sourceCapture?.members.length && !r.projectionCapture?.members.length,
	);
	assert.ok(empty.length > 1024, `crossed record quota: ${empty.length}`);
	assert.ok(Buffer.byteLength(JSON.stringify(empty)) > 1024 * 1024, "crossed the actual byte quota");
	assert.ok(peak <= 70, `request history is bounded before idle cleanup: ${peak}`);
	assert.equal(f.ingress.automatedPause(), undefined);
	assert.deepEqual(f.errors, []);
	const history = f.sessionManager.getSessionFile();
	await f.shutdown("resume", history);
	const reopened = await assembledSession(t, {
		root: f.root,
		persist: true,
		producerExtensions: producers,
		sessionManager: SessionManager.open(history),
	});
	await reopened.session.prompt("Continue after the tool sequence.");
	assert.equal(reopened.bodies.length, 1, reopened.session.agent.state.errorMessage);
	assert.deepEqual(reopened.errors, []);
});
