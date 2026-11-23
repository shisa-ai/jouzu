import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { CatalogMessageId, type CatalogRenderOptions, catalogText, defaultCatalog } from "./cli-messages.js";
import { CommandReport, type CommandReportEntry } from "./command-report.js";
import type { CatalogBundle } from "./locale-catalog.js";
import type { JouzuPaths } from "./paths.js";
import {
	copyPrivateFile,
	ensurePrivateDirectory,
	validatePrivateDirectory,
	writeFilePrivateAtomic,
} from "./private-fs.js";
import type { ResolvedProfile } from "./profiles.js";
import { acquireStateLock, STATE_LOCK_STALE_MS } from "./state-lock.js";

/**
 * The catalog ID for the profile lock message. It stays local rather than
 * joining the shared `CatalogMessageId` table so a parallel surface migration
 * does not conflict on that file; `scripts/check-locales.mjs` allows a
 * catalog-only ID present in both locales.
 */
const PROFILE_LOCK_BUSY_ID = "jouzu.cli.profile.lockBusy";

/**
 * The catalog IDs for the profile-state validation messages a `jz profile` run
 * reports. A path and a JSON error detail are protected values passed as
 * arguments. The internal invariants that follow (`profile target escaped agent
 * root`, `unsafe profile parent`, `missing desired profile asset`) stay English:
 * they name a code bug, not a file the user can repair.
 */
const PROFILE_STATE_MESSAGE_ID = {
	notRegularFile: "jouzu.cli.profile.state.notRegularFile",
	invalidJson: "jouzu.cli.profile.state.invalidJson",
	notObject: "jouzu.cli.profile.state.notObject",
	unknownFields: "jouzu.cli.profile.state.unknownFields",
	fieldsInvalid: "jouzu.cli.profile.state.fieldsInvalid",
	targetNotObject: "jouzu.cli.profile.state.targetNotObject",
	targetInvalid: "jouzu.cli.profile.state.targetInvalid",
} as const;

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

function profileActionEntries(plan: ProfilePlan, catalog: CatalogBundle): CommandReportEntry[] {
	if (plan.actions.length === 0)
		return [{ status: "ok", key: "none", message: catalogText(catalog, CatalogMessageId.profileNoChanges) }];
	return plan.actions.map((action) => ({
		status: action.type === "conflict" ? ("problem" as const) : ("update" as const),
		key: action.type,
		message: `${action.target} (${action.reason})`,
	}));
}

