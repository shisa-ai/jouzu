import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFile, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assistant, createFlowSession, deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { PiHistoryReceipts, verifyPiHistoryEntry } from "../dist/flow-control/pi-history-receipts.js";
import { recoverPiHistory } from "../dist/flow-control/pi-history-recovery.js";
import { PiQueueReceipts } from "../dist/flow-control/pi-queue-receipts.js";
import { projectFlowSubmissions } from "../dist/flow-control/submission-view.js";

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const member = { id: "work", revision: "1", kind: "work", required: true, contentHash: "a".repeat(64) };
const cleanupTasks = new WeakMap();
async function rootFor(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-history-"));
	cleanupTasks.set(t, []);
	t.after(async () => {
		for (const cleanup of cleanupTasks.get(t).reverse()) await cleanup();
		await rm(root, { recursive: true, force: true });
	});
	return root;
}

test("an append return does not acknowledge buffered or in-memory history", async (t) => {
	const root = await rootFor(t);
	const manager = SessionManager.create(root, join(root, "history"));
	const id = manager.appendMessage(user("initial"));
	assert.deepEqual(await verifyPiHistoryEntry(manager, id), { kind: "buffered" });
	manager.appendMessage(assistant());
	assert.deepEqual(await verifyPiHistoryEntry(manager, id), {
		kind: "persisted",
		entryHash: createHash("sha256")
			.update(JSON.stringify(manager.getEntry(id)))
			.digest("hex"),
	});
	const memory = SessionManager.inMemory(root);
	const memoryId = memory.appendMessage(user("memory"));
	assert.deepEqual(await verifyPiHistoryEntry(memory, memoryId), { kind: "memory" });
});

test("an unterminated last append has no receipt while earlier complete entries remain valid", async (t) => {
	const root = await rootFor(t);
	const manager = SessionManager.create(root, join(root, "history"));
	const first = manager.appendMessage(user("first"));
	manager.appendMessage(assistant());
	const last = manager.appendMessage(user("日本語"));
	const bytes = await readFile(manager.getSessionFile());
	await truncate(manager.getSessionFile(), bytes.length - 1);
	assert.equal((await verifyPiHistoryEntry(manager, first)).kind, "persisted");
	assert.equal((await verifyPiHistoryEntry(manager, last)).kind, "buffered");
	await appendFile(manager.getSessionFile(), "\n");
	assert.equal((await verifyPiHistoryEntry(manager, last)).kind, "persisted");
});

for (const mode of ["changed", "duplicate", "malformed"]) {
	test(`history verification rejects ${mode} data without repairing or overwriting it`, async (t) => {
		const root = await rootFor(t);
		const manager = SessionManager.create(root, join(root, "history"));
		const id = manager.appendMessage(user("original"));
		manager.appendMessage(assistant());
		const original = await readFile(manager.getSessionFile(), "utf8");
		let changed;
		if (mode === "changed") changed = original.replace('"text":"original"', '"text":"altered"');
		if (mode === "duplicate") changed = `${original}${JSON.stringify(manager.getEntry(id))}\n`;
		if (mode === "malformed") changed = `${original}{broken}\n`;
		await writeFile(manager.getSessionFile(), changed);
		await assert.rejects(verifyPiHistoryEntry(manager, id));
		assert.equal(await readFile(manager.getSessionFile(), "utf8"), changed);
	});
}

test("verification bounds total bytes and handles multibyte content across read chunks", async (t) => {
	const root = await rootFor(t);
	const manager = SessionManager.create(root, join(root, "history"));
	const id = manager.appendMessage(user("日本語".repeat(30000)));
	manager.appendMessage(assistant());
	const bytes = await readFile(manager.getSessionFile());
	await assert.rejects(verifyPiHistoryEntry(manager, id, bytes.length - 1), { code: "capacity" });
	assert.equal((await verifyPiHistoryEntry(manager, id, bytes.length)).kind, "persisted");
});

async function fixture(t, persist = true, checkpoints) {
	const root = await rootFor(t);
	const host = await createFlowSession(t, { persist, checkpoints });
	const attachment = await PiFlowAttachment.open(root, { sessionId: host.session.sessionId, branchId: "main" });
	const queue = new PiQueueReceipts(host.session.agent, attachment.ledger);
	const history = new PiHistoryReceipts(host.session, attachment.ledger);
	cleanupTasks.get(t).push(async () => {
		history.close();
		queue.close();
		await attachment.close();
	});
	await host.session.prompt("initial");
	host.requests.length = 0;
	await attachment.ledger.select("attempt", [member]);
	await queue.enqueue("attempt", () => host.session.followUp("owned input"));
	return { ...host, attachment, queue, history };
}

