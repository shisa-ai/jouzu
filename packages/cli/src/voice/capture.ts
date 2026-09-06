import { fork } from "node:child_process";
import { VoiceError } from "./errors.js";

export interface VoiceCapture {
	stop(): Promise<void>;
	cancel(): void;
}

export interface CaptureOptions {
	device: number;
	signal: AbortSignal;
	onAudio(pcm: Buffer): void;
	onError(error: Error): void;
}

const CAPTURE_ERROR =
	"Microphone capture failed. Check your input device, microphone permission, and platform support.";

export function captureEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const allowed = new Set([
		"PATH",
		"HOME",
		"USER",
		"USERPROFILE",
		"SYSTEMROOT",
		"WINDIR",
		"APPDATA",
		"LOCALAPPDATA",
		"TEMP",
		"TMP",
		"TMPDIR",
		"XDG_RUNTIME_DIR",
		"DBUS_SESSION_BUS_ADDRESS",
		"PULSE_SERVER",
		"PULSE_COOKIE",
		"ALSA_CONFIG_PATH",
	]);
	return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toUpperCase())));
}

interface CaptureHelperOptions {
	workerUrl?: URL;
	startupTimeoutMs?: number;
	stopTimeoutMs?: number;
}

export function startVoiceCapture(options: CaptureOptions, helper: CaptureHelperOptions = {}): Promise<VoiceCapture> {
	return runCaptureHelper("start", options, helper) as Promise<VoiceCapture>;
}

export function listVoiceDevices(signal: AbortSignal, helper: CaptureHelperOptions = {}): Promise<string[]> {
	return runCaptureHelper("devices", { device: -1, signal, onAudio() {}, onError() {} }, helper) as Promise<string[]>;
}

/** The parent can forcibly terminate a native read that never returns. */
function runCaptureHelper(
	mode: "start" | "devices",
	options: CaptureOptions,
	helper: CaptureHelperOptions,
): Promise<VoiceCapture | string[]> {
	return new Promise((resolve, reject) => {
		if (options.signal.aborted) {
			reject(new Error("Voice recording cancelled."));
			return;
		}
		const child = fork(helper.workerUrl ?? new URL("./capture-worker.js", import.meta.url), [], {
			stdio: ["ignore", "ignore", "ignore", "ipc"],
			execArgv: [],
			env: captureEnvironment(process.env),
		});
		let ready = false;
		let terminal = false;
		let stopping: Promise<void> | undefined;
		let stopResolve: (() => void) | undefined;
		let stopReject: ((error: Error) => void) | undefined;
		let stopTimer: ReturnType<typeof setTimeout> | undefined;
		const startupTimer = setTimeout(
			() => fail(new Error("Microphone startup timed out. Check your audio device.")),
			helper.startupTimeoutMs ?? 10_000,
		);
		const cleanup = () => {
			clearTimeout(startupTimer);
			clearTimeout(stopTimer);
			options.signal.removeEventListener("abort", cancel);
		};
		const fail = (failure: Error) => {
			if (terminal) return;
			const error = new VoiceError(failure.message);
			terminal = true;
			cleanup();
			child.kill("SIGKILL");
			if (!ready) reject(error);
			else if (stopReject) stopReject(error);
			else options.onError(error);
		};
		const cancel = () => {
			if (terminal) return;
			terminal = true;
			cleanup();
			child.kill("SIGKILL");
			if (!ready) reject(new Error("Voice recording cancelled."));
			stopReject?.(new Error("Voice recording cancelled."));
		};
		const send = (message: object) => {
			if (terminal) return;
			child.send(message, (error) => {
				if (error) fail(new Error(CAPTURE_ERROR));
			});
		};
		options.signal.addEventListener("abort", cancel, { once: true });
		child.on("error", () => fail(new Error(CAPTURE_ERROR)));
		child.on("exit", () => {
			if (!terminal) fail(new Error(CAPTURE_ERROR));
		});
		child.on("message", (message: { type?: string; audio?: string; devices?: string[] }) => {
			if (terminal) return;
			if (message.type === "error") {
				fail(new Error(CAPTURE_ERROR));
				return;
			}
			if (message.type === "devices" && mode === "devices" && Array.isArray(message.devices)) {
				terminal = true;
				cleanup();
				resolve(message.devices);
				return;
			}
			if (message.type === "stopped" && stopping) {
				terminal = true;
				cleanup();
				stopResolve?.();
				return;
			}
			if (message.type === "audio" && typeof message.audio === "string") {
				try {
					if (message.audio.length > 4_300) throw new Error(CAPTURE_ERROR);
					const pcm = Buffer.from(message.audio, "base64");
					if (pcm.length !== 3200) throw new Error(CAPTURE_ERROR);
					options.onAudio(pcm);
					if (!stopping) send({ type: "ack" });
				} catch {
					fail(new Error(CAPTURE_ERROR));
				}
			}
			if (message.type === "ready" && !ready) {
				ready = true;
				clearTimeout(startupTimer);
				resolve({
					stop() {
						if (stopping) return stopping;
						if (terminal) return Promise.reject(new Error(CAPTURE_ERROR));
						stopping = new Promise<void>((done, failed) => {
							stopResolve = done;
							stopReject = failed;
							stopTimer = setTimeout(
								() => fail(new Error("Microphone did not respond to stop. Recording was cancelled.")),
								helper.stopTimeoutMs ?? 2_000,
							);
							send({ type: "stop" });
						});
						return stopping;
					},
					cancel,
				});
			}
		});
		send({ type: mode, device: options.device });
	});
}
