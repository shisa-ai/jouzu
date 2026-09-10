import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";

const scope = { sessionId: "session", branchId: "branch" };
const handle = { producer: "bg", handle: "display", execution: "exec", until: "exit" };
const request = (token = "token", workId = "work") => ({
	token,
	workId,
	scope,
	reason: "dependency",
	mode: "all",
	on: [handle],
	expiresAt: 100,
});
const observations = (state = "pending", workId = "work") => [{ ...handle, scope, workId, state }];
async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-waits-"));
	let attachment = await PiFlowAttachment.open(root, scope);
	t.after(async () => {
		await attachment.close();
		await rm(root, { recursive: true, force: true });
	});
	return {
		get attachment() {
			return attachment;
		},
		async reopen() {
			await attachment.close();
			attachment = await PiFlowAttachment.open(root, scope);
			return attachment.waits;
		},
	};
}
test("waits persist original deadlines and one terminal outcome across reopen", async (t) => {
	const f = await fixture(t);
	await f.attachment.waits.declare(request(), observations(), 0, 80);
	const store = await f.reopen();
	assert.equal((await store.snapshot())[0].expiresAt, 80);
	const expired = await store.reconcile("token", observations(), 90);
	assert.equal(expired.state, "expired");
	assert.deepEqual(await (await f.reopen()).cancel("token", "late", 100), expired);
});
test("concurrent declarations admit one live wait per work", async (t) => {
	const f = await fixture(t);
	const results = await Promise.allSettled(
		["one", "two"].map((token) => f.attachment.waits.declare(request(token), observations(), 0, 100)),
	);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal((await f.attachment.waits.snapshot()).length, 1);
});
test("replacement validates exact token and dependencies before cancelling the old wait", async (t) => {
	const f = await fixture(t),
		store = f.attachment.waits;
	const original = await store.declare(request(), observations(), 0, 100);
	await assert.rejects(store.declare(request("next"), [], 10, 100, "token"), { code: "identity" });
	await assert.rejects(store.declare(request("next"), observations(), 10, 100, "wrong"), { code: "stale" });
	assert.deepEqual(await store.snapshot(), [original]);
	await store.declare(request("next"), observations(), 10, 100, "token");
	const waits = await (await f.reopen()).snapshot();
	assert.deepEqual(
		waits.map((wait) => wait.state),
		["cancelled", "waiting"],
	);
	assert.equal(waits[1].createdAt, 10);
});
test("independent work waits and concurrent terminal transitions stay isolated", async (t) => {
	const f = await fixture(t),
		store = f.attachment.waits;
	await store.declare(request(), observations(), 0, 100);
	await store.declare(request("other", "other-work"), observations("pending", "other-work"), 0, 100);
	const outcomes = await Promise.all([
		store.reconcile("token", observations("satisfied"), 20),
		store.cancel("token", "cancel", 20),
	]);
	assert.deepEqual(outcomes[0], outcomes[1]);
	assert.equal((await store.snapshot())[1].state, "waiting");
});

test("failed atomic commit preserves the prior wait and permits explicit retry", async (t) => {
	const f = await fixture(t),
		store = f.attachment.waits;
	const original = await store.declare(request(), observations(), 0, 100);
	const session = store.session;
	const mutate = session.mutate.bind(session);
	const failure = t.mock.method(session, "mutate", (update, context) =>
		mutate(
			(mutation, ctx) =>
				update(
					new Proxy(mutation, {
						get(target, property) {
							if (property === "commit")
								return async () => {
									throw new Error("write unavailable");
								};
							const member = Reflect.get(target, property);
							return typeof member === "function" ? member.bind(target) : member;
						},
					}),
					ctx,
				),
			context,
		),
	);
	await assert.rejects(store.declare(request("next"), observations(), 10, 100, "token"), /write unavailable/);
	failure.mock.restore();
	assert.deepEqual(await store.snapshot(), [original]);
	await store.declare(request("next"), observations(), 10, 100, "token");
	assert.deepEqual(
		(await store.snapshot()).map((wait) => wait.state),
		["cancelled", "waiting"],
	);
});

