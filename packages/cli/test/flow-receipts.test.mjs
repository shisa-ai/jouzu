import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	BACKGROUND_CONTEXT as context,
	JsonlSessionRepo,
	MemorySessionRepo,
	value,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createPiLedgerStore } from "../dist/flow-control/pi-ledger-store.js";
import { FlowReceiptLedger } from "../dist/flow-control/receipt-ledger.js";

const scope = { sessionId: "parent", branchId: "branch-a" };
const member = (id = "result-a", kind = "result", required = false) => ({
	id,
	revision: "execution-1",
	kind,
	required,
	contentHash: createHash("sha256").update(`content:${id}`).digest("hex"),
});
const included = (item) => ({
	id: item.id,
	revision: item.revision,
	disposition: "included",
	contentHash: item.contentHash,
});
const queue = { id: "queue-1", revision: 1 };
const code = (expected) => (error) => error?.code === expected;

async function fixture(t, limits) {
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, context);
	t.after(() => repo.close(context));
	const store = createPiLedgerStore(session);
	return { store, session, ledger: await FlowReceiptLedger.attach(store, scope, limits) };
}

async function claimed(ledger, members = [member()], id = "attempt") {
	await ledger.select(id, members);
	await ledger.queued(id, queue);
	await ledger.claim(id, queue);
}

