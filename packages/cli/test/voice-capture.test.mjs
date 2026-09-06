import assert from "node:assert/strict";
import test from "node:test";
import { listVoiceDevices, startVoiceCapture } from "../dist/voice/capture.js";

const helper = {
	workerUrl: new URL("./fixtures/voice-capture-helper.mjs", import.meta.url),
	startupTimeoutMs: 1000,
	stopTimeoutMs: 50,
};
function options(t, device = -1) {
	const controller = new AbortController();
	t.after(() => controller.abort());
	return {
		device,
		signal: controller.signal,
		onAudio() {},
		onError(error) {
			assert.fail(error.message);
		},
	};
}

test("capture helper enumerates devices without recording", async (t) => {
	assert.deepEqual(await listVoiceDevices(options(t).signal, helper), ["Test microphone"]);
});

test("capture forwards complete frames including the last frame before stopped", async (t) => {
	const frames = [];
	const capture = await startVoiceCapture(
		{
			...options(t),
			onAudio(pcm) {
				frames.push(pcm);
			},
		},
		helper,
	);
	await capture.stop();
	assert.deepEqual(frames, [Buffer.alloc(3200, 7), Buffer.alloc(3200, 8)]);
});

test("capture kills a helper that hangs while stopping", async (t) => {
	const capture = await startVoiceCapture(options(t, 1), helper);
	await assert.rejects(capture.stop(), /did not respond to stop/);
});

test("capture kills a helper that hangs during initialization", async (t) => {
	await assert.rejects(startVoiceCapture(options(t, 2), { ...helper, startupTimeoutMs: 100 }), /startup timed out/);
});

test("cancel terminates capture and prevents a later stop from hanging", async (t) => {
	const capture = await startVoiceCapture(options(t), helper);
	capture.cancel();
	await assert.rejects(capture.stop(), /capture failed/);
});
