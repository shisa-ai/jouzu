import {
	InteractiveMode,
	OAuthSelectorComponent,
	SessionSelectorComponent,
	SettingsSelectorComponent,
	ShowImagesSelectorComponent,
	ThemeSelectorComponent,
	ThinkingSelectorComponent,
	TreeSelectorComponent,
	UserMessageSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import {
	fuzzyFilter,
	SelectList,
	SettingsList,
	stripTerminalSequences,
	Text,
	TruncatedText,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { catalogText, defaultCatalog } from "./cli-messages.js";
import type { CatalogBundle } from "./locale-catalog.js";

/**
 * The catalog IDs for every setting in Pi's `SettingsSelectorComponent`,
 * `WarningSettingsSubmenu`, and `ThemeSubmenu`, keyed by `item.id`.
 */
export const PI_SETTINGS_ITEM_IDS: Readonly<
	Record<
		string,
		{ readonly labelId: string; readonly descriptionId: string; readonly keyMode?: "followUp" | "cycleThinking" }
	>
> = Object.freeze({
	autocompact: {
		labelId: "jouzu.cli.piUi.settings.autocompact.label",
		descriptionId: "jouzu.cli.piUi.settings.autocompact.description",
	},
	"show-images": {
		labelId: "jouzu.cli.piUi.settings.showImages.label",
		descriptionId: "jouzu.cli.piUi.settings.showImages.description",
	},
	"image-width-cells": {
		labelId: "jouzu.cli.piUi.settings.imageWidthCells.label",
		descriptionId: "jouzu.cli.piUi.settings.imageWidthCells.description",
	},
	"auto-resize-images": {
		labelId: "jouzu.cli.piUi.settings.autoResizeImages.label",
		descriptionId: "jouzu.cli.piUi.settings.autoResizeImages.description",
	},
	"block-images": {
		labelId: "jouzu.cli.piUi.settings.blockImages.label",
		descriptionId: "jouzu.cli.piUi.settings.blockImages.description",
	},
	"skill-commands": {
		labelId: "jouzu.cli.piUi.settings.skillCommands.label",
		descriptionId: "jouzu.cli.piUi.settings.skillCommands.description",
	},
	"show-hardware-cursor": {
		labelId: "jouzu.cli.piUi.settings.showHardwareCursor.label",
		descriptionId: "jouzu.cli.piUi.settings.showHardwareCursor.description",
	},
	"editor-padding": {
		labelId: "jouzu.cli.piUi.settings.editorPadding.label",
		descriptionId: "jouzu.cli.piUi.settings.editorPadding.description",
	},
	"output-padding": {
		labelId: "jouzu.cli.piUi.settings.outputPadding.label",
		descriptionId: "jouzu.cli.piUi.settings.outputPadding.description",
	},
	"autocomplete-max-visible": {
		labelId: "jouzu.cli.piUi.settings.autocompleteMaxVisible.label",
		descriptionId: "jouzu.cli.piUi.settings.autocompleteMaxVisible.description",
	},
	"clear-on-shrink": {
		labelId: "jouzu.cli.piUi.settings.clearOnShrink.label",
		descriptionId: "jouzu.cli.piUi.settings.clearOnShrink.description",
	},
	"terminal-progress": {
		labelId: "jouzu.cli.piUi.settings.terminalProgress.label",
		descriptionId: "jouzu.cli.piUi.settings.terminalProgress.description",
	},
	"steering-mode": {
		labelId: "jouzu.cli.piUi.settings.steeringMode.label",
		descriptionId: "jouzu.cli.piUi.settings.steeringMode.description",
	},
	"follow-up-mode": {
		labelId: "jouzu.cli.piUi.settings.followUpMode.label",
		descriptionId: "jouzu.cli.piUi.settings.followUpMode.description",
		keyMode: "followUp",
	},
	transport: {
		labelId: "jouzu.cli.piUi.settings.transport.label",
		descriptionId: "jouzu.cli.piUi.settings.transport.description",
	},
	"share-destination": {
		labelId: "jouzu.cli.piUi.settings.shareDestination.label",
		descriptionId: "jouzu.cli.piUi.settings.shareDestination.description",
	},
	"http-idle-timeout": {
		labelId: "jouzu.cli.piUi.settings.httpIdleTimeout.label",
		descriptionId: "jouzu.cli.piUi.settings.httpIdleTimeout.description",
	},
	"cache-warming-mode": {
		labelId: "jouzu.cli.piUi.settings.cacheWarmingMode.label",
		descriptionId: "jouzu.cli.piUi.settings.cacheWarmingMode.description",
	},
	"hide-thinking": {
		labelId: "jouzu.cli.piUi.settings.hideThinking.label",
		descriptionId: "jouzu.cli.piUi.settings.hideThinking.description",
	},
	"mermaid-rendering": {
		labelId: "jouzu.cli.piUi.settings.mermaidRendering.label",
		descriptionId: "jouzu.cli.piUi.settings.mermaidRendering.description",
	},
	"cache-miss-notices": {
		labelId: "jouzu.cli.piUi.settings.cacheMissNotices.label",
		descriptionId: "jouzu.cli.piUi.settings.cacheMissNotices.description",
	},
	"collapse-changelog": {
		labelId: "jouzu.cli.piUi.settings.collapseChangelog.label",
		descriptionId: "jouzu.cli.piUi.settings.collapseChangelog.description",
	},
	"quiet-startup": {
		labelId: "jouzu.cli.piUi.settings.quietStartup.label",
		descriptionId: "jouzu.cli.piUi.settings.quietStartup.description",
	},
	"install-telemetry": {
		labelId: "jouzu.cli.piUi.settings.installTelemetry.label",
		descriptionId: "jouzu.cli.piUi.settings.installTelemetry.description",
	},
	"default-project-trust": {
		labelId: "jouzu.cli.piUi.settings.defaultProjectTrust.label",
		descriptionId: "jouzu.cli.piUi.settings.defaultProjectTrust.description",
	},
	"double-escape-action": {
		labelId: "jouzu.cli.piUi.settings.doubleEscapeAction.label",
		descriptionId: "jouzu.cli.piUi.settings.doubleEscapeAction.description",
	},
	"tree-filter-mode": {
		labelId: "jouzu.cli.piUi.settings.treeFilterMode.label",
		descriptionId: "jouzu.cli.piUi.settings.treeFilterMode.description",
	},
	warnings: {
		labelId: "jouzu.cli.piUi.settings.warnings.label",
		descriptionId: "jouzu.cli.piUi.settings.warnings.description",
	},
	"model-thinking": {
		labelId: "jouzu.cli.piUi.settings.modelThinking.label",
		descriptionId: "jouzu.cli.piUi.settings.modelThinking.description",
		keyMode: "cycleThinking",
	},
	"tui-mode": {
		labelId: "jouzu.cli.piUi.settings.tuiMode.label",
		descriptionId: "jouzu.cli.piUi.settings.tuiMode.description",
	},
	"fullscreen-exit-output": {
		labelId: "jouzu.cli.piUi.settings.fullscreenExitOutput.label",
		descriptionId: "jouzu.cli.piUi.settings.fullscreenExitOutput.description",
	},
	"fullscreen-scrollbar": {
		labelId: "jouzu.cli.piUi.settings.fullscreenScrollbar.label",
		descriptionId: "jouzu.cli.piUi.settings.fullscreenScrollbar.description",
	},
	"fullscreen-copy-on-select": {
		labelId: "jouzu.cli.piUi.settings.fullscreenCopyOnSelect.label",
		descriptionId: "jouzu.cli.piUi.settings.fullscreenCopyOnSelect.description",
	},
	"fullscreen-wheel-scroll-lines": {
		labelId: "jouzu.cli.piUi.settings.fullscreenWheelScrollLines.label",
		descriptionId: "jouzu.cli.piUi.settings.fullscreenWheelScrollLines.description",
	},
	theme: {
		labelId: "jouzu.cli.piUi.settings.theme.label",
		descriptionId: "jouzu.cli.piUi.settings.theme.description",
	},
	"anthropic-extra-usage": {
		labelId: "jouzu.cli.piUi.settings.anthropicExtraUsage.label",
		descriptionId: "jouzu.cli.piUi.settings.anthropicExtraUsage.description",
	},
	"light-theme": {
		labelId: "jouzu.cli.piUi.settings.lightTheme.label",
		descriptionId: "jouzu.cli.piUi.settings.lightTheme.description",
	},
	"dark-theme": {
		labelId: "jouzu.cli.piUi.settings.darkTheme.label",
		descriptionId: "jouzu.cli.piUi.settings.darkTheme.description",
	},
	apply: {
		labelId: "jouzu.cli.piUi.settings.apply.label",
		descriptionId: "jouzu.cli.piUi.settings.apply.description",
	},
	"single-mode": {
		labelId: "jouzu.cli.piUi.settings.singleMode.label",
		descriptionId: "jouzu.cli.piUi.settings.singleMode.description",
	},
});

const THINKING_LEVEL_IDS: Readonly<Record<string, string>> = Object.freeze({
	off: "jouzu.cli.piUi.thinking.off",
	minimal: "jouzu.cli.piUi.thinking.minimal",
	low: "jouzu.cli.piUi.thinking.low",
	medium: "jouzu.cli.piUi.thinking.medium",
	high: "jouzu.cli.piUi.thinking.high",
	xhigh: "jouzu.cli.piUi.thinking.xhigh",
	max: "jouzu.cli.piUi.thinking.max",
});

const EXACT_TEXT_IDS: readonly string[] = Object.freeze([
	"jouzu.cli.piUi.thinking.title",
	"jouzu.cli.piUi.thinking.perModelTitle",
	"jouzu.cli.piUi.thinking.perModelSelectModel",
	"jouzu.cli.piUi.thinking.perModelSelectLevel",
	"jouzu.cli.piUi.theme.title",
	"jouzu.cli.piUi.theme.description",
	"jouzu.cli.piUi.theme.automaticTitle",
	"jouzu.cli.piUi.theme.automaticSubtitle1",
	"jouzu.cli.piUi.theme.automaticSubtitle2",
	"jouzu.cli.piUi.theme.lightTitle",
	"jouzu.cli.piUi.theme.lightDescription",
	"jouzu.cli.piUi.theme.darkTitle",
	"jouzu.cli.piUi.theme.darkDescription",
	"jouzu.cli.piUi.submenu.hintFilterBack",
	"jouzu.cli.piUi.submenu.hintBack",
	"jouzu.cli.piUi.trust.title",
	"jouzu.cli.piUi.trust.savedNone",
	"jouzu.cli.piUi.trust.sessionTrusted",
	"jouzu.cli.piUi.trust.sessionUntrusted",
	"jouzu.cli.piUi.trust.optionTrust",
	"jouzu.cli.piUi.trust.optionTrustSession",
	"jouzu.cli.piUi.trust.optionDoNotTrust",
	"jouzu.cli.piUi.trust.optionDoNotTrustSession",
	"jouzu.cli.piUi.oauth.loginTitle",
	"jouzu.cli.piUi.oauth.logoutTitle",
	"jouzu.cli.piUi.fork.title",
	"jouzu.cli.piUi.fork.description",
	"jouzu.cli.piUi.fork.empty",
	"jouzu.cli.piUi.resume.titleCurrent",
	"jouzu.cli.piUi.resume.titleAll",
	"jouzu.cli.piUi.resume.renameTitle",
	"jouzu.cli.piUi.tree.title",
	"jouzu.cli.piUi.tree.search",
	"jouzu.cli.piUi.tree.labelPrompt",
]);

interface SettingsItemShape {
	id: string;
	label: string;
	description?: string;
}

interface SelectItemShape {
	value: string;
	label: string;
	description?: string;
}

interface SettingsListThemeShape {
	label: (text: string, selected: boolean) => string;
	value: (text: string, selected: boolean) => string;
	description: (text: string) => string;
	cursor: string;
	hint: (text: string) => string;
}

type SettingsListInternals = {
	items: SettingsItemShape[];
	filteredItems: SettingsItemShape[];
	theme: SettingsListThemeShape;
	selectedIndex: number;
	submenuComponent: { render(width: number): string[] } | null;
};

interface SettingsListPrototype {
	render(this: SettingsList, width: number): string[];
	renderMainList(this: SettingsList, width: number): string[];
	applyFilter(this: SettingsList, query: string): void;
}

interface TextShape {
	text: string;
}

interface RenderablePrototype {
	render(this: object, width: number): string[];
}

export interface PiUiRuntime {
	InteractiveMode?: typeof InteractiveMode;
	SessionSelectorComponent?: typeof SessionSelectorComponent;
	TreeSelectorComponent?: typeof TreeSelectorComponent;
	UserMessageSelectorComponent?: typeof UserMessageSelectorComponent;
	/**
	 * Return the catalog for the next localized render. A host that reloads the
	 * display catalog after a confirmed Settings language change can supply this
	 * instead of restarting Pi. The getter is read on every render; when it
	 * returns an English bundle the adapter leaves the native components alone.
	 * Supply a dynamic getter from the start if the first catalog is English and
	 * a later in-session change should localize native components.
	 */
	getCatalog?: () => CatalogBundle;
}

interface Translators {
	text: (raw: string) => string;
	settingsHint: (text: string) => string;
	selectNoMatch: (text: string) => string;
	oauthTitle: (text: string) => string;
	oauthStatus: (text: string) => string;
}

interface LocalizationRuntime {
	getCatalog: () => CatalogBundle;
	ownedSettings: WeakSet<SettingsList>;
	ownedSelects: WeakSet<SelectList>;
	SessionSelectorComponent?: typeof SessionSelectorComponent;
	TreeSelectorComponent?: typeof TreeSelectorComponent;
	UserMessageSelectorComponent?: typeof UserMessageSelectorComponent;
}

interface CachedTranslators {
	locale: string;
	translators: Translators;
}

const translatorCache = new WeakMap<CatalogBundle, CachedTranslators>();

function buildTextTranslator(catalog: CatalogBundle): (raw: string) => string {
	const en = defaultCatalog();
	const exactPairs: Array<[string, string]> = [];
	for (const id of EXACT_TEXT_IDS) {
		const from = catalogText(en, id);
		const to = catalogText(catalog, id);
		if (from && to && from !== to) exactPairs.push([from, to]);
	}
	const exactMap = new Map(exactPairs);

	const splitTemplate = (id: string, token: string): [string, string] => {
		const rendered = catalogText(en, id, { [token]: `{${token}}` });
		const [prefix = "", suffix = ""] = rendered.split(`{${token}}`);
		return [prefix, suffix];
	};

	const [forModelPre, forModelSuf] = splitTemplate("jouzu.cli.piUi.thinking.perModelForModel", "model");
	const [cyclePre, cycleSuf] = splitTemplate("jouzu.cli.piUi.thinking.cycleHint", "key");
	const [loginPre, loginSuf] = splitTemplate("jouzu.cli.piUi.login.title", "provider");
	const [codePre, codeSuf] = splitTemplate("jouzu.cli.piUi.login.enterCode", "code");
	const [trustParentPre, trustParentSuf] = splitTemplate("jouzu.cli.piUi.trust.optionTrustParent", "path");
	const [savedTrustedPre, savedTrustedSuf] = splitTemplate("jouzu.cli.piUi.trust.savedTrusted", "path");
	const [savedUntrustedPre, savedUntrustedSuf] = splitTemplate("jouzu.cli.piUi.trust.savedUntrusted", "path");
	const [savedInhTrustedPre, savedInhTrustedSuf] = splitTemplate("jouzu.cli.piUi.trust.savedInheritedTrusted", "path");
	const [savedInhUntrustedPre, savedInhUntrustedSuf] = splitTemplate(
		"jouzu.cli.piUi.trust.savedInheritedUntrusted",
		"path",
	);

	const enFooter = catalogText(en, "jouzu.cli.piUi.thinking.footerHint", {
		confirm: "{confirm}",
		save: "{save}",
		cancel: "{cancel}",
	});
	const footerParts = enFooter.split(/\{(?:confirm|save|cancel)\}/u);

	return (raw: string): string => {
		const stripped = stripTerminalSequences(raw);
		const trimmed = stripped.trim();
		const exact = exactMap.get(trimmed);
		if (exact) return raw.replace(trimmed, exact);

		// Trust option row with selection/current markers (`→ ✓ Trust`, `    Do not trust`, etc.)
		const trustRowMatch = /^((?:→ | {2})(?:✓ | {2}))(.+)$/u.exec(stripped);
		if (trustRowMatch?.[2]) {
			const optionText = trustRowMatch[2];
			const exactOption = exactMap.get(optionText);
			if (exactOption) return raw.replace(optionText, exactOption);
			if (optionText.startsWith(trustParentPre) && optionText.endsWith(trustParentSuf)) {
				const path = optionText.slice(trustParentPre.length, optionText.length - trustParentSuf.length);
				return raw.replace(optionText, catalogText(catalog, "jouzu.cli.piUi.trust.optionTrustParent", { path }));
			}
		}

		const matchSingle = (pre: string, suf: string, id: string, key: string): string | undefined => {
			if (trimmed.startsWith(pre) && trimmed.endsWith(suf) && trimmed.length > pre.length + suf.length) {
				const val = trimmed.slice(pre.length, trimmed.length - suf.length);
				return raw.replace(trimmed, catalogText(catalog, id, { [key]: val }));
			}
			return undefined;
		};

		const singleMatched =
			matchSingle(forModelPre, forModelSuf, "jouzu.cli.piUi.thinking.perModelForModel", "model") ??
			matchSingle(cyclePre, cycleSuf, "jouzu.cli.piUi.thinking.cycleHint", "key") ??
			matchSingle(loginPre, loginSuf, "jouzu.cli.piUi.login.title", "provider") ??
			matchSingle(codePre, codeSuf, "jouzu.cli.piUi.login.enterCode", "code") ??
			matchSingle(savedInhTrustedPre, savedInhTrustedSuf, "jouzu.cli.piUi.trust.savedInheritedTrusted", "path") ??
			matchSingle(savedInhUntrustedPre, savedInhUntrustedSuf, "jouzu.cli.piUi.trust.savedInheritedUntrusted", "path") ??
			matchSingle(savedTrustedPre, savedTrustedSuf, "jouzu.cli.piUi.trust.savedTrusted", "path") ??
			matchSingle(savedUntrustedPre, savedUntrustedSuf, "jouzu.cli.piUi.trust.savedUntrusted", "path");
		if (singleMatched) return singleMatched;

		const [fp0, fp1, fp2, fp3] = footerParts;
		if (fp0 !== undefined && fp1 && fp2 && fp3 !== undefined && trimmed.includes(fp1) && trimmed.includes(fp2)) {
			const i1 = trimmed.indexOf(fp1);
			const i2 = trimmed.indexOf(fp2, i1 + fp1.length);
			if (i1 > 0 && i2 > i1 && trimmed.endsWith(fp3)) {
				const confirm = trimmed.slice(fp0.length, i1);
				const save = trimmed.slice(i1 + fp1.length, i2);
				const cancel = trimmed.slice(i2 + fp2.length, trimmed.length - fp3.length);
				return raw.replace(
					trimmed,
					catalogText(catalog, "jouzu.cli.piUi.thinking.footerHint", { confirm, save, cancel }),
				);
			}
		}

		const trustHintMatch = /^(\S+)\s+navigate\s+(\S+)\s+save\s+(\S+)\s+cancel$/u.exec(trimmed);
		if (trustHintMatch) {
			return catalogText(catalog, "jouzu.cli.piUi.trust.hint", {
				nav: trustHintMatch[1] ?? "",
				save: trustHintMatch[2] ?? "",
				cancel: trustHintMatch[3] ?? "",
			});
		}

		return raw;
	};
}

function buildTranslators(catalog: CatalogBundle): Translators {
	const en = defaultCatalog();
	const text = buildTextTranslator(catalog);
	const hintMap = new Map<string, string>([
		[catalogText(en, "jouzu.cli.piUi.settings.empty"), catalogText(catalog, "jouzu.cli.piUi.settings.empty")],
		[catalogText(en, "jouzu.cli.piUi.settings.noMatch"), catalogText(catalog, "jouzu.cli.piUi.settings.noMatch")],
		[catalogText(en, "jouzu.cli.piUi.settings.hintSearch"), catalogText(catalog, "jouzu.cli.piUi.settings.hintSearch")],
		[catalogText(en, "jouzu.cli.piUi.settings.hintPlain"), catalogText(catalog, "jouzu.cli.piUi.settings.hintPlain")],
	]);
	const selectNoMatchEn = catalogText(en, "jouzu.cli.piUi.select.noMatch");
	const selectNoMatchLocal = catalogText(catalog, "jouzu.cli.piUi.select.noMatch");
	const oauthLoginEn = catalogText(en, "jouzu.cli.piUi.oauth.loginTitle");
	const oauthLoginLocal = catalogText(catalog, "jouzu.cli.piUi.oauth.loginTitle");
	const oauthLogoutEn = catalogText(en, "jouzu.cli.piUi.oauth.logoutTitle");
	const oauthLogoutLocal = catalogText(catalog, "jouzu.cli.piUi.oauth.logoutTitle");
	const notConfiguredEn = ` • ${catalogText(en, "jouzu.cli.piUi.oauth.notConfigured")}`;
	const notConfiguredLocal = ` • ${catalogText(catalog, "jouzu.cli.piUi.oauth.notConfigured")}`;
	const configuredEn = ` ✓ ${catalogText(en, "jouzu.cli.piUi.oauth.configured")}`;
	const configuredLocal = ` ✓ ${catalogText(catalog, "jouzu.cli.piUi.oauth.configured")}`;

	const translateSpaced = (value: string, map: Map<string, string>): string => {
		const leading = value.match(/^\s*/u)?.[0] ?? "";
		const body = value.slice(leading.length);
		const localized = map.get(body);
		return localized === undefined ? value : leading + localized;
	};

	return {
		text,
		settingsHint: (value) => translateSpaced(value, hintMap),
		selectNoMatch: (value) =>
			value.includes(selectNoMatchEn) ? value.replace(selectNoMatchEn, selectNoMatchLocal) : value,
		oauthTitle: (value) => {
			const trimmed = stripTerminalSequences(value).trim();
			if (trimmed === oauthLoginEn) return value.replace(trimmed, oauthLoginLocal);
			if (trimmed === oauthLogoutEn) return value.replace(trimmed, oauthLogoutLocal);
			return value;
		},
		oauthStatus: (value) => {
			const visible = stripTerminalSequences(value);
			if (visible.endsWith(notConfiguredEn)) {
				const index = value.lastIndexOf(notConfiguredEn);
				if (index >= 0) {
					return value.slice(0, index) + notConfiguredLocal + value.slice(index + notConfiguredEn.length);
				}
			}
			if (visible.endsWith(configuredEn)) {
				const index = value.lastIndexOf(configuredEn);
				if (index >= 0) {
					return value.slice(0, index) + configuredLocal + value.slice(index + configuredEn.length);
				}
			}
			return value;
		},
	};
}

function translatorsFor(catalog: CatalogBundle): Translators {
	const cached = translatorCache.get(catalog);
	if (cached?.locale === catalog.locale) return cached.translators;
	const translators = buildTranslators(catalog);
	translatorCache.set(catalog, { locale: catalog.locale, translators });
	return translators;
}

interface ItemChange {
	item: { label: string; description?: string };
	label: string;
	description: string | undefined;
}

function applyItemChanges(changes: ReadonlyArray<ItemChange>): Array<() => void> {
	const restores: Array<() => void> = [];
	try {
		for (const { item, label, description } of changes) {
			const originalLabel = item.label;
			const originalDescription = item.description;
			restores.push(() => {
				if (item.label === label) item.label = originalLabel;
				if (item.description === description) item.description = originalDescription;
			});
			item.label = label;
			item.description = description;
		}
	} catch (error) {
		for (const restore of restores.reverse()) restore();
		throw error;
	}
	return restores;
}

function localizeSettingsItems(list: SettingsList, catalog: CatalogBundle): Array<() => void> {
	const items = (list as unknown as { items?: SettingsItemShape[] }).items ?? [];
	const en = defaultCatalog();
	const changes: Array<{ item: SettingsItemShape; label: string; description: string | undefined }> = [];
	for (const item of items) {
		const spec = PI_SETTINGS_ITEM_IDS[item.id];
		if (!spec) continue;
		const originalDescription = item.description;
		const label = catalogText(catalog, spec.labelId);
		let description: string;
		if (spec.keyMode === "followUp") {
			const enTemplate = catalogText(en, spec.descriptionId, { key: "{key}" });
			const [, suffix = ""] = enTemplate.split("{key}");
			const key =
				suffix && originalDescription?.endsWith(suffix)
					? originalDescription.slice(0, originalDescription.length - suffix.length)
					: "";
			description = catalogText(catalog, spec.descriptionId, { key });
		} else if (spec.keyMode === "cycleThinking") {
			const enTemplate = catalogText(en, spec.descriptionId, { key: "{key}" });
			const [prefix = "", suffix = ""] = enTemplate.split("{key}");
			const key =
				originalDescription?.startsWith(prefix) && originalDescription.endsWith(suffix)
					? originalDescription.slice(prefix.length, originalDescription.length - suffix.length)
					: "";
			description = catalogText(catalog, spec.descriptionId, { key });
		} else {
			description = catalogText(catalog, spec.descriptionId);
		}
		if (label !== item.label || description !== originalDescription) {
			changes.push({ item, label, description });
		}
	}

	return applyItemChanges(changes);
}

function localizeSelectItems(list: SelectList, catalog: CatalogBundle): Array<() => void> {
	const items = (list as unknown as { items?: SelectItemShape[] }).items ?? [];
	const en = defaultCatalog();
	const enDefaultSuffix = ` · ${catalogText(en, "jouzu.cli.piUi.thinking.defaultSuffix")}`;
	const localDefaultSuffix = ` · ${catalogText(catalog, "jouzu.cli.piUi.thinking.defaultSuffix")}`;
	const enClearLabel = `  ${catalogText(en, "jouzu.cli.piUi.thinking.clearOverride")}`;
	const enRevertTemplate = catalogText(en, "jouzu.cli.piUi.thinking.revertDefault", { level: "{level}" });
	const [enRevertPrefix = "", enRevertSuffix = ""] = enRevertTemplate.split("{level}");
	const enNoModelsLabel = catalogText(en, "jouzu.cli.piUi.thinking.noModelsLabel");
	const enSystemDesc = catalogText(en, "jouzu.cli.piUi.theme.systemDescription");
	const enAutoLabel = `  ${catalogText(en, "jouzu.cli.piUi.theme.automaticLabel")}`;
	const enCurrent = catalogText(en, "jouzu.cli.piUi.theme.current");
	const enYesDesc = catalogText(en, "jouzu.cli.piUi.showImages.yesDescription");
	const enNoDesc = catalogText(en, "jouzu.cli.piUi.showImages.noDescription");
	const changes: Array<{ item: SelectItemShape; label: string; description: string | undefined }> = [];

	for (const item of items) {
		const originalLabel = item.label;
		const originalDescription = item.description;
		let label = originalLabel;
		let description = originalDescription;
		let matched = false;

		const thinkingId = THINKING_LEVEL_IDS[item.value];
		if (thinkingId && description) {
			const enDesc = catalogText(en, thinkingId);
			if (description === enDesc) {
				description = catalogText(catalog, thinkingId);
				matched = true;
			} else if (description === `${enDesc}${enDefaultSuffix}`) {
				description = `${catalogText(catalog, thinkingId)}${localDefaultSuffix}`;
				matched = true;
			}
		}
		if (!matched && item.value === "__clear__" && label === enClearLabel) {
			label = `  ${catalogText(catalog, "jouzu.cli.piUi.thinking.clearOverride")}`;
			if (description?.startsWith(enRevertPrefix) && description.endsWith(enRevertSuffix)) {
				const level = description.slice(enRevertPrefix.length, description.length - enRevertSuffix.length);
				description = catalogText(catalog, "jouzu.cli.piUi.thinking.revertDefault", { level });
			}
			matched = true;
		}
		if (!matched && item.value === "__none__" && label === enNoModelsLabel) {
			label = catalogText(catalog, "jouzu.cli.piUi.thinking.noModelsLabel");
			description = catalogText(catalog, "jouzu.cli.piUi.thinking.noModelsDescription");
			matched = true;
		}
		if (!matched && item.value === "system" && description === enSystemDesc) {
			description = catalogText(catalog, "jouzu.cli.piUi.theme.systemDescription");
			matched = true;
		}
		if (!matched && item.value === "/" && label === enAutoLabel) {
			label = `  ${catalogText(catalog, "jouzu.cli.piUi.theme.automaticLabel")}`;
			description = catalogText(catalog, "jouzu.cli.piUi.theme.automaticDescription");
			matched = true;
		}
		if (!matched && item.value === "yes" && description === enYesDesc) {
			label = catalogText(catalog, "jouzu.cli.piUi.showImages.yesLabel");
			description = catalogText(catalog, "jouzu.cli.piUi.showImages.yesDescription");
			matched = true;
		}
		if (!matched && item.value === "no" && description === enNoDesc) {
			label = catalogText(catalog, "jouzu.cli.piUi.showImages.noLabel");
			description = catalogText(catalog, "jouzu.cli.piUi.showImages.noDescription");
			matched = true;
		}
		if (!matched && description === enCurrent) {
			description = catalogText(catalog, "jouzu.cli.piUi.theme.current");
		}

		if (label !== originalLabel || description !== originalDescription) {
			changes.push({ item, label, description });
		}
	}

	return applyItemChanges(changes);
}

const COMPONENT_GRAPH_KEYS: readonly string[] = Object.freeze([
	"children",
	"settingsList",
	"selectList",
	"submenuComponent",
	"inputComponent",
	"activeComponent",
	"listContainer",
	"treeContainer",
	"labelInputContainer",
	"messageList",
	"header",
	"treeList",
]);

function visitComponentGraph(root: unknown, visitor: (node: object) => void): void {
	const seen = new Set<object>();
	const stack: unknown[] = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node === null || typeof node !== "object" || seen.has(node)) continue;
		seen.add(node);
		visitor(node);
		if (Array.isArray(node)) {
			for (const child of node) stack.push(child);
			continue;
		}
		for (const key of COMPONENT_GRAPH_KEYS) {
			const value = (node as Record<string, unknown>)[key];
			if (value !== undefined && value !== null) stack.push(value);
		}
	}
}

