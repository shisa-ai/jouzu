import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { model } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { FlowModelInput } from "../dist/flow-control/model-input.js";
import { createPiLedgerStore } from "../dist/flow-control/pi-ledger-store.js";
import { admitFlowPayload, openAIFlowPayload } from "../dist/flow-control/provider-payload.js";
import { FlowReceiptLedger } from "../dist/flow-control/receipt-ledger.js";

async function fixture(t) {
	const repo = new MemorySessionRepo();
	t.after(() => repo.close(context));
	const session = await repo.create({}, context);
	const ledger = await FlowReceiptLedger.attach(createPiLedgerStore(session), { sessionId: "test", branchId: "main" });
	const composition = FlowModelInput.compose(
		"attempt",
		[
			{
				id: "work",
				revision: "1",
				kind: "work",
				text: "Perform the next step",
				images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
			},
			{ id: "result", revision: "1", kind: "result", text: "Completed" },
		],
		4096,
	);
	await ledger.select("attempt", composition.members);
	await ledger.queued("attempt", { id: "queue", revision: 1 });
	await ledger.claim("attempt", { id: "queue", revision: 1 });
	await ledger.prepare(
		"attempt",
		"request",
		composition.inspect([{ role: "user", content: composition.content, timestamp: 1 }]),
		false,
	);
	return { ledger, composition };
}

for (const transform of [
	"unchanged",
	"optional-removed",
	"required-changed",
	"image-removed",
	"role-changed",
	"duplicate",
	"oversized",
]) {
	test(`Pi HTTP conversion admits only verified payload: ${transform}`, async (t) => {
		const { ledger, composition } = await fixture(t);
		const sent = [];
		let payload;
		const result = await stream(
			{ ...model, baseUrl: "https://fixture.invalid/v1" },
			{ messages: [{ role: "user", content: composition.content, timestamp: 1 }] },
			{
				apiKey: "fixture",
				maxRetries: 0,
				onPayload: async (converted) => {
					payload = converted;
					const user = payload.messages.find((message) => message.role === "user");
					if (transform === "optional-removed") user.content.pop();
					if (transform === "required-changed") user.content[0].text = user.content[0].text.replace("Perform", "Skip");
					if (transform === "image-removed") user.content.splice(1, 1);
					if (transform === "role-changed") user.role = "assistant";
					if (transform === "duplicate") payload.messages.push(structuredClone(user));
					const owned = await admitFlowPayload(
						ledger,
						composition,
						"request",
						"openai-completions",
						payload,
						openAIFlowPayload("openai-completions"),
						transform === "oversized" ? 1 : 100000,
					);
					await ledger.handoff("attempt", "request");
					// Mutating the extension-owned payload after admission cannot change transport bytes.
					user.content = [];
					return owned;
				},
				fetch: async (_url, init) => {
					sent.push(JSON.parse(init.body));
					return new Response(
						'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":null}]}\n\ndata: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				},
			},
		).result();
		const [attempt] = (await ledger.snapshot()).attempts;
		const request = attempt.requests[0];
		const allowed = ["unchanged", "optional-removed"].includes(transform);
		assert.equal(sent.length, allowed ? 1 : 0);
		assert.equal(request.handedOff, allowed);
		assert.equal(result.stopReason, allowed ? "stop" : "error");
		assert.equal(request.inclusion[0].disposition, "included");
		if (allowed) {
			assert.equal(request.payload.hash, createHash("sha256").update(JSON.stringify(sent[0])).digest("hex"));
			assert.equal(request.payload.bytes, Buffer.byteLength(JSON.stringify(sent[0])));
			assert.equal(request.payload.inclusion[1].disposition, transform === "optional-removed" ? "omitted" : "included");
		} else assert.equal(attempt.phase, "withheld");
	});
}

test("Responses projection checks image bytes and excludes assistant and metadata copies", async (t) => {
	const { ledger, composition } = await fixture(t);
	const content = composition.content.map((part) =>
		part.type === "text"
			? { type: "input_text", text: part.text }
			: { type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}` },
	);
	const payload = { input: [{ role: "user", content }], metadata: { copy: content } };
	await admitFlowPayload(
		ledger,
		composition,
		"request",
		"openai-responses",
		payload,
		openAIFlowPayload("openai-responses"),
		100000,
	);
	await assert.rejects(
		admitFlowPayload(
			ledger,
			composition,
			"request",
			"openai-responses",
			payload,
			openAIFlowPayload("openai-responses"),
			100000,
		),
		{ code: "identity" },
	);
	assert.equal(
		composition.inspect(
			openAIFlowPayload("openai-responses")({ ...payload, input: [{ role: "assistant", content }] }),
		)[0].disposition,
		"omitted",
	);
});

test("payload storage failure prevents Pi HTTP transmission", async (t) => {
	const { ledger, composition } = await fixture(t);
	let sent = 0;
	t.mock.method(ledger, "payload", async () => {
		throw new Error("storage unavailable");
	});
	const result = await stream(
		{ ...model, baseUrl: "https://fixture.invalid/v1" },
		{ messages: [{ role: "user", content: composition.content, timestamp: 1 }] },
		{
			apiKey: "fixture",
			maxRetries: 0,
			onPayload: (payload) =>
				admitFlowPayload(
					ledger,
					composition,
					"request",
					"openai-completions",
					payload,
					openAIFlowPayload("openai-completions"),
					100000,
				),
			fetch: async () => {
				sent++;
				throw new Error("unexpected transport");
			},
		},
	).result();
	assert.equal(sent, 0);
	assert.equal(result.stopReason, "error");
	assert.equal((await ledger.snapshot()).attempts[0].requests[0].payload, undefined);
});

for (const api of ["openai-completions", "openai-responses"]) {
	test(`${api} payload filtering cannot remove or rebind tool results`, async (t) => {
		const { composition } = await fixture(t);
		const user = {
			role: "user",
			content: composition.content.map((part) =>
				part.type === "text"
					? { type: api === "openai-completions" ? "text" : "input_text", text: part.text }
					: api === "openai-completions"
						? { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } }
						: { type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}` },
			),
		};
		const call =
			api === "openai-completions"
				? {
						role: "assistant",
						content: null,
						tool_calls: [{ id: "call", type: "function", function: { name: "read", arguments: "{}" } }],
					}
				: { type: "function_call", call_id: "call", name: "read", arguments: "{}" };
		const output =
			api === "openai-completions"
				? { role: "tool", tool_call_id: "call", content: "done" }
				: { type: "function_call_output", call_id: "call", output: "done" };
		const project = (items) => openAIFlowPayload(api)({ [api === "openai-completions" ? "messages" : "input"]: items });
		assert.equal(composition.inspect(project([call, output, user]))[0].disposition, "included");
		assert.throws(() => project([call, user]), { code: "schema" });
		assert.throws(() => project([call, { ...output, tool_call_id: "wrong", call_id: "wrong" }, user]), {
			code: "schema",
		});
		assert.throws(() => project([call, output, output, user]), { code: "schema" });
	});
}

test("cancellation during payload inspection cannot acquire a handoff", async (t) => {
	const { ledger, composition } = await fixture(t);
	const payload = { messages: [{ role: "user", content: composition.content.filter((part) => part.type === "text") }] };
	await ledger.cancel("attempt", "User preempted request.");
	await assert.rejects(
		admitFlowPayload(
			ledger,
			composition,
			"request",
			"openai-completions",
			payload,
			openAIFlowPayload("openai-completions"),
			100000,
		),
		{ code: "transition" },
	);
	assert.equal((await ledger.snapshot()).attempts[0].requests[0].payload, undefined);
});
