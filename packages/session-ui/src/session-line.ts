import type { Component } from "@earendil-works/pi-tui";
import type { SessionUiActivity, SessionUiHint, SessionUiSemanticRole } from "./contracts.js";
import type { SessionStatusController } from "./controller.js";
import { fitTerminalText, padTerminalText, sanitizeTerminalText, terminalTextWidth } from "./layout.js";
import type { SessionStatusSnapshot } from "./snapshot.js";
import type { SessionUiStyleRole, SessionUiStyles } from "./styles.js";

/** Braille frames matching Pi's working indicator, so both surfaces animate at the same cadence. */
export const SESSION_ACTIVITY_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
/** Marker for work that is not moving: a paused, stopped, or completed run. */
export const SESSION_ACTIVITY_IDLE_GLYPH = "○";
/** One animation step. Ten frames make a full turn in about 1.6 seconds. */
export const SESSION_ACTIVITY_TICK_MS = 160;
/** Narrowest activity column worth showing: a marker, a space, and a readable fragment. */
const MIN_ACTIVITY_WIDTH = 16;

export function sessionActivityGlyph(activity: SessionUiActivity, frame = 0): string {
	if (!activity.active) return SESSION_ACTIVITY_IDLE_GLYPH;
	const frames = SESSION_ACTIVITY_FRAMES.length;
	return SESSION_ACTIVITY_FRAMES[((Math.trunc(frame) % frames) + frames) % frames];
}

function formatProvider(providerId: string | undefined): string {
	if (!providerId) return "";
	const catalogParts = providerId.split(":");
	if (catalogParts[0] === "catalog" && (catalogParts.length === 3 || catalogParts.length === 4)) {
		try {
			providerId = decodeURIComponent(catalogParts[2]);
		} catch {
			// Malformed external identities still pass through terminal sanitization.
		}
	}
	const known: Readonly<Record<string, string>> = {
		anthropic: "Anthropic",
		codex: "Codex",
		gemini: "Google",
		google: "Google",
		ollama: "Ollama",
		openai: "OpenAI",
		"openai-codex": "OpenAI",
	};
	const safe = sanitizeTerminalText(providerId);
	return known[safe] ?? safe.replace(/[-_]/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatModelId(modelId: string | undefined): string {
	if (!modelId) return "no model";
	const safe = sanitizeTerminalText(modelId);
	return safe.slice(safe.lastIndexOf("/") + 1);
}

function hintStyle(role: SessionUiSemanticRole): SessionUiStyleRole {
	switch (role) {
		case "text":
			return "session.hint.text";
		case "muted":
			return "session.hint.muted";
		case "accent":
			return "session.hint.accent";
		case "success":
			return "session.hint.success";
		case "warning":
			return "session.hint.warning";
		case "error":
			return "session.hint.error";
	}
}

export function selectSessionUiHint(hints: readonly SessionUiHint[]): SessionUiHint | undefined {
	return [...hints].sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))[0];
}

export function renderSessionLine(
	snapshot: SessionStatusSnapshot,
	hints: readonly SessionUiHint[],
	width: number,
	styles: SessionUiStyles,
	activity?: SessionUiActivity,
	glyph?: string,
): string {
	if (width <= 0) return "";
	const provider = formatProvider(snapshot.model.providerId);
	const model = formatModelId(snapshot.model.modelId);
	const thinking = snapshot.model.thinkingLevel;
	const modelIdentity = `${model}${thinking && thinking !== "off" ? ` (${sanitizeTerminalText(thinking)})` : ""}`;
	if (activity?.attentionCount && activity.attentionCount > 0) {
		const badge = `!${Math.floor(activity.attentionCount)}`;
		const badgeWidth = terminalTextWidth(badge);
		if (width < badgeWidth) return fitTerminalText(badge, width);
		const left = styles.apply("session.hint.warning", badge);
		const available = width - badgeWidth - 2;
		if (available <= 0) return padTerminalText(left, width);
		const fullIdentity = `${provider ? `${provider} ` : ""}${modelIdentity}`;
		const identity =
			terminalTextWidth(fullIdentity) <= available
				? `${provider ? `${styles.apply("session.provider", provider)} ` : ""}${styles.apply("session.model", modelIdentity)}`
				: styles.apply("session.model", fitTerminalText(modelIdentity, available, "…"));
		const detailWidth = available - terminalTextWidth(identity) - 2;
		const detail = detailWidth > 0 ? renderActivityLeft(activity, glyph, detailWidth, styles) : undefined;
		const prefix = `${left}${detail ? `  ${detail}` : ""}`;
		return `${prefix}${" ".repeat(width - terminalTextWidth(prefix) - terminalTextWidth(identity))}${identity}`;
	}
	const right = fitTerminalText(
		`${provider ? `${styles.apply("session.provider", provider)} ` : ""}${styles.apply("session.model", modelIdentity)}`,
		width,
	);
	const rightWidth = terminalTextWidth(right);
	if (rightWidth + 2 >= width) return padTerminalText(right, width, { alignment: "right" });
	const availableLeft = width - rightWidth - 2;
	const left = activity
		? renderActivityLeft(activity, glyph, availableLeft, styles)
		: renderHintLeft(hints, availableLeft, styles);
	if (!left) return padTerminalText(right, width, { alignment: "right" });
	return `${left}${" ".repeat(width - terminalTextWidth(left) - rightWidth)}${right}`;
}

