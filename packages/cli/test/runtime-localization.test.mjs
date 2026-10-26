import assert from "node:assert/strict";
import { test } from "node:test";
import { createFastModeExtension, FAST_MODE_STATUS } from "../dist/fast-mode.js";
import { loadCatalog } from "../dist/locale-catalog.js";
import { PI_SETTINGS_ITEM_IDS, withPiUiLocalization } from "../dist/pi-ui-localization.js";
import { renderScrollbackTranscript } from "../dist/scrollback.js";
import {
	createSessionUiStyles,
	formatSlashCommandDescription,
	renderSessionLine,
	SESSION_UI_SLASH_COMMAND_IDS,
	sessionUiText,
	terminalTextWidth,
} from "../dist/session-ui/index.js";
import { assembledSession, capturedNotices } from "./fixtures/flow-assembly.mjs";
import {
	assertLinesFit,
	createSessionInfo,
	createSessionTree,
	createSettingsConfig,
	renderedText,
} from "./fixtures/pi-ui-localization.mjs";

const catalog = loadCatalog("ja");

test("Japanese Fast mode notices preserve persisted state and priority request payloads", async () => {
	const handlers = new Map();
	const commands = new Map();
	const entries = [];
	const statuses = new Map();
	const notices = [];
	const model = { id: "gpt-example", api: "openai-responses" };
	const ctx = {
		model,
		mode: "tui",
		isIdle: () => true,
		sessionManager: { getBranch: () => entries },
		ui: { setStatus: (key, value) => statuses.set(key, value), notify: (value) => notices.push(value) },
	};
	createFastModeExtension(catalog).factory({
		on: (key, value) => handlers.set(key, value),
		registerCommand: (key, value) => commands.set(key, value),
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
	});
	await commands.get("fast").handler("on", ctx);
	assert.match(notices.at(-1), /利用料金が高く/u);
	assert.equal(statuses.get(FAST_MODE_STATUS), "on");
	const payload = { model: model.id, input: [] };
	assert.deepEqual(handlers.get("before_provider_request")({ request: { model }, payload }, ctx), {
		...payload,
		service_tier: "priority",
	});
	assert.equal(payload.service_tier, undefined);
	await commands.get("fast").handler("off", ctx);
	assert.match(notices.at(-1), /無効/u);
	assert.deepEqual(
		entries.map((entry) => entry.data.enabled),
		[true, false],
	);
});

test("Japanese flow reset still requires explicit confirmation and leaves later prompts usable", async (t) => {
	const f = await assembledSession(t, { catalog });
	const notices = capturedNotices(f.session);
	await f.session.prompt("First request");
	await f.session.prompt("/flow reset");
	assert.equal(notices.at(-1).text, catalog.format("jouzu.cli.flow.resetConfirm"));
	assert.match(notices.at(-1).text, /\/flow reset confirm/u);
	await f.session.prompt("/flow reset confirm");
	assert.equal(notices.at(-1).text, catalog.format("jouzu.cli.flow.resetDone"));
	await f.session.prompt("After reset");
	assert.equal(f.bodies.length, 2);
	assert.equal(f.session.agent.state.errorMessage, undefined);
});

test("Japanese Fast mode stays visible in narrow session lines", () => {
	const theme = { fg: (_role, value) => value, bg: (_role, value) => value, bold: (value) => value };
	const styles = createSessionUiStyles(theme, { colorEnabled: false });
	const snapshot = { model: { providerId: "openai", modelId: "a-long-model-name", thinkingLevel: "high" } };
	for (const width of [12, 24, 48, 80]) {
		const line = renderSessionLine(snapshot, [], width, styles, sessionUiText(catalog), undefined, undefined, true);
		assert.equal(terminalTextWidth(line), width);
		assert.match(line, /高速/u);
	}
});

test("Japanese transcript export localizes labels without translating stored tool content", () => {
	const entries = [
		{
			type: "message",
			message: { role: "toolResult", toolName: "read", isError: true, content: "Exact stored output 日本語" },
		},
	];
	for (const width of [24, 48, 80]) {
		const output = renderScrollbackTranscript(entries, {
			width,
			catalog,
			sessionId: "session-id",
			exportedAt: new Date(0),
		});
		assert.ok(output.lines.every((line) => terminalTextWidth(line) <= width));
		const text = output.lines.join("\n");
		assert.match(text.replace(/\n/gu, ""), /ツール結果: read（エラー）/u);
		assert.match(text, /Exact stored output/u);
		assert.match(text, /session-id/u);
		assert.doesNotMatch(text, /Tool result:/u);
	}
});