test("Pi mutation barrier admits one reservation and rolls back the losing update", async (t) => {
	const { ledger } = await fixture(t);
	const results = await Promise.allSettled([ledger.select("a", [member()]), ledger.select("b", [member()])]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(results.find((result) => result.status === "rejected").reason.code, "busy");
	const state = await ledger.snapshot();
	assert.equal(state.attempts.length, 1);
	assert.equal(state.activeAttemptId, state.attempts[0].id);
});

test("cancel racing claim cannot resurrect a queue item", async (t) => {
	const { ledger } = await fixture(t);
	await ledger.select("attempt", [member()]);
	await ledger.queued("attempt", queue);
	await Promise.all([
		ledger.cancel("attempt", "User input arrived."),
		assert.rejects(ledger.claim("attempt", queue), code("transition")),
	]);
	assert.equal((await ledger.snapshot()).activeAttemptId, undefined);
	await assert.rejects(ledger.select("attempt", [member()]), code("identity"));
});

test("claim requires the exact queue item revision and immutable membership", async (t) => {
	const { ledger } = await fixture(t);
	const original = member();
	await ledger.select("attempt", [original]);
	original.revision = "wrong";
	await ledger.queued("attempt", queue);
	await assert.rejects(ledger.claim("attempt", { ...queue, revision: 2 }), code("stale"));
	assert.equal((await ledger.snapshot()).attempts[0].phase, "queued");
	await ledger.claim("attempt", queue);
	assert.equal((await ledger.snapshot()).attempts[0].members[0].revision, "execution-1");
});

test("history persistence does not establish final inclusion or request success", async (t) => {
	const { ledger } = await fixture(t);
	const result = member();
	await claimed(ledger, [result]);
	await ledger.history("attempt", [{ id: result.id, revision: result.revision, entryId: "entry-a" }]);
	let attempt = (await ledger.snapshot()).attempts[0];
	assert.equal(attempt.requests.length, 0);
	assert.equal(attempt.history.length, 1);
	assert.equal(await ledger.prepare("attempt", "request", [included(result)], false), true);
	attempt = (await ledger.snapshot()).attempts[0];
	assert.equal(attempt.phase, "prepared");
	assert.equal(attempt.requests[0].outcome, undefined);
	await ledger.handoff("attempt", "request");
	await assert.rejects(ledger.cancel("attempt", "User stop."), code("transition"));
	await ledger.requestOutcome("attempt", "request", "transient-failure");
	await ledger.settle("attempt", "transient-failure");
	attempt = (await ledger.snapshot()).attempts[0];
	assert.equal(attempt.requests[0].outcome, "transient-failure");
	assert.equal(attempt.requests[0].inclusion[0].disposition, "included");
	assert.equal(attempt.history.length, 1);
});

test("emergency reset releases unsent, partially started, and unknown reservations safely", async (t) => {
	{
		const { ledger } = await fixture(t);
		await ledger.select("unsent", [member("unsent")]);
		assert.equal(await ledger.emergencyReset("unsent", "Emergency reset."), "cancelled");
		assert.equal((await ledger.snapshot()).activeAttemptId, undefined);
	}
	{
		const { ledger } = await fixture(t);
		const started = member("started");
		await claimed(ledger, [started], "unknown");
		await ledger.prepare("unknown", "request", [included(started)], false);
		await ledger.handoff("unknown", "request");
		assert.equal(await ledger.emergencyReset("unknown", "Emergency reset."), "uncertain");
		assert.equal((await ledger.snapshot()).attempts[0].phase, "uncertain");
	}
	{
		const { ledger } = await fixture(t);
		const started = member("started");
		await claimed(ledger, [started], "partial");
		await ledger.prepare("partial", "request-1", [included(started)], false);
		await ledger.handoff("partial", "request-1");
		await ledger.requestOutcome("partial", "request-1", "success");
		await ledger.prepare("partial", "request-2", [included(started)], false);
		assert.equal(await ledger.emergencyReset("partial", "Emergency reset."), "settled");
		const attempt = (await ledger.snapshot()).attempts[0];
		assert.equal(attempt.phase, "settled");
		assert.equal(attempt.outcome, "failure");
	}
});

test("filtering optional results preserves an admitted work item and exact dispositions", async (t) => {
	const { ledger } = await fixture(t);
	const work = member("work", "work", true);
	const result = member();
	await claimed(ledger, [work, result]);
	assert.equal(
		await ledger.prepare(
			"attempt",
			"request",
			[included(work), { id: result.id, revision: result.revision, disposition: "omitted" }],
			false,
		),
		true,
	);
	const state = await ledger.snapshot();
	assert.equal(state.activeAttemptId, "attempt");
	assert.deepEqual(
		state.attempts[0].requests[0].inclusion.map((item) => item.disposition),
		["included", "omitted"],
	);
});

for (const disposition of ["replaced", "omitted", "rejected"]) {
	test(`filtering required work (${disposition}) withholds the turn and leaves other attempts eligible`, async (t) => {
		const { ledger } = await fixture(t);
		const work = member("work", "work", true);
		const result = member();
		await claimed(ledger, [work, result]);
		assert.equal(
			await ledger.prepare(
				"attempt",
				"request",
				[{ id: work.id, revision: work.revision, disposition }, included(result)],
				false,
			),
			false,
		);
		await assert.rejects(ledger.handoff("attempt", "request"), code("transition"));
		await ledger.select("next", [member("later")]);
		assert.equal((await ledger.snapshot()).attempts[0].phase, "withheld");
	});
}

test("inclusion rejects fabricated, duplicate, changed, and missing member receipts atomically", async (t) => {
	const { ledger } = await fixture(t);
	const result = member();
	await claimed(ledger, [result]);
	for (const receipts of [
		[],
		[included(result), included(result)],
		[{ ...included(result), revision: "wrong" }],
		[{ ...included(result), contentHash: "0".repeat(64) }],
	]) {
		await assert.rejects(ledger.prepare("attempt", "request", receipts, false), code("identity"));
		assert.equal((await ledger.snapshot()).attempts[0].requests[0], undefined);
	}
});

test("history receipts cannot be rebound to another entry and failed batches roll back", async (t) => {
	const { ledger } = await fixture(t);
	const result = member();
	await claimed(ledger);
	const receipt = { id: result.id, revision: result.revision, entryId: "entry-a" };
	await assert.rejects(ledger.history("attempt", [receipt, { ...receipt, entryId: "entry-b" }]), code("identity"));
	assert.deepEqual((await ledger.snapshot()).attempts[0].history, []);
	await ledger.history("attempt", [receipt, receipt]);
	assert.equal((await ledger.snapshot()).attempts[0].history.length, 1);
});

for (const phase of ["selected", "queued", "claimed", "prepared", "handed-off", "settled"]) {
	test(`reattachment fences callbacks and reconciles ${phase} without sending`, async (t) => {
		const { ledger, store } = await fixture(t);
		const result = member();
		await ledger.select("attempt", [result]);
		if (phase !== "selected") await ledger.queued("attempt", queue);
		if (!["selected", "queued"].includes(phase)) await ledger.claim("attempt", queue);
		if (["prepared", "handed-off", "settled"].includes(phase))
			await ledger.prepare("attempt", "request", [included(result)], false);
		if (["handed-off", "settled"].includes(phase)) await ledger.handoff("attempt", "request");
		if (phase === "settled") {
			await ledger.requestOutcome("attempt", "request", "success");
			await ledger.settle("attempt", "success");
		}
		const attached = await FlowReceiptLedger.attach(store, scope);
		await assert.rejects(ledger.select("late", [result]), code("stale"));
		const state = await attached.snapshot();
		assert.equal(state.generation, ledger.generation + 1);
		assert.equal(state.activeAttemptId, undefined);
		assert.equal(
			state.attempts[0].phase,
			phase === "handed-off" ? "uncertain" : phase === "settled" ? "settled" : "cancelled",
		);
	});
}

test("scope mismatch cannot import another branch's active attempt", async (t) => {
	const { ledger, store } = await fixture(t);
	await ledger.select("attempt", [member()]);
	await assert.rejects(FlowReceiptLedger.attach(store, { ...scope, branchId: "other" }), code("scope"));
	assert.equal((await ledger.snapshot()).activeAttemptId, "attempt");
});

test("retention exhaustion refuses new work without evicting receipts", async (t) => {
	const { ledger } = await fixture(t, { maxAttempts: 1, maxBytes: 16384 });
	await ledger.select("attempt", [member()]);
	await ledger.cancel("attempt", "Cancelled.");
	await assert.rejects(ledger.select("overflow", [member("overflow")]), code("capacity"));
	const state = await ledger.snapshot();
	assert.equal(state.attempts.length, 1);
	assert.equal(state.activeAttemptId, undefined);
});

test("Pi JSONL reopen preserves membership and marks a handed-off request uncertain", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-ledger-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const options = { fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root };
	let repo = new JsonlSessionRepo(options);
	let session = await repo.create({ cwd: root }, context);
	const metadata = session.metadata;
	let ledger = await FlowReceiptLedger.attach(createPiLedgerStore(session), scope);
	const result = member();
	await claimed(ledger, [result]);
	await ledger.history("attempt", [{ id: result.id, revision: result.revision, entryId: "history-a" }]);
	await ledger.prepare("attempt", "request", [included(result)], false);
	await ledger.handoff("attempt", "request");
	await session.close(context);
	await repo.close(context);
	repo = new JsonlSessionRepo(options);
	session = await repo.open(metadata, context);
	t.after(async () => {
		await session.close(context);
		await repo.close(context);
	});
	ledger = await FlowReceiptLedger.attach(createPiLedgerStore(session), scope);
	const state = await ledger.snapshot();
	assert.equal(state.attempts[0].phase, "uncertain");
	assert.deepEqual(state.attempts[0].members, [result]);
	assert.equal(state.attempts[0].history[0].entryId, "history-a");
	assert.equal(state.attempts[0].requests[0].id, "request");
});

