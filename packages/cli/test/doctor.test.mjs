import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDoctorReport, formatDoctorReport } from "../dist/doctor.js";
import { ModelPickerStore } from "../dist/model-picker-state.js";

function metadata(overrides = {}) {
	return {
		jouzuVersion: "0.1.0",
		displayVersion: "0.1.0",
		build: undefined,
		piVersion: "0.84.2",
		profileSchemaVersion: 1,
		lock: {
			schemaVersion: 2,
			repository: "https://github.com/earendil-works/pi-mono",
			tag: "v0.84.2",
			tagCommit: "914cf1472e715297caa30db4b9535d534a9eb718",
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
		commandPaths: { git: "/usr/bin/git", bash: "/usr/bin/bash", npm: "/usr/bin/npm" },
		keybindingPlan: {
			schemaVersion: 1,
			defaultsVersion: 1,
			configPath: "/home/利用者/.config/jouzu/agent/keybindings.json",
			statePath: "/home/利用者/.local/state/jouzu/keybindings-state.json",
			configExists: true,
			policy: "applied",
			status: "converged",
			portabilityWarnings: [],
			actions: [],
		},
		updateStatus: {
			policy: "auto-restart",
			installChannel: "global-npm",
			startupEligible: true,
			state: {
				schemaVersion: 1,
				policy: "auto-restart",
				channel: "latest",
				lastCheckedAt: null,
				nextCheckAt: null,
				lastResult: "never",
				installedVersion: "0.1.0",
				latestVersion: null,
				latestIntegrity: null,
				previousVersion: null,
				lastUpdatedAt: null,
				lastErrorCode: null,
			},
		},
	});
	assert.equal(report.healthy, true);
	assert.match(report.text, /Platform: linux x64/);
	assert.match(report.text, /Locale: ja-JP/);
	assert.match(report.text, /Provider environment: present/);
	assert.match(report.text, /Proxy configured: yes/);
	assert.match(report.text, /Self-update policy: auto-restart/);
	assert.match(report.text, /Automatic startup update: eligible/);
	assert.match(report.text, /Keybinding defaults: converged/);
	assert.match(report.text, /Model picker state: absent/);
	assert.match(report.text, /Jouzu default follow-up key: ctrl\+enter/);
	assert.match(report.text, /Jouzu default dequeue key: ctrl\+up/);
	assert.doesNotMatch(report.text, /must-not-appear/);
	assert.equal(rmSync(root, { recursive: true, force: true }), undefined);
});

test("doctor reports model picker counts and unreadable state without rewriting it", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-doctor-model-picker-"));
	try {
		const resolvedPaths = paths(root);
		const store = new ModelPickerStore(resolvedPaths);
		store.toggleFavorite({ provider: "anthropic", modelId: "claude-test" }, new Date("2026-08-23T00:00:00.000Z"));
		store.recordDispatch(
			{ provider: "anthropic", modelId: "claude-test" },
			"a".repeat(64),
			new Date("2026-08-23T00:00:01.000Z"),
		);
		const reportFor = () =>
			createDoctorReport({
				metadata: metadata(),
				paths: resolvedPaths,
				profile: { id: "core", source: "default" },
				piRuntimeVersion: "0.84.2",
				executable: "/opt/jouzu/node_modules/jouzu/dist/cli.js",
				env: { HOME: "/home/user", ANTHROPIC_API_KEY: "redacted" },
				platform: "linux",
				commandPaths: { git: "/usr/bin/git", bash: "/usr/bin/bash", npm: "/usr/bin/npm" },
			});
		assert.match(
			reportFor().text,
			/Model picker state: 0 project defaults; 1 favorites; 1 global recents; 1 project scopes/,
		);

		const statePath = join(root, "state", "model-picker.json");
		writeFileSync(statePath, "{ broken");
		const unreadable = reportFor();
		assert.match(unreadable.text, /Model picker state: unreadable/);
		assert.match(unreadable.text, /- Model picker state is unreadable:/);
		assert.equal(readFileSync(statePath, "utf8"), "{ broken");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
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
		commandPaths: { git: null, bash: null, npm: null },
	});
	assert.equal(report.healthy, false);
	assert.match(report.text, /Node v20\.18\.0 is unsupported/);
	assert.match(report.text, /Git was not found/);
	assert.match(report.text, /Bash was not found; install Bash or Git Bash/);
	assert.match(report.text, /npm was not found on PATH/);
	assert.match(report.text, /Pinned Pi 0\.84\.2 does not match loaded runtime 0\.85\.0/);
	assert.match(report.text, /Pi lock status is pending/);
	assert.match(report.text, /Result: action required/);
});

