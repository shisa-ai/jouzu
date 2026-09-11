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
const MACHINE_READABLE_MODES = new Set(["json", "rpc"]);

/**
 * True when Pi writes a protocol or event stream to stdout. Callers that decorate process output
 * must pass these modes through byte-exact.
 */
export function usesMachineReadableStdout(args: string[]): boolean {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--mode") {
			if (MACHINE_READABLE_MODES.has(args[index + 1] ?? "")) return true;
			index += 1;
			continue;
		}
		if (arg.startsWith("--mode=") && MACHINE_READABLE_MODES.has(arg.slice("--mode=".length))) return true;
	}
	return false;
}

export interface InteractiveStartupContext {
	stdinIsTTY?: boolean;
	stdoutIsTTY?: boolean;
	env?: NodeJS.ProcessEnv;
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