test("every upstream built-in Pi slash command has a Japanese catalog description", async () => {
	const { BUILTIN_SLASH_COMMANDS } = await import(
		"../node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js"
	);
	const jaText = sessionUiText(catalog);
	const enText = sessionUiText(loadCatalog("en"));
	for (const command of BUILTIN_SLASH_COMMANDS) {
		if (command.name === "scoped-models") continue;
		assert.ok(command.name in SESSION_UI_SLASH_COMMAND_IDS, `missing slash command ID for /${command.name}`);
		const jaDesc = jaText.slashCommands[command.name];
		const enDesc = enText.slashCommands[command.name];
		assert.ok(jaDesc, `missing Japanese description for /${command.name}`);
		assert.ok(enDesc, `missing English description for /${command.name}`);
		assert.notEqual(jaDesc, enDesc, `/${command.name} should be localized in Japanese`);
	}
	assert.equal(enText.slashCommands.quit, "Quit Jouzu");
	assert.equal(jaText.slashCommands.quit, "Jouzu を終了");
	assert.equal(
		formatSlashCommandDescription("<provider> — Configure provider authentication", jaText.slashCommands.login),
		"<provider> — プロバイダー認証を設定",
	);
});

test("withPiUiLocalization localizes Pi /settings, submenus, and selector components in Japanese and restores prototypes", async () => {
	const pi = await import("../node_modules/@earendil-works/pi-coding-agent/dist/index.js");
	const tui = await import("../node_modules/@earendil-works/pi-tui/dist/index.js");
	const { TrustSelectorComponent } = await import(
		"../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/trust-selector.js"
	);
	pi.initTheme("dark");
	tui.setCapabilityOverrides({ images: "kitty" });

	const settingsConfig = {
		autoCompact: true,
		showImages: true,
		imageWidthCells: 80,
		autoResizeImages: true,
		blockImages: false,
		enableSkillCommands: true,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		transport: "auto",
		sessionShareDestination: "auto",
		httpIdleTimeoutMs: 300000,
		cacheWarmingMode: "off",
		hideThinkingBlock: false,
		mermaidRenderingMode: "final",
		showCacheMissNotices: false,
		collapseChangelog: true,
		quietStartup: true,
		enableInstallTelemetry: false,
		defaultProjectTrust: "ask",
		doubleEscapeAction: "tree",
		treeFilterMode: "default",
		warnings: {},
		modelThinkingLevels: {},
		availableDefaultModels: [],
		showHardwareCursor: true,
		editorPaddingX: 0,
		outputPad: 1,
		autocompleteMaxVisible: 5,
		clearOnShrink: false,
		showTerminalProgress: true,
		tuiMode: "fullscreen",
		fullscreenExitOutput: "resume-hint",
		fullscreenScrollbar: "auto",
		fullscreenCopyOnSelect: true,
		fullscreenWheelScrollLines: "auto",
		currentTheme: "dark",
		terminalTheme: "dark",
		availableThemes: ["dark", "light", "system"],
	};

	await withPiUiLocalization(
		catalog,
		async () => {
			const selector = new pi.SettingsSelectorComponent(settingsConfig, {
				onCancel() {},
				onWarningsChange() {},
				onThemeChange() {},
			});
			const list = selector.getSettingsList();
			for (const item of list.items) {
				assert.ok(item.id in PI_SETTINGS_ITEM_IDS, `missing PI_SETTINGS_ITEM_IDS entry for ${item.id}`);
			}
			const renderedSettings = tui.stripTerminalSequences(selector.render(100).join("\n"));
			assert.match(renderedSettings, /自動圧縮/u);
			assert.match(renderedSettings, /コンテキストが大きくなったときに自動で圧縮します/u);
			assert.match(renderedSettings, /入力して検索 · Enter\/Space で変更 · Esc でキャンセル/u);

			// Search in /settings matches both Japanese and original English labels.
			list.applyFilter("テーマ");
			assert.equal(
				list.filteredItems.some((item) => item.id === "theme"),
				true,
			);
			list.applyFilter("theme");
			assert.equal(
				list.filteredItems.some((item) => item.id === "theme"),
				true,
			);

			// Theme submenu and Automatic Theme submenu, opened through the owned settings list.
			const themeItem = list.items.find((item) => item.id === "theme");
			themeItem.currentValue = "dark/light";
			list.applyFilter("");
			list.selectItem("theme");
			list.handleInput("\r");
			const renderedAutoTheme = tui.stripTerminalSequences(list.render(100).join("\n"));
			assert.match(renderedAutoTheme, /自動テーマ/u);
			assert.match(renderedAutoTheme, /ライトテーマ/u);
			assert.match(renderedAutoTheme, /ダークテーマ/u);
			assert.match(renderedAutoTheme, /適用/u);

			// A nested theme SelectSubmenu opened from the automatic settings list.
			const autoThemeList = list.submenuComponent.inputComponent;
			autoThemeList.selectItem("light-theme");
			autoThemeList.handleInput("\r");
			const renderedLightTheme = tui.stripTerminalSequences(list.render(100).join("\n"));
			assert.match(renderedLightTheme, /ライトテーマ/u);
			assert.match(renderedLightTheme, /端末の配色から作成されたテーマ/u);

			// ThinkingSelectorComponent (/thinking)
			const thinking = new pi.ThinkingSelectorComponent(
				"medium",
				["off", "low", "medium", "high"],
				() => {},
				() => {},
				() => {},
				"medium",
			);
			const renderedThinking = tui.stripTerminalSequences(thinking.render(100).join("\n"));
			assert.match(renderedThinking, /思考レベル/u);
			assert.match(renderedThinking, /標準の推論（約 8k トークン） · 既定/u);

			// TrustSelectorComponent (/trust)
			const trust = new TrustSelectorComponent({
				cwd: "/workspace/sample",
				savedDecision: null,
				projectTrusted: false,
				onSelect() {},
				onCancel() {},
			});
			const renderedTrust = tui.stripTerminalSequences(trust.render(100).join("\n"));
			assert.match(renderedTrust, /プロジェクトの信頼設定/u);
			assert.match(renderedTrust, /保存された設定: なし/u);
			assert.match(renderedTrust, /現在のセッション: 未信頼/u);
			assert.match(renderedTrust, /信頼する/u);
			assert.match(renderedTrust, /信頼しない/u);

			// OAuthSelectorComponent (/login, /logout)
			const oauth = new pi.OAuthSelectorComponent(
				"login",
				[{ id: "anthropic", name: "Anthropic", authType: "oauth", subscription: true }],
				() => {},
				() => {},
			);
			const renderedOauth = tui.stripTerminalSequences(oauth.render(100).join("\n"));
			assert.match(renderedOauth, /設定するプロバイダーを選択:/u);
			assert.match(renderedOauth, /未設定/u);

			// UserMessageSelectorComponent (/fork)
			const fork = new pi.UserMessageSelectorComponent(
				[{ id: "m1", text: "Hello 日本語" }],
				() => {},
				() => {},
			);
			const renderedFork = tui.stripTerminalSequences(fork.render(100).join("\n"));
			assert.match(renderedFork, /メッセージからフォーク/u);
			assert.match(renderedFork, /メッセージ 1 \/ 1/u);
		},
		pi,
	);

	// After withPiUiLocalization finishes, English rendering is restored.
	const englishSelector = new pi.SettingsSelectorComponent(settingsConfig, { onCancel() {} });
	const englishRendered = tui.stripTerminalSequences(englishSelector.render(100).join("\n"));
	assert.match(englishRendered, /Auto-compact/u);
	assert.doesNotMatch(englishRendered, /自動圧縮/u);
});

