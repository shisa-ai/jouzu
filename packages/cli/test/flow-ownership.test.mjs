import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FlowOwnership } from "../dist/flow-control/ownership.js";

const cleanups = new WeakMap();
const onCleanup = (t, action) => cleanups.get(t).push(action);

const scope = { sessionId: "parent", branchId: "branch" };
async function rootFor(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-owner-"));
	cleanups.set(t, []);
	t.after(async () => {
		for (const action of cleanups.get(t).reverse()) await action();
		await rm(root, { recursive: true, force: true });
	});
	return root;
}
async function childFor(t, root, branch = scope.branchId) {
	const child = fork(new URL("./fixtures/flow-owner.mjs", import.meta.url), [root, scope.sessionId, branch], {
		stdio: ["ignore", "pipe", "pipe", "ipc"],
		execArgv: ["--expose-gc"],
	});
	let stderr = "";
	child.stderr.on("data", (data) => {
		stderr += data;
	});
	onCleanup(t, async () => {
		if (child.exitCode === null && child.signalCode === null) {
			const ended = once(child, "exit");
			child.kill("SIGKILL");
			await ended;
		}
	});
	const receive = () =>
		new Promise((resolve, reject) => {
			const cleanup = () => {
				child.off("message", message);
				child.off("error", error);
				child.off("exit", exit);
			};
			const message = (result) => {
				cleanup();
				resolve(result);
			};
			const error = (cause) => {
				cleanup();
				reject(cause);
			};
			const exit = (status) => error(new Error(`Ownership fixture exited ${status}: ${stderr}`));
			child.once("message", message);
			child.once("error", error);
			child.once("exit", exit);
		});
	assert.deepEqual(await receive(), { state: "ready" });
	return {
		child,
		async send(command) {
			const result = receive();
			child.send(command);
			return result;
		},
	};
}

test("ownership uses session/branch identity and refuses another live attachment", async (t) => {
	const root = await rootFor(t);
	const first = FlowOwnership.acquire(root, scope);
	onCleanup(t, () => first.close());
	assert.throws(() => FlowOwnership.acquire(root, scope), { code: "busy" });
	const other = FlowOwnership.acquire(root, { ...scope, branchId: "other" });
	onCleanup(t, () => other.close());
	assert.notEqual(first.directory, other.directory);
	assert.notEqual(first.token, other.token);
	if (process.platform !== "win32")
		assert.equal((await stat(join(first.directory, "owner.sqlite"))).mode & 0o777, 0o600);
});

