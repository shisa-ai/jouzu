import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assistantToolCalls } from "../../../scripts/fixtures/pi-flow-session.mjs";
import {
	afterFlowCleanup,
	assembledSession,
	capturedNotices,
	installedProducerExtensions,
	installedTaskExtension,
	replacedSession,
} from "./fixtures/flow-assembly.mjs";
import { controlledBackground } from "./fixtures/flow-background-gate.mjs";
import { waitDependencyFrom } from "./fixtures/flow-wait-dependency.mjs";

async function setup(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-task-adapter-"));
	afterFlowCleanup(t, () => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, ".pi"));
	await writeFile(
		join(root, ".pi/tasks-config.json"),
		JSON.stringify({ autoMode: "cascade", autoClearCompleted: "never" }),
	);
	const taskFile = join(root, "tasks.json");
	const producerExtensions = [...(await installedProducerExtensions()), await installedTaskExtension(taskFile)];
	return { root, taskFile, producerExtensions };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
async function until(f, predicate) {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await tick();
	}
	assert.fail(
		JSON.stringify({
			flow: f.errors,
			agent: f.session.agent.state.errorMessage,
			bodies: f.bodies.length,
			inspect: await f.ingress.inspect(),
		}),
	);
}
const call = (name, args) => assistantToolCalls({ name, arguments: args });
const messages = (f) =>
	f.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
		.map((entry) => entry.message);

