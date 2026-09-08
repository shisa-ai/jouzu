import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { bindPiFlowBranch, completePiFlowNavigation } from "../dist/flow-control/pi-branch-binding.js";
import { PiFlowSessionRegistry } from "../dist/flow-control/pi-session-registry.js";

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-branch-binding-"));
	const registries = [];
	t.after(async () => {
		for (const registry of registries.reverse()) await registry.close();
		await rm(root, { recursive: true, force: true });
	});
	const manager = SessionManager.create(root, join(root, "history"));
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
test("pending navigation without a marker stays unresolved and writes no transcript", async (t) => {
	const { manager, registry } = await fixture(t);
	await bindPiFlowBranch(registry, manager);
	await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
	const bytes = await readFile(manager.getSessionFile(), "utf8");
	await assert.rejects(bindPiFlowBranch(registry, manager), { code: "transition" });
	assert.equal(await readFile(manager.getSessionFile(), "utf8"), bytes);
	assert.ok((await registry.snapshot()).transition);
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
