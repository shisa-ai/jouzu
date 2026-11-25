// Consistency checks for docs/language.md, docs/profiles.md, docs/subagents.md,
// and the bundled jouzu-reference pages against the source.
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
const referencePages = core.assets.filter((asset) => asset.target.startsWith("skills/jouzu-reference/"));

const configuration = assetText("skills/jouzu-reference/references/configuration.md");
const controls = assetText("skills/jouzu-reference/references/controls.md");
const history = assetText("skills/jouzu-reference/references/history.md");
const savedFiles = assetText("skills/jouzu-reference/references/saved-files.md");
const language = read("docs/language.md");
const profiles = read("docs/profiles.md");
const subagents = read("docs/subagents.md");

const sourceRoot = new URL("packages/cli/src/", repoRoot);
const sourceFiles = readdirSync(sourceRoot, { recursive: true })
	.filter((path) => path.endsWith(".ts"))
	.map((path) => ({ path, text: readFileSync(new URL(path, sourceRoot), "utf8") }));
const source = (path) => sourceFiles.find((file) => file.path === path)?.text ?? assert.fail(`missing source ${path}`);
const constantPattern = /\bconst ([A-Z][A-Z0-9_]*)\s*=\s*"([^"]+)"/g;
const sharedConstants = new Map();
for (const { text } of sourceFiles)
	for (const [, name, value] of text.matchAll(constantPattern))
		sharedConstants.set(name, sharedConstants.has(name) && sharedConstants.get(name) !== value ? null : value);

/**
 * Names joined directly onto a root, as `join(<x.>root, "name")`, a template literal, or a
 * SCREAMING_CASE constant. A template contributes its static prefix followed by `*`. Lower-case
 * arguments are runtime values and are skipped, so this finds the fixed names only.
 */
function rootEntries(root) {
	const entries = new Set();
	const pattern = new RegExp(
		`join\\(\\s*(?:[\\w.]+\\.)?${root},\\s*(?:"([^"]+)"|\`([^\`$]*)|([A-Z][A-Z0-9_]*)\\b)`,
		"g",
	);
	for (const { path, text } of sourceFiles) {
		const local = new Map([...text.matchAll(constantPattern)].map(([, name, value]) => [name, value]));
		for (const [, literal, template, constant] of text.matchAll(pattern)) {
			if (literal) entries.add(literal);
			else if (template !== undefined) entries.add(`${template}*`);
			else {
				const value = local.get(constant) ?? sharedConstants.get(constant);
				assert.ok(value, `${path}: cannot resolve ${constant} joined onto ${root}`);
				entries.add(value);
			}
		}
	}
	return entries;
}

/** Backticked names in the first column of a Markdown table section, without a trailing slash. */
function firstColumnNames(section) {
	const names = new Set();
	for (const row of section.split("\n").filter((line) => line.startsWith("| `")))
		for (const [, name] of row.split(" | ")[0].matchAll(/`([^`]+)`/g)) names.add(name.replace(/\/$/, ""));
	return names;
}

const between = (text, start, end) => {
	const from = text.indexOf(start);
	const to = text.indexOf(end, from);
	assert.ok(from >= 0 && to > from, `missing section ${start}`);
	return text.slice(from, to);
};

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

test("reference state map covers the fixed names source joins onto the state root", () => {
	const section = between(savedFiles, "## State root", "## Child runs");
	const listed = firstColumnNames(section);
	assert.ok(listed.size > 0, "saved-files.md state map has no rows");
	const allSource = sourceFiles.map((file) => file.text).join("\n");
	for (const name of listed)
		assert.ok(allSource.includes(`"${name}"`), `state map names ${name}, which no source names`);

	const written = rootEntries("stateDir");
	for (const name of ["sessions", "subagent-writers", "profile-migration-receipt.json", "model-picker.corrupt-*"])
		assert.ok(written.has(name), `state root scan missed ${name}`);
	for (const name of written) {
		if (name.endsWith(".lock")) continue;
		if (name.endsWith("*")) assert.ok(section.includes(`\`${name.slice(0, -1)}`), `state map is missing ${name}`);
		else assert.ok(listed.has(name), `state map is missing ${name}`);
	}
});

