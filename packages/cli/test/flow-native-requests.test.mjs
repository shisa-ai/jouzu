import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assistant, deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { PiNativeRequests } from "../dist/flow-control/pi-native-requests.js";
import { nativeRequests } from "./fixtures/native-requests.mjs";

test("native receipts hash the final real-provider payload after transforms", async (t) => {
	const f = await nativeRequests(t, { transform: ({ payload }) => ({ ...payload, user: "transformed" }) });
	await f.session.prompt("request");
	assert.equal(f.sent.length, 1);
	const [record] = await f.store.snapshot();
	assert.equal(record.outcome, "success");
	assert.equal(f.sent[0].user, "transformed");
	assert.equal(record.payload.hash, createHash("sha256").update(JSON.stringify(f.sent[0])).digest("hex"));
	assert.equal(record.payload.bytes, Buffer.byteLength(JSON.stringify(f.sent[0])));
	assert.equal(record.inclusion, undefined);
	await assert.rejects(f.store.begin(record), { code: "identity" });
	await assert.rejects(f.store.finish(record.id, "failure"), { code: "transition" });
});

test("native handoff persistence blocks fetch and receipts survive reopen", async (t) => {
	const f = await nativeRequests(t);
	const entered = deferred(),
		release = deferred();
	const handoff = f.store.handoff.bind(f.store);
	t.mock.method(f.store, "handoff", async (...args) => {
		entered.resolve();
		await release.promise;
		return handoff(...args);
	});
	const running = f.session.prompt("barrier");
	await entered.promise;
	assert.equal(f.sent.length, 0);
	assert.equal((await f.store.snapshot())[0].payload, undefined);
	await assert.rejects(f.bridge.close(), { code: "busy" });
	release.resolve();
	await running;
	const saved = await f.store.snapshot();
	await f.bridge.close();
	await f.attachment.close();
	const reopened = await PiFlowAttachment.open(join(f.root, "receipts"), f.scope);
	try {
		assert.deepEqual(await reopened.nativeRequests.snapshot(), saved);
		await assert.rejects(reopened.nativeRequests.finish(saved[0].id, "success"), { code: "stale" });
	} finally {
		await reopened.close();
	}
});

test("oversized native payload is withheld without fetch", async (t) => {
	const f = await nativeRequests(t, { maxBytes: 1 });
	await f.session.prompt("oversized");
	assert.equal(f.sent.length, 0);
	const [record] = await f.store.snapshot();
	assert.equal(record.outcome, "withheld");
	assert.equal(record.payload, undefined);
});

test("native receipt attachment rejects duplicates and keeps two sessions separate", async (t) => {
	const first = await nativeRequests(t),
		second = await nativeRequests(t);
	assert.throws(() => new PiNativeRequests(first.session, first.store, 100000), { code: "identity" });
	assert.throws(() => new PiNativeRequests(first.session, second.store, 100000), { code: "scope" });
	await Promise.all([first.session.prompt("first"), second.session.prompt("second")]);
	const [a] = await first.store.snapshot(),
		[b] = await second.store.snapshot();
	assert.notEqual(a.id, b.id);
	assert.notEqual(a.ownerId, b.ownerId);
	assert.notEqual(a.payload.hash, b.payload.hash);
});

test("failed native handoff persistence prevents fetch", async (t) => {
	const f = await nativeRequests(t);
	t.mock.method(f.store, "handoff", async () => {
		throw new Error("handoff unavailable");
	});
	await f.session.prompt("blocked");
	assert.equal(f.sent.length, 0);
	const [record] = await f.store.snapshot();
	assert.equal(record.payload, undefined);
	assert.equal(record.outcome, "withheld");
});

test("native attachment cannot close during request checkpoint persistence", async (t) => {
	const f = await nativeRequests(t);
	const entered = deferred(),
		release = deferred();
	const begin = f.store.begin.bind(f.store);
	t.mock.method(f.store, "begin", async (...args) => {
		entered.resolve();
		await release.promise;
		return begin(...args);
	});
	const running = f.session.prompt("checkpoint");
	await entered.promise;
	await assert.rejects(f.bridge.close(), { code: "busy" });
	assert.equal(f.sent.length, 0);
	release.resolve();
	await running;
	assert.equal((await f.store.snapshot())[0].outcome, "success");
});

test("repeated native payload callbacks cannot overwrite the first handoff", async (t) => {
	const f = await nativeRequests(t, {
		native: async (model, context, options) => {
			await options.onPayload({ messages: context.messages }, model);
			await assert.rejects(options.onPayload({ messages: [] }, model), { code: "transition" });
			return { async *[Symbol.asyncIterator]() {}, result: async () => assistant() };
		},
	});
	await f.session.prompt("once");
	const [record] = await f.store.snapshot();
	assert.equal(record.outcome, "success");
	assert.ok(record.payload.bytes > 20);
});

test("provider omission of payload admission cannot record native success", async (t) => {
	const f = await nativeRequests(t, {
		native: async () => ({
			async *[Symbol.asyncIterator]() {},
			result: async () => assistant(),
		}),
	});
	await f.session.prompt("unqualified");
	assert.equal((await f.store.snapshot())[0].outcome, "withheld");
	assert.match(f.session.agent.state.errorMessage, /without payload admission/);
});

test("broken native stream retains uncertain handoff and drains ownership", async (t) => {
	const f = await nativeRequests(t, {
		native: async (model, context, options) => {
			await options.onPayload({ messages: context.messages }, model);
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "start", partial: assistant() };
					throw new Error("broken stream");
				},
				result: async () => assistant(),
			};
		},
	});
	await f.session.prompt("uncertain");
	const [record] = await f.store.snapshot();
	assert.ok(record.payload);
	assert.equal(record.outcome, undefined);
	await f.session.prompt("another");
	assert.match(f.session.agent.state.errorMessage, /requires reconciliation/);
	assert.equal((await f.store.snapshot()).length, 1);
	await f.bridge.close();
});

for (const phase of ["prepared", "handoff", "outcome"])
	test(`process death at native request ${phase} retains uncertainty without replay`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "jouzu-native-request-kill-"));
		const child = fork(new URL("./fixtures/native-request-crash.mjs", import.meta.url), [root, phase], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		const exited = once(child, "exit");
		let attachment;
		t.after(async () => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await exited;
			}
			await attachment?.close();
			await rm(root, { recursive: true, force: true });
		});
		const [saved] = await Promise.race([
			once(child, "message"),
			exited.then(() => {
				throw new Error("Native request fixture exited before checkpoint");
			}),
		]);
		assert.equal(saved.sent, phase === "outcome" ? 1 : 0);
		child.kill("SIGKILL");
		await exited;
		attachment = await PiFlowAttachment.open(join(root, "receipts"), saved.scope);
		const [record] = await attachment.nativeRequests.snapshot();
		assert.equal(!!record.payload, phase !== "prepared");
		assert.equal(record.outcome, undefined);
		await assert.rejects(attachment.nativeRequests.begin({ ...record, id: "replay" }), { code: "busy" });
		await assert.rejects(attachment.nativeRequests.finish(record.id, "success"), { code: "stale" });
	});
