import type { ExtensionContext, ExtensionFactory, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatEffectiveKeybinding } from "./keybinding-hints.js";
import type { ScanEvidence, ScanFinding, UnavailableReason } from "./textguard.js";
import { type ContentReview, type ContentSnapshot, displayLabel, escapeInvisible } from "./textguard-admission.js";
import type { TextGuardRuntime } from "./textguard-runtime.js";

/** Native scans attach the offending code point; injected evidence may not. */
type ReviewFinding = ScanFinding & { codepoint?: string };

const ALLOW_SESSION = "Allow for this session";
const ALLOW_ALWAYS = "Always allow this exact content";
const DISMISS = "Dismiss report";
const BACK = "Back";

const REASON_TEXT: Record<UnavailableReason, string> = {
	"input-limit": "the content is larger than TextGuard can scan",
	"unsupported-content": "part of the content is something the scanner cannot check, such as an image",
	"finding-limit": "there were too many findings to report completely",
	"decode-limit": "the content has too many encoded layers to decode completely",
	"output-limit": "the scanner produced too much output",
	scanner: "the scanner could not run",
	timeout: "the scan ran out of time",
	process: "the scanner stopped unexpectedly",
	version: "the installed scanner version is not supported",
	protocol: "the scanner returned an unreadable result",
	busy: "the scanner was busy with other work",
	closed: "the review session ended",
	file: "the content could not be read",
	budget: "the time reserved for scanning ran out",
};

/** A human name and one-sentence explanation for each finding kind the scanner reports. */
const KIND_TEXT: Record<string, [name: string, explanation: string]> = {
	bidi_control: [
		"bidi control character",
		"This character can reverse the order in which text is displayed, so what you read can differ from what is processed.",
	],
	ansi_escape: ["terminal escape sequence", "This sequence can change terminal colors or hide text on screen."],
	invisible_char: ["invisible character", "This character changes the text without appearing on screen."],
	combining_abuse: ["stacked combining marks", "Stacked accent characters can disguise what a letter really is."],
	soft_hyphen: ["soft hyphen", "This invisible character can split words to evade exact matching."],
	tag_character: ["Unicode tag character", "Tag characters can hide extra text inside ordinary-looking content."],
	variation_selector: [
		"variation selector",
		"This invisible character can change how the character next to it renders.",
	],
	split_token: [
		"split keyword",
		'A protected keyword such as "system" or "instructions" appears split by separator characters, a common way to hide prompt injection.',
	],
	decoded: ["encoded text", "Part of the content was stored in an encoded form and was decoded before scanning."],
	normalized: ["normalization change", "Part of the content was rewritten during normalization before scanning."],
	stripped: ["removed characters", "Part of the content was removed during normalization before scanning."],
};

const SEVERITY_LABEL = {
	error: "Error (blocks this content)",
	warn: "Warning",
	info: "Information",
} as const;

/** Human location for a finding offset, measured in the exact scanned text when it is retained. */
function location(finding: ReviewFinding, body?: string): string {
	const offset = finding.offset;
	if (offset === null) return "";
	if (typeof body !== "string" || offset > body.length) return `character ${offset} of the content, counting from 0`;
	const before = body.slice(0, offset);
	const line = (before.match(/\n/g) ?? []).length + 1;
	const column = offset - (before.lastIndexOf("\n") + 1) + 1;
	return `line ${line}, column ${column}`;
}

function describeFinding(finding: ReviewFinding, body?: string): string[] {
	let entry = KIND_TEXT[finding.kind];
	if (!entry && finding.kind.startsWith("yara:"))
		entry = [
			`bundled detection rule (${escapeInvisible(finding.kind.slice(5))}) match`,
			"A bundled detection rule matched a pattern associated with attacks; the rule does not know whether this content is malicious.",
		];
	if (!entry)
		entry = [`flagged pattern ${displayLabel(finding.kind)}`, "The scanner matched a pattern it considers suspicious."];
	const [name, explanation] = entry;
	const where = location(finding, body);
	return [
		`${SEVERITY_LABEL[finding.severity]}: ${name}${finding.codepoint ? ` ${finding.codepoint}` : ""}${where ? ` at ${where}` : ""}.`,
		explanation,
	];
}

function countsLine(evidence: ScanEvidence): string {
	const counts = evidence.severityCounts ?? { info: 0, warn: 0, error: 0 };
	const errors = counts.error ?? 0;
	const warnings = counts.warn ?? 0;
	const notes = counts.info ?? 0;
	const nonBlocking = [
		warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "",
		notes ? `${notes} informational finding${notes === 1 ? "" : "s"}` : "",
	].filter(Boolean);
	const blocking =
		errors > 0
			? `${errors} error${errors === 1 ? "" : "s"} that block${errors === 1 ? "s" : ""} this content until you approve it`
			: "No errors";
	return nonBlocking.length ? `${blocking}; ${nonBlocking.join(" and ")} do not block it.` : `${blocking}.`;
}

