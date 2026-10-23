import assert from "node:assert/strict";
import { test } from "node:test";
import { UNAVAILABLE_INPUT_REASON } from "../dist/flow-control/submission-view.js";
import { projectUserInputReceipt } from "../dist/flow-control/user-input-receipts.js";

const provenance = { adapterId: "test-input", messageId: "message-1", version: 1 };
const target = "target-branch-1";
const journal = { generation: 3, revision: 11 };
const base = { version: 1, adapterId: "test-input", messageId: "message-1", target, generation: 3, revision: 11 };
const hold = { phase: "submission", reason: "Input is waiting for queued user work." };

const submission = {
	version: 1,
	id: "submission-1",
	api: "prompt",
	origin: { kind: "extension", id: "test-input" },
	scope: { sessionId: "parent", attachmentId: "attachment-1", leafId: null },
	args: ["external message"],
};

function retained({ submission: patch = {}, ...overrides } = {}) {
	return {
		id: "submission-1",
		revision: 1,
		status: "retained",
		acceptedAt: 1,
		submission: { ...submission, ...patch },
		...overrides,
	};
}

function dispatched(dispatch, overrides = {}) {
	return retained({ dispatch: { operationId: "operation-1", ownerId: "owner-1", ...dispatch }, ...overrides });
}

const receipt = (record, extra = {}) => projectUserInputReceipt({ record, provenance, target, journal, ...extra });
const promptInput = (text = "external message") => ({ kind: "prompt", args: [text] });
const queueInput = (id, revision = 1) => ({ kind: "steer", args: ["queued work"], queue: { id, revision } });
const contextInput = () => ({ kind: "context", args: [{ role: "custom", customType: "note", display: false }] });
const claimed = (inputIndex = 0, messageIndex = 0) => ({ inputIndex, messageIndex });
const history = (inputIndex = 0, messageIndex = 0) => ({
	inputIndex,
	messageIndex,
	entryId: "entry-1",
	entryHash: "a".repeat(64),
});

test("an admission hold reads as held until the host claims the message", () => {
	const held = receipt(retained({ holds: [hold] }));
	assert.deepEqual(held, {
		...base,
		state: "held",
		reason: { code: "admission-hold", text: "Input is waiting for admission." },
	});

	const consumed = receipt(
		dispatched({ phase: "returned", inputs: [promptInput()], promptClaims: [claimed()] }, { holds: [hold] }),
	);
	assert.equal(consumed.state, "consumed");
	assert.deepEqual(Object.keys(consumed), [
		"version",
		"adapterId",
		"messageId",
		"target",
		"generation",
		"revision",
		"state",
	]);
});

test("hold receipts do not expose policy diagnostics or message content", () => {
	const projected = receipt(
		retained({ holds: [{ ...hold, reason: "Secret message at /private/adapter.ts\u001b[31m" }] }),
	);
	assert.deepEqual(projected.reason, { code: "admission-hold", text: "Input is waiting for admission." });
});

