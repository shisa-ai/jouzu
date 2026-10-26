#!/usr/bin/env python3
"""Materialize the authored, finite source-only importer review (no product imports)."""

import csv
import hashlib
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
AUDIT = HERE.parent
CLI = "packages/cli/src/"
TRACES = []


def add(name, ranges, classification, handling, consumer, provenance, findings, ambiguity, anchors):
    TRACES.append(dict(source_file=CLI + name + ".ts", read_ranges=ranges,
                       classification=classification, local_handling=handling,
                       immediate_consumer=consumer, provenance=provenance,
                       finding_refs=findings.split("; "), residual_ambiguity=ambiguity,
                       anchors=[CLI + anchor for anchor in anchors.split("; ")]))


add("camoufox-adapter", [[65, 129], [210, 489], [535, 574], [670, 749], [860, 1018]],
    "mixed-forwarded-and-suppressed",
    "runtimeIsInstalled catches directory validation and returns false; inspection catches it as invalid. Installation's initial ensurePrivateDirectory and later destination validation propagate. acquireStateLock busy failures are retried except invalid status, with a local timeout replacement; nonbusy path/OS failures escape. Release suppresses errors in state-lock. omitDeclinedArguments only copies/normalizes optional input; it does not translate schemas or result text.",
    "loadCamoufoxRuntime awaits installation; getRuntime clears its cached promise and rethrows; lazyTool.execute has finally but no replacing catch. Rejection crosses the Pi tool boundary, unlike successful content projection. No final host error renderer is claimed.",
    "PrivatePathError is owned English plus a protected path; OS/npm/library diagnostics have separate source provenance. Busy status is protocol data in owned English framing. Tool descriptions are model instructions; fetched text is external payload.",
    "terminal-owned:browser.tool-labels; terminal-owned:browser.screenshot-lines; import-consumers.browser.install-errors",
    "Host tool rejection conversion, rendering/persistence, optional installed runtime internals, timing and native installation remain unverified.",
    "camoufox-adapter.ts:75-80; camoufox-adapter.ts:228-282; camoufox-adapter.ts:346-420; camoufox-adapter.ts:537-541; camoufox-adapter.ts:719-737; camoufox-adapter.ts:908-972")

add("catalog-sources", [[350, 774], [815, 884]], "mixed-forwarded-and-suppressed",
    "Registry/override/token loads validate directories before their parser catches. Atomic registry/override/token writes have no helper-error replacement. credentialState suppresses stored-token read errors, and readShisaLoginToken itself suppresses auth-file failures. isShisaSignedOut gates availability/source enablement and produces a catalog auth_required refusal at request resolution.",
    "Settings constructs CatalogSourceStore with its catalog; saveForm catches add/update/activation/token-write errors and displays sanitized Error.message. Remove and toggle invoke store methods without the same local catch; their final host handling is not established. Operator configuration failures can reach handleMainCliError's generic frame.",
    "Directory safety sentences are owned English, not OS text. Saved tokens never become display arguments here. Credential presence/sign-out flags and auth_required are machine state; catalog messages describe absence without exposing suppressed auth diagnostics.",
    "semantic-owned/files.csv:packages/cli/src/shisa-link/credentials.ts; import-consumers.catalog.mutations",
    "Remove/toggle host exception presentation and every other CatalogSourceStore importer are not closed. Credential-read evidence is separate from store writes.",
    "catalog-sources.ts:365-381; catalog-sources.ts:410-455; catalog-sources.ts:500-540; catalog-sources.ts:577-637; catalog-sources.ts:675-734; catalog-sources.ts:829-855; catalog-settings.ts:435-450; catalog-settings.ts:804-872; catalog-settings.ts:1842-1846; catalog-settings.ts:1926-1930; catalog-settings.ts:2754-2804; main-cli.ts:849-858")

add("context-clamp", [[1, 169]], "forwarded-to-visible-wrapper",
    "writeContextPolicy forwards writeFilePrivateAtomic failures unchanged; removing an off policy is a separate rmSync route. loadContextPolicy catches parsing/I/O into error but does not call the imported write helper. activeContextClamp selects only maxContextTokens.",
    "Settings stepContextLimit catches the write error and inserts sanitized message into settingsContextLimitNotSaved. reloadContextPolicy calls the read helper without catalog and wraps policy.error in settingsContextLimitNotApplied; that separate read route defaults English despite catalog-capable validators.",
    "Owned directory safety text remains English inside a catalog wrapper; OS detail/path are source data. Token limits are numeric identities, not translated prose. Read-default behavior substantively refines settings.context-policy.",
    "terminal-owned:settings.context-policy; import-consumers.settings.policy-errors",
    "Host callback after a successful write is outside the imported-helper failure trace; no renderer/native file conflict was exercised.",
    "context-clamp.ts:75-135; catalog-settings.ts:915-949; catalog-settings.ts:2754-2804")

add("dashboard-policy", [[1, 59]], "forwarded-to-visible-wrapper",
    "writeDashboardPolicy rejects a loaded error with owned Cannot save dashboard policy framing, then forwards atomic-write failures. Load errors become compact plus error, except missing file which is compact without a diagnostic.",
    "Settings catches save failures into settingsDashboardNotSaved; main dashboard refresh separately notifies dashboardUnreadable with policy.error when resetVisibility is true. Initial mode-only reads drop error detail.",
    "Owned schema/recovery sentences and PrivatePathError differ from OS diagnostics. compact/expanded/hidden are policy enums inserted unchanged, not model content.",
    "terminal-owned:settings.dashboard-policy; import-consumers.settings.policy-errors",
    "Notification placement and all dashboard refresh timing/conditions are not executed or exhaustively traced.",
    "dashboard-policy.ts:14-43; catalog-settings.ts:1783-1802; main-cli.ts:552-568; main-cli.ts:663-671; catalog-settings.ts:2754-2804")

