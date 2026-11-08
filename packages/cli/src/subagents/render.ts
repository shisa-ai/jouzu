import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { CatalogMessageId, catalogText, defaultCatalog } from "../cli-messages.js";
import type { CatalogBundle } from "../locale-catalog.js";
import { createSessionUiStyles } from "../session-ui/index.js";
import { fitTerminalText, sanitizeTerminalText } from "../terminal-layout.js";
import type { AgentRun } from "./manager.js";
import { agentModelDisplay, agentModelSelectorLabel } from "./model-display.js";
import { isSameModelSelector } from "./roles.js";
import { formatUsageCost } from "./usage.js";

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
	typeof value === "string" ? sanitizeTerminalText(value.slice(0, max).replace(/[\r\n\t]+/g, " ")) : "";
const number = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
/**
 * The display word for each internal run state. The state value is the key and
 * is a protected value; only the display word moves onto the catalog. A state
 * the table does not know is shown as-is, so an unknown internal value is never
 * silently relabeled.
 */
const STATUS_LABEL_IDS: Record<string, CatalogMessageId> = {
	queued: CatalogMessageId.subagentStatusQueued,
	starting: CatalogMessageId.subagentStatusStarting,
	running: CatalogMessageId.subagentStatusRunning,
	completed: CatalogMessageId.subagentStatusCompleted,
	failed: CatalogMessageId.subagentStatusFailed,
	cancelled: CatalogMessageId.subagentStatusCancelled,
	interrupted: CatalogMessageId.subagentStatusInterrupted,
};

