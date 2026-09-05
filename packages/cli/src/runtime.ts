import { join } from "node:path";
import type { ProfileId } from "./args.js";
import type { JouzuPaths } from "./paths.js";
import { readProfileChoice } from "./profile-choice.js";
import { readProfileState } from "./profile-manager.js";

interface ProfileSelection {
	id: ProfileId;
	source: "command line" | "environment" | "profile state" | "saved choice" | "first-run choice" | "default";
	appliedManifestSha256?: string;
	needsFirstRunInput: boolean;
}

export interface ProfileResolutionOptions {
	explicitProfile?: ProfileId;
	env?: NodeJS.ProcessEnv;
	allowSavedChoice?: boolean;
	interactiveStartup?: boolean;
}

export type { ProfileSelection };

function isProfileId(value: unknown): value is ProfileId {
	return value === "core" || value === "ja";
}

export function resolveProfileSelection(paths: JouzuPaths, options: ProfileResolutionOptions = {}): ProfileSelection {
	const state = readProfileState(paths.profileStatePath);
	const explicitProfile = options.explicitProfile;
	const env = options.env ?? process.env;
	if (explicitProfile) {
		return {
			id: explicitProfile,
			source: "command line",
			appliedManifestSha256:
				state?.activeProfile === explicitProfile && typeof state.manifestSha256 === "string"
					? state.manifestSha256
					: undefined,
			needsFirstRunInput: false,
		};
	}
	if (isProfileId(env.JOUZU_PROFILE)) {
		return {
			id: env.JOUZU_PROFILE,
			source: "environment",
			appliedManifestSha256:
				state?.activeProfile === env.JOUZU_PROFILE && typeof state.manifestSha256 === "string"
					? state.manifestSha256
					: undefined,
			needsFirstRunInput: false,
		};
	}

	const interactiveStartup = options.interactiveStartup === true;
	if (isProfileId(state?.activeProfile)) {
		const savedChoice =
			interactiveStartup && state.activeProfile === "core"
				? readProfileChoice(join(paths.stateDir, "profile-choice.json"))
				: undefined;
		return {
			id: state.activeProfile,
			source: "profile state",
			appliedManifestSha256: typeof state.manifestSha256 === "string" ? state.manifestSha256 : undefined,
			needsFirstRunInput: interactiveStartup && state.activeProfile === "core" && savedChoice === undefined,
		};
	}

	if (options.allowSavedChoice !== false) {
		const savedChoice = readProfileChoice(join(paths.stateDir, "profile-choice.json"));
		if (savedChoice) {
			return { id: savedChoice.profile, source: "saved choice", needsFirstRunInput: false };
		}
	}
	return { id: "core", source: "default", needsFirstRunInput: interactiveStartup };
}

export function configurePiProcess(paths: JouzuPaths): void {
	process.title = "jouzu";
	process.env.AI_AGENT = "jouzu";
	process.env.PI_CODING_AGENT = "true";
	process.env.PI_CODING_AGENT_DIR = paths.agentDir;
	process.env.PI_CODING_AGENT_SESSION_DIR = paths.sessionDir;
	process.env.JOUZU_RUNTIME_STATE_DIR = paths.stateDir;
	process.env.PI_VCC_CONFIG_PATH = join(paths.agentDir, "pi-vcc-config.json");
	process.env.PI_SKIP_VERSION_CHECK = "1";
}
