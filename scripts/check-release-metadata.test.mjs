import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-release-metadata.mjs", import.meta.url));
const root = fileURLToPath(new URL("..", import.meta.url));
const realLock = JSON.parse(readFileSync(join(root, "upstream", "pi.lock.json"), "utf8"));

function runWithLock(fixtureLock) {
	const dir = mkdtempSync(join(tmpdir(), "pi-metadata-fixture-"));
	try {
		const lockPath = join(dir, "pi.lock.json");
		writeFileSync(lockPath, JSON.stringify(fixtureLock, null, 2));
		return spawnSync(process.execPath, [script], {
			encoding: "utf8",
			env: { ...process.env, JOUZU_PI_LOCK: lockPath },
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("a pending-qualification Pi lock fails release metadata validation", () => {
	const pending = { ...realLock, compatibilityStatus: "pending-qualification" };
	const result = runWithLock(pending);
	assert.notEqual(result.status, 0, "pending lock must fail release metadata");
	assert.match(result.stderr, /must be qualified for publication/);
});

test("a qualified Pi lock passes release metadata validation", () => {
	const result = runWithLock(realLock);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.match(result.stdout, /release metadata: jouzu@0\.1\.0/);
});
