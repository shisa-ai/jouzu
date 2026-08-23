export interface SessionUiRuntimeIds {
	extension: string;
	sessionLineWidget: string;
}

/**
 * Runtime-only identifiers are centralized here so a later product rename does
 * not affect state, configuration, or renderer contracts.
 */
export const SESSION_UI_RUNTIME_IDS: Readonly<SessionUiRuntimeIds> = Object.freeze({
	extension: "jouzu-session-ui",
	sessionLineWidget: "jouzu-session-line",
});
