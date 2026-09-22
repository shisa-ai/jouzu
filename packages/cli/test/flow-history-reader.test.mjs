import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assistant } from "../../../scripts/fixtures/pi-flow-session.mjs";
import {
	piHistoryVerificationStats,
	verifyPiHistoryEntries,
	verifyPiHistoryEntry,
} from "../dist/flow-control/pi-history-reader.js";

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-history-reader-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const manager = SessionManager.create(root, join(root, "sessions"));
	const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
	manager.appendMessage(assistant());
	return { manager, first, path: manager.getSessionFile() };
}

test("174 MiB history verifies in one batch and subsequent host writes scan only the new suffix", async (t) => {
	const { manager, first, path } = await fixture(t);
	const payload = "x".repeat(60 * 1024);
	let last;
	for (let i = 0; i < 3000; i++) last = manager.appendCustomEntry("bounded-state", { payload, i });
	const size = (await stat(path)).size;
	assert.ok(size > 174 * 1024 * 1024);
	const proofs = await verifyPiHistoryEntries(manager, [first, last]);
	assert.equal(proofs.get(first).kind, "persisted");
	assert.equal(proofs.get(last).kind, "persisted");
	assert.equal(piHistoryVerificationStats(manager).scannedBytes, size);
	assert.equal(piHistoryVerificationStats(manager).scans, 1);
	for (let i = 0; i < 100; i++) {
		const id = manager.appendCustomEntry("small", { i });
		assert.equal((await verifyPiHistoryEntry(manager, id)).kind, "persisted");
	}
	const finalSize = (await stat(path)).size;
	assert.equal(piHistoryVerificationStats(manager).scannedBytes, finalSize);
	assert.equal((await verifyPiHistoryEntry(manager, first)).kind, "persisted");
	assert.equal(piHistoryVerificationStats(manager).scannedBytes, finalSize);
	assert.ok(piHistoryVerificationStats(manager).targetBytes > 0);
	const reopened = SessionManager.open(path);
	assert.equal((await verifyPiHistoryEntry(reopened, first)).kind, "persisted");
	assert.equal(piHistoryVerificationStats(reopened).scannedBytes, finalSize);
});

for (const corruption of ["changed", "duplicate", "malformed", "utf8", "header"]) {
	test(`a warm index rejects external ${corruption} before and after a host append`, async (t) => {
		for (const hostAppend of [false, true]) {
			const { manager, first, path } = await fixture(t);
			await verifyPiHistoryEntry(manager, first);
			const original = await readFile(path, "utf8");
			if (corruption === "changed") await writeFile(path, original.replace('"first"', '"other"'));
			if (corruption === "duplicate") await appendFile(path, `${JSON.stringify(manager.getEntry(first))}\n`);
			if (corruption === "malformed") await appendFile(path, "{broken}\n");
			if (corruption === "utf8") await appendFile(path, Buffer.from([0xff, 10]));
			if (corruption === "header") await writeFile(path, original.replace(manager.getSessionId(), "foreign"));
			if (hostAppend) manager.appendCustomEntry("after-external-change", {});
			await assert.rejects(verifyPiHistoryEntry(manager, first), /differs|repeated|invalid/);
			assert.equal(piHistoryVerificationStats(manager).indexedEntries, 0);
		}
	});
}

test("host persistence still validates duplicate IDs and malformed complete records", async (t) => {
	const { manager, first } = await fixture(t);
	await verifyPiHistoryEntry(manager, first);
	manager._persist(manager.getEntry(first), true);
	await assert.rejects(verifyPiHistoryEntry(manager, first), { code: "identity" });
});

test("a host rewrite and file replacement force full revalidation", async (t) => {
	const { manager, first, path } = await fixture(t);
	await verifyPiHistoryEntry(manager, first);
	const bytes = await readFile(path);
	manager._rewriteFile();
	await verifyPiHistoryEntry(manager, first);
	assert.equal(piHistoryVerificationStats(manager).scannedBytes, bytes.length * 2);
	await writeFile(`${path}.replacement`, bytes);
	await rename(`${path}.replacement`, path);
	await verifyPiHistoryEntry(manager, first);
	assert.equal(piHistoryVerificationStats(manager).scannedBytes, bytes.length * 3);
});

