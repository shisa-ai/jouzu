import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertClipboardBindingsPresent,
	assertProfileFilesPresent,
	deriveClipboardBindingVariants,
	deriveRequiredProfileFiles,
	forbiddenPublicContent,
} from "./pack-check.mjs";

function makeFixtureProfiles() {
	const dir = mkdtempSync(join(tmpdir(), "pack-check-"));
	const core = join(dir, "core");
	mkdirSync(join(core, "assets"), { recursive: true });
	writeFileSync(
		join(core, "manifest.json"),
		JSON.stringify({
			schemaVersion: 1,
			id: "core",
			version: 1,
			assets: [{ source: "assets/present.md", target: "skills/present/SKILL.md", sha256: "a" }],
		}),
	);
	return dir;
}

test("deriveRequiredProfileFiles lists the manifest and each declared asset", () => {
	const dir = makeFixtureProfiles();
	try {
		const required = deriveRequiredProfileFiles(dir);
		assert.ok(required.includes("dist/profiles/core/manifest.json"));
		assert.ok(required.includes("dist/profiles/core/assets/present.md"));
		assert.ok(!required.some((path) => path.includes("..")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a manifest asset omitted from the tarball fails the presence check", () => {
	const dir = makeFixtureProfiles();
	try {
		const required = deriveRequiredProfileFiles(dir);
		// The packed listing ships the manifest but drops the declared asset.
		const packed = [{ path: "dist/profiles/core/manifest.json" }];
		assert.throws(() => assertProfileFilesPresent(packed, required), /core\/assets\/present\.md/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("all declared assets present in the tarball passes the presence check", () => {
	const dir = makeFixtureProfiles();
	try {
		const required = deriveRequiredProfileFiles(dir);
		const packed = required.map((path) => ({ path }));
		assert.doesNotThrow(() => assertProfileFilesPresent(packed, required));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("deriveClipboardBindingVariants unscopes names and rejects unexpected dependencies", () => {
	const variants = deriveClipboardBindingVariants({
		optionalDependencies: {
			"@mariozechner/clipboard-win32-x64-msvc": "0.3.9",
			"@mariozechner/clipboard-darwin-arm64": "0.3.9",
		},
	});
	assert.deepEqual(variants, ["clipboard-win32-x64-msvc", "clipboard-darwin-arm64"]);
	assert.throws(() => deriveClipboardBindingVariants({ optionalDependencies: { impit: "1.0.0" } }), /unexpected/);
	assert.throws(() => deriveClipboardBindingVariants({}), /no platform binding variants/);
});

test("a clipboard binding variant omitted from the tarball fails the presence check", () => {
	const packed = [
		{
			path: "node_modules/@earendil-works/pi-coding-agent/node_modules/@mariozechner/clipboard-win32-x64-msvc/package.json",
		},
	];
	assertClipboardBindingsPresent(packed, ["clipboard-win32-x64-msvc"]);
	assert.throws(
		() => assertClipboardBindingsPresent(packed, ["clipboard-win32-x64-msvc", "clipboard-darwin-arm64"]),
		/missing clipboard binding clipboard-darwin-arm64/,
	);
});

test("forbiddenPublicContent derives the home path at runtime and honors runbook input", () => {
	const previous = process.env.JOUZU_PRIVATE_HOME;
	try {
		delete process.env.JOUZU_PRIVATE_HOME;
		const list = forbiddenPublicContent();
		// The running machine's home path is generated at runtime.
		assert.ok(list.includes(homedir()));

		process.env.JOUZU_PRIVATE_HOME = "/srv/private, /srv/secret ";
		const withRunbook = forbiddenPublicContent();
		assert.ok(withRunbook.includes("/srv/private"));
		assert.ok(withRunbook.includes("/srv/secret"));
	} finally {
		if (previous === undefined) delete process.env.JOUZU_PRIVATE_HOME;
		else process.env.JOUZU_PRIVATE_HOME = previous;
	}
});

test("pack-check.mjs does not embed a maintainer home path in source", () => {
	const source = readFileSync(new URL("./pack-check.mjs", import.meta.url), "utf8");
	assert.ok(!/\/home\/[^"'`]*\//.test(source));
	assert.ok(!source.includes("/home/lhl"));
});
