import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeTextGuard } from "../dist/textguard-native.js";

test("request count is bounded before initialization and cancelled queue slots are reusable", async () => {
	const scanner = new NativeTextGuard();
	try {
		const active = scanner.scan("first", 5000);
		const controller = new AbortController();
		const cancelled = scanner.scan("cancelled", 5000, controller.signal);
		const queued = Array.from({ length: 14 }, () => scanner.scan("queued", 5000));
		assert.equal((await scanner.scan("overflow")).reason, "busy");
		controller.abort();
		assert.equal((await cancelled).reason, "timeout");
		const replacement = scanner.scan("replacement", 5000);
		assert.equal((await active).status, "clear");
		for (const result of await Promise.all(queued)) assert.equal(result.status, "clear");
		assert.equal((await replacement).status, "clear");
	} finally {
		await scanner.close();
	}
});

test("repeated immediate shutdown drains admitted work", async () => {
	for (let i = 0; i < 10; i++) {
		const scanner = new NativeTextGuard();
		const scans = Array.from({ length: 4 }, () => scanner.scan("fixture"));
		await scanner.close();
		for (const result of await Promise.all(scans)) assert.equal(result.reason, "closed");
	}
});

test("missing packaged artifacts remain unavailable", async () => {
	const scanner = new NativeTextGuard(new URL("./missing-artifacts", import.meta.url).pathname);
	try {
		assert.equal((await scanner.scan("fixture")).status, "unavailable");
	} finally {
		await scanner.close();
	}
});
