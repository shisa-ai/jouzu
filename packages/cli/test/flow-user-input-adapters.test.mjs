import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deferred, tick } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { createScrollbackSessionObserver } from "../dist/scrollback-session.js";
import { SessionManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { afterCleanup } from "./fixtures/cleanup.mjs";
import { fixture } from "./fixtures/flow-session-ingress.mjs";

/** Bounded wait for a state the host reaches asynchronously, with the expectation in the failure. */
async function until(predicate, message) {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(message);
}

async function setup(t, options = {}) {
	const agentDir = await mkdtemp(join(tmpdir(), "jouzu-user-input-"));
	afterCleanup(t, () => rm(agentDir, { recursive: true, force: true }));
	const path = join(agentDir, "extension.ts");
	await writeFile(path, "export default () => {};\n");
	const extensionId = await realpath(path);
	const grants = join(agentDir, "user-input-adapters.json");
	const writeGrants = (list) => writeFile(grants, JSON.stringify({ schemaVersion: 1, grants: list }));
	const grant = { extensionPath: extensionId, adapterId: "fixture" };
	await writeGrants([grant]);
	const f = await fixture(t, { agentDir, ...options });
	// Exercise host registration through the binding; loader closure identity has its own seam test.
	const register = (target = {}) =>
		f.session._flowBinding.registerUserInputAdapter(
			target.extensionId ?? extensionId,
			{ id: target.id ?? "fixture", label: target.label ?? "Fixture" },
			options.runtimeAssert,
		);
	// `register: false` leaves the identity free for a test that must register it itself, such as a
	// first registration made while flow is suspended.
	const adapter = options.register === false ? undefined : await register();
	const binding = adapter && (await adapter.bind());
	return {
		...f,
		adapter,
		binding,
		register,
		writeGrants,
		agentDir,
		extensionId,
		revoke: () => writeGrants([]),
		restore: () => writeGrants([grant]),
	};
}
const input = (f, messageId = "one", text = "external instruction", deliverAs = "followUp") => ({
	binding: f.binding,
	messageId,
	text,
	deliverAs,
});
const lookup = (f, messageId) => f.adapter.lookup({ target: f.binding.target, messageId });
const externalRecords = async (f) =>
	(await f.ingress.branch().attachment.submissions.snapshot()).filter((record) => record.submission.externalUser);

test("canonical identity drift cannot authorize an old handle or its retained input", async (t) => {
	let allowed = false;
	const f = await setup(t, { register: false, admit: async () => allowed });
	const other = join(f.agentDir, "other.ts");
	const alias = join(f.agentDir, "alias.ts");
	await writeFile(other, "export default () => {};\n");
	await symlink(f.extensionId, alias);
	f.adapter = await f.register({ extensionId: alias });
	f.binding = await f.adapter.bind();
	assert.equal((await f.adapter.submit(input(f))).state, "held");
	const [record] = await externalRecords(f);
	await unlink(alias);
	await symlink(other, alias);
	await f.writeGrants([{ extensionPath: await realpath(other), adapterId: "fixture" }]);
	await assert.rejects(f.adapter.bind(), { code: "unauthorized" });
	await assert.rejects(lookup(f, "one"), { code: "unauthorized" });
	await assert.rejects(f.adapter.submit(input(f, "two")), { code: "unauthorized" });
	await assert.rejects(
		f.ingress.authorizeExternal(
			record.submission,
			await f.ingress.branch().attachment.submissions.externalTargetEpoch(),
		),
		{ code: "unauthorized" },
	);
	allowed = true;
	assert.equal(await f.ingress.release(record.id, record.revision), false);
	await f.ingress.joinPendingOperations();
	const [cancelled] = await externalRecords(f);
	assert.equal(cancelled.status, "cancelled");
	assert.equal(cancelled.cancellationReason, "unauthorized");
	assert.equal(f.sent.length, 0);
	const replacement = await f.register({ extensionId: alias });
	assert.equal(await replacement.lookup({ target: f.binding.target, messageId: "one" }), undefined);
});

test("a first authorization fault records a visible hold without a prior policy hold", async (t) => {
	const f = await setup(t);
	const store = f.ingress.branch().attachment.submissions;
	const retain = store.retainExternal.bind(store);
	t.mock.method(store, "retainExternal", async (...args) => {
		const retained = await retain(...args);
		await writeFile(join(f.agentDir, "user-input-adapters.json"), "{");
		return retained;
	});
	await assert.rejects(f.adapter.submit(input(f)), { code: "invalid-config" });
	const [record] = await externalRecords(f);
	assert.equal(record.dispatch, undefined);
	assert.match(record.holds?.[0]?.reason ?? "", /authorization is unavailable/);
	assert.ok((await f.ingress.heldInputs()).some((held) => held.id === record.id));
	assert.equal(f.sent.length, 0);
	await f.restore();
	assert.equal((await lookup(f, "one")).state, "held");
	assert.equal(await f.ingress.release(record.id, record.revision), true);
	await f.ingress.joinPendingOperations();
	assert.equal((await lookup(f, "one")).state, "consumed");
	assert.equal(f.sent.length, 1);
});

test("external human clears reopening pause, consumes once, and conflicting retry does not dispatch", async (t) => {
	const f = await setup(t);
	f.ingress.pauseAutomated("reopened");
	const receipt = await f.adapter.submit(input(f));
	assert.equal(receipt.messageId, "one");
	await f.ingress.joinPendingOperations();
	assert.equal((await f.adapter.lookup({ target: f.binding.target, messageId: "one" })).state, "consumed");
	await f.adapter.submit(input(f));
	await f.ingress.joinPendingOperations();
	assert.equal(f.sent.length, 1);
	await assert.rejects(f.adapter.submit(input(f, "one", "changed")), { code: "id-conflict" });
});

test("launcher scrollback wrapper preserves external delivery and consumed deduplication", async (t) => {
	const observer = createScrollbackSessionObserver();
	const f = await setup(t, { provider: true, wrapIngress: (delegate) => observer.wrap(delegate) });
	await f.adapter.submit(input(f));
	await f.ingress.joinPendingOperations();
	assert.equal((await lookup(f, "one")).state, "consumed");
	assert.equal(f.sent.length, 1);
	assert.equal((await f.adapter.submit(input(f))).state, "consumed");
	await f.ingress.joinPendingOperations();
	assert.equal(f.sent.length, 1);
});

test("navigation interval refuses adapter operations with a structured stale target", async (t) => {
	const f = await setup(t);
	await f.session.prompt("first question");
	await f.adapter.submit(input(f));
	await f.ingress.joinPendingOperations();
	const user = f.session.sessionManager
		.getBranch()
		.find((entry) => entry.type === "message" && entry.message.role === "user");
	const entered = deferred();
	const release = deferred();
	t.after(() => release.resolve());
	const before = f.ingress.beforeBranchChange.bind(f.ingress);
	f.ingress.beforeBranchChange = async () => {
		entered.resolve();
		await release.promise;
		return before();
	};
	const navigation = f.session.navigateTree(user.id);
	try {
		await entered.promise;
		const count = f.sent.length;
		await assert.rejects(f.adapter.bind(), { code: "stale-target" });
		await assert.rejects(lookup(f, "one"), { code: "stale-target" });
		await assert.rejects(f.adapter.submit(input(f, "during-navigation")), { code: "stale-target" });
		assert.equal(f.sent.length, count);
		assert.equal((await externalRecords(f)).length, 1);
	} finally {
		release.resolve();
		await navigation;
	}
	const next = { ...f, binding: await f.adapter.bind() };
	await next.adapter.submit(input(next, "after-navigation"));
	await next.ingress.joinPendingOperations();
	assert.equal((await lookup(next, "after-navigation")).state, "consumed");
});

test("receipt listener and reporter failures preserve later records and other subscriptions", async (t) => {
	const errors = [];
	const f = await setup(t, {
		autoRelease: {
			onError(error) {
				errors.push(error);
				throw Error("reporter failed");
			},
		},
	});
	for (const id of ["one", "two"]) {
		await f.adapter.submit(input(f, id));
		await f.ingress.joinPendingOperations();
	}
	const throwing = new Set();
	const observing = new Set();
	const stopThrowing = f.adapter.subscribe((receipt) => {
		throwing.add(receipt.messageId);
		throw Error("receipt listener failed");
	});
	const stopObserving = f.adapter.subscribe((receipt) => observing.add(receipt.messageId));
	try {
		await until(
			() => throwing.size === 2 && observing.size === 2,
			"receipt failure skipped a snapshot record or subscription",
		);
		assert.ok(errors.length >= 2);
		assert.ok(errors.every((error) => error.message === "receipt listener failed"));
		await tick();
	} finally {
		stopThrowing();
		stopObserving();
	}
});

test("receipt publication contains a throwing reporter after authorization fails", async (t) => {
	const reported = deferred();
	const f = await setup(t, {
		autoRelease: {
			onError(error) {
				reported.resolve(error);
				throw Error("reporter failed");
			},
		},
	});
	const authorize = f.ingress.external.authorize;
	f.ingress.external.authorize = async () => {
		throw Error("receipt authorization failed");
	};
	const stop = f.adapter.subscribe(() => assert.fail("unauthorized snapshot was published"));
	try {
		assert.equal((await reported.promise).message, "receipt authorization failed");
		await tick();
	} finally {
		stop();
		f.ingress.external.authorize = authorize;
	}
});

test("restart retry reattaches only an undispatched callback and preserves consumed deduplication", async (t) => {
	const first = await setup(t, { admit: async () => false });
	assert.equal((await first.adapter.submit(input(first))).state, "held");
	const path = first.session.sessionManager.getSessionFile();
	await first.ingress.dispose();
	const reopen = async () => {
		const f = await fixture(t, { root: first.root, agentDir: first.agentDir, manager: SessionManager.open(path) });
		const adapter = await f.session._flowBinding.registerUserInputAdapter(first.extensionId, {
			id: "fixture",
			label: "Fixture",
		});
		return { ...f, adapter, binding: await adapter.bind() };
	};
	const second = await reopen();
	assert.equal(second.binding.target, first.binding.target);
	assert.notEqual(second.binding.generation, first.binding.generation);
	assert.equal((await lookup(second, "one")).state, "unknown");
	await second.adapter.submit(input(second));
	await second.ingress.joinPendingOperations();
	assert.equal((await lookup(second, "one")).state, "consumed");
	assert.equal(second.sent.length, 1);
	await second.ingress.dispose();
	const third = await reopen();
	assert.equal((await third.adapter.submit(input(third))).state, "consumed");
	assert.equal(third.sent.length, 0);
});

for (const action of ["transform", "handled"]) {
	test(`external input handler ${action} preserves receipt identity`, async (t) => {
		const f = await setup(t, {
			extensions: [
				(pi) =>
					pi.on("input", async () => (action === "transform" ? { action, text: "transformed text" } : { action })),
			],
		});
		await f.adapter.submit(input(f));
		await f.ingress.joinPendingOperations();
		const receipt = await lookup(f, "one");
		assert.equal(receipt.messageId, "one");
		assert.equal(receipt.state, action === "transform" ? "consumed" : "rejected");
		assert.equal(f.sent.length, action === "transform" ? 1 : 0);
		if (action === "handled") assert.equal(receipt.reason.code, "handled-without-input");
		else assert.match(JSON.stringify(f.sent), /transformed text/);
	});
}

test("normal appends preserve bindings while branch navigation fences them", async (t) => {
	const f = await setup(t);
	await f.session.prompt("first question");
	assert.deepEqual(await f.adapter.bind(), f.binding);
	await f.adapter.submit(input(f));
	await f.ingress.joinPendingOperations();
	const user = f.session.sessionManager
		.getBranch()
		.find((entry) => entry.type === "message" && entry.message.role === "user");
	await f.session.navigateTree(user.id);
	await assert.rejects(f.adapter.submit(input(f, "stale")), { code: "stale-target" });
	await assert.rejects(lookup(f, "one"), { code: "target-unavailable" });
	const next = { ...f, binding: await f.adapter.bind() };
	assert.notEqual(next.binding.target, f.binding.target);
	await next.adapter.submit(input(next, "new-action"));
	await next.ingress.joinPendingOperations();
	assert.equal((await lookup(next, "new-action")).state, "consumed");
	assert.equal(f.sent.length, 3);
});

test("archived consumed input keeps lookup and duplicate protection", async (t) => {
	const f = await setup(t);
	await f.adapter.submit(input(f));
	await f.ingress.joinPendingOperations();
	const store = f.ingress.branch().attachment.submissions;
	const [record] = await externalRecords(f);
	await store.archiveHandled([{ id: record.id, revision: record.revision }]);
	assert.equal((await lookup(f, "one")).state, "consumed");
	assert.equal((await f.adapter.submit(input(f))).state, "consumed");
	await f.ingress.joinPendingOperations();
	assert.equal(f.sent.length, 1);
});

test("idle capture held until streaming uses live queue state", async (t) => {
	let allowed = false;
	const gate = deferred();
	t.after(() => gate.resolve());
	let requests = 0;
	const f = await setup(t, {
		provider: true,
		admit: async (submission) => !submission.externalUser || allowed,
		onRequest: async () => {
			if (++requests === 1) await gate.promise;
		},
	});
	assert.equal((await f.adapter.submit(input(f, "held", "queued after idle capture", "steer"))).state, "held");
	const turn = f.session.prompt("start native turn");
	await until(() => f.sent.length === 1, "native turn did not start");
	allowed = true;
	const [held] = await externalRecords(f);
	await f.ingress.release(held.id, held.revision);
	assert.equal((await lookup(f, "held")).state, "queued");
	assert.equal(f.sent.length, 1);
	gate.resolve();
	await turn;
	await f.ingress.joinPendingOperations();
	assert.equal((await lookup(f, "held")).state, "consumed");
	assert.equal(f.sent.length, 2);
});

test("authorization that outlives a typed turn queues external input without losing its callback", async (t) => {
	let allowed = false;
	const authorizing = deferred();
	const authorized = deferred();
	const streaming = deferred();
	const finish = deferred();
	t.after(() => {
		authorized.resolve();
		finish.resolve();
	});
	const f = await setup(t, {
		provider: true,
		admit: async (submission) => !submission.externalUser || allowed,
		onRequest: async () => {
			streaming.resolve();
			await finish.promise;
		},
	});
	assert.equal((await f.adapter.submit(input(f))).state, "held");
	const [record] = await externalRecords(f);
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
	let parked = false;
	const authorize = f.ingress.external.authorize.bind(f.ingress.external);
	t.mock.method(f.ingress.external, "authorize", async (...args) => {
		const grant = await authorize(...args);
		if (!admitting && !parked && f.ingress.pending.get(record.id)?.running) {
			parked = true;
			authorizing.resolve();
			await authorized.promise;
		}
		return grant;
	});
	allowed = true;
	const releasing = f.ingress.release(record.id, record.revision);
	await authorizing.promise;
	const turn = f.session.prompt("typed input takes the host");
	await streaming.promise;
	authorized.resolve();
	try {
		assert.equal(await releasing, true);
		assert.equal((await lookup(f, "one")).state, "queued");
		assert.equal(f.sent.length, 1);
	} finally {
		finish.resolve();
		await turn;
	}
	await f.ingress.joinPendingOperations();
	assert.equal((await lookup(f, "one")).state, "consumed");
	assert.equal(f.sent.length, 2);
	assert.equal((await f.adapter.submit(input(f))).state, "consumed");
	assert.equal(f.sent.length, 2);
});

test("reload from external admission refuses before joining its own drain or replacing the runtime", async (t) => {
	let refusal;
	let drains = 0;
	const f = await setup(t, {
		admit: async (submission) => {
			if (!submission.externalUser) return true;
			const drain = f.ingress.external.drain;
			// Fail rather than hang if reload tries to await the admission operation invoking it.
			f.ingress.external.drain = async () => {
				drains++;
				throw Error("reload joined its own admission");
			};
			try {
				await f.session.reload();
			} catch (error) {
				refusal = error.code;
			} finally {
				f.ingress.external.drain = drain;
			}
			return true;
		},
	});
	const runner = f.session.extensionRunner;
	await f.adapter.submit(input(f));
	await f.ingress.joinPendingOperations();
	assert.equal(refusal, "busy");
	assert.equal(drains, 0);
	assert.equal(f.session.extensionRunner, runner);
	assert.equal((await lookup(f, "one")).state, "consumed");
});

test("suspension from external admission refuses before changing state or joining its own drain", async (t) => {
	let refusal;
	let drains = 0;
	const f = await setup(t, {
		admit: async (submission) => {
			if (!submission.externalUser) return true;
			const drain = f.ingress.external.drain;
			f.ingress.external.drain = async () => {
				drains++;
				throw Error("suspension joined its own admission");
			};
			try {
				await f.ingress.suspend();
			} catch (error) {
				refusal = error.code;
			} finally {
				f.ingress.external.drain = drain;
			}
			return true;
		},
	});
	await f.adapter.submit(input(f));
	await f.ingress.joinPendingOperations();
	assert.equal(refusal, "busy");
	assert.equal(drains, 0);
	assert.equal(f.ingress.enabled(), true);
	assert.equal((await lookup(f, "one")).state, "consumed");
	await f.adapter.submit(input(f, "two"));
	await f.ingress.joinPendingOperations();
	assert.equal((await lookup(f, "two")).state, "consumed");
});

test("overlapping resets share the pre-reset drain and keep admission closed until both finish", async (t) => {
	const f = await setup(t);
	const registry = f.ingress.external;
	const gate = deferred();
	const entered = deferred();
	const pending = registry.serial(async () => {
		entered.resolve();
		await gate.promise;
	});
	await entered.promise;
	const first = registry.beginReset();
	let secondReady = false;
	const second = registry.beginReset().then(() => {
		secondReady = true;
	});
	try {
		await tick();
		assert.equal(secondReady, false, "the second reset skipped the in-flight admission drain");
		gate.resolve();
		await Promise.all([pending, first, second]);
		let admitted = false;
		const next = registry.serial(async () => {
			admitted = true;
		});
		registry.endReset();
		await tick();
		assert.equal(admitted, false, "the first reset reopened admission while the second still owned it");
		registry.endReset();
		await next;
		assert.equal(admitted, true);
	} finally {
		gate.resolve();
		registry.endReset();
		registry.endReset();
		await Promise.all([pending, first, second]);
	}
	await f.adapter.submit(input(f));
	await f.ingress.joinPendingOperations();
	assert.equal((await lookup(f, "one")).state, "consumed");
});

test("revocation after admission does not create an undispatched user-work claim", async (t) => {
	let allowed = false;
	const f = await setup(t, {
		admit: async (submission) => {
			if (!submission.externalUser) return true;
			if (allowed) await f.revoke();
			return allowed;
		},
	});
	assert.equal((await f.adapter.submit(input(f))).state, "held");
	const [record] = await externalRecords(f);
	allowed = true;
	assert.equal(await f.ingress.release(record.id, record.revision), false);
	const branch = f.ingress.branch();
	assert.equal((await branch.attachment.submissions.forIds([record.id]))[0].status, "cancelled");
	assert.equal(
		(await branch.attachment.waits.authoritySnapshot()).work.some((work) =>
			work.userInputs?.some((source) => source.id === record.id),
		),
		false,
	);
});

test("a held release followed by reload and reattachment leaves no older user-work claim", async (t) => {
	let allowed = false;
	const f = await setup(t, { admit: async (submission) => !submission.externalUser || allowed });
	assert.equal((await f.adapter.submit(input(f))).state, "held");
	const [record] = await externalRecords(f);
	allowed = true;
	const branch = f.ingress.branch();
	await branch.workContext.run(undefined, async () => {
		assert.equal(await f.ingress.release(record.id, record.revision), false);
		await f.session.reload();
	});
	const adapter = await f.register();
	const binding = await adapter.bind();
	await adapter.submit({ ...input(f), binding });
	await f.ingress.joinPendingOperations();
	assert.equal((await adapter.lookup({ target: binding.target, messageId: "one" })).state, "consumed");
	const current = (await externalRecords(f)).find((item) => item.id === record.id);
	assert.ok(current.revision > record.revision);
	const claims = (await branch.attachment.waits.authoritySnapshot()).work.filter((work) =>
		work.userInputs?.some((source) => source.id === record.id),
	);
	assert.equal(claims.length, 1);
	assert.deepEqual(claims[0].userInputs, [{ id: record.id, revision: current.revision }]);
	assert.equal(f.sent.length, 1);
});

test("provider failure after native consumption never permits a duplicate dispatch", async (t) => {
	const f = await setup(t, { provider: true, response: () => new Response("unavailable", { status: 503 }) });
	await f.adapter.submit(input(f));
	await f.ingress.joinPendingOperations();
	assert.equal((await lookup(f, "one")).state, "consumed");
	assert.equal((await f.adapter.submit(input(f))).state, "consumed");
	await f.ingress.joinPendingOperations();
	assert.equal(f.sent.length, 1);
});

test("external input owns user work with the configured participants", async (t) => {
	const f = await setup(t, { provider: true, userWorkParticipants: ["bg"] });
	await f.adapter.submit(input(f));
	await f.ingress.joinPendingOperations();
	const authority = await f.ingress.branch().attachment.waits.authoritySnapshot();
	const work = authority.work.filter((item) => item.owner === "host-user");
	assert.equal(work.length, 1);
	assert.deepEqual(work[0].participants, ["host-user", "bg"]);
});

test("exact native queue cancellation is terminal for external input", async (t) => {
	const gate = deferred();
	t.after(() => gate.resolve());
	const f = await setup(t, { provider: true, onRequest: async () => gate.promise });
	const turn = f.session.prompt("keep running");
	await until(() => f.sent.length === 1, "native turn did not start");
	await f.adapter.submit(input(f));
	await until(
		async () => (await lookup(f, "one")).state === "queued",
		"the external input was never observed in the native queue",
	);
	const [item] = f.session.agent.inspectQueuedMessages();
	await f.ingress.branch().native.cancelQueue(item.id, item.revision);
	gate.resolve();
	await turn;
	await f.ingress.joinPendingOperations();
	assert.equal((await lookup(f, "one")).state, "cancelled");
	assert.equal((await f.adapter.submit(input(f))).state, "cancelled");
	assert.equal(f.sent.length, 1);
});

test("suspending a running turn preserves queued input evidence without joining the provider", async (t) => {
	const gate = deferred();
	t.after(() => gate.resolve());
	const f = await setup(t, { provider: true, onRequest: async () => gate.promise });
	const turn = f.session.prompt("keep running");
	await until(() => f.sent.length === 1, "native turn did not start");
	await f.adapter.submit(input(f));
	await until(
		async () => (await lookup(f, "one")).state === "queued",
		"the input was never observed in the native queue",
	);
	await f.ingress.suspend();
	assert.equal((await lookup(f, "one")).state, "queued");
	await assert.rejects(f.adapter.submit(input(f, "blocked")), { code: "flow-suspended" });
	gate.resolve();
	await turn;
	await f.ingress.joinPendingOperations();
	assert.equal((await lookup(f, "one")).state, "consumed");
	await f.ingress.resume();
	assert.equal((await f.adapter.submit(input(f))).state, "consumed");
	assert.equal(f.sent.length, 2);
});

test("simultaneous same-ID submissions keep one native delivery", async (t) => {
	const f = await setup(t);
	await Promise.all([f.adapter.submit(input(f)), f.adapter.submit(input(f))]);
	await f.ingress.joinPendingOperations();
	assert.equal(f.sent.length, 1);
});

test("held external input is cancelled on suspension, while registration remains usable on resume", async (t) => {
	const f = await setup(t, { admit: async () => false });
	assert.equal((await f.adapter.submit(input(f))).state, "held");
	await f.ingress.suspend();
	const receipt = await f.adapter.lookup({ target: f.binding.target, messageId: "one" });
	assert.equal(receipt.state, "cancelled");
	assert.equal(receipt.reason.code, "flow-suspended");
	await assert.rejects(f.adapter.submit(input(f, "two")), { code: "flow-suspended" });
	await f.ingress.resume();
	assert.equal((await f.adapter.submit(input(f, "two"))).state, "held");
	assert.equal(f.sent.length, 0);
});

test("stale binding and grant revocation refuse input before dispatch", async (t) => {
	const f = await setup(t);
	await assert.rejects(f.adapter.submit({ ...input(f), binding: { ...f.binding, generation: "stale" } }), {
		code: "stale-target",
	});
	await f.revoke();
	await assert.rejects(f.adapter.submit(input(f)), { code: "unauthorized" });
	assert.equal(f.sent.length, 0);
});

test("flow and about command text remain literal external input", async (t) => {
	const f = await setup(t);
	await f.adapter.submit(input(f, "flow", "/flow reset confirm"));
	await f.ingress.joinPendingOperations();
	await f.adapter.submit(input(f, "about", "/about"));
	await f.ingress.joinPendingOperations();
	assert.equal(f.sent.length, 2);
	for (const id of ["flow", "about"])
		assert.equal((await f.adapter.lookup({ target: f.binding.target, messageId: id })).state, "consumed");
});

test("submit returns while the provider is blocked and the tracked execution is joined later", async (t) => {
	const entered = deferred(),
		release = deferred();
	let completed = false;
	const f = await setup(t, {
		provider: true,
		onRequest: async () => {
			entered.resolve();
			await release.promise;
			completed = true;
		},
	});
	// Retention and initial admission settle here; model execution is owned by the ingress and still
	// running, so this resolves before the provider request can finish.
	const receipt = await f.adapter.submit(input(f));
	assert.equal(receipt.version, 1);
	assert.equal(receipt.adapterId, "fixture");
	assert.equal(receipt.messageId, "one");
	assert.equal(receipt.target, f.binding.target);
	assert.ok(Number.isSafeInteger(receipt.revision) && receipt.revision > 0);
	// A receipt reports a disposition only: it never echoes the message text back.
	assert.ok(!JSON.stringify(receipt).includes("external instruction"));
	assert.ok(!["rejected", "cancelled"].includes(receipt.state), `unexpected receipt state ${receipt.state}`);
	assert.equal(completed, false);
	await entered.promise;
	assert.equal(f.sent.length, 1);
	assert.equal(completed, false);
	// Native delivery is already proved while the model turn is still blocked.
	assert.equal((await lookup(f, "one")).state, "consumed");
	let joined = false;
	const joining = f.ingress.joinPendingOperations().then(() => {
		joined = true;
	});
	await tick();
	await tick();
	assert.equal(joined, false);
	release.resolve();
	await joining;
	assert.equal(completed, true);
	assert.equal(f.sent.length, 1);
	assert.equal((await lookup(f, "one")).state, "consumed");
});

test("held external input dispatches once admission policy allows", async (t) => {
	let allow = false;
	const f = await setup(t, { admit: async () => allow });
	assert.equal((await f.adapter.submit(input(f))).state, "held");
	allow = true;
	const result = await f.ingress.releaseReady();
	assert.equal(result.released.length, 1);
	assert.equal(result.held.length, 0);
	await f.ingress.joinPendingOperations();
	assert.equal(f.sent.length, 1);
	assert.equal((await lookup(f, "one")).state, "consumed");
});

test("a grant revoked while input is held cancels it instead of dispatching", async (t) => {
	// The case above is the control: this same release path dispatches while the grant is valid.
	let allow = false;
	const f = await setup(t, { admit: async () => allow });
	const held = await f.adapter.submit(input(f));
	assert.equal(held.state, "held");
	assert.equal(held.reason.code, "admission-hold");
	assert.equal(f.sent.length, 0);
	await f.revoke();
	// Admission would now pass, so only the revoked grant can keep the input from the host.
	allow = true;
	assert.deepEqual(await f.ingress.releaseReady(), { released: [], held: [] });
	assert.equal(f.sent.length, 0);
	const [record] = await externalRecords(f);
	assert.equal(record.status, "cancelled");
	assert.equal(record.cancellationReason, "unauthorized");
	assert.equal(record.dispatch, undefined);
	// A cancelled input must not leave user work that gates every later automated send.
	const authority = await f.ingress.branch().attachment.waits.authoritySnapshot();
	assert.deepEqual(
		authority.work.filter((work) => work.owner === "host-user"),
		[],
	);
	await assert.rejects(lookup(f, "one"), { code: "unauthorized" });
	await f.ingress.joinPendingOperations();
	assert.equal(f.sent.length, 0);
});

test("streaming steer and followUp queue by exact revision and are consumed in order", async (t) => {
	const gates = [deferred(), deferred()];
	let requests = 0;
	const f = await setup(t, {
		provider: true,
		onRequest: async () => {
			await gates[requests++]?.promise;
		},
	});
	// A failing assertion must not leave a provider request parked, or cleanup waits for the turn.
	t.after(() => {
		gates[0].resolve();
		gates[1].resolve();
	});
	const turn = f.session.prompt("hold the turn open");
	await until(() => f.sent.length === 1, "the first provider request did not start");
	await f.adapter.submit(input(f, "steer", "steer now", "steer"));
	await f.adapter.submit(input(f, "later", "follow up now", "followUp"));
	await until(
		async () => (await lookup(f, "steer")).state === "queued",
		"the steer was never observed in the native queue",
	);
	const queuedSteer = await lookup(f, "steer");
	assert.equal(queuedSteer.reason, undefined);
	// Each submission is admitted and dispatched independently, so the later follow-up can still be
	// inside its authorization read here. Its receipt is then unconfirmed rather than queued until the
	// native queue observes it, which is a state the host reaches without another event.
	await until(
		async () => (await lookup(f, "later")).state === "queued",
		"the follow-up was never observed in the native queue",
	);
	assert.equal(f.sent.length, 1);
	// A retry of a queued message returns its receipt and adds no second queue item.
	assert.equal((await f.adapter.submit(input(f, "steer", "steer now", "steer"))).state, "queued");
	assert.equal(f.session.agent.inspectQueuedMessages().length, 2);
	gates[0].resolve();
	await until(() => f.sent.length === 2, "the queued steer was never claimed into a second request");
	assert.equal((await lookup(f, "steer")).state, "consumed");
	// Consumption is per exact queue identity, so the later follow-up is still only queued.
	assert.equal((await lookup(f, "later")).state, "queued");
	gates[1].resolve();
	await turn;
	await until(() => f.sent.length === 3, "the queued follow-up was never claimed into a third request");
	assert.equal((await lookup(f, "steer")).state, "consumed");
	assert.equal((await lookup(f, "later")).state, "consumed");
	// Consumed stays consumed: a retry reports the receipt and never dispatches again.
	const consumedSteer = await f.adapter.submit(input(f, "steer", "steer now", "steer"));
	assert.equal(consumedSteer.state, "consumed");
	assert.equal(consumedSteer.reason, undefined);
	await f.ingress.joinPendingOperations();
	assert.equal(f.sent.length, 3);
	const bodies = f.sent.map((messages) => JSON.stringify(messages));
	assert.ok(!bodies[0].includes("steer now"));
	assert.ok(bodies[1].includes("steer now"));
	assert.ok(!bodies[1].includes("follow up now"));
	assert.ok(bodies[2].includes("follow up now"));
});

test("a follow-up still authorizing reports an unconfirmed receipt and queues once authorized", async (t) => {
	const entered = deferred();
	const gate = deferred();
	const held = deferred();
	t.after(() => {
		gate.resolve();
		held.resolve();
	});
	const f = await setup(t, { provider: true, onRequest: async () => held.promise });
	const authorize = f.ingress.authorizeExternal.bind(f.ingress);
	// Hold the follow-up's own dispatch inside the authority read that precedes native input.
	t.mock.method(f.ingress, "authorizeExternal", async (submission, epoch) => {
		if (submission.externalUser?.messageId === "later") {
			entered.resolve();
			await gate.promise;
		}
		return authorize(submission, epoch);
	});
	const turn = f.session.prompt("hold the turn open");
	await until(() => f.sent.length === 1, "the first provider request did not start");
	await f.adapter.submit(input(f, "steer", "steer now", "steer"));
	const submitting = f.adapter.submit(input(f, "later", "follow up now", "followUp"));
	await entered.promise;
	// Dispatch intent exists but no native input is observed yet, so the receipt must not claim the
	// queue position it is about to take. It resolves once authorization returns and the host queues it.
	const parked = await lookup(f, "later");
	assert.equal(parked.state, "unknown");
	assert.equal(parked.reason.code, "dispatch-unconfirmed");
	gate.resolve();
	await submitting;
	await until(
		async () => (await lookup(f, "later")).state === "queued",
		"the authorized follow-up was never observed in the native queue",
	);
	held.resolve();
	await turn.catch(() => {});
	await f.ingress.joinPendingOperations().catch(() => {});
});

test("subscriptions deliver a current snapshot, ordered updates, and survive a throwing listener", async (t) => {
	const f = await setup(t);
	const seen = [];
	let thrown = 0;
	const unsubscribeThrower = f.adapter.subscribe(() => {
		thrown++;
		throw new Error("listener failure");
	});
	const unsubscribe = f.adapter.subscribe((receipt) => seen.push(receipt));
	try {
		await f.adapter.submit(input(f, "one"));
		await until(
			() => seen.some((receipt) => receipt.messageId === "one" && receipt.state === "consumed"),
			"the consumed receipt for the first message was never published",
		);
		await f.adapter.submit(input(f, "two"));
		await until(
			() => seen.some((receipt) => receipt.messageId === "two" && receipt.state === "consumed"),
			"the consumed receipt for the second message was never published",
		);
		// A throwing listener is contained: delivery is unaffected and later publishes still arrive.
		assert.ok(thrown >= 2, `the throwing listener was published ${thrown} times`);
		await until(() => f.sent.length === 2, "the second model request did not start");
		for (const id of ["one", "two"]) {
			const revisions = seen.filter((receipt) => receipt.messageId === id).map((receipt) => receipt.revision);
			assert.deepEqual(
				revisions,
				[...revisions].sort((left, right) => left - right),
			);
			assert.ok(revisions.length >= 1);
		}
		// Subscribing now reports the current state, so a listener cannot miss what already happened.
		const snapshot = [];
		const stop = f.adapter.subscribe((receipt) => snapshot.push(receipt));
		await until(() => snapshot.length >= 2, "the current receipt snapshot was never published");
		assert.deepEqual(
			snapshot.slice(0, 2).map((receipt) => [receipt.messageId, receipt.state]),
			[
				["one", "consumed"],
				["two", "consumed"],
			],
		);
		stop();
		const delivered = snapshot.length;
		await f.adapter.submit(input(f, "three"));
		await f.ingress.joinPendingOperations();
		await tick();
		assert.equal(snapshot.length, delivered);
	} finally {
		unsubscribe();
		unsubscribeThrower();
	}
});

test("invalid external input leaves the automation pause and the journal unchanged", async (t) => {
	const f = await setup(t);
	f.ingress.pauseAutomated("reopened");
	const rejected = [
		["empty text", { ...input(f), text: "" }],
		["blank text", { ...input(f), text: " \n\t " }],
		["oversized text", { ...input(f), text: "x".repeat(32769) }],
		["non-string text", { ...input(f), text: 42 }],
		["invalid UTF-8 text", { ...input(f), text: "\ud800" }],
		["unknown delivery mode", { ...input(f), deliverAs: "nextTurn" }],
		["missing delivery mode", { ...input(f), deliverAs: undefined }],
		["unbounded message ID", { ...input(f), messageId: "a".repeat(257) }],
		["non-string message ID", { ...input(f), messageId: 7 }],
		["forged provenance", { ...input(f), externalUser: { version: 1, adapterId: "fixture", messageId: "one" } }],
		["unknown field", { ...input(f), source: "user" }],
		["missing binding", { messageId: "one", text: "external instruction", deliverAs: "followUp" }],
		["unknown binding field", { ...input(f), binding: { ...f.binding, extra: true } }],
	];
	for (const [label, payload] of rejected)
		await assert.rejects(f.adapter.submit(payload), { code: "invalid-input" }, label);
	// A stale target and a revoked grant are refused on the same side of retention.
	await assert.rejects(f.adapter.submit({ ...input(f), binding: { ...f.binding, generation: "stale" } }), {
		code: "stale-target",
	});
	await assert.rejects(f.adapter.submit({ ...input(f), binding: { ...f.binding, target: "a".repeat(64) } }), {
		code: "stale-target",
	});
	await f.revoke();
	await assert.rejects(f.adapter.submit(input(f)), { code: "unauthorized" });
	await f.restore();
	// Nothing was retained, so nothing can be looked up, dispatched, or clear the hold.
	assert.equal(f.ingress.automatedPause(), "reopened");
	assert.deepEqual(await externalRecords(f), []);
	assert.equal(f.sent.length, 0);
	assert.equal(await lookup(f, "one"), undefined);
	// The pause is still live rather than inert: the next authorized submission clears it.
	await f.adapter.submit(input(f));
	assert.equal(f.ingress.automatedPause(), undefined);
	await f.ingress.joinPendingOperations();
	assert.equal(f.sent.length, 1);
	assert.equal((await lookup(f, "one")).state, "consumed");
});

test("an extension reload ends held input before dispatch so an explicit retry reattaches", async (t) => {
	let allow = false;
	const f = await setup(t, { admit: async () => allow });
	assert.equal((await f.adapter.submit(input(f))).state, "held");
	await f.session.reload();
	// The replaced runtime cannot dispatch its prepared callback, so the record keeps no dispatch intent.
	const [ended] = await externalRecords(f);
	assert.equal(ended.unavailable, "callback-ended");
	assert.equal(ended.dispatch, undefined);
	// The replacement runtime registers and binds the same target, then retries the original ID.
	const adapter = await f.session._flowBinding.registerUserInputAdapter(f.extensionId, {
		id: "fixture",
		label: "Fixture",
	});
	const binding = await adapter.bind();
	assert.equal(binding.target, f.binding.target);
	assert.equal((await adapter.lookup({ target: binding.target, messageId: "one" })).state, "unknown");
	allow = true;
	const retried = await adapter.submit({
		binding,
		messageId: "one",
		text: "external instruction",
		deliverAs: "followUp",
	});
	assert.notEqual(retried.state, "held");
	await f.ingress.joinPendingOperations();
	assert.equal((await adapter.lookup({ target: binding.target, messageId: "one" })).state, "consumed");
	assert.equal(f.sent.length, 1);
});

test("input submitted during the settled event keeps its receipt identity", async (t) => {
	const entered = deferred();
	const gate = deferred();
	t.after(() => gate.resolve());
	let held = false;
	const f = await setup(t, {
		extensions: [
			(pi) =>
				pi.on("agent_settled", async () => {
					if (held) return;
					held = true;
					entered.resolve();
					await gate.promise;
				}),
		],
	});
	// A custom-message turn holds no user work, so external input can dispatch while it settles.
	const first = f.session.sendCustomMessage(
		{ customType: "fixture", content: "start", display: false },
		{ triggerTurn: true },
	);
	await entered.promise;
	// Submit settles after durable admission, not after asynchronous work registration or dispatch.
	// Keep the settled event parked until the native send has actually reached its deferral boundary.
	await f.adapter.submit(input(f));
	await until(async () => (await lookup(f, "one")).state === "unknown", "native settled deferral was never recorded");
	assert.equal((await lookup(f, "one")).state, "unknown");
	gate.resolve();
	await first;
	await f.ingress.joinPendingOperations();
	const receipt = await lookup(f, "one");
	assert.equal(receipt.state, "consumed");
	assert.equal(receipt.reason, undefined);
	// The deferred send stays owned by the retained record instead of becoming a host submission.
	const records = await f.ingress.branch().attachment.submissions.snapshot();
	assert.equal(
		records.filter(
			(record) =>
				!record.submission.externalUser && JSON.stringify(record.submission.args).includes("external instruction"),
		).length,
		0,
	);
	assert.equal(f.sent.filter((messages) => JSON.stringify(messages).includes("external instruction")).length, 1);
});

test("a revoked queued entry is removed exactly and does not hold later input", async (t) => {
	const gate = deferred();
	t.after(() => gate.resolve());
	const f = await setup(t, { provider: true, onRequest: async () => gate.promise });
	const turn = f.session.prompt("keep running");
	await until(() => f.sent.length === 1, "the first provider request did not start");
	await f.adapter.submit(input(f, "revoked", "revoked instruction", "followUp"));
	await until(
		async () => (await lookup(f, "revoked")).state === "queued",
		"the revoked input was never observed in the native queue",
	);
	await f.revoke();
	gate.resolve();
	await turn;
	await f.ingress.joinPendingOperations();
	// The revoked entry no longer heads the native queue, so it cannot be re-offered on every drain.
	assert.deepEqual(f.session.agent.inspectQueuedMessages(), []);
	await f.restore();
	const receipt = await lookup(f, "revoked");
	assert.equal(receipt.state, "cancelled");
	assert.equal(receipt.reason.code, "queue-cancelled");
	assert.equal((await f.adapter.submit(input(f, "revoked", "revoked instruction", "followUp"))).state, "cancelled");
	await f.adapter.submit(input(f, "after", "later instruction", "followUp"));
	await f.ingress.joinPendingOperations();
	assert.equal((await lookup(f, "after")).state, "consumed");
	assert.equal(f.sent.length, 2);
	assert.ok(!JSON.stringify(f.sent).includes("revoked instruction"));
});

test("flow reset withdraws the published target and the next bind accepts new input", async (t) => {
	const f = await setup(t);
	let invalidated = 0;
	const stop = f.adapter.onTargetInvalidated(() => invalidated++);
	try {
		await f.ingress.resetFlow();
		assert.equal(invalidated, 1);
		// The old target cannot be submitted or looked up, and the same adapter binds the new one.
		await assert.rejects(f.adapter.submit(input(f, "old")), { code: "stale-target" });
		await assert.rejects(lookup(f, "old"), { code: "target-unavailable" });
		const binding = await f.adapter.bind();
		assert.notEqual(binding.target, f.binding.target);
		const next = { ...f, binding };
		await next.adapter.submit(input(next, "new"));
		await f.ingress.joinPendingOperations();
		assert.equal((await lookup(next, "new")).state, "consumed");
		assert.equal(f.sent.length, 1);
	} finally {
		stop();
	}
});

test("a duplicate live registration is refused and the first handle keeps its listener", async (t) => {
	const f = await setup(t);
	let invalidated = 0;
	const stop = f.adapter.onTargetInvalidated(() => invalidated++);
	try {
		await assert.rejects(f.register({ label: "Second handle" }), { code: "adapter-already-registered" });
		// The refusal left the first registration intact: it still binds the published target.
		assert.deepEqual(await f.adapter.bind(), f.binding);
		await f.ingress.resetFlow();
		// The listener that a replacing registration used to make unreachable still receives the reset.
		assert.equal(invalidated, 1, "the surviving registration lost its target listener");
		await assert.rejects(f.adapter.submit(input(f, "old")), { code: "stale-target" });
		assert.equal(f.sent.length, 0, "a withdrawn target dispatched input");
		const binding = await f.adapter.bind();
		assert.notEqual(binding.target, f.binding.target);
		const next = { ...f, binding };
		await next.adapter.submit(input(next, "new"));
		await f.ingress.joinPendingOperations();
		assert.equal((await next.adapter.lookup({ target: binding.target, messageId: "new" })).state, "consumed");
		assert.equal(f.sent.length, 1);
	} finally {
		stop();
	}
});

test("concurrent duplicate registration admits exactly one handle", async (t) => {
	const f = await setup(t, { register: false });
	const gate = deferred();
	const entered = deferred();
	let parked = 0;
	const authorize = f.ingress.external.authorize.bind(f.ingress.external);
	t.mock.method(f.ingress.external, "authorize", async (...args) => {
		if (++parked === 1) entered.resolve();
		await gate.promise;
		return authorize(...args);
	});
	const attempts = [f.register({ label: "First" }), f.register({ label: "Second" })];
	await entered.promise;
	// Both grant reads are released together. The check and the insert after authorization are one
	// synchronous section, so exactly one attempt can take the identity.
	gate.resolve();
	const outcomes = await Promise.allSettled(attempts);
	const accepted = outcomes.filter((outcome) => outcome.status === "fulfilled");
	const refused = outcomes.filter((outcome) => outcome.status === "rejected");
	assert.equal(accepted.length, 1, "more than one concurrent registration was accepted");
	assert.equal(refused.length, 1);
	assert.equal(refused[0].reason.code, "adapter-already-registered");
	const survivor = accepted[0].value;
	const binding = await survivor.bind();
	assert.match(binding.target, /^[a-f0-9]{64}$/u);
	assert.deepEqual(await survivor.bind(), binding);
	let invalidated = 0;
	const stop = survivor.onTargetInvalidated(() => invalidated++);
	try {
		await f.ingress.resetFlow();
		assert.equal(invalidated, 1, "the accepted registration lost its target listener");
		await assert.rejects(f.register({ label: "Later" }), { code: "adapter-already-registered" });
	} finally {
		stop();
	}
});

test("distinct adapter IDs and extension identities register independently", async (t) => {
	const f = await setup(t);
	const otherPath = join(f.agentDir, "other-extension.ts");
	await writeFile(otherPath, "export default () => {};\n");
	const otherExtension = await realpath(otherPath);
	await f.writeGrants([
		{ extensionPath: f.extensionId, adapterId: "fixture" },
		{ extensionPath: f.extensionId, adapterId: "second" },
		{ extensionPath: otherExtension, adapterId: "fixture" },
	]);
	const second = await f.register({ id: "second", label: "Second" });
	// The same adapter ID from a separately authorized canonical extension identity is a different
	// registration, not a duplicate.
	const other = await f.register({ extensionId: otherExtension });
	const counts = [0, 0, 0];
	const stops = [
		f.adapter.onTargetInvalidated(() => counts[0]++),
		second.onTargetInvalidated(() => counts[1]++),
		other.onTargetInvalidated(() => counts[2]++),
	];
	try {
		await f.ingress.resetFlow();
		assert.deepEqual(counts, [1, 1, 1], "a distinct registration did not receive the reset");
	} finally {
		for (const stop of stops) stop();
	}
	// Each identity duplicates only itself.
	await assert.rejects(f.register(), { code: "adapter-already-registered" });
	await assert.rejects(f.register({ id: "second" }), { code: "adapter-already-registered" });
	await assert.rejects(f.register({ extensionId: otherExtension }), { code: "adapter-already-registered" });
});

test("a registration pending when its runtime ends cannot reserve the identity", async (t) => {
	const f = await setup(t);
	const gate = deferred();
	const entered = deferred();
	let parked = false;
	const authorize = f.ingress.external.authorize.bind(f.ingress.external);
	t.mock.method(f.ingress.external, "authorize", async (...args) => {
		if (!parked) {
			parked = true;
			entered.resolve();
			await gate.promise;
		}
		return authorize(...args);
	});
	const pending = f.register({ label: "Pending" });
	await entered.promise;
	// Registration cleanup runs before the host invalidates the old runtime, so host liveness alone
	// cannot fence this authorization: the registration lifetime has to.
	await f.ingress.endExtensionRuntime();
	gate.resolve();
	await assert.rejects(pending, { code: "stale-target" });
	// The ended runtime's handle is inert even though the host has not been invalidated yet.
	await assert.rejects(f.adapter.bind(), { code: "stale-target" });
	await assert.rejects(f.adapter.submit(input(f, "stale")), { code: "stale-target" });
	await assert.rejects(f.adapter.lookup({ target: f.binding.target, messageId: "stale" }), {
		code: "stale-target",
	});
	assert.throws(() => f.adapter.subscribe(() => {}), { code: "stale-target" });
	assert.throws(() => f.adapter.onTargetInvalidated(() => {}), { code: "stale-target" });
	assert.deepEqual(await externalRecords(f), []);
	// Retirement alone must not reopen registration on the still-live old runner.
	await assert.rejects(f.register({ label: "Old shutdown" }), { code: "stale-target" });
	await f.session.reload();
	// The actual replacement runtime registers the same identity and owns its listeners.
	const replacement = await f.register({ label: "Replacement" });
	let invalidated = 0;
	const stop = replacement.onTargetInvalidated(() => invalidated++);
	try {
		await f.ingress.resetFlow();
		assert.equal(invalidated, 1, "the replacement registration lost its target listener");
	} finally {
		stop();
	}
});

test("a registration released after its replacement registered leaves the replacement live", async (t) => {
	const f = await setup(t, { register: false });
	const gate = deferred();
	const entered = deferred();
	let parked = false;
	const authorize = f.ingress.external.authorize.bind(f.ingress.external);
	t.mock.method(f.ingress.external, "authorize", async (...args) => {
		if (!parked) {
			parked = true;
			entered.resolve();
			await gate.promise;
		}
		return authorize(...args);
	});
	const pending = f.register({ label: "Pending" });
	await entered.promise;
	await f.ingress.endExtensionRuntime();
	await f.session.reload();
	// The replacement takes the identity while the old authorization is still parked.
	const replacement = await f.register({ label: "Replacement" });
	let invalidated = 0;
	const stop = replacement.onTargetInvalidated(() => invalidated++);
	try {
		gate.resolve();
		await assert.rejects(pending, { code: "stale-target" });
		// The late authorization neither took the identity nor displaced the replacement.
		await assert.rejects(f.register({ label: "Third" }), { code: "adapter-already-registered" });
		await f.ingress.resetFlow();
		assert.equal(invalidated, 1, "the replacement registration lost its target listener");
	} finally {
		stop();
	}
});

test("a registration closed after authorization succeeded is refused by ownership", async (t) => {
	const f = await setup(t, { register: false });
	const entered = deferred();
	const gate = deferred();
	let authorized = false;
	const authorize = f.ingress.external.authorize.bind(f.ingress.external);
	// Park after the real grant decision resolves but before register receives its result, so this
	// call has already passed the registry's initial closed check when the registry closes.
	t.mock.method(f.ingress.external, "authorize", async (...args) => {
		const extensionPath = await authorize(...args);
		authorized = true;
		entered.resolve();
		await gate.promise;
		return extensionPath;
	});
	const pending = f.register({ label: "Pending" });
	await entered.promise;
	assert.equal(authorized, true, "the parked registration had not completed its grant read");
	// The registry closes while the native host attachment is still live, which is the state a
	// shutdown reaches before the host tears down its own scope.
	f.ingress.external.close();
	assert.doesNotThrow(() => f.session._flowBinding.assertActive(), "the native host scope was not live");
	gate.resolve();
	await assert.rejects(pending, { code: "stale-target" });
	// Nothing survived the close. The closed registry cannot be asked through its public API, so this
	// reads its own registration map: an entry here would be a registration the close did not fence.
	assert.equal(f.ingress.external.registrations.size, 0, "a registration survived the close");
	assert.deepEqual(await externalRecords(f), []);
	assert.equal(f.sent.length, 0, "a closed registry dispatched input");
	// A later attempt is refused by the closed registry before any authorization is read.
	await assert.rejects(f.register({ label: "Later" }), { code: "stale-target" });
});

test("one throwing target listener does not stop the other withdrawals", async (t) => {
	const errors = [];
	const f = await setup(t, { autoRelease: { onError: (error) => errors.push(error) } });
	await f.writeGrants([
		{ extensionPath: f.extensionId, adapterId: "fixture" },
		{ extensionPath: f.extensionId, adapterId: "second" },
	]);
	const second = await f.register({ id: "second", label: "Second" });
	let later = 0;
	let other = 0;
	let removed = 0;
	const stopThrower = f.adapter.onTargetInvalidated(() => {
		throw new Error("listener failure");
	});
	const stopLater = f.adapter.onTargetInvalidated(() => later++);
	const stopOther = second.onTargetInvalidated(() => other++);
	const stopRemoved = f.adapter.onTargetInvalidated(() => removed++);
	stopRemoved();
	try {
		await f.ingress.resetFlow();
		// The later listener on the same registration, the other registration, and the reset itself are
		// unaffected by the first listener's synchronous failure.
		assert.equal(later, 1, "a later listener on the same registration was skipped");
		assert.equal(other, 1, "another registration was not notified");
		assert.equal(removed, 0, "an unsubscribed listener was invoked");
		assert.equal(errors.length, 1);
		assert.match(errors[0].message, /listener failure/u);
		await assert.rejects(f.adapter.submit(input(f, "old")), { code: "stale-target" });
		assert.equal(f.sent.length, 0, "a withdrawn target dispatched input");
		const binding = await f.adapter.bind();
		const next = { ...f, binding };
		await next.adapter.submit(input(next, "new"));
		await f.ingress.joinPendingOperations();
		assert.equal((await next.adapter.lookup({ target: binding.target, messageId: "new" })).state, "consumed");
		assert.equal(f.sent.length, 1);
	} finally {
		stopThrower();
		stopLater();
		stopOther();
	}
});

test("a failing error report does not stop the remaining target withdrawals", async (t) => {
	let reports = 0;
	const f = await setup(t, {
		autoRelease: {
			onError: () => {
				reports++;
				throw new Error("error report failed");
			},
		},
	});
	// A second registration is invalidated after the first one's failing report, so a report that
	// interrupted the notification would leave it holding a withdrawn target.
	await f.writeGrants([
		{ extensionPath: f.extensionId, adapterId: "fixture" },
		{ extensionPath: f.extensionId, adapterId: "second" },
	]);
	const second = await f.register({ id: "second", label: "Second" });
	let later = 0;
	let other = 0;
	const stopThrower = f.adapter.onTargetInvalidated(() => {
		throw new Error("listener failure");
	});
	const stopLater = f.adapter.onTargetInvalidated(() => later++);
	const stopOther = second.onTargetInvalidated(() => other++);
	try {
		await f.ingress.resetFlow();
		assert.equal(later, 1, "a failing error report stopped the remaining withdrawals");
		assert.equal(other, 1, "another registration was skipped after a failing error report");
		assert.ok(reports >= 1, "the listener failure was never reported");
	} finally {
		stopThrower();
		stopLater();
		stopOther();
	}
});

test("a submission that enters admission after suspension began is refused before retention", async (t) => {
	const f = await setup(t);
	// Suspension lands while the submission waits behind the serialized admission chain.
	const [outcome] = await Promise.all([
		f.adapter.submit(input(f)).then(
			(receipt) => receipt,
			(error) => error,
		),
		f.ingress.suspend(),
	]);
	assert.equal(outcome.code, "flow-suspended");
	await f.ingress.joinPendingOperations();
	assert.deepEqual(await externalRecords(f), []);
	assert.equal(f.sent.length, 0);
	await f.ingress.resume();
	await f.adapter.submit(input(f));
	await f.ingress.joinPendingOperations();
	assert.equal((await lookup(f, "one")).state, "consumed");
});

test("registration and binding stay available while flow is suspended", async (t) => {
	// A live runtime holds one registration per adapter ID, so the first registration for this
	// identity happens while suspended instead of repeating the fixture's own registration.
	const f = await setup(t, { register: false });
	await f.ingress.suspend();
	const adapter = await f.register();
	const binding = await adapter.bind();
	await assert.rejects(
		adapter.submit({ binding, messageId: "one", text: "external instruction", deliverAs: "followUp" }),
		{
			code: "flow-suspended",
		},
	);
	assert.deepEqual(await externalRecords(f), []);
	await f.ingress.resume();
	// Suspension keeps the attachment, so the binding taken during it is the live target and the same
	// input is accepted unchanged afterwards.
	assert.deepEqual(await adapter.bind(), binding);
	await adapter.submit({ binding, messageId: "one", text: "external instruction", deliverAs: "followUp" });
	await f.ingress.joinPendingOperations();
	assert.equal((await adapter.lookup({ target: binding.target, messageId: "one" })).state, "consumed");
	assert.equal(f.sent.length, 1);
});

test("archived consumed evidence survives reopen for lookup and duplicate protection", async (t) => {
	const first = await setup(t);
	await first.adapter.submit(input(first));
	await first.ingress.joinPendingOperations();
	const [record] = await externalRecords(first);
	await first.ingress.branch().attachment.submissions.archiveHandled([{ id: record.id, revision: record.revision }]);
	const path = first.session.sessionManager.getSessionFile();
	await first.ingress.dispose();
	const second = await fixture(t, {
		root: first.root,
		agentDir: first.agentDir,
		manager: SessionManager.open(path),
	});
	const adapter = await second.session._flowBinding.registerUserInputAdapter(first.extensionId, {
		id: "fixture",
		label: "Fixture",
	});
	const reopened = { ...second, adapter, binding: await adapter.bind() };
	assert.equal(reopened.binding.target, first.binding.target);
	assert.equal((await lookup(reopened, "one")).state, "consumed");
	assert.equal((await adapter.submit(input(reopened))).state, "consumed");
	assert.equal(second.sent.length, 0);
});

test("a failed dispatch keeps its evidence across reopen instead of becoming reattachable", async (t) => {
	const first = await setup(t, { admit: async () => false });
	assert.equal((await first.adapter.submit(input(first))).state, "held");
	const [record] = await externalRecords(first);
	// A native dispatch that throws before returning is the one path that records a failed dispatch
	// without consuming input. Reaching it through the adapter needs a host failure the fixture cannot
	// inject deterministically, so this drives the same store entry point the ingress dispatches through.
	await assert.rejects(
		first.ingress.branch().attachment.submissions.dispatch(record.id, record.revision, "failed-operation", async () => {
			throw new Error("dispatch failure");
		}),
		/dispatch failure/,
	);
	const path = first.session.sessionManager.getSessionFile();
	await first.ingress.dispose();
	const second = await fixture(t, {
		root: first.root,
		agentDir: first.agentDir,
		manager: SessionManager.open(path),
	});
	const adapter = await second.session._flowBinding.registerUserInputAdapter(first.extensionId, {
		id: "fixture",
		label: "Fixture",
	});
	const reopened = { ...second, adapter, binding: await adapter.bind() };
	const [recovered] = await externalRecords(reopened);
	// The callback ended, but dispatch intent proves this input may have reached the host.
	assert.equal(recovered.unavailable, undefined);
	assert.equal(recovered.dispatch.phase, "failed");
	const receipt = await lookup(reopened, "one");
	assert.equal(receipt.state, "unknown");
	assert.equal(receipt.reason.code, "dispatch-failed");
	// A retry cannot reattach a dispatch that may already have run.
	assert.equal((await adapter.submit(input(reopened))).state, "unknown");
	await second.ingress.joinPendingOperations();
	assert.equal(second.sent.length, 0);
});

test("suspension flushes host input but never dispatches held external input", async (t) => {
	const f = await setup(t, { admit: async () => false });
	assert.equal((await f.adapter.submit(input(f))).state, "held");
	await f.session.sendCustomMessage(
		{ customType: "fixture", content: "host note", display: false },
		{ triggerTurn: true },
	);
	// The generic flush hands host input back to Pi; external input has no callback Pi can run.
	await f.ingress.suspend();
	await f.ingress.joinPendingOperations();
	const bodies = f.sent.map((messages) => JSON.stringify(messages));
	assert.equal(bodies.length, 1);
	assert.ok(bodies[0].includes("host note"));
	assert.ok(!bodies[0].includes("external instruction"));
	const [record] = await externalRecords(f);
	assert.equal(record.status, "cancelled");
	assert.equal(record.cancellationReason, "flow-suspended");
	assert.equal(record.dispatch, undefined);
});

test("a destructive reset waits for in-flight retention and fences the old target", async (t) => {
	const f = await setup(t);
	const store = f.ingress.branch().attachment.submissions;
	const retained = deferred();
	const retention = deferred();
	const retain = store.retainExternal.bind(store);
	// Pause the submission after it validated its target, inside the retention transaction's caller.
	t.mock.method(store, "retainExternal", async (...args) => {
		retained.resolve();
		await retention.promise;
		return retain(...args);
	});
	// Pause the release immediately before native input, so the reset cannot be racing a dispatch.
	const releasing = deferred();
	const dispatch = deferred();
	const authorize = f.ingress.authorizeExternal.bind(f.ingress);
	t.mock.method(f.ingress, "authorizeExternal", async (...args) => {
		releasing.resolve();
		await dispatch.promise;
		return authorize(...args);
	});
	const submitting = f.adapter.submit(input(f)).catch((error) => error);
	await retained.promise;
	const epoch = await store.externalTargetEpoch();
	const resetting = f.ingress.resetFlow();
	await tick();
	// The reset cannot rotate the epoch while a submission it must fence is still retaining.
	assert.equal(await store.externalTargetEpoch(), epoch);
	retention.resolve();
	const receipt = await submitting;
	await resetting;
	assert.equal(receipt.state, "retained");
	dispatch.resolve();
	// The fenced release fails on purpose; what matters is that it dispatched nothing.
	await f.ingress.joinPendingOperations().catch(() => {});
	// The release that validated the previous epoch is fenced: nothing reached native input.
	assert.equal(f.sent.length, 0);
	await assert.rejects(lookup(f, "one"), { code: "target-unavailable" });
	const records = await externalRecords(f);
	assert.deepEqual(records, []);
});

test("suspension that begins during retention cancels the record instead of dispatching it", async (t) => {
	const f = await setup(t);
	const store = f.ingress.branch().attachment.submissions;
	const retained = deferred();
	const retention = deferred();
	const retain = store.retainExternal.bind(store);
	t.mock.method(store, "retainExternal", async (...args) => {
		retained.resolve();
		await retention.promise;
		return retain(...args);
	});
	const submitting = f.adapter.submit(input(f)).catch((error) => error);
	await retained.promise;
	// Suspension starts while the record is being retained, so the record exists before it lands.
	const suspending = f.ingress.suspend();
	await tick();
	assert.equal(f.ingress.enabled(), false);
	retention.resolve();
	const outcome = await submitting;
	await suspending;
	assert.equal(outcome.code, "stale-target");
	await f.ingress.joinPendingOperations();
	assert.equal(f.sent.length, 0);
	const [record] = await externalRecords(f);
	assert.equal(record.status, "cancelled");
	assert.equal(record.cancellationReason, "flow-suspended");
	// The durable cause survives the suspension and is what a lookup after resume reports.
	await f.ingress.resume();
	const receipt = await lookup(f, "one");
	assert.equal(receipt.state, "cancelled");
	assert.equal(receipt.reason.code, "flow-suspended");
});

test("a grant revoked while the settled event holds the send refuses the deferred dispatch", async (t) => {
	const entered = deferred();
	const gate = deferred();
	t.after(() => gate.resolve());
	let held = false;
	const f = await setup(t, {
		extensions: [
			(pi) =>
				pi.on("agent_settled", async () => {
					if (held) return;
					held = true;
					entered.resolve();
					await gate.promise;
				}),
		],
	});
	const first = f.session.sendCustomMessage(
		{ customType: "fixture", content: "start", display: false },
		{ triggerTurn: true },
	);
	await entered.promise;
	await f.adapter.submit(input(f));
	// The closure is queued for the settled drain, which runs only after the event finishes.
	await until(() => f.session._deferredSettledActions.length === 1, "the external send was never deferred");
	assert.equal((await lookup(f, "one")).state, "unknown");
	// The grant is withdrawn after admission and before the deferred action executes.
	await f.revoke();
	gate.resolve();
	await first;
	await f.ingress.joinPendingOperations().catch(() => {});
	await f.restore();
	const receipt = await lookup(f, "one");
	assert.equal(receipt.state, "unknown");
	assert.equal(receipt.reason.code, "dispatch-failed");
	assert.ok(!JSON.stringify(f.sent).includes("external instruction"));
});

test("an earlier failing deferred action settles the external dispatch instead of waiting", async (t) => {
	const entered = deferred();
	const gate = deferred();
	t.after(() => gate.resolve());
	let held = false;
	const f = await setup(t, {
		extensions: [
			(pi) =>
				pi.on("agent_settled", async () => {
					if (held) return;
					held = true;
					entered.resolve();
					await gate.promise;
				}),
		],
	});
	const first = f.session.sendCustomMessage(
		{ customType: "fixture", content: "start", display: false },
		{ triggerTurn: true },
	);
	await entered.promise;
	// Pi drains deferred actions in order and stops at the first rejection, so this one is ahead of
	// the closure that owns the external send and the send's closure is never invoked.
	f.session._deferredSettledActions.push(async () => {
		throw new Error("earlier deferred action failed");
	});
	await f.adapter.submit(input(f));
	// The closure is queued for the settled drain, which is where the earlier failure will abort it.
	await until(() => f.session._deferredSettledActions.length === 2, "the external send was never deferred");
	assert.equal((await lookup(f, "one")).state, "unknown");
	gate.resolve();
	await assert.rejects(first, /earlier deferred action failed/u);
	// Joining and disposal are bounded: the abandoned execution settled with a conservative receipt.
	await f.ingress.joinPendingOperations();
	const receipt = await lookup(f, "one");
	assert.equal(receipt.state, "unknown");
	assert.equal(receipt.reason.code, "dispatch-failed");
	assert.ok(!JSON.stringify(f.sent).includes("external instruction"));
});

test("an unreadable grants file holds retained input and admits it after repair", async (t) => {
	let allow = false;
	const f = await setup(t, { admit: async () => allow });
	assert.equal((await f.adapter.submit(input(f))).state, "held");
	// The ordinary way to reach this state is an in-place edit of the grants file.
	await writeFile(join(f.agentDir, "user-input-adapters.json"), "{ not json");
	allow = true;
	await f.ingress.releaseReady();
	await f.ingress.joinPendingOperations();
	assert.equal(f.sent.length, 0);
	const [retained] = await externalRecords(f);
	assert.equal(retained.status, "retained");
	assert.equal(retained.cancellationReason, undefined);
	await f.restore();
	await f.ingress.releaseReady();
	await f.ingress.joinPendingOperations();
	assert.equal((await lookup(f, "one")).state, "consumed");
	assert.equal(f.sent.length, 1);
});

test("an unreadable grants file keeps a queued entry and admits it after repair", async (t) => {
	const gate = deferred();
	t.after(() => gate.resolve());
	const f = await setup(t, { provider: true, onRequest: async () => gate.promise });
	const turn = f.session.prompt("keep running");
	await until(() => f.sent.length === 1, "the first provider request did not start");
	await f.adapter.submit(input(f, "queued", "queued instruction", "followUp"));
	await until(async () => (await lookup(f, "queued")).state === "queued", "the input was never queued");
	await writeFile(join(f.agentDir, "user-input-adapters.json"), "{ not json");
	gate.resolve();
	await turn;
	await f.ingress.joinPendingOperations();
	// The decision is repairable, so the exact identity stays in the queue instead of being removed.
	assert.equal(f.session.agent.inspectQueuedMessages().length, 1);
	const [retained] = await externalRecords(f);
	assert.equal(retained.status, "retained");
	assert.equal(retained.dispatch?.queueCancellations, undefined);
	await f.restore();
	await f.session.prompt("drain the queue");
	await f.ingress.joinPendingOperations();
	assert.equal((await lookup(f, "queued")).state, "consumed");
	assert.ok(JSON.stringify(f.sent).includes("queued instruction"));
});

test("a reset that closes admission in the same tick still drains the queued submission", async (t) => {
	const f = await setup(t);
	// Park the release before native input so the reset cannot race a dispatch either way.
	const dispatch = deferred();
	t.after(() => dispatch.resolve());
	const authorize = f.ingress.authorizeExternal.bind(f.ingress);
	t.mock.method(f.ingress, "authorizeExternal", async (...args) => {
		await dispatch.promise;
		return authorize(...args);
	});
	// Both calls happen without yielding: the submission is chained into admission but its callback
	// has not started when the reset closes admission.
	const submitting = f.adapter.submit(input(f)).catch((error) => error);
	const resetting = f.ingress.resetFlow();
	const settled = await Promise.race([
		Promise.all([submitting, resetting]).then(([outcome]) => outcome),
		new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000)),
	]);
	assert.notEqual(settled, "timeout", "the reset and the queued submission deadlocked");
	dispatch.resolve();
	await f.ingress.joinPendingOperations().catch(() => {});
	assert.equal(f.sent.length, 0);
	await assert.rejects(lookup(f, "one"), { code: "target-unavailable" });
});

