import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deferred, tick } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { FlowOwnership } from "../dist/flow-control/ownership.js";
import { FlowSubmissionStore } from "../dist/flow-control/submission-store.js";
import { UserInputAdapters } from "../dist/flow-control/user-input-adapters.js";
import { afterCleanup } from "./fixtures/cleanup.mjs";
import { BACKGROUND_CONTEXT, MemorySessionRepo, setValue, value } from "./fixtures/flow-storage.mjs";

/**
 * What a receipt subscription publishes, and what it must not publish.
 *
 * A subscription reads the journal once and afterwards receives only records whose indexed evidence
 * changed. These tests pin the parts that are easy to lose while making that cheaper: the first read
 * still carries records archived before the subscriber existed, an unrelated write does not project the
 * archived journal again, an archived record that really did change is still published, a write that
 * lands during a pass is not dropped, and a reset starts a new journal generation without replaying the
 * previous one.
 */

/** Bounded wait for a state the host reaches asynchronously, with the expectation in the failure. */
async function until(predicate, message) {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(message);
}

/**
 * Real submission store and real adapter registry over one journal, without a host session.
 *
 * Retention is wired straight to the store, so a retained record keeps the state the adapter submitted
 * and a test can settle it into the archive without dispatching native input. `passes` counts receipt
 * publication passes, which is the deterministic way to observe that a subscription finished a read.
 */
async function harness(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-receipt-updates-"));
	const agentDir = await mkdtemp(join(tmpdir(), "jouzu-receipt-updates-config-"));
	const scope = { sessionId: "receipt-updates", branchId: "main" };
	const owner = FlowOwnership.acquire(root, scope);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, BACKGROUND_CONTEXT);
	const store = await FlowSubmissionStore.attach(session, owner);
	// Mint the target epoch before any subscription exists: creating it commits, and that commit must
	// not be mistaken for a journal write in the pass counts below.
	await store.externalTargetEpoch();
	const branch = { scope, attachment: { submissions: store } };
	const errors = [];
	let passes = 0;
	const adapters = new UserInputAdapters({
		agentDir,
		branch: () => branch,
		enabled: () => true,
		liveQueue: () => {
			passes++;
			return new Map();
		},
		pending: () => false,
		retain: (submission, digest, epoch) => store.retainExternal(submission, digest, epoch),
		onError: (error) => errors.push(error),
	});
	afterCleanup(t, async () => {
		adapters.close();
		await owner.close(() => session.close(BACKGROUND_CONTEXT));
		await repo.close(BACKGROUND_CONTEXT);
		await rm(root, { recursive: true, force: true });
		await rm(agentDir, { recursive: true, force: true });
	});
	const extensionPath = join(agentDir, "extension.ts");
	await writeFile(extensionPath, "export default () => {};\n");
	const extensionId = await realpath(extensionPath);
	const grant = (adapterId) => ({ extensionPath: extensionId, adapterId });
	const grants = [grant("first"), grant("second")];
	await writeFile(join(agentDir, "user-input-adapters.json"), JSON.stringify({ schemaVersion: 1, grants }));
	const host = {
		extensionId,
		scope: () => ({ sessionId: scope.sessionId, leafId: null, attachmentId: "attachment" }),
		prepare: () => async () => {},
	};
	const register = async (id) => {
		const adapter = await adapters.register(host, { id, label: id });
		return { adapter, binding: await adapter.bind() };
	};
	return { store, session, errors, register, passes: () => passes };
}

const submit = (adapter, binding, messageId) =>
	adapter.submit({ binding, messageId, text: "external instruction", deliverAs: "followUp" });

async function recordFor(store, messageId) {
	const records = await store.snapshot();
	return records.find((record) => record.submission.externalUser?.messageId === messageId);
}

/** Settle one retained record and archive it, as the ingress does once its input is settled. */
async function archive(store, messageId) {
	const retained = await recordFor(store, messageId);
	assert.ok(retained, `no retained record for ${messageId}`);
	await store.cancelExternal(retained.id, "unauthorized");
	const [cancelled] = await store.forIds([retained.id]);
	await store.archiveHandled([{ id: cancelled.id, revision: cancelled.revision }]);
	const [archived] = await store.forIds([retained.id]);
	assert.equal(archived.id, retained.id);
	const active = await store.snapshot(false);
	assert.equal(
		active.some((record) => record.id === retained.id),
		false,
		"the record is still active",
	);
	return archived;
}

