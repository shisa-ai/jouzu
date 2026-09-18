import assert from "node:assert/strict";
import { test } from "node:test";
import { registerCompactionRequest } from "../dist/compaction-request.js";
import { assembledSession, installedProducerExtensions, syntheticProducer } from "./fixtures/flow-assembly.mjs";

for (const keepTail of [true, false])
	for (const repairLegacyFailure of [false, true])
		test(`mid-run compaction continues without replay: repairLegacyFailure=${repairLegacyFailure}, keepTail=${keepTail}`, {
			timeout: 20000,
		}, async (t) => {
			let compactions = 0;
			const f = await assembledSession(t, {
				persist: true,
				settings: { compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 7505 } },
				producerExtensions: [
					...(await installedProducerExtensions()),
					{
						name: "split-turn-compaction",
						factory(pi) {
							pi.registerTool({
								name: "large_result",
								label: "Large result",
								description: "Return fixture data.",
								parameters: { type: "object", properties: {} },
								async execute() {
									return { content: [{ type: "text", text: "data ".repeat(6000) }], details: {} };
								},
							});
							pi.on("session_before_compact", (event) => {
								compactions++;
								const firstKept = event.branchEntries.findLast(
									(entry) => entry.type === "message" && entry.message.role === "assistant",
								);
								return {
									compaction: {
										summary: "Continue fixture work after the completed tool.",
										firstKeptEntryId: keepTail ? firstKept.id : "",
										tokensBefore: event.preparation.tokensBefore,
									},
								};
							});
						},
					},
				],
				script: [
					{ text: "Ready." },
					{ toolCalls: [{ name: "large_result", arguments: {} }] },
					{ toolCalls: [{ name: "large_result", arguments: {} }] },
					{ text: "Finished after two compactions." },
				],
			});
			await f.session.prompt("Run the fixture work.");
			const producer = syntheticProducer();
			const registration = f.ingress.registerProducer(producer.producer);
			t.after(() => registration.dispose());
			producer.offer([{ id: "compact-work", revision: "1" }]);
			const ledger = f.ingress.branch().attachment.ledger;
			const prepare = ledger.prepare.bind(ledger);
			if (repairLegacyFailure) t.mock.method(ledger, "prepare", (...args) => prepare(...args.slice(0, 4)));
			await registration.changed();
			await f.session.waitForIdle();
			if (repairLegacyFailure) {
				assert.equal(f.bodies.length, 2);
				assert.match(f.session.agent.state.errorMessage, /Composed model input was withheld after transformation/);
				assert.ok(f.ingress.automatedPause());
				ledger.prepare.mock.restore();
				await f.session.prompt("/flow clear");
				assert.equal(f.bodies.length, 2, "reset does not replay requests");
				await f.session.prompt("/flow resume");
				producer.offer([{ id: "compact-work", revision: "2" }]);
				await registration.changed();
				await f.session.waitForIdle();
			}
			assert.equal(f.bodies.length, 4, f.session.agent.state.errorMessage);
			assert.ok(compactions >= 2);
			assert.ok(JSON.stringify(f.bodies[1]).includes("work compact-work"));
			assert.ok(!JSON.stringify(f.bodies[3]).includes("work compact-work"));
			assert.equal(f.ingress.automatedPause(), undefined);
			const attempts = (await ledger.snapshot()).attempts;
			assert.equal(attempts.length, repairLegacyFailure ? 2 : 1);
			const completed = attempts.at(-1);
			assert.equal(completed.outcome, "success");
			assert.equal(completed.requests.length, repairLegacyFailure ? 2 : 3);
			assert.deepEqual(
				completed.requests.map((r) => r.inclusion[0].disposition),
				repairLegacyFailure ? ["included", "omitted"] : ["included", "omitted", "omitted"],
			);
			assert.ok(completed.requests.every((r) => r.handedOff && r.outcome === "success"));
			assert.deepEqual(f.errors, []);
		});

test("requested compaction admits its continuation through the installed flow assembly", {
	timeout: 20000,
}, async (t) => {
	let compactions = 0;
	const f = await assembledSession(t, {
		persist: true,
		settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
		producerExtensions: [
			...(await installedProducerExtensions()),
			{
				name: "requested-compaction",
				factory(pi) {
					registerCompactionRequest(pi);
					pi.on("session_before_compact", (event) => {
						compactions++;
						return {
							compaction: {
								summary: "Continue the current work.",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			},
		],
		script: [
			{ toolCalls: [{ name: "compact_context", arguments: {} }] },
			{ text: "Continuing after compaction." },
			{ text: "Resumed." },
		],
	});
	await f.session.prompt("Do the work, compact, and continue.");
	const deadline = Date.now() + 5000;
	while (f.bodies.length < 3 && !f.ingress.automatedPause() && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, 20));
	await f.session.waitForIdle();
	assert.equal(compactions, 1);
	assert.equal(f.bodies.length, 3, f.session.agent.state.errorMessage);
	assert.ok(JSON.stringify(f.bodies[2].messages).includes("Continue the current work from the compaction summary."));
	const receipts = await f.ingress.branch().attachment.nativeRequests.snapshot();
	assert.ok(receipts.some((record) => record.requiredSources?.length && record.outcome === "success"));
	assert.equal(f.ingress.automatedPause(), undefined);
	assert.equal(f.ingress.branch().attachment.nativeRequests.recoveryBlocked, false);
	assert.deepEqual(f.errors, []);
});
