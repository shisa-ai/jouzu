import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FlowOwnership } from "../dist/flow-control/ownership.js";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { FlowSubmissionStore } from "../dist/flow-control/submission-store.js";
import { afterCleanup } from "./fixtures/cleanup.mjs";
import {
	BACKGROUND_CONTEXT,
	JsonlSessionRepo,
	MemorySessionRepo,
	NodeExecutionEnv,
	setValue,
	value,
} from "./fixtures/flow-storage.mjs";

const scope = { sessionId: "external-input", branchId: "main" };
const digest = createHash("sha256").update("payload").digest("hex");
function submission(attachmentId = "first") {
	return {
		version: 1,
		id: "external-message",
		api: "prompt",
		origin: { kind: "extension", id: "/fixture/index.ts" },
		scope: { sessionId: scope.sessionId, leafId: null, attachmentId },
		externalUser: { version: 1, adapterId: "fixture", messageId: "message" },
		args: ["literal text", { expandPromptTemplates: false, streamingBehavior: "followUp", source: "extension" }],
	};
}
async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-external-store-"));
	let attachment = await PiFlowAttachment.open(root, scope);
	afterCleanup(t, async () => {
		await attachment.close();
		await rm(root, { recursive: true, force: true });
	});
	return {
		get store() {
			return attachment.submissions;
		},
		async reopen() {
			await attachment.close();
			attachment = await PiFlowAttachment.open(root, scope);
		},
	};
}

/** Retain against the current epoch, as the adapter does after validating its target. */
const retainExternal = async (store, submission, digest) =>
	store.retainExternal(submission, digest, await store.externalTargetEpoch());

test("external target epoch survives reopen but not reset or replacement of storage", async (t) => {
	const f = await fixture(t);
	const epoch = await f.store.externalTargetEpoch();
	await f.reopen();
	assert.equal(await f.store.externalTargetEpoch(), epoch);
	await f.store.reset();
	const resetEpoch = await f.store.externalTargetEpoch();
	assert.notEqual(resetEpoch, epoch);
	await f.reopen();
	assert.equal(await f.store.externalTargetEpoch(), resetEpoch);
	const replacement = await fixture(t);
	assert.notEqual(await replacement.store.externalTargetEpoch(), epoch);
	assert.notEqual(await replacement.store.externalTargetEpoch(), resetEpoch);
});

test("external reattachment preserves ID and payload, fences the old revision, and clears callback-ended", async (t) => {
	const f = await fixture(t);
	await retainExternal(f.store, submission(), digest);
	await f.store.endCallback("external-message", 1);
	await f.reopen();
	const before = (await f.store.forIds(["external-message"]))[0];
	assert.equal(before.unavailable, "callback-ended");
	const saved = await retainExternal(f.store, submission("replacement"), digest);
	assert.equal(saved.reattached, true);
	assert.equal(saved.revision, 2);
	const record = (await f.store.forIds([saved.id]))[0];
	assert.equal(record.unavailable, undefined);
	assert.equal(record.submission.scope.attachmentId, "replacement");
	await assert.rejects(
		f.store.dispatch(saved.id, 1, "old-operation", async () => {}),
		{ code: "stale" },
	);
});

test("an ended external callback cannot acquire dispatch intent", async (t) => {
	const f = await fixture(t);
	await retainExternal(f.store, submission(), digest);
	await f.store.endCallback("external-message", 1);
	let calls = 0;
	await assert.rejects(
		f.store.dispatch("external-message", 1, "operation", async () => {
			calls++;
		}),
		{ code: "transition" },
	);
	assert.equal(calls, 0);
	const [record] = await f.store.forIds(["external-message"]);
	assert.equal(record.unavailable, "callback-ended");
	assert.equal(record.dispatch, undefined);
});

test("external payload conflict and failed dispatch cannot reattach", async (t) => {
	const f = await fixture(t);
	await retainExternal(f.store, submission(), digest);
	await assert.rejects(retainExternal(f.store, submission("replacement"), "b".repeat(64)), { code: "identity" });
	await assert.rejects(
		f.store.dispatch("external-message", 1, "operation", async () => {
			throw new Error("failed");
		}),
		/failed/,
	);
	await f.reopen();
	await assert.rejects(retainExternal(f.store, submission("replacement"), digest), { code: "stale" });
});

test("external cancellation and reason survive reopen without allowing another callback", async (t) => {
	const f = await fixture(t);
	await retainExternal(f.store, submission(), digest);
	assert.equal(await f.store.cancelExternal("external-message", "flow-suspended"), true);
	await f.reopen();
	const [record] = await f.store.forIds(["external-message"]);
	assert.equal(record.status, "cancelled");
	assert.equal(record.cancellationReason, "flow-suspended");
	await assert.rejects(retainExternal(f.store, submission("replacement"), digest), { code: "stale" });
});

