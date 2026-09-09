import assert from "node:assert/strict";
import { test } from "node:test";
import {
	flowProviderCodecs,
	flowProviderProjections,
	isBlockAddressedFlowProvider,
	isQualifiedFlowProvider,
} from "../dist/flow-control/provider-registry.js";

const qualified = [
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"mistral-conversations",
	"pi-messages",
	"bedrock-converse-stream",
	"anthropic-messages",
	"google-generative-ai",
	"google-vertex",
];

test("the registry declares each qualified API family exactly once", () => {
	const apis = flowProviderCodecs.map((codec) => codec.api);
	assert.deepEqual([...apis].sort(), [...qualified].sort());
	assert.equal(new Set(apis).size, apis.length);
	for (const codec of flowProviderCodecs) assert.equal(typeof codec.projection, "function");
});

test("membership and block addressing follow the declared rows", () => {
	for (const api of qualified) assert.ok(isQualifiedFlowProvider(api), api);
	for (const api of ["", "unknown", "openai", "anthropic"]) assert.equal(isQualifiedFlowProvider(api), false, api);
	const blockAddressed = flowProviderCodecs.filter((codec) => codec.blockAddressed).map((codec) => codec.api);
	assert.deepEqual(blockAddressed.sort(), [
		"anthropic-messages",
		"bedrock-converse-stream",
		"google-generative-ai",
		"google-vertex",
	]);
	for (const api of blockAddressed) assert.ok(isBlockAddressedFlowProvider(api), api);
	assert.equal(isBlockAddressedFlowProvider("openai-completions"), false);
	assert.equal(isBlockAddressedFlowProvider("unknown"), false);
});

test("the host projection registry is keyed by API and owned by its caller", () => {
	const projections = flowProviderProjections();
	assert.deepEqual([...projections.keys()].sort(), [...qualified].sort());
	for (const codec of flowProviderCodecs) assert.equal(projections.get(codec.api), codec.projection);
	projections.delete("openai-completions");
	assert.equal(flowProviderProjections().has("openai-completions"), true);
});

test("responses variants share one qualified projection", () => {
	const projections = flowProviderProjections();
	const responses = ["openai-responses", "openai-codex-responses", "azure-openai-responses"];
	const rows = { input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }] };
	const expected = projections.get("openai-responses")(rows);
	for (const api of responses) assert.deepEqual(projections.get(api)(rows), expected);
	assert.equal(expected.length, 1);
	assert.equal(expected[0].role, "user");
	assert.deepEqual(expected[0].content, [{ type: "text", text: "hello" }]);
});
