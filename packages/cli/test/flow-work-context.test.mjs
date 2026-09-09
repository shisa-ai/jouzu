import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { FlowWorkContext } from "../dist/flow-control/work-context.js";

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-work-context-"));
	const attachment = await PiFlowAttachment.open(root, { sessionId: "session", branchId: "branch" });
	t.after(async () => {
		await attachment.close();
		await rm(root, { recursive: true, force: true });
	});
	await attachment.waits.registerWork("work", "lane", 0);
	await attachment.waits.registerWork("other", "lane", 0);
	let current = attachment;
	return {
		attachment,
		context: new FlowWorkContext(() => current),
		changeBranch: () => {
			current = undefined;
		},
	};
}
const work = { id: "work", actor: "lane", revision: 1 };

test("work authority requires a live host invocation and expires in detached continuations", async (t) => {
	const { context } = await fixture(t);
	assert.equal(context.current(), undefined);
	assert.throws(() => context.authorize("work"), { code: "identity" });
	let authority, detached;
	const resume = deferred();
	await context.run(work, async () => {
		assert.deepEqual(context.current(), { id: "work", revision: 1 });
		authority = context.authorize("work");
		authority.assertActive();
		assert.throws(() => context.authorize("other"), { code: "identity" });
		detached = resume.promise.then(() => assert.throws(() => context.current(), { code: "stale" }));
	});
	assert.throws(() => authority.assertActive(), { code: "stale" });
	resume.resolve();
	await detached;
});

for (const change of ["revision", "paused", "branch"])
	test(`captured work authority rejects ${change} changes`, async (t) => {
		const f = await fixture(t);
		await f.context.run(work, async () => {
			const authority = f.context.authorize("work");
			if (change === "revision") await f.attachment.waits.shareWork("work", "lane", 1, "bg", 1);
			if (change === "paused") await f.attachment.waits.changeWork("work", "lane", 1, "paused", "Paused", 1);
			if (change === "branch") f.changeBranch();
			assert.throws(() => f.context.authorize("work"), { code: "stale" });
			if (change === "branch") assert.throws(() => authority.assertActive(), { code: "stale" });
		});
	});

test("overlapping invocations cannot replace work and failures release the reservation", async (t) => {
	const { context } = await fixture(t);
	const started = deferred(),
		finish = deferred();
	const running = context.run(work, async () => {
		started.resolve();
		await finish.promise;
		throw new Error("fixture failure");
	});
	await started.promise;
	await assert.rejects(
		context.run({ ...work, id: "other" }, async () => {}),
		{ code: "busy" },
	);
	finish.resolve();
	await assert.rejects(running, /fixture failure/);
	await context.run({ ...work, id: "other" }, async () => assert.equal(context.current().id, "other"));
});

test("wait tools use host work authority and cannot claim another registered work", async (t) => {
	const { createFlowWaitExtension } = await import("../dist/flow-control/wait-tools.js");
	const { attachment, context } = await fixture(t);
	await attachment.waits.shareWork("work", "lane", 1, "bg", 1);
	await attachment.waits.registerExecution(
		{
			producer: "bg",
			handle: "bg-1",
			execution: "exec-1",
			workId: "work",
			revision: 1,
			predicates: [{ until: "exit", state: "pending" }],
		},
		2,
		1,
	);
	attachment.waitProducers.register(
		{
			version: 1,
			namespace: "bg",
			subscribe() {
				return () => {};
			},
			async snapshot(identity) {
				return { ...identity, revision: 1, predicates: [{ until: "exit", state: "pending" }] };
			},
		},
		(error) => {
			throw error;
		},
	);
	const tools = new Map();
	createFlowWaitExtension({
		attachment: () => attachment,
		authorize: (id) => context.authorize(id),
		maxDurationMs: 1000,
		now: () => 2,
	}).factory({
		on() {},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
	});
	const request = {
		work: "work",
		reason: "Await process exit",
		deadline: "1s",
		on: [{ producer: "bg", handle: "bg-1", execution: "exec-1", until: "exit" }],
	};
	const execute = (args) =>
		tools
			.get("agent_wait")
			.execute("call-1", args, undefined, undefined, { sessionManager: { getSessionId: () => "session" } });
	await assert.rejects(execute(request), { code: "identity" });
	await context.run({ ...work, revision: 2 }, async () => {
		await assert.rejects(execute({ ...request, work: "other" }), { code: "identity" });
		await execute(request);
	});
	const [wait] = await attachment.waits.snapshot();
	assert.equal(wait.workId, "work");
	assert.equal(wait.state, "waiting");
});

test("revocation preserves the invocation reservation until native execution returns", async (t) => {
	const { context } = await fixture(t);
	await context.run(work, async () => {
		const authority = context.authorize("work");
		context.revoke();
		context.revoke();
		assert.throws(() => authority.assertActive(), { code: "stale" });
		assert.throws(() => context.current(), { code: "stale" });
		await assert.rejects(
			context.run({ ...work, id: "other" }, async () => {}),
			{ code: "busy" },
		);
	});
	await context.run({ ...work, id: "other" }, async () => assert.equal(context.current().id, "other"));
});
