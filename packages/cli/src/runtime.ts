import { readFileSync } from "node:fs";
import type { ProfileId } from "./args.js";
import type { JouzuPaths } from "./paths.js";

interface ProfileState {
	activeProfile?: unknown;
	manifestSha256?: unknown;
}

export interface ProfileSelection {
	id: ProfileId;
	source: "command line" | "environment" | "profile state" | "saved choice" | "first-run choice" | "default";
	appliedManifestSha256?: string;
}

function isProfileId(value: unknown): value is ProfileId {
	return value === "core" || value === "ja";
}

function readProfileState(path: string): ProfileState | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as ProfileState;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		return undefined;
	}
}

export function resolveProfileSelection(
	paths: JouzuPaths,
	explicitProfile: ProfileId | undefined,
	env: NodeJS.ProcessEnv = process.env,
	savedChoice?: ProfileId,
): ProfileSelection {
	const state = readProfileState(paths.profileStatePath);
	if (explicitProfile) {
		return {
			id: explicitProfile,
			source: "command line",
			appliedManifestSha256:
				state?.activeProfile === explicitProfile && typeof state.manifestSha256 === "string"
					? state.manifestSha256
					: undefined,
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
		};
	}
	if (isProfileId(state?.activeProfile)) {
		return {
			id: state.activeProfile,
			source: "profile state",
			appliedManifestSha256: typeof state.manifestSha256 === "string" ? state.manifestSha256 : undefined,
		};
	}
	if (savedChoice) return { id: savedChoice, source: "saved choice" };
	return { id: "core", source: "default" };
}

export function configurePiProcess(paths: JouzuPaths, profile: ProfileSelection): void {
	process.title = "jouzu";
	process.env.AI_AGENT = "jouzu";
	process.env.PI_CODING_AGENT = "true";
	process.env.PI_CODING_AGENT_DIR = paths.agentDir;
	process.env.PI_CODING_AGENT_SESSION_DIR = paths.sessionDir;
	process.env.PI_SKIP_VERSION_CHECK = "1";
	process.env.JOUZU_PROFILE = profile.id;
}
