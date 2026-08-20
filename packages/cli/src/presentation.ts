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

function envFlagIsTrue(value: string | undefined): boolean {
	return value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function shouldClearInteractiveStartup(args: string[], context: InteractiveStartupContext = {}): boolean {
	const env = context.env ?? process.env;
	const stdinIsTTY = context.stdinIsTTY ?? process.stdin.isTTY === true;
	const stdoutIsTTY = context.stdoutIsTTY ?? process.stdout.isTTY === true;
	if (!stdinIsTTY || !stdoutIsTTY || env.TERM === "dumb" || envFlagIsTrue(env.JOUZU_NO_CLEAR)) return false;
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

export function clearInteractiveStartup(args: string[], context: InteractiveStartupContext = {}): boolean {
	if (!shouldClearInteractiveStartup(args, context)) return false;
	process.stdout.write(CLEAR_SCREEN_SEQUENCE);
	return true;
}

function fit(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length <= width) return text;
	if (width === 1) return "…";
	return `${text.slice(0, width - 1)}…`;
}

function bannerLines(theme: Theme, metadata: JouzuMetadata, width: number): string[] {
	const title = fit("J O U Z U", width);
	const subtitle = fit("Japanese-first Pi environment", width);
	const versions = fit(`jouzu ${metadata.jouzuVersion}  ·  pi ${metadata.piVersion}`, width);
	const hints = fit("/model choose  ·  /hotkeys shortcuts  ·  /jouzu status", width);
	return [
		theme.bold(theme.fg("accent", title)),
		theme.fg("muted", subtitle),
		theme.fg("dim", versions),
		theme.fg("dim", hints),
	];
}

export function createJouzuPresentationExtension(metadata: JouzuMetadata, profile: ProfileSelection): InlineExtension {
	return {
		name: "jouzu",
		factory: (pi) => {
			pi.on("session_start", (_event, ctx) => {
				if (ctx.mode !== "tui") return;
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
					render: (width) => bannerLines(theme, metadata, width),
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
