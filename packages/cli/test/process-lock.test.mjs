import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { acquireProcessLock, ProcessLockError } from "../dist/process-lock.js";

const holder = new URL("./fixtures/process-lock-holder.mjs", import.meta.url);
const contender = fileURLToPath(new URL("./fixtures/process-lock-contender.mjs", import.meta.url));
const posixOnly = process.platform === "win32" ? "POSIX-only assertion" : false;

const cleanups = new WeakMap();
function makeDir(t) {
	const root = mkdtempSync(join(tmpdir(), "jouzu-process-lock-"));
	cleanups.set(t, []);
	t.after(async () => {
		for (const cleanup of cleanups.get(t).reverse()) await cleanup();
		rmSync(root, { recursive: true, force: true });
	});
	return root;
}

function reap(t, child) {
	cleanups.get(t).push(async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
	});
}

async function holdInChild(t, path, acquire = true) {
	const child = fork(holder, [path], { stdio: ["ignore", "ignore", "inherit", "ipc"], execArgv: ["--expose-gc"] });
	reap(t, child);
	const [ready] = await once(child, "message");
	assert.deepEqual(ready, { state: "ready" });
	if (!acquire) return child;
	child.send("acquire");
	const [reply] = await once(child, "message");
	assert.equal(reply.state, "held", `the child could not hold the lock: ${JSON.stringify(reply)}`);
	return child;
}

function assertBusy(path) {
	assert.throws(
		() => acquireProcessLock(path),
		(error) => error instanceof ProcessLockError && error.reason === "busy",
		"a held lock must report contention",
	);
}

function assertStorageFailure(path) {
	assert.throws(
		() => acquireProcessLock(path),
		(error) => error instanceof ProcessLockError && error.reason === "storage",
		"an unusable lock file must report a storage failure",
	);
}

test("a held lock excludes another process and release admits it", async (t) => {
	const root = makeDir(t);
	const path = join(root, "state", "owner.sqlite");
	const child = await holdInChild(t, path);
	assertBusy(path);
	child.send("release");
	const [released] = await once(child, "message");
	assert.deepEqual(released, { state: "released" });
	const lock = acquireProcessLock(path);
	lock.release();
	assert.ok(existsSync(path), "the lock file stays in place after release");
});

test("a suspended holder keeps ownership past the former stale threshold", { skip: posixOnly }, async (t) => {
	const root = makeDir(t);
	const path = join(root, "state", "owner.sqlite");
	const child = await holdInChild(t, path);
	child.kill("SIGSTOP");
	try {
		// The retired file protocol recovered an owner-unknown lock after five
		// seconds. Age must no longer authorize a takeover.
		await delay(5_500);
		assertBusy(path);
	} finally {
		child.kill("SIGCONT");
	}
	child.send("release");
	const [released] = await once(child, "message");
	assert.deepEqual(released, { state: "released" });
	const lock = acquireProcessLock(path);
	lock.release();
});

test("a killed holder releases the lock without cleanup", async (t) => {
	const root = makeDir(t);
	const path = join(root, "state", "owner.sqlite");
	const child = await holdInChild(t, path);
	child.kill("SIGKILL");
	await once(child, "exit");
	const lock = acquireProcessLock(path);
	lock.release();
});

test("simultaneous contenders never hold the lock at the same time", async (t) => {
	const root = makeDir(t);
	const path = join(root, "state", "owner.sqlite");
	const ledger = join(root, "ledger.txt");
	writeFileSync(ledger, "");
	const abandoned = await holdInChild(t, path);
	abandoned.kill("SIGKILL");
	await once(abandoned, "exit");
	const children = [0, 1, 2, 3].map((index) =>
		spawn(process.execPath, [contender, path, ledger, String(index), "40"], { stdio: ["ignore", "ignore", "inherit"] }),
	);
	for (const child of children) reap(t, child);
	const codes = await Promise.all(children.map(async (child) => (await once(child, "exit"))[0]));
	assert.deepEqual(codes, [0, 0, 0, 0], "every contender must acquire the lock at least once");
	const events = readFileSync(ledger, "utf8").trim().split("\n");
	assert.equal(events.length, 8);
	let open = null;
	for (const line of events) {
		const [kind, id] = line.split(" ");
		if (kind === "start") {
			assert.equal(open, null, `the protected interval of ${id} overlapped ${open}`);
			open = id;
		} else {
			assert.equal(open, id);
			open = null;
		}
	}
	assert.equal(open, null, "every contender must finish its protected interval");
});

test("release is idempotent and a leftover file never blocks acquisition", (t) => {
	const root = makeDir(t);
	const path = join(root, "state", "owner.sqlite");
	const lock = acquireProcessLock(path);
	lock.release();
	lock.release();
	assert.ok(existsSync(path));
	const next = acquireProcessLock(path);
	try {
		lock.release();
		assertBusy(path);
	} finally {
		next.release();
	}
});

for (const command of ["fail-release", "fail-acquire-close"]) {
	test(`${command} reports failure and retains ownership through garbage collection until exit`, async (t) => {
		const root = makeDir(t);
		const path = join(root, "state", "owner.sqlite");
		const child = await holdInChild(t, path, command === "fail-release");
		const reply = once(child, "message");
		child.send(command);
		const [failure] = await reply;
		assert.equal(failure.reason, "storage");
		if (command === "fail-release") assert.equal(failure.repeated, true);
		else assert.equal(failure.causes, 2);
		assertBusy(path);
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
		acquireProcessLock(path).release();
	});
}

test("locks on different paths do not exclude each other", (t) => {
	const root = makeDir(t);
	const first = acquireProcessLock(join(root, "state", "first.sqlite"));
	const second = acquireProcessLock(join(root, "state", "second.sqlite"));
	first.release();
	second.release();
});

test("a damaged lock file is reported as a storage failure and left untouched", (t) => {
	const root = makeDir(t);
	const path = join(root, "state", "owner.sqlite");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "a leftover record from another protocol\n");
	assertStorageFailure(path);
	assert.equal(readFileSync(path, "utf8"), "a leftover record from another protocol\n");
});

test("a symlinked lock path is refused", { skip: posixOnly }, (t) => {
	const root = makeDir(t);
	const target = join(root, "real.sqlite");
	const alias = join(root, "alias.sqlite");
	writeFileSync(target, "");
	symlinkSync(target, alias);
	assertStorageFailure(alias);
	// Refusing the alias must not leave the target locked.
	const lock = acquireProcessLock(target);
	lock.release();
});

test("the lock file is private and its parent directory is created", { skip: posixOnly }, (t) => {
	const root = makeDir(t);
	const path = join(root, "nested", "state", "owner.sqlite");
	const lock = acquireProcessLock(path);
	lock.release();
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
});
