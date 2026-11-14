import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { resolveCatalog } from "../dist/locale-catalog.js";
import { createPluginsExtension, pluginsGuide } from "../dist/plugins.js";

function harness(catalog) {
	const commands = new Map();
	const renderers = new Map();
	const entries = [];
	createPluginsExtension(catalog).factory({
		registerCommand: (name, command) => commands.set(name, command),
		registerEntryRenderer: (name, renderer) => renderers.set(name, renderer),
		appendEntry: (...args) => entries.push(args),
	});
	return { commands, renderers, entries };
}

test("/plugins appends a transcript-only guide without a model turn or package actions", async () => {
	const h = harness();
	assert.deepEqual([...h.commands.keys()], ["plugins"]);
	assert.match(h.commands.get("plugins").description, /plugins/);
	await h.commands.get("plugins").handler("", { mode: "tui" });
	assert.deepEqual(h.entries, [["jouzu-plugins"]]);
	assert.ok(h.renderers.has("jouzu-plugins"));
	const source = readFileSync(new URL("../src/main-cli.ts", import.meta.url), "utf8");
	assert.match(source, /createPluginsExtension\(preRuntime\.catalog\.bundle\)/);
});

test("guide preserves the approved copy, visible URL, commands, and final question", () => {
	const text = pluginsGuide();
	assert.match(text, /^### Plugins and customization\n\nJouzu inherits Pi’s customizability:/);
	assert.match(text, /make it your own\. Browse Pi packages: https:\/\/pi\.dev\/packages\n\n/);
	assert.match(text, /```sh\njz install npm:<package-name>\n```/);
	assert.match(text, /`jz list`.*`jz remove <source>`.*`\/reload`/);
	assert.match(text, /Third-party packages run with your user permissions/);
	assert.match(text, /Jouzu includes documentation for writing extensions/);
	assert.match(text, /client itself may require a rebuild and restart/);
	assert.ok(text.endsWith("**What would you like to add or change?**"));
	assert.doesNotMatch(text, /\]\(https:/);
});

test("RPC and print modes show the guide without appending entries or opening a view", async (t) => {
	const h = harness();
	const notices = [];
	await h.commands.get("plugins").handler("", {
		mode: "rpc",
		ui: { notify: (...args) => notices.push(args) },
	});
	assert.deepEqual(notices, [[pluginsGuide(), "info"]]);
	const log = t.mock.method(console, "log", () => {});
	await h.commands.get("plugins").handler("", { mode: "print" });
	assert.deepEqual(log.mock.calls[0].arguments, [pluginsGuide()]);
	assert.deepEqual(h.entries, []);
});

test("English and Japanese render as Markdown at narrow terminal widths", () => {
	initTheme("dark");
	for (const locale of ["en", "ja"]) {
		const catalog = resolveCatalog(locale).bundle;
		const h = harness(catalog);
		const component = h.renderers.get("jouzu-plugins")();
		for (const width of [48, 80]) {
			const lines = component.render(width);
			assert.ok(
				lines.every((line) => visibleWidth(line) <= width),
				`${locale} at ${width} columns`,
			);
			assert.ok(lines.join("\n").includes("https://pi.dev/packages"));
		}
		const text = pluginsGuide(catalog);
		assert.doesNotMatch(text, /jouzu\.cli\.plugins\./);
		if (locale === "ja") assert.match(text, /プラグインとカスタマイズ/);
	}
});

test("real session discovers /plugins and excludes the guide from model context across reload", async (t) => {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const root = await mkdtemp(join(tmpdir(), "jouzu-plugins-"));
	let session;
	t.after(async () => {
		session?.dispose();
		await rm(root, { recursive: true, force: true });
	});
	const runtime = await ModelRuntime.create({
		credentials: {
			read: async () => undefined,
			list: async () => [],
			modify: async () => undefined,
			delete: async () => {},
		},
		modelsPath: null,
		modelsStorePath: join(root, "models.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		noPromptTemplates: true,
		extensionFactories: [createPluginsExtension()],
	});
	await loader.reload();
	const manager = SessionManager.create(root, root);
	({ session } = await createAgentSession({
		cwd: root,
		agentDir: root,
		modelRuntime: runtime,
		resourceLoader: loader,
		tools: [],
		sessionManager: manager,
		settingsManager: SettingsManager.inMemory({}),
	}));
	const notices = [];
	await session.bindExtensions({
		mode: "tui",
		uiContext: { notify: (...args) => notices.push(args) },
		onError: (error) => assert.fail(String(error)),
	});
	assert.ok(session.extensionRunner.getCommand("plugins"));
	await session.prompt("/plugins");
	assert.ok(manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "jouzu-plugins"));
	assert.deepEqual(session.messages, []);
	await session.reload();
	assert.ok(session.extensionRunner.getCommand("plugins"));
	assert.deepEqual(session.messages, []);
});
