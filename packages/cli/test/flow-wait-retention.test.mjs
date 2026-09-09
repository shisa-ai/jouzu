import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, setValue, value } from "@earendil-works/pi-agent-core";
import { chooseFlowIntent, initialFlowAdmission } from "../dist/flow-control/admission.js";
import { openLocalFlowSession } from "../dist/flow-control/local-storage.js";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { MAX_RETIRED_FLOW_IDENTITIES, retiredIdentityHash } from "../dist/flow-control/retired-identities.js";

const scope = { sessionId: "session", branchId: "branch" };
const empty = () => ({ work: [], executions: [], waits: [] });
async function fixture(t, retiredCount = 0) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-wait-retention-"));
	let attachment = await PiFlowAttachment.open(root, scope, async (directory) => {
		const session = await openLocalFlowSession(directory);
		if (retiredCount)
			await session.mutate(
				async (writer, context) =>
					writer.commit(
						[
							setValue(value("jouzu.flow.waits", "v1"), {
								version: 1,
								scope,
								waits: [],
								retired: {
									work: Array.from({ length: retiredCount }, (_, i) => retiredIdentityHash(`retired-${i}`)),
									executions: [],
									waits: [],
								},
							}),
						],
						context,
					),
				BACKGROUND_CONTEXT,
			);
		return session;
	});
	t.after(async () => {
		await attachment.close();
		await rm(root, { recursive: true, force: true });
	});
	return {
		get store() {
			return attachment.waits;
		},
		async reopen() {
			await attachment.close();
			attachment = await PiFlowAttachment.open(root, scope);
		},
	};
}
async function completed(store, id = "work") {
	const work = await store.registerWork(id, "bg", 1);
	return store.changeWork(id, "bg", work.revision, "completed", "Finished", 2);
}
async function dependency(store, { id = "work", token = "wait", state = "pending" } = {}) {
	const work = await store.registerWork(id, "bg", 1);
	const execution = await store.registerExecution(
		{
			producer: "bg",
			handle: "display",
			execution: `exec-${id}`,
			workId: id,
			revision: 1,
			predicates: [{ until: "exit", state }],
		},
		work.revision,
		2,
	);
	const wait = await store.declareOwned(
		"bg",
		work.revision,
		{
			scope,
			workId: id,
			token,
			reason: "exit",
			mode: "all",
			on: [{ producer: "bg", handle: "display", execution: execution.execution, until: "exit" }],
			expiresAt: 100,
		},
		3,
		100,
		undefined,
		undefined,
		{ toolCallId: "tool", toolName: "agent_wait" },
	);
	return { work, execution, wait };
}

test("retiring completed work frees the 257th slot and fences replay after restart", async (t) => {
	const f = await fixture(t),
		work = [];
	for (let i = 0; i < 256; i++) work.push(await completed(f.store, `work-${i}`));
	await assert.rejects(f.store.registerWork("new", "bg", 3));
	assert.deepEqual(await f.store.retire({ ...empty(), work }), { work: 256, executions: 0, waits: 0 });
	assert.equal((await f.store.registerWork("new", "bg", 3)).id, "new");
	await f.reopen();
	await assert.rejects(f.store.registerWork("work-0", "bg", 4), { code: "stale" });
	assert.deepEqual(await f.store.retire({ ...empty(), work }), { work: 0, executions: 0, waits: 0 });
	assert.equal((await f.store.authoritySnapshot()).work.length, 1);
	assert.equal(f.store.gate().retiredWorkHashes.length, 256);
	const intent = {
		id: "again",
		revision: "2",
		producer: "bg",
		sequence: 0,
		rank: 4,
		workId: "work-0",
		workRevision: "2",
		runnable: true,
		independent: true,
	};
	assert.equal(
		chooseFlowIntent(initialFlowAdmission(), [intent], {
			hostReady: true,
			userPending: false,
			recoveryBlocked: false,
			...f.store.gate(),
		}),
		undefined,
	);
});

test("retirement atomically frees waits, execution evidence, tool receipts, and stopped work", async (t) => {
	const f = await fixture(t),
		d = await dependency(f.store, { state: "satisfied" });
	assert.equal((await f.store.toolReceipts()).length, 1);
	const work = await f.store.changeWork("work", "bg", d.work.revision, "stopped", "Stop", 4);
	await assert.rejects(f.store.retire({ ...empty(), work: [work] }), { code: "busy" });
	await assert.rejects(f.store.retire({ ...empty(), executions: [d.execution] }), { code: "busy" });
	assert.deepEqual(await f.store.retire({ work: [work], executions: [d.execution], waits: [d.wait] }), {
		work: 1,
		executions: 1,
		waits: 1,
	});
	await f.reopen();
	assert.deepEqual(await f.store.snapshot(), []);
	assert.deepEqual(await f.store.toolReceipts(), []);
	assert.deepEqual(await f.store.authoritySnapshot(), { version: 1, work: [], executions: [], waitTokens: [] });
	await assert.rejects(f.store.registerWork("work", "bg", 5), { code: "stale" });
	const other = await f.store.registerWork("other", "bg", 5);
	const input = { ...d.execution, workId: "other" };
	delete input.observedAt;
	await assert.rejects(f.store.registerExecution(input, other.revision, 6), { code: "stale" });
	await assert.rejects(f.store.synchronizeExecution(input, other.revision, 6), { code: "stale" });
	await assert.rejects(
		f.store.declare(
			{ ...d.wait, workId: "raw" },
			d.wait.observations.map((o) => ({ ...o, workId: "raw" })),
			6,
			100,
		),
		{ code: "stale" },
	);
});

