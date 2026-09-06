import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { connectVoice, MAX_AUDIO_BUFFER_BYTES } from "../dist/voice/realtime.js";

async function server(t, onConnection, extra = {}) {
	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, ...extra });
	await once(wss, "listening");
	wss.on("connection", onConnection);
	t.after(async () => {
		for (const client of wss.clients) client.terminate();
		await new Promise((resolve) => wss.close(resolve));
	});
	return `ws://127.0.0.1:${wss.address().port}`;
}

function options(t, endpoint, extra = {}) {
	const controller = new AbortController();
	t.after(() => controller.abort());
	return {
		endpoint,
		signal: controller.signal,
		apiKey: "test-secret",
		language: "ja",
		onPreview() {},
		onError(error) {
			assert.fail(error.message);
		},
		...extra,
	};
}

test("realtime sends auth and exact PCM configuration, then drains finals on close", async (t) => {
	const events = [];
	const previews = [];
	const endpoint = await server(t, (ws, request) => {
		assert.equal(request.headers.authorization, "Bearer test-secret");
		ws.on("message", (data) => {
			const event = JSON.parse(data.toString());
			events.push(event);
			if (event.type === "input_audio.append") {
				assert.deepEqual(Buffer.from(event.audio, "base64"), Buffer.alloc(3200, 1));
				ws.send(JSON.stringify({ type: "asr.partial_result", result_id: "p1", utterance_id: "u1", text: "暫定" }));
			}
			if (event.type === "session.close") {
				ws.send(JSON.stringify({ type: "asr.final_result", result_id: "f1", utterance_id: "u1", text: "確定" }));
				ws.close(1000);
			}
		});
	});
	const connection = await connectVoice(options(t, endpoint, { onPreview: (text) => previews.push(text) }));
	connection.sendAudio(Buffer.alloc(3200, 1));
	assert.equal(await connection.finish(), "確定");
	assert.deepEqual(
		events.map((e) => e.type),
		["session.update", "input_audio.append", "session.close"],
	);
	assert.deepEqual(events[0].session, {
		input_audio_format: "pcm_s16le",
		sample_rate: 16000,
		channels: 1,
		language: "ja",
	});
	assert.deepEqual(previews, ["暫定", "確定"]);
});

test("a service cannot echo the configured API key into a preview or the editor", async (t) => {
	const previews = [];
	const endpoint = await server(t, (ws) => {
		ws.on("message", (data) => {
			if (JSON.parse(data.toString()).type === "session.close") {
				ws.send(JSON.stringify({ type: "asr.final_result", result_id: "f1", text: "test-secret" }));
				ws.close(1000);
			}
		});
	});
	const connection = await connectVoice(options(t, endpoint, { onPreview: (text) => previews.push(text) }));
	assert.equal(await connection.finish(), "[redacted]");
	assert.deepEqual(previews, ["[redacted]"]);
});

test("unexpected network close cannot insert a partial transcript", async (t) => {
	let resolveError;
	const failed = new Promise((resolve) => {
		resolveError = resolve;
	});
	const endpoint = await server(t, (ws) => setImmediate(() => ws.close(1000)));
	await connectVoice(options(t, endpoint, { onError: resolveError }));
	assert.match((await failed).message, /ended before/);
});

test("remote error text is never echoed and finalization fails", async (t) => {
	const endpoint = await server(t, (ws) => {
		ws.on("message", (data) => {
			if (JSON.parse(data.toString()).type === "session.close") {
				ws.send(JSON.stringify({ type: "error", message: "test-secret\u001b[31m", fatal: true }));
			}
		});
	});
	const connection = await connectVoice(options(t, endpoint));
	await assert.rejects(
		connection.finish(),
		(error) => !error.message.includes("test-secret") && /transcription failed/.test(error.message),
	);
});

test("finalization has a bounded timeout and cancel rejects a pending finish", async (t) => {
	const endpoint = await server(t, () => {});
	const first = await connectVoice(options(t, endpoint, { finishTimeoutMs: 20 }));
	await assert.rejects(first.finish(), /timed out/);
	const second = await connectVoice(options(t, endpoint));
	const pending = second.finish();
	second.cancel();
	await assert.rejects(pending, /cancelled/);
});

test("denied service access reports the permission requirement without the response body", async (t) => {
	const endpoint = await server(t, () => assert.fail("must not connect"), {
		verifyClient: (_info, done) => done(false, 403, "test-secret"),
	});
	await assert.rejects(
		connectVoice(options(t, endpoint)),
		(error) => /shisa\/asr-realtime access/.test(error.message) && !error.message.includes("test-secret"),
	);
});

test("backpressure cancels rather than accumulating unbounded audio", async (t) => {
	const errors = [];
	const endpoint = await server(t, () => {});
	const connection = await connectVoice(options(t, endpoint, { onError: (error) => errors.push(error) }));
	t.mock.getter(WebSocket.prototype, "bufferedAmount", () => MAX_AUDIO_BUFFER_BYTES + 1);
	assert.throws(() => connection.sendAudio(Buffer.alloc(3200)), /too slow/);
	assert.equal(errors.length, 1);
	await assert.rejects(connection.finish(), /closed/);
});

test("nonfatal finalizer errors keep the socket alive and require review on normal close", async (t) => {
	const snapshots = [];
	const endpoint = await server(t, (ws) => {
		ws.on("message", (data) => {
			if (JSON.parse(data.toString()).type === "session.close") {
				for (const event of [
					{
						type: "asr.final_result",
						utterance_id: "a",
						result_id: "f1",
						text: "good",
						audio_start_ms: 0,
						audio_end_ms: 1000,
					},
					{
						type: "asr.partial_result",
						utterance_id: "b",
						result_id: "p1",
						text: "rough",
						audio_start_ms: 1000,
						audio_end_ms: 2000,
					},
					{ type: "error", fatal: false, utterance_id: "b", message: "test-secret", code: "finalization_timeout" },
				])
					ws.send(JSON.stringify(event));
				ws.close(1000);
			}
		});
	});
	const connection = await connectVoice(options(t, endpoint, { onSnapshot: (snapshot) => snapshots.push(snapshot) }));
	await assert.rejects(connection.finish(), (error) => error.snapshot?.segments[1].state === "failed");
	assert.deepEqual(
		snapshots.at(-1).segments.map((s) => s.state),
		["final", "failed"],
	);
	assert.ok(!JSON.stringify(snapshots).includes("test-secret"));
});

test("normal close with a missing final does not treat preview text as completed", async (t) => {
	const endpoint = await server(t, (ws) => {
		ws.on("message", (data) => {
			if (JSON.parse(data.toString()).type === "session.close") {
				ws.send(JSON.stringify({ type: "asr.partial_result", utterance_id: "a", result_id: "p1", text: "rough" }));
				ws.close(1000);
			}
		});
	});
	const connection = await connectVoice(options(t, endpoint));
	await assert.rejects(connection.finish(), /did not finalize/);
});

test("oversized server messages fail without exposing the message", async (t) => {
	let resolveError;
	const failed = new Promise((resolve) => {
		resolveError = resolve;
	});
	const endpoint = await server(t, (ws) => setImmediate(() => ws.send("x".repeat(128_001))));
	await connectVoice(options(t, endpoint, { onError: resolveError }));
	assert.match((await failed).message, /connection failed/);
});
