import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildCapabilityRoutingGuidance, JOUZU_DEFAULT_GUIDANCE } from "../dist/presentation.js";

const root = join(import.meta.dirname, "../../..");
const corpus = JSON.parse(readFileSync(join(root, "evals/core-capability-routing.json"), "utf8"));
const coreSkill = readFileSync(join(root, "packages/cli/profiles/core/assets/jouzu-core-skill.md"), "utf8");

const expectedCaseIds = [
	"simple-repository-change",
	"recall-earlier-session-decision",
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

test("Core keeps execution discipline on demand and generates bounded decision-time routing", () => {
	assert.ok(Buffer.byteLength(coreSkill, "utf8") <= corpus.budgets.coreSkillBytes);
	assert.ok(JOUZU_DEFAULT_GUIDANCE.length <= corpus.budgets.defaultGuidanceCharacters);
	assert.match(coreSkill, /Work directly by default/);
	assert.match(coreSkill, /Use only tools and skills listed in the current session\./);
	assert.match(coreSkill, /Do not add task tracking merely to make the work appear more thorough\./);
	assert.doesNotMatch(coreSkill, /\b(?:removed|retired|obsolete|superseded|unavailable)\b/i);

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
			{ name: "pi-goal" },
			{ name: "multiloop" },
			{ name: "jouzu-clear-writing" },
		],
	});
	for (const phrase of [
		"vcc_recall",
		"web_fetch",
		"batch_web_fetch",
		"tff-search_web",
		"tff-fetch_url",
		"jouzu-source-check",
		"TaskCreate",
		"pi-goal",
		"multiloop",
		"bg_task",
		"schedule_prompt",
		"jouzu-clear-writing",
	]) {
		assert.match(routing, new RegExp(phrase));
	}
});
