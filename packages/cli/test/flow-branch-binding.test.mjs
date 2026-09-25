import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import {
	bindPiFlowBranch,
	completePiFlowNavigation,
	piTranscriptBranchOwners,
} from "../dist/flow-control/pi-branch-binding.js";
import { PiFlowSessionRegistry } from "../dist/flow-control/pi-session-registry.js";
import { legacyPathDigest, pathDigest } from "../dist/path-digest.js";

async function fixture(t, { memory = false } = {}) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-branch-binding-"));
	const registries = [];
	t.after(async () => {
		for (const registry of registries.reverse()) await registry.close();
		await rm(root, { recursive: true, force: true });
	});
	const manager = memory ? SessionManager.inMemory(root) : SessionManager.create(root, join(root, "history"));
	const open = async (host = manager) => {
		const registry = await PiFlowSessionRegistry.open(root, host.getSessionId(), host.getLeafId());
		registries.push(registry);
		return registry;
	};
	return { root, manager, open, registry: await open() };
}
test("initial binding persists metadata before any assistant turn and survives reopen", async (t) => {
	const { manager, registry, open } = await fixture(t);
	const scope = await bindPiFlowBranch(registry, manager);
	assert.deepEqual(manager.buildSessionContext().messages, []);
	const before = await readFile(manager.getSessionFile(), "utf8");
	manager.flush();
	assert.equal(await readFile(manager.getSessionFile(), "utf8"), before);
	await registry.close();
	const reopened = SessionManager.open(manager.getSessionFile());
	const next = await open(reopened);
	assert.deepEqual(await bindPiFlowBranch(next, reopened), scope);
	reopened.appendMessage({ role: "user", content: "later", timestamp: 1 });
	assert.deepEqual(await bindPiFlowBranch(next, reopened), scope);
	assert.equal((await readFile(manager.getSessionFile(), "utf8")).split("\n").filter(Boolean).length, 3);
});
test("unsummarized branch navigation is durably bound before a new model turn", async (t) => {
	const { manager, registry, open } = await fixture(t);
	const original = await bindPiFlowBranch(registry, manager);
	const transition = await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
	manager.resetLeaf();
	const next = await completePiFlowNavigation(registry, manager, transition.id);
	assert.notEqual(next.branchId, original.branchId);
	assert.deepEqual(manager.buildSessionContext().messages, []);
	const leaf = manager.getLeafId();
	await registry.close();
	const reopened = SessionManager.open(manager.getSessionFile());
	assert.equal(reopened.getLeafId(), leaf);
	assert.deepEqual(await bindPiFlowBranch(await open(reopened), reopened), next);
});
test("restart reconciles a durable marker written before registry completion", async (t) => {
	const { manager, registry, open } = await fixture(t);
	await bindPiFlowBranch(registry, manager);
	const transition = await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
	manager.resetLeaf();
	const marker = manager.appendCustomEntry("jouzu-flow-branch", {
		version: 1,
		sessionId: manager.getSessionId(),
		branchId: transition.branchId,
		transitionId: transition.id,
	});
	manager.flush();
	await registry.close();
	const reopened = SessionManager.open(manager.getSessionFile());
	const next = await open(reopened);
	assert.equal((await next.snapshot()).transition.id, transition.id);
	assert.equal((await bindPiFlowBranch(next, reopened)).branchId, transition.branchId);
	assert.equal((await next.snapshot()).branches.at(-1).position.entryId, marker);
	const bytes = await readFile(manager.getSessionFile(), "utf8");
	await bindPiFlowBranch(next, reopened);
	assert.equal(await readFile(manager.getSessionFile(), "utf8"), bytes);
});
test("pending navigation without a marker recovers to the leaf's branch and writes no transcript", async (t) => {
	const { manager, registry } = await fixture(t);
	const scope = await bindPiFlowBranch(registry, manager);
	await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
	const bytes = await readFile(manager.getSessionFile(), "utf8");
	// The fork never recorded a marker, so reconciliation discards the transition and rebinds.
	assert.deepEqual(await bindPiFlowBranch(registry, manager), scope);
	assert.equal((await registry.snapshot()).transition, undefined);
	assert.equal(await readFile(manager.getSessionFile(), "utf8"), bytes);
	assert.equal((await registry.currentScope()).branchId, scope.branchId);
});
test("an unregistered transcript branch cannot reuse active flow ownership", async (t) => {
	const { manager, registry } = await fixture(t);
	await bindPiFlowBranch(registry, manager);
	manager.resetLeaf();
	await assert.rejects(bindPiFlowBranch(registry, manager), { code: "identity" });
});
test("copied foreign-session markers do not import another session's branch identity", async (t) => {
	const { root, manager, registry, open } = await fixture(t);
	const original = await bindPiFlowBranch(registry, manager);
	const foreign = manager.getLeafEntry();
	const fork = SessionManager.create(root, join(root, "fork"));
	fork.appendCustomEntry(foreign.customType, foreign.data);
	const other = await open(fork);
	const scope = await bindPiFlowBranch(other, fork);
	assert.notEqual(scope.sessionId, original.sessionId);
	assert.notEqual(scope.branchId, original.branchId);
	assert.deepEqual(fork.buildSessionContext().messages, []);
});
test("a malformed foreign-session marker does not break this session's binding", async (t) => {
	const { root, manager, registry, open } = await fixture(t);
	const original = await bindPiFlowBranch(registry, manager);
	const fork = SessionManager.create(root, join(root, "fork"));
	// A copied marker from another session is not this session's to validate, so its damaged shape
	// must not make every binding on this transcript throw.
	fork.appendCustomEntry("jouzu-flow-branch", { version: 1, sessionId: 7, branchId: null, transitionId: 0 });
	const other = await open(fork);
	const scope = await bindPiFlowBranch(other, fork);
	assert.notEqual(scope.sessionId, original.sessionId);
	assert.notEqual(scope.branchId, original.branchId);
});
test("changed persisted marker bytes cannot replace a registry's position binding", async (t) => {
	const { manager, registry, open } = await fixture(t);
	await bindPiFlowBranch(registry, manager);
	await registry.close();
	const path = manager.getSessionFile();
	const entries = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
	entries.at(-1).timestamp = "changed";
	await writeFile(path, `${entries.map(JSON.stringify).join("\n")}\n`);
	const reopened = SessionManager.open(path);
	await assert.rejects(bindPiFlowBranch(await open(reopened), reopened), { code: "identity" });
});
test("flush refuses to overwrite a conflicting session file", async (t) => {
	const { manager } = await fixture(t);
	manager.appendCustomEntry("fixture", {});
	await writeFile(manager.getSessionFile(), "existing data\n");
	assert.throws(() => manager.flush(), { code: "EEXIST" });
	assert.equal(await readFile(manager.getSessionFile(), "utf8"), "existing data\n");
});