test("live waits, active work, and pending execution evidence cannot be retired", async (t) => {
	const f = await fixture(t),
		d = await dependency(f.store);
	for (const request of [
		{ ...empty(), waits: [d.wait] },
		{ ...empty(), work: [d.work] },
		{ ...empty(), executions: [d.execution] },
	])
		await assert.rejects(f.store.retire(request), { code: "busy" });
	assert.deepEqual(await f.store.snapshot(), [d.wait]);
	assert.equal(f.store.gate().retiredWorkHashes, undefined);
	const cancelled = await f.store.cancelOwned("bg", d.work.revision, d.wait.token, "Cancel gate", 4);
	await f.store.retire({ ...empty(), waits: [cancelled] });
	await assert.rejects(f.store.retire({ ...empty(), executions: [d.execution] }), { code: "busy" });
	assert.equal((await f.store.authoritySnapshot()).executions.length, 1);
});

test("stale or duplicate retirement selections commit nothing", async (t) => {
	const f = await fixture(t),
		work = await completed(f.store);
	await assert.rejects(f.store.retire({ ...empty(), work: [{ ...work, revision: work.revision + 1 }] }), {
		code: "stale",
	});
	await assert.rejects(f.store.retire({ ...empty(), work: [work, work] }), { code: "identity" });
	assert.deepEqual((await f.store.authoritySnapshot()).work, [work]);
	assert.equal(f.store.gate().retiredWorkHashes, undefined);
});

test("wait and execution slots can be reused past both live-record limits", async (t) => {
	const f = await fixture(t);
	const work = await f.store.registerWork("work", "bg", 1);
	let retiredExecution;
	for (let batch = 0; batch < 9; batch++) {
		const executions = [],
			waits = [];
		for (let index = 0; index < 128; index++) {
			const sequence = batch * 128 + index;
			const execution = await f.store.registerExecution(
				{
					producer: "bg",
					handle: "display",
					execution: `exec-${sequence}`,
					workId: "work",
					revision: 1,
					predicates: [{ until: "exit", state: "satisfied" }],
				},
				work.revision,
				2,
			);
			executions.push(execution);
			waits.push(
				await f.store.declareOwned(
					"bg",
					work.revision,
					{
						scope,
						workId: "work",
						token: `wait-${sequence}`,
						reason: "exit",
						mode: "all",
						on: [{ producer: "bg", handle: "display", execution: execution.execution, until: "exit" }],
						expiresAt: 100,
					},
					3,
					100,
				),
			);
		}
		retiredExecution ??= executions[0];
		assert.equal((await f.store.authoritySnapshot()).waitTokens.length, 128);
		assert.deepEqual(await f.store.retire({ work: [], executions, waits }), { work: 0, executions: 128, waits: 128 });
	}
	await f.reopen();
	assert.equal((await f.store.authoritySnapshot()).executions.length, 0);
	assert.equal((await f.store.authoritySnapshot()).waitTokens.length, 0);
	await assert.rejects(f.store.synchronizeExecution(retiredExecution, work.revision, 4), { code: "stale" });
});

test("an execution change races retirement without losing the newer evidence", async (t) => {
	const f = await fixture(t),
		d = await dependency(f.store, { state: "satisfied" });
	await f.store.retire({ ...empty(), waits: [d.wait] });
	await f.store.observeExecution(
		{ producer: "bg", handle: "display", execution: d.execution.execution },
		2,
		[{ until: "exit", state: "satisfied" }],
		4,
	);
	await assert.rejects(f.store.retire({ ...empty(), executions: [d.execution] }), { code: "stale" });
	assert.equal((await f.store.authoritySnapshot()).executions[0].revision, 2);
});

test("replay-fence capacity holds retirement atomically while existing records remain usable", async (t) => {
	const f = await fixture(t, MAX_RETIRED_FLOW_IDENTITIES - 1);
	const first = await completed(f.store, "first"),
		second = await completed(f.store, "second");
	await assert.rejects(f.store.retire({ ...empty(), work: [first, second] }), { code: "capacity" });
	assert.equal((await f.store.authoritySnapshot()).work.length, 2);
	assert.equal(f.store.gate().retiredWorkHashes.length, MAX_RETIRED_FLOW_IDENTITIES - 1);
	await f.store.retire({ ...empty(), work: [first] });
	await f.reopen();
	await assert.rejects(f.store.retire({ ...empty(), work: [second] }), { code: "capacity" });
	assert.deepEqual((await f.store.authoritySnapshot()).work, [second]);
	await f.store.registerWork("usable", "bg", 3);
	await assert.rejects(f.store.registerWork("first", "bg", 3), { code: "stale" });
});
