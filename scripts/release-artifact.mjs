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
	for (const os of ["ubuntu-latest", "macos-latest"]) {
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

// Native local-Windows qualification evidence (schemaVersion 1) binds the exact
// CI artifact to a completed native Windows run. Published as sanitized JSON:
// no local filesystem paths anywhere, including recorded Defender exclusions.
export const windowsEvidenceSchemaVersion = 1;
export const windowsEvidenceChecks = [
	"node22",
	"node24",
	"python310",
	"python312",
	"python313",
	"packedLocal",
	"packedNpmExec",
	"packedGlobal",
	"camoufox",
	"updateSuccess",
	"updateRollback",
	"publishedUpgrade",
];
const windowsUpdateAssertions = ["projectUnchanged", "userConfigUnchanged"];
const windowsUpgradeAssertions = ["explicitPassed", "rollbackPassed", "startupPassed"];
const windowsAssertionName = /^[a-z][A-Za-z0-9]*$/;
const windowsIsoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const windowsLocalPath = [/(^|[^A-Za-z])[A-Za-z]:[\\/]/, /\\\\/, /(?:^|[\s'"=])\/(?:home|Users|root)\//];
const windowsForbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);

function rejectUnsanitized(value, label) {
	if (typeof value === "string") {
		for (const pattern of windowsLocalPath) {
			assert.ok(
				!pattern.test(value),
				`${label} must be sanitized for publication (local path in ${JSON.stringify(value)})`,
			);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries()) rejectUnsanitized(entry, `${label}[${index}]`);
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const [key, entry] of Object.entries(value)) {
			assert.ok(!windowsForbiddenKeys.has(key), `${label} must not contain the ${key} key`);
			rejectUnsanitized(entry, `${label}.${key}`);
		}
	}
}

function checkEvidenceCheck(entry, label) {
	assert.ok(entry !== null && typeof entry === "object" && !Array.isArray(entry), `${label} must be a JSON object`);
	assert.ok(
		Object.keys(entry).every((key) => ["assertions", "command", "completedAt", "startedAt", "status"].includes(key)),
		`${label} fields differ from schema ${windowsEvidenceSchemaVersion}`,
	);
	assert.equal(entry.status, "passed", `${label} status must be passed`);
	assert.ok(typeof entry.command === "string" && entry.command.trim().length > 0, `${label} must record its command`);
	for (const field of ["startedAt", "completedAt"]) {
		assert.match(entry[field], windowsIsoTimestamp, `${label} ${field} must be an ISO-8601 UTC timestamp`);
		assert.ok(Number.isFinite(Date.parse(entry[field])), `${label} ${field} must be a valid timestamp`);
	}
	assert.ok(
		Date.parse(entry.completedAt) >= Date.parse(entry.startedAt),
		`${label} completedAt must not precede startedAt`,
	);
	if (entry.assertions === undefined) return;
	assert.ok(
		entry.assertions !== null && typeof entry.assertions === "object" && !Array.isArray(entry.assertions),
		`${label} assertions must be a JSON object`,
	);
	for (const [name, value] of Object.entries(entry.assertions)) {
		assert.match(name, windowsAssertionName, `${label} assertion names must be camelCase`);
		assert.strictEqual(value, true, `${label} assertion ${name} must be true`);
	}
}

export function verifyWindowsQualification(evidence, manifest) {
	assert.ok(
		evidence !== null && typeof evidence === "object" && !Array.isArray(evidence),
		"Windows qualification evidence must be a JSON object",
	);
	assert.deepEqual(
		Object.keys(evidence).sort(),
		["checks", "defender", "overall", "qualification", "schemaVersion", "sourceCommit", "tarball"],
		`Windows qualification evidence fields differ from schema ${windowsEvidenceSchemaVersion}`,
	);
	assert.equal(
		evidence.schemaVersion,
		windowsEvidenceSchemaVersion,
		"Windows qualification evidence schemaVersion must be 1",
	);
	assert.match(evidence.sourceCommit, /^[0-9a-f]{40}$/);
	assert.equal(
		evidence.sourceCommit,
		manifest.sourceCommit,
		"Windows qualification evidence does not name the qualification source commit",
	);
	assert.deepEqual(
		Object.keys(evidence.qualification).sort(),
		["repository", "runAttempt", "runId"],
		`Windows qualification fields differ from schema ${windowsEvidenceSchemaVersion}`,
	);
	assert.equal(
		evidence.qualification.repository,
		repository,
		"Windows qualification evidence names another repository",
	);
	assert.match(
		evidence.qualification.runId,
		/^[1-9]\d*$/,
		"Windows qualification runId must be a positive integer string",
	);
	assert.equal(
		evidence.qualification.runId,
		manifest.qualification.runId,
		"Windows qualification evidence does not name the qualification run",
	);
	assert.equal(
		evidence.qualification.runAttempt,
		manifest.qualification.runAttempt,
		"Windows qualification evidence does not name the qualification run attempt",
	);
	assert.deepEqual(
		Object.keys(evidence.tarball).sort(),
		["integrity", "sha256"],
		`Windows qualification tarball fields differ from schema ${windowsEvidenceSchemaVersion}`,
	);
	assert.match(evidence.tarball.sha256, /^[0-9a-f]{64}$/);
	assert.equal(
		evidence.tarball.sha256,
		manifest.tarball.sha256,
		"Windows qualification evidence does not bind the qualification artifact sha256",
	);
	assert.equal(
		evidence.tarball.integrity,
		manifest.tarball.integrity,
		"Windows qualification evidence does not bind the qualification artifact integrity",
	);
	assert.equal(evidence.overall, "passed", "Windows qualification overall result must be passed");
	assert.ok(
		evidence.checks !== null && typeof evidence.checks === "object" && !Array.isArray(evidence.checks),
		"Windows qualification checks must be a JSON object",
	);
	for (const name of windowsEvidenceChecks) {
		assert.ok(
			evidence.checks[name] !== undefined,
			`Windows qualification evidence is missing the required ${name} check`,
		);
	}
	for (const name of windowsUpdateAssertions.concat(windowsUpgradeAssertions)) {
		assert.strictEqual(
			evidence.checks.publishedUpgrade?.assertions?.[name],
			true,
			`publishedUpgrade check must assert ${name}`,
		);
	}
	for (const name of ["updateRollback", "updateSuccess"]) {
		for (const assertion of windowsUpdateAssertions) {
			assert.strictEqual(
				evidence.checks[name]?.assertions?.[assertion],
				true,
				`${name} check must assert ${assertion}`,
			);
		}
	}
	assert.ok(
		evidence.defender !== null && typeof evidence.defender === "object" && !Array.isArray(evidence.defender),
		"Windows qualification defender record must be a JSON object",
	);
	assert.deepEqual(
		Object.keys(evidence.defender).sort(),
		["after", "before"],
		`Windows qualification defender fields differ from schema ${windowsEvidenceSchemaVersion}`,
	);
	for (const side of ["before", "after"]) {
		const record = evidence.defender[side];
		assert.deepEqual(
			Object.keys(record).sort(),
			["exclusions", "realTimeProtectionEnabled"],
			`Windows qualification defender ${side} fields differ from schema ${windowsEvidenceSchemaVersion}`,
		);
		assert.strictEqual(
			record.realTimeProtectionEnabled,
			true,
			`Windows qualification defender ${side} must record active real-time protection`,
		);
		assert.ok(Array.isArray(record.exclusions), `Windows qualification defender ${side} exclusions must be an array`);
		for (const entry of record.exclusions)
			assert.equal(typeof entry, "string", `Windows qualification defender ${side} exclusions must contain strings`);
	}
	assert.deepEqual(
		evidence.defender.before.exclusions,
		evidence.defender.after.exclusions,
		"Windows qualification must record unchanged Defender exclusions",
	);
	for (const [name, entry] of Object.entries(evidence.checks)) {
		assert.match(name, windowsAssertionName, "Windows qualification check names must be camelCase");
		checkEvidenceCheck(entry, `${name} check`);
	}
	rejectUnsanitized(evidence, "Windows qualification evidence");
	return evidence;
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