test("a registry revision change during transcript verification rejects stale binding", async (t) => {
	const { manager, registry } = await fixture(t);
	await bindPiFlowBranch(registry, manager);
	const original = await registry.snapshot();
	const snapshot = registry.snapshot.bind(registry);
	let calls = 0;
	t.mock.method(registry, "snapshot", async () => {
		if (++calls === 2) await registry.beginNavigation(original.revision, manager.getLeafId());
		return snapshot();
	});
	await assert.rejects(bindPiFlowBranch(registry, manager), { code: "stale" });
	assert.ok((await snapshot()).transition);
});

test("process death after durable branch marker allows exact registry reconciliation", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-binding-kill-"));
	let registry;
	const child = fork(new URL("./fixtures/flow-branch-binding.mjs", import.meta.url), [root], {
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	const exited = once(child, "exit");
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await exited;
		}
		await registry?.close();
		await rm(root, { recursive: true, force: true });
	});
	const [saved] = await Promise.race([
		once(child, "message"),
		exited.then(() => {
			throw new Error("Branch fixture exited before persistence.");
		}),
	]);
	child.kill("SIGKILL");
	await exited;
	const manager = SessionManager.open(saved.path);
	registry = await PiFlowSessionRegistry.open(root, manager.getSessionId(), manager.getLeafId());
	assert.ok((await registry.snapshot()).transition);
	assert.equal((await bindPiFlowBranch(registry, manager)).branchId, saved.branchId);
	assert.equal((await registry.snapshot()).transition, undefined);
	assert.deepEqual(manager.buildSessionContext().messages, []);
});

