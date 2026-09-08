import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { FlowWaitProducerRegistry } from "../dist/flow-control/wait-producers.js";

const scope = { sessionId: "session", branchId: "branch" };
const identity = { workId: "work", handle: "bg-1", execution: "exec-1" };
const evidence = (revision = 1, state = "pending") => ({
	...identity,
	scope,
	revision,
	predicates: [{ until: "exit", state }],
});
const deferred = () => {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
};
const waitRequest = () => ({
	scope,
	workId: "work",
	token: "wait",
	reason: "process exit",
	mode: "all",
	on: [{ producer: "bg", handle: "bg-1", execution: "exec-1", until: "exit" }],
	expiresAt: Date.now() + 100000,
});
async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-wait-producers-"));
	let attachment = await PiFlowAttachment.open(root, scope);
	await attachment.waits.registerWork("work", "lane", 0);
	await attachment.waits.shareWork("work", "lane", 1, "bg", 0);
	const errors = [];
	t.after(async () => {
		await attachment.close();
		await rm(root, { recursive: true, force: true });
	});
	return {
		root,
		errors,
		get attachment() {
			return attachment;
		},
		async reopen() {
			await attachment.close();
			attachment = await PiFlowAttachment.open(root, scope);
			return attachment;
		},
	};
}
function source(snapshot = async () => evidence()) {
	const listeners = new Set();
	let captured;
	return {
		version: 1,
		namespace: "bg",
		snapshot,
		subscribe(_identity, changed) {
			captured = changed;
			listeners.add(changed);
			return () => listeners.delete(changed);
		},
		emit(value) {
			for (const listener of listeners) listener(value);
		},
		late(value) {
			captured(value);
		},
		get listeners() {
			return listeners.size;
		},
	};
}

for (const timing of ["before", "during", "after"]) {
	test(`subscribed completion ${timing} snapshot is retained and resolves an owned wait`, async (t) => {
		const f = await fixture(t),
			entered = deferred(),
			proceed = deferred();
		const producer = source(async () => {
			entered.resolve();
			await proceed.promise;
			return timing === "before" ? evidence(2, "satisfied") : evidence();
		});
		const registration = f.attachment.waitProducers.register(producer, (error) => f.errors.push(error));
		const starting = registration.bind(identity, 2);
		assert.equal(f.attachment.waitProducers.updating, true);
		await entered.promise;
		assert.equal(producer.listeners, 1);
		if (timing === "during") producer.emit(evidence(2, "satisfied"));
		proceed.resolve();
		const binding = await starting;
		assert.equal(f.attachment.waitProducers.updating, false);
		await f.attachment.waits.declareOwned("lane", 2, waitRequest(), Date.now(), 100000);
		if (timing === "after") {
			producer.emit(evidence(2, "satisfied"));
			await binding.flush();
		}
		assert.equal((await f.attachment.waits.snapshot())[0].state, "resolved");
		await f.reopen();
		assert.equal(producer.listeners, 0);
		assert.equal((await f.attachment.waits.snapshot())[0].state, "resolved");
		assert.deepEqual(f.errors, []);
	});
}

test("new attachment snapshots advance retained executions and replay does not refresh evidence time", async (t) => {
	const f = await fixture(t),
		producer = source();
	await f.attachment.waitProducers.register(producer, assert.ifError).bind(identity, 2);
	await f.attachment.waits.declareOwned("lane", 2, waitRequest(), Date.now(), 100000);
	await f.reopen();
	const next = source(async () => evidence(2, "satisfied"));
	const binding = await f.attachment.waitProducers.register(next, assert.ifError).bind(identity, 2);
	assert.equal((await f.attachment.waits.snapshot())[0].state, "resolved");
	const before = (await f.attachment.waits.authoritySnapshot()).executions;
	next.emit(evidence(2, "satisfied"));
	await binding.flush();
	assert.deepEqual((await f.attachment.waits.authoritySnapshot()).executions, before);
});

test("namespace and execution subscription ownership cannot be duplicated or transferred", async (t) => {
	const f = await fixture(t),
		producer = source();
	const registration = f.attachment.waitProducers.register(producer, assert.ifError);
	assert.throws(() => f.attachment.waitProducers.register(source(), assert.ifError), { code: "identity" });
	producer.namespace = "foreign";
	const binding = await registration.bind(identity, 2);
	assert.equal((await f.attachment.waits.authoritySnapshot()).executions[0].producer, "bg");
	await assert.rejects(registration.bind({ ...identity, handle: "changed" }, 2), { code: "identity" });
	await binding.close();
	await registration.bind(identity, 2);
	await registration.close();
	await assert.rejects(registration.bind(identity, 2), { code: "stale" });
	await f.attachment.waitProducers.register(source(), assert.ifError).bind(identity, 2);
});

test("foreign and malformed initial observations fail without registering an execution", async (t) => {
	const f = await fixture(t);
	for (const change of [
		{ scope: { ...scope, branchId: "foreign" } },
		{ workId: "other" },
		{ handle: "bg-2" },
		{ execution: "reused" },
		{ revision: 0 },
		{ predicates: [] },
	]) {
		const producer = source(async () => ({ ...evidence(), ...change }));
		const registration = f.attachment.waitProducers.register(producer, assert.ifError);
		await assert.rejects(registration.bind(identity, 2), { code: "identity" });
		assert.equal(producer.listeners, 0);
		assert.deepEqual((await f.attachment.waits.authoritySnapshot()).executions, []);
		await registration.close();
	}
});

