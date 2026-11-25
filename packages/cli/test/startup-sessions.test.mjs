import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { defaultCatalog } from "../dist/cli-messages.js";
import { resolveCatalog } from "../dist/locale-catalog.js";
import { createSessionUiStyles } from "../dist/session-ui/index.js";
import { renderStartupSections, STARTUP_RESERVED_ROWS, startupSectionRows } from "../dist/startup-panel.js";
import { createStartupSessions, launchesFreshSession, startupSessionsScope } from "../dist/startup-sessions.js";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const plain = createSessionUiStyles({ fg: (_color, text) => text }, { colorEnabled: false });

function session(path, cwd, firstMessage, age, extra = {}) {
	return {
		path,
		id: path.replace(/\W/gu, ""),
		cwd,
		name: undefined,
		created: new Date(NOW - age - HOUR),
		modified: new Date(NOW - age),
		messageCount: 4,
		firstMessage,
		allMessagesText: "",
		...extra,
	};
}

const SESSIONS = [
	session("/s/older.jsonl", "/work/jouzu", "An older session", 5 * DAY),
	session("/s/cache.jsonl", "/work/jouzu", "Cache session metadata for resume pickers", 2 * HOUR),
	session("/s/fork.jsonl", "/work/jouzu", "unused first message", DAY, {
		name: "Offer a fork when a session is in use",
	}),
	session("/s/stop.jsonl", "/work/jouzu", "Integrate PR 73 Stop fix with simpler request recording", 3 * DAY),
	session("/s/current.jsonl", "/work/jouzu", "The session this launch just created", 0),
	session("/s/empty.jsonl", "/work/jouzu", "(no messages)", MINUTE, { messageCount: 0 }),
	session("/s/dev.jsonl", "/work/notes", "Planning", 40 * MINUTE),
	session("/s/api.jsonl", "/work/api-server", "Rate limits", 2 * DAY),
	session("/s/api-old.jsonl", "/clone/api-server", "Same folder name elsewhere", 4 * DAY),
	session("/s/dots.jsonl", "/work/dotfiles", "tmux keys", 6 * DAY),
];

function context(entries = []) {
	const calls = { renders: 0 };
	return {
		calls,
		ctx: {
			cwd: "/work/jouzu",
			sessionManager: {
				getSessionDir: () => "/s",
				getSessionFile: () => "/s/current.jsonl",
				getEntries: () => entries,
			},
			requestRender: () => {
				calls.renders += 1;
			},
		},
	};
}