test("close holds ownership until admitted work drains and rejects stale callbacks", async (t) => {
	const root = await rootFor(t);
	const owner = FlowOwnership.acquire(root, scope);
	let finish;
	const pending = owner.run(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const closed = owner.close();
	assert.equal(owner.close(), closed);
	assert.throws(() => FlowOwnership.acquire(root, scope), { code: "busy" });
	await assert.rejects(
		owner.run(() => assert.fail("Late operation executed")),
		{ code: "closed" },
	);
	finish("saved");
	assert.equal(await pending, "saved");
	await closed;
	const next = FlowOwnership.acquire(root, scope);
	await next.close();
	assert.throws(() => owner.assertActive(), { code: "closed" });
});

test("failed admitted operations still drain without releasing a successor's lock", async (t) => {
	const root = await rootFor(t);
	const owner = FlowOwnership.acquire(root, scope);
	await assert.rejects(
		owner.run(() => {
			throw new Error("Write failed.");
		}),
		/Write failed/,
	);
	await owner.close();
	const next = FlowOwnership.acquire(root, scope);
	onCleanup(t, () => next.close());
	await owner.close();
	assert.throws(() => FlowOwnership.acquire(root, scope), { code: "busy" });
});

test("corrupt ownership file is preserved and reported rather than replaced", async (t) => {
	const root = await rootFor(t);
	const owner = FlowOwnership.acquire(root, scope);
	const path = join(owner.directory, "owner.sqlite");
	await owner.close();
	await writeFile(path, "invalid database");
	assert.throws(() => FlowOwnership.acquire(root, scope), { code: "storage" });
	assert.equal((await stat(path)).size, "invalid database".length);
});

test("two processes racing for a branch elect one owner; losing close cannot unlock it", {
	timeout: 15000,
}, async (t) => {
	const root = await rootFor(t);
	const peers = await Promise.all([childFor(t, root), childFor(t, root)]);
	const results = await Promise.all(peers.map((peer) => peer.send("acquire")));
	assert.equal(results.filter((result) => result.state === "owned").length, 1, JSON.stringify(results));
	assert.equal(results.filter((result) => result.code === "busy").length, 1, JSON.stringify(results));
	const loser = peers[results.findIndex((result) => result.state === "failed")];
	await loser.send("close");
	assert.throws(() => FlowOwnership.acquire(root, scope), { code: "busy" });
	const winner = peers[results.findIndex((result) => result.state === "owned")];
	await winner.send("close");
	const next = FlowOwnership.acquire(root, scope);
	await next.close();
});

test("killing a live owner permits immediate reattachment without stale-file deletion", {
	timeout: 15000,
}, async (t) => {
	const root = await rootFor(t);
	const peer = await childFor(t, root);
	const first = await peer.send("acquire");
	assert.equal(first.state, "owned");
	assert.throws(() => FlowOwnership.acquire(root, scope), { code: "busy" });
	const ended = once(peer.child, "exit");
	peer.child.kill("SIGKILL");
	await ended;
	const replacement = FlowOwnership.acquire(root, scope);
	assert.notEqual(replacement.token, first.token);
	await replacement.close();
});

test("ownership resolves symlinked caller ancestors to the same lock", async (t) => {
	const root = await rootFor(t);
	const actual = join(root, "actual");
	await mkdir(actual);
	const alias = join(root, "alias");
	await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
	const owner = FlowOwnership.acquire(join(alias, "receipts"), scope);
	onCleanup(t, () => owner.close());
	assert.throws(() => FlowOwnership.acquire(join(actual, "receipts"), scope), { code: "busy" });
});

test("ownership refuses a redirected lock file and normalizes directory failures", async (t) => {
	const root = await rootFor(t);
	const owner = FlowOwnership.acquire(root, scope);
	const lock = join(owner.directory, "owner.sqlite");
	await owner.close();
	await rm(lock);
	await mkdir(lock);
	assert.throws(() => FlowOwnership.acquire(root, scope), { code: "storage" });
	const invalidRoot = join(root, "file");
	await writeFile(invalidRoot, "preserve");
	assert.throws(() => FlowOwnership.acquire(invalidRoot, scope), { code: "storage" });
});

test("close inside admitted work rejects instead of waiting on itself", async (t) => {
	const root = await rootFor(t);
	const owner = FlowOwnership.acquire(root, scope);
	onCleanup(t, () => owner.close());
	await owner.run(async () => {
		await assert.rejects(owner.close(), { code: "lifecycle" });
		owner.assertActive();
	});
	await owner.close();
});

test("ownership remains exclusive while storage close is pending", async (t) => {
	const root = await rootFor(t);
	const owner = FlowOwnership.acquire(root, scope);
	let finish;
	const drained = new Promise((resolve) => {
		finish = resolve;
	});
	const closed = owner.close(() => drained);
	assert.throws(() => FlowOwnership.acquire(root, scope), { code: "busy" });
	finish();
	await closed;
	const next = FlowOwnership.acquire(root, scope);
	await next.close();
});

test("failed storage close retains ownership through garbage collection until process exit", {
	timeout: 15000,
}, async (t) => {
	const root = await rootFor(t);
	const peer = await childFor(t, root);
	assert.equal((await peer.send("acquire")).state, "owned");
	assert.deepEqual(await peer.send("fail-close"), { state: "failed-close", code: "storage" });
	assert.throws(() => FlowOwnership.acquire(root, scope), { code: "busy" });
	const ended = once(peer.child, "exit");
	peer.child.kill("SIGKILL");
	await ended;
	const next = FlowOwnership.acquire(root, scope);
	await next.close();
});
