import { basename, resolve } from "node:path";
import { parseArgs, type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import { catalogText } from "./cli-messages.js";
import { protectedCommand } from "./human-messages.js";
import type { CatalogBundle } from "./locale-catalog.js";
import type { SessionUiStyleRole, SessionUiStyles } from "./session-ui/index.js";
import type { StartupSection, StartupSectionContext } from "./startup-panel.js";
import { fitTerminalText, sanitizeTerminalText, terminalTextWidth } from "./terminal-layout.js";

/**
 * Catalog IDs for the recent-sessions block under the startup banner. They stay
 * local, like the banner's own IDs, so a parallel catalog migration does not
 * conflict on the shared table; `scripts/check-locales.mjs` accepts a
 * catalog-only ID that every locale carries.
 */
const STARTUP_SESSION_IDS = {
	heading: "jouzu.cli.startupSessions.heading",
	recent: "jouzu.cli.startupSessions.summary",
	elsewhere: "jouzu.cli.startupSessions.elsewhere",
	more: "jouzu.cli.startupSessions.more",
	hintOpen: "jouzu.cli.startupSessions.hint.open",
	hintBrowse: "jouzu.cli.startupSessions.hint.browse",
	ageNow: "jouzu.cli.startupSessions.age.now",
	ageMinutes: "jouzu.cli.startupSessions.age.minutes",
	ageHours: "jouzu.cli.startupSessions.age.hours",
	ageDays: "jouzu.cli.startupSessions.age.days",
	ageWeeks: "jouzu.cli.startupSessions.age.weeks",
	ageMonths: "jouzu.cli.startupSessions.age.months",
	ageYears: "jouzu.cli.startupSessions.age.years",
} as const;

/** Rows listed for this project; `/resume` shows the rest. */
const MAX_SESSION_ROWS = 3;
/** Wider terminals keep the block this wide so ages stay near their titles. */
const MAX_BLOCK_WIDTH = 100;
/** Below this width a single summary row replaces the heading and the table. */
const MIN_TABLE_WIDTH = 48;
/** A long folder name in the Elsewhere row is shortened to this width. */
const MAX_PROJECT_NAME_WIDTH = 20;
/** The banner's own hint separator. */
const HINT_SEPARATOR = "  \u00b7  ";
const LIST_SEPARATOR = " \u00b7 ";
const MARKER = "\uE000";

export type StartupSessionsScope = "all" | "project" | "off";

/** `JOUZU_STARTUP_SESSIONS`: `all` (default), `project`, or `off`. `0` also turns the list off. */
export function startupSessionsScope(env: NodeJS.ProcessEnv = process.env): StartupSessionsScope {
	const value = env.JOUZU_STARTUP_SESSIONS?.trim().toLowerCase();
	if (value === "off" || value === "0") return "off";
	if (value === "project") return "project";
	return "all";
}

/**
 * True when the command line starts a new session and no work: it names no
 * session to continue, resume, open, or fork, and passes no prompt or file.
 */
export function launchesFreshSession(args: readonly string[]): boolean {
	const parsed = parseArgs([...args]);
	return !(
		parsed.continue ||
		parsed.resume ||
		parsed.session ||
		parsed.sessionId ||
		parsed.fork ||
		parsed.messages.length > 0 ||
		parsed.fileArgs.length > 0
	);
}

type SessionListCache = Parameters<typeof SessionManager.list>[5];

export interface StartupSessionListers {
	current(context: StartupSectionContext, signal: AbortSignal): Promise<SessionInfo[]>;
	all(context: StartupSectionContext, signal: AbortSignal): Promise<SessionInfo[]>;
}

export interface StartupSessionsOptions {
	scope: Exclude<StartupSessionsScope, "off">;
	catalog: CatalogBundle;
	/** The session list cache `/resume` uses, so the startup scan also warms it. */
	cache?: SessionListCache;
	/** The live lock check `/resume` uses; returns the label for a session another attachment holds. */
	inUseLabel?: (sessionId: string) => string | undefined;
	now?: () => number;
	/** Replaces Pi's session listings; tests use it. */
	listers?: StartupSessionListers;
}

export interface StartupSessions extends StartupSection {
	/** The session file for a row number shown under the banner, or `undefined` for anything else. */
	resumeTarget(argument: string): string | undefined;
}

interface SessionRow {
	path: string;
	title: string;
	modified: number;
	inUse: string | undefined;
}

interface ProjectEntry {
	name: string;
	modified: number;
}

/**
 * With the cache bypassed, an opener that returns no store still limits Pi to
 * metadata: the list needs titles and dates, not each transcript's full text.
 */
const metadataOnly: NonNullable<SessionListCache> = () => undefined;

const piListers: (cache: NonNullable<SessionListCache>) => StartupSessionListers = (cache) => ({
	current: (context, signal) =>
		SessionManager.list(context.cwd, context.sessionManager.getSessionDir(), undefined, signal, false, cache),
	all: (context, signal) =>
		SessionManager.listAll(
			context.sessionManager.usesDefaultSessionDir?.() === false ? context.sessionManager.getSessionDir() : undefined,
			undefined,
			signal,
			false,
			cache,
		),
});

/** The number `/resume` takes for a row: rows count from 1. */
function rowNumber(index: number): string {
	return String(index + 1);
}

function cleanText(value: string): string {
	return sanitizeTerminalText(value.replace(/\s+/gu, " ")).trim();
}

function folderName(cwd: string): string {
	return cleanText(basename(cwd) || cwd);
}

function sameFolder(left: string, right: string): boolean {
	const key = (path: string) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
	return key(left) === key(right);
}

/** The picker's compact age notation: now, 5m, 3h, 2d, 1w, 4mo, 1y. */
function formatAge(catalog: CatalogBundle, milliseconds: number): string {
	const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
	if (minutes < 1) return catalogText(catalog, STARTUP_SESSION_IDS.ageNow);
	if (minutes < 60) return catalogText(catalog, STARTUP_SESSION_IDS.ageMinutes, { count: minutes });
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return catalogText(catalog, STARTUP_SESSION_IDS.ageHours, { count: hours });
	const days = Math.floor(hours / 24);
	if (days < 7) return catalogText(catalog, STARTUP_SESSION_IDS.ageDays, { count: days });
	if (days < 30) return catalogText(catalog, STARTUP_SESSION_IDS.ageWeeks, { count: Math.floor(days / 7) });
	if (days < 365) return catalogText(catalog, STARTUP_SESSION_IDS.ageMonths, { count: Math.floor(days / 30) });
	return catalogText(catalog, STARTUP_SESSION_IDS.ageYears, { count: Math.floor(days / 365) });
}

/**
 * Newest project folders first, one entry per displayed name: two folders that
 * share a name, or a shortened one, read as one entry with the newer age.
 */
function groupProjects(sessions: readonly SessionInfo[]): ProjectEntry[] {
	const newest = new Map<string, ProjectEntry>();
	for (const session of sessions) {
		const name = fitTerminalText(folderName(session.cwd), MAX_PROJECT_NAME_WIDTH, "\u2026");
		const modified = session.modified.getTime();
		const known = newest.get(name);
		if (!known || modified > known.modified) newest.set(name, { name, modified });
	}
	return [...newest.values()].sort((left, right) => right.modified - left.modified);
}

export function createStartupSessions(options: StartupSessionsOptions): StartupSessions {
	const catalog = options.catalog;
	const now = options.now ?? Date.now;
	const listers = options.listers ?? piListers(options.cache ?? metadataOnly);
	let controller: AbortController | undefined;
	let workspace = "";
	let rows: SessionRow[] | undefined;
	let projects: ProjectEntry[] | undefined;
	let frozen = false;
	// Rows granted to the block, fixed when new data arrives. The prompt dock grows
	// while the user types (slash-command suggestions, a multi-line draft), and the
	// list must not shrink and renumber under `/resume 2` as it is typed.
	let granted = 0;
	let grantedFor = -1;
	let shown = 0;

	const text = (id: string, args?: Parameters<typeof catalogText>[2]) => catalogText(catalog, id, args);

	function needed(): number {
		const list = rows?.length ?? 0;
		const elsewhere = projects?.length ? 1 : 0;
		if (list === 0) return elsewhere ? 2 : 0;
		return 2 + Math.min(list, MAX_SESSION_ROWS) + elsewhere;
	}

	/** A catalog line with one argument styled apart from the surrounding label. */
	function labelled(
		id: string,
		name: string,
		value: string,
		width: number,
		roles: [SessionUiStyleRole, SessionUiStyleRole],
		styles: SessionUiStyles,
	): { text: string; width: number } {
		const [before = "", after = ""] = text(id, { [name]: MARKER }).split(MARKER);
		const room = width - terminalTextWidth(before) - terminalTextWidth(after);
		if (room < 1) {
			const plain = fitTerminalText(`${before}${value}${after}`, width, "\u2026");
			return { text: styles.apply(roles[0], plain), width: terminalTextWidth(plain) };
		}
		const fitted = fitTerminalText(value, room, "\u2026");
		return {
			text: `${styles.apply(roles[0], before)}${styles.apply(roles[1], fitted)}${styles.apply(roles[0], after)}`,
			width: terminalTextWidth(`${before}${fitted}${after}`),
		};
	}

	function heading(width: number, count: number, styles: SessionUiStyles): string {
		const title = labelled(
			STARTUP_SESSION_IDS.heading,
			"workspace",
			workspace,
			width,
			["startup.heading", "startup.workspace"],
			styles,
		);
		const range = count === 1 ? "1" : `1-${count}`;
		const open = text(STARTUP_SESSION_IDS.hintOpen, { command: protectedCommand(`/resume ${range}`) });
		const browse = text(STARTUP_SESSION_IDS.hintBrowse, { command: protectedCommand("/resume") });
		for (const hint of [`${open}${HINT_SEPARATOR}${browse}`, open]) {
			const gap = width - title.width - terminalTextWidth(hint);
			if (gap >= 2) return `${title.text}${" ".repeat(gap)}${styles.apply("startup.hint", hint)}`;
		}
		return title.text;
	}

	function sessionLines(width: number, count: number, styles: SessionUiStyles): string[] {
		const visible = (rows ?? []).slice(0, count);
		const ages = visible.map((row) => formatAge(catalog, now() - row.modified));
		const ageWidth = Math.max(...ages.map((age) => terminalTextWidth(age)));
		const badgeWidth = Math.max(0, ...visible.map((row) => (row.inUse ? terminalTextWidth(row.inUse) : 0)));
		return visible.map((row, index) => {
			const number = rowNumber(index);
			const lead = ` ${number}  `;
			const right = ageWidth + (badgeWidth ? 2 + badgeWidth : 0);
			const titleWidth = Math.max(1, width - terminalTextWidth(lead) - 2 - right);
			const title = fitTerminalText(row.title, titleWidth, "\u2026");
			const padding = " ".repeat(Math.max(0, titleWidth - terminalTextWidth(title)) + 2);
			const age = ages[index] ?? "";
			const ageText = `${" ".repeat(ageWidth - terminalTextWidth(age))}${styles.apply("startup.age", age)}`;
			const badge = row.inUse ? `  ${styles.apply("startup.badge", row.inUse)}` : "";
			return ` ${styles.apply("startup.index", number)}  ${styles.apply("startup.title", title)}${padding}${ageText}${badge}`;
		});
	}

	function elsewhereLine(width: number, styles: SessionUiStyles): string {
		const label = ` ${text(STARTUP_SESSION_IDS.elsewhere)}  `;
		const entries = (projects ?? []).map((project) => ({
			name: project.name,
			age: formatAge(catalog, now() - project.modified),
		}));
		const entryWidth = (entry: { name: string; age: string }) => terminalTextWidth(`${entry.name} ${entry.age}`);
		const separatorWidth = terminalTextWidth(LIST_SEPARATOR);
		let used = terminalTextWidth(label);
		let count = 0;
		for (const entry of entries) {
			const rest = entries.length - count - 1;
			const more = rest > 0 ? separatorWidth + terminalTextWidth(text(STARTUP_SESSION_IDS.more, { count: rest })) : 0;
			const next = (count > 0 ? separatorWidth : 0) + entryWidth(entry);
			if (used + next + more > width) break;
			used += next;
			count += 1;
		}
		const parts = entries
			.slice(0, count)
			.map((entry) => `${styles.apply("startup.workspace", entry.name)} ${styles.apply("startup.age", entry.age)}`);
		const rest = entries.length - count;
		if (rest > 0) parts.push(styles.apply("startup.age", text(STARTUP_SESSION_IDS.more, { count: rest })));
		const line = `${styles.apply("startup.label", label)}${parts.join(styles.apply("startup.separator", LIST_SEPARATOR))}`;
		return terminalTextWidth(line) <= width ? line : fitTerminalText(line, width, "\u2026");
	}

	/** One row for short or narrow terminals: label, the newest session, and its age. */
	function summaryLine(width: number, styles: SessionUiStyles): string {
		const row = rows?.[0];
		if (!row) return "";
		const label = text(STARTUP_SESSION_IDS.recent);
		const age = formatAge(catalog, now() - row.modified);
		const number = rowNumber(0);
		const fixed = terminalTextWidth(`${label}  ${number}  `) + 2 + terminalTextWidth(age);
		const title = fitTerminalText(row.title, Math.max(1, width - fixed), "\u2026");
		const line = `${styles.apply("startup.heading", label)}  ${styles.apply("startup.index", number)}  ${styles.apply("startup.title", title)}  ${styles.apply("startup.age", age)}`;
		return terminalTextWidth(line) <= width ? line : fitTerminalText(line, width, "\u2026");
	}

	function layout(width: number, budget: number, styles: SessionUiStyles): string[] {
		const list = rows ?? [];
		const hasProjects = Boolean(projects?.length);
		shown = 0;
		if (budget < 2) return [];
		if (list.length === 0) return hasProjects ? ["", elsewhereLine(width, styles)] : [];
		if (width < MIN_TABLE_WIDTH || budget < 3) {
			shown = 1;
			return ["", summaryLine(width, styles)];
		}
		const count = Math.min(list.length, MAX_SESSION_ROWS, budget - 2);
		shown = count;
		const lines = ["", heading(width, count, styles), ...sessionLines(width, count, styles)];
		if (hasProjects && lines.length < budget) lines.push(elsewhereLine(width, styles));
		return lines;
	}

	function reset(): void {
		controller?.abort();
		controller = undefined;
		rows = undefined;
		projects = undefined;
		frozen = false;
		granted = 0;
		grantedFor = -1;
		shown = 0;
	}

	return {
		start(context) {
			if (controller || rows) return;
			if (context.sessionManager.getEntries().some((entry) => entry.type === "message")) return;
			workspace = folderName(context.cwd);
			const active = new AbortController();
			controller = active;
			const signal = active.signal;
			const current = context.sessionManager.getSessionFile();
			void (async () => {
				// One scan serves both groups: Jouzu keeps every project's sessions in
				// one folder, so the project listing would read the same files again.
				const all = options.scope === "all";
				const listed = (await (all ? listers.all(context, signal) : listers.current(context, signal))).filter(
					(session) => session.path !== current && session.messageCount > 0,
				);
				if (signal.aborted) return;
				const here = all ? listed.filter((session) => sameFolder(session.cwd, context.cwd)) : listed;
				here.sort((left, right) => right.modified.getTime() - left.modified.getTime());
				rows = here.slice(0, MAX_SESSION_ROWS).map((session) => ({
					path: session.path,
					title: cleanText(session.name || session.firstMessage),
					modified: session.modified.getTime(),
					inUse: options.inUseLabel?.(session.id),
				}));
				if (all) projects = groupProjects(listed.filter((session) => !sameFolder(session.cwd, context.cwd)));
				context.requestRender();
			})().catch(() => {
				// The list is a convenience; `/resume` reports its own loading errors.
			});
		},
		freeze() {
			frozen = true;
			controller?.abort();
		},
		reset,
		render(width, available, styles) {
			if (!rows && !projects) return [];
			const need = needed();
			if (!frozen && need !== grantedFor) {
				granted = Math.min(need, available);
				grantedFor = need;
			}
			return layout(Math.min(width, MAX_BLOCK_WIDTH), granted, styles);
		},
		resumeTarget(argument) {
			if (!/^[1-9]\d*$/u.test(argument)) return undefined;
			const index = Number(argument) - 1;
			return index < shown ? rows?.[index]?.path : undefined;
		},
	};
}
