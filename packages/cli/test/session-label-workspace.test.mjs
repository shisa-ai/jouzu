import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { labelWorkspace } from "../dist/session-labels.js";

test("workspace context includes only folder and repository names, with a non-Git fallback", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-label-workspace-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	assert.deepEqual(await labelWorkspace(root), { folder: basename(root) });
	execFileSync("git", ["init", "-q", root]);
	const child = join(root, "source");
	mkdirSync(child);
	assert.deepEqual(await labelWorkspace(child), { folder: "source", repository: basename(root) });
});
