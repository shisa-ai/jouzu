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
	await first.finishNavigation(transition.id, "new-leaf", new Set());
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
	await assert.rejects(second.finishNavigation("foreign", "new", new Set()), { code: "stale" });
	const scope = await second.finishNavigation(a.value.id, "new", new Set());
	assert.notEqual(scope.branchId, initial.activeBranchId);
	const final = await second.snapshot();
	assert.equal(final.branches[1].fromBranchId, initial.activeBranchId);
	assert.deepEqual(await second.finishNavigation(a.value.id, "new", new Set()), scope);
	assert.deepEqual(await second.snapshot(), final);
	await assert.rejects(second.finishNavigation(a.value.id, "different", new Set()), { code: "stale" });
	await second.close();
	assert.deepEqual(await (await open()).currentScope(), scope);
});
test("a repeated completion is refused once another branch owns the session", async (t) => {
	const { open } = await fixture(t);
	const registry = await open();
	const initial = await navigate(registry, 1);
	const [completed] = initial.branches.slice(-1);
	// Move ownership back to the earlier branch without creating a record, so the completed branch is
	// no longer the active one.
	const state = await registry.snapshot();
	const transition = await registry.beginNavigation(state.revision, "back-leaf");
	await registry.reactivateNavigation(transition.id, initial.branches[0].id);
	// The retry matches the completed record, but reporting that record's identity as a fresh
	// completion would name a branch this transition never entered.
	await assert.rejects(
		registry.finishNavigation(completed.transitionId, completed.enteredAtLeafId, new Set(), completed.position),
		{ code: "stale" },
	);
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
		let stderr = "";
		child.stderr.setEncoding("utf8").on("data", (chunk) => {
			stderr += chunk;
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
				throw new Error(`Registry worker exited before saving state: ${stderr}`);
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

test("a full registry permits reactivation and reserves a bounded slot for a fork", async (t) => {
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
	const back = await registry.beginNavigation(state.revision, "leaf");
	await registry.reactivateNavigation(back.id, "branch-0");
	assert.equal((await registry.snapshot()).branches.length, 1024);
	const next = await registry.beginNavigation((await registry.snapshot()).revision, "first-leaf");
	const scope = await registry.finishNavigation(next.id, "fork-leaf", new Set());
	const after = await registry.snapshot();
	assert.equal(after.branches.length, 1024);
	assert.equal(after.activeBranchId, scope.branchId);
	assert.equal(after.branches.at(-1).fromBranchId, "branch-0");
	assert.equal(after.branches[0].id, "branch-0");
	assert.ok(!after.branches.some((branch) => branch.id === "branch-1"));
	assert.equal(await registry.retireBranchHistory(64, new Set(["branch-0"])), 960);
	assert.equal((await registry.snapshot()).branches.length, 64);
});

test("a fork reservation honors the branches the transcript still owns", async (t) => {
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
	// The oldest record owns the transcript tip, so the reservation must take the slot elsewhere.
	const next = await registry.beginNavigation(state.revision, "leaf");
	const scope = await registry.finishNavigation(next.id, "fork-leaf", new Set(["branch-0"]));
	const after = await registry.snapshot();
	assert.equal(after.branches.length, 1024);
	assert.equal(after.activeBranchId, scope.branchId);
	assert.ok(after.branches.some((record) => record.id === "branch-0"), "the protected owner survives");
	assert.ok(!after.branches.some((record) => record.id === "branch-1"), "the slot comes from the next record");
	assert.deepEqual(after.retired.through, ["branch-1"], "the dropped record is still cited by its retained child");
});

test("a fork that would exceed the byte budget retires records instead of failing", async (t) => {
	const { root, cleanup } = await fixture(t);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, BACKGROUND_CONTEXT);
	cleanup(() => repo.close(BACKGROUND_CONTEXT));
	const registry = await PiFlowSessionRegistry.open(root, "parent", null, async () => session);
	cleanup(() => registry.close());
	// Records are far smaller in a real session (~330 bytes, measured from live navigation), so the
	// record cap is reached long before the byte budget. Padding here reaches the budget under the
	// record cap, which is the case the reservation has to handle.
	const cap = 1024 * 1024;
	const state = await registry.snapshot();
	const size = (branches) => Buffer.byteLength(JSON.stringify({ ...state, branches }));
	const pad = "x".repeat(500);
	const branches = [];
	while (cap - size(branches) > 40000) {
		const i = branches.length;
		branches.push({
			id: `b${pad}${i}`.slice(0, 512),
			enteredAtLeafId: `l${pad}${i}`.slice(0, 512),
			...(i ? { fromBranchId: branches[i - 1].id, transitionId: `t${pad}${i}`.slice(0, 512) } : {}),
		});
	}
	while (cap - size(branches) > 1300) {
		const i = branches.length;
		branches.push({
			id: `b${i}`,
			enteredAtLeafId: `l${i}`,
			...(i ? { fromBranchId: branches[i - 1].id, transitionId: `t${i}` } : {}),
		});
	}
	// One appended record with tunable fields lands the state a known distance below the budget.
	const index = branches.length;
	const tunable = {
		id: `b${index}`,
		enteredAtLeafId: "e",
		fromBranchId: branches[index - 1].id,
		transitionId: `t${index}`,
		position: { entryId: "p", entryHash: "a".repeat(64) },
	};
	branches.push(tunable);
	for (let m = 1; cap - size(branches) > 400 && m <= 512; m++) tunable.position.entryId = "p".repeat(m);
	for (let k = 1; cap - size(branches) > 400 && k <= 512; k++) tunable.enteredAtLeafId = "e".repeat(k);
	state.branches = branches;
	state.activeBranchId = branches.at(-1).id;
	await session.mutate(
		(m) => m.commit([setValue(value("jouzu.flow.session", "v1"), state)], BACKGROUND_CONTEXT),
		BACKGROUND_CONTEXT,
	);

	const before = await registry.snapshot();
	const room = cap - Buffer.byteLength(JSON.stringify(before));
	assert.ok(room > 0 && room < 700, `the seeded state sits just under the budget (room ${room})`);
	// A long enteredAtLeafId makes the overshoot deterministic; real ids are short.
	const next = await registry.beginNavigation(before.revision, "leaf");
	const scope = await registry.finishNavigation(next.id, "f".repeat(512), new Set());
	const after = await registry.snapshot();
	assert.equal(after.activeBranchId, scope.branchId, "the fork completes");
	assert.ok(Buffer.byteLength(JSON.stringify(after)) <= cap, "the committed state fits the budget");
	// The fork adds a record and the reservation drops one, so the count can stay level.
	assert.ok(after.retired.count > (before.retired?.count ?? 0), "retirement made room for it");
	assert.ok(after.retired.count >= before.branches.length - after.branches.length);
});

/** Navigate `count` times so the registry holds a real ancestry chain. */
async function navigate(registry, count) {
	for (let step = 0; step < count; step++) {
		const state = await registry.snapshot();
		const transition = await registry.beginNavigation(state.revision, `leaf-${step}`);
		await registry.finishNavigation(transition.id, `leaf-${step + 1}`, new Set());
	}
	return registry.snapshot();
}

test("branch retirement keeps the active branch, its ancestry link, and the navigated fact", async (t) => {
	const { open } = await fixture(t);
	const registry = await open();
	const before = await navigate(registry, 5);
	assert.equal(before.branches.length, 6);
	assert.equal(before.retired, undefined);

	assert.equal(await registry.retireBranchHistory(2, new Set()), 4);
	const after = await registry.snapshot();
	assert.equal(after.branches.length, 2, "the newest records are kept");
	assert.equal(after.activeBranchId, before.activeBranchId, "the active branch is never retired");
	assert.deepEqual(after.branches, before.branches.slice(-2), "and the kept records are unchanged");
	assert.deepEqual(after.retired, { count: 4, through: [before.branches.at(-2).fromBranchId] });
	// The retained head still links to the newest retired record, so ancestry stays auditable.
	assert.equal(after.branches[0].fromBranchId, before.branches[3].id);

	// Retirement can leave one record behind, so record count alone no longer proves a first branch.
	assert.equal(await registry.retireBranchHistory(1, new Set()), 1);
	const collapsed = await registry.snapshot();
	assert.equal(collapsed.branches.length, 1);
	assert.deepEqual(collapsed.retired, { count: 5, through: [collapsed.branches[0].fromBranchId] });
	await assert.rejects(registry.bindInitialPosition(collapsed.revision, { entryId: "e", entryHash: "a".repeat(64) }), {
		code: "stale",
	});
});

test("retirement is a no-op below its keep size and is refused mid-navigation", async (t) => {
	const { open } = await fixture(t);
	const registry = await open();
	const initial = await navigate(registry, 2);
	assert.equal(await registry.retireBranchHistory(8, new Set()), 0, "nothing is retired below the keep size");
	assert.deepEqual(await registry.snapshot(), initial, "and the revision does not move");

	const state = await registry.snapshot();
	await registry.beginNavigation(state.revision, "old-leaf");
	await assert.rejects(registry.retireBranchHistory(1, new Set()), { code: "busy" });
	for (const size of [0, -1, 1.5]) await assert.rejects(registry.retireBranchHistory(size, new Set()), { code: "capacity" });
	// A caller that names nothing is refusing to decide which branches the transcript still needs.
	// Dropping a transcript owner leaves the session unbindable, so the omission is refused rather
	// than silently treated as an empty set.
	await assert.rejects(registry.retireBranchHistory(1), { code: "capacity" });
	await assert.rejects(registry.retireBranchHistory(1, []), { code: "capacity" });
});

test("a retired ancestry survives reopen and keeps its records valid", async (t) => {
	const { open } = await fixture(t);
	const first = await open();
	await navigate(first, 4);
	await first.retireBranchHistory(2, new Set());
	const before = await first.snapshot();
	await first.close();

	const second = await open("parent", "later-leaf");
	assert.deepEqual(await second.snapshot(), before, "the retired count and its link are durable");
	// A retired head is accepted on reload; the same record without one is not.
	const state = await second.snapshot();
	const transition = await second.beginNavigation(state.revision, "old-leaf");
	const scope = await second.finishNavigation(transition.id, "new-leaf", new Set());
	const grown = await second.snapshot();
	assert.equal(grown.branches.length, 3);
	assert.equal(grown.activeBranchId, scope.branchId);
	assert.deepEqual(grown.retired, before.retired, "navigation after retirement does not change the retired record");
});

test("reactivation restores an earlier retained branch and later forks from it", async (t) => {
	const { open } = await fixture(t);
	const registry = await open();
	const initial = await navigate(registry, 2);
	const original = initial.branches[0];
	const state = await registry.snapshot();
	const transition = await registry.beginNavigation(state.revision, "back-leaf");
	const scope = await registry.reactivateNavigation(transition.id, original.id);
	assert.deepEqual(scope, { sessionId: state.sessionId, branchId: original.id });
	const reactivated = await registry.snapshot();
	assert.equal(reactivated.activeBranchId, original.id);
	assert.equal(reactivated.branches.length, initial.branches.length, "reactivation creates no record");
	assert.equal(reactivated.transition, undefined);
	// A fork from the reactivated branch cites it as a tree parent, not the previous array record.
	const next = await registry.beginNavigation(reactivated.revision, "fork-leaf");
	const forked = await registry.finishNavigation(next.id, "forked-leaf", new Set());
	const tree = await registry.snapshot();
	assert.equal(tree.branches.at(-1).fromBranchId, original.id);
	assert.equal(tree.activeBranchId, forked.branchId);
	// Staying on the same branch is the no-op move: the transition resolves without a new record.
	const stay = await registry.beginNavigation(tree.revision, "same-branch");
	assert.deepEqual(await registry.reactivateNavigation(stay.id, forked.branchId), forked);
	const settled = await registry.snapshot();
	assert.equal(settled.branches.length, tree.branches.length);
	assert.equal(settled.activeBranchId, forked.branchId);
	await assert.rejects(registry.reactivateNavigation("foreign", original.id), { code: "stale" });
	const pending = await registry.beginNavigation(settled.revision, "target");
	await assert.rejects(registry.reactivateNavigation(pending.id, "unknown-branch"), { code: "stale" });
	await registry.reactivateNavigation(pending.id, original.id);
});

test("retirement skips an active root while dropping unrelated older records", async (t) => {
	const { open } = await fixture(t);
	const registry = await open();
	await navigate(registry, 3);
	const state = await registry.snapshot();
	const earliest = state.branches[0];
	const back = await registry.beginNavigation(state.revision, "back-leaf");
	await registry.reactivateNavigation(back.id, earliest.id);
	assert.equal(await registry.retireBranchHistory(2, new Set()), 2);
	const sparse = await registry.snapshot();
	assert.equal(sparse.branches[0].id, earliest.id);
	assert.equal(sparse.branches[1].id, state.branches[3].id);
	assert.deepEqual(sparse.retired, { count: 2, through: [state.branches[2].id] });
	const fork = await registry.beginNavigation((await registry.snapshot()).revision, "fork-leaf");
	await registry.finishNavigation(fork.id, "forked-leaf", new Set());
	assert.equal(await registry.retireBranchHistory(1, new Set()), 2);
	const after = await registry.snapshot();
	assert.equal(after.branches[0].id, fork.branchId);
	assert.deepEqual(after.retired, { count: 4, through: [earliest.id] });
	assert.equal(after.branches.length, 1);
});

test("retirement never drops a protected tip owner", async (t) => {
	const { open } = await fixture(t);
	const registry = await open();
	const grown = await navigate(registry, 1);
	const original = grown.branches[0];
	// The active branch sits at the end; protecting the first record bounds the prefix drop.
	assert.equal(await registry.retireBranchHistory(1, new Set([original.id])), 0);
	assert.equal((await registry.snapshot()).branches.length, 2);
	assert.equal(await registry.retireBranchHistory(1, new Set()), 1);
	const after = await registry.snapshot();
	assert.equal(after.branches.length, 1);
	assert.deepEqual(after.retired, { count: 1, through: [original.id] });
});

test("malformed retired ancestry cannot select a branch", async (t) => {
	const { root, cleanup } = await fixture(t);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, BACKGROUND_CONTEXT);
	cleanup(() => repo.close(BACKGROUND_CONTEXT));
	const registry = await PiFlowSessionRegistry.open(root, "parent", null, async () => session);
	cleanup(() => registry.close());
	const initial = await registry.snapshot();
	const initialId = initial.branches[0].id;
	for (const corrupt of [
		{
			// A self-parent that cites itself through the retired set.
			...initial,
			branches: [{ id: "solo", fromBranchId: "solo", transitionId: "t", enteredAtLeafId: null }],
			activeBranchId: "solo",
			retired: { count: 1, through: ["solo"] },
		},
		{
			// A forward parent: the cited record appears later in the array.
			...initial,
			branches: [
				{ id: "x", fromBranchId: "y", transitionId: "t1", enteredAtLeafId: null },
				{ id: "y", fromBranchId: "dropped", transitionId: "t2", enteredAtLeafId: null },
			],
			activeBranchId: "y",
			retired: { count: 1, through: ["dropped"] },
		},
		{
			// A retired entry no retained record cites.
			...initial,
			branches: [{ id: "kept", fromBranchId: "dropped", transitionId: "t", enteredAtLeafId: null }],
			activeBranchId: "kept",
			retired: { count: 2, through: ["dropped", "unused"] },
		},
		{
			// More cited parents than records ever dropped.
			...initial,
			branches: [{ id: "kept", fromBranchId: "dropped", transitionId: "t", enteredAtLeafId: null }],
			activeBranchId: "kept",
			retired: { count: 1, through: ["dropped", "dropped-2"] },
		},
	]) {
		await session.mutate(
			(m) => m.commit([setValue(value("jouzu.flow.session", "v1"), corrupt)], BACKGROUND_CONTEXT),
			BACKGROUND_CONTEXT,
		);
		await assert.rejects(registry.currentScope(), { code: "schema" });
	}
	// The same shape with every cited parent dropped exactly once still validates.
	await session.mutate(
		(m) =>
			m.commit(
				[
					setValue(value("jouzu.flow.session", "v1"), {
						...initial,
						branches: [{ id: "kept", fromBranchId: "dropped", transitionId: "t", enteredAtLeafId: null }],
						activeBranchId: "kept",
						retired: { count: 1, through: ["dropped"] },
					}),
				],
				BACKGROUND_CONTEXT,
			),
		BACKGROUND_CONTEXT,
	);
	assert.notEqual("kept", initialId);
});

test("a parented record requires an identity transition id", async (t) => {
	const { root, cleanup } = await fixture(t);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, BACKGROUND_CONTEXT);
	cleanup(() => repo.close(BACKGROUND_CONTEXT));
	const registry = await PiFlowSessionRegistry.open(root, "parent", null, async () => session);
	cleanup(() => registry.close());
	const initial = await registry.snapshot();
	for (const transitionId of [null, "", 0, {}, "x".repeat(513)]) {
		await session.mutate(
			(m) =>
				m.commit(
					[
						setValue(value("jouzu.flow.session", "v1"), {
							...initial,
							branches: [
								{ id: "first", enteredAtLeafId: null },
								{ id: "second", fromBranchId: "first", transitionId, enteredAtLeafId: null },
							],
							activeBranchId: "second",
						}),
					],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);
		await assert.rejects(registry.currentScope(), { code: "schema" });
	}
});

test("legacy single-parent retirement normalizes on read and validates as an array", async (t) => {
	const { root, cleanup } = await fixture(t);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, BACKGROUND_CONTEXT);
	cleanup(() => repo.close(BACKGROUND_CONTEXT));
	const registry = await PiFlowSessionRegistry.open(root, "parent", null, async () => session);
	cleanup(() => registry.close());
	const state = await registry.snapshot();
	const legacy = {
		...state,
		branches: [
			{
				id: "kept",
				fromBranchId: "dropped",
				transitionId: "move",
				enteredAtLeafId: null,
			},
		],
		activeBranchId: "kept",
		retired: { count: 1, through: "dropped" },
	};
	await session.mutate(
		(m) => m.commit([setValue(value("jouzu.flow.session", "v1"), legacy)], BACKGROUND_CONTEXT),
		BACKGROUND_CONTEXT,
	);
	const normalized = await registry.snapshot();
	assert.deepEqual(normalized.retired, { count: 1, through: ["dropped"] });
	assert.deepEqual(await registry.currentScope(), { sessionId: state.sessionId, branchId: "kept" });
	// A retained record citing a parent outside both retained ids and retired links is invalid.
	const broken = { ...normalized, branches: [{ ...normalized.branches[0], fromBranchId: "elsewhere" }] };
	await session.mutate(
		(m) => m.commit([setValue(value("jouzu.flow.session", "v1"), broken)], BACKGROUND_CONTEXT),
		BACKGROUND_CONTEXT,
	);
	await assert.rejects(registry.currentScope(), { code: "schema" });
});