add("flow-control/local-storage", [[1, 108]], "existing-flow-boundary",
    "ensurePrivateDirectory at root/folder is outside metadata replacement catch and propagates PrivatePathError or OS failure. Only the later header preflight replaces non-ENOENT errors with Flow session metadata is missing or inconsistent. Journal-open failures remain forwarded.",
    "PiFlowAttachment.open and PiFlowSessionRegistry.open await the opener, close ownership on failure, then rethrow or aggregate cleanup errors. Existing semantic-flow storage/runtime sink findings own the subsequent route; this pass does not claim all host attachment failures reach onError.",
    "Directory/root safety text and Flow preflight/aggregate framing are owned prose; journal payload and paths are preserved data.",
    "semantic-flow:semantic-flow.storage-diagnostics; semantic-flow:semantic-flow.runtime-error-sinks",
    "Final host attachment rejection display versus console callback is not uniformly established; no recursive service/host closure.",
    "flow-control/local-storage.ts:50-108; flow-control/pi-attachment.ts:29-82; flow-control/pi-session-registry.ts:76-101; main-cli.ts:720-734")

add("flow-control/subagent-observation-extension", [[1, 132]], "identity-only",
    "notificationHash hashes tool content/markers for comparisons and stored receipt identity. It does not call inbox delivery/reportError or return the inbox's English diagnostics. No local hash-error replacement is installed; JSON serialization errors on abnormal values could reject the projection/request.",
    "observationProjections returns indices; event accept receives a promise of toolCallId/contentHash/markerHash records. These are machine observation evidence, not a visible message. The Flow runtime registers this extension.",
    "Hashes, indices and receipt keys are protocol data. No imported inbox human sentence is forwarded by these uses.",
    "semantic-owned:semantic-owned.notifications.delivery-errors",
    "Malformed nonserializable injected values and host event callback rejection handling remain outside the bounded normal-data trace.",
    "notifications/inbox.ts:11-12; flow-control/subagent-observation-extension.ts:23-80; flow-control/subagent-observation-extension.ts:82-121; flow-control/flow-runtime.ts:137-150")

add("flow-control/subagent-waits", [[1, 174]], "predicate-only-with-existing-flow-framing",
    "isActiveRun is a Set membership predicate used for wait state and retirement; it does not forward manager.result or its English lifecycle text. Registration failure appends the owned English retain-run-ID warning and forwards cause to onError; subscribed evidence failures also call onError.",
    "Successful results append JSON waitDependency to original content. Existing semantic-flow.subagent-receipt covers the local warning; flow-runtime forwards onError to main-cli's catalog-backed console error sink, not an assumed notification.",
    "Predicate states/revisions/dependencies are machine data. Existing original result content may be model/source payload; the appended failure guidance is separately owned prose.",
    "semantic-flow:semantic-flow.subagent-receipt; semantic-flow:semantic-flow.runtime-error-sinks",
    "Tool-result host fallback visibility/persistence remains unresolved; receipt error does not imply launch failure or justify repeating launch.",
    "subagents/manager.ts:86-89; flow-control/subagent-waits.ts:15-38; flow-control/subagent-waits.ts:76-117; flow-control/subagent-waits.ts:136-164; flow-control/flow-runtime.ts:109-110; main-cli.ts:728-734")

add("flow-control/user-input-grants", [[1, 89], [185, 283]], "replaced-before-api-boundary",
    "readGrantsFile replaces PrivatePathError with a catalog directory-not-directory reason; other directory inspection failures become a different catalog reason. checkUserInputAdapterGrant returns invalid-config plus that reason, not the original path error.",
    "user-input-adapters.authorize supplies its session catalog but discards decision.reason and throws External input adapter is not authorized with the stable decision.code. The detailed private-fs sentence is not exposed on that exact route.",
    "Catalog denial prose, raw parser/race diagnostics and stable authorization codes are distinct. Paths/token/user submissions are not interpolated by this replacement.",
    "semantic-flow:semantic-flow.grant-denial-discard",
    "Ultimate external-client/API error presentation is not traced; no claim that every caller of checkUserInputAdapterGrant discards reasons.",
    "flow-control/user-input-grants.ts:209-227; flow-control/user-input-grants.ts:261-283; flow-control/user-input-adapters.ts:163-175")

add("keybindings", [[355, 791]], "mixed-visible-and-bootstrap-wrapper",
    "planKeybindings wraps directory errors in KeybindingConfigError without translating detail. withLock uses a catalog busy error except invalid lock is literal English. Copy/write failures propagate; compensation writes in apply/reset/upgrade can themselves replace an earlier exception if restoration throws. State-lock release swallows errors.",
    "main-cli operator plans/applies use the active catalog and handleMainCliError displays domain or generic preserved detail. ensureDefaultKeybindings catches failures as a CatalogMessageRef with protectedSourceError; startup omits its catalog argument, so underlying catalog diagnostics may already be English when the outer reference resolves in Japanese.",
    "PrivatePathError/invalid-lock/recovery framing is owned prose, not all OS text. Binding/action/reason keys and stale threshold are machine identities; human plan formatter prints action reason keys unchanged.",
    "operator-cli:cli-runtime-errors; import-consumers.keybindings.storage",
    "Compensation precedence is source-established, not fault-injected. No broad keybinding parser/body audit or terminal input acceptance.",
    "keybindings.ts:375-385; keybindings.ts:431-458; keybindings.ts:487-524; keybindings.ts:576-593; keybindings.ts:606-610; keybindings.ts:662-680; keybindings.ts:693-718; main-cli.ts:216-239; main-cli.ts:351-354; main-cli.ts:815-829")

