import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModelGuidance } from "../dist/model-guidance.js";
import { createJouzuPresentationExtension } from "../dist/presentation.js";
import { childResourceLoader } from "../dist/subagents/worker.js";

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
	assert.match(first.systemPrompt, /carry authorized work through implementation/);
	assert.match(
		first.systemPrompt,
		/Do not stop at acknowledging capability, proposing a plan, or offering to continue/,
	);
	assert.match(first.systemPrompt, /continue without ending the turn to clarify/);
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

test("child sessions receive the same model guidance as main sessions", () => {
	const launch = (id) => ({
		cwd: "/tmp",
		directory: "/tmp",
		task: "task",
		role: { id: "reviewer", instructions: "Review the change.", tools: ["read"], judging: true },
		model: { id, provider: "configured-provider" },
		auth: {},
	});
	const astraPrompt = childResourceLoader(launch("gpt-6-astra")).getAppendSystemPrompt();
	assert.deepEqual(astraPrompt, ["Review the change.", buildModelGuidance("gpt-6-astra", ["read"])]);
	assert.match(astraPrompt[1], /offering to continue/);
	assert.deepEqual(childResourceLoader(launch("gpt-5.6-sol")).getAppendSystemPrompt(), ["Review the change."]);
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
