import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { createJouzuCamoufoxExtension } from "../dist/camoufox-adapter.js";
import {
	consolidateReleaseToolConflicts,
	inspectReleaseExtensions,
	suppressConfiguredReleaseResources,
	usesReleaseExtensions,
	withReleaseExtensionArguments,
} from "../dist/release-extensions.js";

const require = createRequire(import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../release-extensions.json", import.meta.url), "utf8"));

const expectedExtensions = [
	"@lhl/pi-goal",
	"@lhl/pi-tasks",
	"@sting8k/pi-vcc",
	"@the-forge-flow/camoufox-pi",
	"@vanillagreen/pi-background-tasks",
	"pi-code-previews",
	"pi-multiloop",
	"pi-schedule-prompt",
	"pi-skill-dollar",
	"pi-smart-fetch",
];
const expectedCompatibility = ["better-sqlite3", "camoufox-js", "playwright-core"];

function packageNames(records) {
	return records.map((record) => record.name).sort();
}

test("the release manifest and bundle list contain the selected extension set", () => {
	assert.equal(manifest.schemaVersion, 1);
	assert.deepEqual(packageNames(manifest.packages), expectedExtensions);
	assert.deepEqual(packageNames(manifest.compatibilityDependencies), expectedCompatibility);
	assert.deepEqual(
		[...packageJson.bundleDependencies].sort(),
		[
			"@earendil-works/pi-coding-agent",
			"@earendil-works/pi-tui",
			...expectedExtensions,
			...expectedCompatibility,
		].sort(),
	);
	assert.equal(manifest.packages.find((record) => record.name === "pi-smart-fetch").engineOverride, ">=22.19.0");
	assert.deepEqual(
		manifest.packages.find((record) => record.name === "@the-forge-flow/camoufox-pi").dependencyOverrides,
		{
			"camoufox-js": "0.11.5",
			"playwright-core": "1.60.0",
		},
	);
	assert.equal(
		manifest.packages.find((record) => record.name === "@the-forge-flow/camoufox-pi").peerDependenciesRemoved,
		true,
	);
	for (const record of [...manifest.packages, ...manifest.compatibilityDependencies]) {
		assert.equal(packageJson.dependencies[record.name], record.commit ? record.source : record.version);
		assert.match(record.repository, /^https:\/\//u);
		assert.ok(record.license);
		assert.ok(record.licenseEvidence);
		if (record.integrity) assert.match(record.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/u);
	}
});

test("all release-owned resources resolve to the exact installed package versions", () => {
	const status = inspectReleaseExtensions();
	assert.deepEqual(status.errors, []);
	assert.equal(status.extensionCount, 10);
	assert.equal(status.skillCount, 2);
	assert.equal(status.resolvedExtensionPaths.length, 10);
	assert.ok(status.resolvedExtensionPaths.some((path) => path.endsWith("camoufox-adapter.js")));
	assert.equal(status.resolvedSkillPaths.length, 2);
	assert.deepEqual(
		Object.keys(status.resolvedPackageRoots).sort(),
		[...expectedExtensions, ...expectedCompatibility].sort(),
	);
	for (const path of [...status.resolvedExtensionPaths, ...status.resolvedSkillPaths]) {
		assert.equal(existsSync(path), true, path);
	}
});

test("the bundled native compatibility dependency executes a SQLite query", () => {
	const Database = require("better-sqlite3");
	const database = new Database(":memory:");
	try {
		assert.deepEqual(database.prepare("select 1 as value").get(), { value: 1 });
	} finally {
		database.close();
	}
});

test("release resources are added to sessions but not Pi package commands", () => {
	const session = withReleaseExtensionArguments(["--mode", "rpc", "--no-session"]);
	assert.equal(session.filter((value) => value === "--extension").length, 10);
	assert.equal(session.filter((value) => value === "--skill").length, 2);
	assert.deepEqual(session.slice(-3), ["--mode", "rpc", "--no-session"]);
	assert.equal(usesReleaseExtensions(["--mode", "rpc"]), true);
	for (const command of ["config", "install", "list", "remove", "uninstall", "update"]) {
		assert.equal(usesReleaseExtensions([command, "fixture"]), false);
		assert.deepEqual(withReleaseExtensionArguments([command, "fixture"]), [command, "fixture"]);
	}
});

test("matching configured package entrypoints are suppressed without hiding unrelated resources", () => {
	const status = inspectReleaseExtensions();
	const metadata = (baseDir) => ({ source: "fixture", scope: "user", origin: "package", baseDir });
	const extensions = manifest.packages.flatMap((record) =>
		record.extensions.map((resource) => ({
			path: join(status.resolvedPackageRoots[record.name], resource),
			enabled: true,
			metadata: metadata(status.resolvedPackageRoots[record.name]),
		})),
	);
	const skills = manifest.packages.flatMap((record) =>
		record.skills.map((resource) => ({
			path: join(status.resolvedPackageRoots[record.name], resource),
			enabled: true,
			metadata: metadata(status.resolvedPackageRoots[record.name]),
		})),
	);
	const unrelated = {
		path: join(status.resolvedPackageRoots["@sting8k/pi-vcc"], "package.json"),
		enabled: true,
		metadata: metadata(status.resolvedPackageRoots["@sting8k/pi-vcc"]),
	};
	const topLevel = { ...extensions[0], metadata: { ...extensions[0].metadata, origin: "top-level" } };
	const resolved = suppressConfiguredReleaseResources(
		{ extensions: [...extensions, unrelated, topLevel], skills, prompts: [], themes: [] },
		status.manifest,
	);
	assert.equal(resolved.extensions.filter((resource) => !resource.enabled).length, 10);
	assert.equal(resolved.skills.filter((resource) => !resource.enabled).length, 2);
	assert.equal(resolved.extensions.at(-2).enabled, true);
	assert.equal(resolved.extensions.at(-1).enabled, true);
});

test("conflicts with release-owned tools are consolidated by extension", () => {
	const releasePath = join(process.cwd(), "release-extension.ts");
	const otherPath = join(process.cwd(), "other-extension.ts");
	const result = consolidateReleaseToolConflicts(
		{
			extensions: [],
			runtime: {},
			errors: [
				{ path: "user-extension.ts", error: `Tool "beta" conflicts with ${releasePath}` },
				{ path: "user-extension.ts", error: `Tool "alpha" conflicts with ${releasePath}` },
				{ path: "other.ts", error: `Tool "gamma" conflicts with ${otherPath}` },
			],
		},
		[releasePath],
	);
	assert.deepEqual(result.errors, [
		{
			path: "user-extension.ts",
			error:
				'conflicts with Jouzu release-owned tools "alpha", "beta"; disable this extension or its package with `jz config`',
		},
		{ path: "other.ts", error: `Tool "gamma" conflicts with ${otherPath}` },
	]);
});

test("the Jouzu Camoufox adapter registers both tools without starting a browser", () => {
	const tools = [];
	const handlers = new Map();
	const pi = {
		registerTool(tool) {
			tools.push(tool.name);
		},
		on(event, handler) {
			handlers.set(event, handler);
		},
	};
	assert.doesNotThrow(() => createJouzuCamoufoxExtension(pi));
	assert.deepEqual(tools.sort(), ["tff-fetch_url", "tff-search_web"]);
	assert.equal(handlers.has("session_start"), true);
	assert.equal(handlers.has("session_shutdown"), true);
});
