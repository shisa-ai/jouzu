import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { JouzuPaths } from "./paths.js";
import { copyPrivateFile, ensurePrivateDirectory, validatePrivateDirectory } from "./private-fs.js";
import { acquireStateLock, STATE_LOCK_STALE_MS } from "./state-lock.js";

export type KeyBindingValue = string | string[];
export type KeybindingPolicy = "applied" | "disabled";
export type KeybindingStatusKind = "uninitialized" | "converged" | "customized";

export const JOUZU_KEYBINDING_DEFAULTS_VERSION = 1;
export const JOUZU_KEYBINDING_DEFAULTS: Readonly<Record<string, KeyBindingValue>> = Object.freeze({
	"app.message.followUp": "tab",
	"app.message.dequeue": "ctrl+up",
});

const STATE_FIELDS = new Set([
	"schemaVersion",
	"defaultsVersion",
	"policy",
	"transactionId",
	"updatedAt",
	"createdConfig",
	"insertedBindings",
]);
const INSERTED_BINDING_FIELDS = new Set(["action", "binding"]);
const EDITOR_PRIORITY_ACTIONS = new Set(["tui.editor.historyPrevious", "tui.editor.historyNext"]);
const LEGACY_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
	"app.message.followUp": "followUp",
	"app.message.dequeue": "dequeue",
});

export interface InsertedBinding {
	action: string;
	binding: KeyBindingValue;
}

export interface KeybindingState {
	schemaVersion: 1;
	defaultsVersion: number;
	policy: KeybindingPolicy;
	transactionId: string;
	updatedAt: string;
	createdConfig: boolean;
	insertedBindings: InsertedBinding[];
}

export interface KeybindingPlanAction {
	type: "set" | "remove" | "conflict";
	action: string;
	binding?: KeyBindingValue;
	reason: string;
	conflictingAction?: string;
	observed?: KeyBindingValue;
}

export interface KeybindingPlan {
	schemaVersion: 1;
	defaultsVersion: number;
	configPath: string;
	statePath: string;
	configExists: boolean;
	policy: KeybindingPolicy | "unset";
	status: KeybindingStatusKind;
	portabilityWarnings: string[];
	actions: KeybindingPlanAction[];
}

export interface ApplyKeybindingsResult {
	changed: boolean;
	plan: KeybindingPlan;
	transactionId?: string;
	backupDir?: string;
}

export interface BootstrapKeybindingsResult {
	changed: boolean;
	message?: string;
}

export class KeybindingConfigError extends Error {
	readonly exitCode = 5;

	constructor(message: string) {
		super(message);
		this.name = "KeybindingConfigError";
	}
}

export class KeybindingConflictError extends KeybindingConfigError {
	readonly plan: KeybindingPlan;

	constructor(plan: KeybindingPlan) {
		super("keybinding plan contains conflicts");
		this.name = "KeybindingConflictError";
		this.plan = plan;
	}
}

function exactFields(value: Record<string, unknown>, fields: Set<string>): boolean {
	return Object.keys(value).every((key) => fields.has(key)) && Object.keys(value).length === fields.size;
}

function bindingIsValid(value: unknown): value is KeyBindingValue {
	return (
		(typeof value === "string" && value.length > 0) ||
		(Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0))
	);
}

function bindingKeys(value: KeyBindingValue): string[] {
	return (typeof value === "string" ? [value] : value).map((key) => key.toLowerCase());
}

function bindingEquals(left: KeyBindingValue, right: KeyBindingValue): boolean {
	const a = bindingKeys(left);
	const b = bindingKeys(right);
	return a.length === b.length && a.every((key, index) => key === b[index]);
}

function configPath(paths: JouzuPaths): string {
	return join(paths.agentDir, "keybindings.json");
}

export function keybindingStatePath(paths: JouzuPaths): string {
	return join(paths.stateDir, "keybindings-state.json");
}

function lockPath(paths: JouzuPaths): string {
	return join(paths.stateDir, "keybindings.lock");
}

function readRegularJson(path: string, label: string): unknown {
	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new KeybindingConfigError(`${label} must be a regular file`);
	}
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new KeybindingConfigError(`${label} is invalid JSON: ${error instanceof Error ? error.message : error}`);
	}
}

export function readKeybindingConfig(path: string): Record<string, KeyBindingValue> | undefined {
	if (!existsSync(path)) return undefined;
	const parsed = readRegularJson(path, "keybindings.json");
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new KeybindingConfigError("keybindings.json must be an object");
	}
	const config: Record<string, KeyBindingValue> = {};
	for (const [action, binding] of Object.entries(parsed)) {
		if (!bindingIsValid(binding)) {
			throw new KeybindingConfigError(`keybindings.json binding for ${action} must be a key or array of keys`);
		}
		config[action] = binding;
	}
	return config;
}

