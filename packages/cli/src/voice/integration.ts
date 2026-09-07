import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { type KeyId, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createJouzuKeybindingsManager, effectiveJouzuKeys, isPrintableKeyId } from "../jouzu-keybindings.js";
import type { JouzuPaths } from "../paths.js";
import { fitTerminalText, sanitizeTerminalText } from "../terminal-layout.js";
import type { CaptureOptions, VoiceCapture } from "./capture.js";
import { VoiceError } from "./errors.js";
import type { VoiceConnection, VoiceConnectionOptions, VoiceLanguage } from "./realtime.js";
import { VoiceReviewRequired, type VoiceSnapshot } from "./transcript.js";

export type VoiceState = "starting" | "recording" | "finishing";
export interface VoiceDependencies {
	connect(options: VoiceConnectionOptions): Promise<VoiceConnection>;
	capture(options: CaptureOptions): Promise<VoiceCapture>;
	devices(signal: AbortSignal): Promise<string[]>;
	env: NodeJS.ProcessEnv;
	maxRecordingMs: number;
}

const defaults: VoiceDependencies = {
	connect: async (options) => (await import("./realtime.js")).connectVoice(options),
	capture: async (options) => (await import("./capture.js")).startVoiceCapture(options),
	devices: async (signal) => (await import("./capture.js")).listVoiceDevices(signal),
	env: process.env,
	maxRecordingMs: 10 * 60_000,
};

export function renderVoiceWidget(
	state: VoiceState,
	preview: string,
	width: number,
	snapshot?: VoiceSnapshot,
): string[] {
	if (width < 12) return [fitTerminalText("Voice", width)];
	const status =
		state === "starting"
			? "Voice: connecting…"
			: state === "recording"
				? "Voice: recording"
				: "Voice: finishing transcription…";
	return [
		...wrapTextWithAnsi(status, width),
		...wrapTextWithAnsi(
			state === "recording" ? "/voice stop to insert · /voice cancel to discard" : "/voice cancel to discard",
			width,
		),
		...(snapshot?.segments.length
			? [
					...wrapTextWithAnsi(
						`${snapshot.segments.filter((segment) => segment.state === "final").length} finalized · ${snapshot.segments.filter((segment) => segment.state === "pending").length} awaiting final · ${snapshot.segments.filter((segment) => segment.state === "failed").length} failed`,
						width,
					),
					...(snapshot.segments.length > 6
						? [fitTerminalText(`${snapshot.segments.length - 6} earlier chunks retained`, width)]
						: []),
					...snapshot.segments
						.slice(-6)
						.map((segment, index) =>
							fitTerminalText(
								`${{ final: "Final", pending: "Pending", live: "Live", failed: "Failed" }[segment.state]} ${Math.max(0, snapshot.segments.length - 6) + index + 1}: ${sanitizeTerminalText(segment.text) || "…"}`,
								width,
							),
						),
				]
			: preview
				? [fitTerminalText(sanitizeTerminalText(preview).slice(-240), width)]
				: []),
	];
}

