import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { SessionUiSemanticRole } from "./contracts.js";
import type { SessionStatusController } from "./controller.js";
import { fitTerminalText, padTerminalText, sanitizeTerminalText, terminalTextWidth } from "./layout.js";
import type { SessionStatusSnapshot } from "./snapshot.js";

export interface StatusBarSegment {
	id: string;
	side: "left" | "right";
	order: number;
	priority: number;
	role: SessionUiSemanticRole;
	value: string;
	compactValue?: string;
	required?: boolean;
}

type PreparedSegment = StatusBarSegment & {
	value: string;
	compactValue?: string;
	compact: boolean;
	removed: boolean;
};

function compactCount(value: number): string {
	if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;
	if (value >= 10_000) return `${Math.round(value / 1000)}k`;
	if (value >= 1000) return `${Math.round(value / 100) / 10}k`;
	return String(value);
}

function gitFlags(snapshot: SessionStatusSnapshot): string {
	const git = snapshot.git.value;
	if (!git) return "";
	const states = [
		git.conflicted > 0 ? "=" : "",
		git.stashed > 0 ? "$" : "",
		git.deleted > 0 ? "✘" : "",
		git.renamed > 0 ? "»" : "",
		git.modified > 0 ? "!" : "",
		git.typeChanged > 0 ? "T" : "",
		git.staged > 0 ? "+" : "",
		git.untracked > 0 ? "?" : "",
	].join("");
	const relation = git.ahead > 0 && git.behind > 0 ? "⇕" : git.ahead > 0 ? "↑" : git.behind > 0 ? "↓" : "";
	return `${states}${relation}`;
}

export function buildStatusBarSegments(snapshot: SessionStatusSnapshot): StatusBarSegment[] {
	const segments: StatusBarSegment[] = [];
	if (snapshot.git.status === "error" || snapshot.runtime.status === "error") {
		segments.push({
			id: "health",
			side: "left",
			order: 0,
			priority: 1000,
			role: "error",
			value: "! status",
			compactValue: "!",
			required: true,
		});
	}
	segments.push({
		id: "workspace",
		side: "left",
		order: 10,
		priority: 700,
		role: "text",
		value: snapshot.workspace.label,
	});
	if (snapshot.git.value) {
		const flags = gitFlags(snapshot);
		const branch = sanitizeTerminalText(snapshot.git.value.branch ?? "detached");
		segments.push({
			id: "git",
			side: "left",
			order: 20,
			priority: 650,
			role: snapshot.git.value.dirty ? "warning" : "muted",
			value: `${branch}${flags ? ` [${flags}]` : ""}`,
			compactValue: flags ? `[${flags}]` : branch,
		});
	}
	if (snapshot.runtime.value) {
		segments.push({
			id: "runtime",
			side: "left",
			order: 30,
			priority: 300,
			role: "muted",
			value: `${snapshot.runtime.value.id}${snapshot.runtime.value.version ? ` ${snapshot.runtime.value.version}` : ""}`,
			compactValue: snapshot.runtime.value.id,
		});
	}
	const context = snapshot.context.value;
	const percent = context?.percent;
	segments.push({
		id: "context",
		side: "right",
		order: 10,
		priority: 900,
		role:
			percent !== undefined && percent >= 90 ? "error" : percent !== undefined && percent >= 70 ? "warning" : "muted",
		value: context ? `${percent === undefined ? "?" : Math.round(percent)}%/${compactCount(context.window)}` : "ctx ?",
		compactValue: context ? `${percent === undefined ? "?" : Math.round(percent)}%` : "?",
		required: true,
	});
	if (snapshot.usage.value) {
		const usage = snapshot.usage.value;
		const unknown = usage.unknownMessageCount > 0 ? " ?" : "";
		segments.push({
			id: "tokens",
			side: "right",
			order: 20,
			priority: 500,
			role: snapshot.usage.status === "partial" ? "warning" : "muted",
			value: `↑${compactCount(usage.inputTokens)} ↓${compactCount(usage.outputTokens)}${unknown}`,
			compactValue: `↑${compactCount(usage.inputTokens)}${unknown}`,
		});
	}
	return segments;
}

