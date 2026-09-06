import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertVoiceBundlePresent, voiceBundleFiles } from "../../../scripts/voice-package-boundary.mjs";

test("voice pack boundary requires helper, transport and every native platform binary", () => {
	const files = voiceBundleFiles.map((path) => ({ path }));
	assert.doesNotThrow(() => assertVoiceBundlePresent(files));
	for (const missing of voiceBundleFiles) {
		assert.throws(() => assertVoiceBundlePresent(files.filter(({ path }) => path !== missing)), /missing voice file/);
	}
});

test("voice dependencies are exact and bundled in both package locks", () => {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	const cliLock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
	const rootLock = JSON.parse(readFileSync(new URL("../../../package-lock.json", import.meta.url), "utf8"));
	for (const name of ["@picovoice/pvrecorder-node", "ws"]) {
		assert.match(manifest.dependencies[name], /^\d+\.\d+\.\d+$/);
		assert.ok(manifest.bundleDependencies.includes(name));
		assert.equal(cliLock.packages[`node_modules/${name}`].version, manifest.dependencies[name]);
		assert.equal(rootLock.packages["packages/cli"].dependencies[name], manifest.dependencies[name]);
	}
});
