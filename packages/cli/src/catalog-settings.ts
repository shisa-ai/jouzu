import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, Input, matchesKey, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	type CatalogEndpointDiscoveryOptions,
	type CatalogEndpointDiscoveryResult,
	type CatalogSource,
	type CatalogSourceAuth,
	CatalogSourceStore,
	discoverCatalogEndpoint,
} from "./catalog-sources.js";
import {
	type CatalogRefreshResult,
	type CatalogSyncStatus,
	getCatalogSourceStatus,
	loadActiveCatalogForSource,
	type RefreshCatalogOptions,
	refreshCatalogSource,
} from "./model-catalog-sync.js";
import type { PaletteComponent, PaletteComponentContext, PaletteRoute } from "./palette.js";
import type { JouzuPaths } from "./paths.js";
import { detectBannerColorMode, renderBrandGradient } from "./presentation.js";
import type { SessionUiStyles } from "./session-ui/index.js";
import {
	fitTerminalText,
	padTerminalText,
	renderTerminalFrameBorder,
	renderTerminalFrameRow,
	renderTerminalFrameTitle,
	sanitizeTerminalText,
} from "./terminal-layout.js";

interface CatalogSettingsOptions {
	context: PaletteComponentContext;
	paths: JouzuPaths;
	env?: NodeJS.ProcessEnv;
	discover?: (input: string, options: CatalogEndpointDiscoveryOptions) => Promise<CatalogEndpointDiscoveryResult>;
	refresh?: (
		paths: JouzuPaths,
		source: CatalogSource,
		options?: RefreshCatalogOptions,
	) => Promise<CatalogRefreshResult>;
	onCatalogsChanged?: () => void;
}

type FormField = "label" | "url" | "auth" | "credential";

interface SourceView {
	source: CatalogSource;
	status: CatalogSyncStatus;
	offerings: Array<{ providerId: string; modelId: string; name: string }>;
}

interface SourceForm {
	mode: "add" | "edit";
	sourceId?: string;
	label: Input;
	url: Input;
	authType: "none" | "bearer";
	credential: Input;
	field: FormField;
}

function countLabel(count: number): string {
	return `${count} model${count === 1 ? "" : "s"}`;
}

function sourceStatusText(view: SourceView): string {
	if (!view.source.enabled) return "disabled";
	return view.status.status;
}