test("queued needs the exact live queue identity and revision, and is unknown without it", () => {
	const record = dispatched({ phase: "returned", inputs: [queueInput("queue-1")] });
	assert.deepEqual(receipt(record, { liveQueue: new Map([["queue-1", 1]]) }), { ...base, state: "queued" });

	const missing = receipt(record);
	assert.equal(missing.state, "unknown");
	assert.equal(missing.reason.code, "queue-evidence-missing");
	assert.equal(receipt(record, { liveQueue: new Map([["other", 1]]) }).reason.code, "queue-evidence-missing");
	// The host holds the identity at another revision, so it is not holding this input.
	assert.equal(receipt(record, { liveQueue: new Map([["queue-1", 2]]) }).reason.code, "queue-evidence-missing");

	const observed = dispatched({
		phase: "returned",
		inputs: [queueInput("queue-1")],
		queueClaims: [{ id: "queue-1", revision: 1, consumed: false }],
	});
	assert.equal(receipt(observed, { liveQueue: new Map([["queue-1", 1]]) }).state, "queued");
	assert.equal(receipt(observed).state, "unknown");

	const edited = dispatched({
		phase: "returned",
		inputs: [queueInput("queue-1", 2)],
		queueCancellations: [{ id: "queue-1", revision: 1 }],
		queueClaims: [{ id: "queue-1", revision: 1, consumed: false }],
	});
	assert.equal(receipt(edited, { liveQueue: new Map([["queue-1", 2]]) }).state, "queued");

	// A superseded revision is no longer what the host holds, so the pair proves nothing yet.
	const superseded = dispatched({
		phase: "returned",
		inputs: [queueInput("queue-1"), queueInput("queue-1", 2)],
		queueClaims: [{ id: "queue-1", revision: 1, consumed: false }],
	});
	assert.equal(receipt(superseded, { liveQueue: new Map([["queue-1", 2]]) }).state, "unknown");
	assert.equal(receipt(superseded, { liveQueue: new Map([["queue-1", 2]]) }).reason.code, "queue-evidence-missing");
});

test("a queue hold requires the exact live queue revision", () => {
	const record = dispatched(
		{ phase: "returned", inputs: [queueInput("queue-1")] },
		{ holds: [{ phase: "queue", queue: { id: "queue-1", revision: 1 }, reason: "Waiting" }] },
	);
	assert.equal(receipt(record, { liveQueue: new Map([["queue-1", 1]]) }).state, "held");
	for (const liveQueue of [new Map(), new Map([["queue-1", 2]])]) {
		const projected = receipt(record, { liveQueue });
		assert.equal(projected.state, "unknown");
		assert.equal(projected.reason.code, "queue-evidence-missing");
	}
});

test("receipt identity ignores the submitted or transformed text", () => {
	const delivered = (text) => dispatched({ phase: "returned", inputs: [promptInput(text)], promptClaims: [claimed()] });
	const original = receipt(delivered("original text"));
	const transformed = receipt(delivered("text the input handler rewrote"));
	assert.deepEqual(original, transformed);
	assert.equal(original.state, "consumed");
	assert.ok(!JSON.stringify(original).includes("original text"));
	assert.ok(!JSON.stringify(transformed).includes("rewrote"));
});

test("a model failure after the claim cannot undo consumption", () => {
	const failed = dispatched({ phase: "failed", inputs: [promptInput()], promptClaims: [claimed()] });
	assert.equal(receipt(failed).state, "consumed");

	const queued = dispatched({
		phase: "failed",
		inputs: [queueInput("queue-1")],
		queueClaims: [{ id: "queue-1", revision: 1, consumed: true }],
	});
	assert.equal(receipt(queued).state, "consumed");

	const reset = dispatched(
		{ phase: "returned", inputs: [promptInput()], promptClaims: [claimed()] },
		{ status: "cancelled" },
	);
	assert.equal(receipt(reset).state, "consumed");
});

test("a history receipt corroborates consumption without creating it", () => {
	const corroborated = receipt(
		dispatched({ phase: "returned", inputs: [promptInput()], promptClaims: [claimed()], promptHistory: [history()] }),
	);
	assert.equal(corroborated.state, "consumed");

	const unclaimed = receipt(dispatched({ phase: "returned", inputs: [promptInput()], promptHistory: [history()] }));
	assert.equal(unclaimed.state, "unknown");
	assert.equal(unclaimed.reason.code, "dispatch-unconfirmed");
});

