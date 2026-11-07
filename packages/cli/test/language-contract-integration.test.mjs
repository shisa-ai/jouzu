/**
 * The end-to-end language-contract scenarios.
 *
 * The other language-contract suites check one layer each. These tests compose the layers:
 * a saved `localization.json` is read, resolved, built into a contract, and
 * carried into the composed system prompt and the persisted prompt epoch; the
 * real built CLI reports the resolution; and the child, compaction, and
 * scheduled-work contracts stay unchanged.
 *
 * The tests read the compiled `dist` modules and, for the doctor cases, spawn
 * `dist/cli.js`, so `npm run build` must run first.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	buildResponseLanguageSection,
	createLanguageContractExtension,
	LANGUAGE_CONTRACT_ENTRY_TYPE,
	languagePromptDigest,
} from "../dist/language-contract.js";
import {
	projectPolicyPath,
	readProjectArtifactPolicy,
	resolveArtifactPolicy,
	resolveResponseLanguage,
} from "../dist/language-settings.js";
import {
	buildCapabilityRoutingGuidance,
	createJouzuPresentationExtension,
	jouzuPreamble,
} from "../dist/presentation.js";
import { BACKGROUND_MONITOR_LANGUAGE_CONTRACT, COMPACTOR_LANGUAGE_CONTRACT } from "../dist/subagents/language.js";
import { workerEnvironment } from "../dist/subagents/manager.js";
import { defaultAgentConfig, defaultLanguageContract } from "../dist/subagents/roles.js";
import {
	LOCALIZATION_FILE_NAME,
	readLocalizationConfigSnapshot,
	readLocalizationSettings,
	saveLocalizationConfig,
} from "../dist/ui-locale.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = join(packageRoot, "dist", "cli.js");
const piLock = JSON.parse(readFileSync(join(packageRoot, "dist", "pi.lock.json"), "utf8"));
const doctorExitStatus = piLock.compatibilityStatus === "qualified" ? 0 : 1;

const UPSTREAM_PROMPT =
	"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.\n\nAvailable tools:\n- read: Read file contents\n\nGuidelines:\n- Be concise in your responses";

const presentationMetadata = {
	jouzuVersion: "0.1.0",
	displayVersion: "0.1.0",
	build: undefined,
	piVersion: "1.0.0",
	profileSchemaVersion: 1,
	lock: { tag: "v1.0.0", tagCommit: "commit", commit: "commit", compatibilityStatus: "qualified", deviations: [] },
};
const presentationProfile = { id: "core", source: "default" };
const routingOptions = { customPrompt: undefined, selectedTools: ["read", "bg_task", "web_fetch"], skills: [] };

function scrubbedEnv() {
	const scrubbed = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key === "AI_AGENT" || /^JOUZU_/.test(key) || /^PI_CODING_AGENT(?:_|$)/.test(key)) continue;
		scrubbed[key] = value;
	}
	return scrubbed;
}

function runCli(args, options = {}) {
	return spawnSync(process.execPath, [cli, ...args], {
		encoding: "utf8",
		timeout: 30_000,
		env: { ...scrubbedEnv(), PI_OFFLINE: "1", ...options.env },
		cwd: options.cwd,
	});
}

function writeSettings(configDir, localization) {
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, LOCALIZATION_FILE_NAME),
		`${JSON.stringify({ schemaVersion: 2, localization }, null, 2)}\n`,
	);
}

/**
 * Wire the production language-contract extension and presentation extension the
 * way `main-cli.ts` does, so the section and the epoch are exercised together.
 */
