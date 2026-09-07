import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { MAX_SCAN_BYTES } from "../dist/textguard.js";
import { TextGuardAdmission } from "../dist/textguard-admission.js";
import { snapshotPayload } from "../dist/textguard-payload.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");

test("snapshot identity matches complete JSON bytes across Unicode, escapes, and chunk boundaries", () => {
	for (const text of ["", `${"x".repeat(4095)}🐈`, `${"x".repeat(4096)}🐈`, '\uFEFF日本語\r\n\t\\"\u0000\u202e']) {
		const items = [1, true, null];
		items.length = 4;
		items.push(undefined);
		const value = { text, details: { items, omitted: undefined } };
		const encoded = JSON.stringify(value);
		const snapshot = snapshotPayload(value);
		assert.equal(snapshot.status, "identified");
		assert.equal(snapshot.text, encoded);
		assert.equal(snapshot.digest, sha(encoded));
		assert.equal(JSON.stringify(snapshot.value), encoded);
	}
});

test("snapshot copies structured payloads before asynchronous checks can observe mutation", () => {
	const source = JSON.parse(
		'{"__proto__":{"text":"original"},"content":[{"type":"text","text":"BODY"}],"details":{"html":"DETAIL"}}',
	);
	const snapshot = snapshotPayload(source);
	source.details.html = "MUTATED";
	source.content[0].text = "MUTATED";
	assert.equal(snapshot.value.details.html, "DETAIL");
	assert.equal(snapshot.value.content[0].text, "BODY");
	assert.equal(Object.getPrototypeOf(snapshot.value), Object.prototype);
	assert.equal(Object.hasOwn(snapshot.value, "__proto__"), true);
	assert.equal(snapshot.value.__proto__.text, "original");
});

test("oversized scan text retains a full identity without retaining a second serialized body", () => {
	const input = { content: [{ type: "text", text: "x".repeat(MAX_SCAN_BYTES + 1) }], details: { body: "suffix" } };
	const snapshot = snapshotPayload(input);
	assert.equal(snapshot.status, "identified");
	assert.equal(snapshot.text, undefined);
	assert.equal(snapshot.digest, sha(JSON.stringify(input)));
	assert.equal(snapshot.value.details.body, "suffix");
	assert.deepEqual(snapshotPayload("x".repeat(16 * 1024 * 1024 + 1)), { status: "unavailable", reason: "input-limit" });
});

test("malformed, cyclic, deep, and accessor-bearing payloads cannot obtain approvable identities", () => {
	const cyclic = {};
	cyclic.self = cyclic;
	let deep = {};
	for (let i = 0; i < 33; i++) deep = { next: deep };
	let calls = 0;
	const getter = {
		get content() {
			calls++;
			return "HIDDEN";
		},
	};
	for (const input of [cyclic, getter, "\ud800", NaN, Infinity, new Date(), { f() {} }])
		assert.deepEqual(snapshotPayload(input), { status: "unavailable", reason: "protocol" });
	assert.equal(calls, 0);
	assert.deepEqual(snapshotPayload(deep), { status: "unavailable", reason: "budget" });
	assert.deepEqual(snapshotPayload(Array(8193).fill(0)), { status: "unavailable", reason: "budget" });
});

test("complete oversized identities support exact session approval, never cancellation or changed payloads", async () => {
	const scanner = {
		async initialize() {
			return "a".repeat(64);
		},
		async scan() {
			throw Error("Oversized input must not be scanned");
		},
		async close() {},
	};
	const gate = new TextGuardAdmission(scanner);
	const snapshot = snapshotPayload({ text: "x".repeat(MAX_SCAN_BYTES + 1) });
	const first = await gate.checkUnavailableSnapshot("web:fixture", snapshot.digest, "input-limit");
	assert.equal(first.allowed, false);
	assert.equal(first.review.evidence.reason, "input-limit");
	assert.equal(gate.approve(first.review.id), true);
	assert.equal((await gate.checkUnavailableSnapshot("web:fixture", snapshot.digest, "input-limit")).allowed, true);
	assert.equal((await gate.check("web:fixture", JSON.stringify(snapshot.value))).allowed, true);
	assert.equal((await gate.checkUnavailableSnapshot("web:fixture", sha("changed"), "input-limit")).allowed, false);
	assert.equal(
		(await gate.checkUnavailableSnapshot("web:fixture", snapshot.digest, "input-limit", AbortSignal.abort())).allowed,
		false,
	);
	gate.clearApprovals();
	assert.equal((await gate.checkUnavailableSnapshot("web:fixture", snapshot.digest, "input-limit")).allowed, false);
	await assert.rejects(
		gate.checkUnavailableSnapshot("web:fixture", "not-a-digest", "input-limit"),
		/Invalid TextGuard/,
	);
});
