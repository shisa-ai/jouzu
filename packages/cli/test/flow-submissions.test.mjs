import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	BACKGROUND_CONTEXT as context,
	deleteValue,
	MemorySessionRepo,
	setValue,
	value,
} from "@earendil-works/pi-agent-core";
import { createFlowSession, deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { FlowOwnership } from "../dist/flow-control/ownership.js";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { FlowSubmissionStore } from "../dist/flow-control/submission-store.js";
import { legacyPathDigest } from "../dist/path-digest.js";
import { afterCleanup, cleanupContext } from "./fixtures/cleanup.mjs";

const scope = { sessionId: "parent", branchId: "main" };
const submission = (id = "item") => ({
	version: 1,
	id,
	api: "sendUserMessage",
	origin: { kind: "extension", id: "fixture" },
	scope: { sessionId: "parent", attachmentId: "attachment", leafId: null },
	args: [
		[
			{ type: "text", text: "original" },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		],
		undefined,
	],
});

test("native dispatch is recorded before execution and cannot repeat after reopen", async (t) => {
	const root = await rootFor(t);
	let attachment = await PiFlowAttachment.open(root, scope);
	afterCleanup(t, () => attachment.close());
	await attachment.submissions.retain(submission());
	let calls = 0;
	const results = await Promise.allSettled([
		attachment.submissions.dispatch("item", 1, "operation", async () => {
			assert.equal((await attachment.submissions.snapshot())[0].dispatch.phase, "started");
			calls++;
		}),
		attachment.submissions.dispatch("item", 1, "competing", async () => {
			calls++;
		}),
	]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(results.find((result) => result.status === "rejected").reason.code, "transition");
	assert.equal((await attachment.submissions.snapshot())[0].dispatch.phase, "returned");
	await attachment.close();
	attachment = await PiFlowAttachment.open(root, scope);
	await assert.rejects(
		attachment.submissions.dispatch("item", 1, "other", async () => {
			calls++;
		}),
		{ code: "transition" },
	);
	assert.equal(calls, 1);
});

test("process death after a native effect preserves the dispatch hold without repeating the effect", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-native-dispatch-kill-"));
	let attachment;
	const child = fork(new URL("./fixtures/flow-submission-crash.mjs", import.meta.url), [root, "dispatch"], {
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	const exited = once(child, "exit");
	afterCleanup(t, async () => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await exited;
		}
		await attachment?.close();
		await rm(root, { recursive: true, force: true });
	});
	await Promise.race([
		once(child, "message"),
		exited.then(() => {
			throw new Error("Native fixture exited before its effect");
		}),
	]);
	child.kill("SIGKILL");
	await exited;
	attachment = await PiFlowAttachment.open(root, scope);
	assert.equal((await attachment.submissions.snapshot())[0].dispatch.phase, "started");
	await assert.rejects(
		attachment.submissions.dispatch("durable", 1, "retry", async () => {
			await writeFile(join(root, "native-effect"), "repeated");
		}),
		{ code: "transition" },
	);
	assert.equal(await readFile(join(root, "native-effect"), "utf8"), "once\n");
});

test("native failure and cancellation preserve dispatch uncertainty without allowing replay", async (t) => {
	const root = await rootFor(t);
	const attachment = await PiFlowAttachment.open(root, scope);
	afterCleanup(t, () => attachment.close());
	await attachment.submissions.retain(submission());
	await assert.rejects(
		attachment.submissions.dispatch("item", 1, "operation", async () => {
			await attachment.submissions.cancel("item", 1);
			throw new Error("native failed after an effect");
		}),
		/native failed after an effect/,
	);
	const record = (await attachment.submissions.snapshot())[0];
	assert.equal(record.status, "cancelled");
	assert.equal(record.dispatch.phase, "failed");
	await assert.rejects(
		attachment.submissions.dispatch("item", 2, "retry", async () => {}),
		{ code: "stale" },
	);
});

test("closing storage drains native dispatch and keeps its writer reservation", async (t) => {
	const root = await rootFor(t);
	const attachment = await PiFlowAttachment.open(root, scope);
	const entered = deferred(),
		release = deferred();
	await attachment.submissions.retain(submission());
	const dispatch = assert.rejects(
		attachment.submissions.dispatch("item", 1, "operation", async () => {
			entered.resolve();
			await release.promise;
		}),
		{ code: "closed" },
	);
	await entered.promise;
	const closing = attachment.close();
	await assert.rejects(PiFlowAttachment.open(root, scope), { code: "busy" });
	release.resolve();
	await Promise.all([dispatch, closing]);
	const next = await PiFlowAttachment.open(root, scope);
	afterCleanup(t, () => next.close());
	assert.equal((await next.submissions.snapshot())[0].dispatch.phase, "started");
});

test("one native dispatch retains original input and runs Pi input transformation once", async (t) => {
	const root = await rootFor(t);
	let attachment,
		transformations = 0;
	const { session, requests } = await createFlowSession(cleanupContext(t), {
		ingress: {
			version: 1,
			async submit(input, dispatch) {
				const record = await attachment.submissions.retain(input);
				await attachment.submissions.dispatch(record.id, record.revision, "operation", dispatch);
			},
		},
		extensions: [
			(pi) =>
				pi.on("input", () => {
					transformations++;
					return { action: "transform", text: "native normalized input" };
				}),
		],
	});
	attachment = await PiFlowAttachment.open(root, { sessionId: session.sessionId, branchId: "main" });
	afterCleanup(t, () => attachment.close());
	await session.prompt("original input");
	const [record] = await attachment.submissions.snapshot();
	assert.equal(record.submission.args[0], "original input");
	assert.equal(record.dispatch.phase, "returned");
	assert.equal(transformations, 1);
	assert.equal(requests.length, 1);
	assert.equal(requests[0].find((message) => message.role === "user").content[0].text, "native normalized input");
});
async function rootFor(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-submissions-"));
	afterCleanup(t, () => rm(root, { recursive: true, force: true }));
	return root;
}

test("local Pi attachment reopens retained input exactly and cancellation survives replay", async (t) => {
	const root = await rootFor(t);
	let attachment = await PiFlowAttachment.open(root, scope);
	afterCleanup(t, () => attachment.close());
	const original = submission();
	const saved = attachment.submissions.retain(original);
	original.id = "mutated";
	original.args[0][0].text = "changed";
	assert.deepEqual(await saved, { id: "item", revision: 1, status: "retained", duplicate: false });
	await attachment.close();
	attachment = await PiFlowAttachment.open(root, scope);
	const entries = await attachment.submissions.snapshot();
	assert.deepEqual(entries[0].submission, submission());
	assert.equal(entries[0].submission.args[1], undefined);
	assert.equal(entries[0].submission.args.length, 2);
	assert.deepEqual(await attachment.submissions.cancel("item", 0), { kind: "conflict", revision: 1 });
	assert.deepEqual(await attachment.submissions.cancel("item", 1), { kind: "cancelled", revision: 2 });
	assert.deepEqual(await attachment.submissions.retain(submission()), {
		id: "item",
		revision: 2,
		status: "cancelled",
		duplicate: true,
	});
	await attachment.close();
	attachment = await PiFlowAttachment.open(root, scope);
	assert.equal((await attachment.submissions.snapshot())[0].status, "cancelled");
});

test("actual AgentSession capture commits before acceptance and leaves the native queues empty", async (t) => {
	const root = await rootFor(t);
	let attachment;
	const { session, requests } = await createFlowSession(cleanupContext(t), {
		ingress: {
			version: 1,
			submit: async (input) => {
				await attachment.submissions.retain(input);
			},
		},
	});
	attachment = await PiFlowAttachment.open(root, { sessionId: session.sessionId, branchId: "main" });
	afterCleanup(t, () => attachment.close());
	await session.prompt("manual", { images: [{ type: "image", data: "YQ==", mimeType: "image/png" }] });
	await session.sendCustomMessage(
		{ customType: "context", content: "aside", display: false },
		{ deliverAs: "nextTurn" },
	);
	const records = await attachment.submissions.snapshot();
	assert.equal(records.length, 2);
	assert.ok(records.every((record) => record.submission.hostState.streaming === false));
	assert.equal(requests.length, 0);
	assert.deepEqual(session.agent.inspectQueuedMessages(), []);
	await attachment.close();
	await assert.rejects(session.prompt("late"), /closed/);
});

test("capture state survives reopen while earlier records remain distinguishable", async (t) => {
	const root = await rootFor(t);
	let attachment = await PiFlowAttachment.open(root, scope);
	afterCleanup(t, () => attachment.close());
	await attachment.submissions.retain(submission("earlier"));
	await attachment.submissions.retain({ ...submission("streaming"), hostState: { streaming: true } });
	assert.throws(() => attachment.submissions.retain({ ...submission("invalid"), hostState: { streaming: "false" } }), {
		code: "schema",
	});
	await attachment.close();
	attachment = await PiFlowAttachment.open(root, scope);
	const records = await attachment.submissions.snapshot();
	assert.equal(records.find((record) => record.id === "earlier").submission.hostState, undefined);
	assert.deepEqual(records.find((record) => record.id === "streaming").submission.hostState, { streaming: true });
});

test("concurrent duplicate retention is idempotent and changed identities are rejected", async (t) => {
	const root = await rootFor(t);
	const attachment = await PiFlowAttachment.open(root, scope);
	afterCleanup(t, () => attachment.close());
	const results = await Promise.all(Array.from({ length: 20 }, () => attachment.submissions.retain(submission())));
	assert.equal(results.filter((result) => !result.duplicate).length, 1);
	await assert.rejects(attachment.submissions.retain({ ...submission(), args: ["changed"] }), { code: "identity" });
	assert.equal((await attachment.submissions.snapshot()).length, 1);
});

test("bounded retention rejects overflow without dropping cancelled tombstones or prior content", async (t) => {
	const root = await rootFor(t);
	const owner = FlowOwnership.acquire(root, scope);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, context);
	afterCleanup(t, async () => {
		await owner.close(() => session.close(context));
		await repo.close(context);
	});
	const store = await FlowSubmissionStore.attach(session, owner, { maxRecords: 1, maxBytes: 8192 });
	await store.retain(submission());
	await store.cancel("item", 1);
	await assert.rejects(store.retain(submission("other")), { code: "capacity" });
	assert.equal((await store.snapshot())[0].status, "cancelled");
	const bad = submission("huge");
	bad.args = ["x".repeat(9000)];
	const byteLimited = await FlowSubmissionStore.attach(session, owner, { maxRecords: 10, maxBytes: 8192 });
	await assert.rejects(byteLimited.retain(bad), { code: "capacity" });
	assert.equal((await store.snapshot()).length, 1);
});

