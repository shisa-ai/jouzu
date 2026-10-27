import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assistantToolCalls, deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { assembledSession, capturedNotices, installedProducerExtensions } from "./fixtures/flow-assembly.mjs";

for (const earlySnapshot of [false, true])
	test(`installed goal continues after pre-settlement retention read: early snapshot=${earlySnapshot}`, {
		timeout: 15000,
	}, async (t) => {
		let f;
		const done = deferred();
		const inspect = {
			name: "inspect-next-continuation",
			factory(pi) {
				pi.on("agent_end", async () => {
					if (earlySnapshot) await f.ingress.branch().controller.retentionReferences();
					if (f.bodies.length === 4) done.resolve();
				});
			},
		};
		f = await assembledSession(t, {
			producerExtensions: [...(await installedProducerExtensions({ freshMultiloop: true })), inspect],
			script: (_body, index) => {
				if (index === 0) return assistantToolCalls({ name: "get_goal", arguments: {} });
				if (index === 2) return assistantToolCalls({ name: "update_goal", arguments: { status: "complete" } });
				return { text: "Goal turn finished" };
			},
		});
		await f.session.prompt("/goal Verify automatic continuation");
		await done.promise;
		await f.session.waitForIdle();
		assert.equal(f.bodies.length, 4, "the installed goal advances and completes without user input");
		const completed = f.session.messages.findLast(
			(message) => message.role === "toolResult" && message.toolName === "update_goal",
		);
		assert.ok(completed);
		assert.match(JSON.stringify(completed.content), /marked complete/);
		assert.deepEqual(f.errors, []);
	});

for (const command of ["multiloop", "goal"])
	for (const disambiguate of [false, true])
		test(`a reopened session resumes a detached loop without continue: command=${command}, disambiguate=${disambiguate}`, {
			timeout: 15000,
		}, async (t) => {
			const first = await assembledSession(t, {
				persist: true,
				producerExtensions: await installedProducerExtensions({
					freshMultiloop: true,
				}),
			});
			first.ingress.pauseAutomated("Hold setup until restart");
			const notices = capturedNotices(first.session);
			await first.session.prompt("/goal Finish the persisted campaign");
			const target = notices
				.find((notice) => notice.text.startsWith("Goal started:"))
				?.text.match(/Goal started: (\S+)/)?.[1];
			assert.ok(target);
			assert.equal(first.bodies.length, 0);
			const history = first.sessionManager.getSessionFile();
			await first.shutdown("resume", history);
			const done = deferred();
			const second = await assembledSession(t, {
				root: first.root,
				persist: true,
				sessionManager: SessionManager.open(history),
				producerExtensions: await installedProducerExtensions({
					freshMultiloop: true,
				}),
				script: (_body, index) => {
					if (disambiguate && index === 0)
						return assistantToolCalls({
							name: "multiloop_resume",
							arguments: { target },
						});
					if (index === (disambiguate ? 1 : 0))
						return assistantToolCalls({
							name: "multiloop_stop",
							arguments: { target },
						});
					done.resolve();
					return { text: "Campaign handled" };
				},
			});
			const resumedNotices = capturedNotices(second.session);
			await second.session.prompt(
				`/${command} resume ${disambiguate ? "<lane/run-tag>" : command === "goal" ? "" : target}`,
			);
			await done.promise;
			await second.session.waitForIdle();
			assert.equal(second.bodies.length, disambiguate ? 3 : 2);
			assert.ok(
				JSON.stringify(second.bodies[0]).includes(disambiguate ? "<lane/run-tag>" : "Finish the persisted campaign"),
			);
			assert.equal(
				resumedNotices.some((notice) => /Could not resolve|Finding the goal/.test(notice.text)),
				disambiguate,
			);
			assert.deepEqual(second.errors, []);
			assert.deepEqual(first.errors, []);
		});
