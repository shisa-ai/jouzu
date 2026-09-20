import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheWarmAdmission } from "../dist/flow-control/cache-warm-admission.js";

function fixture({ cancellationLookup } = {}) {
	const records = [],
		model = { api: "openai-completions", provider: "fixture", id: "fixture" };
	const context = { messages: [{ role: "user", content: "source" }] };
	const controller = new AbortController();
	let cancelled = false,
		current = true,
		sessionId = "session";
	const request = cacheWarmAdmission({
		session: {
			sessionManager: {
				getSessionId: () => sessionId,
				appendCustomEntry: (_type, data) => records.push(data),
				flush() {},
			},
		},
		store: {
			scope: { sessionId: "session" },
			cancelledSources: cancellationLookup ?? (async () => (cancelled ? [{}] : [])),
		},
		requestId: "conversation",
		model,
		context,
		maxBytes: 1000,
		members: [],
		assertCurrent() {
			if (!current) throw Error("replaced");
		},
	});
	const body = { messages: context.messages, max_tokens: 128 };
	request.capture(body, { ...body, admitted: true });
	const options = {
		signal: controller.signal,
		maxTokens: 1,
		maxRetries: 0,
		onMessageConverted() {
			throw Error("conversational conversion observer must not be called");
		},
		onPayload() {
			throw Error("conversational callback must not be called");
		},
	};
	return {
		request,
		model,
		context,
		records,
		controller,
		options,
		body,
		cancel() {
			cancelled = true;
		},
		replace() {
			current = false;
		},
		switchSession() {
			sessionId = "new";
		},
		send: async (options) => {
			assert.equal(options.onMessageConverted, undefined);
			const payload = await options.onPayload({ ...body, max_tokens: 1 }, model);
			assert.deepEqual(payload, { ...body, max_tokens: 1, admitted: true });
			return { stopReason: "stop" };
		},
	};
}

test("refreshes use independent receipts and never replay conversational callbacks", async () => {
	const f = fixture();
	await f.request.refresh(f.options, f.send);
	await f.request.refresh(f.options, f.send);
	assert.equal(f.records.length, 4);
	assert.notEqual(f.records[0].id, f.records[2].id);
	assert.ok(f.records.every((r) => r.requestId === "conversation"));
	assert.equal(f.records[0].phase, "handoff");
	assert.equal(f.records[1].phase, "settled");
	assert.equal(f.records[0].id, f.records[1].id);
	assert.equal(JSON.stringify(f.records).includes("source"), false);
});

test("refresh admission refuses changed payload, cap, model, context, cancelled sources, and session", async () => {
	for (const reason of ["payload", "cap", "model", "context", "cancelled", "aborted", "replaced", "session"]) {
		const f = fixture();
		if (reason === "context") f.context.messages.push({ role: "user", content: "changed" });
		if (reason === "cancelled") f.cancel();
		if (reason === "aborted") f.controller.abort();
		if (reason === "replaced") f.replace();
		if (reason === "session") f.switchSession();
		await assert.rejects(
			f.request.refresh(f.options, async (options) => {
				await options.onPayload(
					{ ...f.body, max_tokens: reason === "cap" ? 2 : 1, ...(reason === "payload" ? { messages: [] } : {}) },
					reason === "model" ? { ...f.model, id: "other" } : f.model,
				);
				throw Error("should never reach transport");
			}),
		);
		assert.equal(f.records.length, 0, reason);
	}
});

test("refresh callbacks are one-use, cannot outlive a request, and failure permits a new refresh", async () => {
	const f = fixture();
	let callback;
	await assert.rejects(
		f.request.refresh(f.options, async (options) => {
			callback = options.onPayload;
			await callback({ ...f.body, max_tokens: 1 }, f.model);
			await callback({ ...f.body, max_tokens: 1 }, f.model);
		}),
		/repeated/,
	);
	assert.equal(f.records[1].outcome, "error");
	await assert.rejects(callback({ ...f.body, max_tokens: 1 }, f.model), /repeated/);
	await f.request.refresh(f.options, f.send);
	assert.equal(f.records.length, 4);
	await assert.rejects(
		f.request.refresh(f.options, async (options) => {
			callback = options.onPayload;
			return { stopReason: "stop" };
		}),
		/without admission/,
	);
	await assert.rejects(callback({ ...f.body, max_tokens: 1 }, f.model), /outlived/);
	assert.equal(f.records.length, 4);
});

test("overlapping refreshes are refused and separate parent admissions are isolated", async () => {
	const first = fixture(),
		second = fixture();
	await first.request.refresh(first.options, async (options) => {
		await assert.rejects(first.request.refresh(first.options, first.send), /available admission/);
		await second.request.refresh(second.options, second.send);
		return first.send(options);
	});
	assert.equal(first.records.length, 2);
	assert.equal(second.records.length, 2);
});

test("a callback waiting on cancellation cannot admit after its request ends", async () => {
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const f = fixture({ cancellationLookup: () => gate });
	let pending;
	await assert.rejects(
		f.request.refresh(f.options, async (options) => {
			pending = options.onPayload({ ...f.body, max_tokens: 1 }, f.model);
			return { stopReason: "stop" };
		}),
		/without admission/,
	);
	release([]);
	await assert.rejects(pending, /outlived/);
	assert.equal(f.records.length, 0);
});

test("unknown output-cap shapes disable refresh only", async () => {
	const f = fixture();
	// A fresh admission without a recognized cap remains unavailable, without throwing from capture.
	const noCap = cacheWarmAdmission({
		session: {},
		store: {},
		requestId: "x",
		model: f.model,
		context: f.context,
		maxBytes: 1000,
		members: [],
		assertCurrent() {},
	});
	noCap.capture({}, {});
	await assert.rejects(noCap.refresh(f.options, f.send), /available admission/);
	assert.equal(f.records.length, 0);
});