test("malformed persistent state and unsupported values cannot become an empty successful queue", async (t) => {
	const root = await rootFor(t);
	const owner = FlowOwnership.acquire(root, scope);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, context);
	afterCleanup(t, async () => {
		await owner.close(() => session.close(context));
		await repo.close(context);
	});
	const store = await FlowSubmissionStore.attach(session, owner);
	for (const input of [new Date(), new Map(), Number.NaN, () => {}, -0]) {
		assert.throws(() => store.retain({ ...submission(), args: [input] }), { code: "schema" });
	}
	await session.mutate(
		(mutation, ctx) => mutation.commit([setValue(value("jouzu.flow.submissions", "v1"), { version: 2 })], ctx),
		context,
	);
	await assert.rejects(store.snapshot(), { code: "schema" });
	await assert.rejects(FlowSubmissionStore.attach(session, owner), { code: "schema" });
});

test("unreadable JSONL header is preserved and never replaced by a new flow session", async (t) => {
	const root = await rootFor(t);
	const attachment = await PiFlowAttachment.open(root, scope);
	await attachment.submissions.retain(submission());
	await attachment.close();
	const [branch] = await readdir(root);
	const sessions = join(root, branch, "sessions");
	const [folder] = await readdir(sessions);
	const [file] = await readdir(join(sessions, folder));
	const path = join(sessions, folder, file);
	await writeFile(path, "broken header\n");
	await assert.rejects(PiFlowAttachment.open(root, scope), /metadata is missing/);
	assert.equal(await readFile(path, "utf8"), "broken header\n");
	assert.deepEqual(await readdir(join(sessions, folder)), [file]);
});