test("flow reports installed task titles and unfinished dependencies without changing task state", async (t) => {
	const f = await assembledSession(t, {
		...(await setup(t)),
		script: [
			call("TaskCreate", { subject: "Validate shard evidence", description: "Check artifacts" }),
			call("TaskCreate", { subject: "Execute two GPU shards", description: "Wait for validated evidence" }),
			call("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] }),
			call("TaskUpdate", { taskId: "1", paused: true }),
			{ text: "Waiting." },
		],
	});
	await f.session.prompt("Create the task dependencies and pause the first task.");
	await f.session.waitForIdle();
	const notices = capturedNotices(f.session);
	const before = await readFile(f.taskFile ?? join(f.root, "tasks.json"), "utf8");
	const requests = f.bodies.length;
	await f.session.prompt("/flow");
	const text = notices.at(-1).text;
	assert.match(text, /Task #1: Validate shard evidence/);
	assert.match(text, /Paused in task settings/);
	assert.match(text, /Task #2: Execute two GPU shards/);
	assert.match(text, /Waiting for task #1/);
	assert.doesNotMatch(text, /Producer state changed|tasks-work:/);
	await f.session.prompt("/flow details");
	assert.match(notices.at(-1).text, /tasks-work:/);
	assert.equal(f.bodies.length, requests);
	assert.equal(await readFile(join(f.root, "tasks.json"), "utf8"), before);
	assert.deepEqual(f.errors, []);
});

test("installed task continuation owns background execution and waits", { timeout: 20000 }, async (t) => {
	const setupData = await setup(t);
	const background = await controlledBackground(t);
	let phase = 0,
		workId;
	const f = await assembledSession(t, {
		...setupData,
		persist: true,
		script: (body) => {
			switch (phase++) {
				case 0:
					return call("TaskCreate", { subject: "Probe", description: "Run a background probe" });
				case 1:
					return { text: "Task created" };
				case 2:
					return call("bg_task", { action: "spawn", command: background.command });
				case 3: {
					const dependency = waitDependencyFrom(body);
					assert.ok(dependency, "task continuation has background execution authority");
					workId = dependency.work.id;
					return call("agent_wait", {
						work: workId,
						reason: "Wait for probe",
						deadline: "30m",
						on: [
							{
								producer: dependency.producer,
								handle: dependency.handle,
								execution: dependency.execution,
								until: dependency.until,
							},
						],
					});
				}
				case 4:
					return { text: "Waiting for probe" };
				case 5:
					return call("TaskUpdate", { taskId: "1", status: "completed" });
				default:
					return { text: "Completed" };
			}
		},
	});
	await f.session.prompt("Create and run the probe task");
	await until(f, () => phase >= 5);
	const before = f.bodies.length;
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(f.bodies.length, before, "waiting task produces no continuation requests");
	const work = (await f.ingress.branch().attachment.waits.authoritySnapshot()).work.find((work) => work.id === workId);
	assert.equal(work.owner, "tasks");
	assert.ok(work.origin?.id.startsWith("user:"));
	await background.release();
	await until(f, () => phase >= 7);
	await f.session.waitForIdle();
	assert.equal(f.bodies.length, 7);
	assert.deepEqual(f.errors, []);
	assert.ok(
		messages(f).every((message) => !message.isError),
		JSON.stringify(messages(f)),
	);
});

for (const health of [false, true])
	test(`task waits on its user turn's background job using the returned dependency (health=${health})`, {
		timeout: 20000,
	}, async (t) => {
		const background = await controlledBackground(t);
		let dependency;
		const f = await assembledSession(t, {
			...(await setup(t)),
			persist: true,
			script: (body, index) => {
				if (index === 0) return call("bg_task", { action: "spawn", command: background.command, notifyOnExit: true });
				if (index === 1) {
					dependency = waitDependencyFrom(body);
					return call("TaskCreate", { subject: "Analyze job", description: "Wait for the existing job" });
				}
				if (index === 2) return { text: "Task ready" };
				if (index === 3)
					return call("agent_wait", {
						reason: "The analysis needs the running job's output",
						deadline: "30m",
						on: [{ ...dependency, health: health ? dependency.health : undefined }],
					});
				if (index === 4) return { text: "Waiting for the job" };
				if (index === 5) return call("TaskUpdate", { taskId: "1", status: "completed" });
				return { text: "Analyzed completed job" };
			},
		});
		await f.session.prompt("Start a job and create its analysis task");
		await until(f, () => f.bodies.length >= 5);
		const waitResult = messages(f).find((message) => message.toolName === "agent_wait");
		assert.equal(waitResult?.isError, false, JSON.stringify(waitResult));
		const waits = await f.ingress.branch().attachment.waits.snapshot();
		assert.equal(waits.length, 1);
		assert.equal(waits[0].state, "waiting");
		assert.notEqual(waits[0].workId, dependency.work.id);
		const authority = await f.ingress.branch().attachment.waits.authoritySnapshot();
		assert.equal(authority.work.find((work) => work.id === waits[0].workId).origin.id, dependency.work.id);
		assert.equal(
			authority.executions[0].workId,
			dependency.work.id,
			"observing a parent job does not transfer ownership",
		);
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(f.bodies.length, 5, "the waiting task must not churn continuations");
		await background.release();
		await until(f, () => f.bodies.length >= 7);
		await f.session.waitForIdle();
		assert.equal(f.bodies.length, 7);
		assert.ok(
			messages(f).every((message) => !message.isError),
			JSON.stringify(messages(f)),
		);
		assert.deepEqual(f.errors, []);
	});

for (const reverseExtensions of [false, true])
	test(`tree navigation reconnects installed task tools (reverse bridges=${reverseExtensions})`, {
		timeout: 20000,
	}, async (t) => {
		const setupData = await setup(t);
		const hosts = [];
		setupData.producerExtensions.unshift({
			name: "capture-task-host",
			factory(pi) {
				pi.events.on("jouzu:task-flow", (request) => {
					const accept = request.accept;
					request.accept = (host) => {
						hosts.push(host);
						accept(host);
					};
				});
			},
		});
		const f = await assembledSession(t, {
			...setupData,
			reverseExtensions,
			persist: true,
			script: [
				call("TaskCreate", { subject: "Preserved", description: "Keep the saved task" }),
				call("TaskUpdate", { taskId: "1", paused: true }),
				{ text: "Paused" },
				call("TaskList", {}),
				call("TaskCreateMany", { tasks: [{ subject: "New branch", description: "New work" }] }),
				call("TaskUpdate", { taskId: "2", status: "completed" }),
				call("TaskUpdate", { taskId: "1", status: "in_progress", paused: false }),
				call("TaskUpdate", { taskId: "1", status: "completed" }),
				{ text: "Completed" },
			],
		});
		await f.session.prompt("Create and pause a task");
		await f.session.waitForIdle();
		const saved = await readFile(setupData.taskFile, "utf8");
		const original = f.ingress.branch();
		const oldHost = hosts[0];
		await f.session.navigateTree(f.sessionManager.getLeafId());
		assert.equal(hosts.length, 1, "no-op navigation keeps the attachment");
		const user = f.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		await f.session.navigateTree(user.id);
		assert.notEqual(f.ingress.branch(), original);
		assert.equal(await readFile(setupData.taskFile, "utf8"), saved, "navigation preserves the paused task");
		await f.session.prompt("List the saved task, create new work, and complete both");
		await f.session.waitForIdle();
		assert.ok(
			messages(f).every((message) => !message.isError),
			JSON.stringify(messages(f)),
		);
		assert.equal(hosts.length, 2, "tree navigation reconnects without a session restart");
		await assert.rejects(oldHost.ready(), /Task branch attachment changed/);
		await assert.rejects(
			oldHost.tool("TaskList", {}, () => assert.fail("stale tool must not execute")),
			/Task branch attachment changed/,
		);
		assert.equal(JSON.parse(saved).tasks[0].subject, "Preserved");
		assert.deepEqual(
			JSON.parse(await readFile(setupData.taskFile, "utf8")).tasks.map((task) => task.status),
			["completed", "completed"],
		);
		assert.equal(f.bodies.length, 9);
		assert.deepEqual(f.errors, []);
	});

test("tree navigation discards queued TaskExecute context and permits fresh task continuation", {
	timeout: 20000,
}, async (t) => {
	const setupData = await setup(t);
	const staleContext = "ONLY-FOR-THE-ABANDONED-BRANCH";
	let f;
	f = await assembledSession(t, {
		...setupData,
		persist: true,
		script: (_body, index) => {
			if (index === 0)
				return call("TaskCreateMany", {
					tasks: [
						{ subject: "First", description: "First task" },
						{ subject: "Second", description: "Second task" },
					],
				});
			if (index === 1) return call("TaskExecute", { task_ids: ["1", "2"], additional_context: staleContext });
			if (index === 2) {
				f.ingress.pauseAutomated("Hold the queued task before navigation");
				return { text: "Queued" };
			}
			if (index === 3) return call("TaskUpdate", { taskId: "1", status: "in_progress" });
			if (index === 5) return call("TaskUpdate", { taskId: "1", status: "completed" });
			return { text: "Done" };
		},
	});
	await f.session.prompt("Schedule both tasks with branch-specific context");
	await f.session.waitForIdle();
	assert.equal(f.bodies.length, 3);
	const original = f.ingress.branch();
	assert.ok(original.controller.view().producers.includes("tasks"));
	const saved = await readFile(setupData.taskFile, "utf8");
	const user = f.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
	await f.session.navigateTree(user.id);
	assert.equal(await readFile(setupData.taskFile, "utf8"), saved, "navigation preserves stored tasks");
	assert.equal(f.bodies.length, 3, "navigation does not start unbound tasks");
	await f.session.prompt("Start only the first saved task on this branch");
	await until(f, () => f.bodies.length >= 7);
	await f.session.waitForIdle();
	assert.equal(f.bodies.length, 7);
	assert.ok(f.bodies.slice(3).every((body) => !JSON.stringify(body).includes(staleContext)));
	const tasks = JSON.parse(await readFile(setupData.taskFile, "utf8")).tasks;
	assert.deepEqual(
		tasks.map((task) => task.status),
		["completed", "pending"],
	);
	assert.ok(
		messages(f).every((message) => !message.isError),
		JSON.stringify(messages(f)),
	);
	assert.deepEqual(f.errors, []);
});

for (const control of ["waitForUser", "paused"])
	test(`task ${control} holds automation until explicitly cleared`, { timeout: 20000 }, async (t) => {
		const setupData = await setup(t);
		let phase = 0;
		const f = await assembledSession(t, {
			...setupData,
			script: () => {
				switch (phase++) {
					case 0:
						return call("TaskCreate", { subject: "Blocked", description: "Needs input" });
					case 1:
						return call("TaskUpdate", { taskId: "1", [control]: true });
					case 2:
						return { text: "Waiting for input" };
					case 3:
						return call("TaskUpdate", { taskId: "1", status: "in_progress", [control]: false });
					case 4:
						return { text: "Input received" };
					case 5:
						return call("TaskUpdate", { taskId: "1", status: "completed" });
					default:
						return { text: "Completed" };
				}
			},
		});
		await f.session.prompt("Create a task that needs input");
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(f.bodies.length, 3);
		await f.session.prompt("The input is available; resume the task");
		await until(f, () => phase >= 7);
		await f.session.waitForIdle();
		assert.equal(f.bodies.length, 7);
		assert.ok(
			messages(f).every((message) => !message.isError),
			JSON.stringify(messages(f)),
		);
		assert.deepEqual(f.errors, []);
	});

test("task continuations stop after three admitted attempts without task progress", { timeout: 15000 }, async (t) => {
	const setupData = await setup(t);
	const f = await assembledSession(t, {
		...setupData,
		script: (_body, index) =>
			index === 0
				? call("TaskCreate", { subject: "Unchanged", description: "No progress fixture" })
				: { text: "No task changes" },
	});
	await f.session.prompt("Create the task");
	await until(f, () => f.bodies.length >= 5);
	await f.session.waitForIdle();
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(f.bodies.length, 5, "two initial requests and three admitted continuations");
	assert.deepEqual(f.errors, []);
});

test("a completed dependency releases the next task with its own work identity", { timeout: 15000 }, async (t) => {
	const setupData = await setup(t);
	const f = await assembledSession(t, {
		...setupData,
		script: (_body, index) => {
			if (index === 0)
				return call("TaskCreateMany", {
					tasks: [
						{ subject: "First", description: "First task" },
						{ subject: "Second", description: "Depends on first" },
					],
				});
			if (index === 1) return call("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });
			if (index === 2) return { text: "Tasks ready" };
			if (index === 3) return call("TaskUpdate", { taskId: "1", status: "completed" });
			if (index === 5) return call("TaskUpdate", { taskId: "2", status: "completed" });
			return { text: "Task complete" };
		},
	});
	await f.session.prompt("Run two dependent tasks");
	await until(f, () => f.bodies.length >= 7);
	await f.session.waitForIdle();
	const attempts = (await f.ingress.branch().attachment.ledger.snapshot()).attempts.filter(
		(attempt) => attempt.admission?.choice.intent.producer === "tasks",
	);
	assert.equal(attempts.length, 2);
	assert.notEqual(attempts[0].admission.choice.intent.workId, attempts[1].admission.choice.intent.workId);
	assert.ok(
		messages(f).every((message) => !message.isError),
		JSON.stringify(messages(f)),
	);
	assert.deepEqual(f.errors, []);
});

for (const interactive of [false, true])
	test(`session resume preserves task work (interactive=${interactive})`, {
		timeout: 20000,
	}, async (t) => {
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const { replacedSession } = await import("./fixtures/flow-assembly.mjs");
		const setupData = await setup(t);
		let f;
		f = await assembledSession(t, {
			...setupData,
			interactive,
			persist: true,
			script: (_body, index) => {
				if (index === 0) return call("TaskCreate", { subject: "Resume", description: "Continue after resume" });
				f.ingress.pauseAutomated("a turn was interrupted");
				return { text: "Interrupted before task continuation" };
			},
		});
		await f.session.prompt("Create a resumable task");
		await f.session.waitForIdle();
		assert.equal(f.bodies.length, 2);
		const original = (await f.ingress.branch().attachment.waits.authoritySnapshot()).work.find(
			(work) => work.owner === "tasks",
		);

		const next = await replacedSession(t, f, {
			reason: "resume",
			persist: true,
			sessionManager: SessionManager.open(f.sessionManager.getSessionFile()),
			producerExtensions: setupData.producerExtensions,
			script: (_body, index) =>
				index === 0 ? call("TaskUpdate", { taskId: "1", status: "completed" }) : { text: "Completed after resume" },
		});
		if (interactive) {
			assert.equal(next.ingress.automatedPause(), "the session was reopened");
			await next.ingress.releaseReady();
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(next.bodies.length, 0, "startup task continuations remain held");
			await next.session.prompt("/flow");
			assert.equal(next.ingress.automatedPause(), "the session was reopened");
			assert.equal(next.bodies.length, 0, "inspection does not resume automation");
			await next.session.prompt("/flow resume");
		}
		await until(next, () => next.bodies.length >= 2);
		await next.session.waitForIdle();
		const attempts = (await next.ingress.branch().attachment.ledger.snapshot()).attempts.filter(
			(attempt) => attempt.admission?.choice.intent.producer === "tasks",
		);
		assert.equal(attempts.at(-1).admission.choice.intent.workId, original.id);
		assert.ok(
			messages(next).every((message) => !message.isError),
			JSON.stringify(messages(next)),
		);
		assert.deepEqual(next.errors, []);
	});

test("an unadapted extension turn cannot borrow preceding user authority to create task work", {
	timeout: 15000,
}, async (t) => {
	const setupData = await setup(t);
	const f = await assembledSession(t, {
		...setupData,
		script: (_body, index) =>
			index === 1
				? call("TaskCreate", { subject: "Foreign", description: "Unadapted extension work" })
				: { text: "Done" },
	});
	await f.session.prompt("A prior authorized user turn");
	await f.session.sendCustomMessage(
		{ customType: "unadapted", content: "Continue by working on task #1", display: true },
		{ triggerTurn: true },
	);
	await f.session.waitForIdle();
	assert.equal(f.bodies.length, 3);
	assert.ok(
		messages(f).some((message) => message.isError && JSON.stringify(message.content).includes("authorized invocation")),
	);
	assert.ok(
		!(await f.ingress.branch().attachment.waits.authoritySnapshot()).work.some((work) => work.owner === "tasks"),
	);
	assert.deepEqual(f.errors, []);
});

const backgroundSpawns = (f) => messages(f).filter((message) => message.toolName === "bg_task" && !message.isError);
const deliveredResult = (f, index) => JSON.stringify(f.bodies[index] ?? {}).includes("bg-result:");

test("a background completion turn keeps the work that owns the job it answers", {
	timeout: 30000,
}, async (t) => {
	const setupData = await setup(t);
	let phase = 0;
	const f = await assembledSession(t, {
		...setupData,
		script: () => {
			switch (phase++) {
				case 0:
					return call("bg_task", { action: "spawn", command: "true", notifyOnExit: true, notifyOnOutput: false });
				case 1:
					return { text: "The job is running." };
				case 2:
					return assistantToolCalls(
						{
							name: "TaskCreate",
							arguments: { subject: "Follow up on the completed job", description: "Created in a completion turn" },
						},
						{
							name: "bg_task",
							arguments: { action: "spawn", command: "true", notifyOnExit: false, notifyOnOutput: false },
						},
					);
				default:
					return { text: "Recorded the completion and started the follow-up." };
			}
		},
	});
	await f.session.prompt("Start a background job and report when it finishes.");
	await until(f, () => backgroundSpawns(f).length >= 2);
	await f.session.waitForIdle();
	assert.ok(
		messages(f).every((message) => !message.isError),
		JSON.stringify(messages(f)),
	);
	assert.ok(deliveredResult(f, 2), "the second model request delivers the completed job");
	const [first, second] = backgroundSpawns(f);
	assert.match(first.details.task.flow.work.id, /^user:/, "the user turn owns the job it started");
	assert.equal(
		second.details.task.flow.work.id,
		first.details.task.flow.work.id,
		"the completion turn answers on that same work",
	);
	const authority = await f.ingress.branch().attachment.waits.authoritySnapshot();
	assert.deepEqual(
		authority.work.filter((work) => work.owner === "host-automatic"),
		[],
	);
	const tasks = JSON.parse(await readFile(setupData.taskFile, "utf8"));
	assert.ok(JSON.stringify(tasks).includes("Follow up on the completed job"), "a completion turn can create task work");
	assert.deepEqual(f.errors, []);
});

test("a completion turn whose owning work finished runs on host work", { timeout: 30000 }, async (t) => {
	const setupData = await setup(t);
	let phase = 0;
	const f = await assembledSession(t, {
		...setupData,
		script: () => {
			switch (phase++) {
				case 0:
					return call("TaskCreate", { subject: "Own the long job", description: "Its job outlives it" });
				case 1:
					return { text: "The task is ready." };
				case 2:
					return call("bg_task", { action: "spawn", command: "sleep 1", notifyOnExit: true, notifyOnOutput: false });
				case 3:
					return call("TaskUpdate", { taskId: "1", status: "completed" });
				case 4:
					return { text: "The task is complete." };
				case 5:
					return assistantToolCalls(
						{
							name: "TaskCreate",
							arguments: { subject: "Follow up after the task ended", description: "Created in a completion turn" },
						},
						{
							name: "bg_task",
							arguments: { action: "spawn", command: "true", notifyOnExit: false, notifyOnOutput: false },
						},
					);
				default:
					return { text: "Recorded the completion and started the follow-up." };
			}
		},
	});
	await f.session.prompt("Run a background job inside a task that finishes before it does.");
	await until(f, () => backgroundSpawns(f).length >= 2);
	await f.session.waitForIdle();
	assert.ok(
		messages(f).every((message) => !message.isError),
		JSON.stringify(messages(f)),
	);
	assert.ok(deliveredResult(f, 5), "the delivery turn follows the task that owned the job");
	const [first, second] = backgroundSpawns(f);
	const authority = await f.ingress.branch().attachment.waits.authoritySnapshot();
	assert.match(first.details.task.flow.work.id, /^tasks-work:/, "the task turn owns the job it started");
	assert.equal(
		authority.work.find((work) => work.id === first.details.task.flow.work.id).lifecycle.state,
		"completed",
		"the job outlived the task that started it",
	);
	const automatic = authority.work.filter((work) => work.owner === "host-automatic");
	assert.equal(automatic.length, 1, "one reusable host work identity per branch");
	assert.deepEqual(automatic[0].participants, ["host-automatic", "bg", "tasks"]);
	assert.equal(second.details.task.flow.work.id, automatic[0].id, "the completion turn owns the job it started");
	const tasks = JSON.parse(await readFile(setupData.taskFile, "utf8"));
	assert.ok(
		JSON.stringify(tasks).includes("Follow up after the task ended"),
		"a completion turn can create task work after its own work ended",
	);
	assert.deepEqual(f.errors, []);
});

test("an existing unbound task requires an explicit start from an authorized turn", { timeout: 15000 }, async (t) => {
	const setupData = await setup(t);
	await writeFile(
		setupData.taskFile,
		JSON.stringify({
			nextId: 2,
			tasks: [
				{
					id: "1",
					subject: "Imported",
					description: "Previously saved task",
					status: "pending",
					createdAt: 1,
					updatedAt: 1,
					blockedBy: [],
					blocks: [],
					metadata: {},
				},
			],
		}),
	);
	const f = await assembledSession(t, {
		...setupData,
		script: (_body, index) =>
			index === 0
				? call("TaskExecute", { task_ids: ["1"] })
				: index === 2
					? call("TaskUpdate", { taskId: "1", status: "completed" })
					: { text: "Done" },
	});
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(f.bodies.length, 0, "saved task text cannot create authority on attachment");
	const bridge = f.flow.extensions.find((extension) => extension.name === "jouzu-task-controller");
	assert.equal(bridge.unboundTasks().length, 1);
	await f.session.prompt("Start the saved task");
	await until(f, () => f.bodies.length >= 4);
	await f.session.waitForIdle();
	assert.equal(f.bodies.length, 4);
	assert.ok(
		messages(f).every((message) => !message.isError),
		JSON.stringify(messages(f)),
	);
	assert.deepEqual(f.errors, []);
});

test("task completion after queue consumption prevents a stale provider request", { timeout: 15000 }, async (t) => {
	const setupData = await setup(t);
	let completed = false;
	setupData.producerExtensions.push({
		name: "late-task-completion",
		factory(pi) {
			pi.on("message_start", async (event) => {
				if (completed || event.message.role !== "custom" || event.message.customType !== "jouzu-flow") return;
				completed = true;
				const saved = JSON.parse(await readFile(setupData.taskFile, "utf8"));
				saved.tasks[0].status = "completed";
				saved.tasks[0].updatedAt++;
				await writeFile(setupData.taskFile, JSON.stringify(saved));
			});
		},
	});
	const f = await assembledSession(t, {
		...setupData,
		script: (_body, index) =>
			index === 0
				? call("TaskCreate", { subject: "Late completion", description: "Complete before transport" })
				: { text: "Done" },
	});
	await f.session.prompt("Create the task");
	await until(f, () => completed);
	await f.session.waitForIdle();
	assert.equal(f.bodies.length, 2, "completed task sends no stale continuation to the provider");
	await f.session.prompt("Explain the completed task");
	assert.equal(f.bodies.length, 3);
	assert.deepEqual(f.errors, []);
	assert.equal(f.ingress.automatedPause(), undefined);
});

test("stale task cancellation preserves joined results through provider delivery and reopen", {
	timeout: 15000,
}, async (t) => {
	const setupData = await setup(t);
	let capturedSource;
	const queuedUser = "保存する user instruction arriving during cancellation";
	let completed = false,
		offer = false;
	setupData.producerExtensions.push({
		name: "complete-task-with-results",
		factory(pi) {
			pi.on("message_start", async (event) => {
				if (completed || event.message.role !== "custom" || event.message.customType !== "jouzu-flow") return;
				completed = true;
				capturedSource = structuredClone(event.message);
				const saved = JSON.parse(await readFile(setupData.taskFile, "utf8"));
				saved.tasks[0].status = "completed";
				await writeFile(setupData.taskFile, JSON.stringify(saved));
				await f.session.followUp(queuedUser);
			});
		},
	});
	const f = await assembledSession(t, {
		...setupData,
		persist: true,
		script: (_body, index) => {
			if (index === 0)
				return call("TaskCreate", { subject: "Stale with results", description: "Cancel only this work" });
			if (index === 1) offer = true;
			return { text: "Received" };
		},
	});
	const result = {
		id: "important",
		revision: "1",
		producer: "preserve",
		execution: "exec-important",
		status: "failure",
		title: "重要な結果",
		reference: "log:important",
		warnings: ["Do not lose this warning"],
	};
	const registration = f.ingress.registerProducer({
		version: 1,
		namespace: "preserve",
		snapshot: async () =>
			offer
				? [
						{
							id: result.id,
							revision: "1",
							producer: "preserve",
							sequence: 0,
							rank: 6,
							independent: true,
							runnable: true,
						},
					]
				: [],
		build: () => assert.fail("use result metadata"),
		describeResult: async () => result,
	});
	t.after(() => registration.dispose());
	await f.session.prompt("Create the task");
	await until(f, () => completed && f.bodies.length >= 3);
	await f.session.waitForIdle();
	const body = f.bodies.find((body) => JSON.stringify(body).includes("Do not lose this warning"));
	assert.ok(body, "the joined result reaches the provider despite task cancellation");
	assert.ok(JSON.stringify(body).includes("task instruction in the preceding flow message is cancelled"));
	await until(f, async () =>
		(await f.ingress.branch().attachment.ledger.snapshot()).attempts.some((a) => a.phase === "settled"),
	);
	const attempts = (await f.ingress.branch().attachment.ledger.snapshot()).attempts;
	assert.ok(
		attempts.some(
			(attempt) =>
				attempt.phase === "settled" &&
				attempt.members.some((member) => member.kind === "work") &&
				attempt.members.some((member) => member.id === result.id),
		),
	);
	await f.session.prompt("/flow clear");
	await f.session.prompt("User input after cancellation");
	assert.ok(JSON.stringify(f.bodies.at(-1)).includes("User input after cancellation"));
	assert.ok(
		f.bodies.some((body) => JSON.stringify(body).includes(queuedUser)),
		"queued user input survives cancellation",
	);
	registration.dispose();
	const file = f.sessionManager.getSessionFile();
	const next = await replacedSession(t, f, {
		reason: "resume",
		persist: true,
		producerExtensions: setupData.producerExtensions,
		sessionManager: SessionManager.open(file),
	});
	await next.session.prompt("Continue after reopening mixed input");
	const restored = next.sessionManager
		.getBranch()
		.find((entry) => entry.type === "custom_message" && entry.details?.attemptId === capturedSource.details.attemptId);
	assert.deepEqual(restored.content, capturedSource.content, "original composed bytes survive reload");
	assert.deepEqual(restored.details, capturedSource.details);
	assert.ok(JSON.stringify(next.bodies).includes(queuedUser));
	assert.ok(JSON.stringify(next.bodies).includes("Do not lose this warning"));
	assert.ok(JSON.stringify(next.bodies).includes("task instruction in the preceding flow message is cancelled"));
	assert.deepEqual(next.errors, []);
	assert.deepEqual(f.errors, []);
});

for (const goal of [false, true])
	test(`completing a selected task returns following tools to the invocation (goal=${goal})`, {
		timeout: 15000,
	}, async (t) => {
		const setupData = await setup(t);
		const f = await assembledSession(t, {
			...setupData,
			script: (_body, index) => {
				if (index === 0)
					return call("TaskCreateMany", {
						tasks: [
							{ subject: "First", description: "First bounded step" },
							{ subject: "Second", description: "Second bounded step" },
						],
					});
				if (index === 1) return call("TaskUpdate", { taskId: "1", status: "in_progress" });
				if (index === 2) return call("TaskUpdate", { taskId: "1", status: "completed" });
				if (index === 3) return call("TaskList", {});
				if (index === 4) return call("TaskUpdate", { taskId: "2", status: "in_progress" });
				if (index === 5) return call("TaskUpdate", { taskId: "2", status: "completed" });
				if (index === 6) return call("TaskList", {});
				if (goal && index === 7) return call("update_goal", { status: "complete" });
				return { text: "Both steps completed" };
			},
		});
		await f.session.prompt(`${goal ? "/goal " : ""}Create and complete both steps in this invocation`);
		await until(f, () => f.bodies.length >= (goal ? 9 : 8));
		await f.session.waitForIdle();
		assert.ok(
			messages(f).every((message) => !message.isError),
			JSON.stringify(messages(f)),
		);
		assert.deepEqual(f.errors, []);
		assert.equal(f.bodies.length, goal ? 9 : 8);
	});

test("automatic task completion permits inspection before the next task continuation", {
	timeout: 15000,
}, async (t) => {
	const f = await assembledSession(t, {
		...(await setup(t)),
		script: (_body, index) => {
			if (index === 0)
				return call("TaskCreateMany", {
					tasks: [
						{ subject: "First", description: "First task" },
						{ subject: "Second", description: "Second task" },
					],
				});
			if (index === 2) return call("TaskUpdate", { taskId: "1", status: "completed" });
			if (index === 3 || index === 7) return call("TaskList", {});
			if (index === 4) return call("TaskGet", { taskId: "2" });
			if (index === 6) return call("TaskUpdate", { taskId: "2", status: "completed" });
			return { text: "Task turn finished" };
		},
	});
	await f.session.prompt("Create and run two tasks");
	await until(f, () => f.bodies.length >= 9);
	await f.session.waitForIdle();
	assert.equal(f.bodies.length, 9);
	assert.equal(messages(f).filter((message) => message.toolName === "TaskList").length, 2);
	assert.ok(
		messages(f).every((message) => !message.isError),
		JSON.stringify(messages(f)),
	);
	assert.deepEqual(f.errors, []);
});
