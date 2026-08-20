#!/usr/bin/env node

import { join } from "node:path";
import { formatHelp, isBlockedPiSelfUpdate, parseJouzuArgs, UsageError } from "./args.js";
import { createDoctorReport } from "./doctor.js";
import { loadMetadata } from "./metadata.js";
import { resolveJouzuPaths } from "./paths.js";
import { clearInteractiveStartup, createJouzuPresentationExtension, isInteractivePiStartup } from "./presentation.js";
import { promptForJapaneseSupport, readProfileChoice, writeProfileChoice } from "./profile-choice.js";
import { applyProfile, formatProfilePlan, ProfileConflictError, planProfile } from "./profile-manager.js";
import { loadBundledProfile } from "./profiles.js";
import { configurePiProcess, type ProfileSelection, resolveProfileSelection } from "./runtime.js";

async function loadPiRuntime(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
	return import("@earendil-works/pi-coding-agent");
}

async function runCli(args: string[]): Promise<void> {
	const parsed = parseJouzuArgs(args);
	if (parsed.kind === "help") {
		console.log(formatHelp());
		return;
	}
	if (parsed.kind === "pi" && isBlockedPiSelfUpdate(parsed.args)) {
		throw new UsageError(
			"Jouzu pins its Pi runtime and cannot run Pi self-update. Upgrade Jouzu instead; package-only updates such as `jz update --extensions` remain available.",
		);
	}

	const inheritedPiAgentDir = process.env.PI_CODING_AGENT_DIR;
	const inheritedPiSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
	const paths = resolveJouzuPaths({ homeOverride: parsed.options.home });
	const profileChoicePath = join(paths.stateDir, "profile-choice.json");
	let profile: ProfileSelection = resolveProfileSelection(paths, parsed.options.profile);
	const shouldReadSavedChoice =
		parsed.kind !== "version" &&
		(profile.source === "default" ||
			(parsed.kind === "pi" && profile.source === "profile state" && profile.id === "core"));
	const savedChoice = shouldReadSavedChoice ? readProfileChoice(profileChoicePath) : undefined;
	if (profile.source === "default" && savedChoice) {
		profile = resolveProfileSelection(paths, parsed.options.profile, process.env, savedChoice.profile);
	}
	let firstRunChoice = false;
	if (
		parsed.kind === "pi" &&
		profile.id === "core" &&
		profile.source !== "command line" &&
		profile.source !== "environment" &&
		savedChoice === undefined &&
		isInteractivePiStartup(parsed.args)
	) {
		profile = { id: await promptForJapaneseSupport(), source: "first-run choice" };
		firstRunChoice = true;
	}
	const metadata = loadMetadata();

	if (parsed.kind === "profile") {
		const selected = parsed.profile ?? profile.id;
		const bundled = loadBundledProfile(selected);
		if (parsed.operation === "plan") {
			const plan = planProfile(bundled, paths, metadata.jouzuVersion);
			console.log(parsed.json ? JSON.stringify(plan, null, 2) : formatProfilePlan(plan));
			if (plan.actions.some((action) => action.type === "conflict")) process.exitCode = 3;
			return;
		}
		const result = applyProfile(bundled, paths, metadata.jouzuVersion);
		writeProfileChoice(profileChoicePath, selected);
		console.log(formatProfilePlan(result.plan));
		console.log(result.changed ? `Applied transaction: ${result.transactionId}` : "Profile already converged");
		if (result.backupDir) console.log(`Backups: ${result.backupDir}`);
		return;
	}

	configurePiProcess(paths, profile);
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
		const desiredProfile = loadBundledProfile(profile.id);
		const result = createDoctorReport({
			metadata,
			paths,
			profile,
			piRuntimeVersion: pi.VERSION,
			executable: process.argv[1] ?? "unknown",
			inheritedPiAgentDir,
			inheritedPiSessionDir,
			desiredProfileManifestSha256: desiredProfile.manifestSha256,
		});
		console.log(result.text);
		if (!result.healthy) process.exitCode = 1;
		return;
	}

	const bundled = loadBundledProfile(profile.id);
	applyProfile(bundled, paths, metadata.jouzuVersion);
	if (firstRunChoice) {
		writeProfileChoice(profileChoicePath, profile.id);
		console.log(profile.id === "ja" ? "Japanese support enabled." : "Continuing with the Core profile.");
	} else {
		clearInteractiveStartup(parsed.args);
	}
	await pi.main(parsed.args, {
		extensionFactories: [createJouzuPresentationExtension(metadata, profile)],
	});
}

runCli(process.argv.slice(2)).catch((error: unknown) => {
	if (error instanceof ProfileConflictError) {
		console.error(formatProfilePlan(error.plan));
		console.error('Resolve the conflicts above, then run "jouzu profile apply" again.');
		process.exitCode = error.exitCode;
		return;
	}
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
