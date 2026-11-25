// Consistency checks for docs/language.md, docs/profiles.md, docs/subagents.md,
// and the bundled configuration.md and history.md reference assets against the source.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { legacyPathDigest, pathDigest } from "../dist/path-digest.js";
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

test("reference state map lists every state root entry the runtime writes", () => {
	const section = history.slice(history.indexOf("## State map"), history.indexOf("### Trace locations"));
	const listed = new Set();
	for (const row of section.split("\n").filter((line) => line.startsWith("| `")))
		for (const [, name] of row.split(" | ")[0].matchAll(/`([^`]+)`/g)) listed.add(name.replace(/\/$/, ""));
	assert.ok(listed.size > 0, "history.md state map has no rows");

	const sourceRoot = new URL("packages/cli/src/", repoRoot);
	const sources = readdirSync(sourceRoot, { recursive: true })
		.filter((path) => path.endsWith(".ts"))
		.map((path) => readFileSync(new URL(path, sourceRoot), "utf8"))
		.join("\n");
	for (const name of listed)
		assert.ok(sources.includes(`"${name}"`), `state map names ${name}, which no source writes`);

	const written = new Set(
		[...sources.matchAll(/join\(\s*(?:[\w.]+\.)?stateDir,\s*"([^"]+)"/g)].map((match) => match[1]),
	);
	assert.ok(written.has("sessions") && written.has("subagent-writers"), "state root scan found too little");
	for (const name of written)
		if (!name.endsWith(".lock")) assert.ok(listed.has(name), `history.md state map is missing ${name}`);
});

test("reference trace locations match the runtime layout", () => {
	for (const fragment of [
		"`paths.stateDir`",
		"`paths.sessionDir`",
		"`--session-dir`",
		"sessions/<UTC timestamp>_<session-id>.jsonl",
		"subagents/<parent-digest>/<run-id>/",
		"`run.json`",
		"`events.jsonl`",
		"`parent-context.jsonl`",
		"`sessionFile`",
		"`<branch-digest>/`",
		"`schema.json`",
		"`owner.sqlite`",
		"sessions/flow/<UTC timestamp>_flow.jsonl",
		"session-registry-v1/<registry-digest>/",
		"`PI_SESSION_FILE`",
		"`PI_SESSION_ID`",
		"`PI_CODING_AGENT_SESSION_DIR`",
	])
		assert.ok(history.includes(fragment), `history.md is missing ${fragment}`);

	for (const fragment of [
		"`paths.stateDir`",
		"`--session-dir`",
		"<UTC timestamp>_<session-id>.jsonl",
		"subagents/<parent-digest>/",
		"`run.json`",
		"`events.jsonl`",
		"`parent-context.jsonl`",
		"`sessionFile`",
		"`schema.json`",
		"`owner.sqlite`",
		"`session-registry-v1/`",
		"`PI_SESSION_FILE`",
		"`PI_SESSION_ID`",
	])
		assert.ok(subagents.includes(fragment), `docs/subagents.md is missing ${fragment}`);

	const source = (path) => read(`packages/cli/src/${path}`);
	const manager = source("subagents/manager.ts");
	assert.ok(manager.includes('join(paths.stateDir, "subagents", pathDigest(parentSessionId))'));
	for (const name of ['"run.json"', '"events.jsonl"', '"parent-context.jsonl"'])
		assert.ok(manager.includes(name), name);
	// A resumed run reuses the first run's conversation file and keeps its child state beside it.
	assert.ok(manager.includes("directory: sessionFile ? dirname(sessionFile) : this.directory(id)"));
	assert.ok(source("subagents/worker.ts").includes('root: join(launch.directory, "flow")'));
	assert.ok(source("subagents/integration.ts").includes("sessionFile: run.sessionFile"));
	assert.ok(source("main-cli.ts").includes('root: join(paths.stateDir, "flow")'));

	const localFlow = source("flow-control/local-storage.ts");
	for (const name of ['"schema.json"', '"sessions"', '"flow"', "_flow.jsonl"])
		assert.ok(localFlow.includes(name), name);
	const ownership = source("flow-control/ownership.ts");
	assert.ok(ownership.includes('"owner.sqlite"') && ownership.includes("pathDigest([sessionId, branchId])"));
	const registry = source("flow-control/pi-session-registry.ts");
	assert.ok(registry.includes('join(root, "session-registry-v1")') && registry.includes('branchId: "registry"'));

	assert.ok(source("runtime.ts").includes("process.env.PI_CODING_AGENT_SESSION_DIR = paths.sessionDir;"));
	const doctor = source("doctor.ts");
	assert.ok(doctor.includes('"paths.stateDir"') && doctor.includes('"paths.sessionDir"'));

	const sha256 = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
	for (const value of ["00000000-0000-4000-8000-000000000000", ["session", "branch"], ["session", "registry"]]) {
		assert.equal(pathDigest(value), sha256(value).slice(0, 32));
		assert.equal(legacyPathDigest(value), sha256(value));
	}
	assert.ok(history.includes("SHA-256 over JSON text") && history.includes("use all 64"));
});

test("reference configuration qualifies agent resource directories", () => {
	for (const path of ["agent/skills/", "agent/prompts/", "agent/extensions/", "agent/themes/"])
		assert.ok(configuration.includes(`\`${path}\``), `configuration.md is missing ${path}`);
	assert.doesNotMatch(configuration, /\| `agent\/skills\/`, `prompts\/`/);
});