const hashOf = (input) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const historyAddress = (generation, kind, key) =>
	value("jouzu.flow.submission-history", hashOf([generation, kind, key]));

/**
 * Rewrite one archived record and its history index entry in the journal itself.
 *
 * The store exposes no path that mutates archived content, so this stands in for a writer that rewrites
 * an archived record: it is the only way to prove the subscription compares indexed metadata instead of
 * assuming archived evidence never changes.
 */
async function rewriteArchived(session, generation, id) {
	await session.mutate(async (mutation, context) => {
		const headerAddress = value("jouzu.flow.submissions", "v1");
		const header = (await mutation.getValue(headerAddress, context)).value;
		const recordAddress = value("jouzu.flow.submission", id);
		const record = (await mutation.getValue(recordAddress, context)).value;
		const entry = (await mutation.getValue(historyAddress(generation, "id", id), context)).value;
		assert.ok(header && record && entry, "the archived record and its index entry must exist");
		const updated = { ...record, revision: record.revision + 1 };
		// A record cancelled without a durable cause reports the plain cancellation instead of the
		// reason the record used to carry, so the projection is observably different.
		delete updated.cancellationReason;
		const marker = { ...entry, revision: updated.revision };
		marker.bytes = Buffer.byteLength(JSON.stringify(updated));
		marker.contentHash = hashOf(updated);
		const writes = [
			setValue(headerAddress, { ...header, revision: header.revision + 1 }),
			setValue(recordAddress, updated),
			setValue(historyAddress(generation, "id", id), marker),
			setValue(historyAddress(generation, "position", entry.position), marker),
		];
		await mutation.commit(writes, context);
	});
}

const messageIds = (records) => records.map((record) => record.submission.externalUser.messageId);
const receiptIds = (records) => records.map((record) => record.id);
const published = (receipts) => receipts.map((receipt) => [receipt.messageId, receipt.state]);

test("lookup and resubscription recover a failed initial snapshot without a journal write", async (t) => {
	const h = await harness(t);
	const { adapter, binding } = await h.register("first");
	await submit(adapter, binding, "one");
	const before = (await h.store.snapshotVersioned()).journal;
	const snapshot = h.store.snapshotChanged.bind(h.store);
	let fail = true;
	t.mock.method(h.store, "snapshotChanged", async (...args) => {
		if (fail) throw new Error("snapshot unavailable");
		return snapshot(...args);
	});
	const seen = [];
	const stop = adapter.subscribe((receipt) => seen.push(receipt));
	t.after(stop);
	await until(() => h.errors.length === 1, "the snapshot failure was not reported");
	assert.equal(seen.length, 0);
	fail = false;
	assert.equal((await adapter.lookup({ target: binding.target, messageId: "one" })).state, "retained");
	stop();
	const replacement = adapter.subscribe((receipt) => seen.push(receipt));
	t.after(replacement);
	await until(() => seen.length === 1, "resubscription did not recover the initial snapshot");
	assert.equal(seen[0].messageId, "one");
	assert.deepEqual((await h.store.snapshotVersioned()).journal, before);
});

