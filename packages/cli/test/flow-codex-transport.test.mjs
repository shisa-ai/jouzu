import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { assistant, model as baseModel } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { NativePayloadSources } from "../dist/flow-control/native-payload-sources.js";
import { copyFlowPayload } from "../dist/flow-control/payload-copy.js";
import { openAIFlowPayload } from "../dist/flow-control/provider-payload.js";
import { codexTransport } from "./fixtures/codex-transport.mjs";
import { nativeRequests } from "./fixtures/native-requests.mjs";

const model = {
	...baseModel,
	api: "openai-codex-responses",
	provider: "openai-codex",
	id: "gpt-5.4",
	baseUrl: "https://fixture.invalid",
};

for (const transport of ["sse", "websocket", "websocket-cached", "auto"])
	test(`Codex ${transport} native receipts preserve admitted effective input`, async (t) => {
		const server = codexTransport(t, { transport });
		const f = await nativeRequests(t, {
			model,
			native: server.stream,
			retainInputs: true,
			enforceRequiredSources: true,
		});
		await f.session.prompt("first");
		await f.session.prompt("second");
		const records = await f.store.snapshot();
		assert.equal(records.length, 2);
		assert.ok(records.every((r) => r.outcome === "success" && r.payload.api === model.api));
		assert.equal(server.requests.length, 2);
		assert.equal(server.requests[1].input.filter((row) => row.role === "user").length, 2);
		for (const [offset, request] of records.entries()) {
			for (const source of request.payload.sources) {
				assert.equal(source.disposition, "included");
				const row = server.requests[offset].input[source.index];
				assert.equal(row.role, "user");
				assert.equal(
					source.contentHash,
					createHash("sha256")
						.update(JSON.stringify(openAIFlowPayload("openai-responses")({ input: [row] })[0].content))
						.digest("hex"),
				);
			}
		}
		const cached = ["websocket-cached", "auto"].includes(transport);
		assert.equal(
			server.requests[1].body.previous_response_id,
			cached ? "response_1" : undefined,
			JSON.stringify(server.stats()),
		);
		assert.equal(server.requests[1].body.input.length, cached ? 1 : 3);
		if (cached) assert.equal(server.stats().deltaRequests, 1);
		if (transport === "sse") assert.equal(server.requests[0].encoding, "zstd");
	});

for (const failure of ["close", "previous_response_not_found"])
	test(`Codex cached ${failure} retries preserve the full admitted input`, async (t) => {
		const server = codexTransport(t, { fail: (_request, count) => (count === 2 ? failure : undefined) });
		const f = await nativeRequests(t, {
			model,
			native: server.stream,
			retainInputs: true,
			enforceRequiredSources: true,
		});
		await f.session.prompt("first");
		await f.session.prompt("second");
		assert.equal(server.requests.length, 3);
		assert.equal(server.requests[1].body.previous_response_id, "response_1");
		assert.equal(server.requests[2].body.previous_response_id, undefined);
		assert.equal(server.requests[2].input.filter((row) => row.role === "user").length, 2);
		assert.equal(server.requests[2].transport, failure === "close" ? "sse" : "websocket");
		assert.ok((await f.store.snapshot()).every((r) => r.outcome === "success"));
	});

for (const mode of ["edit", "omit", "clone", "duplicate"])
	test(`Codex ${mode} required input is withheld before cached transport`, async (t) => {
		const server = codexTransport(t);
		let change = false;
		const f = await nativeRequests(t, {
			model,
			native: server.stream,
			retainInputs: true,
			enforceRequiredSources: true,
			transform({ payload }) {
				if (!change) return;
				const last = payload.input.at(-1);
				if (mode === "edit") last.content[0].text = "other";
				if (mode === "omit") payload.input.pop();
				if (mode === "clone") payload.input[payload.input.length - 1] = structuredClone(last);
				if (mode === "duplicate") payload.input.push(last);
			},
		});
		await f.session.prompt("first");
		change = true;
		await f.session.prompt("second");
		assert.equal(server.requests.length, 1);
		const record = (await f.store.snapshot())[1];
		assert.equal(record.outcome, "withheld");
		assert.equal(record.withheldPayload.sources.at(-1).disposition, mode === "edit" ? "changed" : "unresolved");
	});

