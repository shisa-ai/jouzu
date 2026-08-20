import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDoctorReport } from "../dist/doctor.js";

function metadata(overrides = {}) {
	return {
		jouzuVersion: "0.1.0",
		piVersion: "0.84.2",
		profileSchemaVersion: 1,
		productLabel: "Agentic AI environment",
		lock: {
			schemaVersion: 1,
			repository: "https://github.com/earendil-works/pi-mono",
			tag: "v0.84.2",
			commit: "914cf1472e715297caa30db4b9535d534a9eb718",
			packages: {},
			reviewedAt: "2026-08-20",
			compatibilityStatus: "qualified",
			deviations: [],
			...overrides,
		},
	};
}

function paths(root) {
	return {
		agentDir: join(root, "agent"),
		stateDir: join(root, "state"),
		cacheDir: join(root, "cache"),
		sessionDir: join(root, "state", "sessions"),
		profileStatePath: join(root, "state", "profile-state.json"),
		backupDir: join(root, "state", "backups"),
	};
}

test("doctor reports an injected healthy Linux runtime without mutating roots", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-doctor-unit-"));
	rmSync(root, { recursive: true, force: true });
	const report = createDoctorReport({
		metadata: metadata(),
		paths: paths(root),
		profile: { id: "ja", source: "default" },
		piRuntimeVersion: "0.84.2",
		executable: "/opt/jouzu/node_modules/jouzu/dist/cli.js",
		env: { HOME: "/home/利用者", ANTHROPIC_API_KEY: "must-not-appear", HTTPS_PROXY: "must-not-appear" },
		platform: "linux",
		architecture: "x64",
		nodeVersion: "v22.19.0",
		locale: "ja-JP",
		commandPaths: { git: "/usr/bin/git", bash: "/usr/bin/bash" },
	});
	assert.equal(report.healthy, true);
	assert.match(report.text, /Platform: linux x64/);
	assert.match(report.text, /Locale: ja-JP/);
	assert.match(report.text, /Provider environment: present/);
	assert.match(report.text, /Proxy configured: yes/);
	assert.doesNotMatch(report.text, /must-not-appear/);
	assert.equal(rmSync(root, { recursive: true, force: true }), undefined);
});

test("doctor fails closed for unsupported Windows prerequisites and Pi drift", () => {
	const root = "C:\\Users\\利用者\\Jouzu 上手";
	const report = createDoctorReport({
		metadata: metadata({ compatibilityStatus: "pending" }),
		paths: {
			agentDir: `${root}\\agent`,
			stateDir: `${root}\\state`,
			cacheDir: `${root}\\cache`,
			sessionDir: `${root}\\state\\sessions`,
			profileStatePath: `${root}\\state\\profile-state.json`,
			backupDir: `${root}\\state\\backups`,
		},
		profile: { id: "core", source: "command line" },
		piRuntimeVersion: "0.85.0",
		executable: "C:\\Program Files\\nodejs\\node_modules\\jouzu\\dist\\cli.js",
		env: { USERPROFILE: "C:\\Users\\利用者", PATH: "" },
		platform: "win32",
		architecture: "x64",
		nodeVersion: "v20.18.0",
		locale: "ja-JP",
		commandPaths: { git: null, bash: null },
	});
	assert.equal(report.healthy, false);
	assert.match(report.text, /Node v20\.18\.0 is unsupported/);
	assert.match(report.text, /Git was not found/);
	assert.match(report.text, /Bash was not found; install Bash or Git Bash/);
	assert.match(report.text, /Pinned Pi 0\.84\.2 does not match loaded runtime 0\.85\.0/);
	assert.match(report.text, /Pi lock status is pending/);
	assert.match(report.text, /Result: action required/);
});