test("closing the registry holds session ownership through in-flight transcript binding", async (t) => {
	const { manager, registry, open } = await fixture(t);
	await bindPiFlowBranch(registry, manager);
	const entered = deferred(),
		release = deferred();
	const snapshot = registry.snapshot.bind(registry);
	t.mock.method(registry, "snapshot", async () => {
		const state = await snapshot();
		entered.resolve();
		await release.promise;
		return state;
	});
	const binding = assert.rejects(bindPiFlowBranch(registry, manager), { code: "closed" });
	await entered.promise;
	const closing = registry.close();
	await assert.rejects(open(), { code: "busy" });
	release.resolve();
	await Promise.all([binding, closing]);
	await open();
});

test("memory branch binding retains exclusive ownership and its live manager across reattachment", async (t) => {
	const { manager, registry, open } = await fixture(t, { memory: true });
	const scope = await bindPiFlowBranch(registry, manager);
	assert.equal(manager.getSessionFile(), undefined);
	assert.deepEqual(manager.buildSessionContext().messages, []);
	const position = (await registry.snapshot()).branches[0].position;
	assert.ok(position.memoryInstanceId);
	await assert.rejects(open(), { code: "busy" });
	await registry.close();
	const next = await open();
	assert.deepEqual(await bindPiFlowBranch(next, manager), scope);
	assert.deepEqual((await next.snapshot()).branches[0].position, position);
});

test("copied memory transcript cannot inherit a live manager's branch binding", async (t) => {
	const { root, manager, registry, open } = await fixture(t, { memory: true });
	await bindPiFlowBranch(registry, manager);
	const copied = SessionManager.inMemory(
		root,
		undefined,
		structuredClone([manager.getHeader(), ...manager.getEntries()]),
	);
	assert.equal(copied.getSessionId(), manager.getSessionId());
	await registry.close();
	const next = await open(copied);
	const before = await next.snapshot();
	await assert.rejects(bindPiFlowBranch(next, copied), /another transcript lifetime/);
	assert.deepEqual(await next.snapshot(), before);
	assert.deepEqual(await bindPiFlowBranch(next, manager), await next.currentScope());
});

test("memory navigation records a distinct branch within the same live lifetime", async (t) => {
	const { manager, registry, open } = await fixture(t, { memory: true });
	const original = await bindPiFlowBranch(registry, manager);
	const before = await registry.snapshot();
	const transition = await registry.beginNavigation(before.revision, manager.getLeafId());
	manager.resetLeaf();
	const scope = await completePiFlowNavigation(registry, manager, transition.id);
	assert.notEqual(scope.branchId, original.branchId);
	const after = await registry.snapshot();
	assert.equal(after.branches[1].position.memoryInstanceId, before.branches[0].position.memoryInstanceId);
	await registry.close();
	assert.deepEqual(await bindPiFlowBranch(await open(), manager), scope);
	assert.equal(manager.getSessionFile(), undefined);
});

test("pending memory navigation cannot be reconciled by a copied session manager", async (t) => {
	const { root, manager, registry, open } = await fixture(t, { memory: true });
	await bindPiFlowBranch(registry, manager);
	const transition = await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
	manager.resetLeaf();
	manager.appendCustomEntry("jouzu-flow-branch", {
		version: 1,
		sessionId: manager.getSessionId(),
		branchId: transition.branchId,
		transitionId: transition.id,
	});
	const copied = SessionManager.inMemory(
		root,
		undefined,
		structuredClone([manager.getHeader(), ...manager.getEntries()]),
	);
	await registry.close();
	const next = await open(copied);
	await assert.rejects(bindPiFlowBranch(next, copied), /another transcript lifetime/);
	assert.equal((await next.snapshot()).transition.id, transition.id);
	assert.equal((await bindPiFlowBranch(next, manager)).branchId, transition.branchId);
});

test("memory copies of durable transcripts cannot downgrade a persistent branch binding", async (t) => {
	const { root, manager, registry, open } = await fixture(t);
	await bindPiFlowBranch(registry, manager);
	const copied = SessionManager.inMemory(
		root,
		undefined,
		structuredClone([manager.getHeader(), ...manager.getEntries()]),
	);
	await registry.close();
	await assert.rejects(bindPiFlowBranch(await open(copied), copied), /another transcript lifetime/);
});

