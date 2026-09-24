import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathDigest } from "../dist/path-digest.js";
import { acquireProcessLock } from "../dist/process-lock.js";
import { SubagentManager } from "../dist/subagents/manager.js";
import { defaultAgentConfig } from "../dist/subagents/roles.js";

const holder = new URL("./fixtures/process-lock-holder.mjs", import.meta.url);

// Hold a real reservation in a second process and report when it is in place.
async function hold(path) {
	const child = fork(holder, [path], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
	const exited = once(child, "exit");
	const [ready] = await once(child, "message");
	assert.deepEqual(ready, { state: "ready" });
	child.send("acquire");
	const [reply] = await once(child, "message");
	assert.equal(reply.state, "held", `the holder could not acquire the lock: ${JSON.stringify(reply)}`);
	return { child, exited };
}

for (const kind of ["owner", "workspace"]) {
	test(`${kind} lock refuses a second process while its owner is live and admits one after it dies`, async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "jouzu-lock-contention-")));
		const paths = { cwd: root, stateDir: join(root, "state") };
		const path =
			kind === "owner"
				? join(paths.stateDir, "subagents", pathDigest("parent"), "owner.sqlite")
				: join(paths.stateDir, "subagent-writers", `${pathDigest(root)}.sqlite`);
		mkdirSync(dirname(path), { recursive: true });
		let starts = 0;
		const manager = new SubagentManager(paths, "parent", 1, (_launch, _emit, exit) => {
			starts++;
			return {
				send() {},
				async stop() {
					exit(false);
				},
			};
		});
		const held = await hold(path);
		try {
			if (kind === "owner") {
				assert.throws(() => manager.attach(), /controlled by another Jouzu process/);
			} else {
				const run = manager.launch({
					role: defaultAgentConfig().roles[1],
					model: { provider: "fixture", id: "test" },
					auth: {},
					cwd: root,
					task: "Test contention",
				});
				assert.equal(run.status, "queued");
				assert.equal(starts, 0, "no writer may start while another process owns the lock");
			}
			held.child.kill("SIGKILL");
			await held.exited;
			if (kind === "owner") {
				manager.attach();
			} else {
				const deadline = Date.now() + 5_000;
				while (starts === 0 && Date.now() < deadline) await delay(50);
				assert.equal(starts, 1, "the queued writer must start after the holder dies");
			}
		} finally {
			await manager.dispose();
			held.child.kill("SIGKILL");
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("a damaged workspace lock fails the run without starting a worker or retrying", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "jouzu-lock-damaged-")));
	const paths = { cwd: root, stateDir: join(root, "state") };
	const path = join(paths.stateDir, "subagent-writers", `${pathDigest(root)}.sqlite`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "damaged database");
	let starts = 0;
	const completions = [];
	const manager = new SubagentManager(
		paths,
		"parent",
		1,
		() => {
			starts++;
			assert.fail("A storage failure must not admit a worker");
		},
		(run) => completions.push(run),
	);
	try {
		const run = manager.launch({
			role: defaultAgentConfig().roles[1],
			model: { provider: "fixture", id: "test" },
			auth: {},
			cwd: root,
			task: "Test damaged lock",
		});
		assert.equal(run.status, "failed");
		assert.match(run.result, /Workspace lock failed:.*could not be acquired/);
		assert.ok(run.result.includes(path));
		assert.equal(starts, 0);
		assert.equal(completions.length, 1);
		assert.equal(completions[0].id, run.id);
		const saved = JSON.parse(
			readFileSync(join(paths.stateDir, "subagents", pathDigest("parent"), run.id, "run.json"), "utf8"),
		);
		assert.equal(saved.status, "failed");
		assert.equal(saved.result, run.result);
		assert.equal(manager.pending.size, 0);
		assert.equal(manager.queueTimer, undefined);
		assert.equal(readFileSync(path, "utf8"), "damaged database");
	} finally {
		await manager.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a failed writer-lock release fails completed and queued runs and rejects further work", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "jouzu-lock-release-")));
	const paths = { cwd: root, stateDir: join(root, "state") };
	let emit;
	let exit;
	let starts = 0;
	const completions = [];
	const manager = new SubagentManager(
		paths,
		"parent",
		1,
		(_launch, onEvent, onExit) => {
			starts++;
			emit = onEvent;
			exit = onExit;
			return {
				send() {},
				async stop() {
					onExit(false);
				},
			};
		},
		(run) => completions.push(run),
	);
	const launch = {
		role: defaultAgentConfig().roles[1],
		model: { provider: "fixture", id: "test" },
		auth: {},
		cwd: root,
		task: "Test release failure",
	};
	const first = manager.launch(launch);
	const queued = manager.launch(launch);
	const lock = manager.releases.get(first.id);
	const failure = t.mock.method(lock, "release", () => {
		throw new Error("Injected release failure");
	});
	try {
		emit({ type: "result", status: "completed", text: "Work finished" });
		exit(true);
		assert.equal(starts, 1);
		for (const run of [first, queued]) {
			const finished = manager.get(run.id);
			assert.equal(finished.status, "failed");
			assert.match(finished.result, /Process lock release failed; restart Jouzu/);
			assert.match(finished.result, /Injected release failure/);
			const saved = JSON.parse(
				readFileSync(join(paths.stateDir, "subagents", pathDigest("parent"), run.id, "run.json"), "utf8"),
			);
			assert.equal(saved.status, "failed");
		}
		assert.equal(completions.length, 2);
		assert.throws(() => manager.launch(launch), /Process lock release failed/);
		assert.throws(() => acquireProcessLock(join(paths.stateDir, "subagent-writers", `${pathDigest(root)}.sqlite`)), {
			reason: "busy",
		});
		await assert.rejects(manager.dispose(), /Process lock release failed/);
		await assert.rejects(manager.dispose(), /Process lock release failed/);
	} finally {
		failure.mock.restore();
		lock.release();
		await manager.dispose().catch(() => {});
		rmSync(root, { recursive: true, force: true });
	}
});

