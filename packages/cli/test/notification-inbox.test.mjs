import assert from "node:assert/strict";
import { test } from "node:test";
import { createNotificationInbox } from "../dist/notifications/inbox.js";

function fixture(failure) {
	const errors = [];
	const records = [{ id: "run", revision: "terminal-1", handled: false }];
	const branch = [];
	const sent = [];
	const handlers = new Map();
	let idle = false;
	let queued = false;
	const ctx = {
		isIdle: () => idle,
		hasPendingMessages: () => queued,
		sessionManager: { getSessionId: () => "parent", getBranch: () => branch },
	};
	const inbox = createNotificationInbox({
		pi: {
			on: (name, handler) => handlers.set(name, handler),
			sendMessage: (message) => {
				if (failure === "send") throw new Error("send failed");
				sent.push(message);
			},
		},
		customType: "fixture-results",
		records: () => records,
		save: (id, change) => {
			if (failure === "save") throw new Error("save failed");
			return Object.assign(
				records.find((record) => record.id === id),
				change,
			);
		},
		observed: () => new Set(),
		build: (batchId) => ({
			content: failure === "size" ? "x".repeat(5000) : `Batch ${batchId}`,
			display: true,
			details: {},
		}),
		reportError: (error) => errors.push(error),
	});
	inbox.start(ctx);
	return {
		inbox,
		errors,
		records,
		branch,
		sent,
		ctx,
		handlers,
		idle: (value) => {
			idle = value;
		},
		queued: (value) => {
			queued = value;
		},
	};
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

for (const failure of ["save", "send", "size"]) {
	test(`${failure} failure remains pending without a settled-event retry loop`, async () => {
		const f = fixture(failure);
		try {
			f.idle(true);
			f.inbox.request();
			await tick();
			assert.equal(f.errors.length, 1);
			assert.equal(f.records[0].handled, false);
			for (let i = 0; i < 3; i++) {
				f.handlers.get("agent_settled")({}, f.ctx);
				await tick();
			}
			assert.equal(f.errors.length, 1);
			assert.equal(f.sent.length, 0);
		} finally {
			f.inbox.shutdown();
		}
	});
}

test("redacted batch cannot establish a receipt or authorize no-reply", async () => {
	const f = fixture();
	try {
		f.idle(true);
		f.inbox.request();
		await tick();
		const changed = { ...f.sent[0], content: "Policy removed result" };
		f.handlers.get("agent_start")();
		f.handlers.get("message_start")({ message: { role: "custom", ...changed } }, f.ctx);
		f.branch.push({ type: "custom_message", ...changed });
		f.handlers.get("turn_end")({}, f.ctx);
		assert.equal(f.records[0].handled, false);
		assert.throws(() => f.inbox.acknowledge(changed.details.inbox.batchId));
	} finally {
		f.inbox.shutdown();
	}
});

for (const deliveryEvent of [true, false]) {
	test(`redacted batch permits later completions without retrying withheld results (message event: ${deliveryEvent})`, async () => {
		const f = fixture();
		try {
			f.idle(true);
			f.inbox.request();
			await tick();
			const changed = { ...f.sent[0], content: "Policy removed result" };
			if (deliveryEvent) f.handlers.get("message_start")({ message: { role: "custom", ...changed } }, f.ctx);
			f.branch.push({ type: "custom_message", ...changed });
			f.handlers.get("turn_end")({}, f.ctx);
			f.records.push({ id: "later", revision: "terminal-2", handled: false });
			f.handlers.get("agent_settled")({}, f.ctx);
			await tick();
			assert.equal(f.sent.length, 2);
			assert.equal(f.records[0].batchId, changed.details.inbox.batchId);
			assert.equal(f.records[1].batchId, f.sent[1].details.inbox.batchId);
			f.branch.push({ type: "custom_message", ...f.sent[1] });
			for (let i = 0; i < 3; i++) {
				f.handlers.get("agent_settled")({}, f.ctx);
				await tick();
			}
			assert.equal(f.errors.length, 1);
			assert.equal(f.sent.length, 2);
			assert.equal(f.records[0].handled, false);
			assert.equal(f.records[1].handled, true);
			f.inbox.start(f.ctx);
			await tick();
			assert.equal(f.sent.length, 3, "reload retries the withheld result");
			assert.equal(f.records[0].batchId, f.sent[2].details.inbox.batchId);
		} finally {
			f.inbox.shutdown();
		}
	});
}

test("subsequent user input invalidates a current-run no-reply choice", async () => {
	const f = fixture();
	try {
		f.idle(true);
		f.inbox.request();
		await tick();
		const message = f.sent[0];
		f.branch.push({ type: "custom_message", ...message });
		f.handlers.get("agent_start")();
		f.handlers.get("message_start")({ message: { role: "custom", ...message } }, f.ctx);
		f.handlers.get("message_start")({ message: { role: "user", content: "New work" } }, f.ctx);
		assert.throws(() => f.inbox.acknowledge(message.details.inbox.batchId));
	} finally {
		f.inbox.shutdown();
	}
});

test("inbox waits for idle and queued user work, then reconciles the durable receipt", async () => {
	const f = fixture();
	try {
		await tick();
		assert.equal(f.sent.length, 0);
		f.idle(true);
		f.queued(true);
		f.inbox.request();
		await tick();
		assert.equal(f.sent.length, 0);
		f.queued(false);
		f.inbox.request();
		await tick();
		assert.equal(f.sent.length, 1);
		assert.equal(f.records[0].handled, false);
		f.branch.push({ type: "custom_message", ...f.sent[0] });
		f.handlers.get("turn_end")({}, f.ctx);
		assert.equal(f.records[0].handled, true);
		f.inbox.request();
		await tick();
		assert.equal(f.sent.length, 1);
	} finally {
		f.inbox.shutdown();
	}
});

test("no-reply permission requires current-run delivered identity, survives receipt reconciliation, and expires", async () => {
	const f = fixture();
	try {
		f.idle(true);
		f.inbox.request();
		await tick();
		const message = f.sent[0];
		const id = message.details.inbox.batchId;
		assert.throws(() => f.inbox.acknowledge(id));
		f.handlers.get("agent_start")();
		f.handlers.get("message_start")({ message: { role: "custom", ...message } }, f.ctx);
		f.branch.push({ type: "custom_message", ...message });
		f.handlers.get("turn_end")({}, f.ctx);
		assert.throws(() => f.inbox.acknowledge("wrong"));
		assert.equal(f.inbox.acknowledge(id).terminate, true);
		assert.throws(() => f.inbox.acknowledge(id));
	} finally {
		f.inbox.shutdown();
	}
});

test("aborted notification runs cannot acknowledge and foreign session events cannot deliver", async () => {
	const f = fixture();
	try {
		f.idle(true);
		f.inbox.request();
		await tick();
		const message = f.sent[0];
		f.branch.push({ type: "custom_message", ...message });
		f.handlers.get("agent_start")();
		f.handlers.get("message_start")(
			{ message: { role: "custom", ...message } },
			{ ...f.ctx, signal: AbortSignal.abort() },
		);
		assert.throws(() => f.inbox.acknowledge(message.details.inbox.batchId));
		f.inbox.shutdown();
		f.records.push({ id: "later", revision: "terminal-2", handled: false });
		f.idle(false);
		f.inbox.start(f.ctx);
		await tick();
		const foreign = {
			...f.ctx,
			isIdle: () => true,
			sessionManager: { getSessionId: () => "other", getBranch: () => [] },
		};
		f.handlers.get("agent_settled")({}, foreign);
		await tick();
		assert.equal(f.sent.length, 1);
	} finally {
		f.inbox.shutdown();
	}
});

test("shutdown cancels scheduled delivery and restart uses persisted membership", async () => {
	const f = fixture();
	f.idle(true);
	f.inbox.request();
	f.inbox.shutdown();
	await tick();
	assert.equal(f.sent.length, 0);
	f.inbox.start(f.ctx);
	await tick();
	f.branch.push({ type: "custom_message", ...f.sent[0] });
	f.inbox.shutdown();
	f.inbox.start(f.ctx);
	await tick();
	assert.equal(f.sent.length, 1);
	assert.equal(f.records[0].handled, true);
	f.inbox.shutdown();
});
