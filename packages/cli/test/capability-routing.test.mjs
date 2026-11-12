import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	buildCapabilityRoutingGuidance,
	JOUZU_ASYNC_WAIT_GUIDANCE,
	JOUZU_DEFAULT_GUIDANCE,
} from "../dist/presentation.js";
import { promptCapabilities } from "../dist/prompt-capabilities.js";

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
		"TaskCreate",
		"get_goal",
		"multiloop",
		"bg_task",
		"schedule_prompt",
	]) {
		assert.match(routing, new RegExp(phrase));
	}
	assert.doesNotMatch(routing, /jouzu-source-check|jouzu-clear-writing|jouzu-anti-slop/);
	assert.match(routing, /read `multiloop` at its listed `<location>`/);
	// The goal and measured-loop routes both come from the multiloop skill now.
	assert.match(routing, /One user-approved persistent objective/);
	assert.match(routing, /Repeated measured improvement/);
});

test("skill triggers live in the index rather than repeated routing rows", () => {
	const skills = ["jouzu-reference", "jouzu-source-check", "jouzu-clear-writing", "jouzu-anti-slop"].map((name) => ({
		name,
	}));
	const options = { selectedTools: ["read"], skills };
	assert.deepEqual(promptCapabilities(options).skills, skills);
	const routing = buildCapabilityRoutingGuidance(options);
	assert.match(routing, /exact listed `<location>` once/);
	assert.match(routing, /If a skill file is unavailable, continue without it/);
	for (const skill of skills) assert.ok(!routing.includes(skill.name));
	assert.equal(buildCapabilityRoutingGuidance({ selectedTools: ["read"], skills: [] }), "");
});

test("delegation skills require an available and enabled delegation tool", () => {
	const skill = { name: "jouzu-delegation" };
	const options = { selectedTools: ["read", "subagent"], skills: [skill] };
	assert.deepEqual(promptCapabilities(options).skills, [skill]);
	assert.deepEqual(promptCapabilities(options, { subagentsEnabled: false }).skills, []);
	assert.deepEqual(promptCapabilities({ ...options, selectedTools: ["read"] }).skills, []);
	assert.deepEqual(promptCapabilities({ ...options, hiddenTools: ["subagent"] }).skills, []);
	assert.equal(promptCapabilities(options, { subagentsEnabled: false }).tools.has("subagent"), true);
});

test("asynchronous-work guidance appears once, from waits when they are active", () => {
	const plain = buildCapabilityRoutingGuidance({ selectedTools: ["bg_task", "TaskUpdate"] });
	assert.ok(plain.startsWith(`${JOUZU_ASYNC_WAIT_GUIDANCE}\n`));
	assert.doesNotMatch(plain, /`agent_wait`/);
	const waiting = buildCapabilityRoutingGuidance({
		selectedTools: ["bg_task", "TaskUpdate", "agent_wait", "schedule_prompt"],
	});
	// `agent_wait` registers the wait protocol as tool guidelines; routing repeats none of it.
	assert.doesNotMatch(waiting, /completion notifications|agent_wait|end the turn/);
	assert.match(waiting, /do not add timer-based polling/);
});

test("the untrusted-content rule is stated once per prompt", () => {
	const withBrowser = buildCapabilityRoutingGuidance({
		selectedTools: ["web_fetch", "batch_web_fetch", "tff-search_web", "tff-fetch_url"],
	});
	assert.doesNotMatch(withBrowser, /untrusted/i);
	const fetchOnly = buildCapabilityRoutingGuidance({ selectedTools: ["web_fetch", "batch_web_fetch"] });
	assert.equal(fetchOnly.match(/untrusted/g)?.length, 1);
	assert.equal(buildCapabilityRoutingGuidance({ selectedTools: ["batch_web_fetch"] }).match(/untrusted/g)?.length, 1);
});

test("minimal and hidden tool selections do not advertise optional workflows", () => {
	for (const selectedTools of [[], ["read", "bash", "edit", "write"]]) {
		assert.equal(buildCapabilityRoutingGuidance({ selectedTools }), "");
	}
	assert.equal(buildCapabilityRoutingGuidance({ selectedTools: ["bg_task"], hiddenTools: ["bg_task"] }), "");
	assert.doesNotMatch(buildCapabilityRoutingGuidance({ selectedTools: ["tff-fetch_url"] }), /web_fetch/);
	assert.doesNotMatch(
		buildCapabilityRoutingGuidance({ selectedTools: ["subagent"] }, { subagentsEnabled: false }),
		/completion notifications/,
	);
});

test("skill admission preserves generic and indirect-reader skills without unavailable workflow skills", () => {
	const skills = ["custom-skill", "jouzu-reference", "multiloop", "jouzu-delegation"].map((name) => ({ name }));
	const options = { selectedTools: ["read"], hiddenTools: ["read"], skills };
	assert.deepEqual(
		promptCapabilities(options).skills.map((skill) => skill.name),
		["custom-skill", "jouzu-reference"],
	);
	assert.deepEqual(promptCapabilities({ ...options, selectedTools: [] }).skills, []);
	assert.deepEqual(
		promptCapabilities({ ...options, selectedTools: ["read", "get_goal"] }).skills.map((skill) => skill.name),
		["custom-skill", "jouzu-reference", "multiloop"],
	);
	assert.deepEqual(options.skills, skills);
});
