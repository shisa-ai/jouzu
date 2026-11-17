import type { ExtensionContext, ExtensionFactory, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { CatalogMessageId, catalogText, defaultCatalog } from "./cli-messages.js";
import { protectedCommand } from "./human-messages.js";
import { formatEffectiveKeybinding } from "./keybinding-hints.js";
import type { CatalogBundle } from "./locale-catalog.js";
import { type ScanEvidence, type ScanFinding, summarizeEvidence, UNAVAILABLE_REASON_MESSAGE_ID } from "./textguard.js";
import { type ContentReview, type ContentSnapshot, displayLabel, escapeInvisible } from "./textguard-admission.js";
import type { TextGuardAlert, TextGuardMode } from "./textguard-policy.js";
import type { TextGuardRuntime } from "./textguard-runtime.js";

/** Native scans attach the offending code point; injected evidence may not. */
type ReviewFinding = ScanFinding & { codepoint?: string };

/** Stable identity for a review action, so the decision logic survives translation. */
type ReviewActionId = "allow-session" | "allow-always" | "dismiss" | "back";

interface ReviewAction {
	id: ReviewActionId;
	label: string;
}

/** The catalog ID for each decision action's label. */
const ACTION_LABEL_ID: Record<ReviewActionId, CatalogMessageId> = {
	"allow-session": CatalogMessageId.textguardActionAllowSession,
	"allow-always": CatalogMessageId.textguardActionAllowAlways,
	dismiss: CatalogMessageId.textguardActionDismiss,
	back: CatalogMessageId.textguardActionBack,
};

/** What each mode does, for a confirmation the user reads once. */
const MODE_TEXT_ID: Record<TextGuardMode, CatalogMessageId> = {
	guarded: CatalogMessageId.textguardModeGuarded,
	strict: CatalogMessageId.textguardModeStrict,
	off: CatalogMessageId.textguardModeOff,
};
/** What the user may type after /textguard to choose a mode. */
const MODE_ARGS: Record<string, TextGuardMode | undefined> = {
	on: "guarded",
	guarded: "guarded",
	strict: "strict",
	off: "off",
};
const MODE_LABEL: Record<TextGuardMode, string> = { guarded: "on", strict: "strict", off: "off" };
/** Shown above the list whenever scanning is not in its default mode. */
const MODE_BANNER_ID: Record<TextGuardMode, CatalogMessageId | undefined> = {
	guarded: undefined,
	strict: CatalogMessageId.textguardBannerStrict,
	off: CatalogMessageId.textguardBannerOff,
};

/**
 * The catalog IDs for the alert detail a user reads. The model banner carries
 * its own fixed English copy in `textguard-policy.ts`, so these messages are
 * the user-facing half of the split and resolve from the active catalog.
 */
const DETAIL_MESSAGE_ID = {
	unavailable: "jouzu.cli.textguard.detail.unavailable",
	errors: "jouzu.cli.textguard.detail.errors",
	errorsWithKinds: "jouzu.cli.textguard.detail.errorsWithKinds",
	warnings: "jouzu.cli.textguard.detail.warnings",
	none: "jouzu.cli.textguard.detail.none",
} as const;

/**
 * The catalog IDs for the finding kinds the scanner reports. The kind
 * identifier itself (`bidi_control`, a `yara:` rule, or another scanner token)
 * is a protected value passed as an argument; these IDs carry the human name
 * and the one-sentence explanation the review overlay shows.
 */
const KIND_MESSAGE_ID: Record<string, [name: string, explanation: string]> = {
	bidi_control: ["jouzu.cli.textguard.kind.bidiControl", "jouzu.cli.textguard.kind.bidiControl.explanation"],
	ansi_escape: ["jouzu.cli.textguard.kind.ansiEscape", "jouzu.cli.textguard.kind.ansiEscape.explanation"],
	invisible_char: ["jouzu.cli.textguard.kind.invisibleChar", "jouzu.cli.textguard.kind.invisibleChar.explanation"],
	combining_abuse: ["jouzu.cli.textguard.kind.combiningAbuse", "jouzu.cli.textguard.kind.combiningAbuse.explanation"],
	soft_hyphen: ["jouzu.cli.textguard.kind.softHyphen", "jouzu.cli.textguard.kind.softHyphen.explanation"],
	tag_character: ["jouzu.cli.textguard.kind.tagCharacter", "jouzu.cli.textguard.kind.tagCharacter.explanation"],
	variation_selector: [
		"jouzu.cli.textguard.kind.variationSelector",
		"jouzu.cli.textguard.kind.variationSelector.explanation",
	],
	split_token: ["jouzu.cli.textguard.kind.splitToken", "jouzu.cli.textguard.kind.splitToken.explanation"],
	decoded: ["jouzu.cli.textguard.kind.decoded", "jouzu.cli.textguard.kind.decoded.explanation"],
	normalized: ["jouzu.cli.textguard.kind.normalized", "jouzu.cli.textguard.kind.normalized.explanation"],
	stripped: ["jouzu.cli.textguard.kind.stripped", "jouzu.cli.textguard.kind.stripped.explanation"],
};

/** The fallback kind name and explanation for a bundled `yara:` rule and for an unknown kind. */
const BUNDLED_RULE_MESSAGE_ID = [
	"jouzu.cli.textguard.kind.bundledRule",
	"jouzu.cli.textguard.kind.bundledRule.explanation",
] as const;
const FLAGGED_PATTERN_MESSAGE_ID = [
	"jouzu.cli.textguard.kind.flaggedPattern",
	"jouzu.cli.textguard.kind.flaggedPattern.explanation",
] as const;

/** The catalog IDs for the review body, the finding location, and the simple counts line. */
const REVIEW_MESSAGE_ID = {
	source: "jouzu.cli.textguard.review.source",
	fingerprint: "jouzu.cli.textguard.review.fingerprint",
	notRetained: "jouzu.cli.textguard.review.notRetained",
	flaggedHeading: "jouzu.cli.textguard.review.flaggedHeading",
	riskNotice: "jouzu.cli.textguard.review.riskNotice",
	findingsTruncated: "jouzu.cli.textguard.review.findingsTruncated",
	countsLine: "jouzu.cli.textguard.counts.line",
	locationCharacter: "jouzu.cli.textguard.location.character",
	locationLine: "jouzu.cli.textguard.location.line",
} as const;

/** The catalog IDs for the review overlay chrome. */
const CHROME_MESSAGE_ID = {
	offTitle: "jouzu.cli.textguard.off.title",
	offBody: "jouzu.cli.textguard.off.body",
	hintSelect: "jouzu.cli.textguard.hint.select",
	hintOpen: "jouzu.cli.textguard.hint.open",
	hintClose: "jouzu.cli.textguard.hint.close",
	hintAction: "jouzu.cli.textguard.hint.action",
	hintScroll: "jouzu.cli.textguard.hint.scroll",
	hintBack: "jouzu.cli.textguard.hint.back",
	listHeader: "jouzu.cli.textguard.list.header",
	listSummary: "jouzu.cli.textguard.list.summary",
	statusWithheld: "jouzu.cli.textguard.status.withheld",
	statusDelivered: "jouzu.cli.textguard.status.delivered",
	statusReport: "jouzu.cli.textguard.status.report",
	listProgress: "jouzu.cli.textguard.list.progress",
	listNotices: "jouzu.cli.textguard.list.notices",
	detailProgress: "jouzu.cli.textguard.detail.progress",
	commandDescription: "jouzu.cli.textguard.commandDescription",
} as const;

/** The list column the three status words are padded to, in display columns. */
const STATUS_WIDTH = 9;

/** The catalog ID for each severity word the verdict line and the finding line use. */
const SEVERITY_LABEL_ID: Record<ScanFinding["severity"], CatalogMessageId> = {
	error: CatalogMessageId.textguardSeverityError,
	warn: CatalogMessageId.textguardSeverityWarn,
	info: CatalogMessageId.textguardSeverityInfo,
};

/** Human location for a finding offset, measured in the exact scanned text when it is retained. */
function location(finding: ReviewFinding, catalog: CatalogBundle, body?: string): string {
	const offset = finding.offset;
	if (offset === null) return "";
	if (typeof body !== "string" || offset > body.length)
		return catalogText(catalog, REVIEW_MESSAGE_ID.locationCharacter, { offset });
	const before = body.slice(0, offset);
	const line = (before.match(/\n/g) ?? []).length + 1;
	const column = offset - (before.lastIndexOf("\n") + 1) + 1;
	return catalogText(catalog, REVIEW_MESSAGE_ID.locationLine, { line, column });
}

function describeFinding(finding: ReviewFinding, catalog: CatalogBundle, body?: string): string[] {
	const known = KIND_MESSAGE_ID[finding.kind];
	const bundled = known === undefined && finding.kind.startsWith("yara:");
	const [nameId, explanationId] = known ?? (bundled ? BUNDLED_RULE_MESSAGE_ID : FLAGGED_PATTERN_MESSAGE_ID);
	const name = bundled
		? catalogText(catalog, nameId, { rule: escapeInvisible(finding.kind.slice(5)) })
		: known
			? catalogText(catalog, nameId)
			: catalogText(catalog, nameId, { kind: displayLabel(finding.kind) });
	const severity = catalogText(catalog, SEVERITY_LABEL_ID[finding.severity]);
	const codepoint = finding.codepoint ? ` ${finding.codepoint}` : "";
	const where = location(finding, catalog, body);
	const line = where
		? catalogText(catalog, CatalogMessageId.textguardFindingLocatedLine, { severity, name, codepoint, location: where })
		: catalogText(catalog, CatalogMessageId.textguardFindingLine, { severity, name, codepoint });
	return [line, catalogText(catalog, explanationId)];
}

function countsLine(evidence: ScanEvidence, withheld: boolean, catalog: CatalogBundle): string {
	const counts = evidence.severityCounts ?? { info: 0, warn: 0, error: 0 };
	const errors = counts.error ?? 0;
	const warnings = counts.warn ?? 0;
	const notes = counts.info ?? 0;
	const blocking =
		errors === 0
			? catalogText(catalog, CatalogMessageId.textguardCountsNoErrors)
			: withheld
				? catalogText(catalog, CatalogMessageId.textguardCountsBlocking, { count: errors })
				: catalogText(catalog, CatalogMessageId.textguardCountsDelivered, { count: errors });
	const warningClause = warnings
		? catalogText(catalog, CatalogMessageId.textguardCountsWarning, { count: warnings })
		: "";
	const noteClause = notes ? catalogText(catalog, CatalogMessageId.textguardCountsInformational, { count: notes }) : "";
	if (!warningClause && !noteClause) return catalogText(catalog, REVIEW_MESSAGE_ID.countsLine, { blocking });
	if (warningClause && noteClause)
		return catalogText(catalog, CatalogMessageId.textguardCountsNonBlockingBoth, {
			blocking,
			warnings: warningClause,
			notes: noteClause,
		});
	if (warningClause)
		return catalogText(catalog, CatalogMessageId.textguardCountsNonBlockingWarnings, {
			blocking,
			warnings: warningClause,
		});
	return catalogText(catalog, CatalogMessageId.textguardCountsNonBlockingNotes, { blocking, notes: noteClause });
}

/** One short clause naming what the scan found, for the alert detail a user reads. */
function describeEvidenceForUser(evidence: ScanEvidence, catalog: CatalogBundle): string {
	const summary = summarizeEvidence(evidence);
	if (summary.status === "unavailable")
		return catalogText(catalog, DETAIL_MESSAGE_ID.unavailable, {
			reason: catalogText(catalog, UNAVAILABLE_REASON_MESSAGE_ID[summary.reason]),
		});
	if (summary.status === "errors")
		return catalogText(catalog, summary.kinds ? DETAIL_MESSAGE_ID.errorsWithKinds : DETAIL_MESSAGE_ID.errors, {
			count: summary.count,
			kinds: summary.kinds,
		});
	if (summary.status === "warnings") return catalogText(catalog, DETAIL_MESSAGE_ID.warnings, { count: summary.count });
	return catalogText(catalog, DETAIL_MESSAGE_ID.none);
}

function evidenceLines(review: ContentReview, withheld: boolean, catalog: CatalogBundle, body?: string): string[] {
	const evidence = review.evidence;
	if (evidence.status === "unavailable") {
		const reason = catalogText(catalog, UNAVAILABLE_REASON_MESSAGE_ID[evidence.reason ?? "scanner"]);
		return [
			catalogText(catalog, "jouzu.cli.textguard.evidence.unavailable", { reason }),
			catalogText(
				catalog,
				withheld ? CatalogMessageId.textguardEvidenceWithheld : CatalogMessageId.textguardEvidenceDelivered,
			),
		];
	}
	const lines = [countsLine(evidence, withheld, catalog)];
	for (const finding of evidence.findings) lines.push(...describeFinding(finding, catalog, body));
	if (evidence.findingCount !== undefined && evidence.findingCount > evidence.findings.length)
		lines.push(
			catalogText(catalog, REVIEW_MESSAGE_ID.findingsTruncated, {
				shown: evidence.findings.length,
				total: evidence.findingCount,
			}),
		);
	return lines;
}

/** Escape scanned content for display: controls and invisible characters become visible escapes. */
function displayContent(text: string): string {
	return text
		.split("\n")
		.map((line) => escapeInvisible(JSON.stringify(line).slice(1, -1)))
		.join("\n");
}

/**
 * Logical (unwrapped) review lines: the complete source label, the exact
 * fingerprint, findings with explanations and locations, and the escaped
 * content when retained. The review component wraps these at render width.
 */
export function reviewLines(
	review: ContentReview,
	snapshot?: ContentSnapshot,
	withheld = true,
	catalog: CatalogBundle = defaultCatalog(),
): string[] {
	const body = snapshot?.body;
	const lines = [
		catalogText(catalog, REVIEW_MESSAGE_ID.source, {
			source: snapshot ? displayLabel(snapshot.source) : review.displaySource,
		}),
		catalogText(catalog, REVIEW_MESSAGE_ID.fingerprint, { digest: review.contentDigest }),
		"",
		...evidenceLines(review, withheld, catalog, body),
		"",
	];
	if (body === undefined) lines.push(catalogText(catalog, REVIEW_MESSAGE_ID.notRetained));
	else lines.push(catalogText(catalog, REVIEW_MESSAGE_ID.flaggedHeading), ...displayContent(body).split("\n"));
	lines.push("", catalogText(catalog, REVIEW_MESSAGE_ID.riskNotice));
	return lines;
}

interface ReviewItem {
	review: ContentReview;
	withheld: boolean;
}

/** Error-level findings and incomplete checks are the ones a user has to decide about. */
export function blocking(review: ContentReview): boolean {
	return review.evidence.status === "unavailable" || (review.evidence.severityCounts?.error ?? 0) > 0;
}

export interface ReviewOutcome {
	approval?: { id: string; persist: boolean };
	mode?: TextGuardMode;
}

export interface ReviewComponentDeps {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	items: ReviewItem[];
	snapshotFor: (id: string) => ContentSnapshot | undefined;
	dismiss: (id: string) => void;
	notices: number;
	done: (outcome: ReviewOutcome) => void;
	mode?: TextGuardMode;
	/** Count of items in the other view, named in the footer so neither list hides the other. */
	otherView?: { count: number; hint: string };
	/** The resolved catalog the review view renders its human text from. */
	catalog: CatalogBundle;
}

/**
 * The /textguard overlay: a scrollable review view with the findings, the
 * escaped content, and the decision actions on one screen. All keys resolve
 * through the keybinding manager; cancellation returns to the list instead of
 * discarding the session's review state.
 */
export function createReviewComponent(deps: ReviewComponentDeps): Component {
	const { theme, keybindings } = deps;
	const catalog = deps.catalog;
	const items = [...deps.items];
	const mode = deps.mode ?? "guarded";
	const outcome: ReviewOutcome = {};
	// With scanning off there is nothing to review, so the view is the switch that turns it back on.
	let state: "list" | "detail" | "off" = mode === "off" ? "off" : "list";
	let selected = 0;
	let listScroll = 0;
	let actionIndex = 0;
	let bodyScroll = 0;
	let detailLines: string[] = [];
	let wrapCache: { width: number; lines: string[] } | undefined;

	const hint = (action: Parameters<typeof formatEffectiveKeybinding>[1]) =>
		formatEffectiveKeybinding(keybindings, action);
	const actionIds = (item: ReviewItem): ReviewActionId[] =>
		item.withheld ? ["allow-session", "allow-always", "back"] : ["dismiss", "back"];
	const actions = (item: ReviewItem): ReviewAction[] =>
		actionIds(item).map((id) => ({ id, label: catalogText(catalog, ACTION_LABEL_ID[id]) }));
	/** Join the resolved key-hint fragments with the middle-dot separator the footer uses. */
	const hintLine = (parts: ReadonlyArray<readonly [id: string, keys: string]>): string =>
		parts.map(([id, keys]) => catalogText(catalog, id, { keys })).join(" · ");
	/** Pad a status word to the fixed list column so the source labels line up. */
	const padStatus = (text: string): string => text + " ".repeat(Math.max(0, STATUS_WIDTH - visibleWidth(text)));

	const wrapDetail = (width: number): string[] => {
		if (wrapCache?.width === width) return wrapCache.lines;
		const lines = detailLines.flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, width)));
		wrapCache = { width, lines };
		return lines;
	};

	const enterDetail = () => {
		const item = items[selected];
		if (!item) return;
		detailLines = reviewLines(item.review, deps.snapshotFor(item.review.id), item.withheld, catalog);
		wrapCache = undefined;
		// Default to denial: the cursor starts on the non-approving action.
		const itemActions = actions(item);
		actionIndex = item.withheld ? itemActions.length - 1 : 0;
		bodyScroll = 0;
		state = "detail";
	};

	const activate = () => {
		const item = items[selected];
		if (!item) return;
		const action = actions(item)[actionIndex];
		if (action.id === "allow-session" || action.id === "allow-always") {
			outcome.approval = { id: item.review.id, persist: action.id === "allow-always" };
			deps.done(outcome);
			return;
		}
		if (action.id === "dismiss") {
			deps.dismiss(item.review.id);
			items.splice(selected, 1);
			if (items.length === 0) {
				deps.done(outcome);
				return;
			}
			selected = Math.min(selected, items.length - 1);
			listScroll = Math.min(listScroll, Math.max(0, items.length - 1));
		}
		state = "list";
	};

	const renderOff = (width: number): string[] => [
		truncateToWidth(theme.bold(theme.fg("accent", catalogText(catalog, CHROME_MESSAGE_ID.offTitle))), width, ""),
		"",
		...wrapTextWithAnsi(theme.fg("dim", catalogText(catalog, CHROME_MESSAGE_ID.offBody)), width),
		"",
		truncateToWidth(
			theme.fg("accent", `> ${catalogText(catalog, CatalogMessageId.textguardActionEnable)}`),
			width,
			"…",
		),
		"",
		theme.fg(
			"dim",
			truncateToWidth(
				hintLine([
					[CHROME_MESSAGE_ID.hintSelect, hint("tui.select.confirm")],
					[CHROME_MESSAGE_ID.hintClose, hint("tui.select.cancel")],
				]),
				width,
				"…",
			),
		),
	];

	const renderList = (width: number, height: number): string[] => {
		const withheld = items.filter((item) => item.withheld).length;
		const header = theme.bold(theme.fg("accent", catalogText(catalog, CHROME_MESSAGE_ID.listHeader)));
		const summary = theme.fg(
			"dim",
			` ${catalogText(catalog, CHROME_MESSAGE_ID.listSummary, { withheld, delivered: items.length - withheld })}`,
		);
		const lines = [truncateToWidth(`${header}${summary}`, width, ""), ""];
		if (mode !== "guarded") {
			const banner = MODE_BANNER_ID[mode];
			if (banner) lines.push(theme.fg("warning", truncateToWidth(catalogText(catalog, banner), width, "…")), "");
		}
		const hints = hintLine([
			[CHROME_MESSAGE_ID.hintSelect, `${hint("tui.select.up")}/${hint("tui.select.down")}`],
			[CHROME_MESSAGE_ID.hintOpen, hint("tui.select.confirm")],
			[CHROME_MESSAGE_ID.hintClose, hint("tui.select.cancel")],
		]);
		const footer: string[] = [];
		if (deps.otherView && deps.otherView.count > 0)
			footer.push(...wrapTextWithAnsi(theme.fg("dim", `${deps.otherView.count} ${deps.otherView.hint}`), width));
		if (deps.notices > 0)
			footer.push(
				...wrapTextWithAnsi(
					theme.fg("dim", catalogText(catalog, CHROME_MESSAGE_ID.listNotices, { count: deps.notices })),
					width,
				),
			);
		footer.push(theme.fg("dim", hints));
		const budget = Math.max(1, height - lines.length - footer.length - 1);
		listScroll = Math.max(0, Math.min(listScroll, items.length - budget));
		if (selected < listScroll) listScroll = selected;
		if (selected >= listScroll + budget) listScroll = selected - budget + 1;
		const window = items.slice(listScroll, listScroll + budget);
		for (const [index, item] of window.entries()) {
			const current = listScroll + index === selected;
			const status = item.withheld
				? theme.fg("warning", padStatus(catalogText(catalog, CHROME_MESSAGE_ID.statusWithheld)))
				: blocking(item.review)
					? theme.fg("warning", padStatus(catalogText(catalog, CHROME_MESSAGE_ID.statusDelivered)))
					: theme.fg("dim", padStatus(catalogText(catalog, CHROME_MESSAGE_ID.statusReport)));
			const label = item.review.displaySource;
			lines.push(truncateToWidth(`${current ? theme.fg("accent", "> ") : "  "}${status} ${label}`, width, "…"));
		}
		if (items.length > budget)
			lines.push(
				theme.fg(
					"dim",
					`  ${catalogText(catalog, CHROME_MESSAGE_ID.listProgress, { current: selected + 1, total: items.length })}`,
				),
			);
		lines.push("", ...footer);
		return lines;
	};

	const renderDetail = (width: number, height: number): string[] => {
		const item = items[selected];
		if (!item) {
			state = "list";
			return renderList(width, height);
		}
		const header = theme.bold(
			theme.fg(
				"accent",
				item.withheld
					? catalogText(catalog, CatalogMessageId.textguardDetailWithheld)
					: blocking(item.review)
						? catalogText(catalog, CatalogMessageId.textguardDetailDelivered)
						: catalogText(catalog, CatalogMessageId.textguardDetailReport),
			),
		);
		const itemActions = actions(item);
		const hints = hintLine([
			[CHROME_MESSAGE_ID.hintAction, `${hint("tui.select.up")}/${hint("tui.select.down")}`],
			[CHROME_MESSAGE_ID.hintScroll, `${hint("tui.select.pageUp")}/${hint("tui.select.pageDown")}`],
			[CHROME_MESSAGE_ID.hintSelect, hint("tui.select.confirm")],
			[CHROME_MESSAGE_ID.hintBack, hint("tui.select.cancel")],
		]);
		const actionLines = itemActions.map((action, index) =>
			truncateToWidth(
				index === actionIndex ? theme.fg("accent", `> ${action.label}`) : `  ${action.label}`,
				width,
				"…",
			),
		);
		const chrome = 1 + 1 + actionLines.length + 1 + 1;
		const budget = Math.max(1, height - chrome);
		const body = wrapDetail(width);
		bodyScroll = Math.max(0, Math.min(bodyScroll, Math.max(0, body.length - budget)));
		const window = body.slice(bodyScroll, bodyScroll + budget);
		const lines = [truncateToWidth(header, width, ""), ...window];
		if (body.length > budget)
			lines.push(
				theme.fg(
					"dim",
					`  ${catalogText(catalog, CHROME_MESSAGE_ID.detailProgress, {
						start: bodyScroll + 1,
						end: Math.min(bodyScroll + budget, body.length),
						total: body.length,
					})}`,
				),
			);
		lines.push("", ...actionLines, "", theme.fg("dim", truncateToWidth(hints, width, "…")));
		return lines;
	};

	return {
		render(width: number): string[] {
			const columns = Math.max(12, width - 2);
			const rows = Number(deps.tui.terminal?.rows ?? 24);
			const height = Math.max(8, Math.min(rows - 6, 44));
			const inner =
				state === "off"
					? renderOff(columns)
					: state === "list"
						? renderList(columns, height)
						: renderDetail(columns, height);
			return inner.map((line) => ` ${line}`);
		},
		invalidate() {
			wrapCache = undefined;
		},
		handleInput(data: string) {
			if (keybindings.matches(data, "tui.select.cancel")) {
				if (state === "detail") state = "list";
				else deps.done(outcome);
				return;
			}
			if (state === "off") {
				if (keybindings.matches(data, "tui.select.confirm")) {
					outcome.mode = "guarded";
					deps.done(outcome);
				}
				return;
			}
			if (state === "list") {
				if (keybindings.matches(data, "tui.select.up")) selected = Math.max(0, selected - 1);
				else if (keybindings.matches(data, "tui.select.down")) selected = Math.min(items.length - 1, selected + 1);
				else if (keybindings.matches(data, "tui.select.pageUp")) selected = Math.max(0, selected - 8);
				else if (keybindings.matches(data, "tui.select.pageDown")) selected = Math.min(items.length - 1, selected + 8);
				else if (keybindings.matches(data, "tui.select.confirm")) enterDetail();
				return;
			}
			const itemActions = actions(items[selected]);
			if (keybindings.matches(data, "tui.select.up")) actionIndex = Math.max(0, actionIndex - 1);
			else if (keybindings.matches(data, "tui.select.down"))
				actionIndex = Math.min(itemActions.length - 1, actionIndex + 1);
			else if (keybindings.matches(data, "tui.select.pageUp")) bodyScroll = Math.max(0, bodyScroll - 8);
			else if (keybindings.matches(data, "tui.select.pageDown")) bodyScroll += 8;
			else if (keybindings.matches(data, "tui.select.confirm")) activate();
		},
	};
}