add("label-policy", [[1, 56]], "forwarded-to-visible-wrapper",
    "write refuses existing load errors with owned Cannot save label settings framing; imported atomic-write errors are not caught. A successful write emits change callbacks, whose exceptions are a separate route from helper failure.",
    "Settings wraps sanitized write detail in settingsAutoLabelsNotSaved. /labels global on/off instead notifies sanitized Error.message directly. This differs from the count/state-only Settings row that shows error/on/off, not load.error detail.",
    "Owned validation/path/refusal prose and OS detail are mixed; boolean/state values remain data. Generated session labels are unrelated user/model content and must not be translated as errors.",
    "terminal-owned:labels.persistence-error; terminal-owned:settings.auto-label-policy; import-consumers.settings.policy-errors",
    "Listener failures after persistence and native label generation/tmux behavior are outside this imported-write failure trace.",
    "label-policy.ts:19-48; catalog-settings.ts:1756-1775; catalog-settings.ts:2496-2518; session-labels.ts:521-533; main-cli.ts:753-753")

add("language-choice", [[1, 246]], "constant-only",
    "The only value import from a semantic-owned primary module is RESPONSE_LANGUAGES; map builds candidate tags/shipped flags. It imports no response resolver that could throw ResponseLanguageUsageError or produce fallback diagnostics. Type names carry no runtime behavior.",
    "promptForLanguageChoice maps tags through languageSelfName with the supplied bundle and writes self-names/catalog markers. saveLanguageChoice uses a different (ui-locale) module; its failure reaches the first-run save catch, independently dispositioned under ui-locale.",
    "Language tags/self-names are intentional identity, not English error propagation. UI/response selections are separate data fields; prompt text is catalog prose.",
    "semantic-owned:semantic-owned.language.resolver-boundaries; import-consumers.locale.save-errors",
    "Closed for the imported constant; no actual first-run interaction, language quality or persistence executed.",
    "language-settings.ts:31-35; language-choice.ts:39-66; language-choice.ts:145-166; language-choice.ts:232-246; main-cli.ts:271-301")

add("model-catalog-sync", [[120, 209], [235, 289], [330, 399], [540, 794], [910, 1000]], "mixed-normalized-and-forwarded",
    "refreshCatalogSource catches lock/private-write failures. CatalogSyncError busy text uses the supplied catalog; untyped PrivatePathError/OS failures go through describeCatalogFailure(error, phase) without its catalog, replacing raw detail with English cache/filesystem explanations. recordError failures are swallowed. activateDiscoveredCatalog and acceptQuarantinedCatalog instead propagate acquisition/private-write errors through finally release.",
    "Settings refresh prints result.message directly; activation/save catches also print Error.message. Operator refresh prints catalogStatus, not top-level result.message in human mode, so lastError appears only if recording succeeded; JSON preserves returned machine structure. Acceptance errors reach the generic main error wrapper. catalog-command displays stored lastError.code and message unchanged.",
    "Locally generated fallback English is not an OS/provider quote. Busy statuses/error codes/digests/revisions remain protocol data; persisted display messages are not retranslated by a later localized report.",
    "operator-cli:cli-catalog-network-errors; terminal-owned:settings.refresh; import-consumers.catalog.failure-normalization",
    "Error reclassification and failed persistence are source-only; no universal claim that every returned refresh message reaches human output, or that JSON schema/persisted text can be freely rewritten.",
    "model-catalog-sync.ts:355-357; model-catalog-sync.ts:555-678; model-catalog-sync.ts:686-777; model-catalog-sync.ts:930-1000; catalog-failure.ts:116-151; catalog-settings.ts:804-872; catalog-settings.ts:889-908; catalog-command.ts:157-161; catalog-command.ts:204-208; command-report.ts:403-405; command-report.ts:478-486; command-report.ts:504-598; main-cli.ts:161-199")

add("pi-import", [[100, 209], [230, 340]], "mixed-wrapped-and-forwarded",
    "Receipt directory failure becomes PiImportError with unchanged detail; destination exclusive-write EEXIST becomes a catalog skipped message, other failures become PiImportError with a catalog importFailed frame and preserved detail. Receipt atomic write and lock acquisition can escape as ordinary errors; busy is a catalog PiImportError. Release is silent.",
    "Interactive startup awaits offerPiConfigurationImport with active catalog. handleMainCliError uses a piImport catalog wrapper for PiImportError, otherwise generic; both preserve detail. Copied models/auth bytes and receipt statuses are not translated.",
    "PrivatePathError is owned English with path, distinct from copied configuration and OS error diagnostics. imported/declined/destination-exists remain stable receipt data.",
    "operator-cli:cli-runtime-errors; import-consumers.import.storage",
    "No import/prompt or rollback executed; exact host stream behavior and partial receipt/write state remain unobserved.",
    "pi-import.ts:119-151; pi-import.ts:235-245; pi-import.ts:285-318; pi-import.ts:322-340; main-cli.ts:346-354; main-cli.ts:808-814; main-cli.ts:849-858")

add("profile-choice", [[1, 103]], "mixed-propagation-and-migration-suppression",
    "readProfileChoice catches directory validation and wraps unchanged message in ProfileChoiceError; writeProfileChoice forwards atomic-write failures. Catalog-backed file/schema validators do not translate PrivatePathError. Neither class conversion nor active catalog changes inherited detail.",
    "resolveProfileSelection forwards reads to main-cli and the generic error wrapper; operator/startup writeProfileChoice calls also have no replacing catch. Migration safeReadProfileChoice suppresses the error in favor of profile-choice-unreadable conflict code, later shown in human plan or JSON.",
    "Owned path safety prose and OS/parser detail differ; profile ID/chosenAt/file bytes remain data. promptForJapaneseSupport is not the first-run consumer used by current main-cli.",
    "terminal-owned:startup.profile.legacy-question; import-consumers.profile.storage; import-consumers.migration.conflicts-and-receipt",
    "No persistence, malformed choice or interactive prompt exercised; other profile-choice consumers are not recursively enumerated.",
    "profile-choice.ts:36-79; runtime.ts:30-78; main-cli.ts:261-267; main-cli.ts:334-336; main-cli.ts:474-477; main-cli.ts:849-858; profile-migration.ts:231-242")