test("bad subscribed evidence reports one failure and cannot refresh or reopen retained state", async (t) => {
	const f = await fixture(t),
		producer = source(async () => evidence(2, "satisfied"));
	const binding = await f.attachment.waitProducers
		.register(producer, (error) => f.errors.push(error))
		.bind(identity, 2);
	const before = (await f.attachment.waits.authoritySnapshot()).executions;
	producer.emit(evidence(3, "pending"));
	await assert.rejects(binding.flush(), { code: "transition" });
	assert.equal(f.errors.length, 1);
	assert.equal(producer.listeners, 0);
	producer.late(evidence(4, "satisfied"));
	assert.deepEqual((await f.attachment.waits.authoritySnapshot()).executions, before);
});

test("snapshot timeout and attachment close abort inspection and suppress late callbacks", async (t) => {
	const f = await fixture(t),
		entered = deferred();
	let expire;
	const registry = new FlowWaitProducerRegistry(f.attachment.waits, scope, {
		now: Date.now,
		after: (_ms, callback) => {
			expire = callback;
			return () => {};
		},
	});
	const producer = source(async (_identity, signal) => {
		entered.resolve(signal);
		return new Promise(() => {});
	});
	const registration = registry.register(producer, assert.ifError);
	const starting = registration.bind(identity, 2);
	const signal = await entered.promise;
	expire();
	await assert.rejects(starting, /timed out/);
	assert.equal(signal.aborted, true);
	assert.equal(producer.listeners, 0);
	await registry.close();
	const secondEntered = deferred();
	const second = source(async (_identity, signal) => {
		secondEntered.resolve(signal);
		return new Promise(() => {});
	});
	const secondStart = f.attachment.waitProducers.register(second, assert.ifError).bind(identity, 2);
	const rejected = assert.rejects(secondStart, { code: "stale" });
	const secondSignal = await secondEntered.promise;
	await f.attachment.close();
	await rejected;
	assert.equal(secondSignal.aborted, true);
	assert.equal(second.listeners, 0);
	second.late(evidence(2, "satisfied"));
	await f.reopen();
	assert.deepEqual((await f.attachment.waits.authoritySnapshot()).executions, []);
});

test("initial notification floods fail at the bounded buffer and leave no persisted execution", async (t) => {
	const f = await fixture(t),
		producer = source();
	producer.subscribe = (_identity, changed) => {
		for (let index = 0; index < 129; index++) changed(evidence(index + 1));
		return () => {};
	};
	await assert.rejects(
		f.attachment.waitProducers.register(producer, (error) => f.errors.push(error)).bind(identity, 2),
		{ code: "capacity" },
	);
	assert.equal(f.errors.length, 1);
	assert.deepEqual((await f.attachment.waits.authoritySnapshot()).executions, []);
});

test("buffered stale pending events are compatible but contradictory terminal evidence rejects the snapshot", async (t) => {
	const f = await fixture(t);
	for (const status of ["pending", "failed"]) {
		const producer = source(async () => evidence(3, "satisfied"));
		producer.subscribe = (_identity, changed) => {
			changed(evidence(2, status));
			return () => {};
		};
		const registration = f.attachment.waitProducers.register(producer, assert.ifError);
		if (status === "pending") {
			await registration.bind(identity, 2);
			assert.equal((await f.attachment.waits.authoritySnapshot()).executions[0].revision, 3);
		} else {
			const before = await f.attachment.waits.authoritySnapshot();
			await assert.rejects(registration.bind(identity, 2), { code: "transition" });
			assert.deepEqual(await f.attachment.waits.authoritySnapshot(), before);
		}
		await registration.close();
	}
});

test("ownership changes during snapshot prevent binding stale work", async (t) => {
	const f = await fixture(t),
		entered = deferred(),
		proceed = deferred();
	const producer = source(async () => {
		entered.resolve();
		await proceed.promise;
		return evidence();
	});
	const starting = f.attachment.waitProducers.register(producer, assert.ifError).bind(identity, 2);
	await entered.promise;
	await f.attachment.waits.changeWork("work", "lane", 2, "stopped", "user stop", Date.now());
	proceed.resolve();
	await assert.rejects(starting, { code: "stale" });
	assert.equal(producer.listeners, 0);
	assert.deepEqual((await f.attachment.waits.authoritySnapshot()).executions, []);
});

test("active notification floods report a bounded queue failure without unhandled rejections", async (t) => {
	const f = await fixture(t),
		producer = source();
	const binding = await f.attachment.waitProducers
		.register(producer, (error) => f.errors.push(error))
		.bind(identity, 2);
	for (let index = 0; index < 129; index++) producer.emit(evidence(index + 2));
	await assert.rejects(binding.flush(), { code: "capacity" });
	assert.equal(f.errors.length, 1);
	assert.equal(producer.listeners, 0);
	assert.equal((await f.attachment.waits.authoritySnapshot()).executions[0].revision, 1);
});
