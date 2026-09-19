import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SubagentManager } from "../dist/subagents/manager.js";
import { defaultAgentConfig, digest } from "../dist/subagents/roles.js";

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
				? join(paths.stateDir, "subagents", digest("parent"), "owner.sqlite")
				: join(paths.stateDir, "subagent-writers", `${digest(root)}.sqlite`);
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

test("a leftover lock file from an earlier protocol does not block subagent ownership", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "jouzu-lock-leftover-")));
	const paths = { cwd: root, stateDir: join(root, "state") };
	const directory = join(paths.stateDir, "subagents", digest("parent"));
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
