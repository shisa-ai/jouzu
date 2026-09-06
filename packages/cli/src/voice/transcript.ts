import { sanitizeTerminalText } from "../terminal-layout.js";
import { VoiceError } from "./errors.js";

export const MAX_TRANSCRIPT_CHARS = 64_000;
export type VoiceSegmentState = "live" | "pending" | "final" | "failed";
export interface VoiceSegment {
	id: string;
	state: VoiceSegmentState;
	text: string;
	startMs?: number;
	endMs?: number;
}
export interface VoiceSnapshot {
	segments: VoiceSegment[];
}

export class VoiceReviewRequired extends VoiceError {
	constructor(readonly snapshot: VoiceSnapshot) {
		super("Some voice chunks did not finalize.");
	}
}

function identifier(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 256)
		throw new VoiceError("Voice returned an invalid segment identifier.");
	return value;
}
function time(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || Number(value) < 0) throw new VoiceError("Voice returned an invalid audio range.");
	return Number(value);
}

/** Server-authored logical segments; audio context overlap is not duplicate text. */
export class VoiceTranscript {
	private readonly segments = new Map<string, VoiceSegment>();
	private readonly results = new Map<string, string>();
	private readonly retired = new Set<string>();
	private readonly sequences = new Map<string, number>();
	private noSpeechCount = 0;
	private finalErrorCount = 0;
	private completedUsage = false;

	accept(event: Record<string, unknown>): void {
		if (event.type === "session.usage" && event.final === true) {
			const usage = event.usage as Record<string, unknown> | undefined;
			if (usage && usage.status === "completed") {
				this.completedUsage = true;
				this.noSpeechCount = time(usage.final_no_speech_count) ?? 0;
				this.finalErrorCount = time(usage.final_error_count) ?? 0;
			}
			return;
		}
		if (
			!["speech_started", "speech_stopped", "asr.partial_result", "asr.final_result", "error"].includes(
				String(event.type),
			)
		)
			return;
		const isFinal = event.type === "asr.final_result";
		const isResult = isFinal || event.type === "asr.partial_result";
		const resultId = isResult ? identifier(event.result_id) : undefined;
		const id = identifier(event.utterance_id ?? resultId);
		if (this.retired.has(id)) return;
		const previous = this.segments.get(id);
		if (previous?.state === "final" && !isFinal) return;
		const seq = time(event.seq);
		if (seq !== undefined && seq <= (this.sequences.get(id) ?? -1)) return;
		const startMs = time(event.audio_start_ms) ?? previous?.startMs;
		const endMs = time(event.audio_end_ms) ?? previous?.endMs;
		if (startMs !== undefined && endMs !== undefined && endMs <= startMs)
			throw new VoiceError("Voice returned an invalid audio range.");
		let text = previous?.text ?? "";
		if (isResult) {
			if (typeof event.text !== "string" || event.text.length > MAX_TRANSCRIPT_CHARS) this.tooLarge();
			text = sanitizeTerminalText(event.text as string).trim();
		}
		if (isFinal) {
			const replaced = new Set<string>();
			if (event.replaces !== undefined) {
				if (!Array.isArray(event.replaces) || event.replaces.length > 10_000) this.tooLarge();
				for (const result of event.replaces as unknown[]) {
					const owner = this.results.get(identifier(result));
					if (owner) replaced.add(owner);
				}
			}
			if (event.replaces_audio_range_ms !== undefined) {
				const range = event.replaces_audio_range_ms;
				if (!Array.isArray(range) || range.length !== 2)
					throw new VoiceError("Voice returned an invalid replacement range.");
				const from = time(range[0]);
				const to = time(range[1]);
				if (from === undefined || to === undefined || to <= from)
					throw new VoiceError("Voice returned an invalid replacement range.");
				for (const segment of this.segments.values()) {
					if (
						segment.startMs !== undefined &&
						segment.endMs !== undefined &&
						segment.startMs >= from &&
						segment.endMs <= to
					)
						replaced.add(segment.id);
				}
			}
			for (const old of replaced) {
				if (old === id) continue;
				this.segments.delete(old);
				this.retired.add(old);
			}
		}
		const state: VoiceSegmentState = isFinal
			? "final"
			: event.type === "error"
				? "failed"
				: previous?.state === "failed"
					? "failed"
					: event.type === "speech_stopped" || previous?.state === "pending"
						? "pending"
						: "live";
		if (state === "live" && startMs !== undefined) {
			// The service can defer speech_stopped until the finalizer returns.
			// A later logical utterance establishes that the earlier one is sealed.
			for (const segment of this.segments.values()) {
				if (segment.id !== id && segment.state === "live" && segment.endMs !== undefined && segment.endMs <= startMs)
					segment.state = "pending";
			}
		}
		this.segments.set(id, { id, state, text, startMs, endMs });
		if (resultId) this.results.set(resultId, id);
		if (seq !== undefined) this.sequences.set(id, seq);
		if (
			this.segments.size + this.retired.size > 2_000 ||
			this.results.size > 10_000 ||
			[...this.segments.values()].reduce((sum, segment) => sum + segment.text.length, 0) > MAX_TRANSCRIPT_CHARS
		)
			this.tooLarge();
	}

	get snapshot(): VoiceSnapshot {
		return {
			segments: [...this.segments.values()]
				.map((segment) => ({ ...segment }))
				.sort((a, b) => (a.startMs ?? Number.MAX_SAFE_INTEGER) - (b.startMs ?? Number.MAX_SAFE_INTEGER)),
		};
	}

	get text(): string {
		return this.snapshot.segments
			.filter((segment) => segment.state === "final")
			.map((segment) => segment.text)
			.filter(Boolean)
			.join("\n");
	}

	get preview(): string {
		return this.snapshot.segments
			.map((segment) => segment.text)
			.filter(Boolean)
			.join("\n");
	}

	beginFinish(): void {
		for (const segment of this.segments.values()) if (segment.state === "live") segment.state = "pending";
	}

	finish(): string {
		const unresolved = [...this.segments.values()].filter((segment) => segment.state !== "final");
		// The protocol may omit empty finals; only terminal accounting can explain them.
		if (
			this.completedUsage &&
			this.finalErrorCount === 0 &&
			unresolved.every((segment) => !segment.text && segment.state !== "failed") &&
			this.noSpeechCount >= unresolved.length
		) {
			for (const segment of unresolved) this.segments.delete(segment.id);
		} else if (unresolved.length || this.finalErrorCount > 0) {
			for (const segment of unresolved) segment.state = "failed";
			if (!unresolved.length)
				this.segments.set("unreported-failure", { id: "unreported-failure", state: "failed", text: "" });
			throw new VoiceReviewRequired(this.snapshot);
		}
		return this.text;
	}

	private tooLarge(): never {
		throw new VoiceError("Voice transcription reached its text or segment limit. Record a shorter passage.");
	}
}