test("native tool-loop requests retain one reservation until the host run settles", async (t) => {
	const { ledger } = await fixture(t);
	const result = member();
	await claimed(ledger, [result]);
	for (const [id, outcome] of [
		["request-1", "success"],
		["retry-1", "transient-failure"],
		["retry-2", "success"],
	]) {
		assert.equal(await ledger.prepare("attempt", id, [included(result)], false), true);
		await ledger.handoff("attempt", id);
		await ledger.requestOutcome("attempt", id, outcome);
		await assert.rejects(ledger.select("competing", [member("later")]), code("busy"));
	}
	await ledger.settle("attempt", "success");
	await ledger.select("next", [member("later")]);
	const attempt = (await ledger.snapshot()).attempts[0];
	assert.equal(attempt.requests.length, 3);
	assert.equal(attempt.outcome, "success");
	assert.deepEqual(
		attempt.requests.map((request) => request.outcome),
		["success", "transient-failure", "success"],
	);
});

test("filter failure during a later request retains ownership until abort-and-join", async (t) => {
	const { ledger } = await fixture(t);
	const work = member("work", "work", true);
	await claimed(ledger, [work]);
	await ledger.prepare("attempt", "request-1", [included(work)], false);
	await ledger.handoff("attempt", "request-1");
	await ledger.requestOutcome("attempt", "request-1", "success");
	assert.equal(
		await ledger.prepare(
			"attempt",
			"request-2",
			[{ id: work.id, revision: work.revision, disposition: "rejected" }],
			false,
		),
		false,
	);
	await assert.rejects(ledger.select("competing", [member()]), code("busy"));
	await assert.rejects(ledger.cancel("attempt", "Cancel."), code("transition"));
	await ledger.settle("attempt", "failure");
	await ledger.select("next", [member()]);
});