test("foreign declarations and writes through a closed attachment are rejected", async (t) => {
	const f = await fixture(t),
		store = f.attachment.waits;
	const foreign = { ...scope, branchId: "foreign" };
	await assert.rejects(
		store.declare(
			{ ...request(), scope: foreign },
			observations().map((item) => ({ ...item, scope: foreign })),
			0,
			100,
		),
		{ code: "identity" },
	);
	assert.deepEqual(await store.snapshot(), []);
	await f.attachment.close();
	await assert.rejects(store.declare(request(), observations(), 0, 100));
});

test("offline expiry reconciles due waits once without producer observations", async (t) => {
	const f = await fixture(t);
	await f.attachment.waits.declare(request(), observations(), 0, 50);
	await f.attachment.waits.declare(request("later", "later-work"), observations("pending", "later-work"), 0, 100);
	const store = await f.reopen();
	const expired = await store.expireDue(75);
	assert.equal(expired.length, 1);
	assert.equal(expired[0].token, "token");
	assert.deepEqual(expired[0].unmet, [handle]);
	assert.deepEqual(await store.expireDue(75), []);
	assert.equal((await store.snapshot())[1].state, "waiting");
	const reopened = await f.reopen();
	assert.deepEqual(await reopened.expireDue(99), []);
	assert.equal((await reopened.expireDue(100))[0].token, "later");
	assert.deepEqual(await reopened.expireDue(200), []);
});

test("cancellation at hard expiry retains expiry as the winning transition", async (t) => {
	const f = await fixture(t),
		store = f.attachment.waits;
	await store.declare(request(), observations(), 0, 100);
	const cancelled = await store.cancel("token", "late cancellation", 100);
	assert.equal(cancelled.state, "expired");
	assert.deepEqual(await store.expireDue(100), []);
	assert.deepEqual((await (await f.reopen()).snapshot())[0], cancelled);
});

function fakeClock(now = 0) {
	const timers = new Set();
	return {
		timers,
		now: () => now,
		after(delay, callback) {
			const timer = { at: now + delay, callback };
			timers.add(timer);
			return () => timers.delete(timer);
		},
		advance(next) {
			now = next;
			for (const timer of [...timers]) {
				if (timer.at <= now) {
					timers.delete(timer);
					timer.callback();
				}
			}
		},
	};
}
async function settledUntil(predicate) {
	for (let i = 0; i < 100; i++) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail("deadline scheduler did not settle");
}

test("attachment deadlines rearm for earlier waits and stop after all terminal transitions", async (t) => {
	const f = await fixture(t),
		store = f.attachment.waits,
		clock = fakeClock(),
		errors = [];
	await store.startDeadlines((error) => errors.push(error), clock);
	assert.equal(clock.timers.size, 0);
	await store.declare(request(), observations(), 0, 100);
	await settledUntil(() => [...clock.timers][0]?.at === 100);
	await store.declare(request("early", "early-work"), observations("pending", "early-work"), 0, 50);
	await settledUntil(() => [...clock.timers][0]?.at === 50);
	clock.advance(50);
	await settledUntil(async () => (await store.snapshot())[1].state === "expired" && [...clock.timers][0]?.at === 100);
	await store.reconcile("token", observations("satisfied"), 60);
	await settledUntil(() => clock.timers.size === 0);
	assert.deepEqual(errors, []);
});

test("deadline startup reconciles offline expiry and detach suppresses captured callbacks", async (t) => {
	const f = await fixture(t),
		clock = fakeClock(),
		errors = [];
	await f.attachment.waits.declare(request(), observations(), 0, 100);
	await f.attachment.waits.startDeadlines((error) => errors.push(error), clock);
	const callback = [...clock.timers][0].callback;
	await f.attachment.close();
	assert.equal(clock.timers.size, 0);
	clock.advance(150);
	callback();
	const store = await f.reopen();
	assert.equal((await store.snapshot())[0].state, "waiting");
	await store.startDeadlines((error) => errors.push(error), clock);
	assert.equal((await store.snapshot())[0].state, "expired");
	assert.equal(clock.timers.size, 0);
	assert.deepEqual(errors, []);
});

