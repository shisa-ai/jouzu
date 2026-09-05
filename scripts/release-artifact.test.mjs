import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { upgradeVersions } from "./published-upgrade.mjs";
import {
	createManifest,
	requiredJobs,
	verifyArtifact,
	verifyManifest,
	verifyQualification,
} from "./release-artifact.mjs";
import { verifyProvenance } from "./verify-published-release.mjs";

const bytes = Buffer.from("qualified package");
const commit = "a".repeat(40);
const manifest = createManifest(bytes, "1.2.3", commit, "123", 1);
const jobs = requiredJobs().map((name) => ({ name, status: "completed", conclusion: "success" }));
const run = {
	id: 123,
	run_attempt: 1,
	head_sha: commit,
	path: ".github/workflows/ci.yml",
	head_repository: { full_name: "shisa-ai/jouzu" },
	event: "push",
	status: "completed",
	conclusion: "success",
};

test("artifact bytes, schema and identity are bound", () => {
	assert.equal(verifyManifest(manifest, bytes), manifest);
	assert.throws(() => verifyManifest(manifest, Buffer.from("replacement")));
	assert.throws(() => verifyManifest({ ...manifest, privatePath: "/private" }, bytes));
	assert.throws(() => verifyManifest(manifest, bytes, { sourceCommit: "b".repeat(40) }));
});

test("published upgrade starts from the released updater and targets the candidate", () => {
	assert.deepEqual(upgradeVersions("0.1.7", "0.1.6"), {
		currentVersion: "0.1.6",
		nextVersion: "0.1.7",
		brokenVersion: "0.1.9",
	});
	assert.deepEqual(upgradeVersions("0.1.7"), { currentVersion: "0.1.7", nextVersion: "0.1.8", brokenVersion: "0.1.9" });
	for (const from of ["0.1.7", "0.1.8", "1.0.0", "invalid"]) assert.throws(() => upgradeVersions("0.1.7", from));
});

test("full native qualification succeeds", () => verifyQualification(run, jobs, manifest));
for (const [name, change] of [
	[
		"Windows-only matrix",
		(list) => list.filter((job) => job.name.includes("windows") || job.name === "release-artifacts"),
	],
	["missing job", (list) => list.slice(1)],
	["duplicate job", (list) => [...list, list[0]]],
	[
		"skipped Windows job",
		(list) => list.map((job) => (job.name === "node (windows-latest, 22)" ? { ...job, conclusion: "skipped" } : job)),
	],
	[
		"failed Windows job",
		(list) =>
			list.map((job) => (job.name === "published-upgrade (windows-latest)" ? { ...job, conclusion: "failure" } : job)),
	],
])
	test(`reject ${name}`, () => assert.throws(() => verifyQualification(run, change(jobs), manifest)));

test("reject wrong source, attempt, workflow, fork, or event", () => {
	for (const extra of [
		{ head_sha: "b".repeat(40) },
		{ run_attempt: 2 },
		{ path: "other.yml" },
		{ head_repository: { full_name: "other/jouzu" } },
		{ event: "pull_request" },
		{ status: "in_progress" },
	]) {
		assert.throws(() => verifyQualification({ ...run, ...extra }, jobs, manifest));
	}
});

const statement = {
	_type: "https://in-toto.io/Statement/v1",
	predicateType: "https://slsa.dev/provenance/v1",
	subject: [
		{
			name: "pkg:npm/jouzu@1.2.3",
			digest: { sha512: Buffer.from(manifest.tarball.integrity.slice(7), "base64").toString("hex") },
		},
	],
	predicate: {
		buildDefinition: {
			buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
			externalParameters: {
				workflow: {
					ref: "refs/tags/v1.2.3",
					repository: "https://github.com/shisa-ai/jouzu",
					path: ".github/workflows/publish-npm.yml",
				},
			},
			internalParameters: { github: { event_name: "workflow_dispatch" } },
			resolvedDependencies: [
				{ uri: "git+https://github.com/shisa-ai/jouzu@refs/tags/v1.2.3", digest: { gitCommit: commit } },
			],
		},
		runDetails: { metadata: { invocationId: "https://github.com/shisa-ai/jouzu/actions/runs/456/attempts/1" } },
	},
};
test("verified provenance must name the package, source, workflow, and publish run", () => {
	verifyProvenance(statement, manifest, "456");
	assert.throws(() => verifyProvenance(statement, manifest, "999"));
	for (const mutate of [
		(s) => {
			s.subject[0].digest.sha512 = "bad";
		},
		(s) => {
			s.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "b".repeat(40);
		},
		(s) => {
			s.predicate.buildDefinition.externalParameters.workflow.path = "other.yml";
		},
	]) {
		const copy = structuredClone(statement);
		mutate(copy);
		assert.throws(() => verifyProvenance(copy, manifest, "456"));
	}
});

test("packed metadata and checksum must agree with the manifest", () => {
	const directory = mkdtempSync(join(tmpdir(), "jouzu-artifact-test-"));
	try {
		mkdirSync(join(directory, "package"));
		writeFileSync(
			join(directory, "package", "package.json"),
			JSON.stringify({ name: "jouzu", version: "1.2.3", gitHead: commit }),
		);
		const packed = spawnSync("tar", ["-czf", join(directory, "candidate.tgz"), "-C", directory, "package"]);
		assert.equal(packed.status, 0);
		const actual = createManifest(readFileSync(join(directory, "candidate.tgz")), "1.2.3", commit, 123, 1);
		writeFileSync(join(directory, "release-manifest.json"), JSON.stringify(actual));
		writeFileSync(join(directory, "SHA256SUMS"), `${actual.tarball.sha256}  ${actual.tarball.name}\n`);
		assert.deepEqual(verifyArtifact(directory), actual);
		writeFileSync(join(directory, "SHA256SUMS"), "invalid\n");
		assert.throws(() => verifyArtifact(directory));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