add("profile-manager", [[120, 199], [255, 319], [385, 455]], "mixed-visible-and-migration-suppression",
    "Read/plan directory failures become ProfileStateError retaining message. applyProfile ensures state root, uses catalog busy except literal invalid-lock English, then copies/writes with no replacement; finally releases silently. Private helpers need not produce ProfileStateError, so raw write/lock-preflight errors can take the generic handler.",
    "main-cli operator and startup applyProfile pass active catalog; handleMainCliError shows domain recovery or generic framing with unchanged detail. runtime profile selection forwards read errors. Migration safeReadProfileState instead replaces them with profile-state-unreadable conflict code.",
    "Owned safety/invalid-lock/recovery sentences differ from OS details. Asset bytes/hash/transaction IDs and plan action reasons are protected configuration data; catalog outer framing is not translation of prebuilt error text.",
    "operator-cli:cli-profile-apply; import-consumers.profile.storage; import-consumers.migration.conflicts-and-receipt",
    "No backup/write/install or source-body completeness claim; every plan action/parser path is outside this helper-focused read.",
    "profile-manager.ts:141-162; profile-manager.ts:269-282; profile-manager.ts:398-455; main-cli.ts:326-343; main-cli.ts:474-477; main-cli.ts:825-837; profile-migration.ts:245-257")

add("profile-migration-command", [[100, 350]], "receipt-read-replacement-write-forwarding",
    "readStoredProfileMigrationReceipt catches directory validation as invalid, without exposing raw text. writeStoredProfileMigrationReceipt forwards private atomic-write errors. runApply catches only ProfileMigrationConflictError before receipt save, so a failed receipt write is not a success message; runRollback similarly forwards restore/remove failures.",
    "runRollback maps invalid receipt to catalog receiptUnreadable and return 1. Command dispatch receives active catalog and prints human notices; plan --json serializes stable structure. Receipt write failure escapes to main-cli's generic wrapper, possibly after migration effects completed.",
    "Receipt status/code/targets/transaction are machine evidence, not display sentences; invalid receipt details are intentionally suppressed. Owned path safety text can survive the write route, unlike the read route.",
    "operator-cli:cli-migration-rollback; import-consumers.migration.conflicts-and-receipt",
    "No apply/rollback or persistence failure induced; recovery after an applied migration with no saved receipt is not runtime-certified.",
    "profile-migration-command.ts:137-161; profile-migration-command.ts:176-194; profile-migration-command.ts:222-241; profile-migration-command.ts:279-350; main-cli.ts:242-257; main-cli.ts:849-858")

add("profile-migration", [[230, 324], [425, 589]], "plan-suppression-apply-forwarding",
    "planAssets replaces directory validation with agent-directory-unsafe. safe profile readers replace helper errors with profile-choice/state-unreadable. apply/rollback backup directory, copy, replacement and restoration writes do not catch private helper failures. saveLocalizationConfig is a separate catalog-aware shared writer, not a direct semantic-owned import.",
    "formatProfileMigrationPlan prints plan.conflicts as report entry keys; --json preserves the codes. runApply replaces only conflict exception with catalog conflict; other copy/write failures reach generic main error display. Receipt validation is separately dispositioned in profile-migration-command.",
    "Plan codes are machine state also rendered as technical keys. Actual private-fs path safety text is owned English; backing APPEND_SYSTEM.md/user edits, backup bytes and selected response language remain preserved model/configuration data.",
    "operator-cli:cli-migration-plan; import-consumers.migration.conflicts-and-receipt",
    "No full migration-body reread or transaction atomicity claim; source effects/rollback, especially missing backups, were not exercised.",
    "profile-migration.ts:231-257; profile-migration.ts:300-324; profile-migration.ts:444-453; profile-migration.ts:476-535; profile-migration.ts:563-585; profile-migration-command.ts:279-350; command-report.ts:403-405; command-report.ts:478-486; command-report.ts:541-598; main-cli.ts:849-858")

add("runtime-diagnostics", [[1, 132]], "metadata-diagnostic-replaced",
    "installed() catches loadMetadata failure and returns undefined. report/about substitute the catalog versionUnavailable label; summary/warnings omit changed-build comparisons when installed metadata is unavailable. Original metadata validation/OS message is not printed by these rereads.",
    "main-cli constructs diagnostics without fourth catalog argument, so text defaults English. report reaches /flow runtime notify, about reaches /about notify outside TUI, summary is supplied as host footer, and warnings are forwarded by release diagnostics. This narrows existing default-locale finding rather than duplicating it.",
    "Version/path/hash/package/timestamp are identities; metadata diagnostic details are suppressed. Local unreadable hash sentinel and catalog unavailability text are owned diagnostic display, not provider prose.",
    "terminal-owned:startup.runtime.identity; terminal-owned:startup.runtime.warnings; semantic-owned:semantic-owned.metadata.failure",
    "Initial loadMetadata has a separate visible failure route; host footer placement/About rendering/native layout and all package-read failures were not executed.",
    "runtime-diagnostics.ts:54-90; runtime-diagnostics.ts:91-132; main-cli.ts:546-550; main-cli.ts:726-739; flow-control/flow-status-extension.ts:144-155; model-picker.ts:1389-1404; release-extensions.ts:441-456")

add("shisa-link/extension", [[1, 121]], "identity-and-auth-state-only",
    "readShisaLinkState catches bad link files as undefined; providerConfig uses endpoint or gateway fallback without displaying parse/file errors. isShisaSignedOut returns process-local membership; getApiKey converts true to catalog signedOutReconnect. setShisaSignedOut catches listener failures; onShisaAuthChange registers/removes a listener and does not forward stored credential text.",
    "Provider API sees endpoint/credential or a catalog refusal; explicit /logout shisa catches signOut rejection as catalog shisaSignOutFailed. Main-cli passes the active bundle to this extension. There is no direct credentials read/write helper import on this path.",
    "Endpoint/access token are provider configuration/secret payload, never translation targets here. Local sign-out notice is catalog prose. Listener failures do not automatically become a toast.",
    "semantic-owned/files.csv:packages/cli/src/shisa-link/credentials.ts; semantic-owned/files.csv:packages/cli/src/shisa-link/state.ts",
    "Provider getApiKey refusal's final host presentation remains unresolved; no login/account/provider execution.",
    "shisa-link/credentials.ts:79-97; shisa-link/state.ts:125-138; shisa-link/extension.ts:43-63; shisa-link/extension.ts:87-119; main-cli.ts:763-769")

