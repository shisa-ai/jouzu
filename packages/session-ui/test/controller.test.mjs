import assert from "node:assert/strict";
import { test } from "node:test";

import { SessionStatusController } from "../dist/index.js";

function context(cwd, idle = true) {
	return {
		cwd,
		model: { provider: "p", id: "m", name: "Model", contextWindow: 1000 },
		thinkingLevel: "low",
		scopedModels: [],
		isIdle: () => idle,
		getContextUsage: () => ({ tokens: 10, contextWindow: 1000, percent: 1 }),
		sessionManager: { getBranch: () => [] },
	};
}

test("publishes snapshots and preserves idle start until activity", () => {
	let now = 100;
	const controller = new SessionStatusController({
		run: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
		clock: { now: () => now },
	});
	const observed = [];
	controller.subscribe((snapshot) => observed.push(snapshot));
	assert.equal(controller.sync(context("/one")).activity.idleSince, 100);
	now = 200;
	assert.equal(controller.sync(context("/one")).activity.idleSince, 100);
	assert.deepEqual(controller.sync(context("/one", false)).activity, { idle: false });
	now = 300;
	assert.equal(controller.sync(context("/one")).activity.idleSince, 300);
	assert.equal(observed.length, 4);
	controller.dispose();
	controller.sync(context("/one"));
	assert.equal(observed.length, 4);
});

test("coalesces project refreshes and publishes only typed source outcomes", async () => {
	let now = 1000;
	const gitCalls = [];
	const runtimeCalls = [];
	const controller = new SessionStatusController({
		run: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		clock: { now: () => now++ },
		readGit: async (cwd) => {
			gitCalls.push(cwd);
			await Promise.resolve();
			return {
				branch: cwd.slice(1),
				dirty: false,
				ahead: 0,
				behind: 0,
				conflicted: 0,
				untracked: 0,
				stashed: 0,
				modified: 0,
				staged: 0,
				renamed: 0,
				deleted: 0,
				typeChanged: 0,
			};
		},
		readRuntime: async (cwd) => {
			runtimeCalls.push(cwd);
			await Promise.resolve();
			return { id: "node", version: `v${cwd.length}` };
		},
	});
	controller.sync(context("/first"));
	const first = controller.refreshProject(context("/first"));
	const second = controller.refreshProject(context("/second"));
	assert.equal(first, second);
	await first;
	assert.deepEqual(gitCalls, ["/first", "/second"]);
	assert.deepEqual(runtimeCalls, ["/first", "/second"]);
	assert.equal(controller.getSnapshot().workspace.label, "second");
	assert.equal(controller.getSnapshot().git.value.branch, "second");
	assert.equal(controller.getSnapshot().runtime.value.id, "node");
	await controller.refreshGit(context("/third"));
	assert.deepEqual(gitCalls, ["/first", "/second", "/third"]);
	assert.deepEqual(runtimeCalls, ["/first", "/second"]);
});

test("aborts source work and suppresses updates after disposal", async () => {
	let observedSignal;
	const controller = new SessionStatusController({
		run: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		readGit: async (_cwd, _run, signal) => {
			observedSignal = signal;
			await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
			return undefined;
		},
		readRuntime: async () => undefined,
	});
	controller.sync(context("/repo"));
	const refresh = controller.refreshProject(context("/repo"));
	controller.dispose();
	await refresh;
	assert.equal(observedSignal.aborted, true);
});
