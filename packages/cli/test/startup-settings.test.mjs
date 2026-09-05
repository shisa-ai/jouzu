import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveJouzuPaths } from "../dist/paths.js";
import { ensureQuietStartupDefault, suppressPiReleaseNotes } from "../dist/startup-settings.js";

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

test("pi release notes marker is pinned to the bundled Pi version", () => {
	const { root, paths, settingsPath } = fixture();
	try {
		assert.equal(suppressPiReleaseNotes(paths, "0.84.4"), true);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { lastChangelogVersion: "0.84.4" });

		const pinned = readFileSync(settingsPath, "utf8");
		assert.equal(suppressPiReleaseNotes(paths, "0.84.4"), false);
		assert.equal(readFileSync(settingsPath, "utf8"), pinned);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a stale pi release notes marker is updated at the top level", () => {
	const { root, paths, settingsPath } = fixture();
	try {
		mkdirSync(paths.agentDir, { recursive: true });
		const existing = '{\n  "theme": "light",\n  "lastChangelogVersion": "0.83.0"\n}\n';
		writeFileSync(settingsPath, existing);
		assert.equal(suppressPiReleaseNotes(paths, "0.84.4"), true);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			theme: "light",
			lastChangelogVersion: "0.84.4",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("updating the pi release notes marker leaves nested extension settings unchanged", () => {
	const { root, paths, settingsPath } = fixture();
	try {
		mkdirSync(paths.agentDir, { recursive: true });
		writeFileSync(settingsPath, '{"plugin":{"lastChangelogVersion":"plugin-value"},"lastChangelogVersion":"0.83.0"}\n');
		assert.equal(suppressPiReleaseNotes(paths, "0.84.4"), true);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			plugin: { lastChangelogVersion: "plugin-value" },
			lastChangelogVersion: "0.84.4",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pi release notes marker is inserted without replacing existing settings", () => {
	const { root, paths, settingsPath } = fixture();
	try {
		mkdirSync(paths.agentDir, { recursive: true });
		const existing = '{"theme":"dark","packages":["example"]}\n';
		writeFileSync(settingsPath, existing);
		assert.equal(suppressPiReleaseNotes(paths, "0.84.4"), true);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			theme: "dark",
			packages: ["example"],
			lastChangelogVersion: "0.84.4",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("unreadable and non-string release notes markers are handled safely", () => {
	const { root, paths, settingsPath } = fixture();
	try {
		mkdirSync(paths.agentDir, { recursive: true });
		writeFileSync(settingsPath, '{"lastChangelogVersion":null,"theme":"dark"}\n');
		assert.equal(suppressPiReleaseNotes(paths, "0.84.4"), true);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			lastChangelogVersion: "0.84.4",
			theme: "dark",
		});

		writeFileSync(settingsPath, "{ broken");
		assert.equal(suppressPiReleaseNotes(paths, "0.84.4"), false);
		assert.equal(readFileSync(settingsPath, "utf8"), "{ broken");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	const linked = fixture();
	try {
		mkdirSync(linked.paths.agentDir, { recursive: true });
		const target = join(linked.root, "target.json");
		writeFileSync(target, "{}\n");
		symlinkSync(target, linked.settingsPath);
		assert.equal(suppressPiReleaseNotes(linked.paths, "0.84.4"), false);
		assert.equal(readFileSync(target, "utf8"), "{}\n");
	} finally {
		rmSync(linked.root, { recursive: true, force: true });
	}
});
