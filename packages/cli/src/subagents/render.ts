import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createSessionUiStyles } from "../session-ui/index.js";
import { fitTerminalText, sanitizeTerminalText } from "../terminal-layout.js";
import type { AgentRun } from "./manager.js";

export function runPresentation(run: AgentRun) {
	return {
		id: run.id,
		role: run.role.id,
		model: run.model,
		status: run.status,
		task: run.task.slice(0, 2000),
		outcome: run.result?.slice(0, 4000),
		cwd: run.cwd,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		usage: run.usage,
		review: run.review,
	};
}

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
const text = (value: unknown, max = 2000) =>
	typeof value === "string" ? sanitizeTerminalText(value.slice(0, max)) : "";
const number = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const labels: Record<string, string> = {
	queued: "Queued",
	starting: "Starting",
	running: "Running",
	completed: "Completed",
	failed: "Failed",
	cancelled: "Cancelled",
	interrupted: "Interrupted",
};

export function subagentComponent(value: unknown, theme: Pick<Theme, "fg">, expanded = false, operation = "") {
	return {
		invalidate() {},
		render(width: number): string[] {
			if (width <= 0) return [];
			const styles = createSessionUiStyles(theme);
			const muted = (s: string) => styles.apply("status.muted", s);
			const accent = (s: string) => styles.apply("status.accent", s);
			const lines: string[] = [];
			const add = (s: string) => lines.push(fitTerminalText(s, width));
			const detail = (label: string, raw: unknown, maxLines = 3) => {
				const content = text(raw);
				if (content) lines.push(...wrapTextWithAnsi(`${label}${content}`, width).slice(0, maxLines));
			};
			const root = object(value);
			const runs = Array.isArray(root.runs) ? root.runs : root.role && root.id ? [root] : undefined;
			if (runs) {
				detail("", root.summary, 8);
				if (root.omitted) detail("", root.retrieval, 8);
				for (const raw of runs.slice(0, expanded ? 20 : 5)) {
					const run = object(raw);
					const status = text(run.status, 40);
					const color =
						status === "failed"
							? "status.error"
							: status === "cancelled" || status === "interrupted"
								? "status.warning"
								: status === "completed"
									? "status.success"
									: "status.accent";
					const model = object(run.model);
					const provider = text(model.provider, 100);
					const modelId = text(model.id, 200);
					const modelLabel = modelId.startsWith(`${provider}/`)
						? modelId
						: [provider, modelId].filter(Boolean).join("/");
					add(
						`${styles.apply(color, labels[status] ?? (status || "Unknown"))} · ${accent(text(run.role, 100) || "Agent")}`,
					);
					if (modelLabel) add(styles.apply("session.model", modelLabel));
					detail("", run.task, expanded ? 8 : 2);
					add(muted(`Run ${text(run.id, expanded ? 256 : 8)}`));
					if (run.cwd ?? run.workspace) {
						if (expanded) detail("Workspace: ", run.cwd ?? run.workspace);
						else add(muted(`Workspace: ${text(run.cwd ?? run.workspace)}`));
					}
					const start = Date.parse(text(run.createdAt));
					const end = Date.parse(text(run.updatedAt));
					if (
						["completed", "failed", "cancelled", "interrupted"].includes(status) &&
						Number.isFinite(start) &&
						Number.isFinite(end) &&
						end >= start
					) {
						const seconds = Math.floor((end - start) / 1000);
						add(muted(`Elapsed ${Math.floor(seconds / 60)}m ${seconds % 60}s (including queue)`));
					}
					detail("", run.reviewWarning, 8);
					detail("", run.outcome, expanded ? 12 : 3);
					if (expanded) {
						const usage = object(run.usage);
						const tokens = ["input", "output", "cacheRead", "cacheWrite"].flatMap((key) =>
							number(usage[key]) !== undefined && Number(usage[key]) > 0 ? [`${key}: ${usage[key]}`] : [],
						);
						if (tokens.length) detail("Tokens: ", tokens.join(" · "));
						if (Object.keys(usage).length)
							add(
								muted(
									usage.costComplete === true && number(usage.cost) !== undefined
										? `Cost: $${Number(usage.cost).toFixed(4)}`
										: "Cost: unknown",
								),
							);
						const review = object(run.review);
						if (Object.keys(review).length) {
							detail("Candidate identity: ", review.status);
							detail("Candidate HEAD: ", object(review.candidate).head);
							add(muted("Identity stability is not review approval."));
						}
					}
				}
				if (runs.length > (expanded ? 20 : 5))
					add(muted(`${runs.length - (expanded ? 20 : 5)} more runs; expand or use list`));
				if (!runs.length) add(muted("No child runs."));
				if (number(root.nextOffset) !== undefined) add(muted(`Next offset: ${root.nextOffset}`));
			} else if (Array.isArray(value)) {
				for (const raw of value.slice(0, expanded ? 64 : 5)) {
					const role = object(raw);
					add(accent(`${text(role.id, 100)} · ${text(role.model, 200)}`));
					detail("", role.description, 2);
					if (expanded) {
						detail("Placement: ", role.placement);
						detail("Tools: ", Array.isArray(role.tools) ? role.tools.join(", ") : "");
					}
				}
				if (value.length > 5 && !expanded) add(muted(`${value.length - 5} more roles; expand to view`));
			} else if (operation === "steer") {
				add(accent("Message accepted by controller"));
				add(muted("Delivery to the child is not yet confirmed."));
				if (expanded) detail("Receipt: ", root.receipt);
			} else if (operation === "stop") add(styles.apply("status.warning", "Child cancellation requested"));
			else {
				const raw = typeof value === "string" ? value : text(root.text) || JSON.stringify(value) || "No result";
				if (operation === "error") add(styles.apply("status.error", "Subagent operation failed"));
				else if (operation === "call") add(accent(text(raw)));
				if (operation !== "call") detail("", raw, expanded ? 30 : 5);
				if (number(root.nextOffset) !== undefined) add(muted(`Next byte offset: ${root.nextOffset}`));
			}
			return lines.map((line) => fitTerminalText(line, width));
		},
	};
}

export function parseSubagentResult(content: unknown): unknown {
	if (!Array.isArray(content)) return "No result";
	const body = content
		.filter((part) => object(part).type === "text")
		.map((part) => text(object(part).text, 64_000))
		.join("\n");
	try {
		return JSON.parse(body);
	} catch {
		return body;
	}
}
