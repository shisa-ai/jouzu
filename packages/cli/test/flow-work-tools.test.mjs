import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assistant, createFlowSession, deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { PiWorkTools } from "../dist/flow-control/pi-work-tools.js";
import { FlowWorkContext } from "../dist/flow-control/work-context.js";

for (const parallel of [false, true])
	for (const failure of [false, true])
		test(`Pi tool work scopes expire independently: parallel=${parallel}, failure=${failure}`, async (t) => {
			const root = await mkdtemp(join(tmpdir(), "jouzu-tool-work-"));
			let context,
				attachment,
				tools,
				activeTools = 0,
				peakTools = 0;
			const escaped = [],
				authorities = [],
				observed = [],
				errors = [];
			const resume = deferred();
			const { session } = await createFlowSession(t, {
				tools: ["probe"],
				extensions: [
					{
						name: "probe",
						factory(pi) {
							pi.registerTool({
								name: "probe",
								label: "Probe",
								description: "Inspect work authority",
								parameters: { type: "object", properties: {}, additionalProperties: false },
								async execute(id) {
									activeTools++;
									peakTools = Math.max(peakTools, activeTools);
									observed.push(context.current());
									const authority = context.authorize("work");
									authorities.push(authority);
									escaped.push(resume.promise.then(() => assert.throws(() => context.current(), { code: "stale" })));
									await new Promise((resolve) => setImmediate(resolve));
									activeTools--;
									authority.assertActive();
									if (failure && id === "one") throw new Error("fixture tool failure");
									return { content: [{ type: "text", text: id }], details: {} };
								},
							});
						},
					},
				],
			});
			await session.bindExtensions({ onError: (error) => errors.push(error) });
			attachment = await PiFlowAttachment.open(root, { sessionId: session.sessionId, branchId: "branch" });
			context = new FlowWorkContext(() => attachment);
			tools = new PiWorkTools(session, context);
			t.after(async () => {
				tools.close();
				await attachment.close();
				await rm(root, { recursive: true, force: true });
			});
			await attachment.waits.registerWork("work", "host", 0);
			session.agent.toolExecution = parallel ? "parallel" : "sequential";
			let requests = 0;
			session.agent.streamFunction = async () => {
				const result = assistant();
				if (++requests === 1) {
					result.content = ["one", "two"].map((id) => ({ type: "toolCall", id, name: "probe", arguments: {} }));
					result.stopReason = "toolUse";
				} else {
					assert.equal(authorities.length, 2);
					for (const authority of authorities) assert.throws(() => authority.assertActive(), { code: "stale" });
					resume.resolve();
					await Promise.all(escaped);
					assert.equal(context.current().id, "work");
				}
				return { async *[Symbol.asyncIterator]() {}, result: async () => result };
			};
			await context.run({ id: "work", actor: "host", revision: 1 }, () => session.prompt("inspect"));
			assert.equal(requests, 2);
			assert.equal(peakTools, parallel ? 2 : 1);
			assert.equal(
				session.agent.state.messages.find((message) => message.role === "toolResult" && message.toolCallId === "one")
					.isError,
				failure,
			);
			assert.deepEqual(observed, [
				{ id: "work", revision: 1 },
				{ id: "work", revision: 1 },
			]);
			assert.deepEqual(errors, []);
		});

test("shared tool objects cannot exchange authority across matching call IDs and arguments", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-shared-tool-work-"));
	const attachments = await Promise.all(
		["a", "b"].map((sessionId) => PiFlowAttachment.open(root, { sessionId, branchId: "branch" })),
	);
	const contexts = attachments.map((attachment) => new FlowWorkContext(() => attachment));
	const agents = contexts.map(() => ({ subscribe: () => () => {} }));
	const wrappers = agents.map((agent, i) => new PiWorkTools({ agent }, contexts[i]));
	t.after(async () => {
		for (const wrapper of wrappers.toReversed()) wrapper.close();
		for (const attachment of attachments) await attachment.close();
		await rm(root, { recursive: true, force: true });
	});
	for (const attachment of attachments) await attachment.waits.registerWork("work", "host", 0);
	const observed = [],
		checks = [];
	const tool = {
		name: "shared",
		async execute() {
			observed.push(contexts.map((context) => context.current()?.id));
			for (const context of contexts) if (context.current()) checks.push(context.authorize("work"));
			return { content: [] };
		},
	};
	const original = tool.execute,
		args = {},
		input = { toolCall: { id: "same", name: "shared" }, args, context: { tools: [tool] } };
	const ready = deferred(),
		proceed = deferred();
	const first = contexts[0].run({ id: "work", actor: "host", revision: 1 }, async () => {
		await agents[0].beforeToolCall(input);
		ready.resolve();
		await proceed.promise;
		await tool.execute("same", args);
		assert.throws(() => checks.at(-1).assertActive(), { code: "stale" });
	});
	await ready.promise;
	await contexts[1].run({ id: "work", actor: "host", revision: 1 }, async () => {
		await agents[1].beforeToolCall(input);
		await tool.execute("same", args);
		assert.throws(() => checks.at(-1).assertActive(), { code: "stale" });
	});
	proceed.resolve();
	await first;
	assert.deepEqual(observed, [
		[undefined, "work"],
		["work", undefined],
	]);
	for (const wrapper of wrappers.toReversed()) wrapper.close();
	assert.equal(tool.execute, original);
});
