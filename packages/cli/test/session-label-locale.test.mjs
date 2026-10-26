import assert from "node:assert/strict";
import { test } from "node:test";
import { createDisplayCatalog } from "../dist/display-catalog.js";
import { loadCatalog } from "../dist/locale-catalog.js";
import { createSessionLabelsExtension } from "../dist/session-labels.js";

/**
 * A minimal extension fixture for the locale test.
 *
 * It drives only the `session_start` handler and the `/labels` command, which
 * is the surface the catalog migration touches. It does not exercise naming
 * requests, so it needs no model stream.
 */
function fixture(catalog) {
	const handlers = new Map(),
		events = new Map(),
		commands = new Map(),
		notifications = [];
	const ctx = {
		mode: "tui",
		cwd: "/workspace/folder",
		model: { provider: "test", id: "cheap" },
		sessionManager: {
			getSessionId: () => "session",
			getEntries: () => [],
			getBranch: () => [],
			getSessionName: () => undefined,
		},
		ui: { notify: (text) => notifications.push(text) },
		modelRegistry: {
			find: () => ({ provider: "test", id: "cheap" }),
			streamSimple: () => ({ result: () => Promise.resolve({}) }),
		},
	};
	const pi = {
		on: (event, handler) => handlers.set(event, handler),
		events: { on: (event, handler) => events.set(event, handler) },
		registerCommand: (name, definition) => commands.set(name, definition),
		appendEntry: () => {},
		setSessionName: () => {},
	};
	createSessionLabelsExtension(
		{ update: async () => true, release: async () => {} },
		async () => ({ folder: "folder" }),
		undefined,
		catalog,
	).factory(pi);
	handlers.get("session_start")({}, ctx);
	return {
		command: (args) => commands.get("labels").handler(args, ctx),
		notifications,
		ctx,
		description: () => commands.get("labels").description,
	};
}

test("the labels status block renders from the ja catalog", async () => {
	const f = fixture(loadCatalog("ja"));
	await f.command("");
	const text = f.notifications.at(-1);
	assert.match(text, /自動命名: オン/);
	assert.match(text, /命名リクエスト: 0\/20/);
	assert.match(text, /\/labels — 状態とコマンドを表示します。/);
	assert.match(text, /\/labels pane auto — この tmux ペインのタイトルを置き換えられるようにします。/);
	assert.doesNotMatch(text, /Show status and commands/);
});

test("the command description renders from the ja catalog", () => {
	const f = fixture(loadCatalog("ja"));
	assert.equal(f.description(), "セッション名の自動設定と tmux ペインラベルを構成します");
});

test("labels notifications follow confirmed locale changes without rebuilding the extension", async () => {
	const controller = createDisplayCatalog(loadCatalog("ja"));
	const f = fixture(controller.bundle);
	for (const locale of ["ja", "en", "ja"]) {
		const catalog = loadCatalog(locale);
		controller.update(catalog);
		await f.command("unknown");
		assert.equal(f.notifications.at(-1), catalog.format("jouzu.cli.sessionLabels.notify.useCommand"));
	}
});

test("the labels notices render from the ja catalog", async () => {
	const ja = loadCatalog("ja");
	const f = fixture(ja);
	f.ctx.model = undefined;
	await f.command("on");
	assert.equal(f.notifications.at(-1), ja.format("jouzu.cli.sessionLabels.notify.selectModel"));
	await f.command("unknown");
	assert.equal(f.notifications.at(-1), ja.format("jouzu.cli.sessionLabels.notify.useCommand"));
});
