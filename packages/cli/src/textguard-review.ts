import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ScanEvidence, ScanFinding, UnavailableReason } from "./textguard.js";
import { type ContentReview, type ContentSnapshot, displayLabel, escapeInvisible } from "./textguard-admission.js";
import type { TextGuardRuntime } from "./textguard-runtime.js";

/** Native scans attach the offending code point; injected evidence may not. */
type ReviewFinding = ScanFinding & { codepoint?: string };

const KEEP = "Keep withheld";
const ALLOW = "Allow this content for this session";
const VIEW = "View flagged content";
const MORE = "More details";
const NEXT = "Next part";
const BACK = "Back";

// 48-column terminals render selector text at 46 columns after padding.
const WRAP_COLUMNS = 46;
// The inherited selector spends 6 rows on chrome plus one row per choice.
const SUMMARY_LINES = 10;
const CONTENT_LINES = 9;

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
		'A protected keyword such as "system" or "instructions" appears split by invisible characters, a common way to hide prompt injection.',
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

/** Wrap a label at the selector width and return the rendered lines. */
function wrap(text: string): string[] {
	return wrapTextWithAnsi(text, WRAP_COLUMNS);
}

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
	const head = `${SEVERITY_LABEL[finding.severity]}: ${name}${finding.codepoint ? ` ${finding.codepoint}` : ""}${where ? ` at ${where}` : ""}.`;
	return [...wrap(head), ...wrap(explanation)];
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
		return [
			...wrap(`The check did not finish: ${reason}.`),
			...wrap("This content stays withheld unless you approve it."),
		];
	}
	const lines = wrap(countsLine(evidence));
	for (const finding of evidence.findings) lines.push(...describeFinding(finding, body));
	if (evidence.findingCount !== undefined && evidence.findingCount > evidence.findings.length)
		lines.push(...wrap(`Showing the first ${evidence.findings.length} of ${evidence.findingCount} findings.`));
	return lines;
}

/**
 * Readable review pages: the complete source label (never double-escaped or cut
 * short), the exact fingerprint, findings with explanations and locations, and
 * the honest limitation when the content itself was not retained.
 */
export function summaryPages(review: ContentReview, snapshot?: ContentSnapshot): string[] {
	const body = snapshot?.body;
	const content = [
		...wrap(`Source: ${snapshot ? displayLabel(snapshot.source) : review.source}`),
		...wrap(`Content fingerprint (SHA-256): ${review.contentDigest}`),
		...evidenceLines(review, body),
		...(body === undefined ? wrap("The flagged content itself is not retained for viewing here.") : []),
		...wrap("Scans reduce risk but cannot prove content is safe. You decide whether to allow it."),
	];
	const pages: string[] = [];
	for (let start = 0; start < content.length || pages.length === 0; start += SUMMARY_LINES - 1) {
		const slice = content.slice(start, start + SUMMARY_LINES - 1);
		const header = pages.length === 0 ? "TextGuard review" : `TextGuard review (continued, part ${pages.length + 1})`;
		pages.push([header, ...slice].join("\n"));
		if (slice.length === 0) break;
	}
	return pages;
}

/** Escape scanned content for display: controls and invisible characters become visible escapes. */
function displayContent(text: string): string {
	return text
		.split("\n")
		.map((line) => escapeInvisible(JSON.stringify(line).slice(1, -1)))
		.join("\n");
}

/** Bounded viewer pages, each titled with the exact fingerprint of the reviewed content. */
export function contentPages(contentDigest: string, body: string): string[] {
	const lines = wrap(displayContent(body));
	const parts = chunk(lines.some((line) => line !== "") ? lines : ["(the content is empty)"], CONTENT_LINES);
	return parts.map((part, index) =>
		[
			`Flagged content, part ${index + 1} of ${parts.length}`,
			...wrap(`Content fingerprint (SHA-256): ${contentDigest}`),
			"",
			...part,
		].join("\n"),
	);
}

export function summaryChoices(
	snapshot: ContentSnapshot | undefined,
	requiresApproval: boolean,
	pageCount: number,
): string[] {
	const choices = [];
	if (snapshot?.body !== undefined) choices.push(VIEW);
	if (requiresApproval) choices.push(KEEP, ALLOW);
	if (pageCount > 1) choices.push(MORE);
	choices.push(BACK);
	return choices;
}

