import assert from "node:assert/strict";
import { test } from "node:test";
import { CompactionRequestController } from "../dist/compaction-request.js";
import { settleChildWork } from "../dist/subagents/settle.js";

function fixture() {
	const waitsListeners = new Set();
	const producerListeners = new Set();
	const idleListeners = new Set();
	const f = { waits: [], executions: [], wakes: 0, idle: 0 };
	const subscribe = (listeners) => (callback) => {
		listeners.add(callback);
		return () => listeners.delete(callback);
	};
	const branch = {
		controller: { retentionReferences: async () => ({ workIds: new Set(), assertCurrent() {} }) },
		attachment: {
			waits: {
				onChanged: subscribe(waitsListeners),
				snapshot: async () => f.waits,
				authoritySnapshot: async () => ({ executions: f.executions, work: [{ id: "unfinished-task" }] }),
			},
			waitProducers: { onChanged: subscribe(producerListeners) },
		},
		host: { onIdle: subscribe(idleListeners) },
	};
	f.session = {
		waitForIdle: async () => {
			f.idle++;
		},
		isStreaming: false,
	};
	f.ingress = {
		branch: () => branch,
		joinPendingOperations: async () => {},
		wakeProducers: async () => {
			f.wakes++;
		},
	};
	f.compaction = new CompactionRequestController();
	f.cancel = new AbortController();
	f.changed = () => {
		for (const listener of waitsListeners) listener();
	};
	f.settle = () => settleChildWork(f.session, f.ingress, f.compaction, f.cancel.signal);
	f.listenerCount = () => waitsListeners.size + producerListeners.size + idleListeners.size;
	return f;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a child joins admitted continuations, not unfinished task inventory", async () => {
	const f = fixture();
	await f.settle();
	assert.equal(f.wakes, 1);
	assert.equal(f.idle, 2);
	assert.equal(f.listenerCount(), 0);
});

test("a child waits for owned executions even without an explicit dependency wait", async () => {
	const f = fixture();
	f.executions = [{ predicates: [{ until: "exit", state: "pending" }] }];
	let finished = false;
	const result = f.settle().then(() => {
		finished = true;
	});
	await tick();
	assert.equal(finished, false);
	f.executions[0].predicates[0].state = "satisfied";
	f.changed();
	await result;
	assert.equal(finished, true);
	assert.equal(f.listenerCount(), 0);
});

test("a dependency terminal transition cannot be lost during the first read", async () => {
	const f = fixture();
	f.waits = [{ state: "waiting" }];
	const branch = f.ingress.branch();
	branch.attachment.waits.snapshot = async () => {
		if (f.waits[0].state === "waiting") {
			f.waits[0].state = "resolved";
			f.changed();
		}
		return f.waits;
	};
	await f.settle();
	assert.equal(f.wakes, 2);
	assert.equal(f.listenerCount(), 0);
});

test("cancellation while a child is idle releases all subscriptions", async () => {
	const f = fixture();
	f.waits = [{ state: "waiting" }];
	const result = f.settle();
	await tick();
	f.cancel.abort(new Error("fixture cancelled"));
	await assert.rejects(result, /fixture cancelled/);
	assert.equal(f.listenerCount(), 0);
});

test("a child does not close during a requested compaction", async () => {
	const f = fixture();
	f.compaction.request();
	let finished = false;
	const result = f.settle().then(() => {
		finished = true;
	});
	await tick();
	assert.equal(finished, false);
	f.compaction.beginDispatch();
	await tick();
	assert.equal(finished, false);
	f.compaction.settle();
	await result;
	assert.equal(finished, true);
	assert.equal(f.listenerCount(), 0);
});

test("an admission error fails the child and releases subscriptions", async () => {
	const f = fixture();
	f.ingress.wakeProducers = async () => {
		throw new Error("fixture admission error");
	};
	await assert.rejects(f.settle(), /fixture admission error/);
	assert.equal(f.listenerCount(), 0);
});
