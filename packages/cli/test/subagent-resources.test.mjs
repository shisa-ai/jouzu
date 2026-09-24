import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configureChildResources, expandedChildResourceLoader } from "../dist/subagents/resources.js";
import { defaultAgentConfig } from "../dist/subagents/roles.js";

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
	configureChildResources(launch);
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
		"schedule_prompt",
		"multiloop_start",
	])
		assert.ok(tools.includes(name), `missing released tool: ${name}`);
	const skills = loader.getSkills().skills.map((skill) => skill.name);
	assert.ok(skills.includes("local-skill"));
	assert.ok(skills.includes("jouzu-clear-writing"));
	assert.ok(skills.includes("multiloop"));
	assert.match(JSON.stringify(loader.getAgentsFiles()), /CHILD_PROJECT_GUIDANCE/);
	assert.match(loader.getAppendSystemPrompt().join("\n"), /not a filesystem sandbox/);
	assert.equal(readFileSync(join(cwd, ".pi", "tasks.json"), "utf8"), "PARENT_TASKS_UNCHANGED");
	assert.deepEqual(readdirSync(join(cwd, ".pi")), ["tasks.json"]);
	const review = await expandedChildResourceLoader({ ...launch, role: { ...launch.role, judging: true } }, policy);
	assert.deepEqual(review.getAgentsFiles().agentsFiles, []);
});
