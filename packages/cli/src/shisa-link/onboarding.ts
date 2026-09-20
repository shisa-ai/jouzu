import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { catalogSourceCredentialAvailable, SHISA_API_CATALOG_SOURCE } from "../catalog-sources.js";
import type { JouzuPaths } from "../paths.js";
import { writeFilePrivateExclusive } from "../private-fs.js";
import { detectTerminalColorMode, sanitizeTerminalText } from "../terminal-layout.js";
import { setShisaSignedOut } from "./credentials.js";
import { resolveShisaGatewayUrl } from "./device-flow.js";
import { loginShisa, type ShisaLoginOptions } from "./login.js";

/** Keep account messaging separate from the first-launch decision and login protocol. */
export const SHISA_ONBOARDING_COPY = {
	points: [
		"Connect to Shisa AI for access to the latest open coding models (Qwen, GLM, etc).",
		"New signups get $10 instant credits. Add a credit card for $25 more.",
	],
	question: "Connect now? [y/N] ",
	hint: "(or later with /login shisa)",
	later: "You can connect later with /login shisa.",
};

/** Marks each offer line without relying on color, so a pipe or NO_COLOR keeps the shape. */
const POINT_MARKER = "\u25c6";
const POINT_PREFIX_WIDTH = 4;

export function shisaOnboardingPath(paths: JouzuPaths): string {
	return join(paths.stateDir, "shisa-onboarding.json");
}

export interface ShisaOnboardingOptions extends Omit<ShisaLoginOptions, "gatewayUrl"> {
	interactive: boolean;
	env?: NodeJS.ProcessEnv;
	input?: NodeJS.ReadableStream;
	output?: NodeJS.WritableStream & { columns?: number; isTTY?: boolean };
	signal?: AbortSignal;
	colorEnabled?: boolean;
	ask?: (question: string, signal: AbortSignal) => Promise<string>;
}

/** Offer only in an interactive launcher, before Pi builds its credential/model snapshot. */
export async function offerShisaOnboarding(options: ShisaOnboardingOptions): Promise<void> {
	const env = options.env ?? process.env;
	if (
		!options.interactive ||
		existsSync(shisaOnboardingPath(options.paths)) ||
		catalogSourceCredentialAvailable(SHISA_API_CATALOG_SOURCE, env, options.paths)
	)
		return;

	const output = options.output ?? process.stdout;
	const columns = () => Math.max(12, output.columns || 80);
	const write = (message: string) => {
		output.write(`${wrapTextWithAnsi(sanitizeTerminalText(message), columns()).join("\n")}\n`);
	};
	// Styling wraps sanitized text: `sanitizeTerminalText` removes escape sequences, so
	// color applied before it would be stripped along with anything the copy inherited.
	const colorEnabled =
		options.colorEnabled ?? (output.isTTY === true && detectTerminalColorMode({ env, stdoutIsTTY: true }) !== "none");
	const style = (value: string, code: string) => (colorEnabled ? `\u001b[${code}m${value}\u001b[0m` : value);
	const writePoint = (message: string) => {
		const width = Math.max(8, columns() - POINT_PREFIX_WIDTH);
		const lines = wrapTextWithAnsi(sanitizeTerminalText(message), width);
		for (const [index, line] of lines.entries())
			output.write(index === 0 ? `  ${style(POINT_MARKER, "36")} ${line}\n` : `    ${line}\n`);
	};
	const controller = new AbortController();
	const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
	const readline = options.ask ? undefined : createInterface({ input: options.input ?? process.stdin, output });
	const cancel = () => controller.abort();
	readline?.on("SIGINT", cancel);
	readline?.on("close", cancel);
	process.on("SIGINT", cancel);
	try {
		output.write("\n");
		for (const point of SHISA_ONBOARDING_COPY.points) writePoint(point);
		output.write("\n");
		const question = `  ${SHISA_ONBOARDING_COPY.question}${style(SHISA_ONBOARDING_COPY.hint, "2")} `;
		const answer = options.ask ? await options.ask(question, signal) : await readline?.question(question, { signal });
		signal.throwIfAborted();
		const connect = /^(?:y|yes)$/iu.test((answer ?? "").trim());
		try {
			writeFilePrivateExclusive(
				shisaOnboardingPath(options.paths),
				`${JSON.stringify({ schemaVersion: 1, choice: connect ? "connect" : "skip", decidedAt: new Date().toISOString() })}\n`,
				options.paths.stateDir,
			);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EEXIST") return;
			write("Could not save the Shisa setup choice. Check Jouzu's storage permissions.");
			write(SHISA_ONBOARDING_COPY.later);
			return;
		}
		if (!connect) {
			write(SHISA_ONBOARDING_COPY.later);
			return;
		}
		write("Open the link below and approve this device in your browser. Press Ctrl+C to cancel sign-in.");
		await loginShisa(
			{
				signal,
				onDeviceCode: ({ verificationUri, userCode }) => {
					// Keep the link intact for copying; the terminal handles its visual wrapping.
					output.write(`${sanitizeTerminalText(verificationUri)}\n`);
					write(`Device code: ${userCode}`);
				},
				onAuth: ({ url }) => output.write(`${sanitizeTerminalText(url)}\n`),
				onPrompt: async () => {
					throw new Error("Unexpected Shisa sign-in prompt.");
				},
				onSelect: async () => undefined,
				onProgress: write,
			},
			{ ...options, gatewayUrl: resolveShisaGatewayUrl(env) },
		);
		setShisaSignedOut(options.paths, false);
		write("Signed in to Shisa AI.");
	} catch (error) {
		// Remote errors can contain credentials; keep startup recovery messages local.
		const storageError = "Could not save Shisa sign-in. Check Jouzu's storage permissions and sign in again.";
		write(
			signal.aborted
				? "Shisa sign-in cancelled."
				: error instanceof Error && error.message === storageError
					? storageError
					: "Shisa sign-in could not complete.",
		);
		write(SHISA_ONBOARDING_COPY.later);
	} finally {
		process.off("SIGINT", cancel);
		readline?.close();
	}
}