for (const mismatch of ["foreign branch", "foreign root", "shared digest prefix", "foreign id"])
	test(`legacy path acceptance rejects ${mismatch} metadata without rewriting it`, async (t) => {
		const root = await rootFor(t);
		const attachment = await PiFlowAttachment.open(root, scope);
		await attachment.submissions.retain(submission());
		await attachment.close();
		const [branch] = await readdir(root);
		const sessions = join(root, branch, "sessions");
		const [folder] = await readdir(sessions);
		const [file] = await readdir(join(sessions, folder));
		const path = join(sessions, folder, file);
		const text = await readFile(path, "utf8");
		const end = text.indexOf("\n");
		const header = JSON.parse(text.slice(0, end));
		const legacy = legacyPathDigest([scope.sessionId, scope.branchId]);
		if (mismatch === "foreign branch") header.cwd = join(root, legacyPathDigest([scope.sessionId, "other"]));
		if (mismatch === "foreign root") header.cwd = join(root, "other-root", legacy);
		if (mismatch === "shared digest prefix")
			header.cwd = join(root, legacy.slice(0, -1) + (legacy.endsWith("0") ? "1" : "0"));
		if (mismatch === "foreign id") {
			header.cwd = join(root, legacy);
			header.id = "other";
		}
		const invalid = JSON.stringify(header) + text.slice(end);
		await writeFile(path, invalid);
		await assert.rejects(PiFlowAttachment.open(root, scope), /metadata is missing/);
		assert.equal(await readFile(path, "utf8"), invalid);
		assert.deepEqual(await readdir(join(sessions, folder)), [file]);
	});

