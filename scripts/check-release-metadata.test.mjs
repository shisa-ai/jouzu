import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-release-metadata.mjs", import.meta.url));
const root = fileURLToPath(new URL("..", import.meta.url));
const realLock = JSON.parse(readFileSync(join(root, "upstream", "pi.lock.json"), "utf8"));
const realCliPackage = JSON.parse(readFileSync(join(root, "packages", "cli", "package.json"), "utf8"));
const realSessionUiPackage = JSON.parse(readFileSync(join(root, "packages", "session-ui", "package.json"), "utf8"));
const realPackageLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));

function runWithMetadata({
	piLock = realLock,
	cliPackage = realCliPackage,
	sessionUiPackage = realSessionUiPackage,
	packageLock = realPackageLock,
} = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-metadata-fixture-"));
	try {
		const paths = {
			piLock: join(dir, "pi.lock.json"),
			cliPackage: join(dir, "cli-package.json"),
			sessionUiPackage: join(dir, "session-ui-package.json"),
			packageLock: join(dir, "package-lock.json"),
		};
		for (const [name, path] of Object.entries(paths)) {
			const value = { piLock, cliPackage, sessionUiPackage, packageLock }[name];
			writeFileSync(path, JSON.stringify(value, null, 2));
		}
		return spawnSync(process.execPath, [script], {
			encoding: "utf8",
			env: {
				...process.env,
				JOUZU_PI_LOCK: paths.piLock,
				JOUZU_CLI_PACKAGE: paths.cliPackage,
				JOUZU_SESSION_UI_PACKAGE: paths.sessionUiPackage,
				JOUZU_PACKAGE_LOCK: paths.packageLock,
			},
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("a pending-qualification Pi lock fails release metadata validation", () => {
	const pending = { ...realLock, compatibilityStatus: "pending-qualification" };
	const result = runWithMetadata({ piLock: pending });
	assert.notEqual(result.status, 0, "pending lock must fail release metadata");
	assert.match(result.stderr, /must be qualified for publication/);
});

test("malformed qualified Pi locks fail release metadata validation", () => {
	const fixtures = [
		["non-ISO reviewedAt", { ...realLock, reviewedAt: "1" }],
		["unknown top-level field", { ...realLock, unexpected: true }],
		[
			"unknown package record field",
			{
				...realLock,
				packages: {
					...realLock.packages,
					"@earendil-works/pi-coding-agent": {
						...realLock.packages["@earendil-works/pi-coding-agent"],
						unexpected: true,
					},
				},
			},
		],
		["malformed deviation", { ...realLock, deviations: [{}] }],
		["unsafe deviation path", { ...realLock, deviations: [{ path: "../pi.patch", sha256: "a".repeat(64) }] }],
	];
	for (const [label, fixture] of fixtures) {
		const result = runWithMetadata({ piLock: fixture });
		assert.notEqual(result.status, 0, `${label} must fail release metadata`);
	}
});

test("Pi and Pi TUI manifest drift fails release metadata validation", () => {
	const fixtures = [
		{
			cliPackage: {
				...realCliPackage,
				dependencies: { ...realCliPackage.dependencies, "@earendil-works/pi-tui": "0.84.2" },
			},
		},
		{
			sessionUiPackage: {
				...realSessionUiPackage,
				peerDependencies: {
					...realSessionUiPackage.peerDependencies,
					"@earendil-works/pi-coding-agent": "0.84.2",
				},
			},
		},
		{
			packageLock: {
				...realPackageLock,
				packages: {
					...realPackageLock.packages,
					"node_modules/@earendil-works/pi-tui": {
						...realPackageLock.packages["node_modules/@earendil-works/pi-tui"],
						version: "0.84.2",
					},
				},
			},
		},
	];
	for (const fixture of fixtures) {
		const result = runWithMetadata(fixture);
		assert.notEqual(result.status, 0, "Pi tuple drift must fail release metadata");
	}
});

test("a qualified Pi lock passes release metadata validation", () => {
	const result = runWithMetadata({
		piLock: { ...realLock, compatibilityStatus: "qualified", reviewedAt: "2026-08-25" },
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.ok(result.stdout.includes(`release metadata: jouzu@${realCliPackage.version}, Pi `));
});
