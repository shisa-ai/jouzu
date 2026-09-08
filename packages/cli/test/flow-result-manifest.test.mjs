import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context, MemorySessionRepo, setValue, value } from "@earendil-works/pi-agent-core";
import { FlowOwnership } from "../dist/flow-control/ownership.js";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { FlowResultManifestStore } from "../dist/flow-control/result-manifest.js";

const scope = { sessionId: "parent", branchId: "main" };
const member = (id = "result", status = "success") => ({
	id,
	producer: "worker",
	execution: `exec-${id}`,
	revision: "1",
	status,
	title: `結果 ${id}`,
	reference: `worker-result:${id}`,
	warnings: ["Review required; completion is not approval."],
});
async function rootFor(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-results-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}
async function memory(t, limits) {
	const ownership = FlowOwnership.acquire(await rootFor(t), scope);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, context);
	t.after(async () => {
		await ownership.close(() => session.close(context));
		await repo.close(context);
	});
	return { session, ownership, store: await FlowResultManifestStore.attach(session, ownership, limits) };
}
const pageOptions = { limit: 20, maxBytes: 20000 };

test("manifest retention freezes membership, is order-independent, and pages exactly after Pi reopen", async (t) => {
	const root = await rootFor(t);
	let attachment = await PiFlowAttachment.open(root, scope);
	t.after(() => attachment.close());
	const members = [member("a", "failure"), member("b"), member("c", "cancelled")];
	const saving = attachment.results.retain(members);
	members[0].title = "mutated";
	members[0].warnings.length = 0;
	const reference = await saving;
	assert.equal(
		await attachment.results.retain([member("c", "cancelled"), member("b"), member("a", "failure")]),
		reference,
	);
	const before = await attachment.ledger.snapshot();
	const first = await attachment.results.page(reference, { ...pageOptions, limit: 1 });
	assert.deepEqual(first.counts, { success: 1, failure: 1, cancelled: 1 });
	assert.equal(first.members[0].title, "結果 a");
	assert.equal(first.members[0].warnings.length, 1);
	assert.equal(first.remaining, 2);
	assert.deepEqual(await attachment.ledger.snapshot(), before);
	await attachment.close();
	attachment = await PiFlowAttachment.open(root, scope);
	const rest = await attachment.results.page(reference, { ...pageOptions, cursor: first.next });
	assert.deepEqual(
		rest.members.map((item) => item.id),
		["b", "c"],
	);
	assert.equal(rest.next, undefined);
	assert.equal(rest.remaining, 0);
});

test("terminal execution/revision cannot change status, reference, or warnings across manifests", async (t) => {
	const { store } = await memory(t);
	await store.retain([member()]);
	for (const update of [{ status: "failure" }, { reference: "changed" }, { warnings: [] }])
		await assert.rejects(store.retain([{ ...member(), ...update }, member("other")]), { code: "identity" });
	await store.retain([{ ...member(), execution: "new-execution", status: "failure" }]);
	await store.retain([{ ...member(), revision: "2", status: "failure" }]);
});

test("pages bound all serialized UTF-8 metadata and reject impossible sizing without truncating warnings", async (t) => {
	const { store } = await memory(t);
	const reference = await store.retain([member("a"), member("b"), member("c")]);
	const one = await store.page(reference, { ...pageOptions, limit: 1 });
	const limit = Buffer.byteLength(JSON.stringify(one));
	const bounded = await store.page(reference, { limit: 20, maxBytes: limit });
	assert.equal(bounded.members.length, 1);
	assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= limit);
	await assert.rejects(store.page(reference, { limit: 20, maxBytes: 10 }), { code: "capacity" });
	assert.deepEqual(bounded.members[0].warnings, member().warnings);
});

test("cursors cannot cross manifests or branches and stale attachments cannot read", async (t) => {
	const root = await rootFor(t);
	const first = await PiFlowAttachment.open(root, scope);
	t.after(() => first.close());
	const reference = await first.results.retain([member("a"), member("b")]);
	const cursor = (await first.results.page(reference, { ...pageOptions, limit: 1 })).next;
	const another = await first.results.retain([member("c")]);
	await assert.rejects(first.results.page(another, { ...pageOptions, cursor }), { code: "identity" });
	await first.close();
	await assert.rejects(first.results.page(reference, pageOptions), { code: "closed" });
	const branch = await PiFlowAttachment.open(root, { ...scope, branchId: "another" });
	t.after(() => branch.close());
	await assert.rejects(branch.results.page(reference, pageOptions), { code: "identity" });
});

test("manifest count overflow leaves previous membership retrievable", async (t) => {
	const { store } = await memory(t, { maxManifests: 1, maxMembers: 20, maxBytes: 20000 });
	const reference = await store.retain([member("a")]);
	await assert.rejects(store.retain([member("b")]), { code: "capacity" });
	assert.equal((await store.page(reference, pageOptions)).members[0].id, "a");
});

test("concurrent duplicates share one immutable manifest and changed stored content is refused", async (t) => {
	const { store, session } = await memory(t);
	const references = await Promise.all(Array.from({ length: 10 }, () => store.retain([member()])));
	assert.equal(new Set(references).size, 1);
	const id = references[0].slice(13);
	await session.mutate(
		(mutation, ctx) =>
			mutation.commit(
				[setValue(value("jouzu.flow.result-manifest", id), { version: 1, scope, members: [member("changed")] })],
				ctx,
			),
		context,
	);
	await assert.rejects(store.page(references[0], pageOptions), { code: "identity" });
});

test("invalid and duplicate member identities fail before retention", async (t) => {
	const { store } = await memory(t);
	assert.throws(() => store.retain([member(), member()]), { code: "identity" });
	for (const update of [{ status: "running" }, { execution: "" }, { warnings: [42] }, { reference: "" }])
		assert.throws(() => store.retain([{ ...member(), ...update }]), { code: "schema" });
});

test("maximum retained membership paginates with exact totals and no repeated or missing identities", async (t) => {
	const { store } = await memory(t);
	const members = Array.from({ length: 1024 }, (_, i) =>
		member(String(i).padStart(4, "0"), i % 2 ? "success" : "failure"),
	);
	const reference = await store.retain(members);
	const found = [];
	let cursor;
	do {
		const page = await store.page(reference, { cursor, limit: 37, maxBytes: 16000 });
		assert.equal(page.total, 1024);
		assert.deepEqual(page.counts, { success: 512, failure: 512, cancelled: 0 });
		assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 16000);
		found.push(...page.members.map((item) => item.id));
		cursor = page.next;
	} while (cursor);
	assert.deepEqual(
		found,
		members.map((item) => item.id),
	);
});

test("byte overflow preserves prior manifests and missing indexed content is an explicit failure", async (t) => {
	const { store, session } = await memory(t, { maxManifests: 20, maxMembers: 20, maxBytes: 1500 });
	const reference = await store.retain([member("a")]);
	await assert.rejects(store.retain([{ ...member("b"), title: "結果".repeat(600) }]), { code: "capacity" });
	assert.equal((await store.page(reference, pageOptions)).total, 1);
	await session.mutate(
		(mutation, ctx) =>
			mutation.commit(
				[
					setValue(value("jouzu.flow.result-manifests", "v1"), {
						version: 1,
						scope,
						manifests: [{ id: "a".repeat(64), bytes: 100 }],
					}),
				],
				ctx,
			),
		context,
	);
	await assert.rejects(store.page(`flow-results:${"a".repeat(64)}`, pageOptions), { code: "identity" });
});
