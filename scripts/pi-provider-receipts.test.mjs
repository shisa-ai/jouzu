import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { applyProviderReceipts } from "./apply-pi-provider-receipts.mjs";

test("provider receipt patch is pinned and idempotent in both package resolutions", async () => {
	const path = "upstream/pi-provider-receipts/patch.lock.json";
	const bytes = await readFile(path);
	const pin = JSON.parse(await readFile("upstream/pi.lock.json", "utf8"));
	assert.deepEqual(
		pin.deviations.filter((record) => record.path === path),
		[{ path, sha256: createHash("sha256").update(bytes).digest("hex") }],
	);
	for (const root of [resolve("."), resolve("packages/cli")]) {
		assert.equal(await applyProviderReceipts(root, true), 0);
		assert.equal(await applyProviderReceipts(root), 0);
	}
});

test("provider receipt patch preserves unrecognized installed source", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-provider-patch-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const pkg = join(root, "node_modules/@earendil-works/pi-ai");
	await mkdir(join(pkg, "dist/api"), { recursive: true });
	await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.85.1" }));
	const path = join(pkg, "dist/api/transform-messages.js");
	await writeFile(path, "unrecognized");
	await assert.rejects(applyProviderReceipts(root), /hash mismatch/);
	assert.equal(await readFile(path, "utf8"), "unrecognized");
});
