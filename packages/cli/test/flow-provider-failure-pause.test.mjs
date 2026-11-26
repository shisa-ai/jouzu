import assert from "node:assert/strict";
import { test } from "node:test";
import { assistant, deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { isProviderPause, providerPause } from "../dist/flow-control/flow-pause.js";
import {
	assembledSession,
	capturedNotices,
	installedProducerExtensions,
	syntheticProducer,
} from "./fixtures/flow-assembly.mjs";
import { nativeRequests } from "./fixtures/native-requests.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const rejection = () => ({ httpStatus: 403, httpBody: { error: { message: "403 terminated" } } });
const truncated = () => ({ text: "", finishReason: "length" });

for (const recovers of [false, true])
	test(`a truncated response pauses only if compact-and-retry fails: recovers=${recovers}`, async (t) => {
		const f = await assembledSession(t, {
			persist: true,
			settings: { compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 } },
			producerExtensions: await installedProducerExtensions(),
			script: [
				{ text: "Earlier successful response" },
				truncated(),
				{ text: "Summary of earlier work" },
				{ text: "Summary of the current turn" },
				recovers ? { text: "Recovered" } : truncated(),
			],
		});
		const notices = capturedNotices(f.session);
		await f.session.setModel({ ...f.session.model, contextWindow: 262144 });
		await f.session.prompt("Establish earlier history");
		await f.session.prompt("Continue the work");
		await f.session.waitForIdle();
		assert.equal(
			f.bodies.length,
			5,
			"one truncation, two summaries for the split turn, and one retry after the earlier turn",
		);
		assert.equal(f.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
		assert.equal(isProviderPause(f.ingress.automatedPause() ?? ""), !recovers);
		assert.equal(notices.filter((notice) => notice.text.includes("Flow control paused")).length, recovers ? 0 : 1);
		if (!recovers) assert.match(f.ingress.automatedPause(), /response was truncated/i);

		const producer = syntheticProducer();
		const registration = f.ingress.registerProducer(producer.producer);
		t.after(() => registration.dispose());
		producer.offer([{ id: "after-truncation-recovery", revision: "1" }]);
		await registration.changed();
		await f.session.waitForIdle();
		assert.equal(f.bodies.length, recovers ? 6 : 5, "only a successful recovery permits automatic continuation");
		assert.deepEqual(f.errors, []);
	});

test("a provider failure that ends a turn holds automated work and reports why", async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: rejection,
	});
	const notices = capturedNotices(f.session);
	await f.session.prompt("Do the work");
	await settle();
	// The fixture disables retries, so the turn stops after the one request it made.
	assert.equal(f.bodies.length, 1);
	const pause = f.ingress.automatedPause();
	assert.ok(isProviderPause(pause ?? ""), `expected a provider pause, got ${pause}`);
	assert.match(pause, /403 terminated/);
	const reported = notices.filter((notice) => notice.text.includes("Flow control paused"));
	assert.equal(reported.length, 1, JSON.stringify(notices));
	assert.match(reported[0].text, /403 terminated/);
	assert.match(reported[0].text, /\/flow for details/);

	notices.length = 0;
	await f.session.prompt("/flow");
	await settle();
	const listed = notices.map((notice) => notice.text).join("\n");
	assert.match(listed, /Paused: a provider request failed/);
	assert.match(listed, /403 terminated/);
	assert.match(listed, /\/flow resume/);
	assert.doesNotMatch(listed, /\/flow clear/, "a provider rejection is not repaired by releasing a reservation");
});

for (const [code, attempts] of [
	["free_allowance_exhausted", 1],
	["backend_at_capacity", 3],
])
	test(`structured ${code} reaches flow failure reporting with the agent retry budget`, async (t) => {
		const f = await assembledSession(t, {
			producerExtensions: await installedProducerExtensions(),
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 0, maxAgentDelayMs: 0 } },
			script: () => ({
				httpStatus: 429,
				httpBody: { error: { code, type: code, message: "Service action needed.\u001b\u202e\r\nTry later." } },
			}),
		});
		const notices = capturedNotices(f.session);
		await f.session.prompt("Do the work");
		await f.session.waitForIdle();
		assert.equal(f.bodies.length, attempts);
		assert.ok(isProviderPause(f.ingress.automatedPause() ?? ""));
		assert.ok(f.ingress.automatedPause().includes(`429: Service action needed. Try later. (${code})`));
		assert.doesNotMatch(f.ingress.automatedPause(), /\u202e|"type":/);
		assert.equal(f.ingress.automatedPause().includes("\u001b"), false);
		assert.equal(notices.filter((notice) => notice.text.includes("Flow control paused")).length, 1);
	});