test("a failed owner-lock release rejects disposal and retains ownership", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "jouzu-owner-release-")));
	const paths = { cwd: root, stateDir: join(root, "state") };
	const manager = new SubagentManager(paths, "parent", 1);
	manager.attach();
	const lock = manager.releaseOwner;
	const failure = t.mock.method(lock, "release", () => {
		throw new Error("Injected owner close failure");
	});
	try {
		await assert.rejects(manager.dispose(), /Injected owner close failure/);
		await assert.rejects(manager.dispose(), /Injected owner close failure/);
		assert.throws(() => acquireProcessLock(join(paths.stateDir, "subagents", pathDigest("parent"), "owner.sqlite")), {
			reason: "busy",
		});
	} finally {
		failure.mock.restore();
		lock.release();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a leftover lock file from an earlier protocol does not block subagent ownership", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "jouzu-lock-leftover-")));
	const paths = { cwd: root, stateDir: join(root, "state") };
	const directory = join(paths.stateDir, "subagents", pathDigest("parent"));
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "owner.sqlite"), "");
	writeFileSync(
		join(directory, "owner.lock"),
		`${JSON.stringify({ pid: 1, startedAt: new Date().toISOString(), token: "earlier-protocol" })}\n`,
	);
	const manager = new SubagentManager(paths, "parent", 1);
	try {
		manager.attach();
	} finally {
		await manager.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a child's flow storage path stays inside the Windows SQLite limit", () => {
	// SQLite on Windows fails with SQLITE_CANTOPEN once a path reaches roughly
	// 250 characters, even though node:fs reaches longer paths through \\?\.
	// The default Windows state root is %LOCALAPPDATA%\Jouzu\state, and a child
	// nests its flow storage several digests below it.
	const stateDir = "C:\\Users\\example\\AppData\\Local\\Jouzu\\state";
	const childDirectory = join(
		stateDir,
		"subagents",
		pathDigest("parent-session"),
		"3f0f2b1c-9d4e-4a5b-8c6d-7e8f9a0b1c2d",
	);
	const lockPath = join(
		childDirectory,
		"flow",
		"session-registry-v1",
		pathDigest(["parent", "branch"]),
		"owner.sqlite",
	);
	assert.ok(lockPath.length < 250, `child flow lock path is ${lockPath.length} characters: ${lockPath}`);
});
