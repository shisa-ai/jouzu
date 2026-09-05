#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const repository = "shisa-ai/jouzu";
export const pinnedNpm = "11.16.0";

export function requiredJobs() {
	const names = ["release-artifacts", "legacy-linux-static-fetch (22.19.0)", "legacy-linux-static-fetch (24)"];
	for (const os of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
		for (const node of os === "ubuntu-latest" ? [22] : [22, 24]) names.push(`node (${os}, ${node})`);
		names.push(`optional-camoufox (${os})`, `published-upgrade (${os})`);
		for (const scope of ["local", "npm-exec", "global"]) names.push(`packed-install (${os}, ${scope})`);
		for (const scope of ["success", "rollback"]) names.push(`automatic-update (${os}, ${scope})`);
		for (const python of ["3.10", "3.12", "3.13"]) names.push(`python (${os}, ${python})`);
	}
	return names;
}

export function verifyQualification(run, jobs, manifest) {
	assert.equal(run.head_sha, manifest.sourceCommit);
	assert.equal(String(run.id), manifest.qualification.runId);
	assert.equal(run.run_attempt, manifest.qualification.runAttempt);
	assert.equal(run.path, ".github/workflows/ci.yml");
	assert.equal(run.head_repository.full_name, repository);
	assert.ok(["push", "workflow_dispatch"].includes(run.event));
	assert.equal(run.status, "completed");
	assert.equal(run.conclusion, "success");
	assert.equal(new Set(jobs.map((job) => job.name)).size, jobs.length, "duplicate qualification jobs");
	for (const name of requiredJobs()) {
		const job = jobs.find((entry) => entry.name === name);
		assert.ok(job, `missing qualification job: ${name}`);
		assert.equal(job.status, "completed", name);
		assert.equal(job.conclusion, "success", name);
	}
	for (const job of jobs) {
		assert.equal(job.status, "completed", job.name);
		assert.equal(job.conclusion, "success", job.name);
	}
}

export function digest(bytes, algorithm = "sha256", encoding = "hex") {
	return createHash(algorithm).update(bytes).digest(encoding);
}

export function packageManifest(tarball) {
	const result = spawnSync("tar", ["-xOf", resolve(tarball), "package/package.json"], {
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 1024 * 1024,
	});
	if (result.error) throw result.error;
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

export function createManifest(bytes, version, commit, runId, runAttempt) {
	assert.match(version, /^\d+\.\d+\.\d+$/);
	assert.match(commit, /^[a-f0-9]{40}$/);
	assert.match(String(runId), /^[1-9]\d*$/);
	assert.match(String(runAttempt), /^[1-9]\d*$/);
	return {
		schemaVersion: 1,
		package: "jouzu",
		version,
		sourceCommit: commit,
		qualification: { repository, runId: String(runId), runAttempt: Number(runAttempt) },
		tarball: {
			name: `jouzu-${version}.tgz`,
			size: bytes.length,
			sha256: digest(bytes),
			integrity: `sha512-${digest(bytes, "sha512", "base64")}`,
		},
	};
}

export function verifyManifest(manifest, bytes, expected = {}) {
	assert.deepEqual(
		manifest,
		createManifest(
			bytes,
			manifest.version,
			manifest.sourceCommit,
			manifest.qualification?.runId,
			manifest.qualification?.runAttempt,
		),
		"release manifest does not match package bytes or schema",
	);
	for (const [field, value] of Object.entries(expected)) {
		assert.equal(manifest[field], value, `release manifest ${field} mismatch`);
	}
	return manifest;
}

export function verifyArtifact(directory, expected = {}) {
	const manifest = JSON.parse(readFileSync(join(directory, "release-manifest.json"), "utf8"));
	const tarball = join(directory, "candidate.tgz");
	verifyManifest(manifest, readFileSync(tarball), expected);
	const pkg = packageManifest(tarball);
	assert.equal(pkg.name, manifest.package);
	assert.equal(pkg.version, manifest.version);
	assert.equal(pkg.gitHead, manifest.sourceCommit, "packed gitHead must identify the tested commit");
	assert.equal(
		readFileSync(join(directory, "SHA256SUMS"), "utf8"),
		`${manifest.tarball.sha256}  ${manifest.tarball.name}\n`,
	);
	return manifest;
}

export function writeManifest(directory, version, commit) {
	const manifest = createManifest(
		readFileSync(join(directory, "candidate.tgz")),
		version,
		commit,
		process.env.GITHUB_RUN_ID || "1",
		process.env.GITHUB_RUN_ATTEMPT || "1",
	);
	writeFileSync(join(directory, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	writeFileSync(join(directory, "SHA256SUMS"), `${manifest.tarball.sha256}  ${manifest.tarball.name}\n`);
	return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const [directory, commit, version] = process.argv.slice(2);
	assert.ok(directory && commit && version, "Usage: node scripts/release-artifact.mjs DIRECTORY COMMIT VERSION");
	console.log(JSON.stringify(verifyArtifact(directory, { sourceCommit: commit, version })));
}