test("a successful deferred turn does not abandon later external input in the same drain", async (t) => {
	const entered = deferred();
	const gate = deferred();
	t.after(() => gate.resolve());
	let held = false;
	const f = await setup(t, {
		extensions: [
			(pi) =>
				pi.on("agent_settled", async () => {
					if (held) return;
					held = true;
					entered.resolve();
					await gate.promise;
				}),
		],
	});
	const first = f.session.sendCustomMessage(
		{ customType: "fixture", content: "start", display: false },
		{ triggerTurn: true },
	);
	await entered.promise;
	// This action runs before the external closure and emits a nested settled event while the outer
	// drain still owns the external action. Its own drain is empty because the outer event already
	// took the actions, so only the binding-wide abandonment can reach across drains.
	f.session._deferredSettledActions.push(async () => {
		await f.session._emitAgentSettled();
	});
	await f.adapter.submit(input(f));
	await until(() => f.session._deferredSettledActions.length === 2, "the external send was never deferred");
	gate.resolve();
	await first;
	await f.ingress.joinPendingOperations();
	// The nested event belongs to the earlier action, not to the drain that still owns this input.
	assert.equal((await lookup(f, "one")).state, "consumed");
	assert.ok(JSON.stringify(f.sent).includes("external instruction"));
});

test("a runtime replaced during dispatch authorization dispatches nothing", async (t) => {
	const entered = deferred();
	const gate = deferred();
	t.after(() => gate.resolve());
	let live = true;
	const f = await setup(t, {
		runtimeAssert: () => {
			if (!live) throw new Error("Extension runtime ended.");
		},
	});
	const authorize = f.ingress.authorizeExternal.bind(f.ingress);
	t.mock.method(f.ingress, "authorizeExternal", async (...args) => {
		entered.resolve();
		await gate.promise;
		return authorize(...args);
	});
	await f.adapter.submit(input(f));
	// The release is inside the asynchronous authorization read when its runtime is replaced.
	await entered.promise;
	live = false;
	gate.resolve();
	await f.ingress.joinPendingOperations().catch(() => {});
	assert.equal(f.sent.length, 0, "a retired runtime dispatched external input");
	// Dispatch intent precedes the callback, so a refusal after authorization leaves a failed dispatch
	// with no native input rather than a record that could be delivered later.
	const [record] = await externalRecords(f);
	assert.equal(record.dispatch.phase, "failed");
	assert.deepEqual(record.dispatch.inputs, undefined);
	// The replacement runtime reads the receipt left by the callback its predecessor ended.
	live = true;
	assert.equal((await lookup(f, "one")).reason.code, "dispatch-failed");
});

