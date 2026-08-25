#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const lockPath = resolve(root, "upstream", "pi.lock.json");
const packagePath = resolve(root, "package.json");
const cliPackagePath = resolve(root, "packages", "cli", "package.json");
const sessionUiPackagePath = resolve(root, "packages", "session-ui", "package.json");
const packageLockPath = resolve(root, "package-lock.json");
const packageName = "@earendil-works/pi-coding-agent";
const tuiPackageName = "@earendil-works/pi-tui";
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function fail(message) {
	throw new Error(message);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

const npmCommand = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
const npmPrefix = process.platform === "win32" ? ["/d", "/s", "/c", "npm"] : [];

function runNpm(args, options = {}) {
	return execFileSync(npmCommand, [...npmPrefix, ...args], {
		cwd: root,
		...options,
	});
}

function registryMetadata(spec) {
	const output = runNpm(
		["view", spec, "version", "gitHead", "dist.integrity", "dist.tarball", "dependencies", "--json"],
		{
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
		},
	);
	const parsed = JSON.parse(output);
	if (!parsed.version || !parsed.gitHead || !parsed["dist.integrity"] || !parsed["dist.tarball"]) {
		fail(`npm metadata for ${spec} is incomplete`);
	}
	return {
		version: parsed.version,
		gitHead: parsed.gitHead,
		integrity: parsed["dist.integrity"],
		tarball: parsed["dist.tarball"],
		dependencies: parsed.dependencies ?? {},
	};
}

function registryVersion(spec) {
	const output = runNpm(["view", spec, "version", "--json"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
	const version = JSON.parse(output);
	if (typeof version !== "string" || !VERSION_RE.test(version)) fail(`npm version for ${spec} is invalid`);
	return version;
}

function dependencyRangeTargetsVersion(range, version) {
	return range === version || range === `^${version}` || range === `~${version}`;
}

function upstreamTagCommit(tag) {
	const output = execFileSync(
		"git",
		["ls-remote", "--tags", "--refs", "https://github.com/earendil-works/pi.git", tag],
		{
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
		},
	).trim();
	const rows = output.split(/\r?\n/).filter(Boolean);
	if (rows.length !== 1) fail(`expected one upstream tag ${tag}, found ${rows.length}`);
	return rows[0].split(/\s+/)[0];
}

function verifyTagContainsPackageSource(tag, tagCommit, sourceCommit) {
	if (tagCommit === sourceCommit) return;
	const directory = mkdtempSync(join(tmpdir(), "jouzu-pi-provenance-"));
	try {
		execFileSync("git", ["init", "--quiet", directory], { cwd: root, stdio: "inherit" });
		execFileSync(
			"git",
			[
				"-C",
				directory,
				"fetch",
				"--quiet",
				"--filter=blob:none",
				"--no-tags",
				"https://github.com/earendil-works/pi.git",
				sourceCommit,
				`refs/tags/${tag}:refs/tags/${tag}`,
			],
			{ cwd: root, stdio: "inherit" },
		);
		const result = execFileSync("git", ["-C", directory, "merge-base", "--is-ancestor", tagCommit, sourceCommit], {
			cwd: root,
			stdio: "ignore",
		});
		void result;
	} catch {
		fail(`npm source ${sourceCommit} is not ${tagCommit} or a descendant of ${tag}`);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function packageLockRecords() {
	const packageLock = readJson(packageLockPath);
	const node = packageLock.packages?.[`node_modules/${packageName}`];
	const tui = packageLock.packages?.[`node_modules/${tuiPackageName}`];
	const cli = packageLock.packages?.["packages/cli"];
	const sessionUi = packageLock.packages?.["packages/session-ui"];
	if (!node) fail(`${packageName} is missing from package-lock.json`);
	if (!tui) fail(`${tuiPackageName} is missing from package-lock.json`);
	if (!cli) fail("packages/cli is missing from package-lock.json");
	if (!sessionUi) fail("packages/session-ui is missing from package-lock.json");
	return { node, tui, cli, sessionUi };
}

function validateLock({ online }) {
	const lock = readJson(lockPath);
	const packageJson = readJson(packagePath);
	const cliPackageJson = readJson(cliPackagePath);
	const sessionUiPackageJson = readJson(sessionUiPackagePath);
	const packageLock = packageLockRecords();
	const packageRecord = lock.packages?.[packageName];
	if (!packageRecord) fail(`${lockPath} is missing ${packageName}`);
	if (lock.schemaVersion !== 2) fail(`unsupported Pi lock schema ${lock.schemaVersion}`);
	if (lock.tag !== `v${packageRecord.version}`) fail(`tag ${lock.tag} does not match package ${packageRecord.version}`);
	if (!/^[0-9a-f]{40}$/.test(lock.tagCommit) || !/^[0-9a-f]{40}$/.test(lock.commit)) {
		fail("Pi tag or package source commit is invalid");
	}
	if (packageJson.devDependencies?.[packageName] !== packageRecord.version) {
		fail(
			`package.json development pin ${packageJson.devDependencies?.[packageName]} does not match ${packageRecord.version}`,
		);
	}
	if (cliPackageJson.dependencies?.[packageName] !== packageRecord.version) {
		fail(`jouzu runtime pin ${cliPackageJson.dependencies?.[packageName]} does not match ${packageRecord.version}`);
	}
	const tuiVersion = cliPackageJson.dependencies?.[tuiPackageName];
	if (typeof tuiVersion !== "string" || !VERSION_RE.test(tuiVersion)) {
		fail(`jouzu runtime pin for ${tuiPackageName} must be exact`);
	}
	if (sessionUiPackageJson.peerDependencies?.[packageName] !== packageRecord.version) {
		fail(`session UI Pi peer does not match ${packageRecord.version}`);
	}
	if (sessionUiPackageJson.peerDependencies?.[tuiPackageName] !== tuiVersion) {
		fail(`session UI Pi TUI peer does not match ${tuiVersion}`);
	}
	if (packageLock.cli.dependencies?.[packageName] !== packageRecord.version) {
		fail(`package-lock CLI pin ${packageLock.cli.dependencies?.[packageName]} does not match ${packageRecord.version}`);
	}
	if (packageLock.cli.dependencies?.[tuiPackageName] !== tuiVersion) {
		fail(`package-lock CLI Pi TUI pin does not match ${tuiVersion}`);
	}
	if (
		packageLock.sessionUi.peerDependencies?.[packageName] !== packageRecord.version ||
		packageLock.sessionUi.peerDependencies?.[tuiPackageName] !== tuiVersion
	) {
		fail("package-lock Session UI peers do not match the Pi tuple");
	}
	if (packageLock.node.version !== packageRecord.version) {
		fail(`package-lock version ${packageLock.node.version} does not match ${packageRecord.version}`);
	}
	if (packageLock.tui.version !== tuiVersion) fail(`package-lock Pi TUI version does not match ${tuiVersion}`);
	if (!dependencyRangeTargetsVersion(packageLock.node.dependencies?.[tuiPackageName], tuiVersion)) {
		fail(`Pi package does not target the pinned Pi TUI ${tuiVersion}`);
	}
	if (packageLock.node.integrity !== packageRecord.integrity) {
		fail("package-lock integrity does not match upstream/pi.lock.json");
	}
	if (!Array.isArray(lock.deviations)) fail("deviations must be an array");
	if (lock.deviations.length > 10) fail(`active Pi deviation count ${lock.deviations.length} exceeds hard cap 10`);

	if (online) {
		const metadata = registryMetadata(`${packageName}@${packageRecord.version}`);
		if (metadata.version !== packageRecord.version) fail("npm version does not match lock");
		if (metadata.gitHead !== lock.commit) fail(`npm gitHead ${metadata.gitHead} does not match ${lock.commit}`);
		if (metadata.integrity !== packageRecord.integrity) fail("npm integrity does not match lock");
		if (!dependencyRangeTargetsVersion(metadata.dependencies[tuiPackageName], tuiVersion)) {
			fail(`npm Pi package does not target Pi TUI ${tuiVersion}`);
		}
		if (registryVersion(`${tuiPackageName}@${tuiVersion}`) !== tuiVersion) fail("npm Pi TUI version is unavailable");
		const tagCommit = upstreamTagCommit(lock.tag);
		if (tagCommit !== lock.tagCommit) fail(`upstream ${lock.tag} is ${tagCommit}, expected ${lock.tagCommit}`);
		verifyTagContainsPackageSource(lock.tag, tagCommit, lock.commit);
	}

	console.log(
		JSON.stringify(
			{
				version: packageRecord.version,
				tag: lock.tag,
				tagCommit: lock.tagCommit,
				commit: lock.commit,
				integrity: packageRecord.integrity,
				compatibilityStatus: lock.compatibilityStatus,
				deviationCount: lock.deviations.length,
				onlineVerified: online,
			},
			null,
			2,
		),
	);
}

function writeLock(metadata) {
	const current = readJson(lockPath);
	const next = {
		schemaVersion: 2,
		repository: current.repository ?? "https://github.com/earendil-works/pi",
		tag: `v${metadata.version}`,
		tagCommit: metadata.tagCommit,
		commit: metadata.gitHead,
		packages: {
			[packageName]: {
				version: metadata.version,
				integrity: metadata.integrity,
			},
		},
		reviewedAt: null,
		compatibilityStatus: "pending-qualification",
		deviations: current.deviations ?? [],
	};
	writeFileSync(lockPath, `${JSON.stringify(next, null, "\t")}\n`);
}

function update(version) {
	const spec = version ? `${packageName}@${version}` : `${packageName}@latest`;
	const metadata = registryMetadata(spec);
	const tuiVersion = registryVersion(`${tuiPackageName}@${metadata.version}`);
	if (!dependencyRangeTargetsVersion(metadata.dependencies[tuiPackageName], tuiVersion)) {
		fail(`${packageName}@${metadata.version} does not target ${tuiPackageName}@${tuiVersion}`);
	}
	const tag = `v${metadata.version}`;
	const tagCommit = upstreamTagCommit(tag);
	verifyTagContainsPackageSource(tag, tagCommit, metadata.gitHead);
	metadata.tagCommit = tagCommit;

	runNpm(["install", "--save-dev", "--save-exact", `${packageName}@${metadata.version}`, "--ignore-scripts"], {
		stdio: "inherit",
	});
	runNpm(
		[
			"install",
			"--workspace",
			"packages/cli",
			"--save-exact",
			`${packageName}@${metadata.version}`,
			`${tuiPackageName}@${tuiVersion}`,
			"--ignore-scripts",
		],
		{ stdio: "inherit" },
	);
	runNpm(
		[
			"install",
			"--workspace",
			"packages/session-ui",
			"--save-peer",
			"--save-exact",
			`${packageName}@${metadata.version}`,
			`${tuiPackageName}@${tuiVersion}`,
			"--ignore-scripts",
		],
		{ stdio: "inherit" },
	);
	writeLock(metadata);
	console.log(`updated Pi candidate to ${metadata.version}; run npm run pi:qualify before promotion`);
}

function promote() {
	const lock = readJson(lockPath);
	if (lock.compatibilityStatus === "qualified") {
		validateLock({ online: true });
		console.log(`Pi ${lock.packages[packageName].version} is already qualified`);
		return;
	}
	if (lock.compatibilityStatus !== "pending-qualification") {
		fail(`only a pending candidate can be promoted; current status is ${lock.compatibilityStatus}`);
	}
	validateLock({ online: true });
	lock.reviewedAt = new Date().toISOString().slice(0, 10);
	lock.compatibilityStatus = "qualified";
	writeFileSync(lockPath, `${JSON.stringify(lock, null, "\t")}\n`);
	console.log(`promoted Pi ${lock.packages[packageName].version} after qualification`);
}

function checkLatest() {
	const lock = readJson(lockPath);
	const current = lock.packages?.[packageName]?.version;
	const latest = registryMetadata(`${packageName}@latest`).version;
	const result = { current, latest, updateAvailable: current !== latest };
	console.log(JSON.stringify(result, null, 2));
	if (process.argv.includes("--require-latest") && result.updateAvailable) process.exitCode = 2;
}

function help() {
	console.log(
		`Usage: node scripts/pi-upstream.mjs <command>\n\nCommands:\n  check [--online]       Validate local pin/lock; optionally verify npm and Git tag\n  latest [--require-latest]  Compare the exact pin with npm latest\n  update [version]       Update package/lock files and mark pending qualification\n  promote                Mark a verified pending candidate qualified`,
	);
}

const [command, argument] = process.argv.slice(2);
switch (command) {
	case "check":
		validateLock({ online: process.argv.includes("--online") });
		break;
	case "latest":
		checkLatest();
		break;
	case "update":
		update(argument);
		break;
	case "promote":
		promote();
		break;
	case "help":
	case "--help":
	case "-h":
	case undefined:
		help();
		break;
	default:
		fail(`unknown command: ${command}`);
}