test("navigation onto a retained branch's path reactivates it without a new record", async (t) => {
	const { manager, registry, open } = await fixture(t);
	const first = await bindPiFlowBranch(registry, manager);
	manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
	const firstEntry = manager.getLeafId();
	// Resetting to the transcript root leaves no marker on the path, so it forks a new branch.
	const transition = await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
	manager.resetLeaf();
	const second = await completePiFlowNavigation(registry, manager, transition.id);
	assert.notEqual(second.branchId, first.branchId);
	manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
	const secondEntry = manager.getLeafId();
	// The first branch's entries still carry its marker, so returning there reactivates it.
	const back = await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
	manager.branch(firstEntry);
	const reactivated = await completePiFlowNavigation(registry, manager, back.id);
	assert.deepEqual(reactivated, first);
	const state = await registry.snapshot();
	assert.equal(state.activeBranchId, first.branchId);
	assert.equal(state.branches.length, 2, "reactivation appends no record");
	assert.equal(state.transition, undefined);
	// Returning to the second branch's own path reactivates it in turn.
	const forward = await registry.beginNavigation(state.revision, manager.getLeafId());
	manager.branch(secondEntry);
	assert.deepEqual(await completePiFlowNavigation(registry, manager, forward.id), second);
	// Leave the session on the first branch at a non-tip leaf, then restart: Pi reopens the
	// transcript at its newest entry, so verified evidence rebinds attachment to its owner.
	const away = await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
	manager.branch(firstEntry);
	await completePiFlowNavigation(registry, manager, away.id);
	await registry.close();
	const reopened = SessionManager.open(manager.getSessionFile());
	assert.notEqual(reopened.getLeafId(), firstEntry, "a restart reopens the transcript at its newest entry");
	assert.deepEqual(await bindPiFlowBranch(await open(reopened), reopened), second);
});

test("an untouched navigation journal follows the saved file tip on reopen", async (t) => {
	const { manager, registry, open } = await fixture(t);
	const first = await bindPiFlowBranch(registry, manager);
	manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
	const firstLeaf = manager.getLeafId();
	const fork = await registry.beginNavigation((await registry.snapshot()).revision, firstLeaf, firstLeaf);
	manager.resetLeaf();
	const second = await completePiFlowNavigation(registry, manager, fork.id);
	const tip = manager.getLeafId();
	const back = await registry.beginNavigation((await registry.snapshot()).revision, tip, tip);
	manager.branch(firstLeaf);
	assert.deepEqual(await completePiFlowNavigation(registry, manager, back.id), first);
	await registry.beginNavigation((await registry.snapshot()).revision, firstLeaf, tip);
	await registry.close();
	const reopened = SessionManager.open(manager.getSessionFile());
	const next = await open(reopened);
	assert.deepEqual(await bindPiFlowBranch(next, reopened), second);
	assert.equal((await next.snapshot()).branches.length, 2);
	assert.equal((await next.snapshot()).transition, undefined);
});

test("a legacy branch without a departure checkpoint forks on explicit navigation", async (t) => {
	const { manager, registry } = await fixture(t);
	const first = await bindPiFlowBranch(registry, manager);
	const firstLeaf = manager.getLeafId();
	const fork = await registry.beginNavigation((await registry.snapshot()).revision, firstLeaf);
	manager.resetLeaf();
	await completePiFlowNavigation(registry, manager, fork.id);
	const back = await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
	const snapshot = registry.snapshot.bind(registry);
	t.mock.method(registry, "snapshot", async () => {
		const state = await snapshot();
		delete state.branches.find((branch) => branch.id === first.branchId).departedAtLeafId;
		return state;
	});
	manager.branch(firstLeaf);
	const scope = await completePiFlowNavigation(registry, manager, back.id);
	assert.equal(scope.branchId, back.branchId);
	assert.notEqual(scope.branchId, first.branchId);
});

