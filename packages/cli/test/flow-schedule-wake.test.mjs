import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	afterFlowCleanup,
	assembledSession,
	capturedNotices,
	installedTaskExtension,
} from "./fixtures/flow-assembly.mjs";

const { createJiti } = await import(
	pathToFileURL(createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("jiti")).href
);
const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: {
		"@earendil-works/pi-ai": fileURLToPath(
			new URL(
				"../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/pi-ai-extension-view.js",
				import.meta.url,
			),
		),
	},
});
const { CronScheduler } = await jiti.import(
	fileURLToPath(new URL("../node_modules/pi-schedule-prompt/src/scheduler.ts", import.meta.url)),
);
const { CronStorage } = await jiti.import(
	fileURLToPath(new URL("../node_modules/pi-schedule-prompt/src/storage.ts", import.meta.url)),
);
const { createCronTool } = await jiti.import(
	fileURLToPath(new URL("../node_modules/pi-schedule-prompt/src/tool.ts", import.meta.url)),
);

for (const outcome of [
	"trigger",
	"inline",
	"timer",
	"remove",
	"disable",
	"error",
	"deadline",
	"reopen-corrupt",
	"task-selection",
]) {
	test(`assembled scheduled-prompt wait wakes on ${outcome} without polling`, { timeout: 15000 }, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "flow-schedule-wake-"));
		afterFlowCleanup(t, () => rm(root, { recursive: true, force: true }));
		const wake = Promise.withResolvers();
		let dependency, scheduler, storage, bus;
		const delivered = [];
		await mkdir(join(root, ".pi"));
		await writeFile(join(root, ".pi/tasks-config.json"), JSON.stringify({ autoMode: "off" }));
		const f = await assembledSession(t, {
			root,
			persist: outcome === "reopen-corrupt",
			producerExtensions: [
				...(outcome === "task-selection" ? [await installedTaskExtension(join(root, "tasks.json"))] : []),
				{
					name: "installed-scheduler",
					factory(pi) {
						bus = pi.events;
						pi.registerTool(
							createCronTool(
								() => storage,
								() => scheduler,
								() => "session",
							),
						);
						pi.on("session_start", (_event, ctx) => {
							storage = new CronStorage(ctx.cwd);
							// Exercise the installed scheduler's start/end events without queuing an extra user turn.
							scheduler = new CronScheduler(
								storage,
								{
									...pi,
									sendUserMessage:
										outcome === "inline" ? pi.sendUserMessage.bind(pi) : (prompt) => delivered.push(prompt),
								},
								ctx,
							);
							scheduler.start();
						});
						pi.on("session_shutdown", () => scheduler?.stop());
					},
				},
			],
			script: async (_body, index) => {
				if (outcome === "task-selection") {
					const calls = [
						{ name: "TaskCreate", arguments: { subject: "Schedule", description: "Own the schedule" } },
						{ name: "TaskUpdate", arguments: { taskId: "1", status: "in_progress" } },
						{ name: "TaskUpdate", arguments: { taskId: "1", description: "Refresh the owning revision" } },
					];
					if (index < calls.length) return { toolCalls: [{ id: `task-${index}`, ...calls[index] }] };
					index -= calls.length;
				}
				if (index === 0)
					return {
						toolCalls: [
							{
								id: "schedule",
								name: "schedule_prompt",
								arguments: {
									action: "add",
									type: "once",
									schedule: outcome === "timer" ? "+1s" : "+1h",
									prompt: "Scheduled fixture",
								},
							},
						],
					};
				if (index === 1) {
					const result = f.sessionManager
						.getBranch()
						.find(
							(entry) =>
								entry.type === "message" &&
								entry.message.role === "toolResult" &&
								entry.message.toolCallId === "schedule",
						).message;
					assert.equal(result.isError, false, JSON.stringify(result));
					dependency = result.details.waitDependency;
					assert.equal(dependency?.producer, "schedule");
					return {
						toolCalls: [
							{
								id: "wait",
								name: "agent_wait",
								arguments: {
									on: [dependency],
									reason: "Await scheduled trigger",
									deadline: outcome === "deadline" ? "1s" : "10s",
								},
							},
						],
					};
				}
				if (index === 2) return { text: "Waiting for the scheduled trigger." };
				wake.resolve();
				return { text: "Wake received." };
			},
		});
		await f.session.prompt("Schedule a prompt and wait for its trigger.");
		assert.equal((await f.ingress.branch().attachment.waits.snapshot())[0].state, "waiting");
		if (outcome === "reopen-corrupt") {
			const history = f.sessionManager.getSessionFile();
			await f.shutdown("resume", history);
			await writeFile(join(root, ".pi/schedule-prompts.json"), "{");
			const reopened = await assembledSession(t, { root, persist: true, sessionManager: SessionManager.open(history) });
			assert.deepEqual(reopened.ingress.branch().waitSourceRecovery.missing, ["schedule"]);
			assert.ok(reopened.errors.some((error) => /Cannot restore wait source schedule/.test(error.message)));
			const notices = capturedNotices(reopened.session);
			await reopened.session.prompt("/flow");
			assert.ok(notices.some((notice) => /unavailable job sources: schedule/.test(notice.text)));
			assert.equal(reopened.bodies.length, 0);
			assert.equal((await reopened.ingress.branch().attachment.waits.snapshot())[0].state, "waiting");
			return;
		}
		const job = storage.getJob(dependency.handle);
		if (outcome === "task-selection") {
			const authority = await f.ingress.branch().attachment.waits.authoritySnapshot();
			const task = authority.work.find((work) => work.owner === "tasks");
			assert.equal(authority.executions.find((execution) => execution.producer === "schedule").workId, task.id);
		}
		if (outcome === "trigger" || outcome === "inline" || outcome === "task-selection") await scheduler.executeJob(job);
		else if (outcome === "remove") {
			storage.removeJob(job.id);
			scheduler.removeJob(job.id);
		} else if (outcome === "disable") {
			storage.updateJob(job.id, { enabled: false });
			scheduler.updateJob(job.id, { ...job, enabled: false });
		} else if (outcome === "error")
			bus.emit("cron:change", { type: "error", jobId: job.id, error: "Fixture scheduling failure" });
		await wake.promise;
		await f.session.agent.waitForIdle();
		assert.equal(
			(await f.ingress.branch().attachment.waits.snapshot())[0].state,
			["trigger", "inline", "timer", "task-selection"].includes(outcome)
				? "resolved"
				: outcome === "deadline"
					? "expired"
					: "failed",
		);
		if (outcome !== "inline")
			assert.equal(f.bodies.length, outcome === "task-selection" ? 7 : 4, "one automatic decision wake");
		else assert.ok(JSON.stringify(f.bodies.at(-1)).includes("Scheduled fixture"));
		assert.deepEqual(delivered, ["trigger", "timer", "task-selection"].includes(outcome) ? ["Scheduled fixture"] : []);
		assert.equal(
			storage.getJob(job.id)?.enabled,
			outcome === "remove" ? undefined : !["disable", "timer"].includes(outcome),
		);
		assert.equal(f.errors.length, 1);
		assert.match(f.errors[0].message, /^Background task waits are unavailable/);
	});
}
