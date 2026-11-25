// Consistency checks for docs/language.md, docs/profiles.md, docs/subagents.md,
// and the bundled configuration.md and history.md reference assets.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pathDigest } from "../dist/path-digest.js";
import { loadBundledProfile } from "../dist/profiles.js";
import {
	TRACE_DEFAULT_LIMIT,
	TRACE_MAX_LIMIT,
	TRACE_RESPONSE_BYTES,
	TRACE_SCAN_BYTES,
} from "../dist/subagents/trace.js";

const repoRoot = new URL("../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, repoRoot), "utf8");
const core = loadBundledProfile("core");
const assetText = (target) => core.assets.find((asset) => asset.target === target)?.bytes.toString("utf8") ?? "";

const configuration = assetText("skills/jouzu-reference/references/configuration.md");
const history = assetText("skills/jouzu-reference/references/history.md");
const language = read("docs/language.md");
const profiles = read("docs/profiles.md");
const subagents = read("docs/subagents.md");

const numberWords = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

test("documented Core skill count matches the bundled profile", () => {
	const skillCount = core.assets.filter((asset) => /^skills\/jouzu-[^/]+\/SKILL\.md$/.test(asset.target)).length;
	assert.ok(skillCount > 0 && skillCount < numberWords.length, `unexpected skill count: ${skillCount}`);
	assert.match(language, new RegExp(`\\b${numberWords[skillCount]} bundled Jouzu skills\\b`));
	assert.match(profiles, new RegExp(`\\b${numberWords[skillCount]} optional skills\\b`));
});

test("documented trace bounds match the trace implementation", () => {
	const scanMiB = TRACE_SCAN_BYTES / (1024 * 1024);
	const responseKB = Math.ceil(TRACE_RESPONSE_BYTES / 1000);
	assert.ok(Number.isInteger(scanMiB), `trace scan bound is not a whole MiB: ${TRACE_SCAN_BYTES}`);
	for (const [name, text] of [
		["history.md", history],
		["docs/subagents.md", subagents],
	]) {
		assert.match(text, new RegExp(`\\b${scanMiB} MiB\\b`), name);
		assert.match(text, new RegExp(`\\b${TRACE_MAX_LIMIT} records\\b`), name);
		assert.match(text, new RegExp(`\\bdefault ${TRACE_DEFAULT_LIMIT}\\b`), name);
		assert.match(text, new RegExp(`\\b${responseKB} KB\\b`), name);
		assert.doesNotMatch(text, /\b48 KB\b/, name);
	}
});

test("reference trace locations match the runtime layout", () => {
	for (const fragment of [
		"sessions/<UTC timestamp>_<session-uuid>.jsonl",
		"subagents/<parent-session-digest>/<run-id>/",
		"events.jsonl",
		"flow/<session-branch-digest>/",
		"schema.json",
		"owner.sqlite",
		"sessions/flow/<UTC timestamp>_flow.jsonl",
		"PI_SESSION_FILE",
		"PI_CODING_AGENT_SESSION_DIR",
	])
		assert.ok(history.includes(fragment), `history.md is missing ${fragment}`);

	for (const fragment of [
		"sessions/",
		"subagents/",
		"events.jsonl",
		"flow/",
		"PI_SESSION_FILE",
		"PI_CODING_AGENT_SESSION_DIR",
	])
		assert.ok(subagents.includes(fragment), `docs/subagents.md is missing ${fragment}`);

	const manager = read("packages/cli/src/subagents/manager.ts");
	const localFlow = read("packages/cli/src/flow-control/local-storage.ts");
	const ownership = read("packages/cli/src/flow-control/ownership.ts");
	const runtime = read("packages/cli/src/runtime.ts");
	assert.ok(manager.includes('"subagents"') && manager.includes('"run.json"') && manager.includes('"events.jsonl"'));
	assert.ok(localFlow.includes('"schema.json"') && localFlow.includes('"sessions"') && localFlow.includes('"flow"'));
	assert.ok(ownership.includes('"owner.sqlite"'));
	assert.ok(runtime.includes("PI_CODING_AGENT_SESSION_DIR"));
	assert.match(pathDigest(["session", "branch"]), /^[a-f0-9]{32}$/);
});

test("reference configuration qualifies agent resource directories", () => {
	for (const path of ["agent/skills/", "agent/prompts/", "agent/extensions/", "agent/themes/"])
		assert.ok(configuration.includes(`\`${path}\``), `configuration.md is missing ${path}`);
	assert.doesNotMatch(configuration, /\| `agent\/skills\/`, `prompts\/`/);
});