test("process death after retention acknowledgement restores exact input with the production opener", {
	timeout: 15000,
}, async (t) => {
	const root = await rootFor(t);
	const child = fork(new URL("./fixtures/flow-submission-crash.mjs", import.meta.url), [root], {
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	afterCleanup(t, () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	});
	const [ready] = await once(child, "message");
	assert.equal(ready.saved, true);
	const ended = once(child, "exit");
	child.kill("SIGKILL");
	await ended;
	const attachment = await PiFlowAttachment.open(root, scope);
	afterCleanup(t, () => attachment.close());
	const [record] = await attachment.submissions.snapshot();
	assert.equal(record.status, "retained");
	assert.equal(record.submission.args[0], "survives process death");
	assert.equal((await attachment.ledger.snapshot()).activeAttemptId, undefined);
});

test("separate branches retain separate input and a missing record is a storage failure", async (t) => {
	const root = await rootFor(t);
	const first = await PiFlowAttachment.open(root, scope);
	const second = await PiFlowAttachment.open(root, { ...scope, branchId: "other" });
	afterCleanup(t, async () => {
		await first.close();
		await second.close();
	});
	await first.submissions.retain(submission());
	assert.deepEqual(await second.submissions.snapshot(), []);
	await second.submissions.retain({ ...submission(), args: ["other branch"] });
	assert.deepEqual((await first.submissions.snapshot())[0].submission, submission());
	await first.close();
	assert.equal((await second.submissions.snapshot())[0].submission.args[0], "other branch");
});

test("manifest/content mismatch refuses reattachment without replacing authoritative records", async (t) => {
	const root = await rootFor(t);
	const owner = FlowOwnership.acquire(root, scope);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, context);
	afterCleanup(t, async () => {
		await owner.close(() => session.close(context));
		await repo.close(context);
	});
	const store = await FlowSubmissionStore.attach(session, owner);
	await store.retain(submission());
	const address = value("jouzu.flow.submission", "item");
	await session.mutate((mutation, ctx) => mutation.commit([setValue(address, { id: "different" })], ctx), context);
	await assert.rejects(store.snapshot(), /missing content/);
	await assert.rejects(FlowSubmissionStore.attach(session, owner), /missing content/);
	assert.deepEqual((await session.getValue(address, context)).value, { id: "different" });
});

test("admission diagnostics persist without changing source revisions or authorizing replay", async (t) => {
	const root = await rootFor(t);
	let attachment = await PiFlowAttachment.open(root, scope);
	afterCleanup(t, () => attachment.close());
	await attachment.submissions.retain(submission());
	const target = { phase: "submission" };
	assert.equal(await attachment.submissions.recordAdmission("item", 1, target, "Waiting for work."), true);
	assert.equal(await attachment.submissions.recordAdmission("item", 1, target, "Waiting for work."), true);
	let [saved] = await attachment.submissions.snapshot();
	assert.equal(saved.revision, 1);
	assert.equal(saved.holds.length, 1);
	assert.deepEqual(saved.submission, submission());
	await attachment.close();
	attachment = await PiFlowAttachment.open(root, scope);
	[saved] = await attachment.submissions.snapshot();
	assert.equal(saved.holds[0].reason, "Waiting for work.");
	assert.equal(saved.dispatch, undefined);
	assert.equal(await attachment.submissions.recordAdmission("item", 1, target), true);
	assert.equal((await attachment.submissions.snapshot())[0].holds, undefined);
	await attachment.submissions.cancel("item", 1);
	assert.equal(await attachment.submissions.recordAdmission("item", 1, target, "stale update"), false);
});

test("admission diagnostics reject oversized reasons and invented queue identities", async (t) => {
	const root = await rootFor(t);
	const attachment = await PiFlowAttachment.open(root, scope);
	afterCleanup(t, () => attachment.close());
	await attachment.submissions.retain(submission());
	assert.throws(() => attachment.submissions.recordAdmission("item", 1, { phase: "submission" }, "あ".repeat(342)), {
		code: "schema",
	});
	await assert.rejects(
		attachment.submissions.recordAdmission(
			"item",
			1,
			{ phase: "queue", queue: { id: "invented", revision: 1 } },
			"held",
		),
		{ code: "stale" },
	);
	assert.equal((await attachment.submissions.snapshot())[0].holds, undefined);
});

test("pending cancellation cannot retire an active native dispatch intent", async (t) => {
	const root = await rootFor(t);
	const attachment = await PiFlowAttachment.open(root, scope);
	afterCleanup(t, () => attachment.close());
	await attachment.submissions.retain(submission());
	const entered = deferred(),
		finish = deferred();
	const dispatch = attachment.submissions.dispatch("item", 1, "operation", async () => {
		entered.resolve();
		await finish.promise;
	});
	await entered.promise;
	try {
		await assert.rejects(attachment.submissions.cancelPending("item", 1), { code: "transition" });
		assert.equal((await attachment.submissions.snapshot())[0].status, "retained");
	} finally {
		finish.resolve();
		await dispatch;
	}
});

async function consumeForArchive(store, id) {
	await store.retain(submission(id));
	await store.dispatch(id, 1, `operation-${id}`, async (observer) => {
		await observer.observe({ kind: "prompt", args: [id] });
		await store.recordPromptClaim(`operation-${id}`, { inputIndex: 0, messageIndex: 0 });
	});
}