export function readKeybindingState(path: string): KeybindingState | undefined {
	if (!existsSync(path)) return undefined;
	const parsed = readRegularJson(path, "keybinding state");
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new KeybindingConfigError("keybinding state must be an object");
	}
	const value = parsed as Record<string, unknown>;
	if (
		!exactFields(value, STATE_FIELDS) ||
		value.schemaVersion !== 1 ||
		!Number.isInteger(value.defaultsVersion) ||
		Number(value.defaultsVersion) < 1 ||
		(value.policy !== "applied" && value.policy !== "disabled") ||
		typeof value.transactionId !== "string" ||
		typeof value.updatedAt !== "string" ||
		!Number.isFinite(Date.parse(value.updatedAt)) ||
		typeof value.createdConfig !== "boolean" ||
		!Array.isArray(value.insertedBindings)
	) {
		throw new KeybindingConfigError("keybinding state fields are invalid");
	}
	const actions = new Set<string>();
	const insertedBindings = value.insertedBindings.map((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new KeybindingConfigError("keybinding state inserted binding must be an object");
		}
		const binding = entry as Record<string, unknown>;
		if (
			!exactFields(binding, INSERTED_BINDING_FIELDS) ||
			typeof binding.action !== "string" ||
			!bindingIsValid(binding.binding) ||
			actions.has(binding.action)
		) {
			throw new KeybindingConfigError("keybinding state inserted binding is invalid or duplicated");
		}
		actions.add(binding.action);
		return { action: binding.action, binding: binding.binding };
	});
	return {
		schemaVersion: 1,
		defaultsVersion: Number(value.defaultsVersion),
		policy: value.policy,
		transactionId: value.transactionId,
		updatedAt: value.updatedAt,
		createdConfig: value.createdConfig,
		insertedBindings,
	};
}

function claimsEditorPriority(action: string): boolean {
	return action.startsWith("app.") || EDITOR_PRIORITY_ACTIONS.has(action);
}

function findConflict(
	config: Record<string, KeyBindingValue>,
	targetAction: string,
	targetBinding: KeyBindingValue,
): string | undefined {
	const desiredKeys = new Set(bindingKeys(targetBinding));
	for (const [action, binding] of Object.entries(config)) {
		if (action === targetAction || !claimsEditorPriority(action)) continue;
		if (bindingKeys(binding).some((key) => desiredKeys.has(key))) return action;
	}
	return undefined;
}

function observedBinding(config: Record<string, KeyBindingValue>, action: string): KeyBindingValue | undefined {
	return config[action] ?? (LEGACY_ACTIONS[action] ? config[LEGACY_ACTIONS[action]] : undefined);
}

function statusFor(config: Record<string, KeyBindingValue> | undefined): KeybindingStatusKind {
	if (!config) return "uninitialized";
	return Object.entries(JOUZU_KEYBINDING_DEFAULTS).every(([action, binding]) => {
		const observed = observedBinding(config, action);
		return observed !== undefined && bindingEquals(observed, binding);
	})
		? "converged"
		: "customized";
}

function getPortabilityWarnings(options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): string[] {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const warnings = [
		"ctrl+up requires the terminal to report modified arrow keys; tmux users should enable extended-keys with extended-keys-format csi-u",
	];
	if (platform === "darwin") {
		warnings.push("macOS may reserve Control+Up for Mission Control until the system shortcut is changed");
	}
	if (env.TERM === "dumb") warnings.push("TERM=dumb cannot provide reliable interactive key events");
	return warnings;
}

export function planKeybindings(
	paths: JouzuPaths,
	options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): KeybindingPlan {
	try {
		validatePrivateDirectory(paths.agentDir);
		validatePrivateDirectory(paths.stateDir);
	} catch (error) {
		throw new KeybindingConfigError(error instanceof Error ? error.message : String(error));
	}
	const path = configPath(paths);
	const statePath = keybindingStatePath(paths);
	const config = readKeybindingConfig(path);
	const state = readKeybindingState(statePath);
	const actions: KeybindingPlanAction[] = [];
	for (const [action, binding] of Object.entries(JOUZU_KEYBINDING_DEFAULTS)) {
		const observed = config ? observedBinding(config, action) : undefined;
		if (observed !== undefined && !bindingEquals(observed, binding)) {
			actions.push({ type: "conflict", action, binding, observed, reason: "user-binding-differs" });
			continue;
		}
		const conflictingAction = config ? findConflict(config, action, binding) : undefined;
		if (conflictingAction) {
			actions.push({
				type: "conflict",
				action,
				binding,
				reason: "key-claimed-by-another-editor-action",
				conflictingAction,
			});
			continue;
		}
		if (observed === undefined)
			actions.push({ type: "set", action, binding, reason: config ? "missing" : "new-config" });
	}
	return {
		schemaVersion: 1,
		defaultsVersion: JOUZU_KEYBINDING_DEFAULTS_VERSION,
		configPath: path,
		statePath,
		configExists: config !== undefined,
		policy: state?.policy ?? "unset",
		status: statusFor(config),
		portabilityWarnings: getPortabilityWarnings(options),
		actions,
	};
}

