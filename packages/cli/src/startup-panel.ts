import type { SessionUiStyles } from "./session-ui/index.js";

/** The session facts a startup section reads; Pi's session manager provides them. */
export interface StartupSessionManager {
	getSessionDir(): string;
	getSessionFile(): string | undefined;
	getEntries(): readonly { type: string }[];
	usesDefaultSessionDir?(): boolean;
}

export interface StartupSectionContext {
	cwd: string;
	sessionManager: StartupSessionManager;
	/** Ask the terminal to draw again, for example after background loading finishes. */
	requestRender(): void;
}

/**
 * One block under the startup banner. Sections render in order and share the
 * rows left between the banner and the prompt; a section with nothing to show
 * returns no lines. Recent sessions use this slot, and later notices share it.
 *
 * `rows` is what remains when the section renders. A section sizes new content
 * to it, then may keep that height while the prompt dock grows, so its lines do
 * not move under the user as they type.
 */
export interface StartupSection {
	/** Begin background work for a fresh launch. Called when the launch header mounts. */
	start?(context: StartupSectionContext): void;
	/** Keep the current lines: the conversation has started below them. */
	freeze?(): void;
	/** Drop everything: another session replaced the launch session. */
	reset?(): void;
	render(width: number, rows: number, styles: SessionUiStyles): string[];
}

/** Rows kept free below the sections for startup warnings and the first reply. */
export const STARTUP_RESERVED_ROWS = 4;
/** The prompt dock's height when it cannot be measured: Session Line, prompt between two borders, status bar. */
export const STARTUP_DEFAULT_DOCK_ROWS = 5;

/** Rows the sections may use once the banner, the prompt dock, and the reserve are subtracted. */
export function startupSectionRows(terminalRows: number, dockRows: number | undefined, bannerRows: number): number {
	if (!Number.isFinite(terminalRows) || terminalRows <= 0) return 0;
	return Math.max(0, terminalRows - (dockRows ?? STARTUP_DEFAULT_DOCK_ROWS) - bannerRows - STARTUP_RESERVED_ROWS);
}

/** Every section's lines within `rows`, earlier sections first. */
export function renderStartupSections(
	sections: readonly StartupSection[],
	width: number,
	rows: number,
	styles: SessionUiStyles,
): string[] {
	const lines: string[] = [];
	for (const section of sections) lines.push(...section.render(width, Math.max(0, rows - lines.length), styles));
	return lines;
}