export function subagentComponent(
	value: unknown,
	theme: Pick<Theme, "fg">,
	expanded = false,
	operation = "",
	catalog: CatalogBundle = defaultCatalog(),
) {
	return {
		invalidate() {},
		render(width: number): string[] {
			if (width <= 0) return [];
			const styles = createSessionUiStyles(theme);
			const muted = (s: string) => styles.apply("status.muted", s);
			const accent = (s: string) => styles.apply("status.accent", s);
			const msg = (id: CatalogMessageId, args?: Readonly<Record<string, string | number>>) =>
				catalogText(catalog, id, args);
			const statusLabel = (status: string): string | undefined => {
				const id = STATUS_LABEL_IDS[status];
				return id === undefined ? undefined : msg(id);
			};
			const label = (id: CatalogMessageId) => `${msg(id)} `;
			const lines: string[] = [];
			const add = (s: string) => lines.push(fitTerminalText(s, width));
			const detail = (prefix: string, raw: unknown, maxLines = 3) => {
				const content = text(raw);
				if (content) lines.push(...wrapTextWithAnsi(`${prefix}${content}`, width).slice(0, maxLines));
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
					const provider = text(model.provider, 1000);
					const modelId = text(model.id, 200);
					const modelLabel = agentModelDisplay({ provider, id: modelId, name: text(model.name, 200) }).label;
					add(
						`${styles.apply(color, statusLabel(status) ?? (status || msg(CatalogMessageId.subagentStatusUnknown)))} · ${accent(text(run.role, 100) || msg(CatalogMessageId.subagentRoleFallback))}`,
					);
					if (modelLabel) add(styles.apply("session.model", modelLabel));
					detail("", run.task, expanded ? 8 : 2);
					add(muted(msg(CatalogMessageId.subagentRunLabel, { id: text(run.id, expanded ? 256 : 8) })));
					if (run.cwd ?? run.workspace) {
						if (expanded) detail(label(CatalogMessageId.subagentWorkspaceLabel), run.cwd ?? run.workspace);
						else add(muted(`${label(CatalogMessageId.subagentWorkspaceLabel)}${text(run.cwd ?? run.workspace)}`));
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
						add(
							muted(
								msg(CatalogMessageId.subagentElapsed, {
									minutes: Math.floor(seconds / 60),
									seconds: seconds % 60,
								}),
							),
						);
					}
					detail("", run.reviewWarning, 8);
					detail("", run.outcome, expanded ? 12 : 3);
					if (expanded) {
						detail(label(CatalogMessageId.subagentModelIdLabel), `${text(model.provider, 500)}/${text(model.id, 500)}`);
						const usage = object(run.usage);
						const tokens = ["input", "output", "cacheRead", "cacheWrite"].flatMap((key) =>
							number(usage[key]) !== undefined && Number(usage[key]) > 0 ? [`${key}: ${usage[key]}`] : [],
						);
						if (tokens.length) detail(label(CatalogMessageId.subagentTokensLabel), tokens.join(" · "));
						const cost = formatUsageCost(usage, catalog);
						if (Object.keys(usage).length)
							add(
								muted(
									cost !== null
										? msg(CatalogMessageId.subagentCost, { amount: cost })
										: msg(CatalogMessageId.subagentCostUnknown),
								),
							);
						const review = object(run.review);
						if (Object.keys(review).length) {
							detail(label(CatalogMessageId.subagentCandidateIdentityLabel), review.status);
							detail(label(CatalogMessageId.subagentCandidateHeadLabel), object(review.candidate).head);
							add(muted(msg(CatalogMessageId.subagentIdentityStability)));
						}
					}
				}
				if (runs.length > (expanded ? 20 : 5))
					add(muted(msg(CatalogMessageId.subagentMoreRuns, { count: runs.length - (expanded ? 20 : 5) })));
				if (!runs.length) add(muted(msg(CatalogMessageId.subagentNoChildRuns)));
				if (number(root.nextOffset) !== undefined)
					add(muted(msg(CatalogMessageId.subagentNextOffset, { offset: String(root.nextOffset) })));
			} else if (Array.isArray(value) || Array.isArray(root.roles)) {
				const roles = (Array.isArray(value) ? value : root.roles) as unknown[];
				if (typeof root.enabled === "boolean")
					add(accent(msg(root.enabled ? CatalogMessageId.subagentEnabledOn : CatalogMessageId.subagentEnabledOff)));
				detail("", root.reason, 5);
				for (const raw of roles.slice(0, expanded ? 64 : 5)) {
					const role = object(raw);
					const selector = text(role.model, 500);
					const suppliedLabel = text(role.modelLabel, 200);
					// modelLabel is a display hint from the roles result. A same-selector
					// hint may have been precomputed in English; resolve it from the active
					// catalog so the visible row follows the rest of the localized view.
					const modelLabel =
						isSameModelSelector(selector) || !suppliedLabel
							? agentModelSelectorLabel(selector, [], catalog)
							: suppliedLabel;
					add(accent(`${text(role.id, 100)} · ${modelLabel}`));
					detail("", role.description, 2);
					if (expanded) {
						detail(label(CatalogMessageId.subagentModelIdLabel), role.model);
						detail(label(CatalogMessageId.subagentPlacementLabel), role.placement);
						detail(label(CatalogMessageId.subagentToolsLabel), Array.isArray(role.tools) ? role.tools.join(", ") : "");
					}
				}
				if (roles.length > 5 && !expanded)
					add(muted(msg(CatalogMessageId.subagentMoreRoles, { count: roles.length - 5 })));
			} else if (operation === "read" && typeof root.text === "string") {
				const records = root.text.split("\n").filter((line) => line.trim());
				const events = records.flatMap((line) => {
					try {
						const event = object(JSON.parse(line));
						return typeof event.type === "string" ? [event] : [];
					} catch {
						return [];
					}
				});
				const tools = new Map<string, number>();
				for (const event of events) {
					if (event.type === "activity" && typeof event.tool === "string")
						tools.set(event.tool, (tools.get(event.tool) ?? 0) + 1);
				}
				const terminal = object(root.terminal);
				const terminalStatus = text(terminal.status, 40);
				const heading = statusLabel(terminalStatus) ?? msg(CatalogMessageId.subagentOutputPage);
				add(
					accent(
						events.length
							? events.length === 1
								? msg(CatalogMessageId.subagentEventOnPage, { heading })
								: msg(CatalogMessageId.subagentEventsOnPage, { heading, count: events.length })
							: heading,
					),
				);
				if (terminal.summary) detail(label(CatalogMessageId.subagentResultLabel), terminal.summary, expanded ? 6 : 3);
				if (tools.size)
					detail(
						label(CatalogMessageId.subagentToolsLabel),
						[...tools].map(([tool, count]) => `${tool} × ${count}`).join(" · "),
						2,
					);
				const messages = events.filter(
					(event) =>
						(event.type === "result" || (event.type === "message" && event.role === "assistant")) && text(event.text),
				);
				if (expanded) {
					const visible = events.filter(
						(event) => event.type !== "usage" && !(event.type === "message" && !text(event.text)),
					);
					for (const event of visible.slice(-12)) {
						if (event.type === "message") {
							if (event.role === "assistant") detail(label(CatalogMessageId.subagentAssistantLabel), event.text, 3);
							else
								add(
									muted(
										msg(CatalogMessageId.subagentOutputReceived, {
											role: text(event.role, 100) || msg(CatalogMessageId.subagentMessageFallback),
										}),
									),
								);
						} else if (event.type === "result") {
							add(accent(statusLabel(text(event.status)) ?? msg(CatalogMessageId.subagentResult)));
							detail("", event.text, 4);
						} else if (event.type === "activity")
							add(muted(msg(CatalogMessageId.subagentToolLabel, { tool: text(event.tool, 100) })));
						else if (event.type === "ready") add(muted(msg(CatalogMessageId.subagentChildSessionReady)));
						else if (event.type === "control")
							add(muted(msg(CatalogMessageId.subagentMessageLabel, { status: text(event.status, 100) })));
						else if (event.type === "terminal")
							add(muted(statusLabel(text(event.status)) ?? msg(CatalogMessageId.subagentRunEnded)));
						else if (event.type === "task") detail(label(CatalogMessageId.subagentAssignmentLabel), event.text, 2);
						else if (event.type === "steer")
							add(muted(msg(CatalogMessageId.subagentMessageLabel, { status: text(event.status, 100) })));
						else add(muted(msg(CatalogMessageId.subagentEvent, { type: text(event.type, 100) })));
					}
					if (visible.length > 12)
						add(muted(msg(CatalogMessageId.subagentEarlierEvents, { count: visible.length - 12 })));
				} else {
					const latest = messages.at(-1);
					if (latest && !terminal.summary)
						detail(
							latest.type === "result"
								? `${statusLabel(text(latest.status)) ?? msg(CatalogMessageId.subagentResult)}: `
								: label(CatalogMessageId.subagentAssistantLabel),
							latest.text,
							3,
						);
				}
				if (records.length > events.length) {
					add(
						muted(
							root.totalBytes === 0
								? msg(CatalogMessageId.subagentNoOutputYet)
								: msg(CatalogMessageId.subagentPartialRecords),
						),
					);
				}
				if (number(root.nextOffset) !== undefined) {
					add(muted(msg(CatalogMessageId.subagentMoreOutput)));
					if (expanded) add(muted(msg(CatalogMessageId.subagentNextByteOffset, { offset: String(root.nextOffset) })));
				} else add(muted(msg(CatalogMessageId.subagentEndOfOutput)));
			} else if (operation === "steer") {
				add(accent(msg(CatalogMessageId.subagentMessageAccepted)));
				add(muted(msg(CatalogMessageId.subagentDeliveryUnconfirmed)));
				if (expanded) detail(label(CatalogMessageId.subagentReceiptLabel), root.receipt);
			} else if (operation === "stop")
				add(styles.apply("status.warning", msg(CatalogMessageId.subagentCancellationRequested)));
			else {
				const raw =
					typeof value === "string"
						? value
						: text(root.text) || JSON.stringify(value) || msg(CatalogMessageId.subagentNoResult);
				if (operation === "error") add(styles.apply("status.error", msg(CatalogMessageId.subagentOperationFailed)));
				else if (operation === "call") add(accent(text(raw)));
				if (operation !== "call") detail("", raw, expanded ? 30 : 5);
				if (number(root.nextOffset) !== undefined)
					add(muted(msg(CatalogMessageId.subagentNextByteOffset, { offset: String(root.nextOffset) })));
			}
			return lines.map((line) => fitTerminalText(line, width));
		},
	};
}

export function parseSubagentResult(content: unknown): unknown {
	if (!Array.isArray(content)) return undefined;
	const body = content
		.filter((part) => object(part).type === "text")
		.map((part) => (typeof object(part).text === "string" ? (object(part).text as string).slice(0, 64_000) : ""))
		.join("\n");
	try {
		return JSON.parse(body);
	} catch {
		return body;
	}
}