test("long deadline timers use bounded segments without renewing the expiry", async (t) => {
	const f = await fixture(t),
		store = f.attachment.waits,
		clock = fakeClock();
	const expiry = 3_000_000_000;
	await store.declare({ ...request(), expiresAt: expiry }, observations(), 0, expiry);
	await store.startDeadlines(assert.ifError, clock);
	assert.equal([...clock.timers][0].at, 2_147_483_647);
	clock.advance(2_147_483_647);
	await settledUntil(() => [...clock.timers][0]?.at === expiry);
	assert.equal((await store.snapshot())[0].state, "waiting");
	clock.advance(expiry);
	await settledUntil(async () => (await store.snapshot())[0].state === "expired");
	assert.equal((await store.snapshot())[0].expiresAt, expiry);
});

test("deadline startup failure permits retry and duplicate ownership is rejected", async (t) => {
	const f = await fixture(t),
		store = f.attachment.waits,
		clock = fakeClock();
	await assert.rejects(store.startDeadlines(assert.ifError, { ...clock, now: () => NaN }), /Invalid wait clock/);
	await store.startDeadlines(assert.ifError, clock);
	await assert.rejects(store.startDeadlines(assert.ifError, clock), /already scheduled/);
	await f.attachment.close();
	await assert.rejects(store.startDeadlines(assert.ifError, clock), /closed/);
});

test("a declaration during an awaited deadline snapshot cannot strand the earlier wait", async (t) => {
	const f = await fixture(t),
		store = f.attachment.waits,
		clock = fakeClock();
	await store.declare(request(), observations(), 0, 100);
	const snapshot = store.snapshot.bind(store);
	let release, entered;
	const blocked = new Promise((resolve) => {
		entered = resolve;
	});
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	let first = true;
	t.mock.method(store, "snapshot", async () => {
		const saved = await snapshot();
		if (first) {
			first = false;
			entered();
			await gate;
		}
		return saved;
	});
	const starting = store.startDeadlines(assert.ifError, clock);
	await blocked;
	await store.declare(request("early", "early-work"), observations("pending", "early-work"), 0, 50);
	release();
	await starting;
	assert.equal(clock.timers.size, 1);
	assert.equal([...clock.timers][0].at, 50);
});

