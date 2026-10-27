import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { afterCleanup } from "./fixtures/cleanup.mjs";
import { fixture } from "./fixtures/flow-session-ingress.mjs";

async function commandFixture(t, { extensions = [], ...options } = {}) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-adapter-command-"));
	afterCleanup(t, () => rm(root, { recursive: true, force: true }));
	const outcomes = [];
	let target;
	const f = await fixture(t, {
		root,
		agentDir: root,
		autoRelease: false,
		...options,
		extensions: [
			(pi) => {
				pi.registerCommand("navigate", {
					handler: async (args, ctx) => {
						try {
							outcomes.push(await ctx.navigateTree(args || target, { summarize: false }));
						} catch (error) {
							outcomes.push(error);
						}
					},
				});
				pi.registerCommand("refresh", {
					handler: async (_args, ctx) => {
						try {
							await ctx.reload();
							outcomes.push("reloaded");
						} catch (error) {
							outcomes.push(error);
						}
					},
				});
			},
			...extensions,
		],
	});
	target = f.session.sessionManager.appendCustomEntry("adapter-anchor", {});
	f.session.sessionManager.appendCustomEntry("adapter-tail", {});
	await f.session.bindExtensions({
		commandContextActions: {
			navigateTree: (id, options) => f.session.navigateTree(id, options),
			reload: () => f.session.reload(),
		},
	});
	const path = join(root, "adapter.ts");
	await writeFile(path, "export default () => {};\n");
	const extensionId = await realpath(path);
	await writeFile(
		join(root, "user-input-adapters.json"),
		JSON.stringify({ schemaVersion: 1, grants: [{ extensionPath: extensionId, adapterId: "fixture" }] }),
	);
	const register = async () => {
		const adapter = await f.session._flowBinding.registerUserInputAdapter(extensionId, {
			id: "fixture",
			label: "Fixture",
		});
		return { adapter, binding: await adapter.bind() };
	};
	return { ...f, outcomes, register, ...(await register()) };
}

const input = (binding, messageId) => ({ binding, messageId, text: `external ${messageId}`, deliverAs: "followUp" });
const externalRecords = async (store) => (await store.snapshot()).filter((record) => record.submission.externalUser);

async function deliverOnce(f, adapter, binding, messageId) {
	const submitted = input(binding, messageId);
	const before = f.sent.length;
	await adapter.submit(submitted);
	await f.ingress.joinPendingOperations();
	const receipt = await adapter.lookup({ target: binding.target, messageId });
	assert.equal(receipt.state, "consumed");
	assert.equal(f.sent.length, before + 1);
	assert.deepEqual(await adapter.submit(submitted), receipt);
	await f.ingress.joinPendingOperations();
	assert.equal(f.sent.length, before + 1, "retry dispatched twice");
}

test("command navigation refuses external input before retention during attachment teardown", async (t) => {
	const f = await commandFixture(t);
	const entered = deferred(),
		release = deferred();
	const attachment = f.ingress.branch().attachment;
	const close = attachment.close.bind(attachment);
	t.mock.method(attachment, "close", async (...args) => {
		entered.resolve();
		await release.promise;
		return close(...args);
	});
	const navigating = f.session.prompt("/navigate");
	try {
		await entered.promise;
		await assert.rejects(f.adapter.submit(input(f.binding, "during-navigation")), { code: "stale-target" });
		assert.deepEqual(await externalRecords(attachment.submissions), []);
		assert.equal(f.sent.length, 0);
	} finally {
		release.resolve();
		await navigating;
	}
	assert.equal(f.outcomes[0].cancelled, false, String(f.outcomes[0]));
});

test("external retention crossing command navigation is cancelled before dispatch", async (t) => {
	const f = await commandFixture(t);
	const retaining = deferred(),
		retainGate = deferred(),
		navigating = deferred(),
		closeGate = deferred();
	const attachment = f.ingress.branch().attachment;
	const store = attachment.submissions;
	const retain = store.retainExternal.bind(store);
	t.mock.method(store, "retainExternal", async (...args) => {
		retaining.resolve();
		await retainGate.promise;
		return retain(...args);
	});
	const before = f.ingress.beforeBranchChange.bind(f.ingress);
	t.mock.method(f.ingress, "beforeBranchChange", () => {
		const pending = before();
		navigating.resolve();
		return pending;
	});
	const close = attachment.close.bind(attachment);
	t.mock.method(attachment, "close", async (...args) => {
		await closeGate.promise;
		return close(...args);
	});
	const refused = assert.rejects(f.adapter.submit(input(f.binding, "crossing")), { code: "stale-target" });
	await retaining.promise;
	const command = f.session.prompt("/navigate");
	try {
		await navigating.promise;
		retainGate.resolve();
		await refused;
		const records = await externalRecords(store);
		assert.equal(records.length, 1);
		assert.equal(records[0].status, "cancelled");
		assert.equal(records[0].dispatch, undefined);
		assert.equal(f.ingress.pending.has(records[0].id), false);
		assert.equal(f.sent.length, 0);
	} finally {
		retainGate.resolve();
		closeGate.resolve();
		await command;
	}
	assert.equal(f.outcomes[0].cancelled, false, String(f.outcomes[0]));
});