add("shisa-link/onboarding", [[1, 143]], "replaced-before-visible-output",
    "writeFilePrivateExclusive EEXIST returns silently; other marker-write failures print catalog setupChoiceFailed plus later, discarding raw detail. Outer catch prints cancellation, exact catalog storageError, or generic couldNotComplete. setShisaSignedOut cannot propagate its listener failures, which credentials suppresses.",
    "write/writePoint sanitize and write catalog prompts/recovery to output; main-cli supplies selected catalog and interactive gate. Imported private-fs diagnostic is not the visible recovery sentence on this path.",
    "Choice/decidedAt JSON is machine state; verification URI/code are remote identity; login progress is outside the specific imported helper. No raw marker path or auth-file content is added to display.",
    "semantic-owned/files.csv:packages/cli/src/private-fs.ts; semantic-owned/files.csv:packages/cli/src/shisa-link/credentials.ts",
    "Closed for named helper errors; login protocol, browser and account operations were not exercised.",
    "shisa-link/onboarding.ts:57-73; shisa-link/onboarding.ts:90-104; shisa-link/onboarding.ts:124-143; shisa-link/credentials.ts:79-97; main-cli.ts:496-501")

add("startup-settings", [[1, 77]], "uncaught-helper-forwarding",
    "Missing settings uses exclusive write; existing usable settings uses atomic replacement. JSON parse/unusable shape returns false, but the private helper calls and I/O preflight have no local failure catch. No English success/notification sentence is created by the boolean return.",
    "main-cli interactive startup invokes both functions without using their boolean result or a local catch. Failure reaches bootstrap -> handleMainCliError generic catalog frame with preserved message, unlike quiet rejection of malformed settings JSON.",
    "quietStartup/version marker and settings bytes are machine configuration. Directory/root safety is owned English; OS failures/path/version are source data. A product-owned English sentence does not become external prose merely by entering protectedSourceError.",
    "operator-cli:cli-runtime-errors; import-consumers.startup.settings-write",
    "No startup settings or changelog state changed; exact startup stream/native exception timing remains unobserved.",
    "startup-settings.ts:8-32; startup-settings.ts:42-77; main-cli.ts:351-354; main-cli.ts:849-858; cli.ts:151-178; cli.ts:189-190")

add("subagents/dashboard", [[1, 99]], "predicate-only-conditional-view",
    "isActiveRun only filters/selects styles/counts; it cannot forward the manager's stored result or errors. Renderer owns English Subagents/active/queued/finished and Details/Hide; raw status/role/model/cwd/tool are data. Existing native-widget finding already records these literals.",
    "SubagentDashboard.refresh installs setWidget only with TUI context, visibility and nonempty runs. Integration attaches it only without dashboardVisibility. Main-cli supplies dashboardVisibility via model-picker, so this standalone widget is not selected by that normal assembly; do not infer current display from the renderer export.",
    "Owned labels differ from run identity/status. Predicate import is not an error surface. No model answer/body is read by this widget.",
    "terminal-owned:subagents.native-widget",
    "Other callers can omit dashboardVisibility; host/native widget selection and the alternate Work dashboard text are not audited recursively.",
    "subagents/manager.ts:86-89; subagents/dashboard.ts:10-41; subagents/dashboard.ts:66-89; subagents/integration.ts:479-480; model-picker.ts:1141-1148; main-cli.ts:569-573")

add("subagents/roles", [[315, 386]], "existing-role-consumer-closure",
    "preferCatalogModels and catalogRuntimeIdentity only deduplicate/decode model identities; malformed identity decoding returns undefined, not a helper diagnostic. AgentRoleStore.save forwards atomic-write/preflight errors and uses its own English onBusy error; release is silent. resolveAgentModel composes catalog ambiguity/unavailable messages using protected selectors.",
    "semantic-roles already fully read the producer. This bounded pass rereads only helper sites: integration service.save forwards save; Workflow errorText/handleInput/render preserve ordinary Error.message. Startup instead catches role-load failure as catalog unreadable notice. No duplicate full-body credit.",
    "Owned Storage/Validation prose differs from filesystem errors, model identities and user role instructions. Imported projection helpers do not produce a model/provider diagnostic on these sites.",
    "semantic-roles:semantic-roles.storage; semantic-roles:semantic-roles.model-errors; semantic-roles:semantic-roles.defaults-and-contracts",
    "Every model resolution caller and native Workflow interaction remains outside this bounded trace; prior complete producer read is not a whole import graph sign-off.",
    "model-catalog-projection.ts:342-366; subagents/roles.ts:333-386; subagents/integration.ts:251-256; subagents/integration.ts:501-507; workflow.ts:215-218; workflow.ts:402-413; workflow.ts:1025-1029; workflow.ts:1288-1301")

add("ui-locale", [[395, 504], [550, 704]], "mixed-validation-data-and-forwarded-storage",
    "isResponseLanguagePreference/parseArtifactPolicy return boolean/data/undefined; describeInvalidArtifactField supplies field/value data to a catalog validation sentence. No ResponseLanguageUsageError is imported. save/restore acquireStateLock maps busy/invalid to catalog errors; preflight/private writes propagate. Restore is used by localization-ops compensation, whose own recovery replacement is already audited.",
    "First-run save catches and prints languageChoiceSaveFailed with source detail. Settings apply/reset goes through localization-ops and existing recovery/store-failure findings. Parser failures become invalid state/reason; main-cli startup displays localizationInvalid, separate from stable configuration data.",
    "Field names/values are diagnostic data inside catalog framing, not model instructions. PrivatePathError owns English; save's own unsupported/refusal/size sentences also remain local English. OS/path detail is source payload, not all owned copy.",
    "semantic-owned:semantic-owned.language.recovery; semantic-owned:semantic-owned.language.store-failures; import-consumers.locale.save-errors",
    "Settings planLanguageChange pre-apply host catch remains unresolved in the prior ledger; no every-reader/UI-locale API closure or settings writes.",
    "language-settings.ts:114-153; language-settings.ts:430-440; ui-locale.ts:417-440; ui-locale.ts:565-608; ui-locale.ts:640-692; language-choice.ts:232-246; main-cli.ts:288-301; main-cli.ts:146-150")

