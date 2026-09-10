import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { stream } from "@earendil-works/pi-ai/api/google-vertex";

import { model as baseModel } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { nativeRequests } from "./fixtures/native-requests.mjs";

// Mock the auth library resolved by the provider's SDK, including nested package installations.
const providerRequire = createRequire(import.meta.resolve("@earendil-works/pi-ai/api/google-vertex"));
const { GoogleAuth } = createRequire(providerRequire.resolve("@google/genai"))("google-auth-library");

const model = { ...baseModel, api: "google-vertex", provider: "google-vertex", id: "gemini-2.5-flash" };
for (const auth of ["key", "adc"])
	for (const cancel of [false, true])
		test(`Vertex ${auth} SDK admission ${cancel ? "cancels in flight" : "preserves input"}`, async (t) => {
			const controller = new AbortController();
			let authCalls = 0,
				sent = 0;
			t.mock.method(GoogleAuth.prototype, "getRequestHeaders", async () => {
				authCalls++;
				return new Headers({ Authorization: "Bearer fixture" });
			});
			t.mock.method(globalThis, "fetch", async (url, init) => {
				sent++;
				const headers = new Headers(init.headers);
				if (auth === "adc") {
					assert.match(String(url), /projects\/fixture-project\/locations\/us-central1/);
					assert.equal(headers.get("authorization"), "Bearer fixture");
				} else assert.equal(headers.get("x-goog-api-key"), "fixture");
				assert.equal(JSON.parse(init.body).contents[0].parts[0].text, "Hello");
				if (cancel)
					return new Promise((_resolve, reject) => {
						init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
						controller.abort(new DOMException("Stopped", "AbortError"));
					});
				return new Response(
					`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Done" }] }, finishReason: "STOP" }] })}\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			});
			const f = await nativeRequests(t, {
				model,
				retainInputs: true,
				enforceRequiredSources: true,
				native: (selected, context, options) =>
					stream(selected, context, {
						...options,
						apiKey: auth === "key" ? "fixture" : undefined,
						project: "fixture-project",
						location: "us-central1",
						env: {},
						signal: controller.signal,
						maxRetries: 0,
					}),
			});
			await f.session.prompt("Hello");
			assert.equal(sent, 1);
			assert.equal(authCalls, auth === "adc" ? 1 : 0);
			const [record] = await f.store.snapshot();
			assert.equal(record.outcome, cancel ? "aborted" : "success");
			assert.equal(record.payload.api, model.api);
			assert.equal(record.sourceCapture.model.members[0].status, "intact");
		});

test("Vertex credential failure cannot turn admission into successful delivery", async (t) => {
	let sent = 0;
	const auth = t.mock.method(GoogleAuth.prototype, "getRequestHeaders", async () => {
		throw new Error("fixture credentials unavailable");
	});
	t.mock.method(globalThis, "fetch", async () => {
		sent++;
		throw new Error("unexpected transport");
	});
	const f = await nativeRequests(t, {
		model,
		retainInputs: true,
		enforceRequiredSources: true,
		native: (selected, context, options) =>
			stream(selected, context, {
				...options,
				apiKey: undefined,
				project: "fixture-project",
				location: "us-central1",
				env: {},
				maxRetries: 0,
			}),
	});
	await f.session.prompt("Hello");
	assert.equal(sent, 0);
	assert.equal(auth.mock.callCount(), 1);
	assert.match(f.session.agent.state.messages.at(-1).errorMessage, /fixture credentials unavailable/);
	const [record] = await f.store.snapshot();
	assert.equal(record.outcome, "failure");
	assert.equal(record.sourceCapture.model.members[0].status, "intact");
});