test("held external input survives command navigation and reattaches only on explicit retry", async (t) => {
	let holding = true,
		preparations = 0;
	const f = await commandFixture(t, {
		admit: async () => !holding,
		extensions: [
			(pi) =>
				pi.on("session_before_tree", () => {
					preparations++;
				}),
		],
	});
	const originalLeaf = f.session.sessionManager.getLeafId();
	const originalScope = f.ingress.branch().scope;
	const submitted = input(f.binding, "held");
	assert.equal((await f.adapter.submit(submitted)).state, "held");
	holding = false;
	await f.session.prompt("/navigate");
	assert.equal(f.outcomes[0].cancelled, false, String(f.outcomes[0]));
	assert.equal(preparations, 1);
	assert.notEqual(f.ingress.branch().scope.branchId, originalScope.branchId);
	assert.equal(f.sent.length, 0);
	await assert.rejects(f.adapter.submit(submitted), { code: "stale-target" });
	await assert.rejects(f.adapter.lookup({ target: f.binding.target, messageId: "held" }), {
		code: "target-unavailable",
	});
	await f.session.prompt(`/navigate ${originalLeaf}`);
	assert.equal(f.outcomes[1].cancelled, false, String(f.outcomes[1]));
	assert.equal(f.ingress.branch().scope.branchId, originalScope.branchId);
	const back = await f.adapter.bind();
	assert.equal(back.target, f.binding.target);
	assert.notEqual(back.generation, f.binding.generation);
	const receipt = await f.adapter.lookup({ target: back.target, messageId: "held" });
	assert.equal(receipt.state, "unknown");
	assert.equal(receipt.reason.code, "callback-ended");
	assert.equal(f.sent.length, 0);
	await deliverOnce(f, f.adapter, back, "held");
});

test("cancelled command navigation preserves the adapter binding and deduplication", async (t) => {
	const f = await commandFixture(t, {
		extensions: [(pi) => pi.on("session_before_tree", () => ({ cancel: true }))],
	});
	await f.session.prompt("/navigate");
	assert.equal(f.outcomes[0].cancelled, true);
	assert.deepEqual(await f.adapter.bind(), f.binding);
	await deliverOnce(f, f.adapter, f.binding, "after-cancel");
});

test("command reload retires held callbacks and permits replacement registration", async (t) => {
	let f,
		ended,
		fresh,
		holding = true;
	f = await commandFixture(t, {
		admit: async () => !holding,
		extensions: [
			(pi) => {
				pi.on("session_shutdown", async (event) => {
					if (event.reason === "reload")
						ended = await f.adapter.bind().then(
							() => "live",
							(error) => error.code,
						);
				});
				pi.on("session_start", async (event) => {
					if (event.reason === "reload") fresh = await f.register();
				});
			},
		],
	});
	const submitted = input(f.binding, "held-reload");
	assert.equal((await f.adapter.submit(submitted)).state, "held");
	holding = false;
	await f.session.prompt("/refresh");
	assert.equal(f.outcomes[0], "reloaded");
	assert.equal(ended, "stale-target");
	assert.ok(fresh?.adapter, "replacement session_start failed to register");
	assert.equal(f.sent.length, 0);
	const [record] = await externalRecords(f.ingress.branch().attachment.submissions);
	assert.equal(record.unavailable, "callback-ended");
	assert.equal(record.dispatch, undefined);
	assert.equal(
		(await fresh.adapter.lookup({ target: fresh.binding.target, messageId: submitted.messageId })).reason.code,
		"callback-ended",
	);
	await fresh.adapter.submit({ ...submitted, binding: fresh.binding });
	await f.ingress.joinPendingOperations();
	assert.equal(
		(await fresh.adapter.lookup({ target: fresh.binding.target, messageId: submitted.messageId })).state,
		"consumed",
	);
	assert.equal(f.sent.length, 1);
});

test("a failed release with automatic release disabled reports no error", async (t) => {
	// `autoRelease: false` has no error channel, so a release failure must be dropped rather than
	// reported through a callback that does not exist. The release runs after `submit` returns, so
	// capture process-level rejections the way the host would see them.
	const unhandled = [];
	const listener = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", listener);
	t.after(() => process.off("unhandledRejection", listener));
	let admissions = 0;
	const releasing = deferred();
	const f = await commandFixture(t, {
		admit: async () => {
			// The retain decision holds the message; the release that follows asks again and fails.
			if (++admissions === 1) return false;
			releasing.resolve();
			throw new Error("release admission failed");
		},
	});
	const submitted = input(f.binding, "failed-release");
	assert.equal((await f.adapter.submit(submitted)).state, "held");
	await releasing.promise;
	// Let the detached release reject and its report settle before asserting the process is quiet.
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(unhandled, []);
	assert.equal(f.sent.length, 0);
	assert.equal((await f.adapter.lookup({ target: f.binding.target, messageId: submitted.messageId })).state, "held");
});