add("updater", [[250, 349], [450, 509], [570, 958]], "phase-dependent-replacement",
    "readUpdateState wraps directory validation as UpdateError invalid-state retaining detail; writeUpdateState forwards. setPolicy/status have no replacing catch. check normalizes non-UpdateError write failure to catalog checkFailed; recordFailure suppresses further failures. apply lock acquisition is before its try (raw preflight can escape); download-directory/private failures inside try become generic updateFailed. Successful install status-write failure emits catalog statusUnrecorded; startup read failure preserves detail in skipped, later check/apply failure notices usually expose code only.",
    "cli bootstrap supplies active catalog; UpdateError uses update wrapper with preserved message, raw pre-lock/path errors fall through generic main handling. Startup resolves its CatalogMessageRef to stderr. Human formatUpdateStatus includes lastResult/lastErrorCode; --json preserves stable state/result keys. No private helper body text is uniformly displayed across these phases.",
    "Owned invalid-lock/path safety and catalog recovery prose differ from OS/registry detail; machine error codes/state/version/hash remain exact. recordFailure writes only code, not a translated error body.",
    "operator-cli:cli-update-apply; operator-cli:cli-startup-update; import-consumers.update.phase-errors",
    "No updater, npm/process, registry/network, restart or install action executed; normalization/rollback/native behavior and concurrent file conflicts are static evidence only.",
    "updater.ts:265-323; updater.ts:468-483; updater.ts:572-586; updater.ts:621-680; updater.ts:729-745; updater.ts:794-902; updater.ts:928-958; cli.ts:84-154; cli.ts:157-178")


# Only substantively new or clarified propagation families; prior body reviews stay referenced.
SURFACES = []


def surface(identifier, source, symbol, entry, state, locale, finding, refs, limit):
    SURFACES.append(dict(surface_id="import-consumers." + identifier, owner="Jouzu CLI",
                         source_file=CLI + source + ".ts", source_symbol=symbol,
                         entry_point=entry, state=state, locale_path=locale,
                         source_finding=finding + " Existing findings: " + refs + ".",
                         evidence_level="source-only-boundary" if "Host" in limit else "source-only-semantic",
                         existing_test="", coverage_limit=limit))


surface("browser.install-errors", "camoufox-adapter", "installCamoufoxRuntime; lazyTool", "lazy browser tool delegate resolution",
        "private directory failure; invalid/busy install lock; timeout", "mixed: suppressed inspection versus forwarded tool rejection",
        "packages/cli/src/camoufox-adapter.ts:228-282 suppresses inspection failures into state, but :346-420 forwards installation path/OS failures and invalid busy status. :908-934 rethrows runtime loading and :719-737 only finalizes tool hooks. Imported omitDeclinedArguments changes input only, not diagnostics or schema prose.",
        "terminal-owned:browser.tool-labels; terminal-owned:browser.screenshot-lines",
        "Host conversion/rendering of the exact rejection remains unresolved; no optional runtime installation/import or tool invocation.")
surface("catalog.mutations", "catalog-sources", "CatalogSourceStore; setCatalogSourceToken", "Settings source save and stored-token update",
        "private directory/registry/token write failure", "mixed: active store catalog does not translate PrivatePathError",
        "packages/cli/src/catalog-sources.ts:365-381,410-455,577-637,681-734 forward private path/write errors. packages/cli/src/catalog-settings.ts:804-872 displays sanitized save errors; :1842-1846 and :1926-1930 remove/toggle do not have that local catch. Credential presence instead suppresses stored read failure at catalog-sources.ts:510-530, and imported auth reader suppresses its own file errors.",
        "terminal-owned:settings.form.save",
        "Host remove/toggle rejection display is unresolved; this is not every CatalogSourceStore caller or any credential access.")
surface("settings.policy-errors", "context-clamp", "writeContextPolicy; sibling dashboard/label stores", "Settings context/labels/dashboard and /labels global",
        "private write failure versus rejected read policy", "mixed: catalog wrapper plus owned English detail; some read calls default English",
        "packages/cli/src/context-clamp.ts:118-126, packages/cli/src/dashboard-policy.ts:34-43 and packages/cli/src/label-policy.ts:43-47 forward private-write errors. packages/cli/src/catalog-settings.ts:930-946,1756-1775,1783-1802 retains detail inside catalog errors, rendered at :2754-2804. session-labels.ts:521-533 instead notifies raw sanitized message. Context read at catalog-settings.ts:915-924 omits the helper catalog; dashboard main-cli.ts:663-671 conditionally notifies a load error.",
        "terminal-owned:settings.context-policy; terminal-owned:settings.auto-label-policy; terminal-owned:settings.dashboard-policy; terminal-owned:labels.persistence-error",
        "No render/file mutation or native conflict; successful-write callback/listener exceptions are separate from helper failures.")
surface("keybindings.storage", "keybindings", "withLock; ensureDefaultKeybindings", "operator keybindings and interactive startup bootstrap",
        "invalid lock; write/backup failure; compensation failure", "mixed: localized reference wraps potentially English backing detail",
        "packages/cli/src/keybindings.ts:436-458 supplies literal invalid-lock versus catalog busy text; :513-524,576-593,662-680 compensation writes can replace an earlier failure. :693-718 returns a CatalogMessageRef with protected error detail. packages/cli/src/main-cli.ts:351-354 omits bootstrap catalog before resolving the outer reference with active locale; :815-829 preserves domain detail.",
        "operator-cli:cli-runtime-errors",
        "Static normalization/exception precedence only; no keybindings parser full-read, compensation injection or terminal gesture test.")
