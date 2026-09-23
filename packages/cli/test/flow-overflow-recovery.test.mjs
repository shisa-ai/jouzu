import assert from "node:assert/strict";
import { test } from "node:test";
import { assembledSession, installedProducerExtensions, syntheticProducer } from "./fixtures/flow-assembly.mjs";

const overflow = {
	message:
		"This model's maximum context length is 262144 tokens. However, you requested 87591 output tokens and your prompt contains at least 174554 input tokens, for a total of at least 262145 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=174554)",
	type: "BadRequestError",
	param: "input_tokens",
	code: 400,
};

for (const keepTail of [false, true])
	test(`HTTP context overflow compacts and retries without holding later work: keepTail=${keepTail}`, {
		timeout: 20000,
	}, async (t) => {
		const compactions = [];
		const f = await assembledSession(t, {
			persist: true,
			settings: { compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 } },
			producerExtensions: [
				...(await installedProducerExtensions()),
				{
					name: "overflow-compaction",
					factory(pi) {
						pi.on("session_before_compact", (event) => {
							compactions.push({ reason: event.reason, willRetry: event.willRetry });
							const kept = event.branchEntries.findLast(
								(entry) => entry.type === "message" && entry.message.role === "user",
							);
							return {
								compaction: {
									summary: "Continue the interrupted fixture work.",
									firstKeptEntryId: keepTail ? kept.id : "",
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
					},
				},
			],
			script: [
				{ text: "Ready." },
				{ httpStatus: 400, httpBody: { error: overflow } },
				{ text: "Recovered after overflow." },
				{ text: "Later work finished." },
			],
		});
		await f.session.prompt("Establish earlier history.");
		await f.session.prompt("Continue fixture work after an injected overflow.");
		await f.session.waitForIdle();
		assert.deepEqual(compactions, [{ reason: "overflow", willRetry: true }]);
		assert.equal(f.bodies.length, 3, f.session.agent.state.errorMessage);
		assert.equal(f.session.agent.state.messages.at(-1).content[0].text, "Recovered after overflow.");
		assert.equal(f.ingress.automatedPause(), undefined);
		assert.equal(f.ingress.branch().attachment.nativeRequests.recoveryBlocked, false);
		assert.ok(JSON.stringify(f.bodies[2]).includes("Continue the interrupted fixture work."));
		assert.ok(!JSON.stringify(f.bodies[2]).includes(overflow.message));
		const producer = syntheticProducer();
		const registration = f.ingress.registerProducer(producer.producer);
		t.after(() => registration.dispose());
		producer.offer([{ id: "after-overflow", revision: "1" }]);
		await registration.changed();
		await f.session.waitForIdle();
		assert.equal(f.bodies.length, 4, "later automatic work must not require /flow clear or /flow reset");
		assert.ok(JSON.stringify(f.bodies[3]).includes("work after-overflow"));
		assert.equal(f.ingress.automatedPause(), undefined);
		assert.deepEqual(f.errors, []);
	});