function evidenceLines(review: ContentReview, body?: string): string[] {
	const evidence = review.evidence;
	if (evidence.status === "unavailable") {
		const reason = REASON_TEXT[evidence.reason ?? "scanner"];
		return [`The check did not finish: ${reason}.`, "This content stays withheld unless you approve it."];
	}
	const lines = [countsLine(evidence)];
	for (const finding of evidence.findings) lines.push(...describeFinding(finding, body));
	if (evidence.findingCount !== undefined && evidence.findingCount > evidence.findings.length)
		lines.push(`Showing the first ${evidence.findings.length} of ${evidence.findingCount} findings.`);
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
export function reviewLines(review: ContentReview, snapshot?: ContentSnapshot): string[] {
	const body = snapshot?.body;
	const lines = [
		`Source: ${snapshot ? displayLabel(snapshot.source) : review.displaySource}`,
		`Content fingerprint (SHA-256): ${review.contentDigest}`,
		"",
		...evidenceLines(review, body),
		"",
	];
	if (body === undefined) lines.push("The flagged content itself is not retained for viewing here.");
	else
		lines.push(
			"Flagged content (controls and invisible characters shown as escapes):",
			...displayContent(body).split("\n"),
		);
	lines.push("", "Scans reduce risk but cannot prove content is safe. You decide whether to allow it.");
	return lines;
}

interface ReviewItem {
	review: ContentReview;
	withheld: boolean;
}

export interface ReviewOutcome {
	approval?: { id: string; persist: boolean };
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
}

/**
 * The /textguard overlay: a scrollable review view with the findings, the
 * escaped content, and the decision actions on one screen. All keys resolve
 * through the keybinding manager; cancellation returns to the list instead of
 * discarding the session's review state.
 */
export function createReviewComponent(deps: ReviewComponentDeps): Component {
	const { theme, keybindings } = deps;
	const items = [...deps.items];
	const outcome: ReviewOutcome = {};
	let state: "list" | "detail" = "list";
	let selected = 0;
	let listScroll = 0;
	let actionIndex = 0;
	let bodyScroll = 0;
	let detailLines: string[] = [];
	let wrapCache: { width: number; lines: string[] } | undefined;

	const hint = (action: Parameters<typeof formatEffectiveKeybinding>[1]) =>
		formatEffectiveKeybinding(keybindings, action);
	const actions = (item: ReviewItem): string[] =>
		item.withheld ? [ALLOW_SESSION, ALLOW_ALWAYS, BACK] : [DISMISS, BACK];

	const wrapDetail = (width: number): string[] => {
		if (wrapCache?.width === width) return wrapCache.lines;
		const lines = detailLines.flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, width)));
		wrapCache = { width, lines };
		return lines;
	};

	const enterDetail = () => {
		const item = items[selected];
		if (!item) return;
		detailLines = reviewLines(item.review, deps.snapshotFor(item.review.id));
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
		if (action === ALLOW_SESSION || action === ALLOW_ALWAYS) {
			outcome.approval = { id: item.review.id, persist: action === ALLOW_ALWAYS };
			deps.done(outcome);
			return;
		}
		if (action === DISMISS) {
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

	const renderList = (width: number, height: number): string[] => {
		const withheld = items.filter((item) => item.withheld).length;
		const header = theme.bold(theme.fg("accent", "TextGuard review"));
		const summary = theme.fg(
			"dim",
			` ${withheld} withheld, ${items.length - withheld} report${items.length - withheld === 1 ? "" : "s"}`,
		);
		const lines = [truncateToWidth(`${header}${summary}`, width, ""), ""];
		const hints =
			`${hint("tui.select.up")}/${hint("tui.select.down")} select · ` +
			`${hint("tui.select.confirm")} open · ${hint("tui.select.cancel")} close`;
		const footer: string[] = [];
		if (deps.notices > 0)
			footer.push(
				...wrapTextWithAnsi(
					theme.fg(
						"dim",
						`${deps.notices} check${deps.notices === 1 ? "" : "s"} could not identify the complete content; that content cannot be approved.`,
					),
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
			const status = item.withheld ? theme.fg("warning", "Withheld") : theme.fg("dim", "Report  ");
			const label = item.review.displaySource;
			lines.push(truncateToWidth(`${current ? theme.fg("accent", "> ") : "  "}${status} ${label}`, width, "…"));
		}
		if (items.length > budget) lines.push(theme.fg("dim", `  (${selected + 1}/${items.length})`));
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
			theme.fg("accent", item.withheld ? "TextGuard review — withheld content" : "TextGuard review — scan report"),
		);
		const itemActions = actions(item);
		const hints =
			`${hint("tui.select.up")}/${hint("tui.select.down")} action · ` +
			`${hint("tui.select.pageUp")}/${hint("tui.select.pageDown")} scroll · ` +
			`${hint("tui.select.confirm")} select · ${hint("tui.select.cancel")} back`;
		const actionLines = itemActions.map((action, index) =>
			truncateToWidth(index === actionIndex ? theme.fg("accent", `> ${action}`) : `  ${action}`, width, "…"),
		);
		const chrome = 1 + 1 + actionLines.length + 1 + 1;
		const budget = Math.max(1, height - chrome);
		const body = wrapDetail(width);
		bodyScroll = Math.max(0, Math.min(bodyScroll, Math.max(0, body.length - budget)));
		const window = body.slice(bodyScroll, bodyScroll + budget);
		const lines = [truncateToWidth(header, width, ""), ...window];
		if (body.length > budget)
			lines.push(
				theme.fg("dim", `  (lines ${bodyScroll + 1}-${Math.min(bodyScroll + budget, body.length)} of ${body.length})`),
			);
		lines.push("", ...actionLines, "", theme.fg("dim", truncateToWidth(hints, width, "…")));
		return lines;
	};

	return {
		render(width: number): string[] {
			const columns = Math.max(12, width - 2);
			const rows = Number(deps.tui.terminal?.rows ?? 24);
			const height = Math.max(8, Math.min(rows - 6, 44));
			const inner = state === "list" ? renderList(columns, height) : renderDetail(columns, height);
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

export function createTextGuardReviewExtension(
	runtime: TextGuardRuntime,
	options: {
		writeDiagnostic?: (text: string) => void;
		terminal?: () => { columns: number; rows: number; dumb: boolean };
	} = {},
): ExtensionFactory {
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
		const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "warning") => {
			if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.notify(message, type);
			else writeDiagnostic(message);
		};
		const report = (_event: unknown, ctx: ExtensionContext) => {
			const policy = runtime.forSession(ctx.sessionManager.getSessionId());
			if (!policy) return;
			const pending = policy.reviews();
			const identity = JSON.stringify([ctx.sessionManager.getSessionId(), pending.map((item) => item.id)]);
			if (identity === lastNotice) return;
			lastNotice = identity;
			// Only content-blocking items notify. Non-blocking reports and identity-limited
			// checks stay inspectable through /textguard without interrupting the session.
			if (pending.length) {
				const noun = pending.length === 1 ? "item" : "items";
				notify(
					ctx,
					`TextGuard: ${pending.length} ${noun} waiting for your review. ${ctx.mode === "tui" ? "Use /textguard to review." : "Content stays withheld. Review with /textguard in an interactive session."}`,
				);
			}
		};
		pi.on("session_start", report);
		pi.on("agent_end", report);
		pi.registerCommand("textguard", {
			description: "Review TextGuard findings and withheld content",
			handler: async (args, ctx) => {
				if (args.trim()) {
					notify(ctx, "Use /textguard without arguments. Approval requires an interactive confirmation.");
					return;
				}
				const dimensions = terminal();
				if (ctx.mode !== "tui" || !ctx.hasUI || dimensions.dumb) {
					notify(ctx, "TextGuard approval requires an interactive terminal. Content stays withheld.");
					return;
				}
				if (dimensions.columns < 48 || dimensions.rows < 24) {
					notify(
						ctx,
						"TextGuard review requires at least 48 columns and 24 rows. Resize the terminal and retry /textguard.",
					);
					return;
				}
				const policy = runtime.forSession(ctx.sessionManager.getSessionId());
				if (!policy) {
					notify(ctx, "TextGuard review is unavailable for this session. Content stays withheld.");
					return;
				}
				const pending = policy.reviews();
				const pendingIds = new Set(pending.map((item) => item.id));
				const items: ReviewItem[] = [
					...pending.map((review) => ({ review, withheld: true })),
					...policy
						.scanReports()
						.filter((item) => !pendingIds.has(item.id))
						.map((review) => ({ review, withheld: false })),
				];
				if (!items.length) {
					notify(
						ctx,
						policy.scanNotices().length
							? "TextGuard could not identify the complete content. Retry the request; this content cannot be approved."
							: "TextGuard has no findings to review.",
					);
					return;
				}
				const outcome = await ctx.ui.custom<ReviewOutcome>(
					(tui, theme, keybindings, done) =>
						createReviewComponent({
							tui,
							theme,
							keybindings,
							items,
							snapshotFor: (id) => policy.admission.snapshotFor(id),
							dismiss: (id) => policy.dismissReport(id),
							notices: policy.scanNotices().length,
							done,
						}),
					{
						overlay: true,
						overlayOptions: { width: "90%", minWidth: 48, maxHeight: "85%", anchor: "center", margin: 1 },
					},
				);
				if (!outcome?.approval) return;
				const finalDimensions = terminal();
				if (finalDimensions.dumb || finalDimensions.columns < 48 || finalDimensions.rows < 24) {
					notify(ctx, "Terminal size changed. Content stays withheld; resize and retry /textguard.");
					return;
				}
				if (!runtime.approve(policy, outcome.approval.id, outcome.approval.persist)) {
					notify(ctx, "This TextGuard review expired. Run /textguard again.");
					return;
				}
				notify(
					ctx,
					outcome.approval.persist
						? "Content approved. Future sessions admit these exact bytes; any change requires a new review. Resources will reload."
						: "Content approved for this session. Retry the request after resources reload.",
					"info",
				);
				try {
					await ctx.reload();
				} catch {
					notify(ctx, "Content approved, but resources could not reload. Run /reload before retrying.");
				}
			},
		});
	};
}
