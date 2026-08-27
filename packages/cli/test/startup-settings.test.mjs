import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveJouzuPaths } from "../dist/paths.js";
import { ensureQuietStartupDefault } from "../dist/startup-settings.js";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "jouzu-startup-settings-"));
	const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
	return { root, paths, settingsPath: join(paths.agentDir, "settings.json") };
}

test("quiet startup is the Jouzu default without overriding an explicit choice", () => {
	const { root, paths, settingsPath } = fixture();
	try {
		assert.equal(ensureQuietStartupDefault(paths), true);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { quietStartup: true });

		const explicit = '{"quietStartup":false,"theme":"light"}\n';
		writeFileSync(settingsPath, explicit);
		assert.equal(ensureQuietStartupDefault(paths), false);
		assert.equal(readFileSync(settingsPath, "utf8"), explicit);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("quiet startup is inserted without replacing existing settings", () => {
	const { root, paths, settingsPath } = fixture();
	try {
		ensureQuietStartupDefault(paths);
		const existing = '{"theme":"dark","packages":["example"]}\n';
		writeFileSync(settingsPath, existing);
		assert.equal(ensureQuietStartupDefault(paths), true);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			theme: "dark",
			packages: ["example"],
			quietStartup: true,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("invalid and symbolic-link settings remain untouched", () => {
	const invalid = fixture();
	try {
		ensureQuietStartupDefault(invalid.paths);
		writeFileSync(invalid.settingsPath, "{ broken");
		assert.equal(ensureQuietStartupDefault(invalid.paths), false);
		assert.equal(readFileSync(invalid.settingsPath, "utf8"), "{ broken");
	} finally {
		rmSync(invalid.root, { recursive: true, force: true });
	}

	const linked = fixture();
	try {
		mkdirSync(linked.paths.agentDir, { recursive: true });
		const target = join(linked.root, "target.json");
		writeFileSync(target, "{}\n");
		symlinkSync(target, linked.settingsPath);
		assert.equal(ensureQuietStartupDefault(linked.paths), false);
		assert.equal(readFileSync(target, "utf8"), "{}\n");
	} finally {
		rmSync(linked.root, { recursive: true, force: true });
	}
});