test("truncation, partial append and completion do not create an early receipt", async (t) => {
	const { manager, first, path } = await fixture(t);
	await verifyPiHistoryEntry(manager, first);
	const last = manager.appendCustomEntry("partial", { text: "日本語" });
	const size = (await stat(path)).size;
	await truncate(path, size - 1);
	let proofs = await verifyPiHistoryEntries(manager, [first, last]);
	assert.equal(proofs.get(first).kind, "persisted");
	assert.equal(proofs.get(last).kind, "buffered");
	await appendFile(path, "\n");
	proofs = await verifyPiHistoryEntries(manager, [first, last]);
	assert.equal(proofs.get(last).kind, "persisted");
});

test("record buffering is bounded for complete and incomplete oversized lines", async (t) => {
	for (const complete of [false, true]) {
		const { manager, first, path } = await fixture(t);
		await appendFile(path, "x".repeat(1025) + (complete ? "\n" : ""));
		await assert.rejects(verifyPiHistoryEntry(manager, first, { maxEntryBytes: 1024 }), /record exceeds/);
	}
});

test("index capacity falls back to streaming without dropping duplicate-target checks", async (t) => {
	const { manager, first, path } = await fixture(t);
	for (let i = 0; i < 10; i++) manager.appendCustomEntry("state", { i });
	assert.equal((await verifyPiHistoryEntry(manager, first, { maxIndexEntries: 2 })).kind, "persisted");
	assert.equal(piHistoryVerificationStats(manager).indexedEntries, 0);
	await appendFile(path, `${JSON.stringify(manager.getEntry(first))}\n`);
	await assert.rejects(verifyPiHistoryEntry(manager, first, { maxIndexEntries: 2 }), { code: "identity" });
});

test("a foreign persistence observer is not replaced and cannot authorize a cached prefix", async (t) => {
	const { manager, first, path } = await fixture(t);
	const observer = { beforeWrite() {}, afterWrite() {} };
	manager.historyWriteObserver = observer;
	await verifyPiHistoryEntry(manager, first);
	await verifyPiHistoryEntry(manager, first);
	assert.equal(manager.historyWriteObserver, observer);
	assert.equal(piHistoryVerificationStats(manager).scannedBytes, (await stat(path)).size * 2);
});

test("aborted verification returns no proof and branch membership is checked on cached reads", async (t) => {
	const { manager, first } = await fixture(t);
	const last = manager.appendCustomEntry("branch", {});
	await verifyPiHistoryEntry(manager, last);
	const controller = new AbortController();
	controller.abort(new Error("cancelled verification"));
	await assert.rejects(verifyPiHistoryEntry(manager, first, { signal: controller.signal }), /cancelled verification/);
	manager.branch(first);
	await assert.rejects(verifyPiHistoryEntry(manager, last), { code: "identity" });
	assert.equal((await verifyPiHistoryEntry(manager, first)).kind, "persisted");
});

test("an append during a verification cannot publish a stale index or receipt", async (t) => {
	const { manager, first } = await fixture(t);
	manager.appendCustomEntry("large", { value: "x".repeat(200000) });
	const signal = new AbortController().signal;
	let checks = 0;
	t.mock.method(signal, "throwIfAborted", () => {
		if (++checks === 3) manager.appendCustomEntry("concurrent", {});
	});
	await assert.rejects(verifyPiHistoryEntry(manager, first, { signal }), { code: "stale" });
	assert.equal(piHistoryVerificationStats(manager).indexedEntries, 0);
	assert.equal((await verifyPiHistoryEntry(manager, first)).kind, "persisted");
});

test("a failed partial host write invalidates the prefix and leaves the missing entry buffered", async (t) => {
	const { manager, first, path } = await fixture(t);
	await verifyPiHistoryEntry(manager, first);
	const originalSize = (await stat(path)).size;
	t.mock.method(manager, "_persistUnobserved", () => {
		appendFileSync(path, "{");
		throw new Error("write failed");
	});
	assert.throws(() => manager.appendCustomEntry("not-durable", {}), /write failed/);
	const last = manager.getLeafId();
	const proofs = await verifyPiHistoryEntries(manager, [first, last]);
	assert.equal(proofs.get(first).kind, "persisted");
	assert.equal(proofs.get(last).kind, "buffered");
	assert.equal(piHistoryVerificationStats(manager).scannedBytes, originalSize * 2 + 1);
});

test("concurrent batch readers do not double-count new records", async (t) => {
	const { manager, first } = await fixture(t);
	await verifyPiHistoryEntry(manager, first);
	const last = manager.appendCustomEntry("new", {});
	await Promise.all(Array.from({ length: 5 }, () => verifyPiHistoryEntries(manager, [first, last])));
	assert.equal((await verifyPiHistoryEntry(manager, last)).kind, "persisted");
});