test("native resume, tree, and fork components localize semantic fields and preserve rows", async () => {
	const pi = await import("@earendil-works/pi-coding-agent");
	const tui = await import("@earendil-works/pi-tui");
	pi.initTheme("dark");
	tui.setCapabilityOverrides({ images: "kitty" });
	let session;
	let tree;
	let fork;
	let emptyFork;

	await withPiUiLocalization(catalog, async () => {
		session = new pi.SessionSelectorComponent(
			async () => [createSessionInfo({ firstMessage: "No user messages found" })],
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
		);
		await new Promise((resolve) => setImmediate(resolve));
		const resumeText = renderedText(session, 100);
		assert.match(resumeText, /セッションを再開（現在のフォルダー）/u);
		assert.match(resumeText, /No user messages found/u);
		assert.match(resumeText, /Current Folder/u);
		assert.doesNotMatch(resumeText, /Resume Session \(Current Folder\)/u);
		assertLinesFit(assert, session, 48);

		session.toggleScope();
		assert.match(renderedText(session, 100), /セッションを再開（すべて）/u);

		tree = new pi.TreeSelectorComponent(
			createSessionTree(),
			"entry-1",
			40,
			() => {},
			() => {},
			() => {},
		);
		const treeText = renderedText(tree, 80);
		assert.match(treeText, /セッションツリー/u);
		assert.match(treeText, /入力して検索:/u);
		assert.match(treeText, /user: hello from the user/u);
		tree.handleInput("hello");
		const searched = renderedText(tree, 80);
		assert.match(searched, /入力して検索:.*hello/u);
		assert.doesNotMatch(searched, /Type to search:/u);
		assertLinesFit(assert, tree, 48);

		tree.showLabelInput("entry-1", undefined);
		const labelText = renderedText(tree, 80);
		assert.match(labelText, /ラベル（空欄で削除）:/u);
		assert.doesNotMatch(labelText, /Label \(empty to remove\):/u);
		assertLinesFit(assert, tree, 48);
		tree.hideLabelInput();

		tree.showLabelInput("entry-1", "keep me");
		const labelValueText = renderedText(tree, 80);
		assert.match(labelValueText, /ラベル（空欄で削除）:/u);
		assert.match(labelValueText, /keep me/u);

		fork = new pi.UserMessageSelectorComponent(
			[
				{ id: "m1", text: "No user messages found" },
				{ id: "m2", text: "Message 1 of 1" },
			],
			() => {},
			() => {},
		);
		const forkText = renderedText(fork, 100);
		assert.match(forkText, /メッセージからフォーク/u);
		assert.match(forkText, /メッセージ 1 \/ 2/u);
		assert.match(forkText, /メッセージ 2 \/ 2/u);
		assert.match(forkText, /No user messages found/u);
		assert.match(forkText, /Message 1 of 1/u);
		assertLinesFit(assert, fork, 48);

		emptyFork = new pi.UserMessageSelectorComponent(
			[],
			() => {},
			() => {},
		);
		const emptyText = renderedText(emptyFork, 48);
		assert.match(emptyText, /ユーザーメッセージが見つかりません/u);
		assert.doesNotMatch(emptyText, /No user messages found/u);
		assertLinesFit(assert, emptyFork, 48);
	});

	const resumeAfter = renderedText(session, 100);
	assert.match(resumeAfter, /Resume Session \(All\)/u);
	assert.doesNotMatch(resumeAfter, /セッションを再開/u);
	const treeAfter = renderedText(tree, 80);
	assert.match(treeAfter, /Type to search:.*hello/u);
	assert.match(treeAfter, /Label \(empty to remove\):/u);
	assert.match(treeAfter, /keep me/u);
	assert.doesNotMatch(treeAfter, /入力して検索:/u);
	assert.doesNotMatch(treeAfter, /ラベル（空欄で削除）:/u);
	const forkAfter = renderedText(fork, 100);
	assert.match(forkAfter, /Fork from Message/u);
	assert.match(forkAfter, /Message 1 of 2/u);
	assert.doesNotMatch(forkAfter, /メッセージからフォーク/u);
	const emptyForkAfter = renderedText(emptyFork, 48);
	assert.match(emptyForkAfter, /No user messages found/u);
	assert.doesNotMatch(emptyForkAfter, /ユーザーメッセージが見つかりません/u);
});