function listers(sessions = SESSIONS, calls = []) {
	return {
		current: async () => {
			calls.push("current");
			return sessions.filter((item) => item.cwd === "/work/jouzu");
		},
		all: async () => {
			calls.push("all");
			return sessions;
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function loaded(options = {}) {
	const section = createStartupSessions({
		scope: "all",
		catalog: defaultCatalog(),
		now: () => NOW,
		inUseLabel: (id) => (id === "scachejsonl" ? "In use" : undefined),
		listers: listers(),
		...options,
	});
	const { ctx, calls } = context();
	section.start(ctx);
	await settle();
	return { section, calls };
}

function row(number, title, age, badge = "") {
	const line = ` ${number}  ${title.padEnd(64)}  ${age}`;
	return badge ? `${line}  ${badge}` : line;
}

test("lists this project's newest sessions, then other project folders", async () => {
	const { section, calls } = await loaded();
	assert.equal(calls.renders, 1, "one scan, one redraw");
	assert.deepEqual(section.render(80, 10, plain), [
		"",
		`Recent in jouzu${" ".repeat(30)}/resume 1-3 open  ·  /resume browse`,
		row(1, "Cache session metadata for resume pickers", "2h", "In use"),
		row(2, "Offer a fork when a session is in use", "1d"),
		row(3, "Integrate PR 73 Stop fix with simpler request recording", "3d"),
		" Elsewhere  notes 40m · api-server 2d · dotfiles 6d",
	]);
});

test("styles each part with the shared roles and keeps meaning without color", async () => {
	const { section } = await loaded();
	// Zero-width codes per theme role, so styled lines measure like real terminal output.
	const codes = { accent: 31, text: 32, dim: 33, warning: 34, muted: 35, borderMuted: 36 };
	const paint = (color, text) => `\u001b[${codes[color]}m${text}\u001b[39m`;
	const brand = (rgb, text) => `\u001b[38;2;${rgb}m${text}\u001b[39m`;
	const styles = createSessionUiStyles({ fg: paint }, { colorEnabled: true, colorMode: "truecolor" });
	const lines = section.render(80, 10, styles);
	const [, heading, first, second, , elsewhere] = lines;
	for (const line of lines) assert.ok(visibleWidth(line) <= 80);
	// Brand blue heading, like Palette headings; the status bar's workspace color for folder names.
	assert.ok(heading.startsWith(`${brand("103;232;249", "Recent in ")}${brand("215;215;255", "jouzu")}`));
	assert.ok(heading.endsWith(paint("dim", "/resume 1-3 open  ·  /resume browse")));
	assert.ok(
		first.startsWith(` ${paint("accent", "1")}  ${paint("text", "Cache session metadata for resume pickers")}`),
	);
	assert.ok(first.endsWith(`${paint("dim", "2h")}  ${paint("warning", "In use")}`));
	assert.ok(second.endsWith(paint("dim", "1d")), "a free session carries no badge");
	const separator = paint("borderMuted", " · ");
	assert.equal(
		elsewhere,
		`${paint("muted", " Elsewhere  ")}${brand("215;215;255", "notes")} ${paint("dim", "40m")}${separator}` +
			`${brand("215;215;255", "api-server")} ${paint("dim", "2d")}${separator}` +
			`${brand("215;215;255", "dotfiles")} ${paint("dim", "6d")}`,
	);
});

test("fits every line from 48 to 200 columns, in English and Japanese, and caps the block width", async () => {
	const wide = { name: "日本語の応答言語設定を確認する長いセッション名".repeat(3) };
	const sessions = [session("/s/ja.jsonl", "/work/jouzu", "unused", 5 * MINUTE, wide), ...SESSIONS];
	for (const catalog of [defaultCatalog(), resolveCatalog("ja").bundle]) {
		for (const width of [48, 60, 80, 120, 200]) {
			const { section } = await loaded({ catalog, listers: listers(sessions) });
			const lines = section.render(width, 10, plain);
			assert.equal(lines.length, 6);
			for (const line of lines) assert.ok(visibleWidth(line) <= Math.min(width, 100), `${width}: ${line}`);
		}
	}
	const { section } = await loaded({ catalog: resolveCatalog("ja").bundle });
	const [, heading, first] = section.render(80, 10, plain);
	assert.match(heading, /^jouzu の最近のセッション +\/resume 1-3 開く {2}· {2}\/resume 一覧$/u);
	assert.match(first, /2時間 {2}In use$/u);
});

test("shrinks to the rows it is given: fewer sessions, then one summary row, then nothing", async () => {
	const short = await loaded();
	assert.deepEqual(short.section.render(80, 4, plain).slice(2), [
		row(1, "Cache session metadata for resume pickers", "2h", "In use"),
		row(2, "Offer a fork when a session is in use", "1d"),
	]);
	assert.match(short.section.render(80, 4, plain)[1], /\/resume 1-2 open/u);
	const summary = await loaded();
	assert.deepEqual(summary.section.render(80, 2, plain), [
		"",
		"Recent  1  Cache session metadata for resume pickers  2h",
	]);
	const narrow = await loaded();
	const [, line] = narrow.section.render(40, 10, plain);
	assert.equal(line, "Recent  1  Cache session metadata f…  2h");
	assert.equal(visibleWidth(line), 40);
	const none = await loaded();
	assert.deepEqual(none.section.render(80, 1, plain), []);
});

test("keeps its height once shown so typing into the prompt does not shift or renumber it", async () => {
	const { section } = await loaded();
	const shown = section.render(80, 10, plain);
	assert.deepEqual(section.render(80, 3, plain), shown, "the prompt dock grew while typing");
	assert.equal(section.resumeTarget("3"), "/s/stop.jsonl");
});

test("resolves only the row numbers it shows", async () => {
	const { section } = await loaded();
	assert.equal(section.resumeTarget("1"), undefined, "nothing is shown before the first render");
	section.render(80, 4, plain);
	assert.equal(section.resumeTarget("1"), "/s/cache.jsonl");
	assert.equal(section.resumeTarget("2"), "/s/fork.jsonl");
	for (const argument of ["3", "0", "01", "-1", "1.0", "cache", ""])
		assert.equal(section.resumeTarget(argument), undefined, argument);
});

test("sanitizes titles and folder names before styling them", async () => {
	const unsafe = [
		session("/s/a.jsonl", "/work/jouzu", "Fix \u001b[31mred\u001b[0m\nbug\tnow\u0007", HOUR),
		session("/s/b.jsonl", "/work/evil\u001b]0;title\u0007name", "x", 2 * HOUR),
	];
	const { section } = await loaded({ listers: listers(unsafe) });
	const lines = section.render(80, 10, plain);
	assert.match(lines[2], /^ 1 {2}Fix red bug now /u);
	assert.equal(lines[3], " Elsewhere  evilname 2h");
	for (const line of lines)
		assert.ok(
			[...line].every((character) => character.charCodeAt(0) >= 0x20),
			line,
		);
});

test("the project scope reads only this folder and leaves other projects out", async () => {
	const calls = [];
	const { section } = await loaded({ scope: "project", listers: listers(SESSIONS, calls) });
	assert.deepEqual(calls, ["current"]);
	const lines = section.render(80, 10, plain);
	assert.equal(lines.length, 5);
	assert.ok(!lines.some((line) => line.includes("Elsewhere")));
});

test("other projects alone show without a heading, and an empty history shows nothing", async () => {
	const elsewhere = SESSIONS.filter((item) => item.cwd !== "/work/jouzu");
	const { section } = await loaded({ listers: listers(elsewhere) });
	assert.deepEqual(section.render(80, 10, plain), ["", " Elsewhere  notes 40m · api-server 2d · dotfiles 6d"]);
	const empty = await loaded({ listers: listers([]) });
	assert.deepEqual(empty.section.render(80, 10, plain), []);
});

test("the Elsewhere row counts the folders it cannot fit", async () => {
	const many = Array.from({ length: 30 }, (_, index) =>
		session(`/s/p${index}.jsonl`, `/work/project-${index}`, "x", (index + 1) * HOUR),
	);
	const { section } = await loaded({ listers: listers(many) });
	const [, line] = section.render(60, 10, plain);
	assert.equal(line, " Elsewhere  project-0 1h · project-1 2h · +28 more");
	assert.ok(visibleWidth(line) <= 60);
});

test("a launch that already has a conversation loads nothing", async () => {
	const calls = [];
	const section = createStartupSessions({ scope: "all", catalog: defaultCatalog(), listers: listers(SESSIONS, calls) });
	section.start(context([{ type: "session" }, { type: "message" }]).ctx);
	await settle();
	assert.deepEqual(calls, []);
	assert.deepEqual(section.render(80, 10, plain), []);
});

test("freezing before the scan finishes discards it; a reset drops what was shown", async () => {
	let release;
	const pending = new Promise((resolve) => {
		release = resolve;
	});
	const section = createStartupSessions({
		scope: "all",
		catalog: defaultCatalog(),
		listers: {
			current: () => pending,
			all: () => pending,
		},
	});
	const { ctx, calls } = context();
	section.start(ctx);
	section.freeze();
	release(SESSIONS);
	await settle();
	assert.equal(calls.renders, 0);
	assert.deepEqual(section.render(80, 10, plain), []);

	const shown = await loaded();
	assert.equal(shown.section.render(80, 10, plain).length, 6);
	shown.section.reset();
	assert.deepEqual(shown.section.render(80, 10, plain), []);
	assert.equal(shown.section.resumeTarget("1"), undefined);
});

test("a failed scan shows nothing", async () => {
	const section = createStartupSessions({
		scope: "all",
		catalog: defaultCatalog(),
		listers: { current: async () => [], all: async () => Promise.reject(new Error("disk")) },
	});
	section.start(context().ctx);
	await settle();
	assert.deepEqual(section.render(80, 10, plain), []);
});

test("startup sections share the rows between the banner and the prompt dock", () => {
	assert.equal(STARTUP_RESERVED_ROWS, 4);
	assert.equal(startupSectionRows(24, 5, 4), 11);
	assert.equal(startupSectionRows(24, undefined, 4), 11, "an unmeasured dock counts as five rows");
	assert.equal(startupSectionRows(12, 5, 4), 0);
	assert.equal(startupSectionRows(Number.NaN, 5, 4), 0);
	const granted = [];
	const section = (count) => ({
		render(_width, rows) {
			granted.push(rows);
			return Array.from({ length: Math.min(count, rows) }, (_, index) => String(index));
		},
	});
	assert.deepEqual(renderStartupSections([section(3), section(5)], 80, 6, plain), ["0", "1", "2", "0", "1", "2"]);
	assert.deepEqual(granted, [6, 3]);
});

test("the list runs only for a fresh launch, in the scope the environment selects", () => {
	assert.equal(launchesFreshSession([]), true);
	assert.equal(launchesFreshSession(["--model", "sonnet", "--no-session"]), true);
	for (const args of [["-c"], ["--resume"], ["--session", "abc"], ["--fork", "abc"], ["fix the bug"], ["@notes.md"]])
		assert.equal(launchesFreshSession(args), false, args.join(" "));
	assert.equal(startupSessionsScope({}), "all");
	assert.equal(startupSessionsScope({ JOUZU_STARTUP_SESSIONS: " Project " }), "project");
	assert.equal(startupSessionsScope({ JOUZU_STARTUP_SESSIONS: "off" }), "off");
	assert.equal(startupSessionsScope({ JOUZU_STARTUP_SESSIONS: "0" }), "off");
	assert.equal(startupSessionsScope({ JOUZU_STARTUP_SESSIONS: "sideways" }), "all");
});