function collectTextInstances(root: unknown): Array<Text | TruncatedText> {
	const result: Array<Text | TruncatedText> = [];
	visitComponentGraph(root, (node) => {
		if (node instanceof Text || node instanceof TruncatedText) result.push(node);
	});
	return result;
}

function markOwnedTree(root: unknown, runtime: LocalizationRuntime): void {
	visitComponentGraph(root, (node) => {
		if (node instanceof SettingsList) runtime.ownedSettings.add(node);
		else if (node instanceof SelectList) runtime.ownedSelects.add(node);
	});
}

function textOf(instance: Text | TruncatedText): string {
	return (instance as unknown as TextShape).text;
}

function setTextOf(instance: Text | TruncatedText, text: string): void {
	if (instance instanceof Text) {
		instance.setText(text);
		return;
	}
	(instance as unknown as TextShape).text = text;
}

function renderLocalizedComponent(
	component: object,
	width: number,
	originalRender: (width: number) => string[],
	runtime: LocalizationRuntime,
	options: {
		skipText?: (instance: Text | TruncatedText) => boolean;
		translateText?: (text: string, translators: Translators, instance: Text | TruncatedText) => string;
		beforeRender?: () => Array<() => void>;
	} = {},
): string[] {
	const catalog = runtime.getCatalog();
	if (catalog.locale === "en") return originalRender.call(component, width);
	const translators = translatorsFor(catalog);
	const restores: Array<() => void> = [];
	try {
		const translate = options.translateText ?? ((text: string, value: Translators) => value.text(text));
		for (const instance of collectTextInstances(component)) {
			if (options.skipText?.(instance)) continue;
			const original = textOf(instance);
			if (original.length === 0) continue;
			const translated = translate(original, translators, instance);
			if (translated === original) continue;
			setTextOf(instance, translated);
			restores.push(() => {
				if (textOf(instance) === translated) setTextOf(instance, original);
			});
		}
		if (options.beforeRender) restores.push(...options.beforeRender());
		return originalRender.call(component, width);
	} finally {
		for (const restore of restores.reverse()) restore();
	}
}

