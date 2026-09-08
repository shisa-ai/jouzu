import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context, MemorySessionRepo, setValue, value } from "@earendil-works/pi-agent-core";
import { createFlowSession } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { FlowOwnership } from "../dist/flow-control/ownership.js";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { FlowSubmissionStore } from "../dist/flow-control/submission-store.js";

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
async function rootFor(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-submissions-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("local Pi attachment reopens retained input exactly and cancellation survives replay", async (t) => {
	const root = await rootFor(t);
	let attachment = await PiFlowAttachment.open(root, scope);
	t.after(() => attachment.close());
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
	const { session, requests } = await createFlowSession(t, {
		ingress: {
			version: 1,
			submit: async (input) => {
				await attachment.submissions.retain(input);
			},
		},
	});
	attachment = await PiFlowAttachment.open(root, { sessionId: session.sessionId, branchId: "main" });
	t.after(() => attachment.close());
	await session.prompt("manual", { images: [{ type: "image", data: "YQ==", mimeType: "image/png" }] });
	await session.sendCustomMessage(
		{ customType: "context", content: "aside", display: false },
		{ deliverAs: "nextTurn" },
	);
	assert.equal((await attachment.submissions.snapshot()).length, 2);
	assert.equal(requests.length, 0);
	assert.deepEqual(session.agent.inspectQueuedMessages(), []);
	await attachment.close();
	await assert.rejects(session.prompt("late"), /closed/);
});

test("concurrent duplicate retention is idempotent and changed identities are rejected", async (t) => {
	const root = await rootFor(t);
	const attachment = await PiFlowAttachment.open(root, scope);
	t.after(() => attachment.close());
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
	t.after(async () => {
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
	t.after(async () => {
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

test("process death after retention acknowledgement restores exact input with the production opener", {
	timeout: 15000,
}, async (t) => {
	const root = await rootFor(t);
	const child = fork(new URL("./fixtures/flow-submission-crash.mjs", import.meta.url), [root], {
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	t.after(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	});
	const [ready] = await once(child, "message");
	assert.equal(ready.saved, true);
	const ended = once(child, "exit");
	child.kill("SIGKILL");
	await ended;
	const attachment = await PiFlowAttachment.open(root, scope);
	t.after(() => attachment.close());
	const [record] = await attachment.submissions.snapshot();
	assert.equal(record.status, "retained");
	assert.equal(record.submission.args[0], "survives process death");
	assert.equal((await attachment.ledger.snapshot()).activeAttemptId, undefined);
});

test("separate branches retain separate input and a missing record is a storage failure", async (t) => {
	const root = await rootFor(t);
	const first = await PiFlowAttachment.open(root, scope);
	const second = await PiFlowAttachment.open(root, { ...scope, branchId: "other" });
	t.after(async () => {
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
	t.after(async () => {
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
