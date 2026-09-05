import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { clipboardBindingDirectoryIsComplete } from "./clipboard-bindings.mjs";
import {
	configureReleasePacklists,
	isPrunedDependencyMetadata,
	releaseDependencyFiles,
} from "./configure-release-packlists.mjs";
import {
	assertClipboardBindingsPresent,
	assertLicenseFilesPresent,
	assertNoPrunedDependencyMetadata,
	assertProfileFilesPresent,
	deriveClipboardBindingRequirements,
	deriveRequiredLicenseFiles,
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

test("clipboard requirements derive package names, entrypoints, and exact placeholders", () => {
	const requirements = deriveClipboardBindingRequirements({
		optionalDependencies: {
			"@mariozechner/clipboard-win32-x64-msvc": "0.3.9",
			"@mariozechner/clipboard-linux-x64-musl": "0.3.9",
		},
	});
	assert.deepEqual(
		requirements.map(({ packageName, entrypoint, placeholder }) => [packageName, entrypoint, placeholder]),
		[
			["clipboard-win32-x64-msvc", "clipboard.win32-x64-msvc.node", false],
			["clipboard-linux-x64-musl", "clipboard.linux-x64-musl.node", true],
		],
	);
	assert.equal(
		deriveClipboardBindingRequirements({
			optionalDependencies: { "@mariozechner/clipboard-linux-x64-musl": "0.4.0" },
		})[0].placeholder,
		false,
	);
	assert.throws(() => deriveClipboardBindingRequirements({ optionalDependencies: { impit: "1.0.0" } }), /unexpected/);
	assert.throws(() => deriveClipboardBindingRequirements({}), /no platform binding variants/);
});

test("clipboard pack checks require native entrypoints except for exact placeholders", () => {
	const [native] = deriveClipboardBindingRequirements({
		optionalDependencies: { "@mariozechner/clipboard-win32-x64-msvc": "0.3.9" },
	});
	const nativePackage = `node_modules/@earendil-works/pi-coding-agent/node_modules/@mariozechner/${native.packageName}`;
	assert.throws(
		() => assertClipboardBindingsPresent([{ path: `${nativePackage}/package.json` }], [native]),
		/missing native entrypoint clipboard\.win32-x64-msvc\.node/u,
	);
	assert.doesNotThrow(() =>
		assertClipboardBindingsPresent(
			[{ path: `${nativePackage}/package.json` }, { path: `${nativePackage}/${native.entrypoint}` }],
			[native],
		),
	);

	const [placeholder] = deriveClipboardBindingRequirements({
		optionalDependencies: { "@mariozechner/clipboard-linux-x64-musl": "0.3.9" },
	});
	const placeholderPackage = `node_modules/@earendil-works/pi-coding-agent/node_modules/@mariozechner/${placeholder.packageName}`;
	assert.doesNotThrow(() =>
		assertClipboardBindingsPresent([{ path: `${placeholderPackage}/package.json` }], [placeholder]),
	);
});

test("a partial extracted binding is not treated as complete", () => {
	const root = mkdtempSync(join(tmpdir(), "clipboard-binding-"));
	try {
		const [requirement] = deriveClipboardBindingRequirements({
			optionalDependencies: { "@mariozechner/clipboard-win32-x64-msvc": "0.3.9" },
		});
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: requirement.name, version: requirement.version, main: requirement.entrypoint }),
		);
		assert.equal(clipboardBindingDirectoryIsComplete(root, requirement), false);
		writeFileSync(join(root, requirement.entrypoint), "native fixture");
		assert.equal(clipboardBindingDirectoryIsComplete(root, requirement), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("release packlists prune only dependency maps and declarations", () => {
	assert.equal(isPrunedDependencyMetadata("node_modules/pi/dist/index.js.map"), true);
	assert.equal(isPrunedDependencyMetadata("node_modules/pi/dist/index.d.mts"), true);
	assert.equal(isPrunedDependencyMetadata("node_modules/pi/extensions/state.ts"), false);
	assert.equal(isPrunedDependencyMetadata("dist/index.d.ts"), false);
	assert.deepEqual(releaseDependencyFiles(["dist", "index.d.ts", "index.js.map"]), [
		"dist",
		"!**/*.map",
		"!**/*.d.ts",
		"!**/*.d.mts",
		"!**/*.d.cts",
	]);
	assert.throws(
		() => assertNoPrunedDependencyMetadata([{ path: "node_modules/pi/dist/index.d.ts" }]),
		/pruned dependency metadata/u,
	);
	assert.doesNotThrow(() => assertNoPrunedDependencyMetadata([{ path: "dist/index.d.ts" }]));
});

test("release packlists apply to nested installed packages", () => {
	const root = mkdtempSync(join(tmpdir(), "release-packlist-"));
	const child = join(root, "node_modules", "child");
	try {
		mkdirSync(child, { recursive: true });
		writeFileSync(join(root, "package.json"), '{"name":"parent","version":"1.0.0","files":["dist"]}\n');
		writeFileSync(join(child, "package.json"), '{"name":"child","version":"1.0.0"}\n');
		assert.equal(configureReleasePacklists([root]), 2);
		assert.deepEqual(
			JSON.parse(readFileSync(join(root, "package.json"), "utf8")).files,
			releaseDependencyFiles(["dist"]),
		);
		assert.deepEqual(JSON.parse(readFileSync(join(child, "package.json"), "utf8")).files, releaseDependencyFiles());
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("dependency licenses remain required after metadata pruning", () => {
	const root = mkdtempSync(join(tmpdir(), "release-licenses-"));
	try {
		const dependency = join(root, "node_modules", "dependency");
		const nested = join(dependency, "node_modules", "nested");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(dependency, "LICENSE"), "license");
		writeFileSync(join(nested, "NOTICE.md"), "notice");
		const packed = [
			{ path: "node_modules/dependency/package.json" },
			{ path: "node_modules/dependency/node_modules/nested/package.json" },
		];
		const required = deriveRequiredLicenseFiles(root, packed);
		assert.deepEqual(required, [
			"node_modules/dependency/LICENSE",
			"node_modules/dependency/node_modules/nested/NOTICE.md",
		]);
		assert.throws(() => assertLicenseFilesPresent([{ path: required[0] }], required), /NOTICE\.md/u);
		assert.doesNotThrow(() =>
			assertLicenseFilesPresent(
				required.map((path) => ({ path })),
				required,
			),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
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
