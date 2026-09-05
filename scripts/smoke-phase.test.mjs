import assert from "node:assert/strict";
import test from "node:test";
import { smokePhase } from "./smoke-phase.mjs";

test("phase reports its start before work and returns the result with elapsed time", async () => {
	const logs = [];
	const value = await smokePhase(
		"baseline install",
		async () => {
			assert.equal(logs.length, 1);
			assert.match(logs[0], /START baseline install \(\d+\.\d{3}s\)$/);
			return 42;
		},
		(line) => logs.push(line),
	);
	assert.equal(value, 42);
	assert.equal(logs.length, 2);
	assert.match(logs[1], /^\[\d{4}-.*Z\] PASS baseline install \(\d+\.\d{3}s\)$/);
});

test("phase reports failure and preserves the error", async () => {
	const failure = new Error("fixture failure");
	for (const action of [
		() => {
			throw failure;
		},
		async () => {
			throw failure;
		},
	]) {
		const logs = [];
		await assert.rejects(
			smokePhase("rollback", action, (line) => logs.push(line)),
			(error) => error === failure,
		);
		assert.equal(logs.length, 2);
		assert.match(logs[1], /FAIL rollback /);
	}
});