function findOAuthTitleText(component: object): TruncatedText | undefined {
	const children = (component as { children?: unknown[] }).children ?? [];
	return children.find((child): child is TruncatedText => child instanceof TruncatedText);
}

function findTrustCwdText(component: object): Text | undefined {
	const children = (component as { children?: unknown[] }).children ?? [];
	const title = catalogText(defaultCatalog(), "jouzu.cli.piUi.trust.title");
	const titleIndex = children.findIndex(
		(child) => child instanceof Text && stripTerminalSequences(textOf(child)).trim() === title,
	);
	if (titleIndex < 0) {
		const candidate = children[3];
		return candidate instanceof Text ? candidate : undefined;
	}
	for (let index = titleIndex + 1; index < children.length; index++) {
		const child = children[index];
		if (child instanceof Text) return child;
	}
	return undefined;
}

interface HeaderShape {
	render(this: object, width: number): string[];
	scope?: string;
}

function localizeResumeHeaderLines(
	lines: string[],
	width: number,
	catalog: CatalogBundle,
	scope: string | undefined,
): string[] {
	const first = lines[0];
	if (first === undefined) return lines;
	return [localizeResumeHeaderTitle(first, width, catalog, scope), ...lines.slice(1)];
}

function localizeResumeHeaderTitle(
	line: string,
	width: number,
	catalog: CatalogBundle,
	scope: string | undefined,
): string {
	const stripped = stripTerminalSequences(line);
	const marker = /[○◉]/u.exec(stripped);
	if (!marker) return line;
	const markerText = stripped.slice(marker.index, Math.min(stripped.length, marker.index + 16));
	const rawIndex = markerText.length > 0 ? line.indexOf(markerText) : -1;
	if (rawIndex < 0) return line;
	const rightVisible = stripped.slice(marker.index);
	const rightWidth = visibleWidth(rightVisible);
	const maxLeft = Math.max(0, width - rightWidth - 1);
	const titleId = scope === "all" ? "jouzu.cli.piUi.resume.titleAll" : "jouzu.cli.piUi.resume.titleCurrent";
	const title = truncateToWidth(catalogText(catalog, titleId), maxLeft, "");
	const rawLeft = line.slice(0, rawIndex);
	const rawRight = line.slice(rawIndex);
	const oldVisibleLeft = stripTerminalSequences(rawLeft).replace(/\s+$/u, "");
	let nextLeft: string;
	if (oldVisibleLeft.length === 0) nextLeft = title;
	else if (rawLeft.includes(oldVisibleLeft)) nextLeft = rawLeft.replace(oldVisibleLeft, title);
	else nextLeft = title;
	nextLeft = nextLeft.replace(/\s+$/u, "");
	const spacing = Math.max(0, width - visibleWidth(nextLeft) - rightWidth);
	return nextLeft + " ".repeat(spacing) + rawRight;
}

