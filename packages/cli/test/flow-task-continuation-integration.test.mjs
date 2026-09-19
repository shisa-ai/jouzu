import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assistantToolCalls, deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import {
	afterFlowCleanup,
	assembledSession,
	installedProducerExtensions,
	installedTaskExtension,
} from "./fixtures/flow-assembly.mjs";

for (const enqueueAt of ["agent_end", "streaming"])
	test(`installed task continuation cancels stale work queued at ${enqueueAt}`, { timeout: 15_000 }, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "jouzu-task-continuation-"));
		afterFlowCleanup(t, () => rm(root, { recursive: true, force: true }));
		await mkdir(join(root, ".pi"));
		await writeFile(
			join(root, ".pi/tasks-config.json"),
			JSON.stringify({ autoMode: "cascade", autoClearCompleted: "never" }),
		);
		const taskFile = join(root, "tasks.json");
		const description = "Preserve this task's original instruction 日本語";
		const captured = deferred(),
			requested = deferred(),
			releaseResponse = deferred(),
			cancelled = deferred();
		let host,
			pending,
			inAgentEnd = false,
			builds = 0,
			consumed = 0;
		const complete = () => {
			const saved = JSON.parse(readFileSync(taskFile, "utf8"));
			assert.equal(saved.tasks.length, 1);
			saved.tasks[0].status = "completed";
			saved.tasks[0].updatedAt++;
			writeFileSync(taskFile, JSON.stringify(saved));
		};
		const enqueueThenComplete = () => {
			host.submit(pending);
			complete();
		};
		const f = await assembledSession(t, {
			root,
			producerExtensions: [
				{
					name: "observe-installed-task-submission",
					factory(pi) {
						pi.on("agent_start", () => {
							inAgentEnd = false;
						});
						pi.on("agent_end", () => {
							inAgentEnd = true;
						});
						pi.events.on("jouzu:task-flow", (request) => {
							const accept = request.accept;
							request.accept = (value) => {
								host = value;
								accept({
									...value,
									submit(input) {
										assert.equal(pending, undefined, "the installed extension submits one continuation");
										assert.equal(inAgentEnd, true, "capture the installed extension's agent_end submission");
										pending = {
											...input,
											build() {
												builds++;
												return input.build();
											},
											consumed() {
												consumed++;
												input.consumed();
											},
											cancelled() {
												input.cancelled();
												cancelled.resolve();
											},
										};
										if (enqueueAt === "agent_end") enqueueThenComplete();
										captured.resolve();
									},
								});
							};
						});
					},
				},
				...(await installedProducerExtensions()),
				await installedTaskExtension(taskFile),
			],
			script: async (_body, index) => {
				if (index === 0)
					return assistantToolCalls({ name: "TaskCreate", arguments: { subject: "A task", description } });
				if (index === 2 && enqueueAt === "streaming") {
					requested.resolve();
					await releaseResponse.promise;
				}
				return { text: "Done" };
			},
		});
		afterFlowCleanup(t, () => releaseResponse.resolve());
		assert.ok(host, "the installed task extension must complete its Jouzu adapter handshake");
		await f.session.prompt("Create the task");
		await captured.promise;
		if (enqueueAt === "streaming") {
			// Delay only delivery of the real installed extension's request until a user response is active.
			const active = f.session.prompt("Answer this separate user request");
			await requested.promise;
			assert.equal(f.session.agent.state.isStreaming, true);
			enqueueThenComplete();
			releaseResponse.resolve();
			await active;
		}
		await cancelled.promise;
		await f.session.waitForIdle();
		const expected = enqueueAt === "streaming" ? 3 : 2;
		assert.equal(f.bodies.length, expected, "stale continuation sends no extra HTTP request");
		assert.equal(builds, 0, "stale work is cancelled before its prompt is built");
		assert.equal(consumed, 0);
		assert.equal(f.ingress.automatedPause(), undefined);
		const task = JSON.parse(readFileSync(taskFile, "utf8")).tasks[0];
		assert.equal(task.status, "completed");
		assert.equal(task.description, description, "cancellation preserves stored source text");
		await f.session.prompt("Explain the completed result");
		assert.equal(f.bodies.length, expected + 1);
		assert.ok(JSON.stringify(f.bodies.at(-1)).includes("Explain the completed result"));
		assert.deepEqual(f.errors, []);
	});
