#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { writeManifest } from "./release-artifact.mjs";

const root = resolve(import.meta.dirname, "..");
const packageDirectory = join(root, "packages", "cli");
const source = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
assert.equal(source.status, 0, source.stderr);
const sourceCommit = source.stdout.trim();
const packageJson = {
	...JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")),
	gitHead: sourceCommit,
};
const versionMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageJson.version);
if (!versionMatch) throw new Error(`CI artifacts require a stable semantic version, got ${packageJson.version}`);
const nextVersion = `${versionMatch[1]}.${versionMatch[2]}.${Number(versionMatch[3]) + 1}`;
const brokenVersion = `${versionMatch[1]}.${versionMatch[2]}.${Number(versionMatch[3]) + 2}`;
const outputDirectory = resolve(process.argv[2] ?? join(root, "dist", "ci-artifacts"));
const npmExecPath = process.env.npm_execpath;
const npmCommand = npmExecPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const npmPrefix = npmExecPath ? [npmExecPath] : [];

function runNpm(args, cwd) {
	const result = spawnSync(npmCommand, [...npmPrefix, ...args], {
		cwd,
		encoding: "utf8",
		maxBuffer: 128 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result.stdout;
}

function pack(directory, version, broken = false) {
	writeFileSync(join(directory, "package.json"), `${JSON.stringify({ ...packageJson, version }, null, 2)}\n`);
	if (broken) {
		writeFileSync(
			join(directory, "dist", "cli.js"),
			'#!/usr/bin/env node\nthrow new Error("intentional updater smoke failure");\n',
		);
	}
	const stdout = runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", outputDirectory], directory);
	return JSON.parse(stdout)[0];
}

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), "jouzu-ci-artifacts-"));
try {
	const fixture = join(temp, "package");
	mkdirSync(fixture, { recursive: true });
	for (const entry of ["camoufox-runtime", "dist", "node_modules", "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md"]) {
		cpSync(join(packageDirectory, entry), join(fixture, entry), { recursive: true });
	}
	const candidate = pack(fixture, packageJson.version);
	renameSync(join(outputDirectory, candidate.filename), join(outputDirectory, "candidate.tgz"));
	writeFileSync(join(outputDirectory, "pack-metadata.json"), `${JSON.stringify([candidate], null, 2)}\n`);
	writeManifest(outputDirectory, packageJson.version, sourceCommit);
	const next = pack(fixture, nextVersion);
	renameSync(join(outputDirectory, next.filename), join(outputDirectory, "next.tgz"));
	const broken = pack(fixture, brokenVersion, true);
	renameSync(join(outputDirectory, broken.filename), join(outputDirectory, "broken.tgz"));
	writeFileSync(
		join(outputDirectory, "artifacts.json"),
		`${JSON.stringify(
			{
				candidate: "candidate.tgz",
				currentVersion: packageJson.version,
				next: "next.tgz",
				nextVersion,
				broken: "broken.tgz",
				brokenVersion,
			},
			null,
			2,
		)}\n`,
	);
	console.log(
		`prepared ${basename(candidate.filename)}, ${basename(next.filename)}, and ${basename(broken.filename)} in ${outputDirectory}`,
	);
} finally {
	rmSync(temp, { recursive: true, force: true });
}
