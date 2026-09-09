import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stream as streamGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";
import { convertMessages } from "@earendil-works/pi-ai/api/google-shared";
import { stream as streamVertex } from "@earendil-works/pi-ai/api/google-vertex";
import { assistant, model as baseModel } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { NativePayloadSources } from "../dist/flow-control/native-payload-sources.js";
import { copyFlowPayload } from "../dist/flow-control/payload-copy.js";
import { nativeRequests } from "./fixtures/native-requests.mjs";

for (const api of ["google-generative-ai", "google-vertex"])
	describe(api, () => {
		const stream = api === "google-vertex" ? streamVertex : streamGoogle;
		const model = {
			...baseModel,
			provider: api === "google-vertex" ? "google-vertex" : "google",
			api,
			id: "gemini-3.1-pro-preview",
		};
		const user = (content = "hello") => ({ role: "user", content, timestamp: 1 });
		const tool = (id, text = "resolved") => ({
			role: "toolResult",
			toolCallId: id,
			toolName: "agent_wait",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 1,
		});
		const calls = (...ids) => ({
			...assistant(),
			stopReason: "toolUse",
			content: ids.map((id) => ({ type: "toolCall", id, name: "agent_wait", arguments: {} })),
		});
		const image = { type: "image", mimeType: "image/png", data: "YWJj" };
		const response = () =>
			new Response(
				`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Done" }] }, finishReason: "STOP" }] })}\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		function fixture(messages, selected = model) {
			const members = messages.flatMap((message, index) => (message.role === "assistant" ? [] : [{ index }]));
			const capture = {
				members,
				model: { members: members.map(({ index }) => ({ sourceIndex: index, index, status: "intact" })) },
			};
			const sources = new NativePayloadSources(messages, capture, selected.api);
			const observed = [];
			const observe = (source, output) => {
				observed.push(source);
				sources.observe(source, output);
			};
			const payload = { contents: convertMessages(selected, { messages }, observe) };
			return {
				payload,
				capture,
				sources,
				observed,
				inspect: (value = payload) => sources.inspect(selected.api, value, copyFlowPayload(value, selected.api).owned),
			};
		}

		test("Google user receipts preserve equal-text identities, inline images, whitespace, and known copies", () => {
			const f = fixture([user(), user(), user([{ type: "text", text: "日本語\n " }, image])]);
			assert.deepEqual(
				f.inspect().map((r) => [r.sourceIndex, r.index, r.disposition]),
				[
					[0, 0, "included"],
					[1, 1, "included"],
					[2, 2, "included"],
				],
			);
			assert.deepEqual(f.inspect(copyFlowPayload(f.payload, model.api).owned), f.inspect());
		});

		for (const mode of ["text", "image", "thought", "mixed", "role", "clone", "duplicate", "omit"])
			test(`Google changed or unresolved user content: ${mode}`, () => {
				const f = fixture([user([{ type: "text", text: "hello" }, image])]);
				const row = f.payload.contents[0];
				if (mode === "text") row.parts[0].text = "other";
				if (mode === "image") row.parts[1].inlineData.data = "b3RoZXI=";
				if (mode === "thought") row.parts[0].thought = true;
				if (mode === "mixed") row.parts[0].functionResponse = { name: "agent_wait", response: { output: "hello" } };
				if (mode === "role") row.role = "model";
				if (mode === "clone") f.payload.contents[0] = structuredClone(row);
				if (mode === "duplicate") f.payload.contents.push(row);
				if (mode === "omit") f.payload.contents.pop();
				assert.equal(
					f.inspect()[0].disposition,
					["clone", "duplicate", "omit"].includes(mode) ? "unresolved" : "changed",
				);
			});

		for (const id of ["gemini-2.5-flash", model.id])
			test(`Google grouped tool blocks use source references with provider call IDs when present: ${id}`, () => {
				const one = tool("one$"),
					two = tool("two");
				const f = fixture([calls("one$", "two"), one, two], { ...model, id });
				assert.deepEqual(f.observed, [one, two]);
				assert.deepEqual(
					f.inspect().map((r) => [r.index, r.blockIndex, r.disposition]),
					[
						[1, 0, "included"],
						[1, 1, "included"],
					],
				);
				assert.equal(f.payload.contents[1].parts[0].functionResponse.id, id === model.id ? "one_" : undefined);
			});

		for (const mode of [
			"text",
			"name",
			"id",
			"error",
			"parent",
			"clone",
			"duplicate",
			"omit",
			"host-copy",
			"parts",
			"continuation",
		])
			test(`Google grouped tool receipt mutation: ${mode}`, () => {
				const f = fixture([calls("one", "two"), tool("one"), tool("two")]);
				let payload = f.payload;
				const row = payload.contents[1],
					block = row.parts[0],
					result = block.functionResponse;
				if (mode === "text") result.response.output = "other";
				if (mode === "parts") result.parts = "invalid";
				if (mode === "continuation") result.willContinue = true;
				if (mode === "name") result.name = "other";
				if (mode === "id") result.id = "other";
				if (mode === "error") result.response = { error: "resolved" };
				if (mode === "parent") row.role = "model";
				if (mode === "clone") row.parts[0] = structuredClone(block);
				if (mode === "duplicate") row.parts.push(block);
				if (mode === "omit") row.parts.shift();
				if (mode === "host-copy") payload = copyFlowPayload(payload, model.api).owned;
				assert.equal(
					f.inspect(payload)[0].disposition,
					mode === "host-copy" ? "included" : ["clone", "duplicate", "omit"].includes(mode) ? "unresolved" : "changed",
				);
				assert.equal(f.inspect(payload)[1].disposition, mode === "parent" ? "changed" : "included");
			});

		test("Google synthetic results, sanitization, and displaced tool images cannot prove exact source inclusion", () => {
			const owned = tool("one");
			owned.content.push(image);
			const f = fixture([calls("one", "orphan"), owned, user("bad\ud800"), user([])], {
				...model,
				id: "gemini-2.5-flash",
			});
			assert.deepEqual(f.observed, [owned, user("bad\ud800")]);
			assert.deepEqual(
				f.inspect().map((r) => r.disposition),
				["changed", "changed", "unresolved"],
			);
		});

		for (const id of ["gemini-2.5-flash", model.id])
			test(`Google SDK preserves qualified source positions and content on HTTP transport: ${id}`, async (t) => {
				const selected = { ...model, id };
				const messages = [
					user([{ type: "text", text: "日本語" }, image]),
					calls("one", "two"),
					tool("one"),
					tool("two"),
					user("next"),
				];
				const f = fixture(messages, selected);
				let final, sent;
				const actual = new NativePayloadSources(messages, f.capture, selected.api);
				t.mock.method(globalThis, "fetch", async (_url, init) => {
					sent = JSON.parse(init.body);
					return response();
				});
				const controller = new AbortController();
				const result = await stream(
					selected,
					{ messages },
					{
						apiKey: "fixture",
						signal: controller.signal,
						maxRetries: 0,
						onMessageConverted: (source, output) => actual.observe(source, output),
						onPayload(payload) {
							final = copyFlowPayload(payload, selected.api).owned;
							return final;
						},
					},
				).result();
				assert.equal(result.stopReason, "stop");
				assert.deepEqual(sent.contents, final.contents);
				assert.deepEqual(sent.contents, f.payload.contents);
				assert.deepEqual(actual.inspect(selected.api, final, sent), f.inspect());
				assert.ok(f.inspect().every((r) => r.disposition === "included"));
			});

		for (const mode of ["intact", "text", "omit", "clone", "extra-body"])
			test(`Google real session required source admission: ${mode}`, async (t) => {
				let sent = 0;
				t.mock.method(globalThis, "fetch", async () => {
					sent++;
					return response();
				});
				const f = await nativeRequests(t, {
					model,
					retainInputs: true,
					enforceRequiredSources: true,
					transform: ({ payload }) => {
						if (mode === "text") payload.contents[0].parts[0].text = "other";
						if (mode === "omit") payload.contents = [];
						if (mode === "extra-body") payload.config.httpOptions = { extraBody: { contents: [] } };
						if (mode === "clone") {
							const cloned = structuredClone(payload);
							cloned.config.abortSignal = payload.config.abortSignal;
							return cloned;
						}
					},
					native: (selected, context, options) =>
						stream(selected, context, { ...options, apiKey: "fixture", maxRetries: 0 }),
				});
				await f.session.prompt("hello");
				const [request] = await f.store.snapshot();
				assert.equal(sent, mode === "intact" ? 1 : 0);
				assert.equal(request.outcome, mode === "intact" ? "success" : "withheld");
				assert.equal(
					(request.payload ?? request.withheldPayload).sources[0].disposition,
					mode === "intact" ? "included" : mode === "text" ? "changed" : "unresolved",
				);
			});

		test("Google SDK late input override leaves source membership unresolved", async (t) => {
			const messages = [user()];
			const f = fixture(messages);
			const actual = new NativePayloadSources(messages, f.capture, model.api);
			let final, sent;
			t.mock.method(globalThis, "fetch", async (_url, init) => {
				sent = JSON.parse(init.body);
				return response();
			});
			const result = await stream(
				model,
				{ messages },
				{
					apiKey: "fixture",
					maxRetries: 0,
					onMessageConverted: (source, output) => actual.observe(source, output),
					onPayload(payload) {
						payload.config.httpOptions = {
							extraBody: { contents: [{ role: "user", parts: [{ text: "replacement" }] }] },
						};
						final = copyFlowPayload(payload, model.api).owned;
						return final;
					},
				},
			).result();
			assert.equal(result.stopReason, "stop");
			assert.equal(final.contents[0].parts[0].text, "hello");
			assert.equal(sent.contents[0].parts[0].text, "replacement");
			assert.equal(actual.inspect(model.api, final, sent)[0].disposition, "unresolved");
		});
	});