test("submission archive frees admission slots and preserves source order across reopen", async (t) => {
	const root = await rootFor(t);
	const owner = FlowOwnership.acquire(root, scope);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, context);
	afterCleanup(t, async () => {
		await owner.close(() => session.close(context));
		await repo.close(context);
	});
	let store = await FlowSubmissionStore.attach(session, owner, { maxRecords: 2, maxBytes: 8192 });
	await consumeForArchive(store, "first");
	await consumeForArchive(store, "second");
	const before = await store.snapshot();
	await assert.rejects(store.retain(submission("third")), { code: "capacity" });
	assert.equal(await store.archiveHandled([{ id: "second", revision: 1 }]), 1);
	assert.deepEqual(await store.snapshot(), before);
	assert.deepEqual(
		(await store.snapshot(false)).map((r) => r.id),
		["first"],
	);
	await consumeForArchive(store, "third");
	assert.equal(await store.archiveHandled([{ id: "first", revision: 1 }]), 1);
	store = await FlowSubmissionStore.attach(session, owner, { maxRecords: 2, maxBytes: 8192 });
	assert.deepEqual(
		(await store.snapshot()).map((r) => r.id),
		["first", "second", "third"],
	);
	assert.deepEqual((await store.snapshot()).slice(0, 2), before);
	assert.equal(await store.archiveHandled([{ id: "first", revision: 1 }]), 0);
	await assert.rejects(store.retain(submission("first")), { code: "stale" });
	await store.retain(submission("fourth"));
	let dispatched = false;
	await assert.rejects(
		store.dispatch("fourth", 1, "operation-first", async () => {
			dispatched = true;
		}),
		{ code: "identity" },
	);
	assert.equal(dispatched, false);
});

test("submission operation queries validate only selected archived bodies", async (t) => {
	const root = await rootFor(t);
	const owner = FlowOwnership.acquire(root, scope);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, context);
	afterCleanup(t, async () => {
		await owner.close(() => session.close(context));
		await repo.close(context);
	});
	let store = await FlowSubmissionStore.attach(session, owner);
	for (const id of ["first", "second", "active"]) await consumeForArchive(store, id);
	const before = await store.snapshot();
	await store.archiveHandled(["first", "second"].map((id) => ({ id, revision: 1 })));
	store = await FlowSubmissionStore.attach(session, owner);
	assert.deepEqual(await store.forOperations(["operation-active", "operation-first", "operation-first"]), [
		before[0],
		before[2],
	]);
	assert.deepEqual(await store.forOperations([]), []);
	assert.deepEqual(await store.forOperations(["unknown"]), []);
	await assert.rejects(store.forOperations([""]), { code: "identity" });
	assert.deepEqual(await store.forIds(["active", "first", "first"]), [before[0], before[2]]);
	assert.deepEqual(await store.forIds([]), []);
	assert.deepEqual(await store.forIds(["unknown"]), []);
	await assert.rejects(store.forIds([""]), { code: "identity" });
	await session.mutate(async (mutation, ctx) => {
		const address = value("jouzu.flow.submission", "second");
		const record = (await mutation.getValue(address, ctx)).value;
		return mutation.commit([setValue(address, { ...record, acceptedAt: record.acceptedAt + 1 })], ctx);
	}, context);
	assert.deepEqual(await store.forOperations(["operation-first"]), [before[0]]);
	assert.deepEqual(await store.forIds(["first"]), [before[0]]);
	await assert.rejects(store.forIds(["second"]), { code: "identity" });
	assert.deepEqual(await store.forOperations([]), []);
	await assert.rejects(store.forOperations(["operation-second"]), { code: "identity" });
	await assert.rejects(store.snapshot(), { code: "identity" });
});

test("archive rejects unconsumed submissions atomically and detects changed historical bodies", async (t) => {
	const root = await rootFor(t);
	const owner = FlowOwnership.acquire(root, scope);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, context);
	afterCleanup(t, async () => {
		await owner.close(() => session.close(context));
		await repo.close(context);
	});
	const store = await FlowSubmissionStore.attach(session, owner);
	await consumeForArchive(store, "handled");
	await store.retain(submission("pending"));
	const before = await store.snapshot();
	await assert.rejects(
		store.archiveHandled([
			{ id: "handled", revision: 1 },
			{ id: "pending", revision: 1 },
		]),
		{ code: "busy" },
	);
	assert.deepEqual(await store.snapshot(false), before);
	await store.archiveHandled([{ id: "handled", revision: 1 }]);
	await session.mutate(async (mutation, ctx) => {
		const address = value("jouzu.flow.submission", "handled");
		const record = (await mutation.getValue(address, ctx)).value;
		return mutation.commit([setValue(address, { ...record, acceptedAt: record.acceptedAt + 1 })], ctx);
	}, context);
	await assert.rejects(store.snapshot(), { code: "identity" });
	const reopened = await FlowSubmissionStore.attach(session, owner);
	assert.deepEqual(await reopened.snapshot(false), await store.snapshot(false));
	await assert.rejects(reopened.forOperations(["operation-handled"]), { code: "identity" });
});