test("memory lifetime mismatch rejects reactivation before changing selection", async (t) => {
	const { manager, registry } = await fixture(t, { memory: true });
	const first = await bindPiFlowBranch(registry, manager);
	const firstLeaf = manager.getLeafId();
	const fork = await registry.beginNavigation((await registry.snapshot()).revision, firstLeaf);
	manager.resetLeaf();
	const second = await completePiFlowNavigation(registry, manager, fork.id);
	const snapshot = registry.snapshot.bind(registry);
	const before = await snapshot();
	t.mock.method(registry, "snapshot", async () => {
		const state = await snapshot();
		state.branches.find((branch) => branch.id === first.branchId).position.memoryInstanceId = "other-lifetime";
		return state;
	});
	manager.branch(firstLeaf);
	await assert.rejects(bindPiFlowBranch(registry, manager), { code: "identity" });
	assert.equal((await snapshot()).activeBranchId, second.branchId);
	assert.equal((await snapshot()).revision, before.revision);
});

test("an interrupted rewind inside the active branch forks on reopen instead of reactivating it", async (t) => {
	const { manager, registry, open } = await fixture(t);
	const first = await bindPiFlowBranch(registry, manager);
	manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
	const firstEntry = manager.getLeafId();
	manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
	const nav = await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
	// Crash point: Pi already persisted the rewind to an earlier entry of the same branch, and its
	// branch summary (here a plain message) landed before the flow marker was appended.
	manager.branch(firstEntry);
	manager.appendMessage({ role: "user", content: "summary", timestamp: 3 });
	manager.flush();
	await registry.close();
	const reopened = SessionManager.open(manager.getSessionFile());
	const next = await open(reopened);
	// The reopened path still carries the active branch's own marker, but ordinary completion of this
	// navigation would have forked there, so recovery completes that fork instead of reactivating the
	// branch the navigation was leaving.
	const scope = await bindPiFlowBranch(next, reopened);
	assert.equal(scope.branchId, nav.branchId);
	assert.notEqual(scope.branchId, first.branchId);
	const state = await next.snapshot();
	assert.equal(state.transition, undefined);
	assert.equal(state.activeBranchId, nav.branchId);
	assert.equal(state.branches.length, 2, "the fork appends its record and the earlier branch is retained");
	assert.deepEqual(await bindPiFlowBranch(next, reopened), scope);
});

test("an interrupted navigation onto a retired path completes its fork on reopen", async (t) => {
	const { manager, registry, open } = await fixture(t);
	const first = await bindPiFlowBranch(registry, manager);
	manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
	const firstEntry = manager.getLeafId();
	const transition = await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
	manager.resetLeaf();
	const second = await completePiFlowNavigation(registry, manager, transition.id);
	assert.equal(await registry.retireBranchHistory(1, new Set()), 1);
	// Crash point: the transition is durable, the leaf moved onto the retired path, and Pi's
	// branch summary (here a plain message) landed before the flow marker was appended.
	const nav = await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
	manager.branch(firstEntry);
	manager.appendMessage({ role: "user", content: "summary", timestamp: 2 });
	manager.flush();
	await registry.close();
	const reopened = SessionManager.open(manager.getSessionFile());
	const next = await open(reopened);
	const scope = await bindPiFlowBranch(next, reopened);
	assert.equal(scope.branchId, nav.branchId);
	assert.equal(scope.branchId !== first.branchId && scope.branchId !== second.branchId, true);
	const state = await next.snapshot();
	assert.equal(state.transition, undefined);
	assert.equal(state.activeBranchId, nav.branchId);
	// The completed fork is idempotent to reconcile.
	assert.deepEqual(await bindPiFlowBranch(next, reopened), scope);
});