test("capacity refuses new IDs but permits reattachment and evidence for existing IDs", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-external-capacity-"));
	const owner = FlowOwnership.acquire(root, scope);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, BACKGROUND_CONTEXT);
	afterCleanup(t, async () => {
		await owner.close(() => session.close(BACKGROUND_CONTEXT));
		await repo.close(BACKGROUND_CONTEXT);
		await rm(root, { recursive: true, force: true });
	});
	const store = await FlowSubmissionStore.attach(session, owner);
	await retainExternal(store, submission(), digest);
	await store.endCallback("external-message", 1);
	await session.mutate(async (mutation, context) => {
		const address = value("jouzu.flow.submissions", "v1");
		const header = (await mutation.getValue(address, context)).value;
		header.externalBudget = { count: 16384, bytes: 64 * 1024 * 1024 };
		await mutation.commit([setValue(address, header)], context);
	}, BACKGROUND_CONTEXT);
	await assert.rejects(retainExternal(store, { ...submission(), id: "new-message" }, digest), { code: "capacity" });
	const saved = await retainExternal(store, submission("replacement"), digest);
	await store.dispatch(saved.id, saved.revision, "operation", async (observer) => observer.completeWithoutInput());
	await store.archiveHandled([{ id: saved.id, revision: saved.revision }]);
	const [archived] = await store.forIds([saved.id]);
	assert.equal(archived.dispatch.noInput, true);
	assert.equal(archived.externalDigest, digest);
	await assert.rejects(retainExternal(store, { ...submission(), id: "still-new" }, digest), { code: "capacity" });
});

test("the encoded-byte budget is enforced separately from the count across archive and reopen", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-external-bytes-"));
	const options = { fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root };
	let repo = new JsonlSessionRepo(options);
	const owner = FlowOwnership.acquire(root, scope);
	let session = await repo.create({ cwd: root }, BACKGROUND_CONTEXT);
	const metadata = session.metadata;
	let store = await FlowSubmissionStore.attach(session, owner);
	afterCleanup(t, async () => {
		await owner.close(() => session.close(BACKGROUND_CONTEXT));
		await repo.close(BACKGROUND_CONTEXT);
		await rm(root, { recursive: true, force: true });
	});
	const readBudget = async () => {
		let budget;
		await session.mutate(async (mutation, context) => {
			budget = (await mutation.getValue(value("jouzu.flow.submissions", "v1"), context)).value.externalBudget;
		}, BACKGROUND_CONTEXT);
		return budget;
	};
	const setBudget = (budget) =>
		session.mutate(async (mutation, context) => {
			const address = value("jouzu.flow.submissions", "v1");
			const header = (await mutation.getValue(address, context)).value;
			await mutation.commit([setValue(address, { ...header, externalBudget: budget })], context);
		}, BACKGROUND_CONTEXT);
	await retainExternal(store, submission(), digest);
	// The byte ceiling alone refuses the second ID: the count is one against a ceiling of 16,384.
	await setBudget({ count: 1, bytes: 64 * 1024 * 1024 });
	await assert.rejects(retainExternal(store, { ...submission(), id: "byte-refused" }, digest), { code: "capacity" });
	assert.equal((await store.snapshot(false)).length, 1);
	// The count ceiling alone refuses the next ID while the byte counter is far from its ceiling.
	await setBudget({ count: 16383, bytes: 0 });
	await retainExternal(store, { ...submission(), id: "count-last" }, digest);
	const counted = await readBudget();
	assert.equal(counted.count, 16384);
	assert.ok(counted.bytes > 0 && counted.bytes < 64 * 1024 * 1024, "the encoded-byte counter advanced too");
	await assert.rejects(retainExternal(store, { ...submission(), id: "count-refused" }, digest), { code: "capacity" });
	assert.equal((await store.snapshot(false)).length, 2);
	// An archived record leaves the active set but stays inside the lifetime budget, and reopening
	// the journal keeps both facts.
	const [original] = await store.forIds(["external-message"]);
	await store.dispatch(original.id, original.revision, "operation", async (observer) =>
		observer.completeWithoutInput(),
	);
	await store.archiveHandled([{ id: original.id, revision: original.revision }]);
	assert.equal((await store.snapshot(false)).length, 1);
	await session.close(BACKGROUND_CONTEXT);
	await repo.close(BACKGROUND_CONTEXT);
	repo = new JsonlSessionRepo(options);
	session = await repo.open(metadata, BACKGROUND_CONTEXT);
	store = await FlowSubmissionStore.attach(session, owner);
	await assert.rejects(retainExternal(store, { ...submission(), id: "after-reopen" }, digest), { code: "capacity" });
	const [archived] = await store.forIds(["external-message"]);
	assert.equal(archived.externalDigest, digest);
	assert.equal(archived.submission.id, "external-message");
});

test("committed admission changes notify with journal revisions, not record revisions", async (t) => {
	const f = await fixture(t);
	const positions = [];
	const unsubscribe = f.store.subscribe((position) => positions.push(position));
	f.store.subscribe(() => {
		throw new Error("listener failure");
	});
	await retainExternal(f.store, submission(), digest);
	await f.store.recordAdmission("external-message", 1, { phase: "submission" }, "held");
	await f.store.recordAdmission("external-message", 1, { phase: "submission" });
	const latest = await f.store.journalVersion();
	unsubscribe();
	assert.ok(positions.length >= 3);
	assert.ok(positions.every((position, index) => !index || position.revision > positions[index - 1].revision));
	assert.deepEqual(positions.at(-1), latest);
	assert.equal((await f.store.forIds(["external-message"]))[0].revision, 1);
});