function atomicWrite(path: string, bytes: string | Uint8Array, privateRoot: string): void {
	ensurePrivateDirectory(privateRoot, dirname(path));
	const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, "wx", 0o600);
		writeFileSync(descriptor, bytes);
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		rmSync(temporary, { force: true });
	}
}

function writeJson(path: string, value: unknown, privateRoot: string): void {
	atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, privateRoot);
}

function withLock<T>(paths: JouzuPaths, operation: () => T): T {
	const releaseLock = acquireStateLock({
		path: lockPath(paths),
		staleMs: STATE_LOCK_STALE_MS,
		describe: "keybinding",
		onBusy: (inspection) =>
			new KeybindingConfigError(
				inspection.status === "invalid"
					? "keybindings.lock is not a regular lock file"
					: "another keybinding operation is in progress",
			),
	});
	try {
		return operation();
	} finally {
		releaseLock();
	}
}

function backupConfig(paths: JouzuPaths, transactionId: string, source: string): string {
	const directory = join(paths.backupDir, "keybindings", transactionId);
	copyPrivateFile(source, join(directory, "keybindings.json"), paths.stateDir);
	return directory;
}

function makeState(options: {
	policy: KeybindingPolicy;
	transactionId: string;
	createdConfig: boolean;
	insertedBindings: InsertedBinding[];
	now: Date;
}): KeybindingState {
	return {
		schemaVersion: 1,
		defaultsVersion: JOUZU_KEYBINDING_DEFAULTS_VERSION,
		policy: options.policy,
		transactionId: options.transactionId,
		updatedAt: options.now.toISOString(),
		createdConfig: options.createdConfig,
		insertedBindings: [...options.insertedBindings].sort((left, right) => left.action.localeCompare(right.action)),
	};
}

export function applyKeybindings(paths: JouzuPaths, now = new Date()): ApplyKeybindingsResult {
	const initial = planKeybindings(paths);
	if (initial.actions.some((action) => action.type === "conflict")) throw new KeybindingConflictError(initial);
	return withLock(paths, () => {
		const plan = planKeybindings(paths);
		if (plan.actions.some((action) => action.type === "conflict")) throw new KeybindingConflictError(plan);
		const config = readKeybindingConfig(plan.configPath) ?? {};
		const previousState = readKeybindingState(plan.statePath);
		const setActions = plan.actions.filter((action) => action.type === "set");
		if (setActions.length === 0 && previousState?.policy === "applied") return { changed: false, plan };

		const transactionId = randomUUID();
		const previousBytes = existsSync(plan.configPath) ? readFileSync(plan.configPath) : undefined;
		const createdConfig = previousState?.createdConfig ?? previousBytes === undefined;
		let backupDir: string | undefined;
		if (previousBytes) backupDir = backupConfig(paths, transactionId, plan.configPath);
		const inserted = new Map(previousState?.insertedBindings.map((entry) => [entry.action, entry]) ?? []);
		for (const action of setActions) {
			if (action.binding === undefined) throw new KeybindingConfigError("keybinding set action is missing a binding");
			config[action.action] = action.binding;
			inserted.set(action.action, { action: action.action, binding: action.binding });
		}
		const state = makeState({
			policy: "applied",
			transactionId,
			createdConfig,
			insertedBindings: [...inserted.values()],
			now,
		});
		try {
			if (setActions.length > 0) writeJson(plan.configPath, config, paths.agentDir);
			writeJson(plan.statePath, state, paths.stateDir);
		} catch (error) {
			if (setActions.length > 0) {
				if (previousBytes) atomicWrite(plan.configPath, previousBytes, paths.agentDir);
				else rmSync(plan.configPath, { force: true });
			}
			throw error;
		}
		return {
			changed: setActions.length > 0 || previousState?.policy !== "applied",
			plan,
			transactionId,
			...(backupDir ? { backupDir } : {}),
		};
	});
}