test("a cancelled record reads as cancelled only where nothing can still deliver", () => {
	const cancelled = receipt(retained({ status: "cancelled" }));
	assert.deepEqual(cancelled, {
		...base,
		state: "cancelled",
		reason: { code: "submission-cancelled", text: "The retained input was cancelled before delivery." },
	});

	const nativeQueue = receipt(
		dispatched({
			phase: "returned",
			inputs: [queueInput("queue-1")],
			queueCancellations: [{ id: "queue-1", revision: 1 }],
			queueClaims: [{ id: "queue-1", revision: 1, consumed: false }],
		}),
	);
	assert.equal(nativeQueue.state, "cancelled");
	assert.equal(nativeQueue.reason.code, "queue-cancelled");

	const removed = receipt(
		dispatched({
			phase: "returned",
			inputs: [contextInput()],
			contextCancellations: [{ inputIndex: 0, removed: true }],
		}),
	);
	assert.equal(removed.state, "cancelled");
	assert.equal(removed.reason.code, "context-cancelled");

	const intent = receipt(
		dispatched({
			phase: "returned",
			inputs: [queueInput("queue-1")],
			queueCancellations: [{ id: "queue-1", revision: 1 }],
		}),
	);
	assert.equal(intent.state, "unknown");
	assert.equal(intent.reason.code, "cancellation-unconfirmed");

	// The host still holds the identity, so it may still be consumed: not a definitive cancellation.
	const live = dispatched({ phase: "returned", inputs: [queueInput("queue-1")] }, { status: "cancelled" });
	assert.equal(receipt(live, { liveQueue: new Map([["queue-1", 1]]) }).state, "queued");
});

test("a durable cancellation cause names the reason a cancelled receipt reports", () => {
	const suspended = receipt(retained({ status: "cancelled", cancellationReason: "flow-suspended" }));
	assert.equal(suspended.state, "cancelled");
	assert.deepEqual(suspended.reason, {
		code: "flow-suspended",
		text: "Flow control was suspended before this input was delivered.",
	});

	const unauthorized = receipt(retained({ status: "cancelled", cancellationReason: "unauthorized" }));
	assert.equal(unauthorized.state, "cancelled");
	assert.deepEqual(unauthorized.reason, {
		code: "unauthorized",
		text: "The adapter's authorization was revoked before this input was delivered.",
	});

	// Consumption still wins over an administrative cancellation.
	const consumed = receipt(
		dispatched(
			{ phase: "returned", inputs: [promptInput()], promptClaims: [claimed()] },
			{ status: "cancelled", cancellationReason: "flow-suspended" },
		),
	);
	assert.equal(consumed.state, "consumed");
});

test("partial evidence never upgrades a record past what it proves", () => {
	const mixed = receipt(
		dispatched({ phase: "returned", inputs: [promptInput(), queueInput("queue-2")], promptClaims: [claimed()] }),
	);
	assert.equal(mixed.state, "consumed");

	const partialQueue = dispatched({ phase: "returned", inputs: [queueInput("queue-1"), queueInput("queue-2")] });
	assert.equal(receipt(partialQueue, { liveQueue: new Map([["queue-1", 1]]) }).state, "unknown");

	const messages = dispatched({
		phase: "returned",
		inputs: [{ kind: "prompt", args: [[{ role: "user" }, { role: "user" }]] }],
		promptClaims: [claimed(0, 0)],
	});
	assert.equal(receipt(messages).state, "unknown");
	assert.equal(receipt(messages).reason.code, "dispatch-unconfirmed");

	const started = receipt(dispatched({ phase: "started" }));
	assert.equal(started.state, "unknown");
	assert.equal(started.reason.code, "dispatch-unconfirmed");

	const failed = receipt(dispatched({ phase: "failed" }));
	assert.equal(failed.state, "unknown");
	assert.equal(failed.reason.code, "dispatch-failed");

	const inflight = receipt(dispatched({ phase: "started" }, { status: "cancelled" }));
	assert.equal(inflight.state, "unknown");
});

test("a durable record without dispatch intent reads as retained", () => {
	assert.deepEqual(receipt(retained()), { ...base, state: "retained" });
	assert.equal(receipt(retained(), { liveQueue: new Map([["queue-1", 1]]) }).state, "retained");
});

