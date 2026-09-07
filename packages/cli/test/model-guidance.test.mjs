import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModelGuidance } from "../dist/model-guidance.js";
import { createJouzuPresentationExtension } from "../dist/presentation.js";

const base =
	"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
function hook() {
	const handlers = new Map();
	createJouzuPresentationExtension({}, {}).factory({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand() {},
		registerTool() {},
	});
	return handlers.get("before_agent_start");
}

test("Astra guidance follows the selected model on every turn without accumulating", async () => {
	const before = hook();
	const event = { systemPrompt: base, systemPromptOptions: { selectedTools: ["read"] } };
	const astra = { model: { id: "gpt-6-astra", provider: "configured-provider" } };
	const first = await before(event, astra);
	assert.match(first.systemPrompt, /Carry authorized work through implementation/);
	assert.match(first.systemPrompt, /Authorization persists across turns/);
	assert.match(first.systemPrompt, /repeat or broaden testing only/);
	assert.doesNotMatch(first.systemPrompt, /Use `subagent`/);
	const other = await before(event, { model: { id: "gpt-5.6-sol" } });
	assert.doesNotMatch(other.systemPrompt, /Jouzu guidance for GPT-6 Astra/);
	assert.deepEqual(await before(event, astra), first);
	assert.equal(await before({ ...event, systemPrompt: first.systemPrompt }, astra), undefined);
});

test("delegation guidance describes only the active Jouzu tool", () => {
	assert.match(buildModelGuidance("gpt-6-astra", ["subagent"]), /Discover configured roles first/);
	assert.doesNotMatch(buildModelGuidance("gpt-6-astra", ["read"]), /subagent|configured roles/);
	for (const id of [undefined, "gpt-6-astra-preview", "custom-gpt-6-astra", "gpt-5.6-sol"])
		assert.equal(buildModelGuidance(id, ["subagent"]), "");
});

test("explicit custom system prompts remain user-owned", async () => {
	assert.equal(
		await hook()(
			{
				systemPrompt: "Review only.",
				systemPromptOptions: { customPrompt: "Review only.", selectedTools: ["subagent"] },
			},
			{ model: { id: "gpt-6-astra" } },
		),
		undefined,
	);
});
