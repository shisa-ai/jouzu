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
	| { kind: "doctor"; options: JouzuOptions }
	| { kind: "version"; options: JouzuOptions }
	| { kind: "help"; options: JouzuOptions }
	| { kind: "profile"; options: JouzuOptions; args: string[] };

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
		if (rest.length > 0) throw new UsageError("doctor does not accept arguments in this development build");
		return { kind: "doctor", options };
	}
	if (command === "profile") return { kind: "profile", options, args: rest };
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
	return `Jouzu development launcher

Usage:
  jouzu [--jouzu-home <path>] [--jouzu-profile <core|ja>] [Pi arguments...]
  jouzu [Jouzu options] pi [Pi arguments...]
  jouzu [Jouzu options] -- [Pi arguments...]
  jouzu [Jouzu options] doctor
  jouzu [Jouzu options] --version

Commands:
  doctor        Show non-mutating runtime and isolation diagnostics
  pi, --        Explicitly pass all remaining arguments to pinned Pi

The jz command is an exact alias. Pi's model picker remains available through
/model or Ctrl+L. Profile plan/apply will be added before v0.1.
Use "jouzu pi --help" for the pinned Pi CLI help.`;
}
