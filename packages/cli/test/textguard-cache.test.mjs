import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CachedTextGuard } from "../dist/textguard-cache.js";
import { NativeTextGuard } from "../dist/textguard-native.js";

function counting(identity = "a".repeat(64), outcome) {
	return {
		calls: 0,
		async initialize() {
			return identity;
		},
		async scan() {
			this.calls++;
			return (
				outcome ?? {
					status: "clear",
					findings: [],
					findingCount: 0,
					severityCounts: { info: 0, warn: 0, error: 0 },
					decodeReasons: [],
				}
			);
		},
		async close() {},
	};
}

test("complete verdicts survive restart without retaining content or approving findings", async () => {
	const directory = await mkdtemp(join(tmpdir(), "jouzu-verdict-test-"));
	const path = join(directory, "verdicts.json");
	const text = "PRIVATE-SOURCE-MARKER\u202e";
	const first = new CachedTextGuard(new NativeTextGuard(), path);
	try {
		const report = await first.scan(text);
		assert.equal(report.status, "findings");
		assert.ok(report.severityCounts.error > 0);
		const identity = first.identity;
		await first.close();
		assert.equal((await readFile(path, "utf8")).includes("PRIVATE-SOURCE-MARKER"), false);
		const scanner = counting(identity);
		const second = new CachedTextGuard(scanner, path);
		try {
			const cached = await second.scan(text);
			assert.equal(cached.status, "findings");
			assert.ok(cached.severityCounts.error > 0);
			assert.equal(scanner.calls, 0);
			cached.findings.length = 0;
			assert.ok((await second.scan(text)).findings.length > 0);
			await second.scan(`${text}changed`);
			assert.equal(scanner.calls, 1);
		} finally {
			await second.close();
		}
	} finally {
		await first.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("corrupt, mismatched, oversized, and incomplete records cause rescanning", async () => {
	const directory = await mkdtemp(join(tmpdir(), "jouzu-verdict-test-"));
	const path = join(directory, "verdicts.json");
	try {
		const first = new CachedTextGuard(counting(), path);
		await first.scan("fixture");
		await first.close();
		const valid = await readFile(path, "utf8");
		const changed = JSON.parse(valid);
		changed.records[0].response = "{}";
		for (const text of [
			"broken",
			JSON.stringify({ ...JSON.parse(valid), identity: "b".repeat(64) }),
			JSON.stringify(changed),
			" ".repeat(262145),
		]) {
			await writeFile(path, text);
			const scanner = counting();
			const cache = new CachedTextGuard(scanner, path);
			try {
				assert.equal((await cache.scan("fixture")).status, "clear");
				assert.equal(scanner.calls, 1);
			} finally {
				await cache.close();
			}
		}
		const failing = counting(undefined, { status: "unavailable", reason: "timeout", findings: [] });
		const cache = new CachedTextGuard(failing);
		try {
			await cache.scan("fixture");
			await cache.scan("fixture");
			assert.equal(failing.calls, 2);
		} finally {
			await cache.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("cache input validation prevents surrogate hash aliases and respects cancellation", async () => {
	const scanner = counting();
	const cache = new CachedTextGuard(scanner);
	try {
		await cache.scan("\ufffd");
		assert.equal((await cache.scan("\ud800")).reason, "protocol");
		assert.equal((await cache.scan("x".repeat(262145))).reason, "input-limit");
		assert.equal((await cache.scan("\ufffd", 0)).reason, "timeout");
		assert.equal((await cache.scan("\ufffd", 2000, AbortSignal.abort())).reason, "timeout");
		assert.equal(scanner.calls, 1);
	} finally {
		await cache.close();
	}
});

test("persisted verdict count and bytes stay bounded", async () => {
	const directory = await mkdtemp(join(tmpdir(), "jouzu-verdict-test-"));
	const path = join(directory, "verdicts.json");
	const scanner = counting();
	const cache = new CachedTextGuard(scanner, path);
	try {
		for (let i = 0; i < 140; i++) await cache.scan(`fixture ${i}`);
		await cache.close();
		const text = await readFile(path, "utf8");
		assert.ok(Buffer.byteLength(text) <= 262144);
		assert.equal(JSON.parse(text).records.length, 128);
	} finally {
		await cache.close();
		await rm(directory, { recursive: true, force: true });
	}
});