function withResumeHeaderLocalization(component: object, runtime: LocalizationRuntime): Array<() => void> {
	const header = (component as { header?: HeaderShape }).header;
	if (!header || typeof header.render !== "function") return [];
	const original = header.render;
	const wrapper = function (this: HeaderShape, width: number): string[] {
		const catalog = runtime.getCatalog();
		const lines = original.call(this, width);
		if (catalog.locale === "en") return lines;
		return localizeResumeHeaderLines(lines, width, catalog, this.scope);
	};
	header.render = wrapper;
	return [
		() => {
			if (header.render === wrapper) header.render = original;
		},
	];
}

interface UserMessageListShape {
	render(this: object, width: number): string[];
	messages?: unknown[];
}

function withForkMessageListLocalization(
	component: UserMessageSelectorComponent,
	runtime: LocalizationRuntime,
): Array<() => void> {
	const list = component.getMessageList() as unknown as UserMessageListShape;
	if (!list || typeof list.render !== "function") return [];
	const original = list.render;
	const enEmpty = catalogText(defaultCatalog(), "jouzu.cli.piUi.fork.empty");
	const wrapper = function (this: UserMessageListShape, width: number): string[] {
		const catalog = runtime.getCatalog();
		const lines = original.call(this, width);
		if (catalog.locale === "en") return lines;
		const localEmpty = catalogText(catalog, "jouzu.cli.piUi.fork.empty");
		const messages = this.messages ?? [];
		if (messages.length === 0) {
			return lines.map((line) => {
				const stripped = stripTerminalSequences(line).trim();
				return stripped === enEmpty ? truncateToWidth(line.replace(stripped, localEmpty), width) : line;
			});
		}
		return lines.map((line, index) => {
			if (index % 3 !== 1) return line;
			const stripped = stripTerminalSequences(line).trim();
			const match = /^Message (\d+) of (\d+)$/u.exec(stripped);
			if (!match) return line;
			const localized = catalogText(catalog, "jouzu.cli.piUi.fork.messagePosition", {
				position: match[1] ?? "",
				total: match[2] ?? "",
			});
			return truncateToWidth(line.replace(stripped, localized), width);
		});
	};
	list.render = wrapper;
	return [
		() => {
			if (list.render === wrapper) list.render = original;
		},
	];
}

