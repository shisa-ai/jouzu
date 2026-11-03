/**
 * Stable message IDs and the English resolution table for the pre-runtime error
 * boundary.
 *
 * Every branch of `handleMainCliError`, the bootstrap error handling in
 * `cli.ts`, and every `UsageError` raised by `args.ts` has an ID here. The ID
 * and the protected values passed with it are the contract; the template text
 * is resolved only for the human stream. A later localization milestone replaces
 * the `en` table with a catalog lookup without changing the IDs or values.
 *
 * Values that must not be split by a wrapper carry a `ProtectedValue` kind, so
 * the renderer distinguishes a path from a command by type rather than by
 * convention.
 */

/**
 * The kinds of values that must survive wrapping as one unit. The kind is a
 * type, not a naming convention: the wrapper and a later catalog can treat a
 * path, a command, or a raw runtime error differently without guessing.
 */
export type ProtectedValueKind = "command" | "path" | "url" | "model-id" | "error-code" | "source-error" | "digest";

/** A value a renderer must not split across lines. */
export interface ProtectedValue {
	readonly kind: ProtectedValueKind;
	readonly value: string;
}

/** A placeholder value in a human message: plain text, a number, or a protected value. */
export type HumanMessageValue = string | number | ProtectedValue;

export interface HumanMessage {
	readonly id: string;
	readonly args?: Readonly<Record<string, HumanMessageValue>>;
}

/** The locale set the display context carries. Only the `en` table ships today. */
export type HumanLocale = "en" | "ja" | "zh-Hans" | "zh-Hant";

/** Construct a protected value of any kind. Prefer the kind-specific helpers. */
export function protectedValue(kind: ProtectedValueKind, value: string): ProtectedValue {
	return { kind, value };
}

/** A command, subcommand, option, or token name. */
export function protectedCommand(value: string): ProtectedValue {
	return { kind: "command", value };
}

/** A filesystem path. */
export function protectedPath(value: string): ProtectedValue {
	return { kind: "path", value };
}

/** A URL. */
export function protectedUrl(value: string): ProtectedValue {
	return { kind: "url", value };
}

/** A model or provider identifier. */
export function protectedModelId(value: string): ProtectedValue {
	return { kind: "model-id", value };
}

/** A stable machine error code, such as a doctor issue identifier. */
export function protectedErrorCode(value: string): ProtectedValue {
	return { kind: "error-code", value };
}

/** A raw message from an underlying runtime or library. */
export function protectedSourceError(value: string): ProtectedValue {
	return { kind: "source-error", value };
}

/** A content digest or integrity value. */
export function protectedDigest(value: string): ProtectedValue {
	return { kind: "digest", value };
}