test("submission history migration validates bodies and publishes indexes atomically", async (t) => {
	const root = await rootFor(t);
	const owner = FlowOwnership.acquire(root, scope);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, context);
	afterCleanup(t, async () => {
		await owner.close(() => session.close(context));
		await repo.close(context);
	});
	let store = await FlowSubmissionStore.attach(session, owner);
	for (const id of ["first", "second", "active"]) await consumeForArchive(store, id);
	const before = await store.snapshot();
	await store.archiveHandled([
		{ id: "second", revision: 1 },
		{ id: "first", revision: 1 },
	]);
	const headerAddress = value("jouzu.flow.submissions", "v1");
	let legacy;
	let first;
	await session.mutate(async (mutation, ctx) => {
		const { history: _history, ...header } = (await mutation.getValue(headerAddress, ctx)).value;
		const archived = [];
		for (const id of ["second", "first"]) {
			const record = (await mutation.getValue(value("jouzu.flow.submission", id), ctx)).value;
			if (id === "first") first = record;
			archived.push({
				id,
				revision: record.revision,
				operationId: record.dispatch.operationId,
				bytes: Buffer.byteLength(JSON.stringify(record)),
				contentHash: createHash("sha256").update(JSON.stringify(record)).digest("hex"),
			});
		}
		legacy = { ...header, archived, orderIds: ["first", "second", "active"] };
		await mutation.commit(
			[
				setValue(headerAddress, legacy),
				setValue(value("jouzu.flow.submission", "first"), { ...first, acceptedAt: first.acceptedAt + 1 }),
			],
			ctx,
		);
	}, context);
	await assert.rejects(FlowSubmissionStore.attach(session, owner), { code: "identity" });
	await session.mutate(async (mutation, ctx) => {
		assert.deepEqual((await mutation.getValue(headerAddress, ctx)).value, legacy);
		const key = createHash("sha256")
			.update(JSON.stringify([legacy.revision, "id", "second"]))
			.digest("hex");
		assert.equal(await mutation.getValue(value("jouzu.flow.submission-history", key), ctx), undefined);
		await mutation.commit([setValue(value("jouzu.flow.submission", "first"), first)], ctx);
	}, context);
	const failing = {
		mutate: (run, ctx) =>
			session.mutate(
				(mutation, current) =>
					run(
						new Proxy(mutation, {
							get(target, key) {
								if (key === "commit")
									return async () => {
										throw new Error("injected migration commit failure");
									};
								const result = Reflect.get(target, key);
								return typeof result === "function" ? result.bind(target) : result;
							},
						}),
						current,
					),
				ctx,
			),
	};
	await assert.rejects(FlowSubmissionStore.attach(failing, owner), /injected migration commit failure/);
	await session.mutate(async (mutation, ctx) => {
		assert.deepEqual((await mutation.getValue(headerAddress, ctx)).value, legacy);
	}, context);
	store = await FlowSubmissionStore.attach(session, owner);
	assert.deepEqual(await store.snapshot(), before);
	await session.mutate(async (mutation, ctx) => {
		const header = (await mutation.getValue(headerAddress, ctx)).value;
		assert.equal(header.archived, undefined);
		assert.equal(header.orderIds, undefined);
		assert.equal(header.history.next, 3);
		assert.deepEqual(header.history.active, [{ id: "active", position: 2 }]);
		assert.deepEqual((await mutation.getValue(value("jouzu.flow.submission", "first"), ctx)).value, first);
	}, context);
	await assert.rejects(store.retain(submission("first")), { code: "stale" });
	await store.retain(submission("fresh"));
	await assert.rejects(
		store.dispatch("fresh", 1, "operation-first", async () => {}),
		{ code: "identity" },
	);
	await store.reset();
	assert.deepEqual(await store.snapshot(), []);
	assert.deepEqual(await store.forOperations(["operation-first"]), []);
	await consumeForArchive(store, "first");
	await store.archiveHandled([{ id: "first", revision: 1 }]);
	store = await FlowSubmissionStore.attach(session, owner);
	assert.deepEqual(
		(await store.snapshot()).map((record) => record.id),
		["first"],
	);
});

test("submission indexes outlive the archive count quota without routine history reads", async (t) => {
	const root = await rootFor(t);
	const owner = FlowOwnership.acquire(root, scope);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, context);
	afterCleanup(t, async () => {
		await owner.close(() => session.close(context));
		await repo.close(context);
	});
	let reads = 0;
	const counted = {
		mutate: (run, ctx) =>
			session.mutate(
				(mutation, current) =>
					run(
						new Proxy(mutation, {
							get(target, key) {
								if (key === "getValue")
									return (...args) => {
										reads++;
										return target.getValue(...args);
									};
								const result = Reflect.get(target, key);
								return typeof result === "function" ? result.bind(target) : result;
							},
						}),
						current,
					),
				ctx,
			),
	};
	let store = await FlowSubmissionStore.attach(counted, owner, { maxRecords: 1, maxBytes: 8192 });
	for (let index = 0; index < 16385; index++) {
		const id = `entry-${index}`;
		await store.retain(submission(id));
		await store.dispatch(id, 1, `op-${index}`, async (observer) => observer.completeWithoutInput());
		await store.archiveHandled([{ id, revision: 1 }]);
	}
	reads = 0;
	store = await FlowSubmissionStore.attach(counted, owner, { maxRecords: 1, maxBytes: 8192 });
	assert.equal(reads, 1);
	reads = 0;
	assert.deepEqual(await store.snapshot(false), []);
	assert.equal(reads, 1);
	reads = 0;
	assert.deepEqual(
		(await store.forOperations(["op-16384"])).map((record) => record.id),
		["entry-16384"],
	);
	assert.equal(reads, 3);
	reads = 0;
	await assert.rejects(store.retain(submission("entry-0")), { code: "stale" });
	assert.equal(reads, 2);
	await session.mutate(async (mutation, ctx) => {
		const header = (await mutation.getValue(value("jouzu.flow.submissions", "v1"), ctx)).value;
		assert.ok(Buffer.byteLength(JSON.stringify(header)) < 512);
		assert.equal(header.history.next, 16385);
	}, context);
	assert.equal((await store.snapshot()).length, 16385);
});

