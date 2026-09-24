import assert from "node:assert/strict";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createScheduleWaitSource } from "../dist/flow-control/schedule-waits.js";
import { configureChildResources, expandedChildResourceLoader } from "../dist/subagents/resources.js";
import { defaultAgentConfig } from "../dist/subagents/roles.js";

test("invalid child schedule state is preserved with a warning and cannot block restored waits", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-child-schedule-recovery-"));
	const previous = { ...process.env };
	t.after(() => {
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
		rmSync(root, { recursive: true, force: true });
	});
	const unsafe = join(root, "unsafe");
	mkdirSync(unsafe);
	writeFileSync(join(unsafe, ".pi"), "PRESERVE");
	assert.throws(() => configureChildResources({ directory: unsafe }), /must be a real directory/);
	assert.equal(readFileSync(join(unsafe, ".pi"), "utf8"), "PRESERVE");
	for (const [name, data] of [
		["json", "{"],
		["format", '{"version":2,"jobs":[]}'],
		["job", '{"version":1,"jobs":[{"enabled":true}]}'],
		["large", "x".repeat(4 * 1024 * 1024 + 1)],
		["directory", null],
	]) {
		const directory = join(root, name);
		const state = join(directory, ".pi");
		mkdirSync(state, { recursive: true });
		const file = join(state, "schedule-prompts.json");
		if (data === null) mkdirSync(file);
		else writeFileSync(file, data);
		const warnings = [];
		assert.equal(
			configureChildResources({ directory }, (text) => warnings.push(text)),
			0,
		);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /Preserved at .*\.invalid-/);
		assert.equal(existsSync(file), false);
		const backup = join(
			state,
			readdirSync(state).find((name) => name.startsWith("schedule-prompts.json.invalid-")),
		);
		if (data === null) assert.ok(lstatSync(backup).isDirectory());
		else assert.equal(readFileSync(backup, "utf8"), data);
		const identity = {
			scope: { sessionId: "child", branchId: "branch" },
			workId: "work",
			handle: "old",
			execution: "old@date",
		};
		const source = createScheduleWaitSource({
			cwd: directory,
			events: {},
			attachment: {
				waits: { authoritySnapshot: async () => ({ executions: [{ producer: "schedule", ...identity }] }) },
			},
			onError(error) {
				throw error;
			},
		});
		assert.deepEqual((await source.snapshot(identity, new AbortController().signal)).predicates, [
			{ until: "first-trigger", state: "cancelled" },
		]);
		assert.equal(
			configureChildResources({ directory }, (text) => warnings.push(text)),
			0,
		);
		assert.equal(warnings.length, 1, "resume does not process quarantined data again");
	}
});

