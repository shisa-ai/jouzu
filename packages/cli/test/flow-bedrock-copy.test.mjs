import assert from "node:assert/strict";
import { test } from "node:test";
import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { copyFlowPayload } from "../dist/flow-control/payload-copy.js";

const api = "bedrock-converse-stream";
function fixture(bytes = new Uint8Array([97, 98, 99])) {
	return {
		modelId: "fixture",
		messages: [{ role: "user", content: [{ image: { format: "png", source: { bytes } } }] }],
	};
}

test("Bedrock copy preserves owned binary bytes through the AWS HTTP serializer", async () => {
	const backing = new Uint8Array([0, 97, 98, 99, 0]);
	const original = fixture(backing.subarray(1, 4));
	const first = copyFlowPayload(original, api);
	const second = copyFlowPayload(first.owned, api);
	assert.equal(first.serialized, second.serialized);
	backing.fill(0);
	assert.deepEqual([...second.owned.messages[0].content[0].image.source.bytes], [97, 98, 99]);
	let wire;
	const client = new BedrockRuntimeClient({
		region: "us-east-1",
		credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
		maxAttempts: 1,
		requestHandler: {
			async handle(request) {
				wire = JSON.parse(request.body);
				throw new Error("captured transport");
			},
			destroy() {},
		},
	});
	try {
		await assert.rejects(client.send(new ConverseStreamCommand(second.owned)), /captured transport/);
	} finally {
		client.destroy();
	}
	assert.equal(wire.messages[0].content[0].image.source.bytes, "YWJj");
	assert.deepEqual(wire.messages, JSON.parse(second.serialized).messages);
	second.owned.messages[0].content[0].image.source.bytes[0] = 0;
	assert.equal(first.owned.messages[0].content[0].image.source.bytes[0], 97);
});

test("Bedrock copy handles Buffer and base64s it for the wire", () => {
	const original = fixture(Buffer.from("abc"));
	const cloned = structuredClone(original);
	copyFlowPayload(cloned, api);
	assert.equal(JSON.parse(copyFlowPayload(original, api).serialized).messages[0].content[0].image.source.bytes, "YWJj");
});

for (const mode of ["getter", "toJSON", "proxy", "cycle", "shared", "subclass", "extra", "lookalike", "shadow-buffer"])
	test(`Bedrock rejects unsupported binary or serialization state: ${mode}`, () => {
		const payload = fixture();
		const source = payload.messages[0].content[0].image.source;
		if (mode === "getter")
			Object.defineProperty(source, "bytes", {
				get() {
					throw new Error("must not execute");
				},
			});
		if (mode === "toJSON")
			payload.toJSON = () => {
				throw new Error("must not execute");
			};
		if (mode === "proxy") source.bytes = new Proxy(source.bytes, {});
		if (mode === "cycle") payload.self = payload;
		if (mode === "shared") source.bytes = new Uint8Array(new SharedArrayBuffer(3));
		if (mode === "subclass") source.bytes = new (class extends Uint8Array {})(3);
		if (mode === "extra") source.bytes.extra = "untracked";
		if (mode === "shadow-buffer")
			Object.defineProperty(source.bytes, "buffer", {
				get() {
					throw new Error("must not execute");
				},
			});
		if (mode === "lookalike") source.bytes = Object.create(Uint8Array.prototype);
		assert.throws(() => copyFlowPayload(payload, api), { code: "schema" });
	});

test("Bedrock copy preserves sparse array length in owned and serialized data", () => {
	const original = { messages: new Array(3) };
	const copy = copyFlowPayload(original, api);
	assert.equal(copy.owned.messages.length, 3);
	assert.equal(copy.serialized, JSON.stringify(original));
});