test("doctor reports a Pi runtime load failure as action required", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-doctor-pi-fail-"));
	rmSync(root, { recursive: true, force: true });
	const report = createDoctorReport({
		metadata: metadata(),
		paths: paths(root),
		profile: { id: "core", source: "default" },
		piRuntimeVersion: "unavailable",
		piRuntimeDiagnostic: "Cannot find module '@earendil-works/pi-coding-agent'",
		executable: "/opt/jouzu/node_modules/jouzu/dist/cli.js",
		env: { HOME: "/home/user" },
		platform: "linux",
		commandPaths: { git: "/usr/bin/git", bash: "/usr/bin/bash", npm: "/usr/bin/npm" },
	});
	assert.equal(report.healthy, false);
	assert.match(report.text, /Pi runtime could not be loaded: Cannot find module/);
	assert.match(report.text, /Result: action required/);
	assert.equal(rmSync(root, { recursive: true, force: true }), undefined);
});

test("doctor reports a Pi version mismatch as action required", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-doctor-pi-version-"));
	rmSync(root, { recursive: true, force: true });
	const report = createDoctorReport({
		metadata: metadata(),
		paths: paths(root),
		profile: { id: "core", source: "default" },
		piRuntimeVersion: "0.85.0",
		executable: "/opt/jouzu/node_modules/jouzu/dist/cli.js",
		env: { HOME: "/home/user" },
		platform: "linux",
		commandPaths: { git: "/usr/bin/git", bash: "/usr/bin/bash", npm: "/usr/bin/npm" },
	});
	assert.equal(report.healthy, false);
	assert.match(report.text, /Pinned Pi 0\.84\.2 does not match loaded runtime 0\.85\.0/);
	assert.match(report.text, /Result: action required/);
	assert.equal(rmSync(root, { recursive: true, force: true }), undefined);
});