function renderHintLeft(
	hints: readonly SessionUiHint[],
	available: number,
	styles: SessionUiStyles,
): string | undefined {
	const hint = selectSessionUiHint(hints);
	if (!hint) return undefined;
	const text = sanitizeTerminalText(hint.text);
	if (terminalTextWidth(text) > available) return undefined;
	return styles.apply(hintStyle(hint.role), text);
}

/**
 * Activity reports what is running, so it survives truncation instead of disappearing the way a
 * hint does. It is dropped only when too little width remains to say anything useful.
 */
function renderActivityLeft(
	activity: SessionUiActivity,
	glyph: string | undefined,
	available: number,
	styles: SessionUiStyles,
): string | undefined {
	const text = sanitizeTerminalText(activity.text);
	if (!text) return undefined;
	const value = `${glyph ?? sessionActivityGlyph(activity)} ${text}`;
	if (terminalTextWidth(value) > available && available < MIN_ACTIVITY_WIDTH) return undefined;
	const role: SessionUiStyleRole = activity.active ? "session.activity" : "session.activity.idle";
	return styles.apply(role, fitTerminalText(value, available, "…"));
}

export class SessionLineComponent implements Component {
	private snapshot?: SessionStatusSnapshot;
	private frame = 0;
	private timer?: ReturnType<typeof setInterval>;
	private readonly unsubscribe: () => void;

	constructor(
		controller: SessionStatusController,
		private readonly styles: SessionUiStyles,
		private readonly getHints: () => readonly SessionUiHint[],
		private readonly requestRender: () => void,
		private readonly getActivity: () => SessionUiActivity | undefined = () => undefined,
		private readonly tickMs: number = SESSION_ACTIVITY_TICK_MS,
	) {
		this.unsubscribe = controller.subscribe((snapshot) => {
			this.snapshot = snapshot;
			requestRender();
		});
	}

	render(width: number): string[] {
		const activity = this.snapshot ? this.getActivity() : undefined;
		this.syncAnimation(activity);
		const glyph = activity ? sessionActivityGlyph(activity, this.frame) : undefined;
		return [
			this.snapshot ? renderSessionLine(this.snapshot, this.getHints(), width, this.styles, activity, glyph) : "",
		];
	}

	/**
	 * Animate only while work is moving and the session is not streaming. Pi animates its own working
	 * indicator while the session streams, so the marker holds one frame instead of adding a second
	 * spinner. Each step also re-reads activity, so the line cannot go stale while it spins.
	 */
	private syncAnimation(activity: SessionUiActivity | undefined): void {
		const animate = activity?.active === true && this.snapshot?.activity.idle === true;
		if (animate === (this.timer !== undefined)) return;
		if (!animate) {
			clearInterval(this.timer);
			this.timer = undefined;
			return;
		}
		this.timer = setInterval(() => {
			this.frame += 1;
			this.requestRender();
		}, this.tickMs);
		// A widget timer must never be the reason a headless process stays alive.
		this.timer.unref?.();
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
		this.timer = undefined;
		this.unsubscribe();
	}
}
