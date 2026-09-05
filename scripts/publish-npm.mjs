#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pinnedNpm, verifyArtifact, verifyQualification } from "./release-artifact.mjs";

const [directoryArg, ...flags] = process.argv.slice(2);
assert.ok(
	directoryArg && flags.every((flag) => flag === "--dry-run"),
	"Usage: node scripts/publish-npm.mjs ARTIFACT_DIRECTORY [--dry-run]",
);
const directory = resolve(directoryArg);
const commit = process.env.GITHUB_SHA;
const tag = process.env.GITHUB_REF_NAME;
assert.match(tag || "", /^v\d+\.\d+\.\d+$/);
const manifest = verifyArtifact(directory, { sourceCommit: commit, version: tag.slice(1) });
const run = JSON.parse(readFileSync(join(directory, "ci-run.json"), "utf8"));
const jobs = JSON.parse(readFileSync(join(directory, "ci-jobs.json"), "utf8"));
verifyQualification(run, jobs, manifest);
const npm = (args, capture = false) => {
	const result = spawnSync("npm", args, {
		encoding: "utf8",
		stdio: capture ? "pipe" : "inherit",
		timeout: 300_000,
	});
	if (result.error) throw result.error;
	assert.equal(result.status, 0, result.stderr || "npm command failed");
	return result.stdout;
};
assert.equal(npm(["--version"], true).trim(), pinnedNpm);
const response = await fetch(`https://registry.npmjs.org/jouzu/${manifest.version}`, {
	signal: AbortSignal.timeout(30_000),
});
assert.equal(
	response.status,
	404,
	response.ok ? "version is already published" : "registry absence could not be confirmed",
);
// Publishing an existing tarball preserves the exact bytes installed by CI.
npm([
	"publish",
	join(directory, "candidate.tgz"),
	"--registry=https://registry.npmjs.org/",
	"--access=public",
	"--provenance",
	"--ignore-scripts",
	...(flags.includes("--dry-run") ? ["--dry-run"] : []),
]);
