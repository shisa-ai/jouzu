// Runs the real interactive startup wiring without starting a terminal or a model request.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runMainCli } from "../../dist/main-cli.js";
import { resolveJouzuPaths } from "../../dist/paths.js";
import { configurePiProcess } from "../../dist/runtime.js";

const locale = process.argv[2];
if (!["en", "ja"].includes(locale)) throw new Error("expected en or ja");
Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });
const paths = resolveJouzuPaths();
configurePiProcess(paths);
globalThis.fetch = async () => {
	throw new Error("localization startup audit must not access the network");
};
const { InteractiveMode } = await import("@earendil-works/pi-coding-agent");
const { KeybindingsManager, TUI_KEYBINDINGS, stripTerminalSequences } = await import("@earendil-works/pi-tui");
const observations = { locale, commands: [], suggestions: [], surfaces: [], errors: [] };
InteractiveMode.prototype.run = async function () {
	// Keep the real extension binding and editor/localizer, but capture UI output.
	this.ui.requestRender = () => {};
	this.showExtensionError = (...args) => observations.errors.push(args.map(String));
	const createUI = this.createExtensionUIContext.bind(this);
	let activeSurface = "startup";
	this.createExtensionUIContext = () => ({
		...createUI(),
		notify: (text, type) => observations.surfaces.push({ surface: activeSurface, kind: "notification", type, text }),
		custom: async (factory) => {
			const component = await factory(this.ui, this.theme, new KeybindingsManager(TUI_KEYBINDINGS), () => {});
			try {
				for (const width of [48, 100]) {
					observations.surfaces.push({
						surface: activeSurface,
						kind: "view",
						width,
						text: stripTerminalSequences(component.render(width).join("\n")),
					});
				}
			} finally {
				component.dispose?.();
			}
		},
	});
	try {
		await this.bindCurrentSessionExtensions();
		// Open the real /settings selector and discover its rows and submenus.
		// No value is accepted, and every submenu is cancelled after inspection.
		this.showSelector = (create) => {
			const selector = create(() => {});
			const record = (surface, component) => {
				for (const width of [48, 100]) {
					observations.surfaces.push({
						surface,
						kind: "view",
						width,
						text: stripTerminalSequences(component.render(width).join("\n")),
					});
				}
			};
			try {
				record("settings.root", selector.component);
				const list = selector.component.getSettingsList();
				for (const item of list.items) {
					observations.surfaces.push({
						surface: `settings.fields.${item.id}`,
						kind: "setting-fields",
						text: JSON.stringify({
							label: item.label,
							description: item.description,
							value: item.currentValue,
							values: item.values,
						}),
					});
					if (!item.submenu) continue;
					list.selectItem(item.id);
					list.handleInput("\r");
					record(`settings.submenu.${item.id}`, selector.component);
					list.handleInput("\x1b");
				}
			} finally {
				selector.dispose?.();
			}
		};
		this.showSettingsSelector();
		const runner = this.session.extensionRunner;
		observations.commands = runner.getRegisteredCommands().map((command) => ({
			name: command.name,
			invocationName: command.invocationName,
			description: command.description,
			sourceInfo: command.sourceInfo,
		}));
		const suggestions = await this.editor.autocompleteProvider.getSuggestions(["/"], 0, 1);
		if (!suggestions?.items.length) throw new Error("no slash suggestions from the active editor");
		observations.suggestions = suggestions.items;
		for (const [name, args, surface] of [
			["labels", "", "labels.status-help"],
			["labels", "audit-invalid-argument", "labels.invalid-argument"],
			["textguard", "audit-invalid-argument", "textguard.invalid-argument"],
			["textguard", "reports", "textguard.reports-empty"],
			["voice", "audit-invalid-argument", "voice.invalid-argument"],
			["subagents", "audit-invalid-argument", "subagents.invalid-argument"],
			["workflow", "audit-invalid-argument", "workflow.invalid-argument"],
		]) {
			activeSurface = surface;
			const command = runner.getRegisteredCommands().find((entry) => entry.name === name);
			if (!command) throw new Error(`missing command: ${name}`);
			await command.handler(args, runner.createCommandContext());
		}
	} finally {
		await this.runtimeHost.dispose();
	}
};
await runMainCli([
	"--jouzu-ui-locale",
	locale,
	"--jouzu-profile",
	"core",
	"--no-session",
	"--no-context-files",
	"--no-approve",
]);
if (!observations.suggestions.length) throw new Error("interactive startup was not observed");
writeFileSync(join(paths.configDir, "localization-audit.json"), JSON.stringify(observations, null, 2));
// No terminal loop was started. Runtime disposal above completes before exit.
process.exit(observations.errors.length ? 1 : 0);