test("detach drains an awaited scan and never arms its stale snapshot", async (t) => {
	const f = await fixture(t),
		store = f.attachment.waits,
		clock = fakeClock();
	await store.declare(request(), observations(), 0, 100);
	const snapshot = store.snapshot.bind(store);
	let release, entered;
	const blocked = new Promise((resolve) => {
		entered = resolve;
	});
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	t.mock.method(store, "snapshot", async () => {
		const saved = await snapshot();
		entered();
		await gate;
		return saved;
	});
	const starting = store.startDeadlines(assert.ifError, clock);
	await blocked;
	let closed = false;
	const closing = f.attachment.close().then(() => {
		closed = true;
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(closed, false);
	await assert.rejects(store.cancel("token", "closing", 1), /closed/);
	release();
	await Promise.all([starting, closing]);
	assert.equal(clock.timers.size, 0);
});

test("admission gates retain committed waits and block while an atomic mutation is pending", async (t) => {
	const f = await fixture(t),
		store = f.attachment.waits;
	assert.deepEqual(store.gate(), { waitingWorkIds: [], inactiveWorkIds: [], updating: false });
	const declaring = store.declare(request(), observations(), 0, 100);
	assert.equal(store.gate().updating, true);
	await declaring;
	assert.deepEqual(store.gate(), { waitingWorkIds: ["work"], inactiveWorkIds: [], updating: false });
	store.gate().waitingWorkIds.length = 0;
	assert.deepEqual(store.gate().waitingWorkIds, ["work"]);
	await assert.rejects(store.declare(request("invalid"), [], 1, 100, "token"));
	assert.deepEqual(store.gate(), { waitingWorkIds: ["work"], inactiveWorkIds: [], updating: false });
	const reopened = await f.reopen();
	assert.deepEqual(reopened.gate(), { waitingWorkIds: ["work"], inactiveWorkIds: [], updating: false });
	await reopened.cancel("token", "cancel gate", 10);
	assert.deepEqual(reopened.gate(), { waitingWorkIds: [], inactiveWorkIds: [], updating: false });
});

test("wait notifications follow changed commits and stop after unsubscribe", async (t) => {
	const f = await fixture(t),
		store = f.attachment.waits;
	let notifications = 0;
	const stop = store.onChanged(() => {
		notifications++;
	}, assert.ifError);
	await assert.rejects(store.declare(request(), [], 0, 100));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(notifications, 0);
	await store.declare(request(), observations(), 0, 100);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(notifications, 1);
	await store.expireDue(50);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(notifications, 1);
	const cancelling = store.cancel("token", "cancel", 60);
	stop();
	await cancelling;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(notifications, 1);
});

async function ownedFixture(t) {
	const f = await fixture(t),
		store = f.attachment.waits;
	await store.registerWork("work", "lane", 0);
	await store.shareWork("work", "lane", 1, "bg", 0);
	await store.registerExecution(
		{
			producer: "bg",
			handle: "display",
			execution: "exec",
			workId: "work",
			revision: 1,
			predicates: [{ until: "exit", state: "pending" }],
		},
		2,
		0,
	);
	return { ...f, store };
}

test("owned waits require explicit work participants and exact execution predicates", async (t) => {
	const { store } = await ownedFixture(t);
	await assert.rejects(store.declareOwned("stranger", 2, request(), 10, 100), { code: "identity" });
	await assert.rejects(store.declareOwned("lane", 1, request(), 10, 100), { code: "stale" });
	for (const changed of [
		{ execution: "new-exec" },
		{ producer: "other" },
		{ handle: "other" },
		{ until: "unblocked" },
	]) {
		await assert.rejects(store.declareOwned("lane", 2, { ...request(), on: [{ ...handle, ...changed }] }, 10, 100), {
			code: "identity",
		});
	}
	await assert.rejects(
		store.declareOwned("lane", 2, { ...request(), scope: { ...scope, branchId: "foreign" } }, 10, 100),
		{ code: "identity" },
	);
	await assert.rejects(store.declare(request(), observations(), 10, 100), { code: "identity" });
	assert.deepEqual(await store.snapshot(), []);
	const wait = await store.declareOwned("lane", 2, request(), 10, 100);
	assert.equal(wait.state, "waiting");
	await assert.rejects(store.reconcile(wait.token, observations("satisfied"), 20), { code: "identity" });
	await assert.rejects(store.cancel(wait.token, "unowned", 20), { code: "identity" });
	assert.deepEqual(await store.snapshot(), [wait]);
});

for (const order of ["before", "after", "concurrent"]) {
	test(`registered completion ${order} declaration cannot leave an owned wait parked`, async (t) => {
		const f = await ownedFixture(t),
			store = f.store;
		const complete = () => store.observeExecution(handle, 2, [{ until: "exit", state: "satisfied" }], 20);
		const declare = () => store.declareOwned("lane", 2, request(), 20, 100);
		if (order === "before") {
			await complete();
			await declare();
		}
		if (order === "after") {
			await declare();
			await complete();
		}
		if (order === "concurrent") await Promise.all([declare(), complete()]);
		const [wait] = await store.snapshot();
		assert.equal(wait.state, "resolved");
		assert.equal(wait.expiresAt, 100);
		assert.deepEqual(store.gate().waitingWorkIds, []);
		const restored = await f.reopen();
		assert.deepEqual(await restored.snapshot(), [wait]);
		assert.equal((await restored.authoritySnapshot()).executions[0].revision, 2);
	});
}

test("execution revisions reject stale or terminal changes without altering the wait", async (t) => {
	const { store } = await ownedFixture(t);
	await store.declareOwned("lane", 2, request(), 10, 100);
	await store.observeExecution(handle, 3, [{ until: "exit", state: "failed" }], 20);
	const before = await store.authoritySnapshot(),
		waits = await store.snapshot();
	await assert.rejects(store.observeExecution(handle, 2, [{ until: "exit", state: "pending" }], 30), { code: "stale" });
	await assert.rejects(store.observeExecution(handle, 3, [{ until: "exit", state: "satisfied" }], 30), {
		code: "identity",
	});
	await assert.rejects(store.observeExecution(handle, 4, [{ until: "exit", state: "pending" }], 30), {
		code: "transition",
	});
	await store.observeExecution(handle, 3, [{ until: "exit", state: "failed" }], 30);
	assert.deepEqual(await store.authoritySnapshot(), before);
	assert.deepEqual(await store.snapshot(), waits);
	assert.equal(waits[0].state, "failed");
});

test("owned replacement and cancellation preserve execution evidence and reject ownership takeover", async (t) => {
	const { store } = await ownedFixture(t);
	await assert.rejects(store.registerWork("work", "other", 0), { code: "identity" });
	await assert.rejects(store.shareWork("work", "bg", 2, "stranger", 0), { code: "identity" });
	await store.shareWork("work", "lane", 2, "tasks", 0);
	await store.declareOwned("tasks", 3, request(), 10, 100);
	await assert.rejects(
		store.declareOwned(
			"lane",
			3,
			{ ...request("replacement"), on: [{ ...handle, execution: "unknown" }] },
			20,
			100,
			"token",
		),
		{ code: "identity" },
	);
	assert.equal((await store.snapshot())[0].state, "waiting");
	await store.declareOwned("lane", 3, request("replacement"), 20, 100, "token");
	await store.cancelOwned("tasks", 3, "replacement", "redirected", 30);
	await store.cancelOwned("tasks", 3, "replacement", "redirected", 40);
	assert.deepEqual(
		(await store.snapshot()).map((wait) => wait.state),
		["cancelled", "cancelled"],
	);
	assert.equal((await store.authoritySnapshot()).executions[0].predicates[0].state, "pending");
});

test("a reused display handle never transfers completion or work ownership", async (t) => {
	const { store } = await ownedFixture(t);
	await store.declareOwned("lane", 2, request(), 10, 100);
	await store.registerExecution(
		{
			producer: "bg",
			handle: "display",
			execution: "another-exec",
			workId: "work",
			revision: 1,
			predicates: [{ until: "exit", state: "satisfied" }],
		},
		2,
		20,
	);
	assert.equal((await store.snapshot())[0].state, "waiting");
	await store.registerWork("other-work", "bg", 20);
	await assert.rejects(
		store.registerExecution(
			{
				producer: "bg",
				handle: "display",
				execution: "exec",
				workId: "other-work",
				revision: 1,
				predicates: [{ until: "exit", state: "pending" }],
			},
			1,
			20,
		),
		{ code: "identity" },
	);
	await assert.rejects(store.declareOwned("bg", 1, request("foreign", "other-work"), 20, 100), { code: "identity" });
	assert.equal((await store.snapshot())[0].state, "waiting");
});

test("pausing and resuming work preserves the wait and its original deadline across reopening", async (t) => {
	const f = await ownedFixture(t),
		store = f.store;
	const original = await store.declareOwned("lane", 2, request(), 10, 100);
	const paused = await store.changeWork("work", "lane", 2, "paused", "user pause", 20);
	assert.equal(paused.revision, 3);
	assert.deepEqual(await store.snapshot(), [original]);
	assert.deepEqual(store.gate().inactiveWorkIds, ["work"]);
	const reopened = await f.reopen();
	assert.deepEqual(reopened.gate().inactiveWorkIds, ["work"]);
	await reopened.observeExecution(handle, 2, [{ until: "exit", state: "satisfied" }], 30);
	assert.equal((await reopened.snapshot())[0].state, "resolved");
	assert.deepEqual(reopened.gate().waitingWorkIds, []);
	assert.deepEqual(reopened.gate().inactiveWorkIds, ["work"]);
	const resumed = await reopened.changeWork("work", "lane", 3, "active", "user resume", 40);
	assert.equal(resumed.revision, 4);
	assert.deepEqual(reopened.gate().inactiveWorkIds, []);
	assert.equal((await reopened.snapshot())[0].expiresAt, 100);
});

for (const status of ["stopped", "completed"]) {
	test(`${status} work retires only its own wait and cannot be reopened by producer replay`, async (t) => {
		const f = await ownedFixture(t),
			store = f.store;
		await store.declareOwned("lane", 2, request(), 10, 100);
		await store.declare(request("independent", "independent"), observations("pending", "independent"), 10, 100);
		const retired = await store.changeWork("work", "lane", 2, status, "user decision", 20);
		assert.equal(retired.revision, 3);
		assert.deepEqual(
			(await store.snapshot()).map((wait) => wait.state),
			["cancelled", "waiting"],
		);
		assert.equal((await store.authoritySnapshot()).executions[0].predicates[0].state, "pending");
		assert.deepEqual(await store.changeWork("work", "lane", 3, status, "repeat", 30), retired);
		assert.deepEqual(await store.registerWork("work", "lane", 40), retired);
		await assert.rejects(store.changeWork("work", "lane", 3, "active", "resume", 40), { code: "transition" });
		await assert.rejects(store.declareOwned("lane", 3, request("replayed"), 40, 100), { code: "transition" });
		await assert.rejects(store.shareWork("work", "lane", 3, "another", 40), { code: "transition" });
		await assert.rejects(
			store.registerExecution(
				{
					producer: "bg",
					handle: "display",
					execution: "new",
					workId: "work",
					revision: 1,
					predicates: [{ until: "exit", state: "pending" }],
				},
				3,
				40,
			),
			{ code: "transition" },
		);
		await store.observeExecution(handle, 2, [{ until: "exit", state: "satisfied" }], 50);
		assert.equal((await store.snapshot())[0].state, "cancelled");
		const reopened = await f.reopen();
		assert.deepEqual(reopened.gate().inactiveWorkIds, ["work"]);
		assert.deepEqual(reopened.gate().waitingWorkIds, ["independent"]);
		assert.equal((await reopened.authoritySnapshot()).work[0].lifecycle.state, status);
	});
}

test("work lifecycle rejects shared participants, stale revisions, invalid time, and malformed transitions atomically", async (t) => {
	const { store } = await ownedFixture(t);
	await store.declareOwned("lane", 2, request(), 10, 100);
	const before = await store.authoritySnapshot(),
		waits = await store.snapshot();
	for (const [owner, revision, status, reason, now, code] of [
		["bg", 2, "stopped", "stop", 20, "identity"],
		["lane", 1, "stopped", "stop", 20, "stale"],
		["lane", 2, "unknown", "stop", 20, "schema"],
		["lane", 2, "stopped", "", 20, "schema"],
		["lane", 2, "stopped", "stop", 5, "schema"],
	])
		await assert.rejects(store.changeWork("work", owner, revision, status, reason, now), { code });
	assert.deepEqual(await store.authoritySnapshot(), before);
	assert.deepEqual(await store.snapshot(), waits);
	assert.deepEqual(store.gate().inactiveWorkIds, []);
	await store.changeWork("work", "lane", 2, "paused", "pause", 20);
	await assert.rejects(store.changeWork("work", "lane", 3, "active", "resume", 19), { code: "schema" });
});

test("cancelling a wait keeps work active and a stop at expiry preserves the expiry outcome", async (t) => {
	const { store } = await ownedFixture(t);
	await store.declareOwned("lane", 2, request(), 10, 100);
	await store.cancelOwned("lane", 2, "token", "change dependency", 20);
	assert.deepEqual(store.gate().inactiveWorkIds, []);
	assert.equal((await store.authoritySnapshot()).work[0].revision, 2);
	await store.declareOwned("lane", 2, request("next"), 30, 100);
	await store.changeWork("work", "lane", 2, "stopped", "stop", 100);
	assert.equal((await store.snapshot())[1].state, "expired");
	assert.deepEqual(store.gate().inactiveWorkIds, ["work"]);
});

test("execution work capture uses committed participation and refuses changing, stale, or inactive ownership", async (t) => {
	const f = await fixture(t),
		store = f.attachment.waits;
	await store.registerWork("work", "lane", 0);
	const sharing = store.shareWork("work", "lane", 1, "bg", 1);
	assert.throws(() => store.captureExecutionWork("work", 1, "lane"), { code: "busy" });
	await sharing;
	assert.deepEqual(store.captureExecutionWork("work", 2, "bg"), { id: "work", revision: 2 });
	assert.throws(() => store.captureExecutionWork("work", 1, "bg"), { code: "stale" });
	assert.throws(() => store.captureExecutionWork("work", 2, "other"), { code: "identity" });
	await store.changeWork("work", "lane", 2, "paused", "pause", 2);
	assert.throws(() => store.captureExecutionWork("work", 3, "bg"), { code: "transition" });
	await store.changeWork("work", "lane", 3, "active", "resume", 3);
	assert.deepEqual(store.captureExecutionWork("work", 4, "bg"), { id: "work", revision: 4 });
	await store.changeWork("work", "lane", 4, "stopped", "stop", 4);
	assert.throws(() => store.captureExecutionWork("work", 5, "bg"), { code: "transition" });
	const restored = await f.reopen();
	assert.throws(() => restored.captureExecutionWork("work", 5, "bg"), { code: "transition" });
});

test("a monitored wait persists its policy and check time and still validates after reopen", async (t) => {
	const f = await fixture(t);
	const { store } = await (async () => ({ store: f.attachment.waits }))();
	await store.registerWork("work", "lane", 0);
	await store.shareWork("work", "lane", 1, "bg", 0);
	await store.registerExecution(
		{
			producer: "bg",
			handle: "display",
			execution: "exec",
			workId: "work",
			revision: 1,
			predicates: [{ until: "exit", state: "pending" }],
		},
		2,
		0,
	);
	const monitored = { ...handle, health: "sweep-progress-v1" };
	await store.declareOwned("lane", 2, { ...request(), on: [monitored], checkAt: 40 }, 10, 100);

	// The store revalidates every retained wait by replaying its declaration, so a policy name and
	// check time that survive reopen prove both are declared inputs rather than derived state.
	const reopened = await f.reopen();
	const [wait] = await reopened.snapshot();
	assert.equal(wait.checkAt, 40);
	assert.equal(wait.on[0].health, "sweep-progress-v1");
	assert.equal(wait.state, "waiting");
	assert.equal(wait.expiresAt, 100);

	// A health decision reaches an owned wait as an execution predicate, the same path any other
	// producer evidence takes, and ends the wait with its own outcome.
	await reopened.observeExecution(
		{ producer: "bg", handle: "display", execution: "exec" },
		2,
		[{ until: "exit", state: "health-unknown" }],
		50,
	);
	const [decided] = await reopened.snapshot();
	assert.equal(decided.state, "health-unknown");
	assert.deepEqual((await (await f.reopen()).snapshot())[0], decided);
	// A terminal predicate is not reopened or overwritten by a later probe.
	await assert.rejects(
		f.attachment.waits.observeExecution(
			{ producer: "bg", handle: "display", execution: "exec" },
			3,
			[{ until: "exit", state: "satisfied" }],
			60,
		),
		{ code: "transition" },
	);
});