export function resetKeybindings(paths: JouzuPaths, now = new Date()): ApplyKeybindingsResult {
	return withLock(paths, () => {
		const path = configPath(paths);
		const statePath = keybindingStatePath(paths);
		const config = readKeybindingConfig(path);
		const state = readKeybindingState(statePath);
		const actions: KeybindingPlanAction[] = [];
		for (const inserted of state?.insertedBindings ?? []) {
			const observed = config?.[inserted.action];
			if (observed === undefined) continue;
			if (!bindingEquals(observed, inserted.binding)) {
				actions.push({
					type: "conflict",
					action: inserted.action,
					binding: inserted.binding,
					observed,
					reason: "jouzu-seeded-binding-was-modified",
				});
			} else {
				actions.push({ type: "remove", action: inserted.action, binding: inserted.binding, reason: "reset-default" });
			}
		}
		const plan: KeybindingPlan = {
			schemaVersion: 1,
			defaultsVersion: JOUZU_KEYBINDING_DEFAULTS_VERSION,
			configPath: path,
			statePath,
			configExists: config !== undefined,
			policy: state?.policy ?? "unset",
			status: statusFor(config),
			portabilityWarnings: getPortabilityWarnings(),
			actions,
		};
		if (actions.some((action) => action.type === "conflict")) throw new KeybindingConflictError(plan);

		const transactionId = randomUUID();
		const previousBytes = config ? readFileSync(path) : undefined;
		let backupDir: string | undefined;
		if (previousBytes) backupDir = backupConfig(paths, transactionId, path);
		const nextConfig = { ...(config ?? {}) };
		for (const action of actions) delete nextConfig[action.action];
		const disabledState = makeState({
			policy: "disabled",
			transactionId,
			createdConfig: false,
			insertedBindings: [],
			now,
		});
		try {
			if (actions.length > 0) {
				if (Object.keys(nextConfig).length === 0 && state?.createdConfig) unlinkSync(path);
				else writeJson(path, nextConfig, paths.agentDir);
			}
			writeJson(statePath, disabledState, paths.stateDir);
		} catch (error) {
			if (previousBytes) atomicWrite(path, previousBytes, paths.agentDir);
			throw error;
		}
		return {
			changed: actions.length > 0 || state?.policy !== "disabled",
			plan,
			transactionId,
			...(backupDir ? { backupDir } : {}),
		};
	});
}

export function ensureDefaultKeybindings(
	paths: JouzuPaths,
	env: NodeJS.ProcessEnv = process.env,
): BootstrapKeybindingsResult {
	if (["1", "true", "yes", "on"].includes((env.JOUZU_NO_KEYBINDING_DEFAULTS ?? "").toLowerCase())) {
		return { changed: false };
	}
	try {
		const state = readKeybindingState(keybindingStatePath(paths));
		const configExists = existsSync(configPath(paths));
		if (configExists) readKeybindingConfig(configPath(paths));
		if (state || configExists) return { changed: false };
		const result = applyKeybindings(paths);
		return { changed: result.changed };
	} catch (error) {
		return {
			changed: false,
			message: `Jouzu keybinding defaults were not applied: ${error instanceof Error ? error.message : error}`,
		};
	}
}

function formatBinding(binding: KeyBindingValue | undefined): string {
	if (binding === undefined) return "Pi default or unbound";
	return typeof binding === "string" ? binding : binding.length > 0 ? binding.join(", ") : "unbound";
}

export function formatKeybindingPlan(plan: KeybindingPlan): string {
	const lines = [
		"Jouzu keybinding plan",
		`Defaults: v${plan.defaultsVersion}`,
		`Status: ${plan.status}`,
		`Policy: ${plan.policy}`,
		`Config: ${plan.configPath}`,
		"Desired bindings:",
	];
	for (const [action, binding] of Object.entries(JOUZU_KEYBINDING_DEFAULTS)) {
		lines.push(`- ${action}: ${formatBinding(binding)}`);
	}
	if (plan.portabilityWarnings.length > 0) {
		lines.push("Portability:");
		for (const warning of plan.portabilityWarnings) lines.push(`- ${warning}`);
	}
	lines.push(`Actions (${plan.actions.length}):`);
	if (plan.actions.length === 0) lines.push("- none");
	for (const action of plan.actions) {
		const detail = action.conflictingAction
			? `; conflicts with ${action.conflictingAction}`
			: action.observed !== undefined
				? `; current ${formatBinding(action.observed)}`
				: "";
		lines.push(`- ${action.type.toUpperCase()} ${action.action} (${action.reason}${detail})`);
	}
	return lines.join("\n");
}
