import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { paths } from "../../../scripts/background-flow-transform.mjs";
import { transformBackgroundResources } from "../../../scripts/background-resource-transform.mjs";
import {
	backgroundStorePredecessor,
	backgroundWidgetPredecessor,
	extensionPatchFixture,
	multiloopPredecessors,
	sha256,
} from "../../../scripts/fixtures/extension-flow-patch.mjs";
import { extensionPath } from "../../../scripts/multiloop-flow-transform.mjs";

const root = resolve(import.meta.dirname, "../../..");
for (const kind of ["background", "multiloop"]) {
	const source = process.env[kind === "background" ? "JOUZU_BACKGROUND_SOURCE" : "JOUZU_MULTILOOP_SOURCE"];
	test(`${kind} patch verifies candidate bytes, installs atomically, and is idempotent`, async (t) => {
		const f = await extensionPatchFixture(t, kind, source);
		const files =
			kind === "background"
				? f.lock.files
				: { [f.lock.path]: f.lock, [extensionPath]: f.lock.extension, [f.lock.lanes.path]: f.lock.lanes };
		const originals = new Map();
		for (const [path, hashes] of Object.entries(files)) {
			const original = await readFile(join(f.packageRoot, path), "utf8");
			originals.set(path, original);
			assert.equal(sha256(original), source ? hashes.before : hashes.after, path);
		}
		if (source) {
			await assert.rejects(f.apply(f.packageRoot, true), /hash (mismatch|differs)/);
			for (const [path, original] of originals)
				assert.equal(await readFile(join(f.packageRoot, path), "utf8"), original);
			const lastPath = Object.keys(files).at(-1);
			await writeFile(join(f.packageRoot, lastPath), "unexpected source\n");
			await assert.rejects(f.apply(f.packageRoot), /hash (mismatch|differs)/);
			for (const [path, original] of originals) {
				if (path !== lastPath) assert.equal(await readFile(join(f.packageRoot, path), "utf8"), original);
			}
			await writeFile(join(f.packageRoot, lastPath), originals.get(lastPath));
		}
		assert.equal(
			await f.apply(f.packageRoot),
			source ? (kind === "background" ? paths.length + 2 + Object.keys(f.lock.helpers).length : 4) : 0,
		);
		assert.equal(await f.apply(f.packageRoot), 0);
		assert.equal(await f.apply(f.packageRoot, true), 0);
		for (const [path, hashes] of Object.entries(files)) {
			assert.equal(sha256(await readFile(join(f.packageRoot, path))), hashes.after, path);
		}
		if (kind === "background") {
			const patched = await readFile(join(f.packageRoot, paths[0]), "utf8");
			assert.equal(patched.match(/const widgetClaims =/g)?.length, 1);
			assert.equal(patched.match(/widgetClaims\.listen\(/g)?.length, 1);
			assert.equal(patched.match(/emit\?\.\(BACKGROUND_WIDGET_READY/g)?.length, 1);
		}
		const unknownRuntime = kind === "background" ? "extensions/jouzu-flow.ts" : "extensions/pi-multiloop/jouzu-flow.ts";
		await writeFile(join(f.packageRoot, unknownRuntime), "unexpected runtime\n");
		await assert.rejects(f.apply(f.packageRoot), /installed runtime (mismatch|differs)/);
		// A manifest edit without the corresponding pin must never be accepted.
		const manifestPath = join(
			f.directory,
			"upstream",
			kind === "background" ? "background-flow" : "multiloop-wait-skill",
			"patch.lock.json",
		);
		await writeFile(manifestPath, `${await readFile(manifestPath, "utf8")}\n`);
		await assert.rejects(f.apply(f.packageRoot), /pinned deviation/);
	});
}

test("background widget guard upgrades only the pinned candidate predecessor", async (t) => {
	const f = await extensionPatchFixture(t, "background", process.env.JOUZU_BACKGROUND_SOURCE);
	await f.apply(f.packageRoot);
	const path = join(f.packageRoot, paths[0]);
	const final = await readFile(path, "utf8");
	const previous = backgroundWidgetPredecessor(final);
	assert.equal(sha256(previous), f.lock.files[paths[0]].previousAfter);
	await writeFile(path, previous);
	await assert.rejects(f.apply(f.packageRoot, true), /hash mismatch/);
	assert.equal(await readFile(path, "utf8"), previous);
	await writeFile(path, `${previous}\n`);
	await assert.rejects(f.apply(f.packageRoot), /hash mismatch/);
	await writeFile(path, previous);
	assert.equal(await f.apply(f.packageRoot), 1);
	assert.equal(await readFile(path, "utf8"), final);
	assert.equal(await f.apply(f.packageRoot, true), 0);
});

test("background store upgrades only the pinned previous store", async (t) => {
	const f = await extensionPatchFixture(t, "background", process.env.JOUZU_BACKGROUND_SOURCE);
	await f.apply(f.packageRoot);
	const path = join(f.packageRoot, "extensions/jouzu-store.ts");
	const final = await readFile(path, "utf8");
	const previous = backgroundStorePredecessor(final);
	assert.equal(sha256(previous), f.lock.previousStore);
	await writeFile(path, previous);
	await assert.rejects(f.apply(f.packageRoot, true), /installed store mismatch/);
	assert.equal(await readFile(path, "utf8"), previous);
	await writeFile(path, `${previous}\n`);
	await assert.rejects(f.apply(f.packageRoot), /installed store mismatch/);
	await writeFile(path, previous);
	assert.equal(await f.apply(f.packageRoot), 1);
	assert.equal(await readFile(path, "utf8"), final);
	assert.equal(await f.apply(f.packageRoot, true), 0);
});

for (const stage of ["previousAfter", "continuationPreviousAfter", "labelsPreviousAfter"]) {
	test(`multiloop upgrades ${stage} without writing during check-only`, async (t) => {
		const f = await extensionPatchFixture(t, "multiloop", process.env.JOUZU_MULTILOOP_SOURCE);
		await f.apply(f.packageRoot);
		const path = join(f.packageRoot, extensionPath);
		const final = await readFile(path, "utf8");
		const previous = multiloopPredecessors(final)[stage];
		assert.equal(sha256(previous), f.lock.extension[stage]);
		await writeFile(path, previous);
		await assert.rejects(f.apply(f.packageRoot, true), /source hash differs/);
		assert.equal(await readFile(path, "utf8"), previous);
		await writeFile(path, `${previous}\n`);
		await assert.rejects(f.apply(f.packageRoot), /source hash differs/);
		await writeFile(path, previous);
		// A later validation failure cannot partially apply an earlier upgrade.
		const runtimePath = join(f.packageRoot, "extensions/pi-multiloop/jouzu-flow.ts");
		await writeFile(runtimePath, "unexpected runtime\n");
		await assert.rejects(f.apply(f.packageRoot), /installed runtime differs/);
		assert.equal(await readFile(path, "utf8"), previous);
		await writeFile(runtimePath, await readFile(join(root, "upstream/multiloop-wait-skill/runtime.ts")));
		assert.equal(await f.apply(f.packageRoot), 1);
		assert.equal(await readFile(path, "utf8"), final);
		assert.equal(await f.apply(f.packageRoot, true), 0);
	});
}

test("background resource upgrade accepts the pinned flow predecessor and rejects altered helpers atomically", async (t) => {
	const f = await extensionPatchFixture(t, "background", process.env.JOUZU_BACKGROUND_SOURCE);
	await f.apply(f.packageRoot);
	const previous = new Map();
	for (const [path, hashes] of Object.entries(f.lock.files)) {
		if (!hashes.resourcePreviousAfter) continue;
		const original = transformBackgroundResources(path, await readFile(join(f.packageRoot, path), "utf8"), true);
		assert.equal(sha256(original), hashes.resourcePreviousAfter, path);
		previous.set(path, original);
		await writeFile(join(f.packageRoot, path), original);
	}
	await assert.rejects(f.apply(f.packageRoot, true), /hash mismatch/);
	const helper = join(f.packageRoot, "extensions/log-writer.ts");
	const valid = await readFile(helper, "utf8");
	await writeFile(helper, "unexpected helper\n");
	await assert.rejects(f.apply(f.packageRoot), /installed helper mismatch/);
	for (const [path, original] of previous) assert.equal(await readFile(join(f.packageRoot, path), "utf8"), original);
	await writeFile(helper, valid);
	assert.equal(await f.apply(f.packageRoot), previous.size);
	assert.equal(await f.apply(f.packageRoot, true), 0);
});