test("reference configuration table covers the fixed names source joins onto the configuration roots", () => {
	const listed = firstColumnNames(between(configuration, "Relative to the configuration root:", "## Language"));
	const config = rootEntries("configDir");
	const agent = rootEntries("agentDir");
	for (const name of ["session-labels.json", "dashboard-policy.json"])
		assert.ok(config.has(name), `configuration root scan missed ${name}`);
	assert.ok(agent.has("user-input-adapters.json"), "agent root scan missed user-input-adapters.json");
	for (const name of config) if (name !== "agent") assert.ok(listed.has(name), `configuration.md is missing ${name}`);
	for (const name of agent) assert.ok(listed.has(`agent/${name}`), `configuration.md is missing agent/${name}`);
});

test("reference trace and history claims match the source that makes them true", () => {
	// Each claim pairs documentation text with the source text that makes it true. A change to
	// either side fails here, so the other side gets reviewed; it does not prove the prose is complete.
	const claims = [
		// Current session and roots.
		[savedFiles, "`PI_SESSION_FILE` is unset when the session is not saved", null],
		[savedFiles, "read the `value` of the entry whose `id` is `paths.stateDir`", ["doctor.ts", '"paths.stateDir"']],
		[savedFiles, "`paths.sessionDir` (default session folder)", ["doctor.ts", '"paths.sessionDir"']],
		[
			savedFiles,
			"doctor and `PI_CODING_AGENT_SESSION_DIR` still name the default",
			["runtime.ts", "process.env.PI_CODING_AGENT_SESSION_DIR = paths.sessionDir;"],
		],
		[
			savedFiles,
			"Inside a child run, `PI_CODING_AGENT_SESSION_DIR` is that child's conversation folder",
			["subagents/resources.ts", "process.env.PI_CODING_AGENT_SESSION_DIR = launch.directory;"],
		],
		[savedFiles, "`sessions/` | Parent conversations, `<UTC timestamp>_<session-id>.jsonl`", null],
		// Child runs.
		[
			savedFiles,
			"`subagents/<parent-digest>/` holds one parent session's runs and its lock `owner.sqlite`",
			["subagents/manager.ts", 'join(paths.stateDir, "subagents", pathDigest(parentSessionId))'],
		],
		[
			savedFiles,
			"its lock `owner.sqlite`",
			["subagents/manager.ts", 'acquireProcessLock(join(this.root, "owner.sqlite"))'],
		],
		[savedFiles, "`run.json`: the run record", ["subagents/manager.ts", '"run.json"']],
		[savedFiles, "`events.jsonl`: execution output", ["subagents/manager.ts", '"events.jsonl"']],
		[
			savedFiles,
			"written at launch when parent lookup (`parentContext`, default on except for review-only roles) is on or context is `fork` or `splice`",
			["subagents/manager.ts", 'if (context.parentLookup || context.mode !== "fresh") {'],
		],
		[
			savedFiles,
			"default on except for review-only roles",
			["subagents/context.ts", "options.parentContext ?? !judging"],
		],
		[
			savedFiles,
			"The child gets the `parent_context` tool only when lookup is on",
			["subagents/worker.ts", "!side && launch.context?.parentLookup && launch.parentContextFile"],
		],
		[
			savedFiles,
			"A resumed run keeps the original snapshot and setting",
			["subagents/manager.ts", "run.parentContextFile = previous.parentContextFile;"],
		],
		[
			savedFiles,
			"A resumed run continues that file; its folder has no conversation",
			["subagents/manager.ts", "directory: sessionFile ? dirname(sessionFile) : this.directory(id)"],
		],
		[savedFiles, "the child's `flow/`", ["subagents/worker.ts", 'root: join(launch.directory, "flow")']],
		[
			savedFiles,
			"`/btw` side conversations are saved as runs too, but `subagent` does not list, read or trace them",
			["subagents/integration.ts", "runs: () => manager?.list().filter((run) => !run.purpose) ?? []"],
		],
		[
			history,
			'`op: "list"`, 20 runs per call, follow `nextOffset`',
			["subagents/integration.ts", "(params.offset ?? 0) + 20"],
		],
		[
			history,
			"`sessionFile`, `childSessionId`, `previousRunId`",
			["subagents/integration.ts", "sessionFile: run.sessionFile"],
		],
		[history, 'call `{"op":"acknowledge","batchId":', ["subagents/integration.ts", 'params.op === "acknowledge"']],
		// Flow folders.
		[
			savedFiles,
			"The parent's flow state is in `flow/` at the state root",
			["main-cli.ts", 'root: join(paths.stateDir, "flow")'],
		],
		[
			savedFiles,
			"`<branch-digest>/` per session branch: `schema.json`",
			["flow-control/local-storage.ts", '"schema.json"'],
		],
		[
			savedFiles,
			"the journal `sessions/flow/<UTC timestamp>_flow.jsonl`",
			["flow-control/local-storage.ts", "_flow.jsonl"],
		],
		[
			savedFiles,
			"`session-registry-v1/<registry-digest>/` per session",
			["flow-control/pi-session-registry.ts", 'join(root, "session-registry-v1")'],
		],
		[
			savedFiles,
			"a folder with only `owner.sqlite` recorded nothing",
			["flow-control/ownership.ts", "A directory with only its lock file is"],
		],
		// Folder names.
		[
			savedFiles,
			'`["<session-id>","<branch-id>"]`',
			["flow-control/ownership.ts", "pathDigest([sessionId, branchId])"],
		],
		[savedFiles, '`["<session-id>","registry"]`', ["flow-control/pi-session-registry.ts", 'branchId: "registry"']],
		[savedFiles, '`"<workspace real path>"`', ["subagents/manager.ts", "pathDigest(run.cwd)"]],
		[savedFiles, "`subagent-writers/<digest>.sqlite`", ["subagents/manager.ts", "cwd: realpathSync(launch.cwd)"]],
		[
			savedFiles,
			"Opening a session branch renames its 64-character flow folder when the short name is free",
			["flow-control/ownership.ts", "if (existsSync(directory)) return;"],
		],
	];
	for (const [doc, text, evidence] of claims) {
		assert.ok(doc.includes(text), `documentation is missing: ${text}`);
		if (evidence)
			assert.ok(source(evidence[0]).includes(evidence[1]), `${evidence[0]} no longer contains: ${evidence[1]}`);
	}

	for (const fragment of [
		"`paths.stateDir`",
		"`--session-dir`",
		"<UTC timestamp>_<session-id>.jsonl",
		"subagents/<parent-digest>/",
		"`run.json` (the run record)",
		"`events.jsonl` (its execution output)",
		"`parent-context.jsonl`",
		"`parent_context` tool only when parent lookup is on",
		"`sessionFile`",
		"`schema.json`",
		"`owner.sqlite`",
		"`session-registry-v1/`",
		"`PI_SESSION_FILE`",
		"`PI_SESSION_ID`",
		"`/btw`",
	])
		assert.ok(subagents.includes(fragment), `docs/subagents.md is missing ${fragment}`);

	const sha256 = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
	for (const value of ["00000000-0000-4000-8000-000000000000", ["session", "branch"], ["session", "registry"]]) {
		assert.equal(pathDigest(value), sha256(value).slice(0, 32));
		assert.equal(legacyPathDigest(value), sha256(value));
	}
	assert.ok(savedFiles.includes("SHA-256 over compact JSON text") && savedFiles.includes("used all 64 characters"));
});