test("a provider failure that survives the host's retries is one stop, reported once", async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 0, maxAgentDelayMs: 0 } },
		script: rejection,
	});
	const notices = capturedNotices(f.session);
	await f.session.prompt("Do the work");
	await settle();
	assert.equal(f.bodies.length, 4, "one attempt plus three retries");
	assert.ok(isProviderPause(f.ingress.automatedPause() ?? ""));
	assert.equal(
		notices.filter((notice) => notice.text.includes("Flow control paused")).length,
		1,
		"four failed attempts are one stopped turn",
	);
});

test("a turn that succeeds raises no provider pause", async (t) => {
	const f = await assembledSession(t, { producerExtensions: await installedProducerExtensions() });
	const notices = capturedNotices(f.session);
	await f.session.prompt("Do the work");
	await settle();
	assert.equal(f.bodies.length, 1);
	assert.equal(f.ingress.automatedPause(), undefined);
	assert.ok(!notices.some((notice) => notice.text.includes("Flow control paused")));
});

test("a failure the host retries and recovers from raises no provider pause", async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 0, maxAgentDelayMs: 0 } },
		script: (_body, index) => (index === 0 ? { httpStatus: 503 } : { text: "Recovered" }),
	});
	await f.session.prompt("Do the work");
	await settle();
	assert.equal(f.bodies.length, 2, "the retry ran and the second request succeeded");
	assert.equal(f.ingress.automatedPause(), undefined, "a turn the host repaired must not hold automated work");
});

test("a failed overflow compaction still pauses after the error leaves projected history", async (t) => {
	const failures = [];
	const f = await assembledSession(t, {
		persist: true,
		settings: { compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 } },
		producerExtensions: await installedProducerExtensions(),
		script: [
			{ text: "Earlier successful response" },
			{
				httpStatus: 400,
				httpBody: {
					error: {
						message:
							"This model's maximum context length is 262144 tokens. However, you requested 87591 output tokens and your prompt contains at least 174554 input tokens, for a total of at least 262145 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=174554)",
						type: "BadRequestError",
						code: 400,
					},
				},
			},
			rejection(),
		],
	});
	const notices = capturedNotices(f.session);
	const unsubscribe = f.session.subscribe((event) => {
		if (event.type === "compaction_end" && event.errorMessage) failures.push(event.errorMessage);
	});
	t.after(unsubscribe);
	await f.session.setModel({ ...f.session.model, contextWindow: 262144 });
	await f.session.prompt("Establish earlier history");
	await f.session.prompt("Continue after overflow");
	await f.session.waitForIdle();
	assert.equal(f.bodies.length, 3, "the provider error is followed by one failed summary request");
	assert.equal(failures.length, 1);
	assert.ok(
		!f.session.agent.state.messages.some((message) => message.role === "assistant" && message.stopReason === "error"),
	);
	assert.ok(isProviderPause(f.ingress.automatedPause() ?? ""));
	assert.match(f.ingress.automatedPause(), /maximum context length/);
	assert.equal(notices.filter((notice) => notice.text.includes("Flow control paused")).length, 1);

	const producer = syntheticProducer();
	const registration = f.ingress.registerProducer(producer.producer);
	t.after(() => registration.dispose());
	producer.offer([{ id: "after-failed-recovery", revision: "1" }]);
	await registration.changed();
	assert.equal(f.bodies.length, 3, "failed context recovery must not admit another automatic request");
	assert.deepEqual(f.errors, []);
});

test("one settled turn reports its provider failure once, and a later success reports nothing", async (t) => {
	const reported = [];
	let fail = true;
	const f = await nativeRequests(t, {
		turn: { aborted() {}, providerFailed: (detail) => reported.push(detail) },
		native: async (model, context, options) => {
			await options.onPayload({ messages: context.messages }, model);
			return {
				async *[Symbol.asyncIterator]() {},
				result: async () =>
					fail ? { ...assistant(), stopReason: "error", errorMessage: "403 terminated" } : assistant(),
			};
		},
	});
	await f.session.prompt("First");
	assert.deepEqual(reported, ["403 terminated"]);
	// Settlement consumes the observed outcome, so an unchanged transcript cannot report it twice.
	f.bridge.observeTurn({ type: "agent_settled", aborted: false });
	assert.deepEqual(reported, ["403 terminated"]);
	fail = false;
	await f.session.prompt("Second");
	assert.deepEqual(reported, ["403 terminated"], "a successful turn replaces the failing message");
	fail = true;
	await f.session.prompt("Third");
	assert.deepEqual(reported, ["403 terminated", "403 terminated"], "a new failure is reported even with the same text");
});