test("invalid durable state is refused without modifying or silently repairing it", async (t) => {
	for (const change of [
		(state) => {
			state.schemaVersion = 2;
		},
		(state) => {
			state.attempts[0].phase = "unknown";
		},
		(state) => {
			state.attempts.push(structuredClone(state.attempts[0]));
		},
		(state) => {
			state.activeAttemptId = "absent";
		},
		(state) => {
			state.attempts[0].members[0].contentHash = "bad";
		},
	]) {
		const { ledger, store, session } = await fixture(t);
		await claimed(ledger);
		const corrupted = await ledger.snapshot();
		change(corrupted);
		await store.transact(() => ({ state: corrupted, result: undefined }));
		const raw = async () => [
			await session.scanValues(value("jouzu.flow.receipts"), context),
			await session.scanValues(value("jouzu.flow.attempt"), context),
		];
		const before = await raw();
		await assert.rejects(FlowReceiptLedger.attach(store, scope));
		assert.deepEqual(await raw(), before);
	}
});

test("all filtered notification content withholds without creating a request", async (t) => {
	const { ledger } = await fixture(t);
	const result = member();
	await claimed(ledger, [result]);
	assert.equal(
		await ledger.prepare(
			"attempt",
			"request",
			[{ id: result.id, revision: result.revision, disposition: "omitted" }],
			false,
		),
		false,
	);
	await assert.rejects(ledger.handoff("attempt", "request"), code("transition"));
	assert.equal((await ledger.snapshot()).attempts[0].requests[0].handedOff, false);
});

test("a controller cannot classify work or wait decisions as optional", async (t) => {
	const { ledger } = await fixture(t);
	for (const kind of ["work", "wait", "user", "alert"]) {
		assert.throws(() => ledger.select("attempt", [member("instruction", kind, false)]), code("identity"));
	}
	assert.equal((await ledger.snapshot()).attempts.length, 0);
});

for (const checkpoint of ["before-handoff", "after-handoff", "torn-handoff"]) {
	test(`process kill at ${checkpoint} preserves exact known receipts`, { timeout: 15000 }, async (t) => {
		const { fork } = await import("node:child_process");
		const { once } = await import("node:events");
		const root = await mkdtemp(join(tmpdir(), "jouzu-flow-kill-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const child = fork(new URL("./fixtures/flow-ledger-crash.mjs", import.meta.url), [root, checkpoint], {
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		t.after(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
		});
		let stderr = "";
		child.stderr.on("data", (data) => {
			stderr += data;
		});
		const metadata = await new Promise((resolve, reject) => {
			child.once("message", (message) => {
				if (message.ready) resolve(message.metadata);
				else reject(new Error("Unexpected crash-fixture message."));
			});
			child.once("error", reject);
			child.once("exit", (status) => reject(new Error(`Crash fixture exited ${status}: ${stderr}`)));
		});
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
		const repo = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
		const session = await repo.open(metadata, context);
		t.after(async () => {
			await session.close(context);
			await repo.close(context);
		});
		const ledger = await FlowReceiptLedger.attach(createPiLedgerStore(session), scope);
		const attempt = (await ledger.snapshot()).attempts[0];
		assert.equal(attempt.phase, checkpoint === "after-handoff" ? "uncertain" : "cancelled");
		assert.equal(attempt.history[0].entryId, "history");
		assert.equal(attempt.members[0].revision, "execution-1");
		assert.equal(attempt.requests[0].handedOff, checkpoint === "after-handoff");
		assert.equal(attempt.requests[0].outcome, undefined);
	});
}

test("Pi JSONL updates do not rewrite every retained attempt on each transition", async (t) => {
	const { stat } = await import("node:fs/promises");
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-growth-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repo = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
	const session = await repo.create({ cwd: root }, context);
	t.after(async () => {
		await session.close(context);
		await repo.close(context);
	});
	const ledger = await FlowReceiptLedger.attach(createPiLedgerStore(session), scope);
	let firstBytes;
	for (let i = 0; i < 40; i++) {
		await ledger.select(`attempt-${i}`, [member(`result-${i}`)]);
		await ledger.cancel(`attempt-${i}`, "User cancelled queued work.");
		if (i === 19) firstBytes = (await stat(session.metadata.path)).size;
	}
	const finalBytes = (await stat(session.metadata.path)).size;
	assert.equal((await ledger.snapshot()).attempts.length, 40);
	assert.ok(finalBytes < firstBytes * 3, `20 attempts: ${firstBytes} bytes; 40 attempts: ${finalBytes} bytes`);
	t.diagnostic(`Pi JSONL retained receipts: 20 attempts ${firstBytes} bytes; 40 attempts ${finalBytes} bytes.`);
});