test("a changed snapshot reads the archived journal once and then only changed records", async (t) => {
	const h = await harness(t);
	const { adapter, binding } = await h.register("first");
	await submit(adapter, binding, "archived");
	const archived = await archive(h.store, "archived");
	await submit(adapter, binding, "live");
	const live = await recordFor(h.store, "live");

	let archivedReads = 0;
	const archivedAddress = JSON.stringify(value("jouzu.flow.submission", archived.id));
	const mutate = h.session.mutate.bind(h.session);
	t.mock.method(h.session, "mutate", (callback, ...args) =>
		mutate(
			(mutation, context) =>
				callback(
					new Proxy(mutation, {
						get(target, key) {
							if (key === "getValue")
								return (...readArgs) => {
									if (JSON.stringify(readArgs[0]) === archivedAddress) archivedReads++;
									return target.getValue(...readArgs);
								};
							const member = Reflect.get(target, key);
							return typeof member === "function" ? member.bind(target) : member;
						},
					}),
					context,
				),
			...args,
		),
	);
	// The first read is the whole journal, archived record included, in committed order.
	const first = await h.store.snapshotChanged();
	assert.equal(archivedReads, 1);
	assert.deepEqual(messageIds(first.records), ["archived", "live"]);
	assert.deepEqual(first.journal, await h.store.journalVersion());

	// Nothing committed since the cursor, so no record is read or reported.
	const idle = await h.store.snapshotChanged(first.cursor);
	assert.deepEqual(idle.records, []);
	assert.deepEqual(idle.journal, first.journal);

	// One record changed: only that record is reported. The archived record was not read again.
	const hold = { phase: "submission" };
	await h.store.recordAdmission(live.id, live.revision, hold, "Waiting for admission.");
	archivedReads = 0;
	const changed = await h.store.snapshotChanged(idle.cursor);
	assert.equal(archivedReads, 0, "an unrelated update read the archived payload");
	assert.deepEqual(receiptIds(changed.records), [live.id]);
	assert.equal(changed.records[0].holds?.length, 1);
	assert.deepEqual(changed.journal, await h.store.journalVersion());

	// The archived record is still reported when the marker the caller holds no longer matches its
	// index entry, which is the change a frozen-archive assumption would silently drop.
	const stale = { ...changed.cursor, revision: changed.cursor.revision - 1 };
	stale.records = new Map(changed.cursor.records);
	stale.records.set(archived.id, { revision: 1, contentHash: "b".repeat(64) });
	const again = await h.store.snapshotChanged(stale);
	assert.deepEqual(receiptIds(again.records), [archived.id]);
	assert.equal(archivedReads, 1);

	// An unsuccessful projection must be retried even at the exact same committed journal version.
	const retry = { ...changed.cursor, records: new Map(changed.cursor.records), retry: true };
	retry.records.delete(live.id);
	assert.deepEqual(receiptIds((await h.store.snapshotChanged(retry)).records), [live.id]);
});

test("a subscription publishes archived receipts once and ignores another adapter's writes", async (t) => {
	const h = await harness(t);
	const first = await h.register("first");
	const second = await h.register("second");
	await submit(first.adapter, first.binding, "archived");
	await archive(h.store, "archived");
	await submit(first.adapter, first.binding, "own");

	const seen = [];
	const throwing = [];
	const otherSeen = [];
	const stop = first.adapter.subscribe((receipt) => seen.push(receipt));
	// Force the legal ordering where this subscriber finishes before the others have even started.
	await until(() => seen.length === 2, "the first subscription did not finish its initial snapshot");
	const stopThrowing = first.adapter.subscribe(() => {
		throwing.push(1);
		throw new Error("receipt listener failed");
	});
	const stopOther = second.adapter.subscribe((receipt) => otherSeen.push(receipt));
	t.after(() => {
		stop();
		stopThrowing();
		stopOther();
	});

	// A new subscriber still receives the record archived before it existed, once, in journal order.
	await until(
		() => seen.length === 2 && throwing.length === 2 && h.passes() >= 3,
		"all three subscriptions must finish their initial snapshots",
	);
	assert.deepEqual(otherSeen, []);
	assert.deepEqual(published(seen), [
		["archived", "cancelled"],
		["own", "retained"],
	]);
	// The throwing listener is contained: it received both records and neither pass was interrupted.
	assert.equal(throwing.length, 2);
	assert.deepEqual(
		h.errors.map((error) => error.message),
		["receipt listener failed", "receipt listener failed"],
	);

	// A write that belongs to the other adapter advances the journal and changes nothing this
	// subscription owns, so no archived or retained receipt is projected again.
	const initialPasses = h.passes();
	await submit(second.adapter, second.binding, "other");
	await until(() => h.passes() >= initialPasses + 3, "the unrelated write never reached all three subscriptions");
	assert.ok(
		otherSeen.some((receipt) => receipt.messageId === "other"),
		"the other adapter saw no receipt",
	);
	assert.equal(seen.length, 2, "an unrelated write republished this adapter's receipts");
	assert.ok(seen.every((receipt) => receipt.adapterId === "first"));
	assert.equal(throwing.length, 2);
});

