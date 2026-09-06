import { sanitizeTerminalText } from "../terminal-layout.js";

export const MAX_TRANSCRIPT_CHARS = 64_000;

/** Keep revisions out of the prompt until recording has finished. */
export class VoiceTranscript {
	private readonly finals = new Map<string, string>();
	private readonly partials = new Map<string, string>();

	accept(event: Record<string, unknown>): void {
		if (event.type !== "asr.partial_result" && event.type !== "asr.final_result") return;
		if (typeof event.text !== "string" || typeof event.result_id !== "string" || !event.result_id) {
			throw new Error("Voice transcription returned an invalid result. Try recording again.");
		}
		if (event.text.length > MAX_TRANSCRIPT_CHARS || event.result_id.length > 256) this.tooLarge();
		const text = sanitizeTerminalText(event.text).trim();
		if (event.type === "asr.partial_result") {
			const id = typeof event.utterance_id === "string" ? event.utterance_id : event.result_id;
			if (id.length > 256) this.tooLarge();
			this.partials.set(id, text);
		} else {
			if (Array.isArray(event.replaces)) {
				for (const id of event.replaces) if (typeof id === "string") this.finals.delete(id);
			}
			this.finals.set(event.result_id, text);
			if (typeof event.utterance_id === "string") this.partials.delete(event.utterance_id);
		}
		if (
			this.finals.size + this.partials.size > 2_000 ||
			this.text.length + this.preview.length > MAX_TRANSCRIPT_CHARS
		) {
			this.tooLarge();
		}
	}

	get text(): string {
		return [...this.finals.values()].filter(Boolean).join("\n");
	}

	get preview(): string {
		return [...this.partials.values()].filter(Boolean).join(" ") || [...this.finals.values()].at(-1) || "";
	}

	private tooLarge(): never {
		throw new Error("Voice transcription reached its text limit. Record a shorter passage.");
	}
}