/** Status key under which clients without a terminal receive TextGuard state as JSON. */
export const TEXTGUARD_STATUS_KEY = "jouzu-textguard";

/** Read-only TextGuard state for clients: the mode and the items waiting for a user decision. */
export interface TextGuardStatus {
	version: 1;
	mode: TextGuardMode;
	pending: {
		id: string;
		source: string;
		status: ScanEvidence["status"];
		reason?: string;
		findings: { kind: string; severity: string }[];
	}[];
}

export function textGuardStatus(mode: TextGuardMode, reviews: ContentReview[]): TextGuardStatus {
	return {
		version: 1,
		mode,
		pending: reviews.map((review) => ({
			id: review.id,
			source: review.displaySource,
			status: review.evidence.status,
			...(review.evidence.reason ? { reason: review.evidence.reason } : {}),
			findings: review.evidence.findings.slice(0, 16).map(({ kind, severity }) => ({ kind, severity })),
		})),
	};
}

export function createTextGuardReviewExtension(
	runtime: TextGuardRuntime,
	options: {
		writeDiagnostic?: (text: string) => void;
		terminal?: () => { columns: number; rows: number; dumb: boolean };
		/** The resolved catalog the review view renders its human text from. */
		catalog?: CatalogBundle;
	} = {},
): ExtensionFactory {
	const catalog = options.catalog ?? defaultCatalog();
	/** Render one catalog message for this extension's notifications and view. */
	const msg = (id: CatalogMessageId, args?: Parameters<typeof catalogText>[2]): string =>
		catalogText(catalog, id, args);
	const writeDiagnostic =
		options.writeDiagnostic ??
		((text: string) => {
			process.stderr.write(`${text}\n`);
		});
	const terminal =
		options.terminal ??
		(() => ({
			columns: process.stdout.columns ?? 80,
			rows: process.stdout.rows ?? 24,
			dumb: process.env.TERM === "dumb",
		}));
	return (pi) => {
		let lastNotice = "";
		let context: ExtensionContext | undefined;
		// Every mode with a user interface (terminal, RPC, ACP) shows the message to the user; only a
		// session without one, such as print mode, falls back to stderr.
		const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "warning") => {
			if (ctx.hasUI) ctx.ui.notify(message, type);
			else writeDiagnostic(message);
		};
		let lastState = "";
		/**
		 * Clients without a terminal (RPC, ACP) get the mode and what is waiting for review as
		 * structured, read-only status under one key; the terminal has its own review view and
		 * footer. Items never carry the withheld text, and nothing here can approve content.
		 */
		const publishState = (ctx: ExtensionContext) => {
			if (!ctx.hasUI || ctx.mode === "tui") return;
			const policy = runtime.forSession(ctx.sessionManager.getSessionId());
			const state = JSON.stringify(textGuardStatus(runtime.currentMode(), policy?.reviews() ?? []));
			if (state === lastState) return;
			lastState = state;
			ctx.ui.setStatus(TEXTGUARD_STATUS_KEY, state);
		};
		const alertText = (alert: TextGuardAlert, interactive: boolean): string => {
			const source = alert.source.length > 96 ? `${alert.source.slice(0, 96)}…` : alert.source;
			const detail = describeEvidenceForUser(alert.evidence, catalog);
			if (alert.kind === "advisory")
				return msg(CatalogMessageId.textguardAlertFlagged, {
					source,
					detail,
					report: interactive
						? msg(CatalogMessageId.textguardAlertAdvisoryReport, { command: protectedCommand("/textguard") })
						: "",
				});
			const next = alert.approvable
				? interactive
					? ` ${msg(CatalogMessageId.textguardAlertApproveInteractive, { command: protectedCommand("/textguard") })}`
					: ` ${msg(CatalogMessageId.textguardAlertApproveNonInteractive, { command: protectedCommand("/textguard") })}`
				: ` ${msg(CatalogMessageId.textguardAlertNotApprovable)}`;
			return msg(CatalogMessageId.textguardAlertWithheld, { source, detail, next });
		};
		/** The confirmation a mode change shows; the strict and off texts name the command. */
		const modeText = (mode: TextGuardMode): string => {
			if (mode === "strict") return msg(MODE_TEXT_ID[mode], { command: protectedCommand("/textguard") });
			if (mode === "off") return msg(MODE_TEXT_ID[mode], { command: protectedCommand("/textguard on") });
			return msg(MODE_TEXT_ID[mode]);
		};
		// Raised as content is admitted or withheld, so a blocked request is visible when it happens.
		const showAlert = (alert: TextGuardAlert): boolean => {
			const ctx = context;
			if (!ctx) return false;
			notify(ctx, alertText(alert, ctx.mode === "tui" && ctx.hasUI), alert.kind === "withheld" ? "warning" : "info");
			publishState(ctx);
			return true;
		};
		const report = (_event: unknown, ctx: ExtensionContext) => {
			context = ctx;
			runtime.setAlertListener(showAlert);
			const policy = runtime.forSession(ctx.sessionManager.getSessionId());
			if (!policy) {
				publishState(ctx);
				return;
			}
			const queued = policy.drainAlerts();
			for (const alert of queued) showAlert(alert);
			publishState(ctx);
			const pending = policy.reviews();
			const identity = JSON.stringify([ctx.sessionManager.getSessionId(), pending.map((item) => item.id)]);
			if (identity === lastNotice) return;
			lastNotice = identity;
			// Only content still waiting for a decision notifies here, and only when no alert just
			// named it. Non-blocking reports never interrupt the session.
			if (pending.length && queued.length === 0) {
				const advice =
					ctx.mode === "tui"
						? msg(CatalogMessageId.textguardReviewPending, { command: protectedCommand("/textguard") })
						: msg(CatalogMessageId.textguardReviewPendingNonInteractive, {
								command: protectedCommand("/textguard"),
							});
				notify(ctx, msg(CatalogMessageId.textguardReviewPendingSummary, { count: pending.length, advice }));
			}
		};
		pi.on("session_start", report);
		pi.on("agent_end", report);
		pi.registerCommand("textguard", {
			description: catalogText(catalog, CHROME_MESSAGE_ID.commandDescription),
			handler: async (args, ctx) => {
				context = ctx;
				runtime.setAlertListener(showAlert);
				const argument = args.trim().toLowerCase();
				const requested = MODE_ARGS[argument];
				if (argument && !requested && argument !== "reports") {
					notify(ctx, msg(CatalogMessageId.textguardCommandUsage));
					return;
				}
				if (requested) {
					if (!runtime.setMode(requested)) {
						notify(ctx, msg(CatalogMessageId.textguardModeAlreadySet, { mode: MODE_LABEL[requested] }), "info");
						return;
					}
					notify(ctx, modeText(requested), "info");
					publishState(ctx);
					try {
						await ctx.reload();
					} catch {
						notify(ctx, msg(CatalogMessageId.textguardReloadFailed));
					}
					return;
				}
				const dimensions = terminal();
				if (ctx.mode !== "tui" || !ctx.hasUI || dimensions.dumb) {
					notify(ctx, msg(CatalogMessageId.textguardReviewRequiresTerminal));
					return;
				}
				if (dimensions.columns < 48 || dimensions.rows < 24) {
					notify(ctx, msg(CatalogMessageId.textguardReviewRequiresSize));
					return;
				}
				const policy = runtime.forSession(ctx.sessionManager.getSessionId());
				if (!policy) {
					notify(ctx, msg(CatalogMessageId.textguardReviewUnavailable));
					return;
				}
				const open = (items: ReviewItem[], otherView: { count: number; hint: string }) =>
					ctx.ui.custom<ReviewOutcome>(
						(tui, theme, keybindings, done) =>
							createReviewComponent({
								tui,
								theme,
								keybindings,
								items,
								snapshotFor: (id) => policy.admission.snapshotFor(id),
								dismiss: (id) => policy.dismissReport(id),
								notices: policy.scanNotices().length,
								mode: policy.currentMode(),
								otherView,
								catalog,
								done,
							}),
						{
							overlay: true,
							overlayOptions: { width: "90%", minWidth: 48, maxHeight: "85%", anchor: "center", margin: 1 },
						},
					);
				const applyMode = async (mode: TextGuardMode) => {
					if (!runtime.setMode(mode)) return;
					notify(ctx, modeText(mode), "info");
					try {
						await ctx.reload();
					} catch {
						notify(ctx, msg(CatalogMessageId.textguardReloadFailed));
					}
				};
				if (policy.currentMode() === "off") {
					const offOutcome = await open([], { count: 0, hint: "" });
					if (offOutcome?.mode) await applyMode(offOutcome.mode);
					return;
				}
				const pending = policy.reviews();
				const pendingIds = new Set(pending.map((item) => item.id));
				const reports = policy.scanReports().filter((item) => !pendingIds.has(item.id));
				// The default view carries only what needs a decision. Findings that did not block
				// content remain available through the reports command.
				const decisions: ReviewItem[] = [
					...pending.map((review) => ({ review, withheld: true })),
					...reports.filter(blocking).map((review) => ({ review, withheld: false })),
				];
				const informational: ReviewItem[] = reports
					.filter((review) => !blocking(review))
					.map((review) => ({ review, withheld: false }));
				const reportsView = argument === "reports";
				const items = reportsView ? informational : decisions;
				const otherView = reportsView
					? {
							count: decisions.length,
							hint: catalogText(catalog, CatalogMessageId.textguardOtherViewDecisions, {
								command: protectedCommand("/textguard"),
							}),
						}
					: {
							count: informational.length,
							hint: catalogText(catalog, CatalogMessageId.textguardOtherViewReports, {
								command: protectedCommand("/textguard reports"),
							}),
						};
				if (!items.length) {
					if (reportsView) {
						notify(ctx, msg(CatalogMessageId.textguardReportsEmpty), "info");
						return;
					}
					const extra = informational.length
						? ` ${msg(CatalogMessageId.textguardReviewBlockedNothing, {
								count: informational.length,
								command: protectedCommand("/textguard reports"),
							})}`
						: "";
					notify(
						ctx,
						policy.scanNotices().length
							? msg(CatalogMessageId.textguardReviewIncomplete, { extra })
							: msg(CatalogMessageId.textguardReviewNothing, { extra }),
						"info",
					);
					return;
				}
				const outcome = await open(items, otherView);
				if (outcome?.mode) {
					await applyMode(outcome.mode);
					return;
				}
				if (!outcome?.approval) return;
				const finalDimensions = terminal();
				if (finalDimensions.dumb || finalDimensions.columns < 48 || finalDimensions.rows < 24) {
					notify(ctx, msg(CatalogMessageId.textguardTerminalResized));
					return;
				}
				if (!runtime.approve(policy, outcome.approval.id, outcome.approval.persist)) {
					notify(ctx, msg(CatalogMessageId.textguardReviewExpired));
					return;
				}
				notify(
					ctx,
					outcome.approval.persist
						? msg(CatalogMessageId.textguardApprovedPersisted)
						: msg(CatalogMessageId.textguardApprovedSession),
					"info",
				);
				try {
					await ctx.reload();
				} catch {
					notify(ctx, msg(CatalogMessageId.textguardApprovedReloadFailed));
				}
			},
		});
	};
}
