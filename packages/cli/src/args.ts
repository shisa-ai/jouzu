export const PROFILE_IDS = ["core", "ja"] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

export class UsageError extends Error {
	readonly exitCode = 2;

	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

export interface JouzuOptions {
	home?: string;
	profile?: ProfileId;
}

export type ParsedCommand =
	| { kind: "pi"; options: JouzuOptions; args: string[] }
	| { kind: "doctor"; options: JouzuOptions; json: boolean }
	| { kind: "version"; options: JouzuOptions }
	| { kind: "help"; options: JouzuOptions }
	| {
			kind: "self-update";
			options: JouzuOptions;
			operation: "status" | "check" | "apply" | "policy";
			json: boolean;
			policy?: "auto-restart" | "notify" | "off";
	  }
	| {
			kind: "keybindings";
			options: JouzuOptions;
			operation: "status" | "plan" | "apply" | "reset";
			json: boolean;
	  }
	| {
			kind: "profile";
			options: JouzuOptions;
			operation: "plan" | "apply";
			profile?: ProfileId;
			json: boolean;
	  };

function readOptionValue(args: string[], index: number, option: string): { value: string; next: number } {
	const token = args[index];
	const equalsPrefix = `${option}=`;
	if (token.startsWith(equalsPrefix)) {
		const value = token.slice(equalsPrefix.length);
		if (!value) throw new UsageError(`${option} requires a value`);
		return { value, next: index + 1 };
	}
	if (token !== option) throw new UsageError(`internal parser error for ${option}`);
	const value = args[index + 1];
	if (value === undefined || value.length === 0) throw new UsageError(`${option} requires a value`);
	return { value, next: index + 2 };
}

function parseSelfUpdateCommand(options: JouzuOptions, args: string[]): ParsedCommand {
	const [operation = "status", ...remaining] = args;
	if (operation !== "status" && operation !== "check" && operation !== "apply" && operation !== "policy") {
		throw new UsageError('self-update requires "status", "check", "apply", or "policy"');
	}
	if (operation === "policy") {
		const [policy, ...extra] = remaining;
		if (policy !== "auto-restart" && policy !== "notify" && policy !== "off") {
			throw new UsageError("self-update policy must be one of: auto-restart, notify, off");
		}
		if (extra.length > 0) throw new UsageError("self-update policy accepts exactly one value");
		return { kind: "self-update", options, operation, json: false, policy };
	}
	let json = false;
	for (const token of remaining) {
		if (token !== "--json" || json || operation === "apply") {
			throw new UsageError(`unknown self-update ${operation} option: ${token}`);
		}
		json = true;
	}
	return { kind: "self-update", options, operation, json };
}

function parseKeybindingsCommand(options: JouzuOptions, args: string[]): ParsedCommand {
	const [operation = "status", ...remaining] = args;
	if (operation !== "status" && operation !== "plan" && operation !== "apply" && operation !== "reset") {
		throw new UsageError('keybindings requires "status", "plan", "apply", or "reset"');
	}
	let json = false;
	for (const token of remaining) {
		if (token !== "--json" || json || operation === "apply" || operation === "reset") {
			throw new UsageError(`unknown keybindings ${operation} option: ${token}`);
		}
		json = true;
	}
	return { kind: "keybindings", options, operation, json };
}

function parseProfileCommand(options: JouzuOptions, args: string[]): ParsedCommand {
	if (options.profile !== undefined) {
		throw new UsageError("use profile --profile <core|ja>; do not mix it with --jouzu-profile");
	}
	const [operation, ...remaining] = args;
	if (operation !== "plan" && operation !== "apply") {
		throw new UsageError('profile requires "plan" or "apply"');
	}
	let profile: ProfileId | undefined;
	let json = false;
	for (let index = 0; index < remaining.length; index += 1) {
		const token = remaining[index];
		if (token === "--profile" || token.startsWith("--profile=")) {
			if (profile !== undefined) throw new UsageError("--profile may be specified only once");
			const parsed = readOptionValue(remaining, index, "--profile");
			if (!PROFILE_IDS.includes(parsed.value as ProfileId)) {
				throw new UsageError(`--profile must be one of: ${PROFILE_IDS.join(", ")}`);
			}
			profile = parsed.value as ProfileId;
			index = parsed.next - 1;
			continue;
		}
		if (token === "--json" && operation === "plan") {
			if (json) throw new UsageError("--json may be specified only once");
			json = true;
			continue;
		}
		throw new UsageError(`unknown profile ${operation} option: ${token}`);
	}
	return { kind: "profile", options, operation, ...(profile ? { profile } : {}), json };
}

export function parseJouzuArgs(args: string[]): ParsedCommand {
	const options: JouzuOptions = {};
	let index = 0;

	while (index < args.length) {
		const token = args[index];
		if (token === "--jouzu-home" || token.startsWith("--jouzu-home=")) {
			if (options.home !== undefined) throw new UsageError("--jouzu-home may be specified only once");
			const parsed = readOptionValue(args, index, "--jouzu-home");
			options.home = parsed.value;
			index = parsed.next;
			continue;
		}
		if (token === "--jouzu-profile" || token.startsWith("--jouzu-profile=")) {
			if (options.profile !== undefined) throw new UsageError("--jouzu-profile may be specified only once");
			const parsed = readOptionValue(args, index, "--jouzu-profile");
			if (!PROFILE_IDS.includes(parsed.value as ProfileId)) {
				throw new UsageError(`--jouzu-profile must be one of: ${PROFILE_IDS.join(", ")}`);
			}
			options.profile = parsed.value as ProfileId;
			index = parsed.next;
			continue;
		}
		if (token.startsWith("--jouzu-")) throw new UsageError(`unknown Jouzu option: ${token}`);
		break;
	}

	const remaining = args.slice(index);
	const [command, ...rest] = remaining;
	if (command === "pi" || command === "--") return { kind: "pi", options, args: rest };
	if (command === "doctor") {
		let json = false;
		for (const token of rest) {
			if (token !== "--json" || json) throw new UsageError(`doctor does not accept ${token}`);
			json = true;
		}
		return { kind: "doctor", options, json };
	}
	if (command === "profile") return parseProfileCommand(options, rest);
	if (command === "keybindings") return parseKeybindingsCommand(options, rest);
	if (command === "self-update") return parseSelfUpdateCommand(options, rest);
	if (command === "--version" || command === "-v") {
		if (rest.length > 0) throw new UsageError(`${command} does not accept arguments; use "jouzu pi ${command}" for Pi`);
		return { kind: "version", options };
	}
	if (command === "--help" || command === "-h") {
		if (rest.length > 0) throw new UsageError(`${command} does not accept arguments; use "jouzu pi ${command}" for Pi`);
		return { kind: "help", options };
	}
	return { kind: "pi", options, args: remaining };
}

export function isBlockedPiSelfUpdate(args: string[]): boolean {
	if (args[0] !== "update") return false;
	const updateArgs = args.slice(1);
	if (updateArgs.length === 0) return true;
	if (updateArgs.some((arg) => arg === "--all" || arg === "--self")) return true;

	let hasExtensionOrModelTarget = false;
	let positionalTarget: string | undefined;
	for (let index = 0; index < updateArgs.length; index += 1) {
		const arg = updateArgs[index];
		if (arg === "--extensions" || arg === "--models") {
			hasExtensionOrModelTarget = true;
			continue;
		}
		if (arg === "--extension") {
			if (updateArgs[index + 1] !== undefined) {
				hasExtensionOrModelTarget = true;
				index += 1;
			}
			continue;
		}
		if (arg.startsWith("--extension=")) {
			hasExtensionOrModelTarget = arg.length > "--extension=".length;
			continue;
		}
		if (!arg.startsWith("-")) {
			positionalTarget ??= arg;
		}
	}

	if (positionalTarget === "self" || positionalTarget === "pi") return true;
	return !hasExtensionOrModelTarget && positionalTarget === undefined;
}

export function formatHelp(): string {
	return `Jouzu agentic AI environment

Usage:
  jouzu [--jouzu-home <path>] [--jouzu-profile <core|ja>] [Pi arguments...]
  jouzu --session <id> [Pi arguments...]
  jouzu [Jouzu options] pi [Pi arguments...]
  jouzu [Jouzu options] -- [Pi arguments...]
  jouzu [Jouzu options] doctor [--json]
  jouzu profile plan [--profile <core|ja>] [--json]
  jouzu profile apply [--profile <core|ja>]
  jouzu keybindings status [--json]
  jouzu keybindings plan [--json]
  jouzu keybindings apply
  jouzu keybindings reset
  jouzu self-update status [--json]
  jouzu self-update check [--json]
  jouzu self-update apply
  jouzu self-update policy <auto-restart|notify|off>
  jouzu [Jouzu options] --version

Commands:
  doctor        Show non-mutating runtime and isolation diagnostics
  profile plan  Preview safe Core/JA profile changes without writing
  profile apply Apply the selected profile with conflicts and backups
  keybindings   Inspect, apply, or reset Jouzu's Pi-compatible key defaults
  self-update   Inspect, check, apply, or configure Jouzu npm updates
  pi, --        Explicitly pass all remaining arguments to pinned Pi

The jz command is an exact alias. Resume with the jz --session command printed
on exit; Jouzu resolves its isolated session root. First interactive launch asks before enabling
the optional JA profile; Core is the safe fallback. Interactive launches clear
the viewport and show the Jouzu header;
set JOUZU_NO_CLEAR=1 to preserve the existing screen. The Jouzu Models view opens
through /model or Ctrl+L. Use "jouzu pi --help" for Pi CLI help.`;
}