export class CatalogSettingsComponent implements PaletteComponent, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly styles: SessionUiStyles;
	private readonly close: () => void;
	private readonly paths: JouzuPaths;
	private readonly env: NodeJS.ProcessEnv;
	private readonly store: CatalogSourceStore;
	private readonly discover: CatalogSettingsOptions["discover"];
	private readonly refreshSource: NonNullable<CatalogSettingsOptions["refresh"]>;
	private readonly onCatalogsChanged?: () => void;
	private readonly wordmark: string;
	private views: SourceView[] = [];
	private selectedIndex = 0;
	private expandedSourceId?: string;
	private expandedOffset = 0;
	private form?: SourceForm;
	private confirmRemove = false;
	private busy = false;
	private message?: { level: "error" | "info"; text: string };
	private controller?: AbortController;
	private disposed = false;
	private _focused = false;

	constructor(options: CatalogSettingsOptions) {
		this.tui = options.context.tui;
		this.theme = options.context.theme;
		this.keybindings = options.context.keybindings;
		this.styles = options.context.styles;
		this.close = options.context.close;
		this.paths = options.paths;
		this.env = options.env ?? process.env;
		this.store = new CatalogSourceStore(this.paths, { env: this.env });
		this.discover = options.discover ?? discoverCatalogEndpoint;
		this.refreshSource = options.refresh ?? refreshCatalogSource;
		this.onCatalogsChanged = options.onCatalogsChanged;
		this.wordmark = renderBrandGradient("JOUZU", detectBannerColorMode());
		this.reloadViews();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.syncInputFocus();
	}

	route(route: PaletteRoute): void {
		if (route.view !== "settings") return;
		this.reloadViews();
		this.tui.requestRender();
	}

	private selected(): SourceView | undefined {
		return this.views[this.selectedIndex];
	}

	private reloadViews(preferredId?: string): void {
		try {
			const sources = this.store.list();
			this.views = sources.map((source) => {
				const document = loadActiveCatalogForSource(this.paths, source);
				return {
					source,
					status: getCatalogSourceStatus(this.paths, source),
					offerings: (document?.modelOfferings ?? []).map((offering) => ({
						providerId: sanitizeTerminalText(offering.providerId),
						modelId: sanitizeTerminalText(offering.modelId),
						name: sanitizeTerminalText(offering.name ?? offering.modelId),
					})),
				};
			});
			const retainedId = preferredId ?? this.selected()?.source.id;
			const retainedIndex = retainedId ? this.views.findIndex((view) => view.source.id === retainedId) : -1;
			this.selectedIndex =
				retainedIndex >= 0 ? retainedIndex : Math.min(this.selectedIndex, Math.max(0, this.views.length - 1));
		} catch (error) {
			this.views = [];
			this.message = {
				level: "error",
				text: `Catalog settings could not be loaded: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`,
			};
		}
	}

	private formFields(): FormField[] {
		if (!this.form) return [];
		return this.form.authType === "bearer" ? ["label", "url", "auth", "credential"] : ["label", "url", "auth"];
	}

	private activeInput(): Input | undefined {
		if (!this.form) return undefined;
		if (this.form.field === "label") return this.form.label;
		if (this.form.field === "url") return this.form.url;
		if (this.form.field === "credential") return this.form.credential;
		return undefined;
	}

	private syncInputFocus(): void {
		if (!this.form) return;
		this.form.label.focused = this._focused && this.form.field === "label";
		this.form.url.focused = this._focused && this.form.field === "url";
		this.form.credential.focused = this._focused && this.form.field === "credential";
	}

	private startForm(mode: "add" | "edit"): void {
		const selected = mode === "edit" ? this.selected()?.source : undefined;
		if (mode === "edit" && !selected) return;
		const label = new Input();
		const url = new Input();
		const credential = new Input();
		label.setValue(selected?.label ?? "");
		url.setValue(selected?.url ?? "");
		credential.setValue(
			selected?.auth.type === "bearer" ? selected.auth.credentialRef.slice(4) : "JOUZU_MODEL_CATALOG_TOKEN",
		);
		this.form = {
			mode,
			...(selected ? { sourceId: selected.id } : {}),
			label,
			url,
			authType: selected?.auth.type ?? "none",
			credential,
			field: "label",
		};
		this.message = undefined;
		this.confirmRemove = false;
		this.syncInputFocus();
		this.tui.requestRender();
	}

	private cycleFormField(delta: number): void {
		if (!this.form) return;
		const fields = this.formFields();
		const index = fields.indexOf(this.form.field);
		this.form.field = fields[(index + delta + fields.length) % fields.length];
		this.syncInputFocus();
		this.tui.requestRender();
	}

	private toggleAuth(): void {
		if (!this.form) return;
		this.form.authType = this.form.authType === "none" ? "bearer" : "none";
		this.form.field = "auth";
		this.syncInputFocus();
		this.tui.requestRender();
	}

	private async saveForm(): Promise<void> {
		const form = this.form;
		if (!form || this.busy) return;
		const label = form.label.getValue().trim();
		const inputUrl = form.url.getValue().trim();
		const credentialName = form.credential.getValue().trim();
		const auth: CatalogSourceAuth =
			form.authType === "none" ? { type: "none" } : { type: "bearer", credentialRef: `env:${credentialName}` };
		this.busy = true;
		this.message = { level: "info", text: "Looking for a Jouzu catalog endpoint…" };
		this.controller?.abort();
		const controller = new AbortController();
		this.controller = controller;
		this.tui.requestRender();
		try {
			const discovered = await this.discover?.(inputUrl, { auth, env: this.env, signal: controller.signal });
			if (!discovered) throw new Error("catalog endpoint discovery returned no result");
			if (this.disposed || controller.signal.aborted) return;
			const source =
				form.mode === "edit" && form.sourceId
					? this.store.update(form.sourceId, { label, url: discovered.url, enabled: true, auth })
					: this.store.add({ label, url: discovered.url, auth });
			const refreshed = await this.refreshSource(this.paths, source, { env: this.env });
			if (this.disposed || controller.signal.aborted) return;
			if (refreshed.status === "error" || refreshed.status === "rejected") throw new Error(refreshed.message);
			this.form = undefined;
			this.reloadViews(source.id);
			const count = refreshed.catalogStatus.configured
				? (refreshed.catalogStatus.offeringCount ?? discovered.document.modelOfferings.length)
				: discovered.document.modelOfferings.length;
			this.message = { level: "info", text: `Saved ${sanitizeTerminalText(source.label)} with ${countLabel(count)}.` };
			this.onCatalogsChanged?.();
		} catch (error) {
			if (this.disposed || controller.signal.aborted) return;
			this.message = {
				level: "error",
				text: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
			};
		} finally {
			if (this.controller === controller) this.controller = undefined;
			this.busy = false;
			this.tui.requestRender();
		}
	}

	private async refreshSelected(): Promise<void> {
		const view = this.selected();
		if (!view || this.busy || !view.source.enabled) return;
		this.busy = true;
		this.message = { level: "info", text: `Refreshing ${sanitizeTerminalText(view.source.label)}…` };
		this.tui.requestRender();
		try {
			const result = await this.refreshSource(this.paths, view.source, { env: this.env });
			if (this.disposed) return;
			if (result.status === "error" || result.status === "rejected") throw new Error(result.message);
			this.reloadViews(view.source.id);
			this.message = {
				level: "info",
				text: result.status === "not-modified" ? "Catalog is up to date." : `Catalog ${result.status}.`,
			};
			this.onCatalogsChanged?.();
		} catch (error) {
			if (this.disposed) return;
			this.reloadViews(view.source.id);
			this.message = {
				level: "error",
				text: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
			};
		} finally {
			this.busy = false;
			this.tui.requestRender();
		}
	}

	private moveSelection(delta: number): void {
		this.selectedIndex = Math.max(0, Math.min(this.views.length - 1, this.selectedIndex + delta));
		this.expandedOffset = 0;
		this.confirmRemove = false;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.form) {
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				if (this.busy) this.controller?.abort();
				else this.form = undefined;
				this.syncInputFocus();
				this.tui.requestRender();
				return;
			}
			if (this.busy) return;
			if (matchesKey(data, "tab")) {
				this.cycleFormField(1);
				return;
			}
			if (matchesKey(data, "shift+tab")) {
				this.cycleFormField(-1);
				return;
			}
			if (matchesKey(data, "ctrl+enter")) {
				void this.saveForm();
				return;
			}
			if (
				this.form.field === "auth" &&
				(matchesKey(data, "space") || matchesKey(data, "left") || matchesKey(data, "right"))
			) {
				this.toggleAuth();
				return;
			}
			if (this.keybindings.matches(data, "tui.select.confirm")) {
				this.cycleFormField(1);
				return;
			}
			this.activeInput()?.handleInput(data);
			this.message = undefined;
			this.tui.requestRender();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.cancel")) {
			if (this.confirmRemove) {
				this.confirmRemove = false;
				this.tui.requestRender();
			} else {
				this.close();
			}
			return;
		}
		if (this.busy) return;
		if (this.confirmRemove) {
			if (this.keybindings.matches(data, "tui.select.confirm")) {
				const source = this.selected()?.source;
				if (source) {
					this.store.remove(source.id);
					this.expandedSourceId = undefined;
					this.reloadViews();
					this.message = { level: "info", text: `Removed ${sanitizeTerminalText(source.label)}.` };
					this.onCatalogsChanged?.();
				}
				this.confirmRemove = false;
				this.tui.requestRender();
			}
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, "pageUp") && this.expandedSourceId) {
			this.expandedOffset = Math.max(0, this.expandedOffset - 8);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown") && this.expandedSourceId) {
			this.expandedOffset += 8;
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const sourceId = this.selected()?.source.id;
			this.expandedSourceId = this.expandedSourceId === sourceId ? undefined : sourceId;
			this.expandedOffset = 0;
			this.tui.requestRender();
			return;
		}
		if (data === "a") {
			this.startForm("add");
			return;
		}
		if (data === "e") {
			this.startForm("edit");
			return;
		}
		if (data === "r") {
			void this.refreshSelected();
			return;
		}
		if (data === "d" && this.selected()) {
			this.confirmRemove = true;
			this.message = { level: "error", text: "Press Enter to remove this catalog source; Esc cancels." };
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "space") && this.selected()) {
			const source = this.selected()?.source;
			if (!source) return;
			const updated = this.store.setEnabled(source.id, !source.enabled);
			this.reloadViews(updated.id);
			this.message = {
				level: "info",
				text: `${sanitizeTerminalText(updated.label)} ${updated.enabled ? "enabled" : "disabled"}.`,
			};
			this.onCatalogsChanged?.();
			this.tui.requestRender();
		}
	}

	private renderForm(width: number, line: (value?: string) => string): string[] {
		const form = this.form;
		if (!form) return [];
		const innerWidth = Math.max(1, width - 4);
		const labelWidth = 14;
		const field = (id: FormField, label: string, value: string) => {
			const marker = form.field === id ? this.styles.apply("palette.marker", "→") : " ";
			const text = `${marker} ${padTerminalText(label, labelWidth)} ${value}`;
			return line(
				form.field === id
					? this.theme.bg("selectedBg", padTerminalText(fitTerminalText(text, innerWidth), innerWidth))
					: text,
			);
		};
		const authValue = form.authType === "none" ? "No authentication" : "Bearer token from environment";
		const lines = [
			line(this.styles.apply("palette.hint", form.mode === "add" ? "Add custom catalog" : "Edit custom catalog")),
			line(),
			field("label", "Label", form.label.render(Math.max(1, innerWidth - labelWidth - 3))[0] ?? ""),
			field("url", "URL or host", form.url.render(Math.max(1, innerWidth - labelWidth - 3))[0] ?? ""),
			field("auth", "Authentication", authValue),
		];
		if (form.authType === "bearer") {
			const credentialName = form.credential.getValue().trim();
			const credentialValue = credentialName ? this.env[credentialName] : undefined;
			const credentialAvailable = typeof credentialValue === "string" && Boolean(credentialValue.trim());
			lines.push(
				field(
					"credential",
					"Token variable",
					form.credential.render(Math.max(1, innerWidth - labelWidth - 3))[0] ?? "",
				),
				line(
					this.styles.apply(
						"palette.hint",
						"  Enter the variable name, not the token. Export it before starting Jouzu.",
					),
				),
			);
			if (credentialName) {
				lines.push(
					line(
						this.styles.apply(
							"palette.hint",
							`  ${sanitizeTerminalText(credentialName)} is ${credentialAvailable ? "set" : "not set"} in this Jouzu process.`,
						),
					),
				);
			}
		}
		lines.push(
			line(),
			line(this.styles.apply("palette.hint", "Exact URL is tried first, then /v1/jouzu/model-catalog.")),
			line(
				this.styles.apply("palette.hint", "Tab fields · Space changes auth · Ctrl+Enter discover & save · Esc cancel"),
			),
		);
		return lines;
	}

	render(width: number): string[] {
		const title = `${this.wordmark} ${this.theme.bold(this.styles.apply("palette.title", "· Settings / Catalogs"))}`;
		if (width < 12) return [fitTerminalText(title, Math.max(1, width))];
		const border = (value: string) => this.styles.apply("palette.border", value);
		const frameOptions = { border };
		const line = (value = "") => renderTerminalFrameRow(value, width, frameOptions);
		const innerWidth = Math.max(1, width - 4);
		const lines = [renderTerminalFrameTitle(title, width, frameOptions)];
		if (this.form) {
			lines.push(...this.renderForm(width, line));
		} else {
			const active = this.views.filter((view) => view.source.enabled && view.status.status === "active").length;
			lines.push(
				line(
					this.styles.apply(
						"palette.hint",
						`${active}/${this.views.length} active · custom catalogs are an advanced feature`,
					),
				),
			);
			lines.push(line());
			if (this.views.length === 0) {
				lines.push(line(this.styles.apply("palette.empty", "No catalog sources configured.")));
			} else {
				for (let index = 0; index < this.views.length; index += 1) {
					const view = this.views[index];
					const selected = index === this.selectedIndex;
					const marker = selected ? this.styles.apply("palette.marker", "→") : " ";
					const count = view.status.configured
						? (view.status.offeringCount ?? view.offerings.length)
						: view.offerings.length;
					const summary = `${marker} ${sanitizeTerminalText(view.source.label)} · ${sourceStatusText(view)} · ${countLabel(count)}`;
					lines.push(
						line(
							selected
								? this.theme.bg("selectedBg", padTerminalText(fitTerminalText(summary, innerWidth), innerWidth))
								: summary,
						),
					);
					if (selected)
						lines.push(line(this.styles.apply("palette.detail", `  ${sanitizeTerminalText(view.source.url)}`)));
					if (this.expandedSourceId === view.source.id) {
						const terminalRows = Number(this.tui.terminal?.rows ?? 24);
						const available = Math.max(3, terminalRows - lines.length - 8);
						const maximumOffset = Math.max(0, view.offerings.length - available);
						this.expandedOffset = Math.min(this.expandedOffset, maximumOffset);
						for (const offering of view.offerings.slice(this.expandedOffset, this.expandedOffset + available)) {
							lines.push(line(`    ${offering.providerId}/${offering.modelId} · ${offering.name}`));
						}
						if (view.offerings.length === 0)
							lines.push(line(this.styles.apply("palette.empty", "    No cached model offerings.")));
						else if (view.offerings.length > available)
							lines.push(
								line(
									this.styles.apply(
										"palette.hint",
										`    ${this.expandedOffset + 1}-${Math.min(view.offerings.length, this.expandedOffset + available)}/${view.offerings.length} · PgUp/PgDn`,
									),
								),
							);
					}
				}
			}
			lines.push(line());
			lines.push(
				line(this.styles.apply("palette.hint", "Enter models · A add · E edit · Space enable · R refresh · D remove")),
			);
			lines.push(line(this.styles.apply("palette.hint", "Ctrl+L Models · ↑↓ move · Esc close")));
		}
		if (this.message) {
			const role = this.message.level === "error" ? "palette.message.error" : "palette.message.info";
			for (const messageLine of wrapTextWithAnsi(this.message.text, innerWidth)) {
				lines.push(line(this.styles.apply(role, messageLine)));
			}
		}
		lines.push(renderTerminalFrameBorder(width, { ...frameOptions, left: "╰", right: "╯" }));
		return lines.map((value) => fitTerminalText(value, width));
	}

	invalidate(): void {
		this.form?.label.invalidate();
		this.form?.url.invalidate();
		this.form?.credential.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		this.controller?.abort();
		this.controller = undefined;
	}
}