test("a changed marker at a retained rebind target rejects binding without selecting it", async (t) => {
	const { manager, registry, open } = await fixture(t);
	const first = await bindPiFlowBranch(registry, manager);
	const firstMarker = manager.getBranch().find((entry) => entry.type === "custom");
	const transition = await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
	manager.resetLeaf();
	const second = await completePiFlowNavigation(registry, manager, transition.id);
	manager.appendMessage({ role: "user", content: "on second", timestamp: 1 });
	manager.flush();
	// Reactivate the first branch; the file tip stays on the second branch's path.
	const away = await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
	manager.branch(firstMarker.id);
	await completePiFlowNavigation(registry, manager, away.id);
	const state = await registry.snapshot();
	assert.equal(state.activeBranchId, first.branchId);
	await registry.close();
	// Corrupt the retained second branch's marker bytes on disk, reopen at its tip, and confirm
	// the failed identity check left the registry's active branch untouched.
	const path = manager.getSessionFile();
	const entries = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
	const marker = entries.find(
		(entry) => entry.customType === "jouzu-flow-branch" && entry.data?.branchId === second.branchId,
	);
	marker.timestamp = "changed";
	await writeFile(path, `${entries.map(JSON.stringify).join("\n")}\n`);
	const reopened = SessionManager.open(path);
	const next = await open(reopened);
	await assert.rejects(bindPiFlowBranch(next, reopened), { code: "identity" });
	const after = await next.snapshot();
	assert.equal(after.activeBranchId, first.branchId, "a rejected marker selects nothing");
	assert.equal(after.revision, state.revision);
});

test("navigation onto a retired branch's position forks with a fresh marker", async (t) => {
	const { manager, registry } = await fixture(t);
	const first = await bindPiFlowBranch(registry, manager);
	manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
	const firstEntry = manager.getLeafId();
	const transition = await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
	manager.resetLeaf();
	const second = await completePiFlowNavigation(registry, manager, transition.id);
	const secondEntry = manager.getLeafId();
	assert.equal(await registry.retireBranchHistory(1, new Set()), 1, "the active branch bounds the prefix drop");
	// The retired branch's marker is still the deepest on its abandoned path, but it names a
	// branch no registry retains, so the navigation forks with a fresh marker instead.
	const nav = await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
	manager.branch(firstEntry);
	const third = await completePiFlowNavigation(registry, manager, nav.id);
	const thirdEntry = manager.getLeafId();
	assert.notEqual(third.branchId, second.branchId);
	assert.notEqual(third.branchId, first.branchId);
	const grown = await registry.snapshot();
	assert.equal(grown.branches.length, 2);
	assert.equal(grown.branches.at(-1).fromBranchId, second.branchId);
	assert.deepEqual(grown.retired, { count: 1, through: [first.branchId] });
	// Returning to another retained branch's path reactivates it; neither move appends a record.
	const toSecond = await registry.beginNavigation(grown.revision, manager.getLeafId());
	manager.branch(secondEntry);
	assert.deepEqual(await completePiFlowNavigation(registry, manager, toSecond.id), second);
	const toThird = await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
	manager.branch(thirdEntry);
	assert.deepEqual(await completePiFlowNavigation(registry, manager, toThird.id), third);
	const settled = await registry.snapshot();
	assert.equal(settled.branches.length, 2);
	assert.equal(settled.activeBranchId, third.branchId);
});

// A restart reopens the transcript at its newest entry, so both the selected leaf and the file
// tip can be resume targets. Retirement must protect both, or the next attach cannot bind.
test("transcript owners cover the selected leaf and the reopened file tip", async (t) => {
	const { manager, registry } = await fixture(t);
	const first = await bindPiFlowBranch(registry, manager);
	assert.deepEqual(
		[...piTranscriptBranchOwners(manager)],
		[first.branchId],
		"a fresh session's leaf and tip are one branch",
	);
	const firstMarker = manager.getBranch().find((entry) => entry.type === "custom");
	assert.equal(firstMarker.data.branchId, first.branchId);

	// Fork at the marker itself, then leave the fork's message as the file tip.
	const fork = await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
	manager.resetLeaf();
	const second = await completePiFlowNavigation(registry, manager, fork.id);
	manager.appendMessage({ role: "user", content: "on the second branch", timestamp: 1 });
	manager.flush();

	// The first branch's recorded departure is the marker, so returning there reactivates it and
	// appends no marker: the selected leaf and the file tip now sit on different branches.
	const back = await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
	manager.branch(firstMarker.id);
	const resumed = await completePiFlowNavigation(registry, manager, back.id);
	assert.equal(resumed.branchId, first.branchId, "returning to the recorded departure reactivates");
	assert.equal((await registry.snapshot()).branches.length, 2, "reactivation appends no record");
	assert.equal(manager.getLeafId(), firstMarker.id);
	assert.notEqual(manager.getLeafId(), manager.getEntries().at(-1).id, "the tip is on the other branch");
	assert.deepEqual(
		[...piTranscriptBranchOwners(manager)].sort(),
		[first.branchId, second.branchId].sort(),
		"the selected leaf and the file tip are both protected",
	);
});

