import type { Component } from "@earendil-works/pi-tui";
import type { SessionStatusController } from "./controller.js";
import { fitTerminalText, padTerminalText, sanitizeTerminalText, terminalTextWidth } from "./layout.js";
import type { SessionStatusSnapshot } from "./snapshot.js";
import type { SessionUiStyleRole, SessionUiStyles } from "./styles.js";

export interface StatusBarFragment {
	value: string;
	style: SessionUiStyleRole;
}

export interface StatusBarSegment {
	id: string;
	side: "left" | "right";
	order: number;
	priority: number;
	style: SessionUiStyleRole;
	value: string;
	fragments?: readonly StatusBarFragment[];
	compactValue?: string;
	compactFragments?: readonly StatusBarFragment[];
	required?: boolean;
}

type PreparedSegment = StatusBarSegment & {
	value: string;
	fragments?: readonly StatusBarFragment[];
	compactValue?: string;
	compactFragments?: readonly StatusBarFragment[];
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

function runtimeStyle(id: string): SessionUiStyleRole {
	switch (id) {
		case "node":
			return "status.runtime.node";
		case "deno":
			return "status.runtime.deno";
		case "bun":
			return "status.runtime.bun";
		case "python":
			return "status.runtime.python";
		case "java":
			return "status.runtime.java";
		case "rust":
			return "status.runtime.rust";
		case "ruby":
			return "status.runtime.ruby";
		case "go":
			return "status.runtime.go";
		case "lua":
			return "status.runtime.lua";
		case "php":
			return "status.runtime.php";
		default:
			return "status.runtime.default";
	}
}

export function buildStatusBarSegments(snapshot: SessionStatusSnapshot): StatusBarSegment[] {
	const segments: StatusBarSegment[] = [];
	if (snapshot.git.status === "error" || snapshot.runtime.status === "error") {
		segments.push({
			id: "health",
			side: "left",
			order: 0,
			priority: 1000,
			style: "status.health",
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
		style: "status.workspace",
		value: snapshot.workspace.label,
	});
	if (snapshot.git.value) {
		const flags = gitFlags(snapshot);
		const branch = sanitizeTerminalText(snapshot.git.value.branch ?? "detached");
		const changes = flags ? ` [${flags}]` : "";
		segments.push({
			id: "git",
			side: "left",
			order: 20,
			priority: 650,
			style: "status.git.branch",
			value: `${branch}${changes}`,
			fragments: [
				{ value: branch, style: "status.git.branch" },
				...(changes ? [{ value: changes, style: "status.git.changes" } as const] : []),
			],
			compactValue: flags ? `[${flags}]` : branch,
			compactFragments: flags
				? [{ value: `[${flags}]`, style: "status.git.changes" }]
				: [{ value: branch, style: "status.git.branch" }],
		});
	}
	if (snapshot.runtime.value) {
		const runtime = snapshot.runtime.value;
		segments.push({
			id: "runtime",
			side: "left",
			order: 30,
			priority: 300,
			style: runtimeStyle(runtime.id),
			value: `${runtime.id}${runtime.version ? ` ${runtime.version}` : ""}`,
			compactValue: runtime.id,
		});
	}
	const context = snapshot.context.value;
	const percent = context?.percent;
	segments.push({
		id: "context",
		side: "right",
		order: 10,
		priority: 900,
		style:
			percent !== undefined && percent >= 90
				? "status.context.error"
				: percent !== undefined && percent >= 70
					? "status.context.warning"
					: "status.context.normal",
		value: context ? `${percent === undefined ? "?" : Math.round(percent)}%/${compactCount(context.window)}` : "ctx ?",
		compactValue: context ? `${percent === undefined ? "?" : Math.round(percent)}%` : "?",
		required: true,
	});
	if (snapshot.usage.value) {
		const usage = snapshot.usage.value;
		const tokenValue = `↑${compactCount(usage.inputTokens)} ↓${compactCount(usage.outputTokens)}`;
		const compactTokenValue = `↑${compactCount(usage.inputTokens)}`;
		const unknown = usage.unknownMessageCount > 0 ? " ?" : "";
		segments.push({
			id: "tokens",
			side: "right",
			order: 20,
			priority: 500,
			style: "status.tokens",
			value: `${tokenValue}${unknown}`,
			fragments: [
				{ value: tokenValue, style: "status.tokens" },
				...(unknown ? [{ value: unknown, style: "status.unknown" } as const] : []),
			],
			compactValue: `${compactTokenValue}${unknown}`,
			compactFragments: [
				{ value: compactTokenValue, style: "status.tokens" },
				...(unknown ? [{ value: unknown, style: "status.unknown" } as const] : []),
			],
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

function sanitizeFragments(
	fragments: readonly StatusBarFragment[] | undefined,
	value: string,
): readonly StatusBarFragment[] | undefined {
	if (!fragments) return undefined;
	const safe = fragments.map((fragment) => ({ ...fragment, value: sanitizeTerminalText(fragment.value) }));
	return safe.map((fragment) => fragment.value).join("") === value ? safe : undefined;
}

function renderPreparedSegment(segment: PreparedSegment, styles: SessionUiStyles): string {
	const value = segment.compact ? (segment.compactValue ?? segment.value) : segment.value;
	const fragments = segment.compact ? segment.compactFragments : segment.fragments;
	if (!fragments) return styles.apply(segment.style, value);
	return fragments.map((fragment) => styles.apply(fragment.style, fragment.value)).join("");
}

export function renderStatusBarSegments(
	segments: readonly StatusBarSegment[],
	width: number,
	styles: SessionUiStyles,
): string {
	if (width <= 0) return "";
	const prepared: PreparedSegment[] = segments.map((segment) => {
		const {
			value: rawValue,
			compactValue: rawCompactValue,
			fragments: rawFragments,
			compactFragments: rawCompactFragments,
			...rest
		} = segment;
		const value = sanitizeTerminalText(rawValue);
		const compactValue = rawCompactValue === undefined ? undefined : sanitizeTerminalText(rawCompactValue);
		const fragments = sanitizeFragments(rawFragments, value);
		const compactFragments =
			compactValue === undefined ? undefined : sanitizeFragments(rawCompactFragments, compactValue);
		return {
			...rest,
			value,
			...(compactValue !== undefined ? { compactValue } : {}),
			...(fragments ? { fragments } : {}),
			...(compactFragments ? { compactFragments } : {}),
			compact: false,
			removed: false,
		};
	});
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
		const rendered = fitTerminalText(renderPreparedSegment(protectedSegment, styles), width);
		return padTerminalText(rendered, width, {
			alignment: protectedSegment.side === "right" ? "right" : "left",
		});
	}
	const renderSide = (side: StatusBarSegment["side"], separator: string): string => {
		const active = prepared
			.filter((segment) => segment.side === side && !segment.removed)
			.sort((left, right) => left.order - right.order);
		return active
			.map((segment) => renderPreparedSegment(segment, styles))
			.join(styles.apply("status.separator", separator));
	};
	const left = renderSide("left", leftSeparator);
	const right = renderSide("right", rightSeparator);
	if (!left) return padTerminalText(right, width, { alignment: "right" });
	if (!right) return padTerminalText(left, width);
	return `${left}${" ".repeat(width - terminalTextWidth(left) - terminalTextWidth(right))}${right}`;
}

export function renderStatusBar(snapshot: SessionStatusSnapshot, width: number, styles: SessionUiStyles): string {
	return renderStatusBarSegments(buildStatusBarSegments(snapshot), width, styles);
}

export class StatusBarComponent implements Component {
	private snapshot?: SessionStatusSnapshot;
	private readonly unsubscribe: () => void;

	constructor(
		controller: SessionStatusController,
		private readonly styles: SessionUiStyles,
		requestRender: () => void,
	) {
		this.unsubscribe = controller.subscribe((snapshot) => {
			this.snapshot = snapshot;
			requestRender();
		});
	}

	render(width: number): string[] {
		return [this.snapshot ? renderStatusBar(this.snapshot, width, this.styles) : ""];
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
	}
}
