import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type ContentReview, reviewLabel } from "./textguard-admission.js";
import type { TextGuardRuntime } from "./textguard-runtime.js";

const KEEP = "Keep withheld";
const ALLOW = "Allow this content for this session";

export function reviewSummary(review: ContentReview): string {
	const evidence = review.evidence;
	const counts = evidence.severityCounts;
	// The source is already escaped by admission. Escape again before terminal output,
	// including test/injected reviews, and never include scanned body text.
	const source = reviewLabel(review.source).slice(0, 40);
	return [
		"TextGuard review",
		`Source (escaped, shortened): ${source}`,
		`Content SHA-256: ${review.contentDigest}`,
		evidence.status === "unavailable"
			? `Check incomplete: ${reviewLabel(evidence.reason ?? "scanner")}`
			: `Findings: ${counts?.error ?? 0} error, ${counts?.warn ?? 0} warning, ${counts?.info ?? 0} information`,
		...evidence.findings
			.slice(0, 2)
			.map(
				(finding) =>
					`${reviewLabel(finding.kind).slice(0, 40)}; character index: ${finding.offset ?? "unknown"} (from 0)`,
			),
		"Scans do not prove safety; review the source.",
	].join("\n");
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
			if (pending.length || reports.length || notices.length)
				notify(
					ctx,
					`TextGuard: ${pending.length} pending reviews, ${reports.length} scan reports, ${notices.length} checks without an exact content identity. ${ctx.mode === "tui" ? "Use /textguard to review." : "Content stays withheld where approval is required. Review with /textguard in an interactive session."}`,
				);
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
				const action = await ctx.ui.select(reviewSummary(review), requiresApproval ? [KEEP, ALLOW] : ["Back"]);
				if (!requiresApproval || action !== ALLOW) return;
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
			},
		});
	};
}
