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
	verifyWindowsQualification,
	windowsEvidenceChecks,
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

test("full hosted qualification succeeds without Windows", () => verifyQualification(run, jobs, manifest));

test("required hosted jobs cover Linux and macOS only", () => {
	assert.ok(requiredJobs().includes("release-artifacts"));
	assert.ok(requiredJobs().every((name) => !name.includes("windows")));
	for (const os of ["ubuntu-latest", "macos-latest"]) {
		for (const name of [
			`node (${os}, ${os === "ubuntu-latest" ? 22 : 24})`,
			`optional-camoufox (${os})`,
			`published-upgrade (${os})`,
			`packed-install (${os}, local)`,
			`packed-install (${os}, npm-exec)`,
			`packed-install (${os}, global)`,
			`automatic-update (${os}, success)`,
			`automatic-update (${os}, rollback)`,
			`python (${os}, 3.10)`,
			`python (${os}, 3.12)`,
			`python (${os}, 3.13)`,
		]) {
			assert.ok(requiredJobs().includes(name), name);
		}
	}
});

for (const [name, change] of [
	[
		"hosted Windows-only run",
		(list) => list.filter((job) => job.name.includes("windows") || job.name === "release-artifacts"),
	],
	["missing job", (list) => list.slice(1)],
	["duplicate job", (list) => [...list, list[0]]],
	[
		"skipped hosted job",
		(list) => list.map((job) => (job.name === "node (macos-latest, 24)" ? { ...job, conclusion: "skipped" } : job)),
	],
	[
		"failed hosted job",
		(list) =>
			list.map((job) => (job.name === "published-upgrade (ubuntu-latest)" ? { ...job, conclusion: "failure" } : job)),
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

const windowsTimestamp = (offsetMinutes) =>
	new Date(Date.parse("2026-09-06T03:00:00.000Z") + offsetMinutes * 60_000).toISOString();
const windowsUpdateAssertions = { projectUnchanged: true, userConfigUnchanged: true };

function windowsCheck(command, offsetMinutes = 5) {
	return {
		assertions: undefined,
		command,
		completedAt: windowsTimestamp(offsetMinutes),
		startedAt: windowsTimestamp(offsetMinutes - 5),
		status: "passed",
	};
}

function windowsEvidence() {
	const checks = {};
	for (const name of windowsEvidenceChecks) checks[name] = windowsCheck(`node scripts/run-${name}.mjs`);
	delete checks.node22.assertions;
	for (const name of ["updateRollback", "updateSuccess"]) checks[name].assertions = { ...windowsUpdateAssertions };
	checks.publishedUpgrade.assertions = {
		...windowsUpdateAssertions,
		explicitPassed: true,
		rollbackPassed: true,
		startupPassed: true,
	};
	return {
		checks,
		defender: {
			after: { exclusions: [], realTimeProtectionEnabled: true },
			before: { exclusions: [], realTimeProtectionEnabled: true },
		},
		overall: "passed",
		qualification: { repository: "shisa-ai/jouzu", runAttempt: 1, runId: "123" },
		schemaVersion: 1,
		sourceCommit: commit,
		tarball: { integrity: manifest.tarball.integrity, sha256: manifest.tarball.sha256 },
	};
}

test("native Windows evidence binds the qualification source, run, and artifact", () => {
	const evidence = windowsEvidence();
	assert.equal(verifyWindowsQualification(evidence, manifest), evidence);
	assert.throws(() => verifyWindowsQualification(windowsEvidence(), { ...manifest, sourceCommit: "b".repeat(40) }));
	assert.throws(() =>
		verifyWindowsQualification(
			windowsEvidence(),
			createManifest(Buffer.from("other bytes"), "1.2.3", commit, "123", 1),
		),
	);
	const extra = windowsEvidence();
	extra.checks.extraProbe = windowsCheck("node scripts/probe.mjs");
	assert.doesNotThrow(() => verifyWindowsQualification(extra, manifest));
});

test("native Windows evidence checks stay available to the publisher", () => {
	const required = [
		"camoufox",
		"node22",
		"node24",
		"packedGlobal",
		"packedLocal",
		"packedNpmExec",
		"publishedUpgrade",
		"python310",
		"python312",
		"python313",
		"updateRollback",
		"updateSuccess",
	];
	assert.deepEqual([...windowsEvidenceChecks].sort(), required);
});

for (const key of ["checks", "defender", "overall", "qualification", "schemaVersion", "sourceCommit", "tarball"])
	test(`reject Windows evidence without ${key}`, () => {
		const evidence = windowsEvidence();
		delete evidence[key];
		assert.throws(() => verifyWindowsQualification(evidence, manifest));
	});

for (const [name, mutate] of [
	[
		"unknown evidence field",
		(e) => {
			e.privatePath = "/private";
		},
	],
	[
		"evidence schema drift",
		(e) => {
			e.schemaVersion = 2;
		},
	],
	[
		"foreign source commit",
		(e) => {
			e.sourceCommit = "b".repeat(40);
		},
	],
	[
		"short source commit",
		(e) => {
			e.sourceCommit = "a".repeat(39);
		},
	],
	[
		"foreign qualification repository",
		(e) => {
			e.qualification.repository = "other/jouzu";
		},
	],
	[
		"foreign run",
		(e) => {
			e.qualification.runId = "124";
		},
	],
	[
		"string run attempt",
		(e) => {
			e.qualification.runAttempt = "1";
		},
	],
	[
		"foreign run attempt",
		(e) => {
			e.qualification.runAttempt = 2;
		},
	],
	[
		"reused artifact sha256",
		(e) => {
			e.tarball.sha256 = "f".repeat(64);
		},
	],
	[
		"reused artifact integrity",
		(e) => {
			e.tarball.integrity = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
		},
	],
	[
		"failed overall result",
		(e) => {
			e.overall = "failed";
		},
	],
	[
		"failed check status",
		(e) => {
			e.checks.node22.status = "failed";
		},
	],
	[
		"empty check command",
		(e) => {
			e.checks.node22.command = "   ";
		},
	],
	[
		"reversed check timestamps",
		(e) => {
			e.checks.node24.startedAt = windowsTimestamp(10);
		},
	],
	[
		"non-UTC check timestamp",
		(e) => {
			e.checks.node24.startedAt = "2026-09-06T03:00:00+02:00";
		},
	],
	[
		"false check assertion",
		(e) => {
			e.checks.updateSuccess.assertions.userConfigUnchanged = false;
		},
	],
	[
		"missing update assertion",
		(e) => {
			delete e.checks.updateRollback.assertions.projectUnchanged;
		},
	],
	[
		"missing startup path",
		(e) => {
			delete e.checks.publishedUpgrade.assertions.startupPassed;
		},
	],
	[
		"missing explicit path",
		(e) => {
			delete e.checks.publishedUpgrade.assertions.explicitPassed;
		},
	],
	[
		"missing rollback path",
		(e) => {
			delete e.checks.publishedUpgrade.assertions.rollbackPassed;
		},
	],
	[
		"false extra assertion",
		(e) => {
			e.checks.node24.assertions = { extra: false };
		},
	],
	[
		"non-object check",
		(e) => {
			e.checks.camoufox = "passed";
		},
	],
	[
		"inactive Defender before",
		(e) => {
			e.defender.before.realTimeProtectionEnabled = false;
		},
	],
	[
		"inactive Defender after",
		(e) => {
			e.defender.after.realTimeProtectionEnabled = false;
		},
	],
	[
		"changed Defender exclusions",
		(e) => {
			e.defender.after.exclusions = ["sidegrade-only"];
		},
	],
	[
		"non-array Defender exclusions",
		(e) => {
			e.defender.before.exclusions = "none";
		},
	],
	[
		"non-string Defender exclusion",
		(e) => {
			e.defender.before.exclusions = [7];
		},
	],
	[
		"check map prototype key",
		(e) => {
			e.checks = JSON.parse('{"__proto__": {"status": "passed"}}');
		},
	],
	[
		"local drive path in command",
		(e) => {
			e.checks.node22.command = "node C:\\Users\\runner\\jouzu\\test.mjs";
		},
	],
	[
		"local drive path with forward slash",
		(e) => {
			e.checks.node24.command = "npm pack D:/temp/jouzu.tgz";
		},
	],
	[
		"UNC path in command",
		(e) => {
			e.checks.camoufox.command = "node \\\\host\\share\\check.mjs";
		},
	],
	[
		"home path in command",
		(e) => {
			e.checks.packedGlobal.command = "npm test /home/builder/jouzu";
		},
	],
	[
		"macOS home path in command",
		(e) => {
			e.checks.packedLocal.command = "npm test /Users/builder/jouzu";
		},
	],
	[
		"root path in command",
		(e) => {
			e.checks.python312.command = "pytest /root/jouzu";
		},
	],
	[
		"local path in Defender exclusions",
		(e) => {
			e.defender.after.exclusions = ["C:\\temp"];
		},
	],
])
	test(`reject Windows evidence: ${name}`, () => {
		const evidence = windowsEvidence();
		mutate(evidence);
		assert.throws(() => verifyWindowsQualification(evidence, manifest));
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
