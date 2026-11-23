import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createQualifiedFlowSession } from "./fixtures/pi-flow-session.mjs";

const jittered = (ms) => [Math.round(ms * 0.75), Math.round(ms * 1.25)];

test("Jouzu's default retry policy keeps the agent working through transient failures", () => {
	const settings = SettingsManager.inMemory().getRetrySettings();
	assert.deepEqual(settings, {
		enabled: true,
		maxRetries: 50,
		baseDelayMs: 1000,
		maxAgentDelayMs: 480000,
	});
});

test("agent-turn retries use a quick first three attempts and a jittered ramp", async (t) => {
	const events = [];
	let failures = 0;
	const { session } = await createQualifiedFlowSession(t, {
		settings: { retry: { enabled: true, maxRetries: 4, baseDelayMs: 4, maxAgentDelayMs: 1000 } },
		script: (_body, index) => {
			if (index < 4) {
				failures++;
				return { httpStatus: 503 };
			}
			return { text: "recovered" };
		},
	});
	session.subscribe((event) => {
		if (event.type === "auto_retry_start") events.push(event);
	});

	await session.prompt("retry through the outage");

	assert.equal(failures, 4, "the fixture failed four times");
	assert.deepEqual(
		events.map((event) => event.attempt),
		[1, 2, 3, 4],
	);
	assert.deepEqual(
		events.map((event) => event.maxAttempts),
		[4, 4, 4, 4],
	);
	for (const [index, scheduled] of [4, 8, 16, 60].entries()) {
		const [low, high] = jittered(scheduled);
		const delay = events[index].delayMs;
		assert.ok(delay >= low && delay <= high, `attempt ${index + 1} delay ${delay}ms is outside ${low}-${high}ms`);
	}
	assert.equal(session.messages.at(-1).content[0].text, "recovered");
});

test("a quota failure is not retried as a transient limit", async (t) => {
	const events = [];
	const { session, bodies } = await createQualifiedFlowSession(t, {
		settings: { retry: { enabled: true, maxRetries: 4, baseDelayMs: 1, maxAgentDelayMs: 10 } },
		script: () => ({
			httpStatus: 429,
			httpBody: { error: { code: "insufficient_quota", message: "quota exceeded" } },
		}),
	});
	session.subscribe((event) => {
		if (event.type === "auto_retry_start") events.push(event);
	});

	await session.prompt("quota failure");

	assert.equal(bodies.length, 1, "the quota failure is sent once");
	assert.equal(events.length, 0, "no retry is scheduled");
	assert.equal(session.messages.at(-1).stopReason, "error");
});

test("compaction keeps a short retry budget while the agent-turn budget is long", async (t) => {
	const events = [];
	let summaryFailures = 0;
	const { session } = await createQualifiedFlowSession(t, {
		settings: {
			retry: { enabled: true, maxRetries: 50, baseDelayMs: 1, maxAgentDelayMs: 10 },
			compaction: { enabled: false, keepRecentTokens: 1 },
		},
		script: (_body, index) => {
			if (index < 2) return { text: `turn ${index}` };
			if (summaryFailures < 3) {
				summaryFailures++;
				return { httpStatus: 503 };
			}
			return { text: "summary" };
		},
	});
	session.subscribe((event) => {
		if (event.type === "summarization_retry_scheduled") events.push(event);
	});

	await session.prompt("first");
	await session.prompt("second");
	const result = await session.compact();

	assert.equal(summaryFailures, 3, "the summary failed three times");
	assert.deepEqual(
		events.map((event) => event.attempt),
		[1, 2, 3],
	);
	assert.deepEqual(
		events.map((event) => event.maxAttempts),
		[3, 3, 3],
	);
	assert.match(result.summary, /^summary/u);
});
