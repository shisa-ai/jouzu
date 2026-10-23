import assert from "node:assert/strict";
import { test } from "node:test";
import { createFlowSession, deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { createScrollbackSessionObserver } from "../dist/scrollback-session.js";

test("scrollback observes live shell activity and clears only its own attachment", async () => {
	const observer = createScrollbackSessionObserver();
	const first = observer.wrap();
	const second = observer.wrap();
	const session = { isBashRunning: true };
	assert.equal(observer.isShellBusy(), false);
	await first.attach(session);
	assert.equal(observer.isShellBusy(), true);
	session.isBashRunning = false;
	assert.equal(observer.isShellBusy(), false);
	await second.attach({ isBashRunning: true });
	await first.dispose();
	assert.equal(observer.isShellBusy(), true);
	await second.dispose();
	assert.equal(observer.isShellBusy(), false);
});

test("scrollback wrapper preserves delegate methods, receivers, and dispatch ownership", async () => {
	const observer = createScrollbackSessionObserver();
	const calls = [];
	const delegate = {
		version: 1,
		async attach(value) {
			assert.equal(this, delegate);
			calls.push(["attach", value]);
		},
		async dispose() {
			assert.equal(this, delegate);
			calls.push(["dispose"]);
		},
		async beforeBranchChange(value) {
			assert.equal(this, delegate);
			calls.push(["before", value]);
		},
		async branchChanged(value) {
			assert.equal(this, delegate);
			calls.push(["after", value]);
		},
		async runCommand(value, run) {
			assert.equal(this, delegate);
			calls.push(["command", value]);
			await run();
		},
		async submit(value) {
			assert.equal(this, delegate);
			calls.push(["submit", value]);
		},
	};
	const wrapped = observer.wrap(delegate);
	const session = { isBashRunning: false };
	const scope = {};
	const submission = {};
	await wrapped.attach(session);
	await wrapped.beforeBranchChange(scope);
	await wrapped.branchChanged(scope);
	let commands = 0;
	await wrapped.runCommand(submission, async () => {
		commands++;
	});
	assert.equal(commands, 1);
	await wrapped.submit(submission, () => {
		throw Error("delegate owns dispatch");
	});
	await wrapped.dispose();
	assert.deepEqual(calls, [
		["attach", session],
		["before", scope],
		["after", scope],
		["command", submission],
		["submit", submission],
		["dispose"],
	]);
	let dispatched = 0;
	await observer.wrap().submit(submission, async () => {
		dispatched++;
	});
	assert.equal(dispatched, 1);
	await observer.wrap().runCommand(submission, async () => {
		commands++;
	});
	assert.equal(commands, 2);
});

test("scrollback wrapper forwards adapter registration and dispatch authorization with their receiver", async () => {
	const observer = createScrollbackSessionObserver();
	const calls = [];
	const adapter = {};
	const delegate = {
		version: 1,
		submit() {},
		async registerUserInputAdapter(...args) {
			assert.equal(this, delegate);
			calls.push(["register", ...args]);
			return adapter;
		},
		async authorizeExternal(...args) {
			assert.equal(this, delegate);
			calls.push(["authorize", ...args]);
			if (args[1] === "expired") throw Error("expired target");
		},
	};
	const wrapped = observer.wrap(delegate);
	const host = {};
	const options = { id: "fixture", label: "Fixture" };
	const submission = {};
	assert.equal(await wrapped.registerUserInputAdapter(host, options), adapter);
	await wrapped.authorizeExternal(submission, "epoch");
	await assert.rejects(wrapped.authorizeExternal(submission, "expired"), /expired target/);
	assert.deepEqual(calls, [
		["register", host, options],
		["authorize", submission, "epoch"],
		["authorize", submission, "expired"],
	]);
	assert.equal(observer.wrap().registerUserInputAdapter, undefined);
	assert.equal(observer.wrap().authorizeExternal, undefined);
});

test("host shell activity stays busy through executeBash while the agent is idle", async (t) => {
	const observer = createScrollbackSessionObserver();
	const { session } = await createFlowSession(t, { ingress: observer.wrap() });
	const entered = deferred();
	const release = deferred();
	const running = session.executeBash("fixture", undefined, {
		operations: {
			async exec() {
				entered.resolve();
				await release.promise;
				return { exitCode: 0 };
			},
		},
	});
	try {
		await entered.promise;
		assert.equal(session.isIdle, true);
		assert.equal(observer.isShellBusy(), true);
	} finally {
		release.resolve();
		await running;
	}
	assert.equal(observer.isShellBusy(), false);
	await session.dispose();
	assert.equal(observer.isShellBusy(), false);
});

test("failed attachment does not replace the observed session", async () => {
	const observer = createScrollbackSessionObserver();
	await observer.wrap().attach({ isBashRunning: true });
	const wrapped = observer.wrap({
		version: 1,
		attach() {
			throw Error("attach failed");
		},
		submit() {},
	});
	await assert.rejects(wrapped.attach({ isBashRunning: false }), /attach failed/);
	assert.equal(observer.isShellBusy(), true);
	await wrapped.dispose();
	assert.equal(observer.isShellBusy(), true);
});
