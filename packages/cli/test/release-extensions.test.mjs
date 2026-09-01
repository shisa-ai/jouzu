import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createJouzuCamoufoxExtension,
	ensureJouzuCamoufoxInstalled,
	shouldDisableCamoufoxWebGl,
	withJouzuCamoufoxLibraryPath,
} from "../dist/camoufox-adapter.js";
import {
	consolidateReleaseToolConflicts,
	inspectReleaseExtensions,
	repairRuntimeDependencyRedirect,
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
const expectedCompatibility = ["better-sqlite3", "camoufox-js", "impit", "playwright-core"];

function packageNames(records) {
	return records.map((record) => record.name).sort();
}

test("the release manifest and bundle list contain the selected extension set", () => {
	assert.equal(manifest.schemaVersion, 1);
	assert.deepEqual(packageNames(manifest.packages), expectedExtensions);
	assert.deepEqual(packageNames(manifest.compatibilityDependencies), expectedCompatibility);
	assert.deepEqual(
		[...packageJson.bundleDependencies].sort(),
		["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", ...expectedExtensions].sort(),
	);
	for (const record of manifest.compatibilityDependencies) assert.equal(record.bundled, false);
	const smartFetchExtension = manifest.packages.find((record) => record.name === "pi-smart-fetch");
	assert.equal(smartFetchExtension.engineOverride, ">=22.19.0");
	assert.deepEqual(smartFetchExtension.dependencyOverrides, { "wreq-js": "3.0.0" });
	assert.deepEqual(manifest.runtimeDependencyRedirects, [
		{ consumer: "camoufox-js", dependency: "impit", version: "0.11.0" },
	]);
	const camoufoxExtension = manifest.packages.find((record) => record.name === "@the-forge-flow/camoufox-pi");
	assert.deepEqual(camoufoxExtension.dependencyOverrides, {});
	assert.deepEqual(camoufoxExtension.dependencyRemovals, ["camoufox-js", "playwright-core"]);
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

test("an incompatible nested native dependency redirects to the exact direct package", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-native-redirect-"));
	try {
		const modules = join(root, "node_modules");
		const consumer = join(modules, "camoufox-js");
		const replacement = join(modules, "impit");
		const nested = join(consumer, "node_modules", "impit");
		mkdirSync(nested, { recursive: true });
		mkdirSync(replacement, { recursive: true });
		writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "camoufox-js", version: "0.12.0" }));
		writeFileSync(
			join(nested, "package.json"),
			JSON.stringify({ name: "impit", version: "0.14.4", main: "index.cjs" }),
		);
		writeFileSync(join(nested, "index.cjs"), "module.exports = { incompatible: true };\n");
		writeFileSync(
			join(replacement, "package.json"),
			JSON.stringify({ name: "impit", version: "0.11.0", main: "index.cjs" }),
		);
		writeFileSync(join(replacement, "index.cjs"), "module.exports = { compatible: true };\n");
		const record = { consumer: "camoufox-js", dependency: "impit", version: "0.11.0" };
		const roots = { "camoufox-js": consumer, impit: replacement };
		assert.equal(repairRuntimeDependencyRedirect(record, roots), true);
		assert.equal(existsSync(nested), false);
		assert.equal(repairRuntimeDependencyRedirect(record, roots), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
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

test("the Jouzu Camoufox installer awaits first-use download and verifies the result", async () => {
	let locateCalls = 0;
	let installCalls = 0;
	await ensureJouzuCamoufoxInstalled({
		locateInstalled() {
			locateCalls += 1;
			if (locateCalls === 1) throw new Error("not installed");
		},
		async install() {
			installCalls += 1;
		},
	});
	assert.equal(installCalls, 1);
	assert.equal(locateCalls, 2);

	await ensureJouzuCamoufoxInstalled({
		locateInstalled() {},
		async install() {
			throw new Error("must not install");
		},
	});
});

test("Camoufox disables WebGL only for an incompatible native SQLite binding", async () => {
	class Database {
		close() {}
	}
	assert.equal(await shouldDisableCamoufoxWebGl(async () => ({ default: Database })), false);
	assert.equal(
		await shouldDisableCamoufoxWebGl(async () => {
			throw new Error("/lib64/libc.so.6: version `GLIBC_2.34' not found");
		}),
		true,
	);
	await assert.rejects(
		shouldDisableCamoufoxWebGl(async () => {
			throw new Error("database is corrupt");
		}),
		/database is corrupt/u,
	);
});

test("Camoufox scopes a compatibility library path to the browser child", () => {
	const options = withJouzuCamoufoxLibraryPath(
		{ env: { EXISTING: "kept" } },
		{ JOUZU_CAMOUFOX_LIBRARY_PATH: "/opt/jouzu/lib", LD_LIBRARY_PATH: "/usr/local/lib", HOME: "/home/test" },
	);
	assert.deepEqual(options.env, {
		JOUZU_CAMOUFOX_LIBRARY_PATH: "/opt/jouzu/lib",
		LD_LIBRARY_PATH: "/opt/jouzu/lib:/usr/local/lib",
		HOME: "/home/test",
		EXISTING: "kept",
	});
	assert.deepEqual(withJouzuCamoufoxLibraryPath({ env: { EXISTING: "kept" } }, {}), {
		env: { EXISTING: "kept" },
	});
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
