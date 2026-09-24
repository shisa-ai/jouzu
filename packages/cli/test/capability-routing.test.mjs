import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildCapabilityRoutingGuidance, JOUZU_DEFAULT_GUIDANCE } from "../dist/presentation.js";

const root = join(import.meta.dirname, "../../..");
const corpus = JSON.parse(readFileSync(join(root, "evals/core-capability-routing.json"), "utf8"));

const expectedCaseIds = [
	"simple-repository-change",
	"recall-earlier-session-decision",
	"continue-after-compaction",
	"request-compaction-during-long-task",
	"fetch-known-readable-url",
	"fetch-multiple-known-urls",
	"discover-web-sources",
	"fetch-rendered-or-blocked-page",
	"fact-check-disputed-claim",
	"finite-multi-step-work",
	"active-persistent-goal",
	"measured-iteration-loop",
	"long-running-shell-process",
	"explicit-reminder",
	"durable-user-facing-documentation",
	"deslop-existing-prose",
	"background-dependency-wait",
	"replacement-job-notification",
	"task-awaiting-user-input",
	"status-during-dependency-wait",
];

function assertStringArray(value, subject) {
	assert.ok(Array.isArray(value), `${subject} must be an array`);
	for (const item of value) assert.equal(typeof item, "string", `${subject} entries must be strings`);
}

test("Core capability routing corpus covers direct, context, web, and workflow choices", () => {
	assert.equal(corpus.schemaVersion, 1);
	assert.deepEqual(
		corpus.cases.map((entry) => entry.id),
		expectedCaseIds,
	);
	for (const entry of corpus.cases) {
		assert.equal(typeof entry.prompt, "string");
		assert.ok(entry.prompt.length > 0);
		for (const side of ["expect", "avoid"]) {
			assertStringArray(entry[side].skills, `${entry.id}.${side}.skills`);
			assertStringArray(entry[side].tools, `${entry.id}.${side}.tools`);
		}
		assertStringArray(entry.expect.behaviors, `${entry.id}.expect.behaviors`);
		assert.equal(
			entry.expect.skills.some((name) => entry.avoid.skills.includes(name)),
			false,
			`${entry.id} expects and avoids the same skill`,
		);
		assert.equal(
			entry.expect.tools.some((name) => entry.avoid.tools.includes(name)),
			false,
			`${entry.id} expects and avoids the same tool`,
		);
	}
});

test("Core keeps repository discipline inline and generates bounded decision-time routing", () => {
	assert.ok(JOUZU_DEFAULT_GUIDANCE.length <= corpus.budgets.defaultGuidanceCharacters);
	for (const phrase of [
		"Work directly by default",
		"Follow repository instructions and preserve user-owned work",
		"Inspect relevant files before editing",
		"Distinguish evidence from assumptions",
		"make the smallest coherent change",
		"run the narrowest deterministic check",
		"Report untested limitations honestly",
		"Use task tracking only for work with three or more distinct steps",
		"do not combine workflow systems",
		"exact listed `<location>` once",
		"never search guessed package paths",
		"If a skill file is unavailable, continue without it",
	]) {
		assert.match(JOUZU_DEFAULT_GUIDANCE, new RegExp(phrase));
	}
	assert.doesNotMatch(JOUZU_DEFAULT_GUIDANCE, /jouzu-core/);
	assert.doesNotMatch(JOUZU_DEFAULT_GUIDANCE, /\b(?:removed|retired|obsolete|superseded)\b/i);

	const routing = buildCapabilityRoutingGuidance({
		selectedTools: [
			"read",
			"grep",
			"find",
			"ls",
			"vcc_recall",
			"web_fetch",
			"batch_web_fetch",
			"tff-search_web",
			"tff-fetch_url",
			"TaskCreate",
			"get_goal",
			"update_goal",
			"multiloop_start",
			"bg_task",
			"schedule_prompt",
		],
		skills: [
			{ name: "jouzu-source-check" },
			{ name: "multiloop" },
			{ name: "jouzu-clear-writing" },
			{ name: "jouzu-anti-slop" },
		],
	});
	assert.doesNotMatch(routing, /Repository files and commands|`read`|`grep`|`find`|`ls`/);
	for (const phrase of [
		"vcc_recall",
		"web_fetch",
		"batch_web_fetch",
		"tff-search_web",
		"tff-fetch_url",
		"jouzu-source-check",
		"TaskCreate",
		"get_goal",
		"multiloop",
		"bg_task",
		"schedule_prompt",
		"jouzu-clear-writing",
		"jouzu-anti-slop",
	]) {
		assert.match(routing, new RegExp(phrase));
	}
	assert.match(routing, /read `jouzu-source-check` at its listed `<location>`/);
	assert.match(routing, /read `multiloop` at its listed `<location>`/);
	// The goal and measured-loop routes both come from the multiloop skill now.
	assert.match(routing, /One user-approved persistent objective/);
	assert.match(routing, /Repeated measured improvement/);
	assert.match(routing, /read `jouzu-clear-writing` at its listed `<location>`/);
	assert.match(routing, /read `jouzu-anti-slop` at its listed `<location>`/);
	assert.match(routing, /Existing prose needs a filler-removal pass/);
});

test("delegation routes to the skill only when both tool and skill are available", () => {
	const skill = { name: "jouzu-delegation" };
	const routing = buildCapabilityRoutingGuidance({ selectedTools: ["subagent"], skills: [skill] });
	assert.match(routing, /read `jouzu-delegation` at its listed `<location>` once/);
	assert.match(routing, /one objective, verified context, constraints, acceptance checks, and a stopping point/);
	assert.doesNotMatch(buildCapabilityRoutingGuidance({ selectedTools: ["subagent"] }), /jouzu-delegation/);
	assert.doesNotMatch(buildCapabilityRoutingGuidance({ selectedTools: ["read"], skills: [skill] }), /jouzu-delegation/);
});

test("dependency routing is available only when waits are active", () => {
	const plain = buildCapabilityRoutingGuidance({ selectedTools: ["bg_task", "TaskUpdate"] });
	assert.doesNotMatch(plain, /`agent_wait`/);
	const waiting = buildCapabilityRoutingGuidance({
		selectedTools: ["bg_task", "TaskUpdate", "agent_wait", "schedule_prompt"],
	});
	assert.match(waiting, /Remaining work depends on asynchronous execution/);
	assert.match(waiting, /Once waiting, end the turn/);
	assert.match(waiting, /do not add timer-based polling/);
});