function preparedWidth(segments: readonly PreparedSegment[], separator: string): number {
	const active = segments.filter((segment) => !segment.removed);
	return active.reduce((total, segment, index) => {
		const value = segment.compact ? (segment.compactValue ?? segment.value) : segment.value;
		return total + terminalTextWidth(value) + (index > 0 ? terminalTextWidth(separator) : 0);
	}, 0);
}

export function renderStatusBarSegments(
	segments: readonly StatusBarSegment[],
	width: number,
	theme: Pick<Theme, "fg">,
): string {
	if (width <= 0) return "";
	const prepared: PreparedSegment[] = segments.map((segment) => ({
		...segment,
		value: sanitizeTerminalText(segment.value),
		...(segment.compactValue ? { compactValue: sanitizeTerminalText(segment.compactValue) } : {}),
		compact: false,
		removed: false,
	}));
	const leftSeparator = " · ";
	const rightSeparator = " | ";
	const totalWidth = () => {
		const left = preparedWidth(
			prepared.filter((segment) => segment.side === "left"),
			leftSeparator,
		);
		const right = preparedWidth(
			prepared.filter((segment) => segment.side === "right"),
			rightSeparator,
		);
		return left + right + (left > 0 && right > 0 ? 1 : 0);
	};
	while (totalWidth() > width) {
		const compactable = prepared
			.filter(
				(segment) =>
					!segment.removed &&
					!segment.compact &&
					segment.compactValue !== undefined &&
					terminalTextWidth(segment.compactValue) < terminalTextWidth(segment.value),
			)
			.sort((left, right) => left.priority - right.priority)[0];
		if (compactable) {
			compactable.compact = true;
			continue;
		}
		const removable = prepared
			.filter((segment) => !segment.removed && !segment.required)
			.sort((left, right) => left.priority - right.priority)[0];
		if (removable) {
			removable.removed = true;
			continue;
		}
		break;
	}
	if (totalWidth() > width) {
		const protectedSegment = prepared
			.filter((segment) => !segment.removed && segment.required)
			.sort((left, right) => right.priority - left.priority)[0];
		if (!protectedSegment) return " ".repeat(width);
		const value = protectedSegment.compact
			? (protectedSegment.compactValue ?? protectedSegment.value)
			: protectedSegment.value;
		const styled = theme.fg(protectedSegment.role, fitTerminalText(value, width));
		return padTerminalText(styled, width, { alignment: protectedSegment.side === "right" ? "right" : "left" });
	}
	const renderSide = (side: StatusBarSegment["side"], separator: string): string => {
		const active = prepared
			.filter((segment) => segment.side === side && !segment.removed)
			.sort((left, right) => left.order - right.order);
		return active
			.map((segment) =>
				theme.fg(segment.role, segment.compact ? (segment.compactValue ?? segment.value) : segment.value),
			)
			.join(theme.fg("dim", separator));
	};
	const left = renderSide("left", leftSeparator);
	const right = renderSide("right", rightSeparator);
	if (!left) return padTerminalText(right, width, { alignment: "right" });
	if (!right) return padTerminalText(left, width);
	return `${left}${" ".repeat(width - terminalTextWidth(left) - terminalTextWidth(right))}${right}`;
}

export function renderStatusBar(snapshot: SessionStatusSnapshot, width: number, theme: Pick<Theme, "fg">): string {
	return renderStatusBarSegments(buildStatusBarSegments(snapshot), width, theme);
}

export class StatusBarComponent implements Component {
	private snapshot?: SessionStatusSnapshot;
	private readonly unsubscribe: () => void;

	constructor(
		controller: SessionStatusController,
		private readonly theme: Pick<Theme, "fg">,
		requestRender: () => void,
	) {
		this.unsubscribe = controller.subscribe((snapshot) => {
			this.snapshot = snapshot;
			requestRender();
		});
	}

	render(width: number): string[] {
		return [this.snapshot ? renderStatusBar(this.snapshot, width, this.theme) : ""];
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
	}
}
