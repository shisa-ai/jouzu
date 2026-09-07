import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewLabel, TextGuardAdmission } from "../dist/textguard-admission.js";
import { NativeTextGuard } from "../dist/textguard-native.js";

const verdict = (severity) => ({
	status: severity ? "findings" : "clear",
	findings: severity ? [{ kind: "bidi", severity, offset: 0, codepoint: "U+202E" }] : [],
	findingCount: severity ? 1 : 0,
	severityCounts: {
		info: severity === "info" ? 1 : 0,
		warn: severity === "warn" ? 1 : 0,
		error: severity === "error" ? 1 : 0,
	},
	decodeReasons: [],
});
function scanner(evidence = verdict()) {
	return {
		identity: "a".repeat(64),
		async initialize() {
			return this.identity;
		},
		async scan() {
			return evidence;
		},
		async close() {},
	};
}

test("only complete clear, info, and warn verdicts pass without approval", async () => {
	for (const severity of [undefined, "info", "warn", "error"]) {
		const gate = new TextGuardAdmission(scanner(verdict(severity)));
		assert.equal((await gate.check("fixture", "text")).allowed, severity !== "error");
	}
	for (const evidence of [
		{ status: "clear", findings: [] },
		{ status: "unavailable", reason: "timeout", findings: [] },
		{ ...verdict(), decodeReasons: ["encoding:decode_bound_hit"] },
	]) {
		assert.equal((await new TextGuardAdmission(scanner(evidence)).check("fixture", "text")).allowed, false);
	}
	const failure = scanner();
	failure.scan = async () => {
		throw new Error("PRIVATE BODY");
	};
	const report = await new TextGuardAdmission(failure).check("fixture", "text");
	assert.equal(report.allowed, false);
	assert.equal(JSON.stringify(report).includes("PRIVATE BODY"), false);
});

test("approval is exact-source, content, scanner, and session bound", async () => {
	const source = scanner(verdict("error"));
	const gate = new TextGuardAdmission(source);
	const first = await gate.check("skill-a", "text");
	assert.equal(first.allowed, false);
	assert.equal(first.approved, false);
	assert.equal(gate.approve("unknown"), false);
	assert.equal(gate.approve(first.review.id), true);
	const same = await gate.check("skill-a", "text");
	assert.equal(same.allowed, true);
	assert.equal(same.approved, true);
	assert.equal((await gate.check("skill-b", "text")).allowed, false);
	assert.equal((await gate.check("skill-a", "changed")).allowed, false);
	source.identity = "b".repeat(64);
	assert.equal((await gate.check("skill-a", "text")).allowed, false);
	source.identity = "a".repeat(64);
	assert.equal((await new TextGuardAdmission(source).check("skill-a", "text")).allowed, false);
	gate.clearApprovals();
	assert.equal((await gate.check("skill-a", "text")).allowed, false);
});

test("unavailable coverage can be explicitly approved but cancellation and invalid UTF-8 cannot", async () => {
	const gate = new TextGuardAdmission(scanner({ status: "unavailable", reason: "timeout", findings: [] }));
	const missing = await gate.check("web", "content");
	gate.approve(missing.review.id);
	assert.equal((await gate.check("web", "content")).allowed, true);
	assert.equal((await gate.check("web", "content", AbortSignal.abort())).allowed, false);
	const invalid = await gate.check("web", "\ud800");
	assert.equal(invalid.allowed, false);
	assert.equal(gate.approve(invalid.review.id), false);
	const large = await gate.check("web", "x".repeat(262145));
	assert.equal(large.allowed, false);
	assert.equal(large.review.evidence.reason, "input-limit");
	assert.equal(gate.approve(large.review.id), true);
});

test("review records are bounded, contain no source body, and cannot be mutated by readers", async () => {
	const gate = new TextGuardAdmission(scanner(verdict("error")));
	for (let i = 0; i < 140; i++) await gate.check(`source ${i}`, "PRIVATE BODY");
	const records = gate.reviews();
	assert.equal(records.length, 128);
	assert.equal(JSON.stringify(records).includes("PRIVATE BODY"), false);
	records[0].id = "forged";
	assert.equal(gate.approve("forged"), false);
	const label = reviewLabel("path\n\u001b[31m\u202e\udb40\udc01");
	for (const control of ["\n", "\u001b", "\u202e"]) assert.equal(label.includes(control), false);
	assert.match(label, /\\u202e/);
});

test("blocked scans retain the exact body for the reviewer, in a bounded identity-bound store", async () => {
	const gate = new TextGuardAdmission(scanner(verdict("error")));
	const ids = [];
	for (let i = 0; i < 9; i++) {
		const decision = await gate.check(`source ${i}`, `PRIVATE BODY ${i}`);
		ids.push(decision.review.id);
	}
	// Reviews stay metadata-only; bodies live in the separate bounded snapshot store.
	assert.equal(JSON.stringify(gate.reviews()).includes("PRIVATE BODY"), false);
	// Only the most recent eight blocked reviews retain their bodies.
	assert.equal(gate.snapshotFor(ids[0])?.body, undefined);
	assert.equal(gate.snapshotFor(ids[1])?.body, "PRIVATE BODY 1");
	assert.equal(gate.snapshotFor(ids[8])?.body, "PRIVATE BODY 8");
	// Access is bound to the exact reviewed identity.
	assert.equal(gate.snapshotFor("forged"), undefined);
	assert.equal(gate.snapshotFor(ids[8].slice(0, 63)), undefined);
	// Session reset clears the store.
	gate.clearApprovals();
	assert.equal(gate.snapshotFor(ids[8]), undefined);
});

test("unavailable snapshots and invalid Unicode keep the source label but no viewable body", async () => {
	const gate = new TextGuardAdmission(scanner({ status: "unavailable", reason: "scanner", findings: [] }));
	const missing = await gate.checkUnavailableSnapshot("web", "b".repeat(64), "input-limit");
	assert.equal(gate.snapshotFor(missing.review.id)?.body, undefined);
	assert.match(gate.snapshotFor(missing.review.id)?.source ?? "", /web/);
	const invalid = await gate.check("web", "\ud800");
	assert.equal(gate.snapshotFor(invalid.review.id)?.body, undefined);
});

test("reset invalidates in-flight decisions without repopulating pending reviews", async () => {
	const source = scanner();
	let release;
	source.scan = () =>
		new Promise((resolve) => {
			release = resolve;
		});
	const gate = new TextGuardAdmission(source);
	const pending = gate.check("skill", "text");
	await new Promise((resolve) => setImmediate(resolve));
	gate.clearApprovals();
	release(verdict("error"));
	const decision = await pending;
	assert.equal(decision.allowed, false);
	assert.equal(decision.review.evidence.reason, "closed");
	assert.equal(gate.reviews().length, 0);
	assert.equal(gate.approve(decision.review.id), false);
});

test("native multilingual text is admitted and major findings require user approval", async () => {
	const native = new NativeTextGuard();
	const gate = new TextGuardAdmission(native);
	try {
		assert.equal((await gate.check("skill", "日本語の資料を確認します。")).allowed, true);
		const blocked = await gate.check("web", "hello\u202eworld");
		assert.equal(blocked.allowed, false);
		assert.ok(blocked.review.evidence.severityCounts.error > 0);
		gate.approve(blocked.review.id);
		assert.equal((await gate.check("web", "hello\u202eworld")).allowed, true);
	} finally {
		await native.close();
	}
});
