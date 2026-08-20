#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const lockPath = resolve(root, "upstream", "pi.lock.json");
const packagePath = resolve(root, "package.json");
const packageLockPath = resolve(root, "package-lock.json");
const packageName = "@earendil-works/pi-coding-agent";

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
	const output = runNpm(["view", spec, "version", "gitHead", "dist.integrity", "dist.tarball", "--json"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
	const parsed = JSON.parse(output);
	if (!parsed.version || !parsed.gitHead || !parsed["dist.integrity"] || !parsed["dist.tarball"]) {
		fail(`npm metadata for ${spec} is incomplete`);
	}
	return {
		version: parsed.version,
		gitHead: parsed.gitHead,
		integrity: parsed["dist.integrity"],
		tarball: parsed["dist.tarball"],
	};
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

function packageLockNode() {
	const packageLock = readJson(packageLockPath);
	const node = packageLock.packages?.[`node_modules/${packageName}`];
	if (!node) fail(`${packageName} is missing from package-lock.json`);
	return node;
}

function validateLock({ online }) {
	const lock = readJson(lockPath);
	const packageJson = readJson(packagePath);
	const packageLockNodeValue = packageLockNode();
	const packageRecord = lock.packages?.[packageName];
	if (!packageRecord) fail(`${lockPath} is missing ${packageName}`);
	if (lock.tag !== `v${packageRecord.version}`) fail(`tag ${lock.tag} does not match package ${packageRecord.version}`);
	if (packageJson.devDependencies?.[packageName] !== packageRecord.version) {
		fail(`package.json pin ${packageJson.devDependencies?.[packageName]} does not match ${packageRecord.version}`);
	}
	if (packageLockNodeValue.version !== packageRecord.version) {
		fail(`package-lock version ${packageLockNodeValue.version} does not match ${packageRecord.version}`);
	}
	if (packageLockNodeValue.integrity !== packageRecord.integrity) {
		fail("package-lock integrity does not match upstream/pi.lock.json");
	}
	if (!Array.isArray(lock.deviations)) fail("deviations must be an array");
	if (lock.deviations.length > 10) fail(`active Pi deviation count ${lock.deviations.length} exceeds hard cap 10`);

	if (online) {
		const metadata = registryMetadata(`${packageName}@${packageRecord.version}`);
		if (metadata.version !== packageRecord.version) fail("npm version does not match lock");
		if (metadata.gitHead !== lock.commit) fail(`npm gitHead ${metadata.gitHead} does not match ${lock.commit}`);
		if (metadata.integrity !== packageRecord.integrity) fail("npm integrity does not match lock");
		const tagCommit = upstreamTagCommit(lock.tag);
		if (tagCommit !== lock.commit) fail(`upstream ${lock.tag} is ${tagCommit}, expected ${lock.commit}`);
	}

	console.log(
		JSON.stringify(
			{
				version: packageRecord.version,
				tag: lock.tag,
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
		schemaVersion: current.schemaVersion ?? 1,
		repository: current.repository ?? "https://github.com/earendil-works/pi",
		tag: `v${metadata.version}`,
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
	const tagCommit = upstreamTagCommit(`v${metadata.version}`);
	if (tagCommit !== metadata.gitHead)
		fail(`npm gitHead ${metadata.gitHead} differs from v${metadata.version} ${tagCommit}`);

	runNpm(["install", "--save-dev", "--save-exact", `${packageName}@${metadata.version}`, "--ignore-scripts"], {
		stdio: "inherit",
	});
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