test("a settled event does not treat restored error history as a new provider failure", async (t) => {
	const reported = [];
	const f = await nativeRequests(t, {
		turn: { aborted() {}, providerFailed: (detail) => reported.push(detail) },
	});
	f.session.agent.state.messages = [{ ...assistant(), stopReason: "error", errorMessage: "Historical failure" }];
	f.bridge.observeTurn({ type: "agent_start" });
	f.bridge.observeTurn({ type: "agent_settled", aborted: false });
	assert.deepEqual(reported, []);
});

for (const initiallyOff of [true, false])
	test(`a provider failure while flow is off leaves no pause after enabling it: initiallyOff=${initiallyOff}`, async (t) => {
		const entered = deferred();
		const release = deferred();
		const f = await assembledSession(t, {
			producerExtensions: await installedProducerExtensions(),
			script: async (_body, index) => {
				if (index > 0) return { text: "Automatic work resumed" };
				entered.resolve();
				await release.promise;
				return rejection();
			},
		});
		const notices = capturedNotices(f.session);
		if (initiallyOff) await f.session.prompt("/flow off");
		const prompted = f.session.prompt("Do the work");
		await entered.promise;
		try {
			if (!initiallyOff) await f.session.prompt("/flow off");
		} finally {
			release.resolve();
		}
		await prompted;
		await f.session.waitForIdle();
		assert.equal(f.ingress.automatedPause(), undefined);
		assert.ok(!notices.some((notice) => notice.text.includes("Flow control paused")));
		await f.session.prompt("/flow on");
		assert.equal(f.ingress.automatedPause(), undefined);

		const producer = syntheticProducer();
		const registration = f.ingress.registerProducer(producer.producer);
		t.after(() => registration.dispose());
		producer.offer([{ id: "after-disabled-failure", revision: "1" }]);
		await registration.changed();
		await f.session.waitForIdle();
		assert.equal(f.bodies.length, 2, "enabling flow must not leave automatic work silently held");
		assert.deepEqual(f.errors, []);
	});

for (const [failure, reply] of [
	["error", rejection],
	["length", truncated],
])
	for (const resume of ["command", "user"])
		test(`a provider ${failure} pause holds later work until resumed by ${resume}`, async (t) => {
			const f = await assembledSession(t, {
				producerExtensions: await installedProducerExtensions(),
				script: (_body, index) => (index === 0 ? reply() : { text: "Recovered" }),
			});
			const notices = capturedNotices(f.session);
			const producer = syntheticProducer();
			const registration = f.ingress.registerProducer(producer.producer);
			t.after(() => registration.dispose());
			producer.offer([{ id: "failed-work", revision: "1" }]);
			await registration.changed();
			await f.session.waitForIdle();
			assert.ok(isProviderPause(f.ingress.automatedPause() ?? ""));
			producer.offer([{ id: "later-work", revision: "1" }]);
			await registration.changed();
			assert.equal(f.bodies.length, 1, "later work stays held after the failed automatic request");
			await f.session.prompt("/flow");
			assert.equal(f.bodies.length, 1, "inspection does not release the pause");

			await f.session.prompt(resume === "command" ? "/flow resume" : "Continue after repairing the provider");
			await registration.changed();
			await f.session.waitForIdle();
			assert.equal(f.ingress.automatedPause(), undefined);
			assert.equal(f.bodies.length, resume === "command" ? 2 : 3);
			assert.ok(JSON.stringify(f.bodies.at(-1)).includes("work later-work"));
			assert.equal(notices.filter((notice) => notice.text.includes("Flow control paused")).length, 1);
			assert.deepEqual(f.errors, []);
		});

test("a provider failure does not replace an explicit pause", async (t) => {
	const entered = deferred();
	const release = deferred();
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: async () => {
			entered.resolve();
			await release.promise;
			return rejection();
		},
	});
	const notices = capturedNotices(f.session);
	const prompted = f.session.prompt("Do the work");
	await entered.promise;
	try {
		await f.session.prompt("/flow pause");
	} finally {
		release.resolve();
	}
	await prompted;
	assert.equal(f.ingress.automatedPause(), "held from /flow");
	assert.ok(!notices.some((notice) => notice.text.includes("a provider request failed")));
	assert.deepEqual(f.errors, []);
});

test("a provider pause reason is bounded and carries no credential", () => {
	assert.equal(providerPause(""), "a provider request failed");
	const reason = providerPause(`401 unauthorized api_key=super-secret ${"x".repeat(4000)}`);
	assert.ok(isProviderPause(reason));
	assert.doesNotMatch(reason, /super-secret/);
	assert.ok(reason.length <= 160, `reason is ${reason.length} characters`);
});
