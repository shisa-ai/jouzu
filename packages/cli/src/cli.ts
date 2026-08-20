#!/usr/bin/env node

import { formatHelp, isBlockedPiSelfUpdate, parseJouzuArgs, UsageError } from "./args.js";
import { createDoctorReport } from "./doctor.js";
import { loadMetadata } from "./metadata.js";
import { resolveJouzuPaths } from "./paths.js";
import { clearInteractiveStartup, createJouzuPresentationExtension } from "./presentation.js";
import { configurePiProcess, resolveProfileSelection } from "./runtime.js";

async function loadPiRuntime(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
	return import("@earendil-works/pi-coding-agent");
}

async function runCli(args: string[]): Promise<void> {
	const parsed = parseJouzuArgs(args);
	if (parsed.kind === "help") {
		console.log(formatHelp());
		return;
	}
	if (parsed.kind === "profile") {
		throw new UsageError(
			`profile ${parsed.args.join(" ") || "command"} is not available in this development build; the isolated devstack bootstrap can be used now`,
		);
	}
	if (parsed.kind === "pi" && isBlockedPiSelfUpdate(parsed.args)) {
		throw new UsageError(
			"Jouzu pins its Pi runtime and cannot run Pi self-update. Upgrade Jouzu instead; package-only updates such as `jz update --extensions` remain available.",
		);
	}

	const inheritedPiAgentDir = process.env.PI_CODING_AGENT_DIR;
	const inheritedPiSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
	const paths = resolveJouzuPaths({ homeOverride: parsed.options.home });
	const profile = resolveProfileSelection(paths, parsed.options.profile);
	configurePiProcess(paths, profile);
	const metadata = loadMetadata();
	const pi = await loadPiRuntime();
	if (pi.VERSION !== metadata.piVersion) {
		throw new Error(`loaded Pi ${pi.VERSION} does not match Jouzu's exact pin ${metadata.piVersion}`);
	}

	if (parsed.kind === "version") {
		console.log(`jouzu ${metadata.jouzuVersion}`);
		console.log(`pi ${pi.VERSION}`);
		console.log(`profile schema ${metadata.profileSchemaVersion}`);
		return;
	}
	if (parsed.kind === "doctor") {
		const result = createDoctorReport({
			metadata,
			paths,
			profile,
			piRuntimeVersion: pi.VERSION,
			executable: process.argv[1] ?? "unknown",
			inheritedPiAgentDir,
			inheritedPiSessionDir,
		});
		console.log(result.text);
		if (!result.healthy) process.exitCode = 1;
		return;
	}

	clearInteractiveStartup(parsed.args);
	await pi.main(parsed.args, {
		extensionFactories: [createJouzuPresentationExtension(metadata, profile)],
	});
}

runCli(process.argv.slice(2)).catch((error: unknown) => {
	if (error instanceof UsageError) {
		console.error(`Error: ${error.message}`);
		console.error('Run "jouzu --help" for Jouzu usage or "jouzu pi --help" for Pi usage.');
		process.exitCode = error.exitCode;
		return;
	}
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Jouzu failed: ${message}`);
	process.exitCode = 1;
});