test("retirement keeps a transcript owner bindable across a reopen", async (t) => {
	const { manager, registry, open } = await fixture(t);
	const first = await bindPiFlowBranch(registry, manager);
	const firstMarker = manager.getBranch().find((entry) => entry.type === "custom");
	const fork = await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
	manager.resetLeaf();
	const second = await completePiFlowNavigation(registry, manager, fork.id);
	manager.appendMessage({ role: "user", content: "on the second branch", timestamp: 1 });
	manager.flush();
	const back = await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
	manager.branch(firstMarker.id);
	await completePiFlowNavigation(registry, manager, back.id);
	assert.equal(manager.getLeafId(), firstMarker.id);

	// Retirement at the smallest possible size must not drop a branch the restart can land on.
	assert.equal(
		await registry.retireBranchHistory(1, piTranscriptBranchOwners(manager)),
		0,
		"both records are load-bearing",
	);
	const before = await registry.snapshot();
	assert.deepEqual(before.branches.map((record) => record.id).sort(), [first.branchId, second.branchId].sort());
	await registry.close();

	// Without the protection the tip owner would be gone and this reopen would reject with
	// `identity`, leaving the session permanently unbindable.
	const reopened = SessionManager.open(manager.getSessionFile());
	assert.deepEqual(await bindPiFlowBranch(await open(reopened), reopened), second);
});
test("the legacy digest keeps the full key an earlier version wrote", () => {
	// Golden value: sha256 of the JSON scope, which is the key shape v0.1.14 and earlier used. The
	// adoption path is only correct while this derivation still matches what those versions wrote.
	assert.equal(
		legacyPathDigest(["01a0d36e-7417-7500-a4ce-202b024a9d8a", "registry"]),
		"6e02778a37d9c113557d43155e51bf019551dccf648d9813b5151d22c56f4dc0",
	);
	assert.equal(
		pathDigest(["01a0d36e-7417-7500-a4ce-202b024a9d8a", "registry"]),
		legacyPathDigest(["01a0d36e-7417-7500-a4ce-202b024a9d8a", "registry"]).slice(0, 32),
	);
});
const sessionFolderName = (cwd) => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

/**
 * Rewrite state the way an upgrade finds it: the registry sits under the key the full digest
 * produced, and the flow session inside it still records the path it was written at. Relocating
 * the directory without rewriting that path is what the shortened digest leaves behind.
 */
async function relocateToLegacyDigest(root, sessionId) {
	const registryRoot = join(root, "session-registry-v1");
	const currentKey = pathDigest([sessionId, "registry"]);
	const legacyKey = legacyPathDigest([sessionId, "registry"]);
	const current = join(registryRoot, currentKey);
	const legacy = join(registryRoot, legacyKey);
	const sessions = join(current, "sessions");
	for (const folder of await readdir(sessions)) {
		const directory = join(sessions, folder);
		for (const file of await readdir(directory)) {
			const path = join(directory, file);
			const text = await readFile(path, "utf8");
			const end = text.indexOf("\n");
			const header = JSON.parse(text.slice(0, end));
			header.cwd = legacy;
			await writeFile(path, JSON.stringify(header) + text.slice(end));
		}
		await rename(directory, join(sessions, sessionFolderName(legacy)));
	}
	await rename(current, legacy);
	return { currentKey, legacyKey, legacy };
}