test("Codex conversion and SSE transport retain normalized tool and image source receipts", async (t) => {
	const server = codexTransport(t, { transport: "sse" });
	const messages = [
		{
			role: "user",
			content: [
				{ type: "text", text: "日本語" },
				{ type: "image", mimeType: "image/png", data: "YWJj" },
			],
			timestamp: 1,
		},
	];
	messages.push(
		{
			...assistant(),
			stopReason: "toolUse",
			content: [
				{ type: "toolCall", id: "tool$|fc_one", name: "agent_wait", arguments: {} },
				{ type: "toolCall", id: "orphan|fc_two", name: "agent_wait", arguments: {} },
			],
		},
		{
			role: "toolResult",
			toolCallId: "tool$|fc_one",
			toolName: "agent_wait",
			content: [{ type: "text", text: "resolved" }],
			isError: false,
			timestamp: 1,
		},
		{ role: "user", content: "continue", timestamp: 2 },
	);
	const members = [0, 2, 3].map((index) => ({ index }));
	const capture = {
		members,
		model: { members: members.map(({ index }) => ({ index, sourceIndex: index, status: "intact" })) },
	};
	const sources = new NativePayloadSources(messages, capture, model.api);
	let final;
	const result = await server
		.stream(
			model,
			{ messages },
			{
				onMessageConverted: (source, output) => sources.observe(source, output),
				onPayload(payload) {
					final = copyFlowPayload(payload).owned;
					return final;
				},
			},
		)
		.result();
	assert.equal(result.stopReason, "stop");
	assert.deepEqual(server.requests[0].input, final.input);
	assert.ok(sources.inspect(model.api, final, server.requests[0].body).every((r) => r.disposition === "included"));
	assert.equal(final.input.filter((row) => row.type === "function_call_output").length, 2);
});

for (const mode of ["prefix", "configuration"])
	test(`Codex changed ${mode} invalidates cached continuation`, async (t) => {
		const server = codexTransport(t);
		let change = false;
		const f = await nativeRequests(t, {
			model,
			native: server.stream,
			retainInputs: true,
			enforceRequiredSources: true,
			transform({ payload }) {
				if (!change) return;
				if (mode === "prefix")
					payload.input.find((row) => row.role === "assistant").content[0].text = "revised history";
				else payload.instructions += " New configuration.";
			},
		});
		await f.session.prompt("first");
		change = true;
		await f.session.prompt("second");
		assert.equal(server.requests[1].body.previous_response_id, undefined);
		assert.equal(server.requests[1].body.input.length, 3);
		assert.ok((await f.store.snapshot()).every((r) => r.outcome === "success"));
	});

test("Codex failure after stream start does not fall back and acknowledge input", async (t) => {
	const server = codexTransport(t, { fail: (_request, count) => (count === 2 ? "after-start" : undefined) });
	const f = await nativeRequests(t, { model, native: server.stream, retainInputs: true, enforceRequiredSources: true });
	await f.session.prompt("first");
	await f.session.prompt("second");
	assert.equal(server.requests.length, 2);
	assert.equal((await f.store.snapshot())[1].outcome, "failure");
	assert.equal(server.stats().sseFallbacks, 0);
	assert.match(server.stats().lastWebSocketError, /after start/);
});

test("Codex cancellation after cached send records an aborted request without fallback", async (t) => {
	const controller = new AbortController();
	const server = codexTransport(t, {
		fail: (_request, count) => {
			if (count === 2) {
				controller.abort();
				return "close";
			}
		},
	});
	const f = await nativeRequests(t, {
		model,
		native: (m, c, o) => server.stream(m, c, { ...o, signal: controller.signal }),
		retainInputs: true,
		enforceRequiredSources: true,
	});
	await f.session.prompt("first");
	await f.session.prompt("second");
	assert.equal(server.requests.length, 2);
	assert.equal((await f.store.snapshot())[1].outcome, "aborted");
	assert.equal(server.requests[1].body.previous_response_id, "response_1");
	assert.equal(server.stats().sseFallbacks, 0);
});

for (const mode of ["reconnect", "cache-disabled"])
	test(`Codex ${mode} sends full input with preserved source membership`, async (t) => {
		const server = codexTransport(t);
		const f = await nativeRequests(t, {
			model,
			retainInputs: true,
			enforceRequiredSources: true,
			native: (m, c, o) =>
				server.stream(m, c, { ...o, ...(mode === "cache-disabled" ? { cacheRetention: "none" } : {}) }),
		});
		await f.session.prompt("first");
		if (mode === "reconnect") server.close();
		await f.session.prompt("second");
		assert.equal(server.connections, 2);
		assert.equal(server.requests[1].body.previous_response_id, undefined);
		assert.equal(server.requests[1].input.length, 3);
		assert.ok((await f.store.snapshot()).every((r) => r.outcome === "success"));
	});
