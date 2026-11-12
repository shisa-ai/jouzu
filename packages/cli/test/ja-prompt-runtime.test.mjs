import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFlowSession } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { runPromptHook } from "../../../scripts/fixtures/prompt-hook.mjs";
import { createLanguageContractExtension, readStoredLanguageContractState } from "../dist/language-contract.js";
import { resolveArtifactPolicy, resolveResponseLanguage } from "../dist/language-settings.js";
import { resolveCatalog } from "../dist/locale-catalog.js";
import { createJouzuPresentationExtension, JOUZU_DEFAULT_GUIDANCE } from "../dist/presentation.js";
import { applyProfile } from "../dist/profile-manager.js";
import { loadBundledProfile } from "../dist/profiles.js";
import { roleLanguageContract } from "../dist/subagents/language.js";
import { configureChildResources, expandedChildResourceLoader } from "../dist/subagents/resources.js";
import { defaultAgentConfig } from "../dist/subagents/roles.js";

const metadata = { jouzuVersion: "0.2.1", displayVersion: "0.2.1", piVersion: "1.4.0" };
const japanesePolicy = loadBundledProfile("ja").assets.find((asset) => asset.target === "APPEND_SYSTEM.md");

async function start(t, { profile = "core", uiLocale = "en", responseLanguage = "auto", customPrompt } = {}) {
	const root = mkdtempSync(join(tmpdir(), "jouzu-ja-prompt-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const paths = {
		agentDir: root,
		stateDir: join(root, "state"),
		profileStatePath: join(root, "state", "profile-state.json"),
		backupDir: join(root, "state", "backups"),
	};
	applyProfile(loadBundledProfile(profile), paths, metadata.jouzuVersion);
	if (customPrompt) writeFileSync(join(root, "SYSTEM.md"), customPrompt);
	const language = createLanguageContractExtension({
		responseLanguage: resolveResponseLanguage({ config: responseLanguage }),
		artifactPolicy: resolveArtifactPolicy({}),
	});
	const fixture = await createFlowSession(t, {
		root,
		tools: ["read"],
		extensions: [
			language.extension,
			createJouzuPresentationExtension(
				metadata,
				{ id: profile, source: "explicit" },
				{
					catalog: resolveCatalog(uiLocale).bundle,
					responseLanguageSection: () => language.currentSection(),
				},
			),
		],
	});
	await fixture.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
	return { ...fixture, language, root };
}

for (const selection of [
	{ profile: "core", uiLocale: "ja", responseLanguage: "auto" },
	{ profile: "core", uiLocale: "en", responseLanguage: "ja" },
	{ profile: "ja", uiLocale: "en", responseLanguage: "auto" },
]) {
	test(`Pi receives current guidance for ${selection.profile}, UI ${selection.uiLocale}, responses ${selection.responseLanguage}`, async (t) => {
		const { session, requests, root } = await start(t, selection);
		await session.prompt("Inspect only. Preserve src/日本語.ts and the error TypeError: unchanged.");
		const system = requests[0].filter((message) => message.role === "system");
		assert.equal(system.length, 1);
		const { preamble, docs, addendum } = system[0].sections;
		assert.ok(preamble.includes(JOUZU_DEFAULT_GUIDANCE), "Japanese selection uses the shared streamlined guidance");
		assert.equal(preamble.split(JOUZU_DEFAULT_GUIDANCE).length, 2);
		assert.match(docs, /^<docs>\nFor Pi extension, SDK, or TUI development, start with .*\/index.md\./u);
		assert.match(preamble, /comments: Preserve the existing language/u);
		assert.match(preamble, /documentation: Follow the project's existing language/u);
		assert.match(preamble, /commits: Follow the project's existing language/u);
		assert.match(preamble, /reviews: Follow the project's existing language/u);
		assert.match(preamble, /Preserve commands, identifiers, paths, code, quoted text, and source error text exactly/u);
		if (selection.responseLanguage === "ja") assert.match(preamble, /Response language: Japanese \(ja\)/u);
		else assert.doesNotMatch(preamble, /Response language:/u);
		if (selection.profile === "ja") {
			assert.equal(readFileSync(join(root, "APPEND_SYSTEM.md"), "utf8"), japanesePolicy.bytes.toString("utf8"));
			assert.equal(addendum, `<addendum>\n${japanesePolicy.bytes.toString("utf8")}\n</addendum>`);
			for (const asset of loadBundledProfile("core").assets)
				assert.deepEqual(readFileSync(join(root, asset.target)), asset.bytes, asset.target);
		} else assert.doesNotMatch(session.systemPrompt, /Jouzu Japanese-First Policy/u);
	});
}

test("Japanese child resources inherit core skills and resolve the profile fallback in the role contract", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-ja-child-prompt-"));
	const previous = { ...process.env };
	t.after(() => {
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
		rmSync(root, { recursive: true, force: true });
	});
	const launch = {
		cwd: root,
		directory: root,
		profile: "ja",
		model: { id: "fixture" },
		role: defaultAgentConfig().roles.find((role) => role.id === "coder"),
	};
	configureChildResources(launch);
	const loader = await expandedChildResourceLoader(launch);
	assert.ok(loader.getAppendSystemPrompt().every((text) => !text.includes("Jouzu Japanese-First Policy")));
	for (const asset of loadBundledProfile("core").assets.filter((asset) => asset.target.startsWith("skills/")))
		assert.deepEqual(readFileSync(join(root, asset.target)), asset.bytes, asset.target);
	const child = loader.getExtensions().extensions.find((extension) => extension.path === "<inline:jouzu-child>");
	const rendered = runPromptHook(child.handlers.get("before_agent_start")[0], {
		options: { selectedTools: ["read"], skills: loader.getSkills().skills },
	});
	assert.ok(rendered.sections.preamble.includes(JOUZU_DEFAULT_GUIDANCE));
	assert.match(rendered.sections.preamble, /Write user-facing explanations in Japanese \(ja\)/u);
	assert.match(rendered.sections.preamble, /Return your result in Japanese\./u);
	assert.match(rendered.sections.preamble, /Follow the project's existing language/u);
	assert.match(rendered.sections.preamble, /jouzu-language-limitation/u);
});

test("Japanese response changes reach the next Pi request without rewriting the leading prompt or history", async (t) => {
	const { session, requests, language } = await start(t, { responseLanguage: "en" });
	const original = "Keep `src/日本語.ts`, `git status`, and `TypeError: unchanged` exactly.";
	await session.prompt(original);
	const first = structuredClone(requests[0]);
	const previousPrompt = session.systemPrompt;
	language.applyLanguage(resolveResponseLanguage({ session: "ja" }));
	assert.equal(language.currentContract().taskLanguage, "en", "staging does not change the active contract");
	assert.equal(session.systemPrompt, previousPrompt);
	await session.prompt("Report the result.");
	const system = requests[1].filter((message) => message.role === "system");
	assert.deepEqual(
		system[0],
		first.find((message) => message.role === "system"),
	);
	assert.equal(system.length, 2);
	assert.deepEqual(Object.keys(system[1].sections), ["preamble"]);
	assert.match(system[1].sections.preamble, /Response language: Japanese \(ja\)/u);
	assert.doesNotMatch(system[1].sections.preamble, /Response language: English/u);
	assert.ok(system[1].sections.preamble.includes(JOUZU_DEFAULT_GUIDANCE));
	assert.deepEqual(
		requests[1].find((message) => message.role === "user"),
		first.find((message) => message.role === "user"),
	);
	assert.equal(language.currentContract().taskLanguage, "ja");
});

test("Japanese response settings leave a user-owned SYSTEM.md unchanged in a Pi request", async (t) => {
	const customPrompt = "User-owned instructions: preserve this 日本語 and English text exactly.";
	const { session, requests, language } = await start(t, { uiLocale: "ja", responseLanguage: "ja", customPrompt });
	await session.prompt("Inspect only.");
	const originalSystem = requests[0].filter((message) => message.role === "system");
	assert.equal(originalSystem[0].sections.preamble, customPrompt);
	assert.doesNotMatch(session.systemPrompt, /Response language:|Artifact language policy|operating inside Jouzu/u);
	const originalPrompt = session.systemPrompt;
	language.applyLanguage(resolveResponseLanguage({ session: "en" }));
	await session.prompt("Inspect again.");
	assert.equal(session.systemPrompt, originalPrompt);
	assert.deepEqual(
		requests[1].filter((message) => message.role === "system"),
		originalSystem,
	);
});

for (const selection of [
	{ responseLanguage: "ja", customLanguage: "English", taskLanguage: "ja" },
	{ responseLanguage: "auto", customLanguage: "Japanese", taskLanguage: "preserve" },
]) {
	test(`custom main prompt does not replace the child's stored ${selection.responseLanguage} preference`, async (t) => {
		const previous = { ...process.env };
		t.after(() => {
			for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
			Object.assign(process.env, previous);
		});
		const customPrompt = `User-owned instructions: answer only in ${selection.customLanguage}. Preserve 日本語 and English text exactly.`;
		const { session, requests, root } = await start(t, { responseLanguage: selection.responseLanguage, customPrompt });
		await session.prompt("Inspect only. Preserve src/日本語.ts and TypeError: unchanged.");
		const parentSystem = requests[0].filter((message) => message.role === "system");
		assert.equal(parentSystem[0].sections.preamble, customPrompt);
		assert.doesNotMatch(session.systemPrompt, /Response language:|Artifact language policy|operating inside Jouzu/u);
		const parentPrompt = session.systemPrompt;
		const stored = readStoredLanguageContractState({ sessionManager: session.sessionManager });
		assert.equal(stored.contract.taskLanguage, selection.taskLanguage);

		const role = defaultAgentConfig().roles.find((role) => role.id === "coder");
		const launch = {
			cwd: root,
			directory: join(root, "child"),
			userAgentDir: root,
			profile: "core",
			model: { id: "fixture" },
			role,
			languageContract: roleLanguageContract(role, stored.contract, "core"),
		};
		configureChildResources(launch);
		const loader = await expandedChildResourceLoader(launch);
		assert.equal(loader.getSystemPrompt(), undefined, "the child does not reuse the parent's custom SYSTEM.md");
		const child = loader.getExtensions().extensions.find((extension) => extension.path === "<inline:jouzu-child>");
		const rendered = runPromptHook(child.handlers.get("before_agent_start")[0], {
			options: {
				selectedTools: role.tools,
				skills: loader.getSkills().skills,
				sections: { addendum: loader.getAppendSystemPrompt().join("\n") },
			},
		});
		assert.ok(!rendered.systemPrompt.includes(customPrompt));
		assert.match(rendered.sections.preamble, /Artifact language policy/u);
		if (selection.responseLanguage === "ja") {
			assert.match(rendered.sections.preamble, /Write user-facing explanations in Japanese \(ja\)/u);
			assert.match(rendered.sections.preamble, /Return your result in Japanese\./u);
			assert.doesNotMatch(rendered.sections.preamble, /Write user-facing explanations in English/u);
		} else {
			assert.match(rendered.sections.preamble, /Work in the language of the task you were given/u);
			assert.doesNotMatch(
				rendered.sections.preamble,
				/Write user-facing explanations in|Return your result in Japanese/u,
			);
		}
		assert.equal(readFileSync(join(root, "SYSTEM.md"), "utf8"), customPrompt);
		assert.equal(session.systemPrompt, parentPrompt);
	});
}
