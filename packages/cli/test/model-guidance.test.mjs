import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runPromptHook } from "../../../scripts/fixtures/prompt-hook.mjs";
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

function assertRecoveryGuidance(prompt) {
	for (const clause of [
		"When a check fails, distinguish implementation, test, and environment failures",
		"Do not weaken or bypass checks or reduce scope to get a pass",
		"Respect diagnosis-only, review-only, pause, and cancellation requests",
		"Preserve it across turns and compaction",
		"Apply steering through action in the same turn",
		"Preserve running jobs and pending work",
		"compare the requested deliverables against verification evidence",
		"A failed first attempt or a completed task list is not proof of completion",
		"completion checklist",
	]) {
		assert.ok(prompt.includes(clause), `Missing recovery instruction: ${clause}`);
	}
}

test("Astra guidance follows the selected model on every turn without accumulating", async () => {
	const before = hook();
	const turn = (ctx) => runPromptHook(before, { systemPrompt: base, options: { selectedTools: ["read"] }, ctx });
	const astra = { model: { id: "gpt-6-astra", provider: "configured-provider" } };
	const first = turn(astra);
	assert.match(first.systemPrompt, /Carry authorized work through implementation/);
	assert.match(first.systemPrompt, /do not substitute a plan, acknowledgement, or offer to continue/);
	assert.match(first.systemPrompt, /Ask only when missing information affects correctness or authorization/);
	assert.match(first.systemPrompt, /Respect diagnosis-only, review-only, pause, and cancellation requests/);
	assert.match(first.systemPrompt, /Authorization persists across turns/);
	assertRecoveryGuidance(first.systemPrompt);
	assert.match(first.systemPrompt, /repeat passing checks only/);
	assert.doesNotMatch(first.systemPrompt, /Use task tools|agent_wait|Use subagent/);
	const other = turn({ model: { id: "gpt-5.6-sol" } });
	assert.doesNotMatch(other.systemPrompt, /Carry authorized work through implementation/);
	// Each run starts from fresh options, so guidance is set once per turn and never accumulates.
	assert.deepEqual(turn(astra).sections, first.sections);
	assert.equal(first.systemPrompt.split("Carry authorized work through implementation").length, 2);
});

test("delegation guidance describes only the active Jouzu tool", () => {
	assert.match(buildModelGuidance("gpt-6-astra", ["subagent"]), /Follow its role-discovery and assignment contract/);
	assert.doesNotMatch(buildModelGuidance("gpt-6-astra", ["read"]), /subagent|configured roles/);
	for (const id of [undefined, "gpt-6-astra-preview", "custom-gpt-6-astra", "gpt-5.6-sol"])
		assert.equal(buildModelGuidance(id, ["subagent"]), "");
});

test("Astra guidance keeps one scope boundary and evidence rule after deduplication", () => {
	const guidance = buildModelGuidance("gpt-6-astra", ["subagent", "TaskUpdate", "agent_wait"]);
	assert.equal(guidance.match(/Respect diagnosis-only/g)?.length, 1);
	assert.equal(guidance.match(/not proof of completion/g)?.length, 1);
	assert.match(guidance, /use dependencies, user-input holds, or pauses for blocked work/);
	assert.match(guidance, /use agent_wait and resume on its result/);
	assert.match(guidance, /verify child evidence and the integrated result/);
	assert.ok(guidance.length < 3400);
});

test("child sessions receive the same model guidance as main sessions", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-child-model-guidance-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const launch = (id) => ({
		cwd: root,
		directory: root,
		task: "task",
		role: { id: "reviewer", instructions: "Review the change.", tools: ["read"], judging: true },
		model: { id, provider: "configured-provider" },
		auth: {},
	});
	const astraPrompt = (await childResourceLoader(launch("gpt-6-astra"))).getAppendSystemPrompt();
	assert.ok(astraPrompt.includes("Review the change."));
	assert.ok(astraPrompt.includes(buildModelGuidance("gpt-6-astra", ["read"])));
	assert.match(astraPrompt.join("\n"), /offer to continue/);
	assertRecoveryGuidance(astraPrompt.join("\n"));
	const other = (await childResourceLoader(launch("gpt-5.6-sol"))).getAppendSystemPrompt();
	assert.ok(other.includes("Review the change."));
	assert.doesNotMatch(other.join("\n"), /Carry authorized work through implementation/);
});

test("model workflow advice follows hidden tools and disabled features", () => {
	const handlers = new Map();
	createJouzuPresentationExtension(
		{},
		{},
		{ promptFeatures: () => ({ subagentsEnabled: false, flowEnabled: false }) },
	).factory({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand() {},
		registerTool() {},
	});
	const run = runPromptHook(handlers.get("before_agent_start"), {
		options: {
			selectedTools: ["read", "subagent", "agent_wait", "TaskUpdate"],
			hiddenTools: ["TaskUpdate"],
			skills: [{ name: "jouzu-delegation" }],
		},
		ctx: { model: { id: "gpt-6-astra" } },
	});
	assert.doesNotMatch(run.systemPrompt, /Use subagent|use agent_wait|Use task tools|jouzu-delegation/);
	assertRecoveryGuidance(run.systemPrompt);
});

test("explicit custom system prompts remain user-owned", () => {
	const run = runPromptHook(hook(), {
		systemPrompt: "Review only.",
		options: { customPrompt: "Review only.", selectedTools: ["subagent"] },
		ctx: { model: { id: "gpt-6-astra" } },
	});
	assert.equal(run.result, undefined);
	assert.deepEqual(run.sections, {});
	assert.equal(run.systemPrompt, "Review only.");
});