// Worker-only process settings are changed in this test process, never in the parent runner.
test("child resources retain released tools and skills without reopening project automation", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-child-resources-"));
	const cwd = join(root, "workspace");
	const directory = join(root, "child");
	const userAgentDir = join(root, "user-agent");
	for (const path of [cwd, directory, userAgentDir]) mkdirSync(path);
	writeFileSync(join(cwd, "AGENTS.md"), "CHILD_PROJECT_GUIDANCE");
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "tasks.json"), "PARENT_TASKS_UNCHANGED");
	mkdirSync(join(userAgentDir, "skills", "local-skill"), { recursive: true });
	writeFileSync(
		join(userAgentDir, "skills", "local-skill", "SKILL.md"),
		"---\nname: local-skill\ndescription: Local fixture skill\n---\nLOCAL_SKILL_EVIDENCE\n",
	);
	const previous = { ...process.env };
	t.after(() => {
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
		rmSync(root, { recursive: true, force: true });
	});
	const launch = {
		cwd,
		directory,
		userAgentDir,
		role: { ...defaultAgentConfig().roles[1], judging: false },
		model: { id: "fixture" },
	};
	mkdirSync(join(directory, ".pi"));
	const savedSchedules = {
		version: 1,
		jobs: [
			{ id: "future", createdAt: "2026-01-01T00:00:00Z", enabled: true, schedule: "2099-01-01T00:00:00Z", runCount: 0 },
			{ id: "disabled", createdAt: "2026-01-01T00:00:00Z", enabled: false, runCount: 2 },
		],
	};
	writeFileSync(join(directory, ".pi", "schedule-prompts.json"), JSON.stringify(savedSchedules));
	assert.equal(configureChildResources(launch), 1);
	const stoppedSchedules = JSON.parse(readFileSync(join(directory, ".pi", "schedule-prompts.json"), "utf8"));
	assert.deepEqual(
		stoppedSchedules.jobs,
		savedSchedules.jobs.map((job) => ({ ...job, enabled: false })),
	);
	const stored = readFileSync(join(directory, ".pi", "schedule-prompts.json"), "utf8");
	assert.equal(configureChildResources(launch), 0);
	assert.equal(readFileSync(join(directory, ".pi", "schedule-prompts.json"), "utf8"), stored);
	const scheduleSource = createScheduleWaitSource({
		cwd: directory,
		events: {},
		attachment: {},
		onError(error) {
			throw error;
		},
	});
	const evidence = await scheduleSource.snapshot(
		{
			scope: { sessionId: "child", branchId: "branch" },
			workId: "work",
			handle: "future",
			execution: "future@2026-01-01T00:00:00Z",
		},
		new AbortController().signal,
	);
	assert.deepEqual(evidence.predicates, [{ until: "first-trigger", state: "cancelled" }]);
	assert.equal(process.env.PI_CODING_AGENT_DIR, directory);
	assert.equal(process.env.PI_TASKS, join(directory, "tasks.json"));
	assert.equal(JSON.parse(readFileSync(join(directory, "tasks-config.json"))).taskScope, "session");
	assert.equal(JSON.parse(readFileSync(join(directory, "pi-vcc-config.json"))).continueAfterThresholdCompact, false);
	const policy = { filterSkills: async (skills) => skills };
	const scopes = [];
	const loader = await expandedChildResourceLoader(launch, policy, [
		{
			name: "jouzu-task-controller",
			factory(pi) {
				pi.on("session_start", (_event, ctx) => {
					scopes.push(["event", ctx.cwd]);
				});
				pi.registerCommand("scope-probe", {
					handler: async (_args, ctx) => {
						scopes.push(["command", ctx.cwd]);
					},
				});
				pi.registerTool({
					name: "scope_probe",
					label: "Scope probe",
					description: "Fixture scope probe",
					parameters: { type: "object", properties: {} },
					execute: async (_id, _args, _signal, _update, ctx) => {
						scopes.push(["tool", ctx.cwd]);
						return { content: [], details: {} };
					},
				});
			},
		},
	]);
	const scoped = loader
		.getExtensions()
		.extensions.find((extension) => extension.path === "<inline:jouzu-task-controller>");
	const context = { cwd };
	await scoped.handlers.get("session_start")[0]({}, context);
	await scoped.commands.get("scope-probe").handler("", context);
	await scoped.tools.get("scope_probe").definition.execute("probe", {}, undefined, undefined, context);
	assert.deepEqual(scopes, [
		["event", directory],
		["command", directory],
		["tool", directory],
	]);
	assert.equal(context.cwd, cwd);
	assert.equal(loader.contentPolicy, policy);
	const tools = loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]);
	for (const name of [
		"web_fetch",
		"tff-search_web",
		"vcc_recall",
		"compact_context",
		"TaskCreate",
		"TaskExecute",
		"bg_task",
		"multiloop_start",
	])
		assert.ok(tools.includes(name), `missing released tool: ${name}`);
	assert.ok(!tools.includes("schedule_prompt"));
	assert.ok(!tools.includes("subagent"));
	assert.ok(loader.getExtensions().extensions.every((extension) => !extension.commands.has("schedule-prompt")));
	const skills = loader.getSkills().skills.map((skill) => skill.name);
	assert.ok(skills.includes("local-skill"));
	assert.ok(skills.includes("jouzu-clear-writing"));
	assert.ok(skills.includes("multiloop"));
	assert.match(JSON.stringify(loader.getAgentsFiles()), /CHILD_PROJECT_GUIDANCE/);
	assert.match(loader.getAppendSystemPrompt().join("\n"), /not a filesystem sandbox/);
	assert.equal(readFileSync(join(cwd, ".pi", "tasks.json"), "utf8"), "PARENT_TASKS_UNCHANGED");
	assert.deepEqual(readdirSync(join(cwd, ".pi")), ["tasks.json"]);
	assert.match(loader.getAppendSystemPrompt().join("\n"), /Scheduling and delegation belong to the parent/);
	const review = await expandedChildResourceLoader({ ...launch, role: { ...launch.role, judging: true } }, policy);
	assert.deepEqual(review.getAgentsFiles().agentsFiles, []);
	assert.ok(
		review
			.getExtensions()
			.extensions.every((extension) => !extension.tools.has("schedule_prompt") && !extension.tools.has("subagent")),
	);
});
