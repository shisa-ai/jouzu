import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { JouzuPaths } from "./paths.js";
import { acquireStateLock, STATE_LOCK_STALE_MS } from "./state-lock.js";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const UPDATE_STATE_FIELDS = new Set([
	"schemaVersion",
	"policy",
	"channel",
	"lastCheckedAt",
	"nextCheckAt",
	"lastResult",
	"installedVersion",
	"latestVersion",
	"latestIntegrity",
	"previousVersion",
	"lastUpdatedAt",
	"lastErrorCode",
]);
const UPDATE_POLICIES = ["auto-restart", "notify", "off"] as const;
const UPDATE_RESULTS = ["never", "current", "available", "updated", "failed"] as const;
const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FAILED_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const SRI_SHA512_RE = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const SEMVER_RE =
	/^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export type UpdatePolicy = (typeof UPDATE_POLICIES)[number];
export type UpdateResult = (typeof UPDATE_RESULTS)[number];
export type UpdateInstallChannel = "global-npm" | "local-npm" | "ephemeral-npx" | "source" | "other";

export interface UpdateState {
	schemaVersion: 1;
	policy: UpdatePolicy;
	channel: "latest";
	lastCheckedAt: string | null;
	nextCheckAt: string | null;
	lastResult: UpdateResult;
	installedVersion: string;
	latestVersion: string | null;
	latestIntegrity: string | null;
	previousVersion: string | null;
	lastUpdatedAt: string | null;
	lastErrorCode: string | null;
}

export interface RegistryRelease {
	version: string;
	integrity: string;
}

export interface UpdateCheckResult extends RegistryRelease {
	status: "current" | "available";
	installedVersion: string;
}

export interface UpdateStatus {
	policy: UpdatePolicy;
	installChannel: UpdateInstallChannel;
	startupEligible: boolean;
	state: UpdateState;
}

export interface NpmRunResult {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
}

export type NpmRunner = (args: string[], timeoutMs: number) => NpmRunResult;

export interface UpdaterOptions {
	paths: JouzuPaths;
	currentVersion: string;
	executable: string;
	packageRoot?: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	now?: () => Date;
	runNpm?: NpmRunner;
	verifyInstalled?: (expectedVersion: string) => void;
	report?: (message: string) => void;
}

export interface StartupUpdateResult {
	action: "continue" | "restart";
	version?: string;
	message?: string;
}

interface ParsedSemver {
	major: number;
	minor: number;
	patch: number;
	prerelease: Array<string | number>;
}

interface PackedArtifact {
	path: string;
	integrity: string;
}

export class UpdateError extends Error {
	readonly code: string;
	readonly exitCode: number;
	readonly fatal: boolean;

	constructor(message: string, code: string, options: { exitCode?: number; fatal?: boolean } = {}) {
		super(message);
		this.name = "UpdateError";
		this.code = code;
		this.exitCode = options.exitCode ?? 4;
		this.fatal = options.fatal ?? false;
	}
}

function exactFields(value: Record<string, unknown>, fields: Set<string>): boolean {
	return Object.keys(value).every((key) => fields.has(key)) && Object.keys(value).length === fields.size;
}

