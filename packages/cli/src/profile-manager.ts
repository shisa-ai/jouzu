import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { JouzuPaths } from "./paths.js";
import {
	copyPrivateFile,
	ensurePrivateDirectory,
	validatePrivateDirectory,
	writeFilePrivateAtomic,
} from "./private-fs.js";
import type { ResolvedProfile } from "./profiles.js";
import { acquireStateLock, STATE_LOCK_STALE_MS } from "./state-lock.js";

const STATE_FIELDS = new Set([
	"schemaVersion",
	"activeProfile",
	"profileVersion",
	"manifestSha256",
	"jouzuVersion",
	"transactionId",
	"appliedAt",
	"managedTargets",
]);
const MANAGED_TARGET_FIELDS = new Set(["target", "sha256"]);
const SHA256_RE = /^[0-9a-f]{64}$/;

export type ProfileActionType = "create" | "update" | "delete" | "adopt" | "state-update" | "conflict";

export interface ProfileAction {
	type: ProfileActionType;
	target: string;
	reason: string;
	desiredSha256?: string;
	observedSha256?: string;
}

export interface ProfilePlan {
	schemaVersion: 1;
	profile: string;
	profileVersion: number;
	manifestSha256: string;
	agentDir: string;
	actions: ProfileAction[];
}

export interface ProfileState {
	schemaVersion: 1;
	activeProfile: "core" | "ja";
	profileVersion: number;
	manifestSha256: string;
	jouzuVersion: string;
	transactionId: string;
	appliedAt: string;
	managedTargets: Array<{ target: string; sha256: string }>;
}

export interface ApplyProfileResult {
	changed: boolean;
	plan: ProfilePlan;
	transactionId?: string;
	backupDir?: string;
}

export class ProfileStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProfileStateError";
	}
}

export function formatProfilePlan(plan: ProfilePlan): string {
	const lines = [
		"Jouzu profile plan",
		`Profile: ${plan.profile} v${plan.profileVersion}`,
		`Manifest: ${plan.manifestSha256}`,
		`Agent root: ${plan.agentDir}`,
		`Actions (${plan.actions.length}):`,
	];
	if (plan.actions.length === 0) lines.push("- none");
	for (const action of plan.actions) {
		lines.push(`- ${action.type.toUpperCase()} ${action.target} (${action.reason})`);
	}
	return lines.join("\n");
}

export class ProfileConflictError extends Error {
	readonly exitCode = 3;
	readonly plan: ProfilePlan;

	constructor(plan: ProfilePlan) {
		super("profile plan contains conflicts");
		this.name = "ProfileConflictError";
		this.plan = plan;
	}
}

