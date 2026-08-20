import { basename } from "node:path";
import type { InlineExtension, Theme } from "@earendil-works/pi-coding-agent";
import type { JouzuMetadata } from "./metadata.js";
import type { ProfileSelection } from "./runtime.js";

export const CLEAR_SCREEN_SEQUENCE = "\u001b[2J\u001b[H";

const NON_INTERACTIVE_COMMANDS = new Set(["auth", "config", "install", "list", "remove", "uninstall", "update"]);
const NON_INTERACTIVE_FLAGS = new Set([
	"-h",
	"--help",
	"-p",
	"--print",
	"-v",
	"--version",
	"--list-models",
	"--export",
]);
const NON_INTERACTIVE_MODES = new Set(["json", "print", "rpc"]);

export interface InteractiveStartupContext {
	stdinIsTTY?: boolean;
	stdoutIsTTY?: boolean;
	env?: NodeJS.ProcessEnv;
}

export type BannerColorMode = "truecolor" | "256" | "16" | "none";

export interface BannerRenderOptions {
	colorMode?: BannerColorMode;
	colorDepth?: number;
	env?: NodeJS.ProcessEnv;
}

function envFlagIsTrue(value: string | undefined): boolean {
	return value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function isInteractivePiStartup(args: string[], context: InteractiveStartupContext = {}): boolean {
	const env = context.env ?? process.env;
	const stdinIsTTY = context.stdinIsTTY ?? process.stdin.isTTY === true;
	const stdoutIsTTY = context.stdoutIsTTY ?? process.stdout.isTTY === true;
	if (!stdinIsTTY || !stdoutIsTTY || env.TERM === "dumb") return false;
	if (args.length > 0 && NON_INTERACTIVE_COMMANDS.has(args[0])) return false;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (NON_INTERACTIVE_FLAGS.has(arg) || arg.startsWith("--export=")) return false;
		if (arg === "--mode") {
			if (NON_INTERACTIVE_MODES.has(args[index + 1] ?? "")) return false;
			index += 1;
			continue;
		}
		if (arg.startsWith("--mode=") && NON_INTERACTIVE_MODES.has(arg.slice("--mode=".length))) return false;
	}
	return true;
}

export function shouldClearInteractiveStartup(args: string[], context: InteractiveStartupContext = {}): boolean {
	const env = context.env ?? process.env;
	return isInteractivePiStartup(args, context) && !envFlagIsTrue(env.JOUZU_NO_CLEAR);
}

export function clearInteractiveStartup(args: string[], context: InteractiveStartupContext = {}): boolean {
	if (!shouldClearInteractiveStartup(args, context)) return false;
	process.stdout.write(CLEAR_SCREEN_SEQUENCE);
	return true;
}

const BRAILLE_MARK = ["⠈⢹ ⡎⢱ ⡇⢸ ⢉⠝ ⡇⢸", "⠣⠜ ⠣⠜ ⠣⠜ ⠮⠤ ⠣⠜"] as const;
const BRAILLE_MIN_WIDTH = 16;
const ANSI_RESET = "\u001b[0m";

function fit(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length <= width) return text;
	if (width === 1) return "…";
	return `${text.slice(0, width - 1)}…`;
}

export function detectBannerColorMode(options: BannerRenderOptions = {}): BannerColorMode {
	const env = options.env ?? process.env;
	if (env.NO_COLOR !== undefined || env.TERM === "dumb") return "none";
	const colorDepth =
		options.colorDepth ??
		(process.stdout.isTTY && typeof process.stdout.getColorDepth === "function"
			? process.stdout.getColorDepth(env)
			: undefined);
	if ((colorDepth ?? 0) >= 24 || /^(truecolor|24bit)$/i.test(env.COLORTERM ?? "")) return "truecolor";
	if ((colorDepth ?? 0) >= 8 || /256color/i.test(env.TERM ?? "")) return "256";
	if ((colorDepth ?? 0) >= 4 || (env.TERM !== undefined && env.TERM !== "")) return "16";
	return "none";
}

function colorizeMark(line: string, mode: BannerColorMode): string {
	if (mode === "none") return line;
	const characters = Array.from(line);
	const glyphCount = characters.filter((character) => character !== " ").length;
	let glyphIndex = 0;
	return characters
		.map((character) => {
			if (character === " ") return character;
			const ratio = glyphCount <= 1 ? 0 : glyphIndex / (glyphCount - 1);
			glyphIndex += 1;
			if (mode === "truecolor") {
				const start = [34, 211, 238] as const;
				const end = [244, 114, 182] as const;
				const [red, green, blue] = start.map((value, index) => Math.round(value + (end[index] - value) * ratio));
				return `\u001b[38;2;${red};${green};${blue}m${character}${ANSI_RESET}`;
			}
			if (mode === "256") {
				const palette = [45, 81, 117, 141, 177, 213];
				const color = palette[Math.min(palette.length - 1, Math.round(ratio * (palette.length - 1)))];
				return `\u001b[38;5;${color}m${character}${ANSI_RESET}`;
			}
			const palette = [96, 94, 95];
			const color = palette[Math.min(palette.length - 1, Math.round(ratio * (palette.length - 1)))];
			return `\u001b[${color}m${character}${ANSI_RESET}`;
		})
		.join("");
}

export function renderBannerLines(
	theme: Theme,
	metadata: JouzuMetadata,
	width: number,
	colorMode: BannerColorMode,
): string[] {
	const subtitle = fit(metadata.productLabel, width);
	const versions = fit(`jouzu ${metadata.jouzuVersion}  ·  pi ${metadata.piVersion}`, width);
	const hints = fit("/model choose  ·  /hotkeys shortcuts  ·  /jouzu status", width);
	const details =
		colorMode === "none"
			? [subtitle, versions, hints]
			: [theme.fg("muted", subtitle), theme.fg("dim", versions), theme.fg("dim", hints)];
	if (width < BRAILLE_MIN_WIDTH) return [fit("J O U Z U", width), ...details];
	return [...BRAILLE_MARK.map((line) => colorizeMark(line, colorMode)), ...details];
}

export function createJouzuPresentationExtension(
	metadata: JouzuMetadata,
	profile: ProfileSelection,
	options: BannerRenderOptions = {},
): InlineExtension {
	return {
		name: "jouzu",
		factory: (pi) => {
			pi.on("session_start", (_event, ctx) => {
				if (ctx.mode !== "tui") return;
				const colorMode = options.colorMode ?? detectBannerColorMode(options);
				ctx.ui.setTitle(`Jouzu - ${basename(ctx.cwd) || "workspace"}`);
				ctx.ui.setWorkingIndicator({
					frames: [
						ctx.ui.theme.fg("dim", "·"),
						ctx.ui.theme.fg("muted", "•"),
						ctx.ui.theme.fg("accent", "●"),
						ctx.ui.theme.fg("muted", "•"),
					],
					intervalMs: 120,
				});
				ctx.ui.setHeader((_tui, theme) => ({
					render: (width) => renderBannerLines(theme, metadata, width, colorMode),
					invalidate() {},
				}));
			});

			pi.registerCommand("jouzu", {
				description: "Show the active Jouzu, Pi, profile, and model tuple",
				handler: async (_args, ctx) => {
					const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "not selected";
					const applied = profile.appliedManifestSha256 ? "applied" : "not applied";
					ctx.ui.notify(
						`Jouzu ${metadata.jouzuVersion} · Pi ${metadata.piVersion} · profile ${profile.id} (${applied}) · model ${model}`,
						"info",
					);
				},
			});
		},
	};
}