test("localization adapter leaves unrelated Text, SettingsList, and SelectList content alone", async () => {
	const pi = await import("@earendil-works/pi-coding-agent");
	const tui = await import("@earendil-works/pi-tui");
	pi.initTheme("dark");
	const textRender = tui.Text.prototype.render;
	const truncatedRender = tui.TruncatedText.prototype.render;
	let foreignSettings;

	await withPiUiLocalization(
		catalog,
		async () => {
			const text = new tui.Text("Theme", 0, 0);
			assert.equal(renderedText(text, 80).trim(), "Theme");
			const truncated = new tui.TruncatedText("No user messages found", 0, 0);
			assert.equal(renderedText(truncated, 80).trim(), "No user messages found");

			foreignSettings = new tui.SettingsList(
				[
					{
						id: "theme",
						label: "Theme",
						description: "Color theme for the interface",
						currentValue: "dark",
						values: ["dark"],
					},
					{
						id: "transport",
						label: "Transport",
						description: "Preferred transport",
						currentValue: "auto",
						values: ["auto"],
					},
					{
						id: "apply",
						label: "Apply",
						description: "Apply changes",
						currentValue: "yes",
						values: ["yes"],
					},
				],
				10,
				pi.getSettingsListTheme(),
				() => {},
				() => {},
				{ enableSearch: true },
			);
			const settingsText = renderedText(foreignSettings, 80);
			assert.match(settingsText, /Theme/u);
			assert.match(settingsText, /Color theme for the interface/u);
			assert.match(settingsText, /Transport/u);
			assert.match(settingsText, /Type to search/u);
			assert.doesNotMatch(settingsText, /テーマ/u);
			assert.doesNotMatch(settingsText, /入力して検索/u);
			foreignSettings.applyFilter("theme");
			assert.equal(
				foreignSettings.filteredItems.some((item) => item.id === "theme"),
				true,
			);

			const foreignSelect = new tui.SelectList(
				[{ value: "theme", label: "Theme", description: "No matching commands" }],
				10,
				pi.getSelectListTheme(),
			);
			const selectText = renderedText(foreignSelect, 80);
			assert.match(selectText, /Theme/u);
			assert.match(selectText, /No matching commands/u);
			foreignSelect.setFilter("zzz");
			const noMatch = renderedText(foreignSelect, 80);
			assert.match(noMatch, /No matching commands/u);
			assert.doesNotMatch(noMatch, /一致するコマンドがありません/u);
		},
		pi,
	);

	assert.equal(tui.Text.prototype.render, textRender);
	assert.equal(tui.TruncatedText.prototype.render, truncatedRender);
	const after = renderedText(foreignSettings, 80);
	assert.match(after, /Theme/u);
	assert.doesNotMatch(after, /テーマ/u);
});