test("a handled prompt that inserted no input reads as rejected", () => {
	const rejected = receipt(dispatched({ phase: "returned", noInput: true }));
	assert.equal(rejected.state, "rejected");
	assert.deepEqual(rejected.reason, {
		code: "handled-without-input",
		text: "The input handler completed without passing this input to the model.",
	});
});

test("an ended callback is unconfirmed and is not replayed by this projection", () => {
	const ended = receipt(retained({ unavailable: "callback-ended" }));
	assert.equal(ended.state, "unknown");
	assert.deepEqual(ended.reason, { code: "callback-ended", text: UNAVAILABLE_INPUT_REASON });
});

test("ordering uses the committed journal position, not the record revision", () => {
	const projected = receipt(retained({ revision: 99 }));
	assert.equal(projected.revision, journal.revision);
	assert.equal(projected.generation, journal.generation);
	assert.notEqual(projected.revision, 99);
});

test("provenance and target come from the caller, never from the record", () => {
	const first = retained({ submission: { origin: { kind: "extension", id: "another-extension" } } });
	const second = retained({ submission: { origin: { kind: "host", id: "someone-else" } } });
	assert.deepEqual(receipt(first), receipt(second));
	assert.deepEqual(
		receipt(first, {
			provenance: { adapterId: "second-adapter", messageId: "message-2", version: 1 },
			target: "target-branch-2",
		}),
		{
			version: 1,
			adapterId: "second-adapter",
			messageId: "message-2",
			target: "target-branch-2",
			generation: 3,
			revision: 11,
			state: "retained",
		},
	);
});

test("a receipt carries only identity, journal position, state, and a safe reason", () => {
	const records = [
		retained(),
		retained({ holds: [hold] }),
		retained({ status: "cancelled" }),
		retained({ status: "cancelled", cancellationReason: "flow-suspended" }),
		retained({ unavailable: "callback-ended" }),
		dispatched({ phase: "returned", noInput: true }),
		dispatched({ phase: "started" }),
		dispatched({ phase: "failed" }),
		dispatched({ phase: "returned", inputs: [queueInput("queue-1")] }),
		dispatched({ phase: "returned", inputs: [promptInput()], promptClaims: [claimed()] }),
	];
	for (const record of records) {
		const projected = receipt(record);
		assert.deepEqual(
			Object.keys(projected).filter((key) => key !== "reason"),
			["version", "adapterId", "messageId", "target", "generation", "revision", "state"],
		);
		assert.deepEqual(JSON.parse(JSON.stringify(projected)), projected);
		const serialized = JSON.stringify(projected);
		assert.ok(!serialized.includes("external message"));
		assert.ok(!serialized.includes("queued work"));
		assert.ok(!serialized.includes("/"));
		if (projected.reason) {
			assert.equal(typeof projected.reason.code, "string");
			assert.ok(projected.reason.text.length > 0 && projected.reason.text.length <= 200);
			assert.ok(
				[...projected.reason.text].every((character) => {
					const code = character.codePointAt(0);
					return code > 0x1f && code !== 0x7f;
				}),
			);
		}
	}
});

test("unusable provenance, target, or journal positions are refused", () => {
	const record = retained();
	for (const invalid of [
		{ provenance: { adapterId: "", messageId: "message-1", version: 1 } },
		{ provenance: { adapterId: "test-input", messageId: "", version: 1 } },
		{ provenance: { adapterId: "test-input", messageId: "x".repeat(513), version: 1 } },
		{ provenance: { adapterId: "test-input", messageId: "message-1", version: 2 } },
		{ target: "" },
		{ target: "x".repeat(1025) },
		{ target: "target\nbranch" },
		{ journal: { generation: -1, revision: 11 } },
		{ journal: { generation: 3, revision: 1.5 } },
	])
		assert.throws(() => receipt(record, invalid), TypeError);
});
