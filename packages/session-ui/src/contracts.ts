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

export interface SessionUiClock {
	now(): number;
}

export const SYSTEM_SESSION_UI_CLOCK: SessionUiClock = Object.freeze({
	now: () => Date.now(),
});