test("settings hints are translated before truncation and instance data is restored after failure", async () => {
	const pi = await import("@earendil-works/pi-coding-agent");
	const tui = await import("@earendil-works/pi-tui");
	pi.initTheme("dark");
	const settingsRender = tui.SettingsList.prototype.render;
	const settingsMain = tui.SettingsList.prototype.renderMainList;
	const settingsFilter = tui.SettingsList.prototype.applyFilter;
	const selectRender = tui.SelectList.prototype.render;
	const selectFilter = tui.SelectList.prototype.setFilter;
	const selectorRender = pi.SettingsSelectorComponent.prototype.render;
	let failingSelector;

	await assert.rejects(
		withPiUiLocalization(
			catalog,
			async () => {
				const selector = new pi.SettingsSelectorComponent(createSettingsConfig(), { onCancel() {} });
				const text48 = renderedText(selector, 48);
				assert.match(text48, /入力して検索/u);
				assert.doesNotMatch(text48, /Type to search/u);
				assert.match(text48, /コンテキストが大きくなったときに/u);
				assertLinesFit(assert, selector, 48);

				const list = selector.getSettingsList();
				list.applyFilter("zzzz");
				const noMatch = renderedText(selector, 48);
				assert.match(noMatch, /一致する設定がありません/u);
				assert.doesNotMatch(noMatch, /No matching settings/u);
				assertLinesFit(assert, selector, 48);
				list.applyFilter("");

				failingSelector = new pi.SettingsSelectorComponent(createSettingsConfig(), { onCancel() {} });
				renderedText(failingSelector, 100);
				throw new Error("localization failure");
			},
			pi,
		),
		/localization failure/u,
	);

	assert.equal(tui.SettingsList.prototype.render, settingsRender);
	assert.equal(tui.SettingsList.prototype.renderMainList, settingsMain);
	assert.equal(tui.SettingsList.prototype.applyFilter, settingsFilter);
	assert.equal(tui.SelectList.prototype.render, selectRender);
	assert.equal(tui.SelectList.prototype.setFilter, selectFilter);
	assert.equal(pi.SettingsSelectorComponent.prototype.render, selectorRender);

	const after = renderedText(failingSelector, 100);
	assert.match(after, /Auto-compact/u);
	assert.match(after, /Type to search/u);
	assert.doesNotMatch(after, /自動圧縮/u);
	assert.doesNotMatch(after, /入力して検索/u);
});