surface("profile.storage", "profile-manager", "applyProfile; readProfileState; read/writeProfileChoice", "profile selection/apply and startup",
        "directory safety; invalid/busy lock; backup/write failure", "mixed: active catalog domain/generic wrappers retain owned English",
        "packages/cli/src/profile-manager.ts:141-162,269-282 wraps validation detail; :398-455 forwards other helper failures and owns literal invalid-lock text. profile-choice.ts:36-79 similarly preserves directory/write failures. runtime.ts:30-78 and main-cli.ts:261-267,326-343,474-477 forward to main-cli.ts:825-837 or :849-858. Not every helper failure has a domain Error class.",
        "operator-cli:cli-profile-apply; terminal-owned:startup.profile.legacy-question",
        "No profile asset/state operations or full planner/body claim; model prompt/configuration bytes and hash identity stay unchanged.")
surface("migration.conflicts-and-receipt", "profile-migration-command", "readStoredProfileMigrationReceipt; runApply; planAssets", "migration plan/apply/rollback reports",
        "read failure replaced; apply/receipt/rollback write failure forwarded", "mixed: stable conflict keys plus catalog notices and preserved write error",
        "packages/cli/src/profile-migration.ts:231-257,300-324 discards private/profile read messages into profile-choice-unreadable/profile-state-unreadable/agent-directory-unsafe; :444-453 renders conflict keys directly. profile-migration-command.ts:137-161 replaces receipt inspection detail with invalid; :222-241 maps it to catalog notice. Receipt atomic write :176-194 occurs after apply :279-312 and can escape without printing applied; copy/restore errors at profile-migration.ts:510-535,563-585 also propagate to generic main display.",
        "operator-cli:cli-migration-plan; operator-cli:cli-migration-apply; operator-cli:cli-migration-rollback",
        "No mutation/rollback run; --json codes remain machine payload, and an absent saved receipt after effects is not a runtime-tested recovery state.")
surface("catalog.failure-normalization", "model-catalog-sync", "refreshCatalogSource; activateDiscoveredCatalog; acceptQuarantinedCatalog", "catalog refresh/activation/accept and status report",
        "private helper failure by phase; error recording also fails", "english-default-replacement versus preserved activation detail",
        "packages/cli/src/model-catalog-sync.ts:635-654 omits catalog in describeCatalogFailure, so untyped PrivatePathError/OS errors become English fallback explanations rather than raw detail even when refresh received Japanese. catalog-failure.ts:116-151 defines that replacement. Activation :655-678 and acceptance :930-1000 have no such catch. catalog-settings.ts:889-908 prints refresh result.message, but main-cli.ts:161-199 human output prints catalogStatus; catalog-command.ts:157-161,204-208 shows lastError only when retained. Refresh recording failure is swallowed, not an assurance of displayed message.",
        "operator-cli:cli-catalog-network-errors; terminal-owned:settings.refresh; terminal-owned:settings.form.save",
        "No fetch/storage/lock operations. Persisted reasons/JSON compatibility and every status consumer remain separate boundaries.")
surface("import.storage", "pi-import", "offerPiConfigurationImportLocked; offerPiConfigurationImport", "first-run Pi configuration import",
        "exclusive destination failure versus receipt/lock preflight failure", "mixed: localized PiImportError versus generic retained diagnostic",
        "packages/cli/src/pi-import.ts:285-307 replaces EEXIST with skipped and wraps other destination errors with catalog detail. Receipt atomic write :318 and acquireStateLock :329-334 can fail as ordinary errors. main-cli.ts:346-354 passes catalog; :808-814 uses PiImportError frame and :849-858 handles ordinary failures without translating PrivatePathError. Imported file bytes/receipt statuses remain data.",
        "operator-cli:cli-runtime-errors",
        "No import/prompt/file operations; source-only propagation does not certify partial-write state or terminal output.")
surface("startup.settings-write", "startup-settings", "ensureQuietStartupDefault; suppressPiReleaseNotes", "interactive startup settings defaults",
        "exclusive/atomic write failure versus malformed existing JSON", "generic catalog frame retains imported helper error",
        "packages/cli/src/startup-settings.ts:8-32,42-77 suppresses malformed JSON into false but does not catch private writes. main-cli.ts:351-354 has no local catch and handleMainCliError at :849-858 preserves messages; cli.ts:151-178 forwards that rejection. Boolean results/settings bytes are configuration, not human notices.",
        "operator-cli:cli-runtime-errors",
        "No startup/settings changes or runtime/native sign-off; filesystem source detail is distinct from helper-owned English path safety prose.")
surface("locale.save-errors", "ui-locale", "acquireLocalizationConfigLock; saveLocalizationConfig; restoreLocalizationConfig", "first-run language save and Settings transaction",
        "private path/write failure; catalog busy; rejected policy data", "mixed: data-only language helpers; localized lock errors; forwarded storage detail",
        "packages/cli/src/ui-locale.ts:417-440 uses boolean/policy/field-value helpers, not response-language exception text. :565-608 and :640-692 use catalog busy/invalid lock mapping but forward private writes. First-run main-cli.ts:288-301 wraps preserved detail in languageChoiceSaveFailed. Existing semantic-owned recovery/store findings own the distinct localization-ops compensation and Settings consumers; this adds no new whole-body credit.",
        "semantic-owned:semantic-owned.language.recovery; semantic-owned:semantic-owned.language.store-failures",
        "Host planning-exception display remains unresolved as in prior ledger; no preference writes or malformed settings/runtime fixtures.")