test("old runtime registration during command reload cannot reserve the replacement identity", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-adapter-reload-"));
	afterCleanup(t, () => rm(root, { recursive: true, force: true }));
	const path = join(root, "runtime-adapter.mjs");
	await writeFile(
		path,
		`export default function(pi) {
		const register = async (phase) => {
			try { await pi.registerUserInputAdapter({ id: "fixture", label: "Fixture" }); pi.events.emit("registration", { phase, code: "registered" }); }
			catch (error) { pi.events.emit("registration", { phase, code: error.code }); }
		};
		pi.registerCommand("refresh", { handler: async (_args, ctx) => ctx.reload() });
		pi.on("session_shutdown", async event => { if (event.reason === "reload") await register("shutdown"); });
		pi.on("session_start", async event => { if (event.reason === "reload") await register("replacement"); });
	}`,
	);
	await writeFile(
		join(root, "user-input-adapters.json"),
		JSON.stringify({
			schemaVersion: 1,
			grants: [{ extensionPath: await realpath(path), adapterId: "fixture" }],
		}),
	);
	const f = await fixture(t, { root, agentDir: root, additionalExtensionPaths: [path], autoRelease: false });
	const reports = [];
	f.session.resourceLoader.eventBus.on("registration", (event) => reports.push(event));
	await f.session.bindExtensions({ commandContextActions: { reload: () => f.session.reload() } });
	await f.session.prompt("/refresh");
	assert.deepEqual(reports, [
		{ phase: "shutdown", code: "stale-target" },
		{ phase: "replacement", code: "registered" },
	]);
	assert.equal(f.sent.length, 0);
});

for (const owner of ["command", "invocation"])
	test(`authorization rechecks ${owner} ownership without losing or duplicating input`, async (t) => {
		let holding = true;
		const parked = deferred(),
			gate = deferred(),
			entered = deferred(),
			finish = deferred();
		// Release barriers before the fixture starts its disposal cleanup after an assertion failure.
		t.after(() => {
			gate.resolve();
			finish.resolve();
		});
		const f = await commandFixture(t, {
			admit: async () => !holding,
			extensions: [
				(pi) =>
					pi.registerCommand("park", {
						handler: async () => {
							entered.resolve();
							await finish.promise;
						},
					}),
			],
		});
		const store = f.ingress.branch().attachment.submissions;
		let admitting = false;
		const admit = f.ingress.admit.bind(f.ingress);
		t.mock.method(f.ingress, "admit", async (...args) => {
			admitting = true;
			try {
				return await admit(...args);
			} finally {
				admitting = false;
			}
		});
		let recordId,
			parkedOnce = false;
		const authorize = f.ingress.external.authorize.bind(f.ingress.external);
		t.mock.method(f.ingress.external, "authorize", async (...args) => {
			const granted = await authorize(...args);
			if (!admitting && !parkedOnce && f.ingress.pending.get(recordId)?.running) {
				parkedOnce = true;
				parked.resolve();
				await gate.promise;
			}
			return granted;
		});
		assert.equal((await f.adapter.submit(input(f.binding, "queued"))).state, "held");
		const [record] = await externalRecords(store);
		recordId = record.id;
		holding = false;
		const released = f.ingress.release(record.id, record.revision);
		await parked.promise;
		const competing =
			owner === "command"
				? f.session.prompt("/park")
				: f.ingress.branch().workContext.run(undefined, async () => {
						entered.resolve();
						await finish.promise;
					});
		await entered.promise;
		gate.resolve();
		try {
			assert.equal(await released, owner === "command");
			if (owner === "invocation") {
				const [held] = await externalRecords(store);
				assert.equal(held.status, "retained");
				assert.equal(held.unavailable, undefined);
				assert.equal(held.dispatch, undefined);
				assert.equal(f.ingress.pending.has(record.id), true);
				assert.equal(
					(await f.ingress.branch().attachment.waits.authoritySnapshot()).work.some((work) =>
						work.userInputs?.some((source) => source.id === record.id),
					),
					false,
				);
				assert.equal(f.sent.length, 0);
			} else {
				assert.equal(f.ingress.pending.has(record.id), false);
				assert.equal((await f.adapter.lookup({ target: f.binding.target, messageId: "queued" })).state, "consumed");
				assert.equal(f.sent.length, 1);
			}
		} finally {
			finish.resolve();
			await competing;
		}
		if (owner === "invocation") assert.equal(await f.ingress.release(record.id, record.revision), true);
		await f.ingress.joinPendingOperations();
		assert.equal((await f.adapter.lookup({ target: f.binding.target, messageId: "queued" })).state, "consumed");
		assert.equal((await f.adapter.submit(input(f.binding, "queued"))).state, "consumed");
		await f.ingress.joinPendingOperations();
		assert.equal(f.sent.length, 1);
		assert.equal(
			(await f.ingress.branch().attachment.waits.authoritySnapshot()).work.filter((work) =>
				work.userInputs?.some((source) => source.id === record.id),
			).length,
			1,
			"delivery must create exactly one user-work claim",
		);
	});