/** The single place later milestones look up pre-runtime error and argument IDs. */
export const CliMessageId = {
	// handleMainCliError branches and their recovery lines.
	piImport: "jouzu.cli.error.piImport",
	keybindingConflict: "jouzu.cli.error.keybindingConflict",
	keybindingConflictRecovery: "jouzu.cli.error.keybindingConflict.recovery",
	keybindingConfig: "jouzu.cli.error.keybindingConfig",
	profileState: "jouzu.cli.error.profileState",
	profileStateRecovery: "jouzu.cli.error.profileState.recovery",
	profileConflict: "jouzu.cli.error.profileConflict",
	profileConflictRecovery: "jouzu.cli.error.profileConflict.recovery",
	usage: "jouzu.cli.error.usage",
	usageHint: "jouzu.cli.error.usage.hint",
	generic: "jouzu.cli.error.generic",
	// Bootstrap-only branch in cli.ts.
	update: "jouzu.cli.error.update",
	// Argument and option errors raised by args.ts.
	optionValueRequired: "jouzu.cli.args.optionValueRequired",
	internalParserError: "jouzu.cli.args.internalParserError",
	catalogOperationRequired: "jouzu.cli.args.catalogOperationRequired",
	catalogAcceptOptionsRequireValues: "jouzu.cli.args.catalogAcceptOptionsRequireValues",
	catalogUnknownAcceptOption: "jouzu.cli.args.catalogUnknownAcceptOption",
	catalogAcceptUsage: "jouzu.cli.args.catalogAcceptUsage",
	catalogFileRequired: "jouzu.cli.args.catalogFileRequired",
	catalogUnknownOption: "jouzu.cli.args.catalogUnknownOption",
	selfUpdateOperationRequired: "jouzu.cli.args.selfUpdateOperationRequired",
	selfUpdatePolicyRequired: "jouzu.cli.args.selfUpdatePolicyRequired",
	selfUpdatePolicySingleValue: "jouzu.cli.args.selfUpdatePolicySingleValue",
	selfUpdateUnknownOption: "jouzu.cli.args.selfUpdateUnknownOption",
	keybindingsOperationRequired: "jouzu.cli.args.keybindingsOperationRequired",
	keybindingsUnknownOption: "jouzu.cli.args.keybindingsUnknownOption",
	profileMixedSelection: "jouzu.cli.args.profileMixedSelection",
	profileOperationRequired: "jouzu.cli.args.profileOperationRequired",
	profileRepeatedOption: "jouzu.cli.args.profileRepeatedOption",
	profileInvalidId: "jouzu.cli.args.profileInvalidId",
	profileRepeatedJson: "jouzu.cli.args.profileRepeatedJson",
	profileUnknownOption: "jouzu.cli.args.profileUnknownOption",
	profileMigrationOperationRequired: "jouzu.cli.args.profileMigrationOperationRequired",
	profileMigrationUnknownOption: "jouzu.cli.args.profileMigrationUnknownOption",
	homeRepeated: "jouzu.cli.args.homeRepeated",
	launchProfileRepeated: "jouzu.cli.args.launchProfileRepeated",
	launchProfileInvalidId: "jouzu.cli.args.launchProfileInvalidId",
	uiLocaleRepeated: "jouzu.cli.args.uiLocaleRepeated",
	uiLocaleInvalid: "jouzu.cli.args.uiLocaleInvalid",
	textguardRepeated: "jouzu.cli.args.textguardRepeated",
	unknownJouzuOption: "jouzu.cli.args.unknownJouzuOption",
	textguardOffStrict: "jouzu.cli.args.textguardOffStrict",
	textguardOffFiles: "jouzu.cli.args.textguardOffFiles",
	doctorUnexpectedToken: "jouzu.cli.args.doctorUnexpectedToken",
	versionHelpArguments: "jouzu.cli.args.versionHelpArguments",
} as const;

export type CliMessageId = (typeof CliMessageId)[keyof typeof CliMessageId];

/**
 * The English table. It is intentionally complete: `satisfies` fails the build
 * when a new ID is added without a message.
 */