test("submission indexes outlive the archived byte quota without legacy validation", async (t) => {
	const root = await rootFor(t);
	const owner = FlowOwnership.acquire(root, scope);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, context);
	afterCleanup(t, async () => {
		await owner.close(() => session.close(context));
		await repo.close(context);
	});
	const padded = (id) => ({
		...submission(id),
		args: [
			[
				{ type: "text", text: "x".repeat(3 * 1024 * 1024) },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			],
			undefined,
		],
	});
	let store = await FlowSubmissionStore.attach(session, owner, { maxRecords: 1, maxBytes: 4 * 1024 * 1024 });
	let total = 0;
	for (let index = 0; index < 22; index++) {
		const id = `bulk-${index}`;
		const input = padded(id);
		total += Buffer.byteLength(JSON.stringify(input));
		await store.retain(input);
		await store.dispatch(id, 1, `bulk-op-${index}`, async (observer) => observer.completeWithoutInput());
		await store.archiveHandled([{ id, revision: 1 }]);
	}
	assert.ok(total > 64 * 1024 * 1024, "archived bodies must exceed the former legacy byte cap");
	store = await FlowSubmissionStore.attach(session, owner, { maxRecords: 1, maxBytes: 4 * 1024 * 1024 });
	assert.deepEqual(await store.snapshot(false), []);
	assert.equal((await store.snapshot()).length, 22);
	assert.deepEqual(
		(await store.forOperations(["bulk-op-21"])).map((record) => record.id),
		["bulk-21"],
	);
	await assert.rejects(store.retain(padded("bulk-0")), { code: "stale" });
});

test("exact history queries treat a deleted index copy as absent while full inspection keeps validating", async (t) => {
	const root = await rootFor(t);
	const owner = FlowOwnership.acquire(root, scope);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, context);
	afterCleanup(t, async () => {
		await owner.close(() => session.close(context));
		await repo.close(context);
	});
	let store = await FlowSubmissionStore.attach(session, owner);
	await consumeForArchive(store, "fault-first");
	await consumeForArchive(store, "fault-second");
	await store.archiveHandled([
		{ id: "fault-first", revision: 1 },
		{ id: "fault-second", revision: 1 },
	]);
	const before = await store.snapshot();
	await session.mutate(async (mutation, ctx) => {
		const header = (await mutation.getValue(value("jouzu.flow.submissions", "v1"), ctx)).value;
		const key = createHash("sha256")
			.update(JSON.stringify([header.history.generation, "operation", "operation-fault-first"]))
			.digest("hex");
		return mutation.commit([deleteValue(value("jouzu.flow.submission-history", key))], ctx);
	}, context);
	store = await FlowSubmissionStore.attach(session, owner);
	assert.deepEqual(await store.forOperations(["operation-fault-first"]), []);
	assert.deepEqual(await store.forIds(["fault-first"]), [before[0]]);
	assert.deepEqual(await store.snapshot(), before);
	await assert.rejects(store.retain(submission("fault-first")), { code: "stale" });
});