export function createVoiceExtension(paths: JouzuPaths, overrides: Partial<VoiceDependencies> = {}): InlineExtension {
	const deps = { ...defaults, ...overrides };
	return {
		name: "jouzu-voice",
		factory(pi) {
			let device = -1;
			let language: VoiceLanguage = "auto";
			let deviceQuery: AbortController | undefined;
			type ActiveRecording = {
				controller: AbortController;
				ctx: ExtensionContext;
				state: VoiceState;
				preview: string;
				snapshot?: VoiceSnapshot;
				connection?: VoiceConnection;
				capture?: VoiceCapture;
				timer?: ReturnType<typeof setTimeout>;
			};
			let run: ActiveRecording | undefined;

			const cancel = () => {
				const old = run;
				run = undefined;
				if (!old) return;
				clearTimeout(old.timer);
				old.controller.abort();
				old.capture?.cancel();
				old.connection?.cancel();
				old.ctx.ui.setWidget("jouzu-voice", undefined);
				old.ctx.ui.setStatus("jouzu-voice", undefined);
			};
			const refresh = () => {
				if (!run) return;
				const active = run;
				active.ctx.ui.setStatus("jouzu-voice", `Voice: ${active.state}`);
				active.ctx.ui.setWidget("jouzu-voice", () => ({
					render: (width) => renderVoiceWidget(active.state, active.preview, width, active.snapshot),
					invalidate() {},
				}));
			};
			const insertIncomplete = (active: ActiveRecording, snapshot: VoiceSnapshot) => {
				const chunks = snapshot.segments.map((segment) => (segment.state === "final" ? segment.text : "[garbled]"));
				// A disconnected tail may have no segment in the last snapshot.
				if (!snapshot.segments.some((segment) => segment.state !== "final")) chunks.push("[garbled]");
				const text = chunks.filter(Boolean).join("\n");
				cancel();
				active.ctx.ui.pasteToEditor(`${active.ctx.ui.getEditorText() ? "\n" : ""}${text}`);
				active.ctx.ui.notify(
					"Voice text inserted with [garbled] for missing speech. Edit the prompt, then press Enter to send.",
					"warning",
				);
			};
			const stop = async () => {
				const active = run;
				if (!active) return;
				if (active.state !== "recording") {
					active.ctx.ui.notify("Voice is still preparing or finishing. Use /voice cancel to discard it.", "info");
					return;
				}
				active.state = "finishing";
				clearTimeout(active.timer);
				refresh();
				try {
					await active.capture?.stop();
					if (run !== active) return;
					const text = await active.connection?.finish();
					if (run !== active) return;
					cancel();
					if (text) {
						// Read the live draft only at insertion time; never restore a stale snapshot.
						active.ctx.ui.pasteToEditor(`${active.ctx.ui.getEditorText() ? "\n" : ""}${text}`);
						active.ctx.ui.notify("Voice text inserted. Review it, then press Enter to send.", "info");
					} else active.ctx.ui.notify("No speech was transcribed. Your prompt is unchanged.", "info");
				} catch (error) {
					if (run !== active) return;
					if (error instanceof VoiceReviewRequired) {
						insertIncomplete(active, error.snapshot);
						return;
					}
					if (active.snapshot?.segments.length) {
						insertIncomplete(active, active.snapshot);
						return;
					}
					cancel();
					active.ctx.ui.notify("Voice could not finish. Your prompt is unchanged; try recording again.", "error");
				}
			};
			const start = async (ctx: ExtensionContext) => {
				if (run || deviceQuery) {
					ctx.ui.notify("Voice is already active. Stop or cancel it first.", "info");
					return;
				}
				const apiKey = deps.env.SHISA_API_KEY;
				if (!apiKey) {
					ctx.ui.notify("Set SHISA_API_KEY with shisa/asr-realtime access before using /voice.", "error");
					return;
				}
				const active: ActiveRecording = { controller: new AbortController(), ctx, state: "starting", preview: "" };
				run = active;
				refresh();
				const onError = (error: Error) => {
					if (run !== active) return;
					if (active.snapshot?.segments.length) {
						insertIncomplete(active, active.snapshot);
						return;
					}
					cancel();
					// Only our capture/transport diagnostics reach this callback, never raw remote/native errors.
					ctx.ui.notify(
						error instanceof VoiceError
							? error.message
							: "Voice could not start. Check your microphone, network, and Shisa access.",
						"error",
					);
				};
				try {
					active.connection = await deps.connect({
						apiKey,
						language,
						signal: active.controller.signal,
						onPreview(text) {
							if (run === active) {
								active.preview = text;
								refresh();
							}
						},
						onSnapshot(snapshot) {
							if (run === active) {
								active.snapshot = snapshot;
								refresh();
							}
						},
						onError,
					});
					if (run !== active) {
						active.connection.cancel();
						return;
					}
					active.capture = await deps.capture({
						device,
						signal: active.controller.signal,
						onAudio(pcm) {
							if (run === active) active.connection?.sendAudio(pcm);
						},
						onError,
					});
					if (run !== active) {
						active.capture.cancel();
						return;
					}
					active.state = "recording";
					active.timer = setTimeout(() => {
						void stop();
					}, deps.maxRecordingMs);
					refresh();
				} catch (error) {
					if (run !== active) return;
					onError(
						error instanceof Error ? error : new Error("Voice could not start. Check your microphone and network."),
					);
				}
			};
			const command = async (args: string, ctx: ExtensionContext) => {
				if (ctx.mode !== "tui" || deps.env.TERM === "dumb") {
					ctx.ui.notify("Voice input requires an interactive terminal on the machine with the microphone.", "error");
					return;
				}
				const action = args.trim();
				if (action === "cancel") {
					deviceQuery?.abort();
					deviceQuery = undefined;
					cancel();
					ctx.ui.notify("Voice cancelled. Your prompt is unchanged.", "info");
				} else if (action === "stop" || (!action && run)) {
					await stop();
				} else if (!action || action === "start") {
					await start(ctx);
				} else if (action === "devices") {
					if (run || deviceQuery) {
						ctx.ui.notify("Stop or cancel voice before choosing a microphone.", "info");
						return;
					}
					const controller = new AbortController();
					deviceQuery = controller;
					try {
						const devices = await deps.devices(controller.signal);
						if (controller.signal.aborted) return;
						const labels = ["Default microphone", ...devices.map((name, i) => `${i}: ${sanitizeTerminalText(name)}`)];
						const choice = await ctx.ui.select("Voice microphone (this machine)", labels, {
							signal: controller.signal,
						});
						if (!controller.signal.aborted && choice !== undefined) device = labels.indexOf(choice) - 1;
					} catch {
						if (!controller.signal.aborted)
							ctx.ui.notify("Could not list microphones. Check audio device and platform support.", "error");
					} finally {
						if (deviceQuery === controller) deviceQuery = undefined;
					}
				} else if (/^language (auto|ja|en|zh)$/.test(action)) {
					if (run) {
						ctx.ui.notify("Stop or cancel voice before changing language.", "info");
						return;
					}
					language = action.slice(9) as VoiceLanguage;
					ctx.ui.notify(`Voice language: ${language}.`, "info");
				} else
					ctx.ui.notify(
						"Use /voice [start|stop|cancel|devices|language auto|language ja|language en|language zh].",
						"info",
					);
			};
			pi.registerCommand("voice", {
				description: "Dictate into the prompt; start, stop, cancel, or configure voice",
				getArgumentCompletions: (prefix) =>
					["start", "stop", "cancel", "devices", "language auto", "language ja", "language en", "language zh"]
						.filter((value) => value.startsWith(prefix))
						.map((value) => ({ value, label: value })),
				handler: command,
			});
			const keybindings = createJouzuKeybindingsManager(paths);
			for (const key of effectiveJouzuKeys(keybindings, "jouzu.voice.toggle")) {
				// Bare keys remain editor input; only modified keys become shortcuts.
				if (!isPrintableKeyId(key))
					pi.registerShortcut(key as KeyId, {
						description: "Start or stop voice dictation",
						handler: (ctx) => command("", ctx),
					});
			}
			pi.on("session_shutdown", () => {
				deviceQuery?.abort();
				deviceQuery = undefined;
				cancel();
			});
		},
	};
}