test("a runtime replaced while the settled dispatch authorizes delivers nothing", async (t) => {
	const entered = deferred();
	const settled = deferred();
	const authorizing = deferred();
	const authorized = deferred();
	t.after(() => {
		settled.resolve();
		authorized.resolve();
	});
	let live = true;
	let calls = 0;
	const f = await setup(t, {
		runtimeAssert: () => {
			if (!live) throw new Error("Extension runtime ended.");
		},
		extensions: [
			(pi) =>
				pi.on("agent_settled", async () => {
					entered.resolve();
					await settled.promise;
				}),
		],
	});
	const authorize = f.ingress.authorizeExternal.bind(f.ingress);
	t.mock.method(f.ingress, "authorizeExternal", async (...args) => {
		// The first call authorizes the dispatch that queues the deferred closure; the second is the
		// deferred execution's own revalidation, which is where the runtime is replaced.
		if (++calls === 2) {
			authorizing.resolve();
			await authorized.promise;
		}
		return authorize(...args);
	});
	const first = f.session.sendCustomMessage(
		{ customType: "fixture", content: "start", display: false },
		{ triggerTurn: true },
	);
	await entered.promise;
	await f.adapter.submit(input(f));
	await until(() => f.session._deferredSettledActions.length === 1, "the external send was never deferred");
	settled.resolve();
	await authorizing.promise;
	// The deferred closure is inside its authorization read when its runtime is replaced.
	live = false;
	authorized.resolve();
	await first;
	await f.ingress.joinPendingOperations().catch(() => {});
	assert.ok(!JSON.stringify(f.sent).includes("external instruction"), "a retired runtime delivered deferred input");
	const [record] = await externalRecords(f);
	assert.equal(record.dispatch.phase, "failed");
	live = true;
	assert.equal((await lookup(f, "one")).reason.code, "dispatch-failed");
});