export function formatProfilePlan(plan: ProfilePlan, options: CatalogRenderOptions = {}): string {
	const catalog = options.catalog ?? defaultCatalog();
	const text = (id: CatalogMessageId): string => catalogText(catalog, id);
	const out = new CommandReport(options);
	out.title(text(CatalogMessageId.profileTitle), `${plan.profile} v${plan.profileVersion}`);
	out.section(text(CatalogMessageId.profileSection), [
		{ label: text(CatalogMessageId.profileFieldManifest), value: plan.manifestSha256 },
		{ label: text(CatalogMessageId.profileFieldAgentRoot), value: plan.agentDir },
	]);
	out.entries(text(CatalogMessageId.profileActions), profileActionEntries(plan, catalog));
	return out.toString();
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

export function readProfileState(path: string, catalog: CatalogBundle = defaultCatalog()): ProfileState | undefined {
	try {
		validatePrivateDirectory(dirname(path));
	} catch (error) {
		throw new ProfileStateError(error instanceof Error ? error.message : String(error));
	}
	if (!existsSync(path)) return undefined;
	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.isSymbolicLink())
		throw new ProfileStateError(catalogText(catalog, PROFILE_STATE_MESSAGE_ID.notRegularFile, { path }));
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new ProfileStateError(
			catalogText(catalog, PROFILE_STATE_MESSAGE_ID.invalidJson, {
				path,
				detail: error instanceof Error ? error.message : String(error),
			}),
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new ProfileStateError(catalogText(catalog, PROFILE_STATE_MESSAGE_ID.notObject));
	const state = parsed as Record<string, unknown>;
	if (!exactFields(state, STATE_FIELDS))
		throw new ProfileStateError(catalogText(catalog, PROFILE_STATE_MESSAGE_ID.unknownFields));
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
		throw new ProfileStateError(catalogText(catalog, PROFILE_STATE_MESSAGE_ID.fieldsInvalid, { path }));
	}
	const targets = new Set<string>();
	const managedTargets = state.managedTargets.map((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new ProfileStateError(catalogText(catalog, PROFILE_STATE_MESSAGE_ID.targetNotObject));
		}
		const target = entry as Record<string, unknown>;
		if (
			!exactFields(target, MANAGED_TARGET_FIELDS) ||
			typeof target.target !== "string" ||
			typeof target.sha256 !== "string" ||
			!SHA256_RE.test(target.sha256) ||
			targets.has(target.target)
		) {
			throw new ProfileStateError(catalogText(catalog, PROFILE_STATE_MESSAGE_ID.targetInvalid));
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

export function planProfile(
	profile: ResolvedProfile,
	paths: JouzuPaths,
	jouzuVersion: string,
	catalog: CatalogBundle = defaultCatalog(),
): ProfilePlan {
	try {
		validatePrivateDirectory(paths.agentDir);
	} catch (error) {
		throw new ProfileStateError(error instanceof Error ? error.message : String(error));
	}
	const state = readProfileState(paths.profileStatePath, catalog);
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

/** How long a start waits for another live process that is applying the same profile. */
export const PROFILE_LOCK_WAIT_MS = 15_000;
const PROFILE_LOCK_POLL_MS = 100;

/** Another live process kept the profile lock for the whole bounded wait. Nothing is damaged. */
export class ProfileBusyError extends Error {
	readonly exitCode = 1;
	constructor(message: string) {
		super(message);
		this.name = "ProfileBusyError";
	}
}

class ProfileLockHeldLive extends Error {}

function pause(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function applyProfile(
	profile: ResolvedProfile,
	paths: JouzuPaths,
	jouzuVersion: string,
	catalog: CatalogBundle = defaultCatalog(),
	options: { lockWaitMs?: number } = {},
): ApplyProfileResult {
	const initialPlan = planProfile(profile, paths, jouzuVersion, catalog);
	if (initialPlan.actions.some((action) => action.type === "conflict")) throw new ProfileConflictError(initialPlan);
	if (initialPlan.actions.length === 0) return { changed: false, plan: initialPlan };

	ensurePrivateDirectory(paths.stateDir);
	// Concurrent starts converge the same profile. A start that finds a live owner waits for it and
	// re-plans: the owner has usually applied everything already, so there is nothing left to do.
	const deadline = Date.now() + (options.lockWaitMs ?? PROFILE_LOCK_WAIT_MS);
	let releaseLock: () => void;
	for (;;) {
		try {
			releaseLock = acquireStateLock({
				path: join(paths.stateDir, "profile.lock"),
				staleMs: STATE_LOCK_STALE_MS,
				describe: "profile",
				onBusy: (inspection) =>
					inspection.status === "held-live"
						? new ProfileLockHeldLive()
						: new ProfileStateError(
								inspection.status === "invalid"
									? "profile.lock is not a regular lock file"
									: catalogText(catalog, PROFILE_LOCK_BUSY_ID),
							),
			});
			break;
		} catch (error) {
			if (!(error instanceof ProfileLockHeldLive)) throw error;
			// Name the lock, so a lock whose owner is not really Jouzu can be found and removed.
			if (Date.now() >= deadline)
				throw new ProfileBusyError(
					`${catalogText(catalog, PROFILE_LOCK_BUSY_ID)} (${join(paths.stateDir, "profile.lock")})`,
				);
			pause(PROFILE_LOCK_POLL_MS);
			// The owner may be between writes, so only a converged plan ends the wait early; conflicts
			// are judged under the lock.
			const plan = planProfile(profile, paths, jouzuVersion, catalog);
			if (plan.actions.length === 0) return { changed: false, plan };
		}
	}
	try {
		const plan = planProfile(profile, paths, jouzuVersion, catalog);
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
