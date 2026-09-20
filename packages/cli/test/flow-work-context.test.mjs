import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { automaticWorkId, retainAutomaticWork } from "../dist/flow-control/automatic-work.js";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { FlowWorkContext } from "../dist/flow-control/work-context.js";

async function fixture(t, options = {}) {
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
		context: new FlowWorkContext(() => current, options.automatic ? () => retainAutomaticWork(current) : undefined),
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
		currentWork: () => context.current(),
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
	const { work: _work, ...implicit } = request;
	await assert.rejects(execute(implicit), { code: "identity" });
	await context.run({ ...work, revision: 2 }, async () => {
		await assert.rejects(execute({ ...request, work: "other" }), { code: "identity" });
		await execute(implicit);
	});
	const [wait] = await attachment.waits.snapshot();
	assert.equal(wait.workId, "work");
	assert.equal(wait.state, "waiting");
	await attachment.waits.shareWork("other", "lane", 1, "bg", 2);
	await context.run({ ...work, id: "other", revision: 2 }, async () => {
		await assert.rejects(
			tools
				.get("agent_wait_cancel")
				.execute("cancel", { token: wait.token, reason: "User changed work" }, undefined, undefined, {
					sessionManager: { getSessionId: () => "session" },
				}),
			/Requested work does not belong to this invocation/,
		);
		await assert.rejects(
			execute({ ...request, replaceToken: wait.token }),
			/Requested work does not belong to this invocation/,
		);
		await assert.rejects(execute({ ...request, work: "other" }), /different ownership/);
	});
	assert.deepEqual(await attachment.waits.snapshot(), [wait], "refused management leaves the original wait intact");
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

const otherWork = { id: "other", actor: "lane", revision: 1 };
test("a live tool selects work for following tools without replacing a parallel sibling identity", async (t) => {
	const { context } = await fixture(t);
	await context.run(work, async () => {
		const started = deferred(),
			finish = deferred();
		const sibling = context.runTool(async () => {
			started.resolve();
			await finish.promise;
			assert.equal(context.current().id, "work");
		});
		await started.promise;
		await context.runTool(async () => {
			assert.equal(await context.selectToolWork(otherWork), true);
			assert.equal(context.current().id, "work");
		});
		await context.runTool(async () => assert.equal(context.current().id, "other"));
		finish.resolve();
		await sibling;
	});
});

for (const duringRead of [false, true])
	test(`revoked child cannot select new work${duringRead ? " across authority read" : ""}`, async (t) => {
		const { context, attachment } = await fixture(t);
		await context.run(work, async () => {
			await context.runTool(async () => {
				if (duringRead) {
					const original = attachment.waits.authoritySnapshot.bind(attachment.waits);
					attachment.waits.authoritySnapshot = async () => {
						const snapshot = await original();
						context.revoke();
						return snapshot;
					};
				} else context.revoke();
				await assert.rejects(context.selectToolWork(otherWork), { code: "stale" });
			});
		});
	});

test("native root may select consumed user work after revoking the old scope", async (t) => {
	const { context } = await fixture(t);
	await context.run(work, async () => {
		context.revoke();
		assert.equal(await context.selectToolWork(otherWork), true);
		await context.runTool(async () => assert.equal(context.current().id, "other"));
	});
});

for (const variant of ["valid", "foreign-work", "foreign-branch", "paused", "completed"])
	test(`wait-decision authority validates its durable identity: ${variant}`, async (t) => {
		const { waitDecisionIntent } = await import("../dist/flow-control/wait-decisions.js");
		const { context, attachment } = await fixture(t);
		const wait = {
			token: "wait",
			scope: attachment.ledger.scope,
			workId: "work",
			state: "expired",
			createdAt: 0,
			endedAt: 1,
		};
		const intent = waitDecisionIntent(wait);
		if (variant === "foreign-work") intent.workId = "other";
		if (variant === "foreign-branch")
			intent.id = waitDecisionIntent({ ...wait, scope: { ...wait.scope, branchId: "elsewhere" } }).id;
		attachment.waits.snapshot = async () => [wait];
		attachment.ledger.snapshot = async () => ({
			activeAttemptId: "attempt",
			attempts: [{ id: "attempt", phase: "queued", admission: { choice: { intent } } }],
		});
		if (["paused", "completed"].includes(variant))
			await attachment.waits.changeWork("work", "lane", 1, variant, "Lifecycle test", 1);
		const invoke = () =>
			context.runSelected("attempt", async () => {
				assert.throws(() => context.authorize("other"), { code: "identity" });
				if (variant === "valid") assert.equal(context.authorize("work").actor, "lane");
				else assert.equal(context.current(), undefined);
			});
		if (variant.startsWith("foreign")) await assert.rejects(invoke(), { code: "stale" });
		else await invoke();
	});

for (const change of ["none", "revision", "paused", "branch", "revoked", "consumed"])
	test(`completed child returns only to retained live authority: ${change}`, async (t) => {
		const { context, attachment, changeBranch } = await fixture(t);
		await context.run(work, async () => {
			await context.runTool(async () => context.selectToolWork(otherWork, true));
			await context.runTool(async () => {
				assert.equal(await context.returnFromToolWork(), false, "active child cannot return");
				await attachment.waits.changeWork("other", "lane", 1, "completed", "Done", 1);
				if (change === "revision") await attachment.waits.shareWork("work", "lane", 1, "bg", 2);
				if (change === "paused") await attachment.waits.changeWork("work", "lane", 1, "paused", "Pause", 2);
				if (change === "branch") changeBranch();
				if (change === "revoked") context.revoke();
				if (change === "consumed") {
					await context.selectToolWork(work);
					assert.equal(await context.returnFromToolWork(), false);
				} else if (change !== "none") await assert.rejects(context.returnFromToolWork(), { code: "stale" });
				else assert.equal(await context.returnFromToolWork(), true);
			});
			if (["none", "consumed"].includes(change))
				await context.runTool(async () => assert.equal(context.current().id, "work"));
		});
	});

test("nested task selections return one authorized scope at a time", async (t) => {
	const { context, attachment } = await fixture(t);
	await attachment.waits.registerWork("nested", "lane", 0);
	await context.run(work, async () => {
		await context.runTool(async () => context.selectToolWork(otherWork, true));
		await context.runTool(async () => context.selectToolWork({ ...work, id: "nested" }, true));
		await context.runTool(async () => {
			await attachment.waits.changeWork("nested", "lane", 1, "completed", "Done", 1);
			assert.equal(await context.returnFromToolWork(), true);
		});
		await context.runTool(async () => {
			assert.equal(context.current().id, "other");
			await attachment.waits.changeWork("other", "lane", 1, "completed", "Done", 2);
			assert.equal(await context.returnFromToolWork(), true);
		});
		await context.runTool(async () => assert.equal(context.current().id, "work"));
	});
});

test("an admitted task releases completed authority without adopting another work", async (t) => {
	const { context, attachment } = await fixture(t);
	await context.run(otherWork, async () => {
		await context.runTool(async () => {
			await attachment.waits.changeWork("other", "lane", 1, "completed", "Done", 1);
			assert.equal(await context.returnFromToolWork(), true);
		});
		await context.runTool(async () => {
			assert.equal(context.current(), undefined);
			assert.throws(() => context.authorize("other"), { code: "identity" });
			assert.throws(() => context.authorize("work"), { code: "identity" });
		});
	});
});

const resultIntent = (workId) => ({
	id: "bg-result:execution",
	revision: "1",
	producer: "bg",
	sequence: 0,
	rank: 6,
	independent: true,
	runnable: true,
	...(workId === undefined ? {} : { workId, workRevision: "2" }),
});
const selectedAttempt = (attachment, intent) => {
	attachment.ledger.snapshot = async () => ({
		activeAttemptId: "attempt",
		attempts: [{ id: "attempt", phase: "queued", admission: { choice: { intent } } }],
	});
};

test("result delivery runs on the work that owns its execution", async (t) => {
	const { context, attachment } = await fixture(t);
	await attachment.waits.shareWork("work", "lane", 1, "bg", 1);
	selectedAttempt(attachment, resultIntent("work"));
	await context.runSelected("attempt", async () => {
		assert.deepEqual(context.current(), { id: "work", revision: 2 });
		assert.equal(context.authorize("work").actor, "lane");
		// The spawn path captures exactly this authority before any process starts.
		assert.deepEqual(attachment.waits.captureExecutionWork("work", 2, "bg"), { id: "work", revision: 2 });
	});
});

for (const variant of ["paused", "completed", "unshared", "missing", "absent"])
	test(`result delivery without live owning work still keeps its tools: ${variant}`, async (t) => {
		const { context, attachment } = await fixture(t, { automatic: true });
		if (variant !== "unshared") await attachment.waits.shareWork("work", "lane", 1, "bg", 1);
		if (["paused", "completed"].includes(variant))
			await attachment.waits.changeWork("work", "lane", 2, variant, "Lifecycle test", 2);
		selectedAttempt(
			attachment,
			resultIntent(variant === "absent" ? undefined : variant === "missing" ? "elsewhere" : "work"),
		);
		await context.runSelected("attempt", async () => {
			const current = context.current();
			assert.equal(current.id, automaticWorkId(attachment.ledger.scope));
			const authority = await attachment.waits.authoritySnapshot();
			assert.deepEqual(
				authority.work.find((item) => item.id === current.id).participants,
				["host-automatic", "bg", "tasks", "subagent"],
				"a wake turn can start background jobs and derive task work",
			);
			assert.deepEqual(attachment.waits.captureExecutionWork(current.id, current.revision, "bg"), {
				id: current.id,
				revision: current.revision,
			});
			const derived = await attachment.waits.deriveWorkBinding(
				{ producer: "tasks", key: ["created-in-a-wake-turn"] },
				"task-revision",
				current,
				1,
				["bg", "tasks"],
			);
			assert.deepEqual(derived.origin, { id: current.id, revision: current.revision });
		});
	});

for (const rank of [2, 3, 6])
	test(`automated rank ${rank} falls back to host work only when the host supplies it`, async (t) => {
		const plain = await fixture(t);
		await plain.attachment.waits.shareWork("work", "lane", 1, "bg", 1);
		selectedAttempt(plain.attachment, { ...resultIntent("work"), rank });
		await plain.context.runSelected("attempt", async () => {
			if (rank === 6) assert.deepEqual(plain.context.current(), { id: "work", revision: 2 });
			else assert.equal(plain.context.current(), undefined, "no owning work is invented without a host supplier");
		});
	});

test("producer-bound attempts never borrow host automatic work", async (t) => {
	const { context, attachment } = await fixture(t, { automatic: true });
	selectedAttempt(attachment, {
		id: "task-continuation",
		revision: "1",
		producer: "tasks",
		sequence: 0,
		rank: 4,
		independent: false,
		runnable: true,
		workId: "elsewhere",
		workRevision: "1",
	});
	await context.runSelected("attempt", async () => assert.equal(context.current(), undefined));
});

test("a wait decision for finished work keeps its tools through host work", async (t) => {
	const { waitDecisionIntent } = await import("../dist/flow-control/wait-decisions.js");
	const { context, attachment } = await fixture(t, { automatic: true });
	const wait = {
		token: "wait",
		scope: attachment.ledger.scope,
		workId: "work",
		state: "expired",
		createdAt: 0,
		endedAt: 1,
	};
	attachment.waits.snapshot = async () => [wait];
	selectedAttempt(attachment, waitDecisionIntent(wait));
	await attachment.waits.changeWork("work", "lane", 1, "completed", "Done", 1);
	await context.runSelected("attempt", async () =>
		assert.equal(context.current().id, automaticWorkId(attachment.ledger.scope)),
	);
});
