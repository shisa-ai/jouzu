import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { smokeDevelopmentRuntime } from "./dev-smoke.mjs";

function fixture(t, source) {
	const root = mkdtempSync(join(tmpdir(), "jouzu-smoke-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const entry = join(root, "cli.mjs");
	writeFileSync(entry, source);
	return entry;
}

test("source smoke uses isolated offline state and validates an idle response", (t) => {
	const entry = fixture(
		t,
		`import assert from 'node:assert/strict';
assert.equal(process.env.PI_OFFLINE, '1');
assert.equal(process.env.JOUZU_NO_UPDATE, '1');
assert.ok(process.env.JOUZU_HOME.endsWith('Jouzu 上手'));
let input = ''; for await (const chunk of process.stdin) input += chunk;
assert.equal(JSON.parse(input).type, 'get_state');
console.log(JSON.stringify({ id: 'dev-build', type: 'response', command: 'get_state', success: true, data: { isStreaming: false } }));`,
	);
	assert.doesNotThrow(() => smokeDevelopmentRuntime(entry));
});

test("source smoke rejects malformed, missing, failed, and persistent responses", (t) => {
	for (const response of [
		"not json",
		"{}",
		JSON.stringify({ id: "dev-build", type: "response", command: "get_state", success: false }),
		JSON.stringify({
			id: "dev-build",
			type: "response",
			command: "get_state",
			success: true,
			data: { isStreaming: false, sessionFile: "saved" },
		}),
	]) {
		assert.throws(
			() => smokeDevelopmentRuntime(fixture(t, `console.log(${JSON.stringify(response)})`)),
			/invalid output/,
		);
	}
});

test("source smoke bounds startup duration and output", (t) => {
	assert.throws(
		() => smokeDevelopmentRuntime(fixture(t, "setInterval(() => {}, 1000)"), { timeout: 100 }),
		/timed out/,
	);
	assert.throws(() => smokeDevelopmentRuntime(fixture(t, "console.log('x'.repeat(1100000))")), /failed/);
});