function validTimestamp(value: unknown): value is string | null {
	return value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function parseSemver(value: string): ParsedSemver {
	const match = SEMVER_RE.exec(value);
	if (!match) throw new UpdateError(`invalid semantic version: ${value}`, "invalid-version");
	const [major, minor, patch] = match.slice(1, 4).map(Number);
	if (![major, minor, patch].every(Number.isSafeInteger)) {
		throw new UpdateError(`semantic version components exceed the safe integer range: ${value}`, "invalid-version");
	}
	const prerelease = match[4]
		? match[4].split(".").map((part) => {
				if (/^\d+$/.test(part)) {
					if (!/^(?:0|[1-9]\d*)$/.test(part)) {
						throw new UpdateError(`semantic version has a zero-padded prerelease number: ${value}`, "invalid-version");
					}
					const numeric = Number(part);
					if (!Number.isSafeInteger(numeric)) {
						throw new UpdateError(
							`semantic version prerelease exceeds the safe integer range: ${value}`,
							"invalid-version",
						);
					}
					return numeric;
				}
				return part;
			})
		: [];
	return { major, minor, patch, prerelease };
}

export function compareSemver(left: string, right: string): number {
	const a = parseSemver(left);
	const b = parseSemver(right);
	for (const field of ["major", "minor", "patch"] as const) {
		if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
	}
	if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
	if (a.prerelease.length === 0) return 1;
	if (b.prerelease.length === 0) return -1;
	for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
		const leftPart = a.prerelease[index];
		const rightPart = b.prerelease[index];
		if (leftPart === undefined) return -1;
		if (rightPart === undefined) return 1;
		if (leftPart === rightPart) continue;
		if (typeof leftPart === "number" && typeof rightPart === "string") return -1;
		if (typeof leftPart === "string" && typeof rightPart === "number") return 1;
		return leftPart < rightPart ? -1 : 1;
	}
	return 0;
}

function defaultState(currentVersion: string): UpdateState {
	parseSemver(currentVersion);
	return {
		schemaVersion: 1,
		policy: "auto-restart",
		channel: "latest",
		lastCheckedAt: null,
		nextCheckAt: null,
		lastResult: "never",
		installedVersion: currentVersion,
		latestVersion: null,
		latestIntegrity: null,
		previousVersion: null,
		lastUpdatedAt: null,
		lastErrorCode: null,
	};
}

export function updateStatePath(paths: JouzuPaths): string {
	return join(paths.stateDir, "self-update.json");
}

function updateLockPath(paths: JouzuPaths): string {
	return join(paths.stateDir, "self-update.lock");
}

export function readUpdateState(path: string, currentVersion: string): UpdateState {
	if (!existsSync(path)) return defaultState(currentVersion);
	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new UpdateError("self-update state must be a regular file", "invalid-state");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new UpdateError(
			`self-update state is invalid JSON: ${error instanceof Error ? error.message : error}`,
			"invalid-state",
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new UpdateError("self-update state must be an object", "invalid-state");
	}
	const value = parsed as Record<string, unknown>;
	if (!exactFields(value, UPDATE_STATE_FIELDS)) {
		throw new UpdateError("self-update state has missing or unknown fields", "invalid-state");
	}
	if (
		value.schemaVersion !== 1 ||
		!UPDATE_POLICIES.includes(value.policy as UpdatePolicy) ||
		value.channel !== "latest" ||
		!validTimestamp(value.lastCheckedAt) ||
		!validTimestamp(value.nextCheckAt) ||
		!UPDATE_RESULTS.includes(value.lastResult as UpdateResult) ||
		typeof value.installedVersion !== "string" ||
		(value.latestVersion !== null && typeof value.latestVersion !== "string") ||
		(value.latestIntegrity !== null &&
			(typeof value.latestIntegrity !== "string" || !SRI_SHA512_RE.test(value.latestIntegrity))) ||
		(value.previousVersion !== null && typeof value.previousVersion !== "string") ||
		!validTimestamp(value.lastUpdatedAt) ||
		(value.lastErrorCode !== null && typeof value.lastErrorCode !== "string")
	) {
		throw new UpdateError("self-update state fields are invalid", "invalid-state");
	}
	if ((value.latestVersion === null) !== (value.latestIntegrity === null)) {
		throw new UpdateError("self-update state must pair latest version and integrity", "invalid-state");
	}
	if (value.lastResult === "available" && value.latestVersion === null) {
		throw new UpdateError("available self-update state is missing release metadata", "invalid-state");
	}
	parseSemver(value.installedVersion);
	if (typeof value.latestVersion === "string") parseSemver(value.latestVersion);
	if (typeof value.previousVersion === "string") parseSemver(value.previousVersion);
	return value as unknown as UpdateState;
}

