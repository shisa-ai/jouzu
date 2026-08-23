import type { Component } from "@earendil-works/pi-tui";
import type { SessionUiHint, SessionUiSemanticRole } from "./contracts.js";
import type { SessionStatusController } from "./controller.js";
import { fitTerminalText, padTerminalText, sanitizeTerminalText, terminalTextWidth } from "./layout.js";
import type { SessionStatusSnapshot } from "./snapshot.js";
import type { SessionUiStyleRole, SessionUiStyles } from "./styles.js";

function formatProvider(providerId: string | undefined): string {
	if (!providerId) return "";
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
): string {
	if (width <= 0) return "";
	const provider = formatProvider(snapshot.model.providerId);
	const model = formatModelId(snapshot.model.modelId);
	const thinking = snapshot.model.thinkingLevel;
	const modelIdentity = `${model}${thinking && thinking !== "off" ? ` (${sanitizeTerminalText(thinking)})` : ""}`;
	const right = fitTerminalText(
		`${provider ? `${styles.apply("session.provider", provider)} ` : ""}${styles.apply("session.model", modelIdentity)}`,
		width,
	);
	const rightWidth = terminalTextWidth(right);
	const hint = selectSessionUiHint(hints);
	if (!hint || rightWidth + 2 >= width) return padTerminalText(right, width, { alignment: "right" });
	const plainLeft = sanitizeTerminalText(hint.text);
	const availableLeft = width - rightWidth - 2;
	if (terminalTextWidth(plainLeft) > availableLeft) return padTerminalText(right, width, { alignment: "right" });
	const left = styles.apply(hintStyle(hint.role), plainLeft);
	return `${left}${" ".repeat(width - terminalTextWidth(left) - rightWidth)}${right}`;
}

export class SessionLineComponent implements Component {
	private snapshot?: SessionStatusSnapshot;
	private readonly unsubscribe: () => void;

	constructor(
		controller: SessionStatusController,
		private readonly styles: SessionUiStyles,
		private readonly getHints: () => readonly SessionUiHint[],
		requestRender: () => void,
	) {
		this.unsubscribe = controller.subscribe((snapshot) => {
			this.snapshot = snapshot;
			requestRender();
		});
	}

	render(width: number): string[] {
		return [this.snapshot ? renderSessionLine(this.snapshot, this.getHints(), width, this.styles) : ""];
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
	}
}
