import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const storeUrl = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/models-store.js", import.meta.url);
const entry = { models: [], checkedAt: 1 };
let instances = 0;
// closeModelsStores is one-way for its module, so each test loads its own copy.
const loadStore = () => import(`${storeUrl.href}?case=${++instances}`);

async function storeHome(t) {
	const directory = await mkdtemp(join(tmpdir(), "jouzu-models-store-exit-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "models-store.json");
	return { path, lock: `${path}.lock` };
}

test("closing the models store stops a save waiting for another holder's lock", async (t) => {
	const { FileModelsStore, closeModelsStores } = await loadStore();
	const home = await storeHome(t);
	const store = new FileModelsStore(home.path);
	await store.write("first", entry);
	// A fresh lock from another process; Pi would wait up to 30 s for it.
	mkdirSync(home.lock);
	const refused = assert.rejects(store.write("second", entry), { name: "AbortError" });
	const started = Date.now();
	await closeModelsStores();
	assert.ok(Date.now() - started < 5_000, `close took ${Date.now() - started} ms`);
	await refused;
	assert.ok(existsSync(home.lock), "the other holder's lock is left in place");
});

test("a closed models store refuses new operations without taking the lock", async (t) => {
	const { FileModelsStore, closeModelsStores } = await loadStore();
	const home = await storeHome(t);
	const store = new FileModelsStore(home.path);
	await store.write("first", entry);
	await closeModelsStores();
	await assert.rejects(new FileModelsStore(home.path).read("first"), { name: "AbortError" });
	await assert.rejects(store.write("second", entry), { name: "AbortError" });
	await assert.rejects(store.delete("first"), { name: "AbortError" });
	assert.equal(existsSync(home.lock), false);
});

test("closing waits for operations in progress and leaves no lock behind", async (t) => {
	const { FileModelsStore, closeModelsStores } = await loadStore();
	const home = await storeHome(t);
	const settled = [];
	const operations = [
		new FileModelsStore(home.path).write("first", entry),
		new FileModelsStore(home.path).write("second", entry),
		new FileModelsStore(home.path).read("first"),
	].map((operation, index) =>
		operation.then(
			() => settled.push(index),
			() => settled.push(index),
		),
	);
	// Let the operations reach proper-lockfile, then close as a runtime does before it exits.
	await new Promise((resolve) => setImmediate(resolve));
	await closeModelsStores();
	assert.equal(settled.length, operations.length, "close returned before every operation settled");
	assert.equal(existsSync(home.lock), false);
	await Promise.all(operations);
});