interface SearchLineShape {
	render(this: object, width: number): string[];
	treeList?: { getSearchQuery?: () => string };
}

function withTreeSearchLocalization(component: TreeSelectorComponent, runtime: LocalizationRuntime): Array<() => void> {
	const children = (component as unknown as { children?: unknown[] }).children ?? [];
	const searchLine = children.find((child): child is SearchLineShape => {
		const candidate = child as SearchLineShape;
		return typeof candidate.treeList?.getSearchQuery === "function" && typeof candidate.render === "function";
	});
	if (!searchLine) return [];
	const original = searchLine.render;
	const enSearch = catalogText(defaultCatalog(), "jouzu.cli.piUi.tree.search");
	const wrapper = function (this: SearchLineShape, width: number): string[] {
		const catalog = runtime.getCatalog();
		const lines = original.call(this, width);
		if (catalog.locale === "en") return lines;
		const localSearch = catalogText(catalog, "jouzu.cli.piUi.tree.search");
		return lines.map((line) => truncateToWidth(line.replace(enSearch, localSearch), width));
	};
	searchLine.render = wrapper;
	return [
		() => {
			if (searchLine.render === wrapper) searchLine.render = original;
		},
	];
}

interface LabelInputShape {
	render(this: object, width: number): string[];
}

function withTreeLabelInputLocalization(
	component: TreeSelectorComponent,
	runtime: LocalizationRuntime,
): Array<() => void> {
	const labelInput = (component as unknown as { labelInput?: LabelInputShape }).labelInput;
	if (!labelInput || typeof labelInput.render !== "function") return [];
	const original = labelInput.render;
	const enPrompt = catalogText(defaultCatalog(), "jouzu.cli.piUi.tree.labelPrompt");
	const wrapper = function (this: LabelInputShape, width: number): string[] {
		const catalog = runtime.getCatalog();
		const lines = original.call(this, width);
		if (catalog.locale === "en") return lines;
		const localPrompt = catalogText(catalog, "jouzu.cli.piUi.tree.labelPrompt");
		const first = lines[0];
		if (first === undefined) return lines;
		return [
			first.includes(enPrompt) ? truncateToWidth(first.replace(enPrompt, localPrompt), width) : first,
			...lines.slice(1),
		];
	};
	labelInput.render = wrapper;
	return [
		() => {
			if (labelInput.render === wrapper) labelInput.render = original;
		},
	];
}

