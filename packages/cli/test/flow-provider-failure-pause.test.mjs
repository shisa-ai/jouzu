import assert from "node:assert/strict";
import { test } from "node:test";
import { assistant } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { isProviderPause, providerPause } from "../dist/flow-control/flow-pause.js";
import { assembledSession, capturedNotices, installedProducerExtensions } from "./fixtures/flow-assembly.mjs";
import { nativeRequests } from "./fixtures/native-requests.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const rejection = () => ({ httpStatus: 403, httpBody: { error: { message: "403 terminated" } } });

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
	// A host can settle again over an unchanged transcript. The failing message is the identity the
	// observer records, so the same stop cannot be reported twice.
	f.bridge.observeSettled({ type: "agent_settled" });
	assert.deepEqual(reported, ["403 terminated"]);
	fail = false;
	await f.session.prompt("Second");
	assert.deepEqual(reported, ["403 terminated"], "a successful turn replaces the failing message");
});

test("a provider pause reason is bounded and carries no credential", () => {
	assert.equal(providerPause(""), "a provider request failed");
	const reason = providerPause(`401 unauthorized api_key=super-secret ${"x".repeat(4000)}`);
	assert.ok(isProviderPause(reason));
	assert.doesNotMatch(reason, /super-secret/);
	assert.ok(reason.length <= 160, `reason is ${reason.length} characters`);
});