test("a release parked in authorization cannot dispatch a callback the runtime ended", async (t) => {
	const f = await setup(t);
	const store = f.ingress.branch().attachment.submissions;
	const entered = deferred();
	const gate = deferred();
	t.after(() => gate.resolve());
	const authorize = f.ingress.external.authorize.bind(f.ingress.external);
	// The submit's own grant read and its admission decision pass through; the release's separate
	// read immediately before dispatch is the one parked here.
	let calls = 0;
	t.mock.method(f.ingress.external, "authorize", async (...args) => {
		if (++calls === 3) {
			entered.resolve();
			await gate.promise;
		}
		return authorize(...args);
	});
	// Resume the parked release once the ended-callback marker is committed but before the runtime
	// retirement drops its pending entry, which is the window the release would dispatch through.
	const endCallback = store.endCallback.bind(store);
	t.mock.method(store, "endCallback", async (...args) => {
		const result = await endCallback(...args);
		gate.resolve();
		return result;
	});
	const submitting = f.adapter.submit(input(f));
	await entered.promise;
	await f.ingress.endExtensionRuntime();
	await submitting;
	await f.ingress.joinPendingOperations().catch(() => {});
	assert.equal(f.sent.length, 0, "a callback the host ended was dispatched");
	const [record] = await externalRecords(f);
	assert.equal(record.unavailable, "callback-ended");
	assert.equal(record.dispatch, undefined, "the ended callback acquired dispatch intent");
	// The ended runtime's handle is inert; replace the runner before registering the new handle.
	await f.session.reload();
	const replacement = await f.register();
	assert.equal((await replacement.lookup({ target: f.binding.target, messageId: "one" })).state, "unknown");
});

test("a reset requested by an admission decision fails promptly instead of joining its own drain", async (t) => {
	let resetOutcome;
	let first = true;
	const f = await setup(t, {
		admit: async () => {
			if (!first) return true;
			first = false;
			// This admission decision is inside the submit's serialized retention, which the reset's
			// admission barrier would wait on, so the reset must refuse rather than wait for itself.
			resetOutcome = await f.ingress.resetFlow().catch((error) => error);
			return true;
		},
	});
	const submitting = f.adapter.submit(input(f));
	assert.equal((await submitting).state, "retained");
	assert.equal(resetOutcome?.code, "busy");
	await f.ingress.joinPendingOperations();
	assert.equal(f.sent.length, 1);
	assert.equal((await lookup(f, "one")).state, "consumed");
});