test("a registry left under the legacy full digest is adopted instead of abandoned", async (t) => {
	const { root, manager, registry, open } = await fixture(t);
	const scope = await bindPiFlowBranch(registry, manager);
	await registry.close();
	const registryRoot = join(root, "session-registry-v1");
	const { currentKey, legacyKey } = await relocateToLegacyDigest(root, manager.getSessionId());
	assert.deepEqual(await readdir(registryRoot), [legacyKey]);

	const adopted = await open();
	const notices = [];
	// The stored registry is found and reused, so the same branch binds with nothing dropped.
	assert.deepEqual(await bindPiFlowBranch(adopted, manager, (path) => notices.push(path)), scope);
	assert.deepEqual(notices, []);
	assert.deepEqual(await readdir(registryRoot), [currentKey]);
});
test("a relocated flow session that must rebuild still opens instead of failing", async (t) => {
	const { root, manager, registry, open } = await fixture(t);
	await bindPiFlowBranch(registry, manager);
	await registry.close();
	const { legacy } = await relocateToLegacyDigest(root, manager.getSessionId());
	// Empty the flow journal, which is where the registry keeps its state. The reopen drops and
	// rebuilds the registry, while the session file still records the pre-shortening path. Rejecting
	// that path left the whole session unable to load.
	const sessions = join(legacy, "sessions");
	const [folder] = await readdir(sessions);
	const [file] = await readdir(join(sessions, folder));
	const path = join(sessions, folder, file);
	const [header] = (await readFile(path, "utf8")).split("\n");
	await writeFile(path, `${header}\n`);

	const rebuilt = await open();
	const notices = [];
	await bindPiFlowBranch(rebuilt, manager, (notice) => notices.push(notice));
	assert.equal(notices.length, 1, "the rebuilt registry is reported once");
});
test("rebuilding a navigated branch is idempotent and still rejects changed marker evidence", async (t) => {
	const { root, manager, registry, open } = await fixture(t);
	await bindPiFlowBranch(registry, manager);
	const transition = await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
	manager.resetLeaf();
	const scope = await completePiFlowNavigation(registry, manager, transition.id);
	await registry.close();
	await rm(join(root, "session-registry-v1"), { recursive: true });
	const rebuilt = await open();
	const notices = [];
	assert.deepEqual(await bindPiFlowBranch(rebuilt, manager, (path) => notices.push(path)), scope);
	const state = await rebuilt.snapshot();
	assert.equal(notices.length, 1);
	assert.deepEqual(await bindPiFlowBranch(rebuilt, manager, (path) => notices.push(path)), scope);
	assert.deepEqual(await rebuilt.snapshot(), state);
	assert.equal(notices.length, 1, "rebinding must not rebuild the same registry again");
	await rebuilt.close();
	const reopened = SessionManager.open(manager.getSessionFile());
	const next = await open(reopened);
	assert.deepEqual(await bindPiFlowBranch(next, reopened, (path) => notices.push(path)), scope);
	assert.deepEqual(await next.snapshot(), state);
	assert.equal(notices.length, 1, "restart must not rebuild the same registry again");
	await next.close();
	const path = manager.getSessionFile();
	const entries = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
	entries.at(-1).data.transitionId = "changed-transition";
	await writeFile(path, `${entries.map(JSON.stringify).join("\n")}\n`);
	const changed = SessionManager.open(path);
	const rejected = await open(changed);
	await assert.rejects(bindPiFlowBranch(rejected, changed), { code: "identity" });
	assert.deepEqual(await rejected.snapshot(), state);
});

test("a registry that cannot be reconciled with the transcript rebuilds instead of failing", async (t) => {
	const { root, manager, registry, open } = await fixture(t);
	const original = await bindPiFlowBranch(registry, manager);
	await registry.close();
	// The registry the transcript's marker refers to is gone, which is what a relocation or an
	// earlier record shape leaves behind. This reopen used to reject with `identity`.
	await rm(join(root, "session-registry-v1"), { recursive: true, force: true });

	const rebuilt = await open();
	const notices = [];
	const scope = await bindPiFlowBranch(rebuilt, manager, (path) => notices.push(path));
	assert.equal(scope.branchId, original.branchId);
	assert.equal(notices.length, 1, "the drop is reported once");
	const dropped = JSON.parse(await readFile(notices[0], "utf8"));
	assert.equal(dropped.branches.length, 1, "the discarded state is written aside");
	// The rebuild is durable: binding again keeps the branch and drops nothing further.
	const again = [];
	assert.deepEqual(await bindPiFlowBranch(rebuilt, manager, (path) => again.push(path)), scope);
	assert.deepEqual(again, []);
});
