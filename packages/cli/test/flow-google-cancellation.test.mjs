import assert from "node:assert/strict";
import { test } from "node:test";
import { stream } from "@earendil-works/pi-ai/api/google-generative-ai";
import { model as fixtureModel } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { copyFlowPayload } from "../dist/flow-control/payload-copy.js";
import { nativeRequests } from "./fixtures/native-requests.mjs";

for (const api of ["google-generative-ai", "google-vertex"])
	test(`${api} payload copies retain live cancellation and isolate request data`, () => {
		const controller = new AbortController();
		const payload = {
			model: "gemini-2.5-flash",
			contents: [{ role: "user", parts: [{ text: "Hello" }] }],
			config: { abortSignal: controller.signal, temperature: 0 },
		};
		const first = copyFlowPayload(payload, api);
		const second = copyFlowPayload(first.owned, api);
		assert.equal(first.serialized, second.serialized);
		assert.equal(JSON.parse(first.serialized).config.abortSignal, undefined);
		assert.equal(second.owned.config.abortSignal, controller.signal);
		second.owned.contents[0].parts[0].text = "Changed";
		assert.equal(payload.contents[0].parts[0].text, "Hello");
		assert.equal(first.owned.contents[0].parts[0].text, "Hello");
		controller.abort("stop");
		assert.equal(second.owned.config.abortSignal.aborted, true);
		assert.equal(second.owned.config.abortSignal.reason, "stop");
	});

test("Google cancellation rejects fake signals and transforming parameter objects", () => {
	for (const abortSignal of [{}, Object.create(AbortSignal.prototype), new Proxy(new AbortController().signal, {})])
		assert.throws(() => copyFlowPayload({ config: { abortSignal } }, "google-generative-ai"), /cancellation signal/);
	assert.throws(
		() =>
			copyFlowPayload({ config: { abortSignal: new AbortController().signal }, toJSON: () => ({}) }, "google-vertex"),
		/unsupported runtime values/,
	);
});

for (const cancel of [false, true])
	test(`Google SDK transport through native admission ${cancel ? "receives cancellation" : "completes"}`, async (t) => {
		const model = { ...fixtureModel, api: "google-generative-ai", provider: "google", id: "gemini-2.5-flash" };
		const controller = new AbortController();
		let sent = 0;
		t.mock.method(globalThis, "fetch", async (_url, init) => {
			sent++;
			const body = JSON.parse(init.body);
			assert.equal(body.contents[0].parts[0].text, "Hello");
			assert.equal(body.abortSignal, undefined);
			assert.equal(typeof init.signal.addEventListener, "function");
			if (cancel) {
				return new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
					controller.abort(new DOMException("Stopped", "AbortError"));
				});
			}
			return new Response(
				`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Done" }] }, finishReason: "STOP" }] })}\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		});
		const f = await nativeRequests(t, {
			model,
			native: (selected, context, options) =>
				stream(selected, context, { ...options, apiKey: "fixture", signal: controller.signal, maxRetries: 0 }),
		});
		await f.session.prompt("Hello");
		assert.equal(sent, 1);
		assert.equal((await f.store.snapshot())[0].outcome, cancel ? "aborted" : "success");
	});
