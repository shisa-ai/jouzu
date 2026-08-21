import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { acquireStateLock, describeStateLock, inspectStateLock, STATE_LOCK_STALE_MS } from "../dist/state-lock.js";

function makeStateDir() {
	const root = mkdtempSync(join(tmpdir(), "jouzu-state-lock-"));
	const stateDir = join(root, "state");
	mkdirSync(stateDir, { recursive: true });
	return { root, stateDir };
}

function busyError() {
	return new Error("domain busy");
}

async function deadPid() {
	const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
	await new Promise((resolve) => child.once("exit", resolve));
	return child.pid;
}

test("acquire writes a record and token-safe release removes only its own lock", () => {
	const { root, stateDir } = makeStateDir();
	try {
		const path = join(stateDir, "lock");
		const release = acquireStateLock({ path, describe: "test", onBusy: busyError });
		assert.ok(existsSync(path));
		const record = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(record.pid, process.pid);
		assert.equal(typeof record.token, "string");

		// A successor overwrites the lock; our release must not delete it.
		writeFileSync(path, `${JSON.stringify({ pid: 1, startedAt: new Date().toISOString(), token: "successor" })}\n`);
		release();
		assert.ok(existsSync(path), "release must not delete a successor's lock");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("live contention is refused regardless of lock age", async () => {
	const { root, stateDir } = makeStateDir();
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
	try {
		const path = join(stateDir, "lock");
		writeFileSync(path, `${JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), token: "live" })}\n`);
		assert.throws(() => acquireStateLock({ path, describe: "test", onBusy: busyError }), /domain busy/);
		assert.ok(existsSync(path), "live lock must not be recovered");
	} finally {
		child.kill();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a dead owner's lock is refused while younger than the threshold and recovered after", async () => {
	const { root, stateDir } = makeStateDir();
	try {
		const path = join(stateDir, "lock");
		const pid = await deadPid();

		writeFileSync(path, `${JSON.stringify({ pid, startedAt: new Date().toISOString(), token: "dead" })}\n`);
		assert.throws(() => acquireStateLock({ path, describe: "test", onBusy: busyError }), /domain busy/);
		assert.ok(existsSync(path), "young dead lock must not be recovered");

		const staleStartedAt = new Date(Date.now() - STATE_LOCK_STALE_MS - 1000).toISOString();
		writeFileSync(path, `${JSON.stringify({ pid, startedAt: staleStartedAt, token: "dead" })}\n`);
		const release = acquireStateLock({ path, describe: "test", onBusy: busyError });
		assert.ok(existsSync(path), "recovered lock is held by us");
		release();
		assert.equal(existsSync(path), false, "lock released after recovery");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function writeAged(path, content, ageMs) {
	writeFileSync(path, content);
	const past = new Date(Date.now() - ageMs);
	utimesSync(path, past, past);
}

test("an empty legacy lock is owner-unknown: refused young, recovered stale", () => {
	const { root, stateDir } = makeStateDir();
	try {
		const path = join(stateDir, "lock");
		writeAged(path, "", 1000);
		assert.equal(inspectStateLock(path, new Date()).status, "owner-unknown");
		assert.throws(() => acquireStateLock({ path, describe: "test", onBusy: busyError }), /domain busy/);

		writeAged(path, "", STATE_LOCK_STALE_MS + 1000);
		const release = acquireStateLock({ path, describe: "test", onBusy: busyError });
		release();
		assert.equal(existsSync(path), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a malformed legacy lock is owner-unknown: refused young, recovered stale", () => {
	const { root, stateDir } = makeStateDir();
	try {
		const path = join(stateDir, "lock");
		writeAged(path, "{ not valid json", 1000);
		assert.equal(inspectStateLock(path, new Date()).status, "owner-unknown");
		assert.throws(() => acquireStateLock({ path, describe: "test", onBusy: busyError }), /domain busy/);

		writeAged(path, "{ not valid json", STATE_LOCK_STALE_MS + 1000);
		const release = acquireStateLock({ path, describe: "test", onBusy: busyError });
		release();
		assert.equal(existsSync(path), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("describeStateLock reports free, dead, and owner-unknown states", async () => {
	const { root, stateDir } = makeStateDir();
	try {
		const path = join(stateDir, "lock");
		assert.equal(describeStateLock(path, STATE_LOCK_STALE_MS, new Date()), "free");

		writeFileSync(
			path,
			`${JSON.stringify({ pid: await deadPid(), startedAt: new Date().toISOString(), token: "x" })}\n`,
		);
		assert.match(describeStateLock(path, STATE_LOCK_STALE_MS, new Date()), /dead process/);

		writeAged(path, "", 5000);
		assert.match(describeStateLock(path, STATE_LOCK_STALE_MS, new Date()), /owner unknown/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
