import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLabelPolicy, labelPolicyPath } from "../dist/label-policy.js";

test("global label settings persist, notify same-process subscribers, and reject malformed state", (t) => {
	const configDir = mkdtempSync(join(tmpdir(), "jouzu-label-policy-"));
	t.after(() => rmSync(configDir, { recursive: true, force: true }));
	const paths = { configDir };
	const first = createLabelPolicy(paths),
		second = createLabelPolicy(paths);
	assert.deepEqual(first.load(), { enabled: true });
	let updates = 0;
	const unsubscribe = second.subscribe(() => updates++);
	first.write(false);
	assert.deepEqual(second.load(), { enabled: false });
	assert.equal(updates, 1);
	unsubscribe();
	first.write(true);
	assert.equal(updates, 1);
	assert.deepEqual(createLabelPolicy(paths).load(), { enabled: true });
	const path = labelPolicyPath(paths);
	for (const invalid of [
		"broken",
		'{"schemaVersion":1,"enabled":"yes"}',
		'{"schemaVersion":1,"enabled":true,"unknown":1}',
	]) {
		writeFileSync(path, invalid);
		assert.equal(first.load().enabled, false);
		assert.ok(first.load().error);
		assert.throws(() => first.write(true));
		assert.equal(readFileSync(path, "utf8"), invalid);
	}
});
