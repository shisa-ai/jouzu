#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { parseJouzuArgs, UsageError } from "./args.js";
import { isInteractivePiStartup } from "./interactive-startup.js";
import { loadMetadata } from "./metadata.js";
import { resolveJouzuPaths } from "./paths.js";
import { formatUpdateStatus, JouzuUpdater, relaunchUpdatedJouzu, UpdateError } from "./updater.js";

function createUpdater(args: ReturnType<typeof parseJouzuArgs>) {
	const paths = resolveJouzuPaths({ homeOverride: args.options.home });
	const metadata = loadMetadata();
	const executable = process.argv[1] ?? fileURLToPath(import.meta.url);
	return {
		metadata,
		executable,
		updater: new JouzuUpdater({
			paths,
			currentVersion: metadata.jouzuVersion,
			executable,
			report: (message) => console.log(message),
		}),
	};
}

async function runBootstrap(args: string[]): Promise<void> {
	const parsed = parseJouzuArgs(args);
	if (parsed.kind === "self-update") {
		const { updater } = createUpdater(parsed);
		if (parsed.operation === "policy") {
			if (!parsed.policy) throw new UsageError("self-update policy requires a value");
			const state = updater.setPolicy(parsed.policy);
			console.log(`Jouzu self-update policy: ${state.policy}`);
			return;
		}
		if (parsed.operation === "check") {
			const result = updater.check();
			if (parsed.json) console.log(JSON.stringify(result, null, 2));
			else if (result.status === "available") {
				console.log(`Jouzu ${result.version} is available (installed ${result.installedVersion})`);
			} else {
				console.log(`Jouzu ${result.installedVersion} is current (latest ${result.version})`);
			}
			return;
		}
		if (parsed.operation === "apply") {
			const result = updater.apply();
			console.log(
				result.changed
					? `Updated Jouzu to ${result.version}. Restart Jouzu to use the new version.`
					: `Jouzu ${result.version} is already current.`,
			);
			return;
		}
		const status = updater.status();
		console.log(parsed.json ? JSON.stringify(status, null, 2) : formatUpdateStatus(status));
		return;
	}

	const interactiveStartup = parsed.kind === "pi" && isInteractivePiStartup(parsed.args);
	if (interactiveStartup) {
		const { metadata, executable, updater } = createUpdater(parsed);
		const startupUpdate = updater.startup();
		delete process.env.JOUZU_INTERNAL_UPDATE_RESTARTED;
		if (startupUpdate.message) console.error(startupUpdate.message);
		if (startupUpdate.action === "restart") {
			console.log(`Updated Jouzu ${metadata.jouzuVersion} → ${startupUpdate.version}; restarting…`);
			process.exitCode = relaunchUpdatedJouzu({ executable, args, env: process.env });
			return;
		}
	}

	const main = await import("./main-cli.js");
	await main.runMainCli(args);
}

runBootstrap(process.argv.slice(2)).catch(async (error: unknown) => {
	if (error instanceof UpdateError) {
		console.error(`Jouzu update failed: ${error.message}`);
		process.exitCode = error.exitCode;
		return;
	}
	if (error instanceof UsageError) {
		console.error(`Error: ${error.message}`);
		console.error('Run "jouzu --help" for Jouzu usage or "jouzu pi --help" for Pi usage.');
		process.exitCode = error.exitCode;
		return;
	}
	try {
		const main = await import("./main-cli.js");
		main.handleMainCliError(error);
	} catch {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Jouzu failed: ${message}`);
		process.exitCode = 1;
	}
});
