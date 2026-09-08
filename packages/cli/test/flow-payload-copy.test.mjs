import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowModelInput } from "../dist/flow-control/model-input.js";
import { copyFlowPayload, payloadRowOrigin } from "../dist/flow-control/payload-copy.js";
import { PiRequestReceipts } from "../dist/flow-control/pi-request-receipts.js";
import { openAIFlowPayload } from "../dist/flow-control/provider-payload.js";
import { nativeRequests } from "./fixtures/native-requests.mjs";

for (const mode of ["retain", "clone"])
	test(`controller payload admission preserves native receipts only for known copies: ${mode}`, async (t) => {
		const f = await nativeRequests(t, {
			retainInputs: true,
			transform: mode === "clone" ? ({ payload }) => structuredClone(payload) : undefined,
		});
		await f.session.prompt("seed");
		const ledger = f.attachment.ledger;
		const composition = FlowModelInput.compose(
			"attempt",
			[{ id: "work", revision: "1", kind: "work", text: "Do work" }],
			4096,
		);
		await ledger.select("attempt", composition.members);
		await ledger.queued("attempt", { id: "queue", revision: 1 });
		await ledger.claim("attempt", { id: "queue", revision: 1 });
		const receipts = new PiRequestReceipts(f.session, ledger, {
			projections: new Map([["openai-completions", openAIFlowPayload("openai-completions")]]),
			maxPayloadBytes: 100000,
			containsUserInput: () => false,
		});
		try {
			receipts.register(composition);
			const [seed] = await f.attachment.submissions.snapshot();
			const saved = await f.attachment.submissions.retain({ ...seed.submission, id: "composed" });
			await f.dispatch.dispatch(saved.id, saved.revision, "composed-operation", () =>
				f.session.agent.prompt([{ role: "user", content: composition.content, timestamp: 1 }]),
			);
			const request = (await f.store.snapshot())[1];
			assert.equal(request.outcome, "success");
			const offset = request.sourceCapture.members.findIndex((source) => source.operationId === "composed-operation");
			assert.ok(offset >= 0);
			assert.equal(request.payload.sources[offset].disposition, mode === "retain" ? "included" : "unresolved");
			const semantic = (await ledger.snapshot()).attempts[0].requests[0];
			assert.equal(semantic.outcome, "success");
			assert.equal(semantic.payload.hash, request.payload.hash);
			assert.equal(semantic.payload.inclusion[0].disposition, "included");
		} finally {
			receipts.close();
		}
	});

test("host payload copy tracks duplicate occurrences and chained copies without mutating source", () => {
	const row = { role: "user", content: "same" };
	const original = { messages: [row, row, { ...row }] };
	const first = copyFlowPayload(original),
		second = copyFlowPayload(first.owned);
	assert.equal(payloadRowOrigin(second.owned.messages[0]), row);
	assert.equal(payloadRowOrigin(second.owned.messages[1]), row);
	assert.equal(payloadRowOrigin(second.owned.messages[2]), original.messages[2]);
	second.owned.messages[0].content = "changed";
	assert.equal(original.messages[0].content, "same");
	assert.equal(first.owned.messages[0].content, "same");
	assert.equal(payloadRowOrigin(structuredClone(second.owned).messages[0]).content, "changed");
});

test("custom serialization and accessors cannot establish positional payload provenance", () => {
	for (const payload of [
		{
			messages: [{ role: "user", content: "same" }],
			toJSON() {
				return { messages: [{ role: "user", content: "same" }] };
			},
		},
		{
			get messages() {
				return [{ role: "user", content: "same" }];
			},
		},
		{
			messages: [
				{
					role: "user",
					get content() {
						return "same";
					},
				},
			],
		},
	]) {
		const { owned } = copyFlowPayload(payload);
		assert.equal(payloadRowOrigin(owned.messages[0]), owned.messages[0]);
	}
});

test("known host copy preserves changed disposition after later edits", async (t) => {
	const f = await nativeRequests(t, {
		retainInputs: true,
		transform: ({ payload }) => {
			const { owned } = copyFlowPayload(payload);
			owned.messages.find((message) => message.role === "user").content[0].text = "changed";
			return owned;
		},
	});
	await f.session.prompt("original");
	assert.equal((await f.store.snapshot())[0].payload.sources[0].disposition, "changed");
});

test("array subclasses and proxies cannot forge host payload copy mappings", () => {
	class Rows extends Array {
		toJSON() {
			return [...this].reverse();
		}
	}
	const row = { role: "user", content: "same" };
	for (const payload of [
		{ messages: new Rows(row, { ...row }) },
		new Proxy({ messages: [row] }, {}),
		{ messages: [new Proxy(row, {})] },
	]) {
		const { owned } = copyFlowPayload(payload);
		assert.equal(payloadRowOrigin(owned.messages[0]), owned.messages[0]);
	}
});
