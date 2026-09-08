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
