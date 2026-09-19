import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { SubagentManager } from "../dist/subagents/manager.js";
import { defaultAgentConfig, digest } from "../dist/subagents/roles.js";

// Hold a real exclusive-create descriptor open before publishing its owner record.
const pendingWriter = `
const fs = require("node:fs");
const path = process.argv[1];
const fd = fs.openSync(path, "wx", 0o600);
process.send("opened");
process.once("message", () => {
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: "child" }));
  fs.closeSync(fd);
  process.send("published");
});
`;

for (const kind of ["owner", "workspace"]) {
	test(`${kind} lock refuses a second process during publication and while its owner is live`, async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "jouzu-lock-contention-")));
		const paths = { cwd: root, stateDir: join(root, "state") };
		const path =
			kind === "owner"
				? join(paths.stateDir, "subagents", digest("parent"), "owner.lock")
				: join(paths.stateDir, "subagent-writers", `${digest(root)}.lock`);
		mkdirSync(dirname(path), { recursive: true });
		const child = spawn(process.execPath, ["-e", pendingWriter, path], {
			stdio: ["ignore", "ignore", "inherit", "ipc"],
		});
		const exited = once(child, "exit");
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
		const contend = () => {
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
				assert.equal(starts, 0, "no writer may start while the other process owns the lock");
			}
		};
		try {
			assert.deepEqual(await once(child, "message"), ["opened", undefined]);
			assert.equal(readFileSync(path, "utf8"), "");
			contend();
			const published = once(child, "message");
			child.send("publish");
			await published;
			assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, child.pid);
			contend();
		} finally {
			await manager.dispose();
			child.kill();
			await exited;
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("subagent ownership recovers an abandoned lock after the publication grace period", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "jouzu-lock-recovery-")));
	const paths = { cwd: root, stateDir: join(root, "state") };
	const path = join(paths.stateDir, "subagents", digest("parent"), "owner.lock");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "");
	const past = new Date(Date.now() - 10_000);
	utimesSync(path, past, past);
	const manager = new SubagentManager(paths, "parent", 1);
	try {
		manager.attach();
		assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, process.pid);
	} finally {
		await manager.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