function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, "wx", 0o600);
		writeFileSync(descriptor, content);
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		rmSync(temporary, { force: true });
	}
}

function writeUpdateState(path: string, state: UpdateState): void {
	atomicWrite(path, `${JSON.stringify(state, null, 2)}\n`);
}

function envFlagIsTrue(value: string | undefined): boolean {
	return value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function effectivePolicy(state: UpdateState, env: NodeJS.ProcessEnv): UpdatePolicy {
	if (envFlagIsTrue(env.JOUZU_NO_UPDATE)) return "off";
	const override = env.JOUZU_UPDATE_POLICY;
	if (override !== undefined) {
		return UPDATE_POLICIES.includes(override as UpdatePolicy) ? (override as UpdatePolicy) : "off";
	}
	return state.policy;
}

function normalizePathForPlatform(path: string, platform: NodeJS.Platform): string {
	const pathApi = platform === "win32" ? win32 : posix;
	const normalized = pathApi.resolve(path).replaceAll("\\", "/").replace(/\/$/, "");
	return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function classifyInstallChannel(options: {
	packageRoot: string;
	globalNpmRoot?: string;
	platform?: NodeJS.Platform;
}): UpdateInstallChannel {
	const platform = options.platform ?? process.platform;
	const packageRoot = normalizePathForPlatform(options.packageRoot, platform);
	if (packageRoot.endsWith("/packages/cli")) return "source";
	if (packageRoot.includes("/_npx/")) return "ephemeral-npx";
	if (options.globalNpmRoot) {
		const globalPackage = normalizePathForPlatform(
			(platform === "win32" ? win32 : posix).join(options.globalNpmRoot, "jouzu"),
			platform,
		);
		if (packageRoot === globalPackage) return "global-npm";
	}
	if (packageRoot.includes("/node_modules/jouzu")) return "local-npm";
	return "other";
}

function defaultPackageRoot(): string {
	return dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
}

function defaultNpmRunner(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NpmRunner {
	return (args, timeoutMs) => {
		const command = platform === "win32" ? (env.ComSpec ?? "cmd.exe") : "npm";
		const prefix = platform === "win32" ? ["/d", "/s", "/c", "npm"] : [];
		const result = spawnSync(command, [...prefix, ...args], {
			encoding: "utf8",
			timeout: timeoutMs,
			maxBuffer: 10 * 1024 * 1024,
			env: { ...env, npm_config_update_notifier: "false" },
		});
		return {
			status: result.status,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			...(result.error ? { error: result.error } : {}),
		};
	};
}

function requireCommandSuccess(result: NpmRunResult, operation: string): string {
	if (result.error) {
		const code = "code" in result.error && typeof result.error.code === "string" ? result.error.code : "spawn";
		throw new UpdateError(`${operation} failed (${code})`, `npm-${operation}-${code}`);
	}
	if (result.status !== 0) {
		throw new UpdateError(`${operation} failed (npm exit ${result.status ?? "unknown"})`, `npm-${operation}-exit`);
	}
	return result.stdout;
}

function parseRegistryRelease(stdout: string): RegistryRelease {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new UpdateError("npm returned invalid update metadata", "invalid-registry-metadata");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new UpdateError("npm returned invalid update metadata", "invalid-registry-metadata");
	}
	const value = parsed as Record<string, unknown>;
	const version = value.version;
	const integrity = value["dist.integrity"];
	if (typeof version !== "string" || typeof integrity !== "string" || !SRI_SHA512_RE.test(integrity)) {
		throw new UpdateError("npm update metadata is missing version or SHA-512 integrity", "invalid-registry-metadata");
	}
	parseSemver(version);
	return { version, integrity };
}

function parsePackedArtifact(stdout: string, directory: string, expectedVersion?: string): PackedArtifact {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new UpdateError("npm pack returned invalid metadata", "invalid-pack-metadata");
	}
	if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== "object") {
		throw new UpdateError("npm pack returned invalid metadata", "invalid-pack-metadata");
	}
	const value = parsed[0] as Record<string, unknown>;
	if (
		value.name !== "jouzu" ||
		typeof value.version !== "string" ||
		(expectedVersion !== undefined && value.version !== expectedVersion) ||
		typeof value.integrity !== "string" ||
		!SRI_SHA512_RE.test(value.integrity) ||
		typeof value.filename !== "string" ||
		value.filename !== posix.basename(value.filename) ||
		value.filename !== win32.basename(value.filename)
	) {
		throw new UpdateError("npm pack metadata does not describe the expected Jouzu artifact", "invalid-pack-metadata");
	}
	return { path: join(directory, value.filename), integrity: value.integrity };
}

