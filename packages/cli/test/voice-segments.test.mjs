import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderVoiceWidget } from "../dist/voice/integration.js";
import { VoiceReviewRequired, VoiceTranscript } from "../dist/voice/transcript.js";

function result(type, id, text, start = 0, end = 1000, extra = {}) {
	return {
		type,
		utterance_id: id,
		result_id: `${id}-${type}`,
		text,
		audio_start_ms: start,
		audio_end_ms: end,
		...extra,
	};
}

test("hybrid snapshot retains finalized, pending, and live chunks together", () => {
	const t = new VoiceTranscript();
	t.accept(result("asr.final_result", "a", "確定"));
	t.accept(result("asr.partial_result", "b", "waiting", 1000, 2000));
	t.accept({ type: "speech_stopped", utterance_id: "b", audio_start_ms: 1000, audio_end_ms: 2000 });
	t.accept(result("asr.partial_result", "c", "live", 2000, 3000));
	assert.deepEqual(
		t.snapshot.segments.map((s) => s.state),
		["final", "pending", "live"],
	);
	assert.equal(t.preview, "確定\nwaiting\nlive");
	t.accept(result("asr.final_result", "b", "corrected", 1000, 2000));
	assert.equal(t.preview, "確定\ncorrected\nlive");
});

test("later speech and local stop mark pending even when the server defers speech_stopped", () => {
	const t = new VoiceTranscript();
	t.accept(result("asr.partial_result", "a", "first"));
	t.accept(result("asr.partial_result", "b", "second", 1000, 2000));
	assert.deepEqual(
		t.snapshot.segments.map((s) => s.state),
		["pending", "live"],
	);
	t.beginFinish();
	assert.deepEqual(
		t.snapshot.segments.map((s) => s.state),
		["pending", "pending"],
	);
});

test("finalization preserves deliberate repetition and ignores delayed partials", () => {
	const t = new VoiceTranscript();
	t.accept(result("asr.final_result", "a", "今日は今日は"));
	t.accept(result("asr.partial_result", "a", "stale"));
	t.accept(
		result("asr.final_result", "b", "今日は今日は", 1000, 2000, {
			payload_audio_range_ms: [0, 2000],
			leading_context_ms: 1000,
		}),
	);
	assert.equal(t.finish(), "今日は今日は\n今日は今日は");
});

test("logical replacement ranges retire covered segments but not overlapping context", () => {
	const t = new VoiceTranscript();
	t.accept(result("asr.final_result", "a", "first"));
	t.accept(result("asr.partial_result", "b", "second", 1000, 2000));
	t.accept(
		result("asr.final_result", "c", "corrected", 1000, 2000, {
			replaces_audio_range_ms: [1000, 2000],
			payload_audio_range_ms: [500, 2000],
		}),
	);
	t.accept(result("asr.partial_result", "b", "late", 1000, 2000));
	assert.equal(t.finish(), "first\ncorrected");
});

test("replacement IDs and chronological ordering do not depend on completion order", () => {
	const t = new VoiceTranscript();
	t.accept(result("asr.final_result", "b", "second", 1000, 2000));
	t.accept(result("asr.final_result", "a", "first"));
	t.accept(result("asr.final_result", "c", "revised", 0, 1000, { replaces: ["a-asr.final_result"] }));
	assert.equal(t.finish(), "revised\nsecond");
});

test("nonfatal chunk failure retains other finals and requires explicit review", () => {
	const t = new VoiceTranscript();
	t.accept(result("asr.final_result", "a", "first"));
	t.accept(result("asr.partial_result", "b", "uncertain", 1000, 2000));
	t.accept({ type: "error", utterance_id: "b", fatal: false, message: "secret" });
	assert.equal(t.snapshot.segments[1].state, "failed");
	assert.throws(() => t.finish(), VoiceReviewRequired);
	assert.equal(t.text, "first");
	assert.ok(!JSON.stringify(t.snapshot).includes("secret"));
});

test("only explicit terminal no-speech accounting clears empty unresolved chunks", () => {
	const t = new VoiceTranscript();
	t.accept({ type: "speech_started", utterance_id: "a", audio_start_ms: 0 });
	t.accept({ type: "speech_stopped", utterance_id: "a", audio_start_ms: 0, audio_end_ms: 1000 });
	t.accept({
		type: "session.usage",
		final: true,
		usage: { status: "completed", final_no_speech_count: 1, final_error_count: 0 },
	});
	assert.equal(t.finish(), "");
	const missing = new VoiceTranscript();
	missing.accept(result("asr.partial_result", "a", "not confirmed"));
	missing.accept({ type: "session.usage", final: true, usage: { status: "completed", final_no_speech_count: 1 } });
	assert.throws(() => missing.finish(), VoiceReviewRequired);
});

test("terminal error counts cannot silently produce successful text", () => {
	const t = new VoiceTranscript();
	t.accept({ type: "session.usage", final: true, usage: { status: "completed", final_error_count: 1 } });
	assert.throws(() => t.finish(), VoiceReviewRequired);
});

test("snapshot copies cannot mutate authoritative text and old sequence updates are ignored", () => {
	const t = new VoiceTranscript();
	t.accept(result("asr.partial_result", "a", "new", 0, 1000, { seq: 4 }));
	t.accept(result("asr.partial_result", "a", "old", 0, 1000, { seq: 3 }));
	t.snapshot.segments[0].text = "changed";
	assert.equal(t.preview, "new");
});

test("hybrid widget labels states, retains history, and fits small terminals", () => {
	const snapshot = {
		segments: Array.from({ length: 10 }, (_, index) => ({
			id: String(index),
			state: ["final", "pending", "live", "failed"][index % 4],
			text: "日本語 👩🏽‍💻 text",
		})),
	};
	for (const width of [1, 10, 12, 24, 48, 80]) {
		const lines = renderVoiceWidget("review", "", width, snapshot);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
	const rendered = renderVoiceWidget("review", "", 80, snapshot).join("\n");
	assert.match(rendered, /4 earlier chunks retained/);
	assert.match(rendered, /Final.*Pending|Pending/s);
	assert.match(rendered, /\/voice review/);
});
