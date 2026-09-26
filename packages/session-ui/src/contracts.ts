export type SessionUiSemanticRole = "text" | "muted" | "accent" | "success" | "warning" | "error";

export interface SessionUiHint {
	id: string;
	text: string;
	priority: number;
	role: SessionUiSemanticRole;
}

export interface SessionUiHintSource {
	getHint(): SessionUiHint | undefined;
}

/** Status text other extensions published through `ctx.ui.setStatus`, keyed by extension. */
export interface SessionUiActivityContext {
	extensionStatuses: ReadonlyMap<string, string>;
}

/**
 * Work the Session Line reports instead of the shortcut hint: a running loop, active child
 * agents, or loop state that outlives the turn. `active` animates the marker while work moves.
 */
export interface SessionUiActivity {
	text: string;
	active: boolean;
	/** Distinct unresolved units; retained even when detail or model identity cannot fit. */
	attentionCount?: number;
}

export interface SessionUiClock {
	now(): number;
}

export const SYSTEM_SESSION_UI_CLOCK: SessionUiClock = Object.freeze({
	now: () => Date.now(),
});