surface("update.phase-errors", "updater", "check; apply; startup; setPolicy", "self-update commands and startup",
        "private read/write/pre-lock/download/status recording failure", "phase-dependent catalog replacement versus preserved diagnostic",
        "packages/cli/src/updater.ts:265-323 retains directory failure in UpdateError invalid-state. :621-680 normalizes ordinary check/write errors; :729-745 acquires apply lock before try, so preflight can bypass updateFailed replacement. :794-824 suppresses post-install status-write detail and normalizes in-try failures; :841-902 startup read uses full detail while later failures normally expose code. cli.ts:157-178 separates UpdateError frame from generic fallback. recordFailure :572-586 suppresses write failures and stores only code.",
        "operator-cli:cli-update-apply; operator-cli:cli-startup-update",
        "No update/npm/install/restart/network execution; static exception order is not native/rollback acceptance.")


def primary_imports(source_file):
    """Finite named-import scan, not a TypeScript parser or recursive import closure."""
    with (AUDIT / "semantic-owned/files.csv").open(encoding="utf-8-sig", newline="") as handle:
        primary = {row["source_file"] for row in csv.DictReader(handle)
                   if row["disposition"].startswith("full-read-")}
    path = ROOT / source_file
    text = path.read_text(encoding="utf-8")
    imports = []
    for match in re.finditer(r'^import\s+(?!type\b)([\s\S]*?)\s+from\s+["\']([^"\']+)["\'];', text, re.MULTILINE):
        fields, spec = match.groups()
        if not spec.startswith("."):
            continue
        target = (path.parent / spec).with_suffix(".ts").resolve().relative_to(ROOT).as_posix()
        if target not in primary:
            continue
        names = [part.strip().split(" as ")[-1] for part in fields.strip("{}\n\t ").split(",")
                 if part.strip() and not part.strip().startswith("type ")]
        if not names:
            continue
        last_import_line = text[:match.end()].count("\n") + 1
        uses = {name: [index for index, line in enumerate(text.splitlines(), 1)
                       if index > last_import_line and re.search(r"\b" + re.escape(name) + r"\b", line)] for name in names}
        imports.append(dict(target=target, symbols=uses))
    return imports


def write_csv(name, header, rows):
    with (HERE / name).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=header, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


# These helper implementations were actually read; hashes alone do not grant read credit.
HELPER_READS = {
    "private-fs.ts": ("complete-helper-read", [[1, 155]]),
    "state-lock.ts": ("complete-helper-read", [[1, 176]]),
    "shisa-link/credentials.ts": ("complete-helper-read", [[1, 109]]),
    "shisa-link/state.ts": ("complete-helper-read", [[1, 160]]),
    "metadata.ts": ("complete-helper-read", [[1, 112]]),
    "language-settings.ts": ("bounded-helper-read", [[30, 39], [110, 154], [425, 440]]),
    "model-catalog-projection.ts": ("bounded-helper-read", [[335, 394]]),
    "notifications/inbox.ts": ("bounded-helper-read", [[1, 25]]),
    "subagents/manager.ts": ("bounded-helper-read", [[80, 104]]),
    "tool-arguments.ts": ("bounded-helper-read", [[1, 100]]),
}


def main():
    for index, trace in enumerate(TRACES, 1):
        trace["trace_id"] = f"IC{index:02}"
        trace["imports"] = primary_imports(trace["source_file"])
        trace["read_depth"] = "bounded-helper-consumer-trace"
    (HERE / "traces.json").write_text(json.dumps(TRACES, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="")
    write_csv("files.csv", ["source_file", "disposition", "evidence"], [
        dict(source_file=t["source_file"], disposition=t["read_depth"],
             evidence=f"{t['trace_id']}: selected ranges " + "; ".join(f"{a}-{b}" for a, b in t["read_ranges"]) +
             ". Helper use/handling/consumer anchors are in traces.json; not a full importer-body claim.") for t in TRACES])
    headers = ["surface_id", "owner", "source_file", "source_symbol", "entry_point", "state", "locale_path", "source_finding", "evidence_level", "existing_test", "coverage_limit"]
    write_csv("surfaces.csv", headers, SURFACES)
    paths = {t["source_file"] for t in TRACES}
    for trace in TRACES:
        paths.update(item["target"] for item in trace["imports"])
        paths.update(re.match(r"(.+\.ts):", anchor)[1] for anchor in trace["anchors"])
    paths.update(CLI + path for path in HELPER_READS)
    supporting = {}
    candidate_paths = {t["source_file"] for t in TRACES}
    for trace in TRACES:
        for anchor in trace["anchors"]:
            match = re.fullmatch(r"(.+\.ts):(\d+)-(\d+)", anchor)
            path, start, end = match.groups()
            if path not in candidate_paths:
                supporting.setdefault(path, dict(read_depth="bounded-consumer-read", read_ranges=[]))["read_ranges"].append([int(start), int(end)])
    for path, (depth, ranges) in HELPER_READS.items():
        entry = supporting.setdefault(CLI + path, dict(read_depth=depth, read_ranges=[]))
        entry["read_depth"] = depth
        entry["read_ranges"].extend(ranges)
    for entry in supporting.values():
        entry["read_ranges"] = sorted(set(tuple(pair) for pair in entry["read_ranges"]))
    (HERE / "support-reads.json").write_text(json.dumps(supporting, indent=2) + "\n", encoding="utf-8", newline="")
    # Whole-file hashes detect stale anchors; they are NOT whole-body reading declarations.
    receipt = dict(baseline="62dee0ff79ad83afa96947ea58e5c426bb1563e8", static_only=True,
                   candidate_traces=len(TRACES), new_full_body_claims=0, surface_families=len(SURFACES),
                   semantic_signoff=False, runtime_signoff=False, native_signoff=False,
                   source_snapshots={path: dict(lines=len((ROOT / path).read_text(encoding="utf-8").splitlines()),
                                                sha256=hashlib.sha256((ROOT / path).read_bytes()).hexdigest()) for path in sorted(paths)})
    (HERE / "source-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8", newline="")
    print(json.dumps(dict(candidate_traces=len(TRACES), surface_families=len(SURFACES),
                          named_value_imports=sum(len(i["symbols"]) for t in TRACES for i in t["imports"]),
                          source_snapshots=len(paths), new_full_body_claims=0), indent=2))


if __name__ == "__main__":
    main()