test("terminal cancellations retire into indexed history and free admission capacity", async (t) => {
	const root = await rootFor(t);
	const owner = FlowOwnership.acquire(root, scope);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, context);
	afterCleanup(t, async () => {
		await owner.close(() => session.close(context));
		await repo.close(context);
	});
	let store = await FlowSubmissionStore.attach(session, owner, { maxRecords: 2, maxBytes: 8192 });
	for (let index = 0; index < 6; index++) {
		await store.retain(submission(`cancelled-${index}`));
		assert.equal((await store.cancelPending(`cancelled-${index}`, 1)).kind, "cancelled");
		assert.equal(await store.archiveCompleted(), 1);
	}
	assert.deepEqual(await store.snapshot(false), []);
	assert.equal((await store.snapshot()).length, 6);
	const cancelledThird = (await store.snapshot()).find((record) => record.id === "cancelled-3");
	assert.equal(cancelledThird.dispatch, undefined);
	assert.deepEqual(await store.forIds(["cancelled-3"]), [cancelledThird]);
	await assert.rejects(store.retain(submission("cancelled-3")), { code: "stale" });
	// An admission hold does not keep a cancelled submission in the active window.
	await store.retain(submission("held-cancel"));
	assert.equal(await store.recordAdmission("held-cancel", 1, { phase: "submission" }, "held by policy"), true);
	assert.equal((await store.cancelPending("held-cancel", 1)).kind, "cancelled");
	assert.equal(await store.archiveCompleted(), 1);
	// A cancelled dispatch with an unsettled input keeps its evidence active.
	await store.retain(submission("failed"));
	await assert.rejects(
		store.dispatch("failed", 1, "operation-failed", async (observer) => {
			await observer.observe({ kind: "prompt", args: ["failed"] });
			await store.cancel("failed", 1);
			throw new Error("native failed after an effect");
		}),
		/native failed after an effect/,
	);
	const failed = (await store.snapshot(false))[0];
	assert.equal(failed.status, "cancelled");
	assert.equal(failed.dispatch.phase, "failed");
	assert.equal(await store.archiveCompleted(), 0);
	await assert.rejects(store.archiveHandled([{ id: "failed", revision: 2 }]), { code: "busy" });
	// A retained dispatch whose queue input is cancellation-confirmed retires with its receipts.
	await store.retain(submission("queued"));
	await store.dispatch("queued", 1, "operation-queued", async (observer) => {
		await observer.observe({ kind: "followUp", args: ["queued"], queue: { id: "queue-1", revision: 1 } });
		await store.cancelQueue("operation-queued", { id: "queue-1", revision: 1 });
		await store.recordQueueClaim("operation-queued", { id: "queue-1", revision: 1 }, false);
	});
	assert.equal(await store.archiveCompleted(), 1);
	const queued = (await store.snapshot()).find((record) => record.id === "queued");
	assert.deepEqual(queued.dispatch.queueCancellations, [{ id: "queue-1", revision: 1 }]);
	assert.deepEqual(queued.dispatch.queueClaims, [{ id: "queue-1", revision: 1, consumed: false }]);
	await assert.rejects(store.retain(submission("queued")), { code: "stale" });
	// An unconsumed queue claim without its cancellation receipt keeps the record active.
	await store.retain(submission("queued-held"));
	await store.dispatch("queued-held", 1, "operation-queued-held", async (observer) => {
		await observer.observe({ kind: "followUp", args: ["held"], queue: { id: "queue-2", revision: 1 } });
		await store.recordQueueClaim("operation-queued-held", { id: "queue-2", revision: 1 }, false);
	});
	assert.equal(await store.archiveCompleted(), 0);
	await store.cancelQueue("operation-queued-held", { id: "queue-2", revision: 1 });
	assert.equal(await store.archiveCompleted(), 1);
	const queuedHeld = (await store.snapshot()).find((record) => record.id === "queued-held");
	assert.deepEqual(queuedHeld.dispatch.queueCancellations, [{ id: "queue-2", revision: 1 }]);
	// A confirmed context cancellation settles its input the same way.
	await store.retain({
		...submission("context"),
		api: "sendCustomMessage",
		args: [[{ type: "text", text: "context" }], { deliverAs: "nextTurn" }],
	});
	await store.dispatch("context", 1, "operation-context", async (observer) => {
		await observer.observe({ kind: "context", args: ["context"] });
		await store.cancelContext("operation-context", 0);
		await store.confirmContextCancellation("operation-context", 0);
	});
	assert.equal(await store.archiveCompleted(), 1);
	store = await FlowSubmissionStore.attach(session, owner, { maxRecords: 2, maxBytes: 8192 });
	assert.deepEqual(
		(await store.snapshot(false)).map((record) => record.id),
		["failed"],
	);
	assert.equal((await store.snapshot()).length, 11);
});

test("indexed submission receipts survive disk reopen and rejected retirement guards", async (t) => {
	const root = await rootFor(t);
	let attachment = await PiFlowAttachment.open(root, scope);
	afterCleanup(t, () => attachment.close());
	await consumeForArchive(attachment.submissions, "disk-first");
	await consumeForArchive(attachment.submissions, "disk-second");
	const before = await attachment.submissions.snapshot();
	let checks = 0;
	await assert.rejects(
		attachment.submissions.archiveHandled([{ id: "disk-second", revision: 1 }], () => {
			if (++checks === 2) throw new Error("retirement authorization changed");
		}),
		/retirement authorization changed/,
	);
	assert.deepEqual(await attachment.submissions.snapshot(false), before);
	await attachment.submissions.archiveHandled([{ id: "disk-second", revision: 1 }]);
	await attachment.close();
	attachment = await PiFlowAttachment.open(root, scope);
	assert.deepEqual(await attachment.submissions.snapshot(), before);
	assert.deepEqual(await attachment.submissions.forOperations(["operation-disk-second"]), [before[1]]);
	await assert.rejects(attachment.submissions.retain(submission("disk-second")), { code: "stale" });
	await attachment.submissions.reset();
	await attachment.close();
	attachment = await PiFlowAttachment.open(root, scope);
	assert.deepEqual(await attachment.submissions.snapshot(), []);
	assert.deepEqual(await attachment.submissions.forOperations(["operation-disk-second"]), []);
});
