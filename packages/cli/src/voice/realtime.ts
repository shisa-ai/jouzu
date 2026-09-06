import WebSocket from "ws";
import { VoiceError } from "./errors.js";
import { VoiceTranscript } from "./transcript.js";

export const VOICE_ENDPOINT = "wss://api.shisa.ai/ws/asr/realtime";
export const MAX_AUDIO_BUFFER_BYTES = 256_000;
export type VoiceLanguage = "auto" | "ja" | "en" | "zh";

export interface VoiceConnection {
	sendAudio(pcm: Buffer): void;
	finish(): Promise<string>;
	cancel(): void;
}

export interface VoiceConnectionOptions {
	apiKey: string;
	language: VoiceLanguage;
	signal: AbortSignal;
	onPreview(text: string): void;
	onError(error: Error): void;
	/** Local protocol-test seam; the interactive command uses the fixed Shisa endpoint. */
	endpoint?: string;
	connectTimeoutMs?: number;
	finishTimeoutMs?: number;
}

export function connectVoice(options: VoiceConnectionOptions): Promise<VoiceConnection> {
	return new Promise((resolve, reject) => {
		if (options.signal.aborted) {
			reject(new Error("Voice recording cancelled."));
			return;
		}
		const socket = new WebSocket(options.endpoint ?? VOICE_ENDPOINT, {
			headers: { Authorization: `Bearer ${options.apiKey}` },
			maxPayload: 128_000,
			perMessageDeflate: false,
			handshakeTimeout: options.connectTimeoutMs ?? 10_000,
			followRedirects: false,
		});
		const transcript = new VoiceTranscript();
		let opened = false;
		let terminal = false;
		let finishing: Promise<string> | undefined;
		let finishResolve: ((text: string) => void) | undefined;
		let finishReject: ((error: Error) => void) | undefined;
		let finishTimer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			clearTimeout(finishTimer);
			options.signal.removeEventListener("abort", cancel);
		};
		const fail = (error: Error) => {
			if (terminal) return;
			terminal = true;
			cleanup();
			socket.terminate();
			if (!opened) reject(error);
			else if (finishReject) finishReject(error);
			else options.onError(error);
		};
		const cancel = () => {
			if (terminal) return;
			terminal = true;
			cleanup();
			socket.terminate();
			const error = new Error("Voice recording cancelled.");
			if (!opened) reject(error);
			finishReject?.(error);
		};
		const send = (value: unknown) => {
			if (terminal || socket.readyState !== WebSocket.OPEN) throw new Error("Voice connection is closed.");
			if (socket.bufferedAmount > MAX_AUDIO_BUFFER_BYTES) {
				const error = new VoiceError("Voice network upload is too slow. Check your connection and try again.");
				fail(error);
				throw error;
			}
			socket.send(JSON.stringify(value), (error) => {
				if (error) fail(new VoiceError("Voice network upload failed. Check your connection and try again."));
			});
		};
		options.signal.addEventListener("abort", cancel, { once: true });
		socket.on("unexpected-response", (_request, response) => {
			response.resume();
			const message =
				response.statusCode === 401
					? "Voice authentication failed. Check SHISA_API_KEY."
					: response.statusCode === 403
						? "Voice access denied. Your Shisa key needs shisa/asr-realtime access."
						: "Voice connection was rejected. Check service availability and try again.";
			fail(new VoiceError(message));
		});
		socket.on("error", () => fail(new VoiceError("Voice connection failed. Check your network and Shisa access.")));
		socket.on("message", (data, binary) => {
			if (terminal) return;
			try {
				if (binary) throw new Error("invalid response");
				const event: unknown = JSON.parse(data.toString());
				if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("invalid response");
				const record = event as Record<string, unknown>;
				if (record.type === "error") {
					// Never echo remote error bodies: they may contain credentials or terminal controls.
					fail(new VoiceError("Voice transcription failed. Check Shisa service access and try again."));
					return;
				}
				if (options.apiKey && typeof record.text === "string") {
					record.text = record.text.replaceAll(options.apiKey, "[redacted]");
				}
				transcript.accept(record);
				if (record.type === "asr.partial_result" || record.type === "asr.final_result") {
					options.onPreview(transcript.preview);
				}
			} catch {
				fail(new VoiceError("Voice returned an invalid or oversized transcript. Try a shorter recording."));
			}
		});
		socket.on("close", (code) => {
			if (terminal) return;
			if (!finishing || code !== 1000) {
				fail(new VoiceError("Voice connection ended before transcription finished. Try recording again."));
				return;
			}
			terminal = true;
			cleanup();
			finishResolve?.(transcript.text);
		});
		socket.once("open", () => {
			if (terminal) return;
			try {
				send({
					type: "session.update",
					session: {
						input_audio_format: "pcm_s16le",
						sample_rate: 16000,
						channels: 1,
						language: options.language,
					},
				});
				opened = true;
				resolve({
					sendAudio(pcm) {
						if (finishing) return;
						if (pcm.length !== 3200) throw new Error("Voice capture returned an invalid audio frame.");
						send({ type: "input_audio.append", audio: pcm.toString("base64") });
					},
					finish() {
						if (finishing) return finishing;
						finishing = new Promise<string>((done, failed) => {
							finishResolve = done;
							finishReject = failed;
							finishTimer = setTimeout(
								() => fail(new Error("Voice finalization timed out. Try a shorter recording.")),
								options.finishTimeoutMs ?? 30_000,
							);
							try {
								send({ type: "session.close" });
							} catch (error) {
								failed(error);
								cleanup();
							}
						});
						return finishing;
					},
					cancel,
				});
			} catch {
				fail(new VoiceError("Voice connection could not start. Try again."));
			}
		});
	});
}