test("catalog failures leave native settings items untouched", async () => {
	const pi = await import("@earendil-works/pi-coding-agent");
	pi.initTheme("dark");
	const throwingCatalog = Object.create(catalog);
	throwingCatalog.format = (id, args) => {
		if (id === "jouzu.cli.piUi.settings.warnings.label") throw new Error("catalog failure");
		return catalog.format(id, args);
	};
	let selector;

	await assert.rejects(
		withPiUiLocalization(
			throwingCatalog,
			async () => {
				selector = new pi.SettingsSelectorComponent(createSettingsConfig(), { onCancel() {} });
				renderedText(selector, 100);
			},
			pi,
		),
		/catalog failure/u,
	);

	const autocompact = selector.getSettingsList().items.find((item) => item.id === "autocompact");
	assert.equal(autocompact.label, "Auto-compact");
	const warnings = selector.getSettingsList().items.find((item) => item.id === "warnings");
	assert.equal(warnings.label, "Warnings");
	const after = renderedText(selector, 100);
	assert.match(after, /Auto-compact/u);
	assert.doesNotMatch(after, /自動圧縮/u);
});

test("localization adapter supports a live catalog getter and bypasses a fixed English catalog", async () => {
	const pi = await import("@earendil-works/pi-coding-agent");
	const tui = await import("@earendil-works/pi-tui");
	pi.initTheme("dark");
	const englishCatalog = loadCatalog("en");
	let current = englishCatalog;

	await withPiUiLocalization(
		() => current,
		async () => {
			const selector = new pi.SettingsSelectorComponent(createSettingsConfig(), { onCancel() {} });
			assert.match(renderedText(selector, 100), /Auto-compact/u);
			current = catalog;
			assert.match(renderedText(selector, 100), /自動圧縮/u);
		},
		pi,
	);

	current = catalog;
	await withPiUiLocalization(
		() => current,
		async () => {
			const selector = new pi.SettingsSelectorComponent(createSettingsConfig(), { onCancel() {} });
			assert.match(renderedText(selector, 100), /自動圧縮/u);
			current = englishCatalog;
			const english = renderedText(selector, 100);
			assert.match(english, /Auto-compact/u);
			assert.doesNotMatch(english, /自動圧縮/u);
			current = catalog;
			assert.match(renderedText(selector, 100), /自動圧縮/u);
		},
		pi,
	);

	let runtimeCurrent = catalog;
	await withPiUiLocalization(
		catalog,
		async () => {
			const selector = new pi.SettingsSelectorComponent(createSettingsConfig(), { onCancel() {} });
			assert.match(renderedText(selector, 100), /自動圧縮/u);
			runtimeCurrent = englishCatalog;
			const english = renderedText(selector, 100);
			assert.match(english, /Auto-compact/u);
			assert.doesNotMatch(english, /自動圧縮/u);
		},
		{
			SessionSelectorComponent: pi.SessionSelectorComponent,
			TreeSelectorComponent: pi.TreeSelectorComponent,
			UserMessageSelectorComponent: pi.UserMessageSelectorComponent,
			getCatalog: () => runtimeCurrent,
		},
	);

	const mainRender = tui.SettingsList.prototype.renderMainList;
	await withPiUiLocalization(
		englishCatalog,
		async () => {
			assert.equal(tui.SettingsList.prototype.renderMainList, mainRender);
			const selector = new pi.SettingsSelectorComponent(createSettingsConfig(), { onCancel() {} });
			const text = renderedText(selector, 100);
			assert.match(text, /Auto-compact/u);
			assert.match(text, /Type to search/u);
			assert.doesNotMatch(text, /自動圧縮/u);
		},
		pi,
	);
	assert.equal(tui.SettingsList.prototype.renderMainList, mainRender);
});
