import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, MemorySessionRepo, setValue, value } from "@earendil-works/pi-agent-core";
import { deferred, tick } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { PiFlowSessionRegistry } from "../dist/flow-control/pi-session-registry.js";

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-session-registry-"));
	const handles = [];
	t.after(async () => {
		for (const close of handles.reverse()) await close();
		await rm(root, { recursive: true, force: true });
	});
	return {
		root,
		cleanup: (action) => handles.push(action),
		open: async (sessionId = "parent", leaf = null) => {
			const h = await PiFlowSessionRegistry.open(root, sessionId, leaf);
			handles.push(() => h.close());
			return h;
		},
	};
}
test("registry retains stable branch IDs across transcript growth and reopen", async (t) => {
	const { open } = await fixture(t);
	const first = await open();
	const state = await first.snapshot();
	const scope = await first.currentScope();
	assert.equal(scope.branchId, state.activeBranchId);
	await first.close();
	const second = await open("parent", "later-leaf");
	assert.deepEqual(await second.snapshot(), state);
	assert.deepEqual(await second.currentScope(), scope);
	await assert.rejects(first.snapshot(), { code: "closed" });
	const detached = await second.snapshot();
	detached.branches[0].id = "mutated";
	assert.deepEqual(await second.snapshot(), state);
});
test("one session lease excludes competing registries across branch transitions", async (t) => {
	const { open } = await fixture(t);
	const first = await open();
	await assert.rejects(open(), { code: "busy" });
	const other = await open("another-session");
	assert.notEqual((await first.currentScope()).branchId, (await other.currentScope()).branchId);
	const state = await first.snapshot();
	const transition = await first.beginNavigation(state.revision, "old-leaf");
	await first.finishNavigation(transition.id, "new-leaf");
	await assert.rejects(open(), { code: "busy" });
});
test("navigation uses revision checks, holds incomplete transitions, and commits once", async (t) => {
	const { open } = await fixture(t);
	const first = await open();
	const initial = await first.snapshot();
	const [a, b] = await Promise.allSettled([
		first.beginNavigation(initial.revision, "old"),
		first.beginNavigation(initial.revision, "old"),
	]);
	assert.equal(a.status, "fulfilled");
	assert.equal(b.status, "rejected");
	assert.equal(b.reason.code, "stale");
	await assert.rejects(first.currentScope(), { code: "transition" });
	const pending = await first.snapshot();
	assert.equal(pending.activeBranchId, initial.activeBranchId);
	await first.close();
	const second = await open();
	assert.deepEqual(await second.snapshot(), pending);
	await assert.rejects(second.currentScope(), { code: "transition" });
	await assert.rejects(second.finishNavigation("foreign", "new"), { code: "stale" });
	const scope = await second.finishNavigation(a.value.id, "new");
	assert.notEqual(scope.branchId, initial.activeBranchId);
	const final = await second.snapshot();
	assert.equal(final.branches[1].fromBranchId, initial.activeBranchId);
	assert.deepEqual(await second.finishNavigation(a.value.id, "new"), scope);
	assert.deepEqual(await second.snapshot(), final);
	await assert.rejects(second.finishNavigation(a.value.id, "different"), { code: "stale" });
	await second.close();
	assert.deepEqual(await (await open()).currentScope(), scope);
});
test("session lease remains held until branch cleanup drains", async (t) => {
	const { open } = await fixture(t);
	const first = await open();
	const entered = deferred(),
		release = deferred();
	const closing = first.close(async () => {
		entered.resolve();
		await release.promise;
	});
	await entered.promise;
	await assert.rejects(open(), { code: "busy" });
	await assert.rejects(first.snapshot(), { code: "closed" });
	release.resolve();
	await closing;
	await open();
});
test("corrupt registry metadata is rejected without replacing branch identity", async (t) => {
	const { root, cleanup } = await fixture(t);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, BACKGROUND_CONTEXT);
	cleanup(() => repo.close(BACKGROUND_CONTEXT));
	await session.mutate(
		(m) => m.commit([setValue(value("jouzu.flow.session", "v1"), null)], BACKGROUND_CONTEXT),
		BACKGROUND_CONTEXT,
	);
	await assert.rejects(
		PiFlowSessionRegistry.open(root, "parent", null, async () => session),
		{ code: "schema" },
	);
});
for (const phase of ["begin", "finish"])
	test(`process death after ${phase} preserves committed navigation state`, async (t) => {
		const { root, open, cleanup } = await fixture(t);
		const child = fork(new URL("./fixtures/flow-session-registry.mjs", import.meta.url), [root, phase], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		const exited = once(child, "exit");
		cleanup(async () => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await exited;
			}
		});
		const [record] = await Promise.race([
			once(child, "message"),
			exited.then(() => {
				throw new Error("Registry worker exited before saving state.");
			}),
		]);
		assert.equal(record.kind, "saved");
		await assert.rejects(open(), { code: "busy" });
		child.kill("SIGKILL");
		await exited;
		const registry = await open();
		assert.deepEqual(await registry.snapshot(), record.state);
		if (phase === "begin") await assert.rejects(registry.currentScope(), { code: "transition" });
		else assert.equal((await registry.currentScope()).branchId, record.state.activeBranchId);
		await tick();
	});