test("the live AgentSession observer records verified history before the provider request", async (t) => {
	let attachment;
	let checking = false;
	const observed = [];
	const result = await fixture(t, true, {
		beforeRequest: async () => {
			if (checking) observed.push((await attachment.ledger.snapshot()).attempts[0].history);
		},
	});
	({ attachment } = result);
	checking = true;
	await result.session.agent.continue();
	assert.equal(result.requests.length, 1);
	assert.equal(observed[0].length, 1);
	assert.equal(observed[0][0].id, member.id);
	assert.match(observed[0][0].entryHash, /^[a-f0-9]{64}$/);
	const entry = result.session.sessionManager.getEntry(observed[0][0].entryId);
	assert.equal(entry.message.content[0].text, "owned input");
});

test("in-memory execution never invents a durable history receipt", async (t) => {
	const { session, attachment } = await fixture(t, false);
	await session.agent.continue();
	assert.deepEqual((await attachment.ledger.snapshot()).attempts[0].history, []);
});

test("receipt-store failure after Pi persistence prevents a provider invocation", async (t) => {
	const { session, requests, attachment } = await fixture(t);
	t.mock.method(attachment.ledger, "history", async () => {
		throw new Error("Receipt storage unavailable");
	});
	await assert.rejects(session.agent.continue(), /Receipt storage unavailable/);
	assert.equal(requests.length, 0);
	assert.ok(
		session.sessionManager
			.getBranch()
			.some(
				(entry) =>
					entry.type === "message" && entry.message.role === "user" && entry.message.content[0].text === "owned input",
			),
	);
	assert.deepEqual((await attachment.ledger.snapshot()).attempts[0].history, []);
});

test("abort after native removal clears unmatched claims without assigning them to an error message", async (t) => {
	const entered = deferred();
	const release = deferred();
	const { session, requests, attachment } = await fixture(t);
	const claim = attachment.ledger.claim.bind(attachment.ledger);
	t.mock.method(attachment.ledger, "claim", async (...args) => {
		entered.resolve();
		await release.promise;
		await claim(...args);
	});
	const running = session.agent.continue();
	await entered.promise;
	session.agent.abort();
	release.resolve();
	await running;
	assert.equal(requests.length, 0);
	assert.deepEqual((await attachment.ledger.snapshot()).attempts[0].history, []);
});

test("a recorded history hash cannot be replaced under the same entry identity", async (t) => {
	const { session, attachment, history } = await fixture(t);
	await session.agent.continue();
	const [receipt] = (await attachment.ledger.snapshot()).attempts[0].history;
	await assert.rejects(attachment.ledger.history("attempt", [{ ...receipt, entryHash: "0".repeat(64) }]), {
		code: "identity",
	});
	await history.flush();
	assert.deepEqual((await attachment.ledger.snapshot()).attempts[0].history, [receipt]);
	history.close();
	await assert.rejects(history.flush(), { code: "stale" });
});

for (const boundary of ["before-receipt", "after-receipt"]) {
	test(`process kill ${boundary} preserves the Pi history and only committed history receipts`, {
		timeout: 15000,
	}, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "jouzu-flow-history-kill-"));
		let attachment;
		const child = fork(new URL("./fixtures/flow-history-crash.mjs", import.meta.url), [root, boundary], {
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		t.after(async () => {
			if (child.exitCode === null && child.signalCode === null) {
				const ended = once(child, "exit");
				child.kill("SIGKILL");
				await ended;
			}
			await attachment?.close();
			await rm(root, { recursive: true, force: true });
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const [ready] = await Promise.race([
			once(child, "message"),
			once(child, "exit").then(() => {
				throw new Error(`History fixture exited: ${stderr}`);
			}),
		]);
		assert.equal(ready.requests, 0);
		const ended = once(child, "exit");
		child.kill("SIGKILL");
		await ended;
		attachment = await PiFlowAttachment.open(join(root, "receipts"), ready.scope);
		const [attempt] = (await attachment.ledger.snapshot()).attempts;
		assert.equal(attempt.phase, "cancelled");
		assert.equal(attempt.consumed, true);
		const [retained] = projectFlowSubmissions(
			await attachment.submissions.snapshot(),
			await attachment.ledger.snapshot(),
		);
		assert.equal(retained.admission, "held");
		assert.equal(retained.delivery, boundary === "after-receipt" ? "history" : "consumed");
		assert.deepEqual(attempt.history, boundary === "after-receipt" ? [ready.receipt] : []);
		const originalBytes = await readFile(ready.historyFile);
		const restored = await recoverPiHistory(SessionManager.open(ready.historyFile), attachment.ledger);
		assert.deepEqual(restored, { recovered: boundary === "before-receipt" ? 1 : 0, unresolved: 0 });
		assert.deepEqual((await attachment.ledger.snapshot()).attempts[0].history, [ready.receipt]);
		assert.deepEqual(await readFile(ready.historyFile), originalBytes);
		const entries = (await readFile(ready.historyFile, "utf8"))
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		const entry = entries.find((candidate) => candidate.id === ready.receipt.entryId);
		assert.equal(createHash("sha256").update(JSON.stringify(entry)).digest("hex"), ready.receipt.entryHash);
	});
}