test("doctor reports a leftover profile lock as action required", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-doctor-lock-"));
	try {
		const stateDir = join(root, "state");
		mkdirSync(stateDir, { recursive: true });
		const lock = join(stateDir, "profile.lock");
		writeFileSync(lock, "");
		const past = new Date(Date.now() - 31 * 60 * 1000);
		utimesSync(lock, past, past);
		const report = createDoctorReport({
			metadata: metadata(),
			paths: paths(root),
			profile: { id: "core", source: "default" },
			piRuntimeVersion: "0.84.2",
			executable: "/opt/jouzu/node_modules/jouzu/dist/cli.js",
			env: { HOME: "/home/user" },
			platform: "linux",
			commandPaths: { git: "/usr/bin/git", bash: "/usr/bin/bash", npm: "/usr/bin/npm" },
		});
		assert.equal(report.healthy, false);
		assert.match(report.text, /Profile lock: owner unknown/);
		assert.match(report.text, /leftover state lock blocks Jouzu operations/);
		assert.match(report.text, /Result: action required/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("doctor maps every updater install channel to user-facing text", () => {
	const cases = [
		["global-npm", /Install channel: global npm install/],
		["local-npm", /Install channel: local npm install/],
		["ephemeral-npx", /Install channel: npx install/],
		["source", /Install channel: source checkout/],
		["other", /Install channel: other/],
	];
	const root = mkdtempSync(join(tmpdir(), "jouzu-doctor-channel-"));
	rmSync(root, { recursive: true, force: true });
	for (const [channel, pattern] of cases) {
		const report = createDoctorReport({
			metadata: metadata(),
			paths: paths(root),
			profile: { id: "core", source: "default" },
			piRuntimeVersion: "0.84.2",
			executable: "/any/executable",
			env: { HOME: "/home/user" },
			platform: "linux",
			commandPaths: { git: "/usr/bin/git", bash: "/usr/bin/bash", npm: "/usr/bin/npm" },
			updateStatus: {
				policy: "off",
				installChannel: channel,
				startupEligible: false,
				state: {
					schemaVersion: 1,
					policy: "off",
					channel: "latest",
					lastCheckedAt: null,
					nextCheckAt: null,
					lastResult: "never",
					installedVersion: "0.1.0",
					latestVersion: null,
					latestIntegrity: null,
					previousVersion: null,
					lastUpdatedAt: null,
					lastErrorCode: null,
				},
			},
		});
		assert.match(report.text, pattern, `channel ${channel}`);
	}
	assert.equal(rmSync(root, { recursive: true, force: true }), undefined);
});

function healthyContext(root) {
	return {
		metadata: metadata(),
		paths: paths(root),
		profile: { id: "core", source: "default" },
		piRuntimeVersion: "0.84.2",
		executable: "/opt/jouzu/dist/cli.js",
		env: { HOME: root },
		platform: "linux",
		architecture: "x64",
		nodeVersion: "v22.19.0",
		locale: "en-US",
		commandPaths: { git: "/usr/bin/git", bash: "/usr/bin/bash", npm: "/usr/bin/npm" },
	};
}

test("doctor exposes a structured report whose text rendering matches it", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-doctor-report-"));
	try {
		const result = createDoctorReport(healthyContext(root));
		const report = result.report;

		assert.equal(report.schemaVersion, 1);
		assert.equal(report.experimental, true);
		assert.equal(report.healthy, result.healthy);
		assert.ok(report.fields.length > 30, "the report carries every observed field");

		// Experimental schema 1 still requires unique machine keys within one report.
		const ids = report.fields.map((field) => field.id);
		assert.equal(new Set(ids).size, ids.length, "field identifiers are unique");
		for (const required of ["jouzu.version", "pi.runtime", "node", "git", "paths.stateDir", "packages.count"]) {
			assert.ok(ids.includes(required), `expected a ${required} field`);
		}
		const issueIds = report.issues.map((issue) => issue.id);
		assert.equal(new Set(issueIds).size, issueIds.length, "issue identifiers are unique");

		// The text output is a pure rendering of the report, not a second source of truth.
		assert.equal(formatDoctorReport(report), result.text);

		// Every field appears in the text exactly as label and value.
		for (const field of report.fields) {
			assert.ok(result.text.includes(`${field.label}: ${field.value}`), `${field.id} must appear in the text report`);
		}
		assert.match(result.text, /^Jouzu doctor\n/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("doctor issues drive health and the rendered warning and problem blocks", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-doctor-issues-"));
	try {
		const result = createDoctorReport({
			...healthyContext(root),
			piRuntimeVersion: "0.84.1",
			commandPaths: { git: null, bash: "/usr/bin/bash", npm: "/usr/bin/npm" },
		});

		const problems = result.report.issues.filter((issue) => issue.severity === "problem");
		assert.ok(
			problems.some((issue) => issue.id === "git.missing"),
			"a missing Git is reported as a problem",
		);
		assert.ok(
			problems.some((issue) => issue.id === "pi.versionMismatch"),
			"a Pi pin mismatch is reported as a problem",
		);
		assert.equal(result.healthy, false, "any problem makes the report unhealthy");
		assert.match(result.text, /\nProblems:\n/);
		assert.match(result.text, /Result: action required$/);
		for (const issue of problems) {
			assert.ok(result.text.includes(`- ${issue.message}`), `${issue.id} must be listed`);
		}

		const warnings = result.report.issues.filter((issue) => issue.severity === "warning");
		assert.ok(
			warnings.some((issue) => issue.id === "profile.notApplied"),
			"an unapplied profile is a warning, not a problem",
		);
		assert.match(result.text, /\nWarnings:\n/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a report without issues omits the warning and problem blocks", () => {
	const report = {
		schemaVersion: 1,
		experimental: true,
		healthy: true,
		fields: [{ id: "a", section: "runtime", label: "A", value: "1" }],
		issues: [],
		notes: ["Note text."],
	};
	assert.equal(
		formatDoctorReport(report),
		"Jouzu doctor\n\nA: 1\n\nNote text.\n\nResult: ready for Jouzu v0.1 preview",
	);
});