function chunk<T>(items: T[], size: number): T[][] {
	const groups: T[][] = [];
	for (let start = 0; start < items.length; start += size) groups.push(items.slice(start, start + size));
	return groups;
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
		const notify = (ctx: ExtensionContext, message: string) => {
			if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.notify(message, "warning");
			else writeDiagnostic(message);
		};
		const report = (_event: unknown, ctx: ExtensionContext) => {
			const policy = runtime.forSession(ctx.sessionManager.getSessionId());
			if (!policy) return;
			const pending = policy.reviews();
			const reports = policy.scanReports();
			const notices = policy.scanNotices();
			const identity = JSON.stringify([
				ctx.sessionManager.getSessionId(),
				pending.map((item) => item.id),
				reports.map((item) => item.id),
				notices,
			]);
			if (identity === lastNotice) return;
			lastNotice = identity;
			if (pending.length || reports.length || notices.length) {
				const item = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
				notify(
					ctx,
					`TextGuard: ${item(pending.length, "item")} waiting for your review, ${item(reports.length, "scan report")}, and ${item(notices.length, "check")} without an exact content identity. ${ctx.mode === "tui" ? "Use /textguard to review." : "Content stays withheld where approval is required. Review with /textguard in an interactive session."}`,
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
				const reviews = [...pending, ...policy.scanReports().filter((item) => !pendingIds.has(item.id))];
				if (!reviews.length) {
					notify(
						ctx,
						policy.scanNotices().length
							? "TextGuard could not identify the complete content. Retry the request; this content cannot be approved."
							: "TextGuard has no findings to review.",
					);
					return;
				}
				const choices = reviews.map(
					(item, index) =>
						`${index + 1}. ${pendingIds.has(item.id) ? "Withheld" : "Scan report"} ${item.id.slice(0, 12)}`,
				);
				while (true) {
					let page = 0;
					let index = -1;
					while (index < 0) {
						const items = choices.slice(page * 6, page * 6 + 6);
						if (page > 0) items.push("Previous page");
						if ((page + 1) * 6 < choices.length) items.push("Next page");
						const selected = await ctx.ui.select(`TextGuard findings (page ${page + 1})`, items);
						if (selected === "Next page" && items.includes(selected)) {
							page++;
							continue;
						}
						if (selected === "Previous page" && items.includes(selected)) {
							page--;
							continue;
						}
						index = selected !== undefined && items.includes(selected) ? choices.indexOf(selected) : -1;
						if (index < 0) return;
					}
					const review = reviews[index];
					const requiresApproval = pendingIds.has(review.id);
					const snapshot = policy.contentSnapshot(review);
					const pages = summaryPages(review, snapshot);
					let detail = 0;
					while (true) {
						const action = await ctx.ui.select(pages[detail], summaryChoices(snapshot, requiresApproval, pages.length));
						if (action === MORE) {
							detail = Math.min(detail + 1, pages.length - 1);
							continue;
						}
						if (action === BACK) break;
						if (action === ALLOW && requiresApproval) {
							const finalDimensions = terminal();
							if (finalDimensions.dumb || finalDimensions.columns < 48 || finalDimensions.rows < 24) {
								notify(ctx, "Terminal size changed. Content stays withheld; resize and retry /textguard.");
								return;
							}
							if (!runtime.approve(policy, review.id)) {
								notify(ctx, "This TextGuard review expired. Run /textguard again.");
								return;
							}
							ctx.ui.notify("Content approved for this session. Retry the request after resources reload.", "info");
							try {
								await ctx.reload();
							} catch {
								notify(ctx, "Content approved, but resources could not reload. Run /reload before retrying.");
							}
							return;
						}
						// Viewing the content ends the command; Keep withheld and cancellation leave it withheld.
						if (action === VIEW && snapshot?.body !== undefined) {
							const parts = contentPages(review.contentDigest, snapshot.body);
							for (let part = 0; part < parts.length; part++) {
								const partChoices = part + 1 < parts.length ? [NEXT, BACK] : [BACK];
								if ((await ctx.ui.select(parts[part], partChoices)) !== NEXT) break;
							}
						}
						return;
					}
				}
			},
		});
	};
}