test("an update to an archived record is published with its newer journal revision", async (t) => {
	const h = await harness(t);
	const { adapter, binding } = await h.register("first");
	await submit(adapter, binding, "archived");
	const archived = await archive(h.store, "archived");
	await submit(adapter, binding, "live");
	const live = await recordFor(h.store, "live");

	const seen = [];
	const stop = adapter.subscribe((receipt) => seen.push(receipt));
	t.after(stop);
	await until(() => seen.length === 2, "the initial snapshot did not publish both records");
	const before = seen.find((receipt) => receipt.messageId === "archived");
	assert.equal(before.state, "cancelled");
	assert.equal(before.reason.code, "unauthorized");

	await rewriteArchived(h.session, before.generation, archived.id);
	// The rewrite is committed outside the store, so the next store write is what carries the
	// subscription to it. Only the two changed records are published: the live one, and the archived
	// record whose index entry no longer matches what the subscription already projected.
	const hold = { phase: "submission" };
	await h.store.recordAdmission(live.id, live.revision, hold, "Waiting for admission.");
	await until(() => seen.length === 4, "the archived record's update was never published");
	assert.deepEqual(published(seen.slice(2)), [
		["archived", "cancelled"],
		["live", "held"],
	]);
	const [updated] = seen.slice(2);
	assert.equal(updated.reason.code, "submission-cancelled");
	assert.ok(updated.revision > before.revision, "the update did not advance the journal revision");
	assert.equal(updated.generation, before.generation);
	const journal = { generation: updated.generation, revision: updated.revision };
	assert.deepEqual(await h.store.journalVersion(), journal);
});

test("a write committed while a pass is publishing is not lost", async (t) => {
	const h = await harness(t);
	const { adapter, binding } = await h.register("first");
	const seen = [];
	const stop = adapter.subscribe((receipt) => seen.push(receipt));
	t.after(stop);
	await until(() => h.passes() >= 1, "the initial pass did not run");
	assert.deepEqual(seen, []);

	const read = h.store.snapshotChanged.bind(h.store);
	const entered = deferred();
	const release = deferred();
	t.after(() => release.resolve());
	let parked = false;
	t.mock.method(h.store, "snapshotChanged", async (...args) => {
		const update = await read(...args);
		if (parked) {
			parked = false;
			entered.resolve();
			await release.promise;
		}
		return update;
	});

	// Park the pass that the first write starts, after it has read the journal, then commit a second
	// write. Its notification arrives while that pass is still publishing, so the update it coalesces
	// is only delivered if the subscription reads again afterwards.
	parked = true;
	const first = submit(adapter, binding, "first");
	await entered.promise;
	await submit(adapter, binding, "second");
	release.resolve();
	await first;
	await until(() => seen.some((receipt) => receipt.messageId === "second"), "the coalesced write was lost");
	assert.deepEqual(
		seen.map((receipt) => receipt.messageId),
		["first", "second"],
	);
});

test("reset between target capture and snapshot does not skip new-target receipts", async (t) => {
	const h = await harness(t);
	const { adapter, binding } = await h.register("first");
	const entered = deferred();
	const release = deferred();
	t.after(() => release.resolve());
	const read = h.store.snapshotChanged.bind(h.store);
	let first = true;
	t.mock.method(h.store, "snapshotChanged", async (...args) => {
		if (first) {
			first = false;
			entered.resolve();
			await release.promise;
		}
		return read(...args);
	});
	const seen = [];
	const stop = adapter.subscribe((receipt) => seen.push(receipt));
	t.after(stop);
	await entered.promise;
	await h.store.reset();
	const rebound = await adapter.bind();
	assert.notEqual(rebound.target, binding.target);
	await submit(adapter, rebound, "new-target");
	release.resolve();
	await until(() => seen.length === 1, "the old-target pass advanced past a new-target receipt");
	assert.equal(seen[0].messageId, "new-target");
	assert.equal(seen[0].target, rebound.target);
});

test("reset starts a new journal generation without replaying the previous one", async (t) => {
	const h = await harness(t);
	const { adapter, binding } = await h.register("first");
	await submit(adapter, binding, "before");
	const seen = [];
	const stop = adapter.subscribe((receipt) => seen.push(receipt));
	t.after(stop);
	await until(() => seen.length === 1, "the initial snapshot did not publish the retained record");
	const before = seen[0];

	await h.store.reset();
	await until(() => h.passes() >= 2, "the reset never reached the subscription");
	await tick();
	// The reset journal holds no records, so the previous lifetime's receipt is not published again.
	assert.deepEqual(seen, [before]);

	const rebound = await adapter.bind();
	assert.notEqual(rebound.target, binding.target);
	await submit(adapter, rebound, "after");
	await until(() => seen.length === 2, "the new generation's receipt was never published");
	const [publishedReceipt] = seen.slice(1);
	assert.equal(publishedReceipt.messageId, "after");
	assert.equal(publishedReceipt.target, rebound.target);
	assert.ok(publishedReceipt.generation > before.generation, "the receipt kept the old journal generation");
	const journal = { generation: publishedReceipt.generation, revision: publishedReceipt.revision };
	assert.deepEqual(await h.store.journalVersion(), journal);
});