test("corrupt ancestry and pending transitions cannot select a branch", async (t) => {
	const { root, cleanup } = await fixture(t);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, BACKGROUND_CONTEXT);
	cleanup(() => repo.close(BACKGROUND_CONTEXT));
	const registry = await PiFlowSessionRegistry.open(root, "parent", null, async () => session);
	cleanup(() => registry.close());
	const original = await registry.snapshot();
	for (const corrupt of [
		{ ...original, version: 2 },
		{ ...original, activeBranchId: "unknown" },
		{ ...original, transition: null },
		{ ...original, transition: { id: "move", fromBranchId: "foreign", branchId: "new", previousLeafId: null } },
		{
			...original,
			branches: [
				...original.branches,
				{
					id: original.activeBranchId,
					fromBranchId: original.activeBranchId,
					transitionId: "move",
					enteredAtLeafId: null,
				},
			],
		},
	]) {
		await session.mutate(
			(m) => m.commit([setValue(value("jouzu.flow.session", "v1"), corrupt)], BACKGROUND_CONTEXT),
			BACKGROUND_CONTEXT,
		);
		await assert.rejects(registry.currentScope(), { code: "schema" });
	}
});

test("branch capacity failure preserves the current scope without creating a transition", async (t) => {
	const { root, cleanup } = await fixture(t);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, BACKGROUND_CONTEXT);
	cleanup(() => repo.close(BACKGROUND_CONTEXT));
	const registry = await PiFlowSessionRegistry.open(root, "parent", null, async () => session);
	cleanup(() => registry.close());
	const state = await registry.snapshot();
	state.branches = Array.from({ length: 1024 }, (_, i) => ({
		id: `branch-${i}`,
		enteredAtLeafId: null,
		...(i ? { fromBranchId: `branch-${i - 1}`, transitionId: `move-${i}` } : {}),
	}));
	state.activeBranchId = state.branches.at(-1).id;
	await session.mutate(
		(m) => m.commit([setValue(value("jouzu.flow.session", "v1"), state)], BACKGROUND_CONTEXT),
		BACKGROUND_CONTEXT,
	);
	await assert.rejects(registry.beginNavigation(state.revision, "leaf"), { code: "capacity" });
	assert.deepEqual(await registry.snapshot(), state);
	assert.equal((await registry.currentScope()).branchId, state.activeBranchId);
});

/** Navigate `count` times so the registry holds a real ancestry chain. */
async function navigate(registry, count) {
	for (let step = 0; step < count; step++) {
		const state = await registry.snapshot();
		const transition = await registry.beginNavigation(state.revision, `leaf-${step}`);
		await registry.finishNavigation(transition.id, `leaf-${step + 1}`);
	}
	return registry.snapshot();
}

test("branch retirement keeps the active branch, its ancestry link, and the navigated fact", async (t) => {
	const { open } = await fixture(t);
	const registry = await open();
	const before = await navigate(registry, 5);
	assert.equal(before.branches.length, 6);
	assert.equal(before.retired, undefined);

	assert.equal(await registry.retireBranchHistory(2), 4);
	const after = await registry.snapshot();
	assert.equal(after.branches.length, 2, "the newest records are kept");
	assert.equal(after.activeBranchId, before.activeBranchId, "the active branch is never retired");
	assert.deepEqual(after.branches, before.branches.slice(-2), "and the kept records are unchanged");
	assert.deepEqual(after.retired, { count: 4, through: before.branches.at(-2).fromBranchId });
	// The retained head still links to the newest retired record, so ancestry stays auditable.
	assert.equal(after.branches[0].fromBranchId, before.branches[3].id);

	// Retirement can leave one record behind, so record count alone no longer proves a first branch.
	assert.equal(await registry.retireBranchHistory(1), 1);
	const collapsed = await registry.snapshot();
	assert.equal(collapsed.branches.length, 1);
	assert.deepEqual(collapsed.retired, { count: 5, through: collapsed.branches[0].fromBranchId });
	await assert.rejects(registry.bindInitialPosition(collapsed.revision, { entryId: "e", entryHash: "a".repeat(64) }), {
		code: "stale",
	});
});

test("retirement is a no-op below its keep size and is refused mid-navigation", async (t) => {
	const { open } = await fixture(t);
	const registry = await open();
	const initial = await navigate(registry, 2);
	assert.equal(await registry.retireBranchHistory(8), 0, "nothing is retired below the keep size");
	assert.deepEqual(await registry.snapshot(), initial, "and the revision does not move");

	const state = await registry.snapshot();
	await registry.beginNavigation(state.revision, "old-leaf");
	await assert.rejects(registry.retireBranchHistory(1), { code: "busy" });
	for (const size of [0, -1, 1.5]) await assert.rejects(registry.retireBranchHistory(size), { code: "capacity" });
});

test("a retired ancestry survives reopen and keeps its records valid", async (t) => {
	const { open } = await fixture(t);
	const first = await open();
	await navigate(first, 4);
	await first.retireBranchHistory(2);
	const before = await first.snapshot();
	await first.close();

	const second = await open("parent", "later-leaf");
	assert.deepEqual(await second.snapshot(), before, "the retired count and its link are durable");
	// A retired head is accepted on reload; the same record without one is not.
	const state = await second.snapshot();
	const transition = await second.beginNavigation(state.revision, "old-leaf");
	const scope = await second.finishNavigation(transition.id, "new-leaf");
	const grown = await second.snapshot();
	assert.equal(grown.branches.length, 3);
	assert.equal(grown.activeBranchId, scope.branchId);
	assert.deepEqual(grown.retired, before.retired, "navigation after retirement does not change the retired record");
});