function wireSession({ responseLanguage, artifactPolicy }) {
	const handlers = new Map();
	const entries = [];
	let idCounter = 0;
	const languageContract = createLanguageContractExtension({
		responseLanguage,
		artifactPolicy,
		now: () => new Date("2026-10-10T00:00:00.000Z"),
		newEpochId: () => `epoch-${++idCounter}`,
	});
	const pi = {
		on: (event, handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: () => {},
		registerTool: () => {},
		sendMessage: async () => {},
		events: { emit: () => {} },
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
	};
	// Register the language contract before presentation, as the launcher does,
	// so a staged change commits before the prompt is composed.
	languageContract.extension.factory(pi);
	createJouzuPresentationExtension(presentationMetadata, presentationProfile, {
		colorMode: "none",
		responseLanguageSection: () => languageContract.currentSection(),
	}).factory(pi);
	const ctx = { sessionManager: { getEntries: () => entries } };
	const emit = (event, data = {}) => {
		let result;
		for (const handler of handlers.get(event) ?? []) result = handler(data, ctx);
		return result;
	};
	return { languageContract, entries, emit };
}

function field(report, id) {
	return report.fields.find((entry) => entry.id === id)?.value;
}

// --- T21/T24: a settings value reaches the prompt section and the epoch ------

test("a saved response language reaches the composed prompt and the persisted epoch", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-language-integration-"));
	try {
		writeSettings(root, { uiLocale: "en", responseLanguage: "ja", artifactPolicy: { documentation: "ja" } });
		const read = readLocalizationSettings(root);
		assert.equal(read.status, "ok");
		const responseLanguage = resolveResponseLanguage({ config: read.settings.responseLanguage });
		const artifactPolicy = resolveArtifactPolicy({ config: read.settings.artifactPolicy });
		// The saved file is the winning source for both settings.
		assert.equal(responseLanguage.source, "config");
		assert.equal(responseLanguage.effective, "ja");
		assert.equal(artifactPolicy.source, "config");
		assert.equal(artifactPolicy.fieldSources.documentation, "config");

		const session = wireSession({ responseLanguage, artifactPolicy });
		session.emit("session_start", { type: "session_start", reason: "startup" });

		// The epoch is persisted with the config source and the section digest.
		const stored = session.entries.find((entry) => entry.customType === LANGUAGE_CONTRACT_ENTRY_TYPE);
		assert.ok(stored, "an epoch entry was appended");
		assert.equal(stored.data.epoch.source, "config");
		assert.equal(stored.data.epoch.contractId, session.languageContract.currentContract().contractId);
		assert.equal(stored.data.epoch.promptDigest, languagePromptDigest(session.languageContract.currentSection()));

		// The composed prompt carries exactly the Japanese section after the
		// existing guidance, and the rest of the prompt is unchanged.
		const section = buildResponseLanguageSection(session.languageContract.currentContract());
		const routing = buildCapabilityRoutingGuidance(routingOptions);
		const event = { systemPrompt: UPSTREAM_PROMPT, systemPromptOptions: { ...routingOptions, sections: {} } };
		session.emit("before_agent_start", event);
		// Presentation sets the preamble section; the section follows the existing guidance.
		const preamble = event.systemPromptOptions.sections.preamble;
		assert.equal(preamble, jouzuPreamble(routing, section));
		assert.match(preamble, /Response language: Japanese \(ja\)/u);
		assert.equal(session.languageContract.currentEpoch().source, "config");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("auto applies artifact instructions without fixing the response language end to end", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-language-integration-auto-"));
	try {
		writeSettings(root, { uiLocale: "en" });
		const read = readLocalizationSettings(root);
		assert.equal(read.status, "ok");
		const responseLanguage = resolveResponseLanguage({ config: read.settings.responseLanguage });
		assert.equal(responseLanguage.source, "builtin");
		assert.equal(responseLanguage.effective, "auto");
		const session = wireSession({ responseLanguage, artifactPolicy: resolveArtifactPolicy({}) });
		session.emit("session_start", { type: "session_start", reason: "startup" });
		const section = session.languageContract.currentSection();
		assert.match(section, /Artifact language policy/u);
		assert.doesNotMatch(section, /Response language:/u);
		const routing = buildCapabilityRoutingGuidance(routingOptions);
		const event = { systemPrompt: UPSTREAM_PROMPT, systemPromptOptions: { ...routingOptions, sections: {} } };
		session.emit("before_agent_start", event);
		const preamble = event.systemPromptOptions.sections.preamble;
		assert.equal(preamble, jouzuPreamble(routing, section));
		assert.doesNotMatch(preamble, /Response language:/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// --- T24: a UI-locale change leaves the response language unchanged ----------

test("a UI-locale change leaves the saved response language and artifact policy unchanged", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-language-integration-ui-"));
	try {
		writeSettings(root, { uiLocale: "en", responseLanguage: "ja", artifactPolicy: { commits: "ja" } });
		const before = readLocalizationSettings(root);
		assert.equal(before.status, "ok");
		const beforeLanguage = resolveResponseLanguage({ config: before.settings.responseLanguage });
		const beforePolicy = resolveArtifactPolicy({ config: before.settings.artifactPolicy });

		// Change only the UI locale through the real save path.
		const location = { configDir: root, stateDir: join(root, "state") };
		const snapshot = readLocalizationConfigSnapshot(root);
		saveLocalizationConfig(location, "ja", snapshot);

		const after = readLocalizationSettings(root);
		assert.equal(after.status, "ok");
		assert.equal(after.settings.uiLocale, "ja");
		assert.equal(after.settings.responseLanguage, "ja", "the response language survives a UI-locale save");
		assert.deepEqual(after.settings.artifactPolicy, { commits: "ja" });
		assert.deepEqual(resolveResponseLanguage({ config: after.settings.responseLanguage }), beforeLanguage);
		assert.deepEqual(resolveArtifactPolicy({ config: after.settings.artifactPolicy }), beforePolicy);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the CLI reports the same language contract, profile, and model under both UI locales", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-language-integration-cli-ui-"));
	try {
		const home = join(root, "home");
		const reportFor = (locale) => {
			writeSettings(home, { uiLocale: locale, responseLanguage: "ja", artifactPolicy: { commits: "ja" } });
			const result = runCli(["--jouzu-home", home, "--jouzu-ui-locale", locale, "doctor", "--json"]);
			assert.equal(result.status, doctorExitStatus, result.stderr || result.stdout);
			assert.equal(result.stderr, "");
			return JSON.parse(result.stdout);
		};
		const japanese = reportFor("ja");
		const english = reportFor("en");
		for (const id of [
			"language.responseLanguage.requested",
			"language.responseLanguage.effective",
			"language.responseLanguage.source",
			"language.artifactPolicy.requested",
			"language.artifactPolicy.effective",
			"language.artifactPolicy.source",
			"language.projectPolicy",
		]) {
			assert.equal(field(japanese, id), field(english, id), `${id} is independent of the UI locale`);
		}
		// T24: a UI-locale change leaves the profile, model, and provider alone.
		// The product has no region setting, so these fields are the surface that
		// a language setting must not move.
		for (const id of [
			"profile.selected",
			"modelPicker.state",
			"lock.profile",
			"lock.modelPicker",
			"provider.authFile",
			"provider.modelsFile",
			"provider.environment",
		]) {
			assert.equal(field(japanese, id), field(english, id), `${id} is independent of the UI locale`);
		}
		assert.equal(field(japanese, "language.responseLanguage.effective"), "ja");
		assert.equal(field(japanese, "language.responseLanguage.source"), "config");
		// The UI locale itself did move, so the independence is not a no-op.
		assert.notEqual(field(japanese, "localization.effective"), field(english, "localization.effective"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// --- T21/T22: a project policy is read only when it is trusted ---------------

test("an untrusted project policy is never read, and a trusted one supplies only the artifact policy", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-language-integration-trust-"));
	try {
		const repo = join(root, "repo");
		mkdirSync(join(repo, ".jouzu"), { recursive: true });
		writeFileSync(
			projectPolicyPath(repo),
			`${JSON.stringify({ localization: { responseLanguage: "en", artifactPolicy: { documentation: "en" } } })}\n`,
		);
		const configDir = join(root, "home");
		writeSettings(configDir, { uiLocale: "en", responseLanguage: "ja", artifactPolicy: { documentation: "ja" } });
		const before = readFileSync(join(configDir, LOCALIZATION_FILE_NAME), "utf8");

		// Untrusted: the file is not opened, so the saved setting wins and the
		// global settings file is untouched.
		assert.deepEqual(readProjectArtifactPolicy(repo, { trusted: false }), { status: "untrusted" });
		const settings = readLocalizationSettings(configDir);
		assert.equal(settings.status, "ok");
		const untrustedPolicy = resolveArtifactPolicy({ config: settings.settings.artifactPolicy });
		assert.equal(untrustedPolicy.effective.documentation, "ja");
		assert.equal(untrustedPolicy.fieldSources.documentation, "config");
		assert.equal(readFileSync(join(configDir, LOCALIZATION_FILE_NAME), "utf8"), before);

		// Trusted: only the artifact policy crosses the boundary, and it outranks
		// the saved setting. The response language still comes from the settings.
		const trusted = readProjectArtifactPolicy(repo, { trusted: true });
		assert.equal(trusted.status, "ok");
		assert.deepEqual(trusted.artifactPolicy, { documentation: "en" });
		const trustedPolicy = resolveArtifactPolicy({
			project: trusted.artifactPolicy,
			config: settings.settings.artifactPolicy,
		});
		assert.equal(trustedPolicy.effective.documentation, "en");
		assert.equal(trustedPolicy.fieldSources.documentation, "project");
		const responseLanguage = resolveResponseLanguage({ config: settings.settings.responseLanguage });
		assert.equal(responseLanguage.effective, "ja");
		assert.equal(responseLanguage.source, "config");

		// Absent: a trusted repository with no policy file keeps the saved
		// language and supplies nothing.
		const emptyRepo = join(root, "empty-repo");
		mkdirSync(emptyRepo, { recursive: true });
		assert.deepEqual(readProjectArtifactPolicy(emptyRepo, { trusted: true }), { status: "absent" });
		const absentPolicy = resolveArtifactPolicy({ config: settings.settings.artifactPolicy });
		assert.equal(absentPolicy.effective.documentation, "ja");
		assert.equal(absentPolicy.fieldSources.documentation, "config");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the CLI reports an untrusted project policy and leaves the global settings intact", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-language-integration-cli-trust-"));
	try {
		const home = join(root, "home");
		const repo = join(root, "repo");
		mkdirSync(join(repo, ".jouzu"), { recursive: true });
		writeFileSync(
			projectPolicyPath(repo),
			`${JSON.stringify({ localization: { artifactPolicy: { documentation: "en", commits: "en" } } })}\n`,
		);
		writeSettings(home, { uiLocale: "en", responseLanguage: "ja", artifactPolicy: { documentation: "ja" } });
		const before = readFileSync(join(home, LOCALIZATION_FILE_NAME), "utf8");

		const result = runCli(["--jouzu-home", home, "doctor", "--json"], { cwd: repo });
		assert.equal(result.status, doctorExitStatus, result.stderr || result.stdout);
		const report = JSON.parse(result.stdout);
		// No trust signal exists for a repository yet, so the project file is
		// reported as untrusted and contributes nothing.
		assert.equal(field(report, "language.projectPolicy"), "untrusted");
		assert.equal(
			field(report, "language.artifactPolicy.effective"),
			"comments=preserve documentation=ja commits=project reviews=project",
		);
		assert.equal(field(report, "language.artifactPolicy.source"), "config");
		assert.equal(readFileSync(join(home, LOCALIZATION_FILE_NAME), "utf8"), before);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// --- T12/T16/T19: children, compaction, and scheduled work stay unchanged ----

test("a saved response language does not change the role, compactor, or monitor contracts", () => {
	const roles = defaultAgentConfig().roles;
	const before = new Map();
	for (const role of roles) before.set(role.id, defaultLanguageContract(role).contractId);
	const compactorBefore = COMPACTOR_LANGUAGE_CONTRACT.contractId;
	const monitorBefore = BACKGROUND_MONITOR_LANGUAGE_CONTRACT.contractId;

	// Resolve two parent languages from settings and build both contracts.
	const root = mkdtempSync(join(tmpdir(), "jouzu-language-integration-roles-"));
	try {
		for (const language of ["ja", "en"]) {
			writeSettings(root, { uiLocale: "en", responseLanguage: language });
			const settings = readLocalizationSettings(root);
			assert.equal(settings.status, "ok");
			const responseLanguage = resolveResponseLanguage({ config: settings.settings.responseLanguage });
			const artifactPolicy = resolveArtifactPolicy({ config: settings.settings.artifactPolicy });
			// The parent contract changes, but the role contracts are fixed defaults.
			assert.equal(responseLanguage.effective, language);
			for (const role of roles) {
				assert.equal(defaultLanguageContract(role).contractId, before.get(role.id));
			}
			assert.equal(COMPACTOR_LANGUAGE_CONTRACT.contractId, compactorBefore);
			assert.equal(BACKGROUND_MONITOR_LANGUAGE_CONTRACT.contractId, monitorBefore);
			assert.equal(artifactPolicy.source, "builtin");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a UI-locale change leaves the child environment and scheduled work unchanged", () => {
	const source = { PATH: "/usr/bin", LANG: "ja_JP.UTF-8", LC_ALL: "ja_JP.UTF-8" };
	const before = workerEnvironment(source);
	assert.deepEqual(workerEnvironment(source), before);
	assert.equal(before.LANG, "ja_JP.UTF-8");
	assert.equal(before.LC_ALL, "ja_JP.UTF-8");

	const root = mkdtempSync(join(tmpdir(), "jouzu-language-integration-schedule-"));
	try {
		const scheduleFile = join(root, "schedule-prompts.json");
		const saved = {
			version: 1,
			jobs: [
				{
					id: "release-review",
					schedule: "0 9 * * *",
					prompt: "Review the release.",
					nextRun: "2026-06-01T09:00:00.000Z",
				},
			],
		};
		writeFileSync(scheduleFile, JSON.stringify(saved));
		const bytes = readFileSync(scheduleFile, "utf8");
		// Resolve both languages and a UI locale; none of them writes the store.
		writeSettings(root, { uiLocale: "ja", responseLanguage: "en" });
		const settings = readLocalizationSettings(root);
		assert.equal(settings.status, "ok");
		resolveResponseLanguage({ config: settings.settings.responseLanguage });
		assert.equal(readFileSync(scheduleFile, "utf8"), bytes);
		const after = JSON.parse(readFileSync(scheduleFile, "utf8")).jobs[0];
		assert.equal(after.prompt, saved.jobs[0].prompt);
		assert.equal(after.schedule, saved.jobs[0].schedule);
		assert.equal(after.nextRun, saved.jobs[0].nextRun);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
