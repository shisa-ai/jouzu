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
const serverPackageName = "@earendil-works/pi-server";
const chordPackageName = "@earendil-works/chord";
const alignedRuntimePackageNames = [
	chordPackageName,
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	packageName,
	"@earendil-works/pi-protocol",
	serverPackageName,
	"@earendil-works/pi-telemetry",
	tuiPackageName,
];
const directRuntimePackageNames = [
	"@earendil-works/pi-ai",
	packageName,
	serverPackageName,
	"@earendil-works/pi-telemetry",
	tuiPackageName,
];
const esbuildPackageName = "esbuild";
const typeboxPackageName = "typebox";
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function fail(message) {
	throw new Error(message);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function pinManifestDependency(path, section, name, version) {
	const manifest = readJson(path);
	if (!manifest[section]) fail(`${path} is missing ${section}`);
	manifest[section][name] = version;
	writeFileSync(path, `${JSON.stringify(manifest, null, "\t")}\n`);
}

function setBundledDependency(path, name, bundled) {
	const manifest = readJson(path);
	if (!Array.isArray(manifest.bundleDependencies)) fail(`${path} is missing bundleDependencies`);
	const current = new Set(manifest.bundleDependencies);
	if (bundled) current.add(name);
	else current.delete(name);
	manifest.bundleDependencies = [...current];
	writeFileSync(path, `${JSON.stringify(manifest, null, "\t")}\n`);
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
	const server = packageLock.packages?.[`node_modules/${serverPackageName}`];
	const esbuild = packageLock.packages?.[`node_modules/${esbuildPackageName}`];
	const typebox = packageLock.packages?.[`node_modules/${typeboxPackageName}`];
	const cli = packageLock.packages?.["packages/cli"];
	const sessionUi = packageLock.packages?.["packages/session-ui"];
	const alignedRuntime = Object.fromEntries(
		alignedRuntimePackageNames.map((name) => [name, packageLock.packages?.[`node_modules/${name}`]]),
	);
	if (!node) fail(`${packageName} is missing from package-lock.json`);
	if (!tui) fail(`${tuiPackageName} is missing from package-lock.json`);
	if (!server) fail(`${serverPackageName} is missing from package-lock.json`);
	if (!esbuild) fail(`${esbuildPackageName} is missing from package-lock.json`);
	if (!typebox) fail(`${typeboxPackageName} is missing from package-lock.json`);
	if (!cli) fail("packages/cli is missing from package-lock.json");
	if (!sessionUi) fail("packages/session-ui is missing from package-lock.json");
	for (const [name, record] of Object.entries(alignedRuntime)) {
		if (!record) fail(`${name} is missing from package-lock.json`);
	}
	return { node, tui, server, esbuild, typebox, cli, sessionUi, alignedRuntime };
}

function validateLock({ online }) {
	const lock = readJson(lockPath);
	const packageJson = readJson(packagePath);
	const cliPackageJson = readJson(cliPackagePath);
	const sessionUiPackageJson = readJson(sessionUiPackagePath);
	const packageLock = packageLockRecords();
	const packageRecord = lock.packages?.[packageName];
	const serverRecord = lock.packages?.[serverPackageName];
	if (!packageRecord) fail(`${lockPath} is missing ${packageName}`);
	if (!serverRecord) fail(`${lockPath} is missing ${serverPackageName}`);
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
	if (packageJson.devDependencies?.[tuiPackageName] !== packageRecord.version) {
		fail(`package.json development pin for ${tuiPackageName} does not match ${packageRecord.version}`);
	}
	for (const name of directRuntimePackageNames) {
		if (cliPackageJson.dependencies?.[name] !== packageRecord.version) {
			fail(`jouzu runtime pin for ${name} must match the Pi tuple ${packageRecord.version}`);
		}
		if (packageLock.cli.dependencies?.[name] !== packageRecord.version) {
			fail(`package-lock CLI pin for ${name} must match the Pi tuple ${packageRecord.version}`);
		}
	}
	for (const name of alignedRuntimePackageNames) {
		if (packageLock.alignedRuntime[name].version !== packageRecord.version) {
			fail(`package-lock version for ${name} must match the Pi tuple ${packageRecord.version}`);
		}
	}
	const tuiVersion = cliPackageJson.dependencies?.[tuiPackageName];
	const esbuildVersion = cliPackageJson.dependencies?.[esbuildPackageName];
	const typeboxVersion = cliPackageJson.dependencies?.[typeboxPackageName];
	if (typeof tuiVersion !== "string" || !VERSION_RE.test(tuiVersion)) {
		fail(`jouzu runtime pin for ${tuiPackageName} must be exact`);
	}
	if (typeof esbuildVersion !== "string" || !VERSION_RE.test(esbuildVersion)) {
		fail(`jouzu runtime pin for ${esbuildPackageName} must be exact`);
	}
	if (typeof typeboxVersion !== "string" || !VERSION_RE.test(typeboxVersion)) {
		fail(`jouzu runtime pin for ${typeboxPackageName} must be exact`);
	}
	if (cliPackageJson.dependencies?.[serverPackageName] !== serverRecord.version) {
		fail(`jouzu runtime pin for ${serverPackageName} does not match ${serverRecord.version}`);
	}
	if (cliPackageJson.bundleDependencies?.includes(serverPackageName)) {
		fail(`jouzu runtime must install ${serverPackageName} separately from the bundled Pi tree`);
	}
	for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-telemetry"]) {
		if (!cliPackageJson.bundleDependencies?.includes(name)) {
			fail(`jouzu runtime must bundle ${name} alongside the bundled coding agent`);
		}
	}
	if (sessionUiPackageJson.peerDependencies?.[packageName] !== packageRecord.version) {
		fail(`session UI Pi peer does not match ${packageRecord.version}`);
	}
	if (sessionUiPackageJson.peerDependencies?.[tuiPackageName] !== tuiVersion) {
		fail(`session UI Pi TUI peer does not match ${tuiVersion}`);
	}
	if (packageLock.cli.dependencies?.[esbuildPackageName] !== esbuildVersion) {
		fail(`package-lock CLI esbuild pin does not match ${esbuildVersion}`);
	}
	if (packageLock.cli.dependencies?.[typeboxPackageName] !== typeboxVersion) {
		fail(`package-lock CLI typebox pin does not match ${typeboxVersion}`);
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
	if (packageLock.server.version !== serverRecord.version) {
		fail(`package-lock Pi server version does not match ${serverRecord.version}`);
	}
	if (packageLock.esbuild.version !== esbuildVersion) {
		fail(`package-lock esbuild version does not match ${esbuildVersion}`);
	}
	if (packageLock.typebox.version !== typeboxVersion) {
		fail(`package-lock typebox version does not match ${typeboxVersion}`);
	}
	if (!dependencyRangeTargetsVersion(packageLock.node.dependencies?.[tuiPackageName], tuiVersion)) {
		fail(`Pi package does not target the pinned Pi TUI ${tuiVersion}`);
	}
	if (!dependencyRangeTargetsVersion(packageLock.node.dependencies?.[typeboxPackageName], typeboxVersion)) {
		fail(`Pi package does not target the pinned typebox ${typeboxVersion}`);
	}
	if (packageLock.node.integrity !== packageRecord.integrity) {
		fail("package-lock integrity does not match upstream/pi.lock.json");
	}
	if (packageLock.server.integrity !== serverRecord.integrity) {
		fail("package-lock Pi server integrity does not match upstream/pi.lock.json");
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
		if (registryVersion(`${esbuildPackageName}@${esbuildVersion}`) !== esbuildVersion) {
			fail("npm esbuild version is unavailable");
		}
		if (registryVersion(`${typeboxPackageName}@${typeboxVersion}`) !== typeboxVersion) {
			fail("npm typebox version is unavailable");
		}
		const serverMetadata = registryMetadata(`${serverPackageName}@${serverRecord.version}`);
		if (serverMetadata.version !== serverRecord.version) fail("npm Pi server version does not match lock");
		if (serverMetadata.gitHead !== lock.commit)
			fail(`npm Pi server gitHead ${serverMetadata.gitHead} does not match ${lock.commit}`);
		if (serverMetadata.integrity !== serverRecord.integrity) fail("npm Pi server integrity does not match lock");
		const tagCommit = upstreamTagCommit(lock.tag);
		if (tagCommit !== lock.tagCommit) fail(`upstream ${lock.tag} is ${tagCommit}, expected ${lock.tagCommit}`);
		verifyTagContainsPackageSource(lock.tag, tagCommit, lock.commit);
		verifyTagContainsPackageSource(lock.tag, tagCommit, serverMetadata.gitHead);
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

function writeLock(metadata, serverMetadata) {
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
			[serverPackageName]: {
				version: serverMetadata.version,
				integrity: serverMetadata.integrity,
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
	const serverMetadata = registryMetadata(`${serverPackageName}@${metadata.version}`);
	const chordMetadata = registryMetadata(`${chordPackageName}@${metadata.version}`);
	if (serverMetadata.version !== metadata.version || chordMetadata.version !== metadata.version) {
		fail(`Pi runtime packages do not share version ${metadata.version}`);
	}
	const esbuildVersion = chordMetadata.dependencies[esbuildPackageName];
	if (typeof esbuildVersion !== "string" || !VERSION_RE.test(esbuildVersion)) {
		fail(`${chordPackageName}@${chordMetadata.version} does not use an exact ${esbuildPackageName} version`);
	}
	const typeboxVersion = metadata.dependencies[typeboxPackageName];
	if (typeof typeboxVersion !== "string" || !VERSION_RE.test(typeboxVersion)) {
		fail(`${packageName}@${metadata.version} does not use an exact ${typeboxPackageName} version`);
	}
	const esbuildMetadata = registryMetadata(`${esbuildPackageName}@${esbuildVersion}`);
	if (!dependencyRangeTargetsVersion(metadata.dependencies[tuiPackageName], tuiVersion)) {
		fail(`${packageName}@${metadata.version} does not target ${tuiPackageName}@${tuiVersion}`);
	}
	if (!dependencyRangeTargetsVersion(metadata.dependencies[chordPackageName], chordMetadata.version)) {
		fail(`${packageName}@${metadata.version} does not target ${chordPackageName}@${chordMetadata.version}`);
	}
	const tag = `v${metadata.version}`;
	const tagCommit = upstreamTagCommit(tag);
	verifyTagContainsPackageSource(tag, tagCommit, metadata.gitHead);
	verifyTagContainsPackageSource(tag, tagCommit, serverMetadata.gitHead);
	metadata.tagCommit = tagCommit;

	pinManifestDependency(packagePath, "devDependencies", packageName, metadata.version);
	pinManifestDependency(packagePath, "devDependencies", tuiPackageName, tuiVersion);
	for (const name of directRuntimePackageNames) {
		pinManifestDependency(cliPackagePath, "dependencies", name, metadata.version);
	}
	pinManifestDependency(cliPackagePath, "dependencies", esbuildPackageName, esbuildMetadata.version);
	pinManifestDependency(cliPackagePath, "dependencies", typeboxPackageName, typeboxVersion);
	setBundledDependency(cliPackagePath, serverPackageName, false);
	setBundledDependency(cliPackagePath, "@earendil-works/pi-ai", true);
	setBundledDependency(cliPackagePath, "@earendil-works/pi-telemetry", true);
	setBundledDependency(cliPackagePath, typeboxPackageName, true);
	pinManifestDependency(sessionUiPackagePath, "peerDependencies", packageName, metadata.version);
	pinManifestDependency(sessionUiPackagePath, "peerDependencies", tuiPackageName, tuiVersion);

	runNpm(
		[
			"install",
			"--prefix",
			"packages/cli",
			"--package-lock-only",
			"--ignore-scripts",
			"--workspaces=false",
			"--legacy-peer-deps",
			"--install-strategy=nested",
		],
		{ stdio: "inherit" },
	);
	runNpm(["install", "--ignore-scripts"], { stdio: "inherit" });
	writeLock(metadata, serverMetadata);
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