test("reference configuration qualifies agent resource directories", () => {
	for (const path of ["agent/skills/", "agent/prompts/", "agent/extensions/", "agent/themes/"])
		assert.ok(configuration.includes(`\`${path}\``), `configuration.md is missing ${path}`);
	assert.doesNotMatch(configuration, /\| `agent\/skills\/`, `prompts\/`/);
	assert.ok(source("paths.ts").includes('stateDir = pathApi.join(applicationSupport, "state");'));
	assert.ok(configuration.includes("`~/Library/Application Support/Jouzu/state`"));
});

test("reference pages name every slash command Jouzu registers", () => {
	const text = referencePages.map((asset) => asset.bytes.toString("utf8")).join("\n");
	const commands = new Set(
		sourceFiles.flatMap(({ text: code }) =>
			[...code.matchAll(/registerCommand\("([a-z-]+)"/g)].map((match) => match[1]),
		),
	);
	assert.ok(commands.has("btw") && commands.has("flow"), "command scan found too little");
	for (const command of commands) assert.ok(text.includes(`\`/${command}`), `jouzu-reference never names /${command}`);
	assert.ok(controls.includes("`/btw`"));
});

test("reference tables keep one cell per column", () => {
	for (const asset of referencePages) {
		const lines = asset.bytes.toString("utf8").split("\n");
		for (let index = 0; index < lines.length; index++) {
			if (!/^\| --- (\| --- )*\|$/.test(lines[index])) continue;
			const columns = lines[index].split("|").length;
			const rows = [index - 1];
			for (let row = index + 1; lines[row]?.startsWith("|"); row++) rows.push(row);
			// An unescaped pipe, even inside backticks, starts a new cell.
			for (const row of rows)
				assert.equal(lines[row].split("|").length, columns, `${asset.target}:${row + 1}: ${lines[row]}`);
		}
	}
});