const EN_MESSAGES = {
	[CliMessageId.piImport]: "Jouzu Pi import failed: {message}",
	[CliMessageId.keybindingConflict]: "{plan}",
	[CliMessageId.keybindingConflictRecovery]: 'Resolve the conflicts above, then run "jouzu keybindings apply" again.',
	[CliMessageId.keybindingConfig]: "Jouzu keybindings failed: {message}",
	[CliMessageId.profileState]: "Jouzu profile state is unreadable: {message}",
	[CliMessageId.profileStateRecovery]:
		'Recovery: repair or remove the profile state file, then run "jouzu profile plan" and "jouzu profile apply" again.',
	[CliMessageId.profileConflict]: "{plan}",
	[CliMessageId.profileConflictRecovery]: 'Resolve the conflicts above, then run "jouzu profile apply" again.',
	[CliMessageId.usage]: "Error: {message}",
	[CliMessageId.usageHint]: 'Run "jouzu --help" for Jouzu usage or "jouzu pi --help" for Pi usage.',
	[CliMessageId.generic]: "Jouzu failed: {message}",
	[CliMessageId.update]: "Jouzu update failed: {message}",
	[CliMessageId.optionValueRequired]: "{option} requires a value",
	[CliMessageId.internalParserError]: "internal parser error for {option}",
	[CliMessageId.catalogOperationRequired]:
		'catalog requires "status", "refresh", "accept", "reject", "validate", or "conformance"',
	[CliMessageId.catalogAcceptOptionsRequireValues]: "catalog {operation} options require values",
	[CliMessageId.catalogUnknownAcceptOption]: "unknown catalog {operation} option: {option}",
	[CliMessageId.catalogAcceptUsage]: "catalog {operation} requires <revision> --digest <sha256> [--source <source-id>]",
	[CliMessageId.catalogFileRequired]: "catalog {operation} requires one file path and optional --json",
	[CliMessageId.catalogUnknownOption]: "unknown catalog {operation} option: {token}",
	[CliMessageId.selfUpdateOperationRequired]: 'self-update requires "status", "check", "apply", or "policy"',
	[CliMessageId.selfUpdatePolicyRequired]: "self-update policy must be one of: auto-restart, notify, off",
	[CliMessageId.selfUpdatePolicySingleValue]: "self-update policy accepts exactly one value",
	[CliMessageId.selfUpdateUnknownOption]: "unknown self-update {operation} option: {token}",
	[CliMessageId.keybindingsOperationRequired]: 'keybindings requires "status", "plan", "apply", or "reset"',
	[CliMessageId.keybindingsUnknownOption]: "unknown keybindings {operation} option: {token}",
	[CliMessageId.profileMixedSelection]: "use profile --profile <core|ja>; do not mix it with --jouzu-profile",
	[CliMessageId.profileOperationRequired]: 'profile requires "plan" or "apply"',
	[CliMessageId.profileRepeatedOption]: "--profile may be specified only once",
	[CliMessageId.profileInvalidId]: "--profile must be one of: {values}",
	[CliMessageId.profileRepeatedJson]: "--json may be specified only once",
	[CliMessageId.profileUnknownOption]: "unknown profile {operation} option: {token}",
	[CliMessageId.profileMigrationOperationRequired]: 'profile-migration requires "plan", "apply", or "rollback"',
	[CliMessageId.profileMigrationUnknownOption]: "unknown profile-migration {operation} option: {token}",
	[CliMessageId.homeRepeated]: "--jouzu-home may be specified only once",
	[CliMessageId.launchProfileRepeated]: "--jouzu-profile may be specified only once",
	[CliMessageId.launchProfileInvalidId]: "--jouzu-profile must be one of: {values}",
	[CliMessageId.uiLocaleRepeated]: "--jouzu-ui-locale may be specified only once",
	[CliMessageId.uiLocaleInvalid]: "--jouzu-ui-locale must be one of: {values}",
	[CliMessageId.textguardRepeated]: "{option} may be specified only once",
	[CliMessageId.unknownJouzuOption]: "unknown Jouzu option: {token}",
	[CliMessageId.textguardOffStrict]: "--jouzu-textguard-off and --jouzu-textguard-strict cannot be combined",
	[CliMessageId.textguardOffFiles]: "--jouzu-textguard-off and --jouzu-textguard-files cannot be combined",
	[CliMessageId.doctorUnexpectedToken]: "doctor does not accept {token}",
	[CliMessageId.versionHelpArguments]: '{command} does not accept arguments; use "jouzu pi {command}" for Pi',
} satisfies Record<CliMessageId, string>;

export function humanMessage(id: CliMessageId, args?: Readonly<Record<string, HumanMessageValue>>): HumanMessage {
	return args === undefined ? { id } : { id, args };
}

/** Whether an arbitrary message ID is one of the pre-runtime `CliMessageId` values. */
export function isCliMessageId(id: string): id is CliMessageId {
	return (Object.values(CliMessageId) as readonly string[]).includes(id);
}

/**
 * Resolution tables keyed by locale. Only `en` ships today; adding a locale adds
 * an entry here (or replaces `en`) without touching a single call site.
 */
const MESSAGE_TABLES: Readonly<Partial<Record<HumanLocale, Readonly<Record<string, string>>>>> = {
	en: EN_MESSAGES as Readonly<Record<string, string>>,
};

function renderMessageArg(value: HumanMessageValue): string {
	return typeof value === "object" ? value.value : String(value);
}

/**
 * Resolve a message descriptor to text.
 *
 * A locale with no table yet falls back to `en`, so a caller may pass the
 * resolved display locale before the catalog exists. Call sites therefore need
 * no change when the catalog arrives.
 */
export function resolveHumanMessage(message: HumanMessage, locale: HumanLocale = "en"): string {
	const table = MESSAGE_TABLES[locale] ?? MESSAGE_TABLES.en;
	const template = table?.[message.id];
	if (template === undefined) throw new Error(`unknown human message id: ${message.id}`);
	return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/gu, (_placeholder, name: string) => {
		const value = message.args?.[name];
		if (value === undefined) throw new Error(`human message ${message.id} is missing value "${name}"`);
		return renderMessageArg(value);
	});
}