async function loadTrustSelectorPrototype(): Promise<RenderablePrototype | undefined> {
	try {
		const packageUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
		const moduleUrl = new URL("./modes/interactive/components/trust-selector.js", packageUrl).href;
		const module = (await import(moduleUrl)) as {
			TrustSelectorComponent?: { prototype: RenderablePrototype };
		};
		return module.TrustSelectorComponent?.prototype;
	} catch {
		return undefined;
	}
}

function patchMethod<T extends object, K extends keyof T>(prototype: T, key: K, wrapper: T[K]): () => void {
	const hadOwn = Object.hasOwn(prototype, key);
	const original = prototype[key];
	prototype[key] = wrapper;
	return () => {
		if (prototype[key] !== wrapper) return;
		if (hadOwn) prototype[key] = original;
		else Reflect.deleteProperty(prototype, key as string | symbol);
	};
}

function installPrototypePatches(
	runtime: LocalizationRuntime,
	trustPrototype: RenderablePrototype | undefined,
): () => void {
	const restores: Array<() => void> = [];
	const install = (restore: () => void): void => {
		restores.push(restore);
	};
	const restoreAll = (): void => {
		for (const restore of restores.reverse()) restore();
	};

	try {
		const settingsProto = SettingsList.prototype as unknown as SettingsListPrototype;
		const originalSettingsRender = settingsProto.render;
		install(
			patchMethod(settingsProto, "render", function (this: SettingsList, width: number): string[] {
				if (!runtime.ownedSettings.has(this)) return originalSettingsRender.call(this, width);
				const list = this as unknown as SettingsListInternals;
				markOwnedTree(list.submenuComponent, runtime);
				return renderLocalizedComponent(this, width, originalSettingsRender, runtime);
			}),
		);

		const originalRenderMainList = settingsProto.renderMainList;
		install(
			patchMethod(settingsProto, "renderMainList", function (this: SettingsList, width: number): string[] {
				if (!runtime.ownedSettings.has(this)) return originalRenderMainList.call(this, width);
				const catalog = runtime.getCatalog();
				if (catalog.locale === "en") return originalRenderMainList.call(this, width);
				const list = this as unknown as SettingsListInternals;
				const theme = list.theme;
				if (!theme) return originalRenderMainList.call(this, width);
				const translators = translatorsFor(catalog);
				const wrappedTheme: SettingsListThemeShape = {
					...theme,
					hint: (text: string) => theme.hint(translators.settingsHint(text)),
				};
				const itemRestores = localizeSettingsItems(this, catalog);
				list.theme = wrappedTheme;
				try {
					return originalRenderMainList.call(this, width);
				} finally {
					list.theme = theme;
					for (const restore of itemRestores.reverse()) restore();
				}
			}),
		);

		const originalApplyFilter = settingsProto.applyFilter;
		install(
			patchMethod(settingsProto, "applyFilter", function (this: SettingsList, query: string): void {
				if (!runtime.ownedSettings.has(this)) {
					originalApplyFilter.call(this, query);
					return;
				}
				const catalog = runtime.getCatalog();
				if (catalog.locale === "en") {
					originalApplyFilter.call(this, query);
					return;
				}
				const list = this as unknown as SettingsListInternals;
				const en = defaultCatalog();
				list.filteredItems = fuzzyFilter(list.items, query, (item) => {
					const spec = PI_SETTINGS_ITEM_IDS[item.id];
					return spec ? `${catalogText(catalog, spec.labelId)} ${catalogText(en, spec.labelId)}` : item.label;
				});
				list.selectedIndex = 0;
			}),
		);

		const originalSelectRender = SelectList.prototype.render;
		install(
			patchMethod(SelectList.prototype, "render", function (this: SelectList, width: number): string[] {
				if (!runtime.ownedSelects.has(this)) return originalSelectRender.call(this, width);
				const catalog = runtime.getCatalog();
				if (catalog.locale === "en") return originalSelectRender.call(this, width);
				const translators = translatorsFor(catalog);
				const itemRestores = localizeSelectItems(this, catalog);
				try {
					const lines = originalSelectRender.call(this, width);
					const filtered = (this as unknown as { filteredItems?: SelectItemShape[] }).filteredItems ?? [];
					return filtered.length === 0
						? lines.map((line) => truncateToWidth(translators.selectNoMatch(line), width))
						: lines;
				} finally {
					for (const restore of itemRestores.reverse()) restore();
				}
			}),
		);

		const installSelector = (componentConstructor: unknown): void => {
			const prototype = (componentConstructor as { prototype: { render(this: object, width: number): string[] } })
				.prototype;
			const original = prototype.render;
			install(
				patchMethod(prototype, "render", function (this: object, width: number): string[] {
					markOwnedTree(this, runtime);
					return renderLocalizedComponent(this, width, original, runtime);
				}),
			);
		};

		installSelector(SettingsSelectorComponent);
		installSelector(ThemeSelectorComponent);
		installSelector(ShowImagesSelectorComponent);
		installSelector(ThinkingSelectorComponent);

		const oauthPrototype = OAuthSelectorComponent.prototype as unknown as {
			render(this: object, width: number): string[];
		};
		const originalOauthRender = oauthPrototype.render;
		install(
			patchMethod(oauthPrototype, "render", function (this: object, width: number): string[] {
				const title = findOAuthTitleText(this);
				return renderLocalizedComponent(this, width, originalOauthRender, runtime, {
					translateText: (text, translators, instance) =>
						instance === title ? translators.oauthTitle(text) : translators.oauthStatus(text),
				});
			}),
		);

		const sessionConstructor = runtime.SessionSelectorComponent ?? SessionSelectorComponent;
		const sessionPrototype = sessionConstructor.prototype as unknown as {
			render(this: object, width: number): string[];
		};
		const originalSessionRender = sessionPrototype.render;
		install(
			patchMethod(sessionPrototype, "render", function (this: object, width: number): string[] {
				return renderLocalizedComponent(this, width, originalSessionRender, runtime, {
					beforeRender: () => withResumeHeaderLocalization(this, runtime),
				});
			}),
		);

		const treeConstructor = runtime.TreeSelectorComponent ?? TreeSelectorComponent;
		const treePrototype = treeConstructor.prototype as unknown as {
			render(this: object, width: number): string[];
		};
		const originalTreeRender = treePrototype.render;
		install(
			patchMethod(treePrototype, "render", function (this: object, width: number): string[] {
				return renderLocalizedComponent(this, width, originalTreeRender, runtime, {
					beforeRender: () => {
						const restores = withTreeSearchLocalization(this as unknown as TreeSelectorComponent, runtime);
						try {
							restores.push(...withTreeLabelInputLocalization(this as unknown as TreeSelectorComponent, runtime));
						} catch (error) {
							for (const restore of restores.reverse()) restore();
							throw error;
						}
						return restores;
					},
				});
			}),
		);

		const forkConstructor = runtime.UserMessageSelectorComponent ?? UserMessageSelectorComponent;
		const forkPrototype = forkConstructor.prototype as unknown as {
			render(this: object, width: number): string[];
		};
		const originalForkRender = forkPrototype.render;
		install(
			patchMethod(forkPrototype, "render", function (this: object, width: number): string[] {
				return renderLocalizedComponent(this, width, originalForkRender, runtime, {
					beforeRender: () => withForkMessageListLocalization(this as unknown as UserMessageSelectorComponent, runtime),
				});
			}),
		);

		if (trustPrototype) {
			const originalTrustRender = trustPrototype.render;
			install(
				patchMethod(trustPrototype, "render", function (this: object, width: number): string[] {
					const cwdText = findTrustCwdText(this);
					return renderLocalizedComponent(this, width, originalTrustRender, runtime, {
						skipText: (instance) => instance === cwdText,
					});
				}),
			);
		}
	} catch (error) {
		restoreAll();
		throw error;
	}

	return restoreAll;
}

