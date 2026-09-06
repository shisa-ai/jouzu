import { createRequire } from "node:module";

interface Recorder {
	readonly sampleRate: number;
	start(): void;
	stop(): void;
	release(): void;
	readSync(): Int16Array;
}

// This file runs only in a child process. Loading the native library or reading
// a disconnected device must not block or crash the terminal process.
let recorder: Recorder | undefined;
let stopped = false;
let initialized = false;

function finish(failed = false): void {
	if (stopped) return;
	stopped = true;
	try {
		recorder?.stop();
	} catch {
		/* Release even if stopping the device failed. */
	}
	try {
		recorder?.release();
	} catch {
		/* Process exit is the final cleanup boundary. */
	}
	process.send?.({ type: failed ? "error" : "stopped" }, () => process.exit(failed ? 1 : 0));
	if (!process.connected) process.exit(failed ? 1 : 0);
}

function readFrame(): void {
	if (stopped || !recorder) return;
	try {
		const samples = recorder.readSync();
		const pcm = Buffer.alloc(samples.length * 2);
		for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(samples[i], i * 2);
		// Wait for a parent acknowledgement before the next blocking native read.
		process.send?.({ type: "audio", audio: pcm.toString("base64") }, (error) => {
			if (error) finish(true);
		});
	} catch {
		finish(true);
	}
}

process.on("disconnect", () => finish());
process.on("SIGTERM", () => finish());
process.on("message", (message: { type?: string; device?: number }) => {
	if (message.type === "stop") {
		finish();
		return;
	}
	if (message.type === "ack") {
		setImmediate(readFrame);
		return;
	}
	if (initialized || stopped || (message.type !== "start" && message.type !== "devices")) return;
	initialized = true;
	try {
		const { PvRecorder } = createRequire(import.meta.url)("@picovoice/pvrecorder-node") as {
			PvRecorder: {
				new (frameLength: number, deviceIndex: number, bufferedFrames: number): Recorder;
				getAvailableDevices(): string[];
			};
		};
		if (message.type === "devices") {
			process.send?.(
				{
					type: "devices",
					devices: PvRecorder.getAvailableDevices()
						.slice(0, 128)
						.map((name) => name.slice(0, 512)),
				},
				() => process.exit(0),
			);
			return;
		}
		const device = message.device ?? -1;
		if (!Number.isInteger(device) || device < -1) throw new Error("invalid device");
		recorder = new PvRecorder(1600, device, 10);
		if (recorder.sampleRate !== 16000) throw new Error("invalid sample rate");
		recorder.start();
		process.send?.({ type: "ready" });
		setImmediate(readFrame);
	} catch {
		finish(true);
	}
});
