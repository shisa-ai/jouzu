import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDeferredJournal } from "../dist/flow-control/journal-storage.js";
import { materializeLocalFlowSession, openLocalFlowSession } from "../dist/flow-control/local-storage.js";
import { FlowOwnership } from "../dist/flow-control/ownership.js";
import { BACKGROUND_CONTEXT, deleteValue, setValue, value } from "../dist/flow-control/scalar-storage.js";

async function base(t) {
	const root = await mkdtemp(join(tmpdir(), "flow-deferred-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

const commit = (session, writes) =>
	session.mutate((mutation) => mutation.commit(writes, BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
const read = async (session, key) => (await session.getValue(value("probe", key), BACKGROUND_CONTEXT))?.value;

test("a deferred journal writes nothing until it is materialized, then keeps every record", async (t) => {
	const root = await base(t);
	const directory = join(root, "flow", "branch");
	const journal = createDeferredJournal();
	await commit(journal.session, [setValue(value("probe", "kept"), "日本語")]);
	await commit(journal.session, [setValue(value("probe", "dropped"), 1)]);
	await commit(journal.session, [deleteValue(value("probe", "dropped"))]);
	assert.equal(existsSync(join(root, "flow")), false, "nothing exists before materialize");

	await materializeLocalFlowSession(journal, directory);
	await materializeLocalFlowSession(journal, directory);
	assert.equal(journal.materialized, true);
	await commit(journal.session, [setValue(value("probe", "after"), true)]);
	await journal.session.close(BACKGROUND_CONTEXT);
	assert.deepEqual(await readdir(join(directory, "sessions", "flow")).then((names) => names.length), 1);
	assert.deepEqual(await readdir(directory), ["sessions"], "no temporary file is left behind");

	const reopened = await openLocalFlowSession(directory);
	try {
		assert.equal(await read(reopened, "kept"), "日本語");
		assert.equal(await read(reopened, "dropped"), undefined);
		assert.equal(await read(reopened, "after"), true);
		// The sequence floor survives the deleted value, so no sequence number is reused.
		const stored = await reopened.getValue(value("probe", "after"), BACKGROUND_CONTEXT);
		await commit(reopened, [setValue(value("probe", "next"), 1)]);
		assert.ok((await reopened.getValue(value("probe", "next"), BACKGROUND_CONTEXT)).seq > stored.seq);
	} finally {
		await reopened.close(BACKGROUND_CONTEXT);
	}
});

test("the first write after the hook is set creates the journal before it is recorded", async (t) => {
	const root = await base(t);
	const directory = join(root, "branch");
	const journal = createDeferredJournal();
	await commit(journal.session, [setValue(value("probe", "opening"), 1)]);
	let calls = 0;
	journal.beforeFirstWrite(async () => {
		calls++;
		await materializeLocalFlowSession(journal, directory);
	});
	await Promise.all([
		commit(journal.session, [setValue(value("probe", "first"), 1)]),
		commit(journal.session, [setValue(value("probe", "second"), 2)]),
	]);
	await commit(journal.session, [setValue(value("probe", "third"), 3)]);
	await journal.session.close(BACKGROUND_CONTEXT);
	assert.equal(calls, 1, "a materialized journal skips the hook");
	const reopened = await openLocalFlowSession(directory);
	try {
		for (const [key, expected] of [
			["opening", 1],
			["first", 1],
			["second", 2],
			["third", 3],
		])
			assert.equal(await read(reopened, key), expected);
	} finally {
		await reopened.close(BACKGROUND_CONTEXT);
	}
});

test("reserved ownership creates nothing until it is claimed, and a claim is exclusive", async (t) => {
	const root = join(await base(t), "flow");
	const scope = { sessionId: "session", branchId: "branch" };
	const reserved = FlowOwnership.reserve(root, scope);
	assert.equal(reserved.claimedStorage, false);
	assert.throws(() => reserved.directory, { code: "lifecycle" });
	assert.equal(existsSync(root), false);
	assert.equal(FlowOwnership.exists(root, scope), false);
	await reserved.run(async () => {});
	await reserved.close();
	assert.equal(existsSync(root), false, "closing unclaimed ownership leaves nothing behind");

	const first = FlowOwnership.reserve(root, scope);
	first.claim();
	assert.equal(FlowOwnership.exists(root, scope), true);
	assert.ok(existsSync(join(first.directory, "owner.sqlite")));
	const second = FlowOwnership.reserve(root, scope);
	assert.throws(() => second.claim(), { code: "busy" });
	await second.close();
	await first.close();
});