function sha256(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function exactFields(value: Record<string, unknown>, fields: Set<string>): boolean {
	return Object.keys(value).every((key) => fields.has(key));
}

export function readProfileState(path: string): ProfileState | undefined {
	try {
		validatePrivateDirectory(dirname(path));
	} catch (error) {
		throw new ProfileStateError(error instanceof Error ? error.message : String(error));
	}
	if (!existsSync(path)) return undefined;
	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.isSymbolicLink())
		throw new ProfileStateError(`profile state must be a regular file: ${path}`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new ProfileStateError(
			`profile state is invalid JSON at ${path}: ${error instanceof Error ? error.message : error}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new ProfileStateError("profile state must be an object");
	const state = parsed as Record<string, unknown>;
	if (!exactFields(state, STATE_FIELDS)) throw new ProfileStateError("profile state has unknown fields");
	if (
		state.schemaVersion !== 1 ||
		(state.activeProfile !== "core" && state.activeProfile !== "ja") ||
		!Number.isInteger(state.profileVersion) ||
		Number(state.profileVersion) < 1 ||
		typeof state.manifestSha256 !== "string" ||
		!SHA256_RE.test(state.manifestSha256) ||
		typeof state.jouzuVersion !== "string" ||
		typeof state.transactionId !== "string" ||
		typeof state.appliedAt !== "string" ||
		!Array.isArray(state.managedTargets)
	) {
		throw new ProfileStateError(`profile state fields are invalid at ${path}`);
	}
	const targets = new Set<string>();
	const managedTargets = state.managedTargets.map((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new ProfileStateError("profile state managed target must be an object");
		}
		const target = entry as Record<string, unknown>;
		if (
			!exactFields(target, MANAGED_TARGET_FIELDS) ||
			typeof target.target !== "string" ||
			typeof target.sha256 !== "string" ||
			!SHA256_RE.test(target.sha256) ||
			targets.has(target.target)
		) {
			throw new ProfileStateError("profile state managed target is invalid or duplicated");
		}
		targets.add(target.target);
		return { target: target.target, sha256: target.sha256 };
	});
	return {
		schemaVersion: 1,
		activeProfile: state.activeProfile,
		profileVersion: Number(state.profileVersion),
		manifestSha256: state.manifestSha256,
		jouzuVersion: state.jouzuVersion,
		transactionId: state.transactionId,
		appliedAt: state.appliedAt,
		managedTargets,
	};
}

function targetPath(agentDir: string, target: string): string {
	const resolved = resolve(agentDir, ...target.split("/"));
	const root = resolve(agentDir);
	if (resolved !== root && !resolved.startsWith(`${root}${sep}`))
		throw new ProfileStateError(`profile target escaped agent root: ${target}`);
	return resolved;
}

function unsafeParent(agentDir: string, target: string): string | undefined {
	let current = resolve(agentDir);
	for (const part of target.split("/").slice(0, -1)) {
		current = join(current, part);
		if (!existsSync(current)) continue;
		const metadata = lstatSync(current);
		if (metadata.isSymbolicLink() || !metadata.isDirectory()) return part;
	}
	return undefined;
}

function observedFile(
	agentDir: string,
	target: string,
): { kind: "missing" | "unsafe" | "file"; sha256?: string; unsupportedEncoding?: boolean } {
	if (unsafeParent(agentDir, target)) return { kind: "unsafe" };
	const path = targetPath(agentDir, target);
	if (!existsSync(path)) return { kind: "missing" };
	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.isSymbolicLink()) return { kind: "unsafe" };
	const bytes = readFileSync(path);
	let unsupportedEncoding = false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		unsupportedEncoding = true;
	}
	return { kind: "file", sha256: sha256(bytes), unsupportedEncoding };
}

function stateMatches(state: ProfileState | undefined, profile: ResolvedProfile, jouzuVersion: string): boolean {
	if (
		!state ||
		state.activeProfile !== profile.id ||
		state.profileVersion !== profile.version ||
		state.manifestSha256 !== profile.manifestSha256 ||
		state.jouzuVersion !== jouzuVersion ||
		state.managedTargets.length !== profile.assets.length
	) {
		return false;
	}
	const expected = profile.assets.map((asset) => `${asset.target}:${asset.sha256}`).sort();
	const current = state.managedTargets.map((asset) => `${asset.target}:${asset.sha256}`).sort();
	return expected.every((value, index) => value === current[index]);
}

function sortedActions(actions: ProfileAction[]): ProfileAction[] {
	return actions.sort((left, right) => left.target.localeCompare(right.target) || left.type.localeCompare(right.type));
}

export function planProfile(profile: ResolvedProfile, paths: JouzuPaths, jouzuVersion: string): ProfilePlan {
	try {
		validatePrivateDirectory(paths.agentDir);
	} catch (error) {
		throw new ProfileStateError(error instanceof Error ? error.message : String(error));
	}
	const state = readProfileState(paths.profileStatePath);
	const previous = new Map(state?.managedTargets.map((item) => [item.target, item.sha256]) ?? []);
	const desired = new Map(profile.assets.map((asset) => [asset.target, asset]));
	const actions: ProfileAction[] = [];

	for (const asset of profile.assets) {
		const observed = observedFile(paths.agentDir, asset.target);
		const installedSha256 = previous.get(asset.target);
		if (observed.kind === "unsafe") {
			actions.push({ type: "conflict", target: asset.target, reason: "unsafe-target", desiredSha256: asset.sha256 });
			continue;
		}
		if (observed.kind === "missing") {
			actions.push({
				type: "create",
				target: asset.target,
				reason: installedSha256 ? "managed-missing" : "missing",
				desiredSha256: asset.sha256,
			});
			continue;
		}
		if (!installedSha256) {
			actions.push(
				observed.sha256 === asset.sha256
					? {
							type: "adopt",
							target: asset.target,
							reason: "matching-unmanaged",
							desiredSha256: asset.sha256,
							observedSha256: observed.sha256,
						}
					: {
							type: "conflict",
							target: asset.target,
							reason: observed.unsupportedEncoding ? "unsupported-encoding" : "unmanaged-different",
							desiredSha256: asset.sha256,
							observedSha256: observed.sha256,
						},
			);
			continue;
		}
		if (observed.sha256 === asset.sha256) continue;
		if (observed.sha256 !== installedSha256) {
			actions.push({
				type: "conflict",
				target: asset.target,
				reason: observed.unsupportedEncoding ? "unsupported-encoding" : "managed-modified",
				desiredSha256: asset.sha256,
				observedSha256: observed.sha256,
			});
			continue;
		}
		actions.push({
			type: "update",
			target: asset.target,
			reason: "managed-upgrade",
			desiredSha256: asset.sha256,
			observedSha256: observed.sha256,
		});
	}

	for (const [target, installedSha256] of previous) {
		if (desired.has(target)) continue;
		const observed = observedFile(paths.agentDir, target);
		if (observed.kind === "missing") continue;
		if (observed.kind === "unsafe" || observed.sha256 !== installedSha256) {
			actions.push({
				type: "conflict",
				target,
				reason:
					observed.kind === "unsafe"
						? "unsafe-target"
						: observed.unsupportedEncoding
							? "unsupported-encoding"
							: "managed-modified",
				observedSha256: observed.sha256,
			});
			continue;
		}
		actions.push({
			type: "delete",
			target,
			reason: "retired-managed",
			observedSha256: observed.sha256,
		});
	}

	if (!stateMatches(state, profile, jouzuVersion)) {
		actions.push({
			type: "state-update",
			target: "profile-state.json",
			reason: state ? "state-drift" : "state-missing",
		});
	}
	return {
		schemaVersion: 1,
		profile: profile.id,
		profileVersion: profile.version,
		manifestSha256: profile.manifestSha256,
		agentDir: paths.agentDir,
		actions: sortedActions(actions),
	};
}

function stateBytes(profile: ResolvedProfile, jouzuVersion: string, transactionId: string): Buffer {
	const state: ProfileState = {
		schemaVersion: 1,
		activeProfile: profile.id,
		profileVersion: profile.version,
		manifestSha256: profile.manifestSha256,
		jouzuVersion,
		transactionId,
		appliedAt: new Date().toISOString(),
		managedTargets: profile.assets.map((asset) => ({ target: asset.target, sha256: asset.sha256 })),
	};
	return Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
}

export function applyProfile(profile: ResolvedProfile, paths: JouzuPaths, jouzuVersion: string): ApplyProfileResult {
	const initialPlan = planProfile(profile, paths, jouzuVersion);
	if (initialPlan.actions.some((action) => action.type === "conflict")) throw new ProfileConflictError(initialPlan);
	if (initialPlan.actions.length === 0) return { changed: false, plan: initialPlan };

	ensurePrivateDirectory(paths.stateDir);
	const releaseLock = acquireStateLock({
		path: join(paths.stateDir, "profile.lock"),
		staleMs: STATE_LOCK_STALE_MS,
		describe: "profile",
		onBusy: (inspection) =>
			new ProfileStateError(
				inspection.status === "invalid"
					? "profile.lock is not a regular lock file"
					: "another profile operation is in progress",
			),
	});
	try {
		const plan = planProfile(profile, paths, jouzuVersion);
		if (plan.actions.some((action) => action.type === "conflict")) throw new ProfileConflictError(plan);
		if (plan.actions.length === 0) return { changed: false, plan };

		const transactionId = randomUUID();
		const transactionBackupDir = join(paths.backupDir, transactionId);
		const desired = new Map(profile.assets.map((asset) => [asset.target, asset]));
		for (const action of plan.actions) {
			if (action.type === "state-update" || action.type === "adopt") continue;
			const path = targetPath(paths.agentDir, action.target);
			if (action.type === "update" || action.type === "delete") {
				const backup = targetPath(transactionBackupDir, action.target);
				copyPrivateFile(path, backup, paths.stateDir);
			}
			if (action.type === "delete") {
				unlinkSync(path);
				continue;
			}
			const asset = desired.get(action.target);
			if (!asset) throw new ProfileStateError(`missing desired profile asset: ${action.target}`);
			if (unsafeParent(paths.agentDir, action.target))
				throw new ProfileStateError(`unsafe profile parent: ${action.target}`);
			writeFilePrivateAtomic(path, asset.bytes, paths.agentDir);
		}
		writeFilePrivateAtomic(paths.profileStatePath, stateBytes(profile, jouzuVersion, transactionId), paths.stateDir);
		return {
			changed: true,
			plan,
			transactionId,
			...(existsSync(transactionBackupDir) ? { backupDir: transactionBackupDir } : {}),
		};
	} finally {
		releaseLock();
	}
}