interface ErrorComponent {
	build?: () => string;
}

interface ErrorHost {
	chatContainer: { addChild(component: ErrorComponent): void };
}

/**
 * Localize Pi's built-in interactive settings menu, submenus, and selector
 * components for the duration of `operation` when the effective catalog is not
 * `en`.
 *
 * `catalog` may be a getter. It is read before every localized render, so a
 * confirmed Settings language change can replace the display catalog without
 * restarting Pi; returning an English bundle restores native English text. A
 * host that owns catalog reloads can pass the getter, or set
 * `runtime.getCatalog`, without this module depending on the host's refresh
 * mechanism. A fixed English catalog with no dynamic getter bypasses all
 * patching for the operation.
 */
export async function withPiUiLocalization<T>(
	catalog: CatalogBundle | (() => CatalogBundle),
	operation: () => Promise<T>,
	runtime: PiUiRuntime = {},
): Promise<T> {
	const readCatalog = (): CatalogBundle =>
		typeof catalog === "function" ? catalog() : (runtime.getCatalog?.() ?? catalog);
	const initial = readCatalog();
	const dynamic = typeof catalog === "function" || runtime.getCatalog !== undefined;
	if (initial.locale === "en" && !dynamic) return operation();

	const fallback = initial;
	const getCatalog = (): CatalogBundle => {
		try {
			return readCatalog();
		} catch {
			return fallback;
		}
	};
	const localizationRuntime: LocalizationRuntime = {
		getCatalog,
		ownedSettings: new WeakSet<SettingsList>(),
		ownedSelects: new WeakSet<SelectList>(),
		SessionSelectorComponent: runtime.SessionSelectorComponent,
		TreeSelectorComponent: runtime.TreeSelectorComponent,
		UserMessageSelectorComponent: runtime.UserMessageSelectorComponent,
	};
	const trustPrototype = await loadTrustSelectorPrototype();
	const restorePrototypes = installPrototypePatches(localizationRuntime, trustPrototype);
	const prototype = (runtime.InteractiveMode ?? InteractiveMode).prototype as unknown as {
		showError(this: ErrorHost, message: string): void;
	};
	const originalShowError = prototype.showError;
	const restoreErrors = patchMethod(prototype, "showError", function (this: ErrorHost, message: string): void {
		if (message !== "Compaction failed: Nothing to compact (session too small)") {
			originalShowError.call(this, message);
			return;
		}
		// Keep Pi's theme-aware component and layout, changing only this known display sentence.
		const container = this.chatContainer;
		const originalAdd = container.addChild;
		container.addChild = function (component: ErrorComponent): void {
			if (typeof component.build === "function") {
				const build = component.build;
				component.build = function (): string {
					return build
						.call(this)
						.replace(`Error: ${message}`, catalogText(getCatalog(), "jouzu.cli.piUi.compaction.tooSmallError"));
				};
			}
			originalAdd.call(this, component);
		};
		try {
			originalShowError.call(this, message);
		} finally {
			container.addChild = originalAdd;
		}
	});
	try {
		return await operation();
	} finally {
		restoreErrors();
		restorePrototypes();
	}
}