function verifyFileIntegrity(path: string, integrity: string): void {
	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new UpdateError("downloaded update is not a regular file", "invalid-update-artifact");
	}
	const observed = `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
	if (observed !== integrity)
		throw new UpdateError("downloaded update failed SHA-512 verification", "integrity-mismatch");
}

function acquireUpdateLock(path: string, now: Date): () => void {
	return acquireStateLock({
		path,
		now,
		staleMs: STATE_LOCK_STALE_MS,
		describe: "self-update",
		onBusy: (inspection) =>
			new UpdateError(
				inspection.status === "invalid" ? "self-update lock is not a regular file" : "another Jouzu update is running",
				"update-busy",
			),
	});
}

function defaultVerifyInstalled(
	packageRoot: string,
	executable: string,
	expectedVersion: string,
	env: NodeJS.ProcessEnv,
): void {
	const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
		name?: unknown;
		version?: unknown;
		dependencies?: Record<string, unknown>;
	};
	const piLock = JSON.parse(readFileSync(join(packageRoot, "dist", "pi.lock.json"), "utf8")) as {
		packages?: Record<string, { version?: unknown }>;
	};
	const piDependency = packageJson.dependencies?.[PI_PACKAGE];
	const piLockVersion = piLock.packages?.[PI_PACKAGE]?.version;
	if (
		packageJson.name !== "jouzu" ||
		packageJson.version !== expectedVersion ||
		typeof piDependency !== "string" ||
		piDependency !== piLockVersion
	) {
		throw new UpdateError("installed update metadata failed verification", "installed-metadata-mismatch");
	}
	const cliBytes = readFileSync(executable, "utf8");
	if (!cliBytes.startsWith("#!/usr/bin/env node\n")) {
		throw new UpdateError("installed update CLI failed verification", "installed-cli-invalid");
	}
	const result = spawnSync(process.execPath, [executable, "--version"], {
		encoding: "utf8",
		timeout: 30_000,
		env: { ...env, JOUZU_NO_UPDATE: "1" },
	});
	if (result.status !== 0 || !result.stdout.startsWith(`jouzu ${expectedVersion}\n`)) {
		throw new UpdateError("installed update runtime smoke failed", "installed-runtime-invalid");
	}
}

function checkIntervalMs(env: NodeJS.ProcessEnv): number {
	const raw = env.JOUZU_UPDATE_INTERVAL_HOURS;
	if (!raw) return DEFAULT_CHECK_INTERVAL_MS;
	const hours = Number(raw);
	return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : DEFAULT_CHECK_INTERVAL_MS;
}

function checkIsDue(state: UpdateState, now: Date): boolean {
	return state.nextCheckAt === null || Date.parse(state.nextCheckAt) <= now.getTime();
}

export class JouzuUpdater {
	private readonly paths: JouzuPaths;
	private readonly currentVersion: string;
	private readonly executable: string;
	private readonly packageRoot: string;
	private readonly env: NodeJS.ProcessEnv;
	private readonly platform: NodeJS.Platform;
	private readonly now: () => Date;
	private readonly runNpm: NpmRunner;
	private readonly verifyInstalled: (expectedVersion: string) => void;
	private readonly report: (message: string) => void;
	private cachedInstallChannel: UpdateInstallChannel | undefined;

	constructor(options: UpdaterOptions) {
		parseSemver(options.currentVersion);
		this.paths = options.paths;
		this.currentVersion = options.currentVersion;
		this.executable = resolve(options.executable);
		this.packageRoot = options.packageRoot ?? defaultPackageRoot();
		this.env = options.env ?? process.env;
		this.platform = options.platform ?? process.platform;
		this.now = options.now ?? (() => new Date());
		this.runNpm = options.runNpm ?? defaultNpmRunner(this.env, this.platform);
		this.verifyInstalled =
			options.verifyInstalled ??
			((expectedVersion) => defaultVerifyInstalled(this.packageRoot, this.executable, expectedVersion, this.env));
		this.report = options.report ?? (() => {});
	}

	private readState(): UpdateState {
		return readUpdateState(updateStatePath(this.paths), this.currentVersion);
	}

	private writeState(state: UpdateState): void {
		writeUpdateState(updateStatePath(this.paths), state);
	}

	private recordFailure(code: string, now: Date, checked = false): void {
		try {
			const state = this.readState();
			this.writeState({
				...state,
				lastCheckedAt: checked ? now.toISOString() : state.lastCheckedAt,
				lastResult: "failed",
				nextCheckAt: new Date(now.getTime() + FAILED_CHECK_INTERVAL_MS).toISOString(),
				installedVersion: this.currentVersion,
				lastErrorCode: code,
			});
		} catch {}
	}

	private globalNpmRoot(): string | undefined {
		try {
			return requireCommandSuccess(this.runNpm(["root", "--global", "--loglevel=error"], 15_000), "root").trim();
		} catch {
			return undefined;
		}
	}

	installChannel(): UpdateInstallChannel {
		this.cachedInstallChannel ??= classifyInstallChannel({
			packageRoot: this.packageRoot,
			globalNpmRoot: this.globalNpmRoot(),
			platform: this.platform,
		});
		return this.cachedInstallChannel;
	}

	status(): UpdateStatus {
		const state = this.readState();
		const policy = effectivePolicy(state, this.env);
		const installChannel = this.installChannel();
		return {
			policy,
			installChannel,
			startupEligible: installChannel === "global-npm" && policy !== "off",
			state: { ...state, installedVersion: this.currentVersion },
		};
	}

	setPolicy(policy: UpdatePolicy): UpdateState {
		if (!UPDATE_POLICIES.includes(policy))
			throw new UpdateError(`unknown update policy: ${policy}`, "invalid-policy", { exitCode: 2 });
		const state = this.readState();
		const updated = { ...state, policy };
		this.writeState(updated);
		return updated;
	}

	check(): UpdateCheckResult {
		const now = this.now();
		try {
			const stdout = requireCommandSuccess(
				this.runNpm(
					[
						"view",
						"jouzu@latest",
						"version",
						"dist.integrity",
						"--json",
						"--fetch-retries=0",
						"--fetch-timeout=8000",
						"--loglevel=error",
					],
					12_000,
				),
				"view",
			);
			const release = parseRegistryRelease(stdout);
			const status = compareSemver(release.version, this.currentVersion) > 0 ? "available" : "current";
			const state = this.readState();
			this.writeState({
				...state,
				lastCheckedAt: now.toISOString(),
				nextCheckAt: new Date(now.getTime() + checkIntervalMs(this.env)).toISOString(),
				lastResult: status,
				installedVersion: this.currentVersion,
				latestVersion: release.version,
				latestIntegrity: release.integrity,
				lastErrorCode: null,
			});
			return { status, installedVersion: this.currentVersion, ...release };
		} catch (error) {
			const updateError = error instanceof UpdateError ? error : new UpdateError("update check failed", "check-failed");
			this.recordFailure(updateError.code, now, true);
			throw updateError;
		}
	}

	private createDownloadDirectory(): string {
		mkdirSync(this.paths.cacheDir, { recursive: true, mode: 0o700 });
		const directory = join(this.paths.cacheDir, `self-update-${randomUUID()}`);
		mkdirSync(directory, { mode: 0o700 });
		return directory;
	}

	private pack(specifier: string, directory: string, expectedVersion?: string): PackedArtifact {
		const stdout = requireCommandSuccess(
			this.runNpm(
				[
					"pack",
					specifier,
					"--ignore-scripts",
					"--json",
					"--pack-destination",
					directory,
					"--fetch-retries=1",
					"--fetch-timeout=15000",
					"--loglevel=error",
				],
				60_000,
			),
			"pack",
		);
		return parsePackedArtifact(stdout, directory, expectedVersion);
	}

	private installTarball(path: string): void {
		requireCommandSuccess(
			this.runNpm(
				["install", "--global", path, "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"],
				300_000,
			),
			"install",
		);
	}

	apply(checkResult?: UpdateCheckResult): { changed: boolean; version: string } {
		if (this.installChannel() !== "global-npm") {
			throw new UpdateError(
				"automatic installation is available only for a real global npm install; update this source, local, or npx invocation through its owning channel",
				"unsupported-install-channel",
			);
		}
		const check = checkResult ?? this.check();
		if (check.status === "current") return { changed: false, version: this.currentVersion };
		const now = this.now();
		const releaseLock = acquireUpdateLock(updateLockPath(this.paths), now);
		let directory: string | undefined;
		let backup: PackedArtifact | undefined;
		let candidate: PackedArtifact | undefined;
		let installedAndVerified = false;
		try {
			directory = this.createDownloadDirectory();
			this.report(`Downloading Jouzu ${check.version}…`);
			backup = this.pack(this.packageRoot, directory, this.currentVersion);
			verifyFileIntegrity(backup.path, backup.integrity);
			candidate = this.pack(`jouzu@${check.version}`, directory, check.version);
			if (candidate.integrity !== check.integrity) {
				throw new UpdateError("npm metadata changed during update download", "registry-integrity-drift");
			}
			verifyFileIntegrity(candidate.path, check.integrity);
			this.report(`Installing Jouzu ${check.version}…`);
			try {
				this.installTarball(candidate.path);
				this.verifyInstalled(check.version);
				installedAndVerified = true;
			} catch {
				let currentRemainsVerified = false;
				try {
					this.verifyInstalled(this.currentVersion);
					currentRemainsVerified = true;
				} catch {}
				if (currentRemainsVerified) {
					throw new UpdateError(
						`Jouzu ${check.version} was not installed; ${this.currentVersion} remains verified`,
						"update-not-installed",
					);
				}
				this.report(`Jouzu ${check.version} failed verification; restoring ${this.currentVersion}…`);
				try {
					verifyFileIntegrity(backup.path, backup.integrity);
					this.installTarball(backup.path);
					this.verifyInstalled(this.currentVersion);
				} catch {
					throw new UpdateError(
						"Jouzu update and automatic rollback both failed; reinstall the previous Jouzu version with npm",
						"rollback-failed",
						{ fatal: true },
					);
				}
				throw new UpdateError(
					`Jouzu ${check.version} failed verification and ${this.currentVersion} was restored`,
					"update-rolled-back",
				);
			}
			try {
				const state = this.readState();
				this.writeState({
					...state,
					lastResult: "updated",
					installedVersion: check.version,
					latestVersion: check.version,
					latestIntegrity: check.integrity,
					previousVersion: this.currentVersion,
					lastUpdatedAt: now.toISOString(),
					lastErrorCode: null,
				});
			} catch {
				this.report("Jouzu was updated and verified, but its update status could not be recorded.");
			}
			return { changed: true, version: check.version };
		} catch (error) {
			if (installedAndVerified) return { changed: true, version: check.version };
			const updateError =
				error instanceof UpdateError ? error : new UpdateError("Jouzu update failed", "update-failed");
			this.recordFailure(updateError.code, now);
			throw updateError;
		} finally {
			for (const artifact of [candidate, backup]) {
				if (!artifact) continue;
				try {
					unlinkSync(artifact.path);
				} catch {}
			}
			if (directory) {
				try {
					rmdirSync(directory);
				} catch {}
			}
			releaseLock();
		}
	}

	startup(): StartupUpdateResult {
		if (this.env.JOUZU_INTERNAL_UPDATE_RESTARTED === "1") return { action: "continue" };
		let state: UpdateState;
		try {
			state = this.readState();
		} catch (error) {
			return {
				action: "continue",
				message: `Automatic update skipped: ${error instanceof Error ? error.message : error}`,
			};
		}
		const policy = effectivePolicy(state, this.env);
		if (policy === "off") return { action: "continue" };
		if (this.installChannel() !== "global-npm") return { action: "continue" };
		let check: UpdateCheckResult | undefined;
		if (
			!checkIsDue(state, this.now()) &&
			state.lastResult === "available" &&
			state.latestVersion !== null &&
			state.latestIntegrity !== null &&
			compareSemver(state.latestVersion, this.currentVersion) > 0
		) {
			check = {
				status: "available",
				installedVersion: this.currentVersion,
				version: state.latestVersion,
				integrity: state.latestIntegrity,
			};
		} else if (!checkIsDue(state, this.now())) {
			return { action: "continue" };
		}
		if (!check) {
			try {
				check = this.check();
			} catch (error) {
				return {
					action: "continue",
					message: `Jouzu update check failed; continuing with ${this.currentVersion} (${error instanceof UpdateError ? error.code : "unknown"})`,
				};
			}
		}
		if (check.status === "current") return { action: "continue" };
		if (policy === "notify") {
			return {
				action: "continue",
				message: `Jouzu ${check.version} is available; run "jouzu self-update apply"`,
			};
		}
		try {
			const applied = this.apply(check);
			return applied.changed ? { action: "restart", version: applied.version } : { action: "continue" };
		} catch (error) {
			if (error instanceof UpdateError && error.fatal) throw error;
			return {
				action: "continue",
				message: `Jouzu update failed; continuing with ${this.currentVersion} (${error instanceof UpdateError ? error.code : "unknown"})`,
			};
		}
	}
}

export function relaunchUpdatedJouzu(options: { executable: string; args: string[]; env?: NodeJS.ProcessEnv }): number {
	const result = spawnSync(process.execPath, [options.executable, ...options.args], {
		stdio: "inherit",
		env: { ...(options.env ?? process.env), JOUZU_INTERNAL_UPDATE_RESTARTED: "1" },
	});
	if (result.error)
		throw new UpdateError(`updated Jouzu could not restart: ${result.error.message}`, "restart-failed", {
			fatal: true,
		});
	if (result.signal) return 128;
	return result.status ?? 1;
}

export function formatUpdateStatus(status: UpdateStatus): string {
	const state = status.state;
	return [
		"Jouzu self-update status",
		`Policy: ${status.policy}`,
		`Install channel: ${status.installChannel}`,
		`Automatic startup update: ${status.startupEligible ? "eligible" : "not eligible"}`,
		`Installed version: ${state.installedVersion}`,
		`Latest observed version: ${state.latestVersion ?? "not checked"}`,
		`Last result: ${state.lastResult}`,
		`Last checked: ${state.lastCheckedAt ?? "never"}`,
		`Next check: ${state.nextCheckAt ?? "due"}`,
		`Last updated: ${state.lastUpdatedAt ?? "never"}`,
		`Previous version: ${state.previousVersion ?? "none"}`,
		`Last error: ${state.lastErrorCode ?? "none"}`,
	].join("\n");
}
