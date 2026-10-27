# English source catalog for the Jouzu CLI.
#
# One message per CliMessageId. The Fluent identifier is the stable dotted
# message ID with each dot replaced by a hyphen. The `en` catalog is the
# source and the complete fallback; keep every ID present.

jouzu-cli-error-piImport = Jouzu Pi import failed: { $message }
jouzu-cli-error-keybindingConflict = { $plan }
jouzu-cli-error-keybindingConflict-recovery = Resolve the conflicts above, then run "jouzu keybindings apply" again.
jouzu-cli-error-keybindingConfig = Jouzu keybindings failed: { $message }
jouzu-cli-error-profileState = Jouzu profile state is unreadable: { $message }
jouzu-cli-error-profileState-recovery = Recovery: repair or remove the profile state file, then run "jouzu profile plan" and "jouzu profile apply" again.
jouzu-cli-error-profileConflict = { $plan }
jouzu-cli-error-profileConflict-recovery = Resolve the conflicts above, then run "jouzu profile apply" again.
jouzu-cli-error-usage = Error: { $message }
jouzu-cli-error-usage-hint = Run "jouzu --help" for Jouzu usage or "jouzu pi --help" for Pi usage.
jouzu-cli-error-generic = Jouzu failed: { $message }
jouzu-cli-error-update = Jouzu update failed: { $message }
jouzu-cli-args-optionValueRequired = { $option } requires a value
jouzu-cli-args-internalParserError = internal parser error for { $option }
jouzu-cli-args-catalogOperationRequired = catalog requires "status", "refresh", "accept", "validate", or "conformance"
jouzu-cli-args-catalogAcceptOptionsRequireValues = catalog accept options require values
jouzu-cli-args-catalogUnknownAcceptOption = unknown catalog accept option: { $option }
jouzu-cli-args-catalogAcceptUsage = catalog accept requires <revision> --digest <sha256> [--source <source-id>]
jouzu-cli-args-catalogFileRequired = catalog { $operation } requires one file path and optional --json
jouzu-cli-args-catalogUnknownOption = unknown catalog { $operation } option: { $token }
jouzu-cli-args-selfUpdateOperationRequired = self-update requires "status", "check", "apply", or "policy"
jouzu-cli-args-selfUpdatePolicyRequired = self-update policy must be one of: auto-restart, notify, off
jouzu-cli-args-selfUpdatePolicySingleValue = self-update policy accepts exactly one value
jouzu-cli-args-selfUpdateUnknownOption = unknown self-update { $operation } option: { $token }
jouzu-cli-args-keybindingsOperationRequired = keybindings requires "status", "plan", "apply", or "reset"
jouzu-cli-args-keybindingsUnknownOption = unknown keybindings { $operation } option: { $token }
jouzu-cli-args-profileMixedSelection = use profile --profile <core|ja>; do not mix it with --jouzu-profile
jouzu-cli-args-profileOperationRequired = profile requires "plan" or "apply"
jouzu-cli-args-profileRepeatedOption = --profile may be specified only once
jouzu-cli-args-profileInvalidId = --profile must be one of: { $values }
jouzu-cli-args-profileRepeatedJson = --json may be specified only once
jouzu-cli-args-profileUnknownOption = unknown profile { $operation } option: { $token }
jouzu-cli-args-homeRepeated = --jouzu-home may be specified only once
jouzu-cli-args-launchProfileRepeated = --jouzu-profile may be specified only once
jouzu-cli-args-launchProfileInvalidId = --jouzu-profile must be one of: { $values }
jouzu-cli-args-uiLocaleRepeated = --jouzu-ui-locale may be specified only once
jouzu-cli-args-uiLocaleInvalid = --jouzu-ui-locale must be one of: { $values }
jouzu-cli-args-textguardRepeated = { $option } may be specified only once
jouzu-cli-args-unknownJouzuOption = unknown Jouzu option: { $token }
jouzu-cli-args-textguardOffStrict = --jouzu-textguard-off and --jouzu-textguard-strict cannot be combined
jouzu-cli-args-textguardOffFiles = --jouzu-textguard-off and --jouzu-textguard-files cannot be combined
jouzu-cli-args-doctorUnexpectedToken = doctor does not accept { $token }
jouzu-cli-args-versionHelpArguments = { $command } does not accept arguments; use "jouzu pi { $command }" for Pi

# Pre-launch help, version, doctor, and report text.
# Help messages are complete semantic units. The renderer owns wrapping and
# alignment; command and key arguments stay intact.

jouzu-cli-help-title = Jouzu agentic AI environment
jouzu-cli-help-usageHeading = Usage:
jouzu-cli-help-commandsHeading = Commands:
jouzu-cli-acp-model = Model
jouzu-cli-acp-reject = Reject
jouzu-cli-acp-formUnavailable = This ACP host does not support form input. The dialog was cancelled.
jouzu-cli-help-command-acp = Serve Agent Client Protocol over standard input and output
jouzu-cli-help-command-doctor = Show non-mutating runtime and isolation diagnostics
jouzu-cli-help-command-catalog = Inspect optional catalog setup or validate a catalog file
jouzu-cli-help-command-profilePlan = Preview safe Core/JA profile changes without writing
jouzu-cli-help-command-profileApply = Apply the selected profile with conflicts and backups
jouzu-cli-help-command-keybindings = Inspect, apply, or reset Jouzu's Pi-compatible key defaults
jouzu-cli-help-command-selfUpdate = Inspect, check, apply, or configure Jouzu npm updates
jouzu-cli-help-command-pi = Explicitly pass all remaining arguments to pinned Pi
jouzu-cli-help-textguard-scanning = TextGuard scans skills and web content locally by default.
jouzu-cli-help-textguard-handling = Flagged web results reach the model labelled as untrusted data; flagged skills stay withheld until you approve them.
jouzu-cli-help-textguard-controls = Use { $reviewCommand } in an interactive session to review findings, and { $onCommand }, { $strictCommand }, or { $offCommand } to change scanning for that session.
jouzu-cli-help-option-textguardStrict = Withhold every flagged input until approved
jouzu-cli-help-option-textguardOff = Start with scanning off
jouzu-cli-help-option-textguardFiles = Also scan ordinary read-tool content
jouzu-cli-help-option-uiLocale = UI language; auto follows the OS locale
jouzu-cli-help-footer-alias = The { $alias } command behaves identically to { $command }.
jouzu-cli-help-footer-resume = Resume with the { $command } command printed on exit; Jouzu resolves its isolated session root.
jouzu-cli-help-footer-profile = The first interactive launch asks before enabling the optional JA profile; Core is the fallback.
jouzu-cli-help-footer-startup = Interactive launches clear the viewport and show the Jouzu header; set { $setting } to preserve the existing screen.
jouzu-cli-help-footer-palette = Open the Jouzu Palette through { $command } or { $key }.
jouzu-cli-help-footer-catalogs = { $command } opens Settings / Catalogs directly.
jouzu-cli-help-footer-sections = { $nextKey } or { $previousKey } switches Palette sections in browse mode.
jouzu-cli-help-footer-pi = Use { $command } for Pi CLI help.

jouzu-cli-version-jouzu = jouzu { $version }
jouzu-cli-version-pi = pi { $version }
jouzu-cli-version-profileSchema = profile schema { $version }
jouzu-cli-localization-future = Jouzu localization settings use schemaVersion { $version }, which this build does not understand; using English and leaving the file unchanged.
jouzu-cli-localization-invalid = Jouzu localization settings could not be used ({ $reason }); using English and leaving the file unchanged.

# Localization and context-policy diagnostics.
# A damaged or hand-edited settings file reaches these. The settings keys, the
# schema version, the byte limits, and the token bounds stay protected values;
# the numeric ones are passed as strings so Fluent never adds grouping
# separators.

jouzu-cli-localization-config-notInspected = localization settings could not be inspected
jouzu-cli-localization-config-notRegularFile = localization settings must be a regular file
jouzu-cli-localization-config-tooLarge = localization settings exceed { $maxBytes } bytes
jouzu-cli-localization-config-invalidJson = localization settings are invalid JSON: { $message }
jouzu-cli-localization-config-notObject = localization settings must be an object
jouzu-cli-localization-config-unknownFields = localization settings have unknown fields
jouzu-cli-localization-config-schemaVersionInvalid = localization settings schemaVersion is invalid
jouzu-cli-localization-config-localizationNotObject = localization settings must carry a localization object
jouzu-cli-localization-config-unknownLocalizationFields = localization settings have unknown localization fields
jouzu-cli-localization-uiLocaleNotString = localization.uiLocale must be a string
jouzu-cli-localization-uiLocaleUnsupported = localization.uiLocale is not a supported UI locale: { $value }
jouzu-cli-localization-osCandidateUnsupported = unsupported OS locale candidate: { $candidate }
jouzu-cli-localization-lockNotRegularFile = localization.lock is not a regular lock file
jouzu-cli-localization-lockBusy = another localization settings save is in progress
jouzu-cli-localization-responseLanguageNotString = localization.responseLanguage must be a string
jouzu-cli-localization-responseLanguageUnsupported = localization.responseLanguage is not a supported response language: { $value }
jouzu-cli-localization-artifactPolicyNotObject = localization.artifactPolicy must be an object
jouzu-cli-localization-artifactPolicyFieldInvalid = localization.artifactPolicy.{ $field } is not a supported artifact language: { $value }

# The trusted project policy is read from `<repository root>/.jouzu/localization.json`.
# A repository whose trust cannot be established is never read, so these reasons
# only appear for a repository the runtime reported as trusted.

jouzu-cli-projectPolicy-notInspected = project language policy could not be inspected
jouzu-cli-projectPolicy-notRegularFile = project language policy must be a regular file
jouzu-cli-projectPolicy-tooLarge = project language policy exceeds { $maxBytes } bytes
jouzu-cli-projectPolicy-invalidJson = project language policy is invalid JSON: { $message }
jouzu-cli-projectPolicy-notObject = project language policy must be an object
jouzu-cli-projectPolicy-artifactPolicyNotObject = project language policy localization.artifactPolicy must be an object

jouzu-cli-context-policy-notBoundedFile = context policy must be a bounded regular file
jouzu-cli-context-policy-notObject = context policy must be an object
jouzu-cli-context-policy-unknownKeys = context policy has unknown keys: { $keys }
jouzu-cli-context-policy-schemaVersionRequired = context policy requires schemaVersion { $version }
jouzu-cli-context-policy-maxTokensRange = context policy maxContextTokens must be an integer from { $min } to { $max }

jouzu-cli-report-problem = problem
jouzu-cli-report-problems = problems
jouzu-cli-report-warning = warning
jouzu-cli-report-warnings = warnings

jouzu-cli-doctor-title = Jouzu doctor
jouzu-cli-doctor-notes = Notes
jouzu-cli-doctor-hint = Run "jz doctor --json" for the same report as JSON, or "jz catalog status" for catalog detail.
jouzu-cli-doctor-upstreamConstraint = Upstream text constraint: the pinned Pi and the third-party bundled extensions render their own English that Jouzu does not translate or replace, while the Jouzu-owned browser adapter renders its tool labels from the Jouzu catalog. A surface that could not be inspected stays unverified and is not counted as translated. Recheck when the Pi pin or an extension version changes.
jouzu-cli-doctor-section-runtime = Runtime
jouzu-cli-doctor-section-catalog = Model catalog
jouzu-cli-doctor-section-platform = Platform
jouzu-cli-doctor-section-localization = Localization
jouzu-cli-doctor-section-upstream = Upstream boundary
jouzu-cli-doctor-section-roots = Roots
jouzu-cli-doctor-section-profile = Profile
jouzu-cli-doctor-field-jouzu-version = Jouzu version
jouzu-cli-doctor-field-pi-runtime = Pi runtime
jouzu-cli-doctor-field-pi-upstream = Pi upstream
jouzu-cli-doctor-field-pi-packageSource = Pi package source
jouzu-cli-doctor-field-pi-qualification = Pi qualification
jouzu-cli-doctor-field-profile-schema = Profile schema
jouzu-cli-doctor-field-extensions-releaseOwned = Release-owned extensions
jouzu-cli-doctor-field-skills-packageOwned = Package-owned skills
jouzu-cli-doctor-field-extensions-compatibilityDependencies = Compatibility dependencies
jouzu-cli-doctor-field-camoufox-runtime = Optional Camoufox runtime
jouzu-cli-doctor-field-update-installChannel = Install channel
jouzu-cli-doctor-field-update-policy = Self-update policy
jouzu-cli-doctor-field-update-channel = Self-update channel
jouzu-cli-doctor-field-update-startupEligible = Automatic startup update
jouzu-cli-doctor-field-update-lastCheckedAt = Last update check
jouzu-cli-doctor-field-update-latestVersion = Latest observed Jouzu
jouzu-cli-doctor-field-keybindings-status = Keybinding defaults
jouzu-cli-doctor-field-keybindings-policy = Keybinding policy
jouzu-cli-doctor-field-keybindings-followUpKey = Jouzu default follow-up key
jouzu-cli-doctor-field-keybindings-dequeueKey = Jouzu default dequeue key
jouzu-cli-doctor-field-keybindings-configPath = Keybinding config
jouzu-cli-doctor-field-executable = Executable
jouzu-cli-doctor-field-catalog-sources = Active catalogs
jouzu-cli-doctor-field-catalog-offerings = Offerings
jouzu-cli-doctor-field-catalog-registration = Model registration
jouzu-cli-doctor-field-catalog-thinkingLevels = Thinking levels
jouzu-cli-doctor-field-platform = Platform
jouzu-cli-doctor-field-node = Node
jouzu-cli-doctor-field-locale = Locale
jouzu-cli-doctor-field-git = Git
jouzu-cli-doctor-field-bash = Bash
jouzu-cli-doctor-field-npm = npm
jouzu-cli-doctor-field-proxy = Proxy configured
jouzu-cli-doctor-field-extraCaCerts = Additional CA configured
jouzu-cli-doctor-field-localization-requested = UI locale requested
jouzu-cli-doctor-field-localization-effective = UI locale effective
jouzu-cli-doctor-field-localization-source = UI locale source
jouzu-cli-doctor-field-localization-fallback = UI locale fallback reason
jouzu-cli-doctor-field-localization-catalogVersion = UI catalog version
jouzu-cli-doctor-field-localization-catalogDigest = UI catalog digest
jouzu-cli-doctor-field-localization-catalogFallback = UI catalog fallback reason
jouzu-cli-doctor-field-localization-catalogState = UI catalog support state
jouzu-cli-doctor-field-localization-supportStates = Recorded UI catalog states
jouzu-cli-doctor-field-language-responseLanguage-requested = Response language requested
jouzu-cli-doctor-field-language-responseLanguage-effective = Response language effective
jouzu-cli-doctor-field-language-responseLanguage-source = Response language source
jouzu-cli-doctor-field-language-artifactPolicy-requested = Artifact policy requested
jouzu-cli-doctor-field-language-artifactPolicy-effective = Artifact policy effective
jouzu-cli-doctor-field-language-artifactPolicy-source = Artifact policy source
jouzu-cli-doctor-field-language-projectPolicy = Project language policy
jouzu-cli-doctor-field-upstream-surfaces-total = Recorded surfaces
jouzu-cli-doctor-field-upstream-surfaces-translated = Translated surfaces
jouzu-cli-doctor-field-upstream-surfaces-upstreamOwned = Upstream-owned surfaces
jouzu-cli-doctor-field-upstream-surfaces-notInspected = Not-inspected surfaces
jouzu-cli-doctor-field-upstream-surfaces-outOfScope = Out-of-scope surfaces
jouzu-cli-doctor-field-upstream-supportStage = Support stage
jouzu-cli-doctor-field-paths-agentDir = Agent/config root
jouzu-cli-doctor-field-paths-stateDir = State root
jouzu-cli-doctor-field-paths-sessionDir = Session root
jouzu-cli-doctor-field-paths-cacheDir = Cache root
jouzu-cli-doctor-field-modelPicker-state = Model picker state
jouzu-cli-doctor-field-isolation-piAgentDir = Pi agent root replaced
jouzu-cli-doctor-field-isolation-piSessionDir = Pi session root replaced
jouzu-cli-doctor-field-skills-shared = Shared cross-harness skills
jouzu-cli-doctor-field-profile-selected = Selected profile
jouzu-cli-doctor-field-profile-bundledManifest = Bundled profile manifest
jouzu-cli-doctor-field-profile-appliedManifest = Applied profile manifest
jouzu-cli-doctor-field-packages-count = Configured Pi packages
jouzu-cli-doctor-field-provider-authFile = Provider auth file
jouzu-cli-doctor-field-provider-modelsFile = Custom models file
jouzu-cli-doctor-field-provider-environment = Provider environment
jouzu-cli-doctor-field-lock-profile = Profile lock
jouzu-cli-doctor-field-lock-piImport = Pi import lock
jouzu-cli-doctor-field-lock-keybindings = Keybinding lock
jouzu-cli-doctor-field-lock-modelPicker = Model picker lock
jouzu-cli-doctor-field-lock-update = Update lock
jouzu-cli-doctor-field-lock-camoufoxRuntime = Camoufox runtime install lock

# Doctor diagnoses. Each message is rebuilt from its ID at render time so
# the `doctor --json` report keeps the English machine text it has always had.
# Values such as counts, source IDs, diagnostics, and command names are passed
# as arguments and stay protected.
jouzu-cli-doctor-warning-providerUnconfigured = No obvious provider credential or custom model configuration was found; use /login or provider environment variables
jouzu-cli-doctor-warning-profileNotApplied = The selected profile has not been applied; run "jouzu profile apply"
jouzu-cli-doctor-warning-profileDrift = The applied profile differs from the bundled manifest; run "jouzu profile plan"
jouzu-cli-doctor-warning-packagesNotArray = settings.json packages is not an array
jouzu-cli-doctor-warning-packagesUnparseable = settings.json could not be parsed
jouzu-cli-doctor-warning-updateLastFailed = The last Jouzu update operation failed ({ $code })
jouzu-cli-doctor-warning-updateStatusUnavailable = Self-update status is unavailable: { $diagnostic }
jouzu-cli-doctor-warning-keybindingsConflict = Jouzu keybinding defaults conflict with user bindings; run "jouzu keybindings plan"
jouzu-cli-doctor-warning-keybindingsStatusUnavailable = Keybinding status is unavailable: { $diagnostic }
jouzu-cli-doctor-warning-catalogStatusUnavailable = Catalog status is unavailable: { $diagnostic }
jouzu-cli-doctor-warning-catalogRegistration = { $complete } of { $total } offerings carry the fields a new model needs ({ $gaps }). { $effect } Run "jz catalog status { $sourceId }" for the list.
jouzu-cli-doctor-warning-catalogThinkingLevels = { $count } of { $total } offerings declare no thinking levels, so Jouzu cannot control their reasoning effort. Run "jz catalog status { $sourceId }" for the list.
jouzu-cli-doctor-warning-modelPickerUnreadable = Model picker state is unreadable: { $message }

# Doctor problems. Same render-time mechanism as the warnings, so the
# `doctor --json` report keeps its English machine text while the human text
# localizes. Values such as a version, a lock status, a diagnostic, an error
# list, and a path are passed as arguments and stay protected.
jouzu-cli-doctor-problem-nodeUnsupported = Node { $version } is unsupported; Jouzu requires >=22.19.0
jouzu-cli-doctor-problem-gitMissing = Git was not found on PATH
jouzu-cli-doctor-problem-bashMissing = Bash was not found; install Bash or Git Bash
jouzu-cli-doctor-problem-npmMissing = npm was not found on PATH; npm is required for Jouzu updates
jouzu-cli-doctor-problem-piVersionMismatch = Pinned Pi { $pinned } does not match loaded runtime { $loaded }
jouzu-cli-doctor-problem-piRuntimeUnavailable = Pi runtime could not be loaded: { $diagnostic }
jouzu-cli-doctor-problem-piLockUnqualified = Pi lock status is { $status }, not qualified
jouzu-cli-doctor-problem-extensionsUnavailable = Required release extensions are unavailable: { $errors }
jouzu-cli-doctor-problem-extensionsOptionalUnavailable = Optional release extensions are unavailable: { $failures }. Correct the reported platform or package error, then rerun `jz doctor`.
jouzu-cli-doctor-problem-extensionsDisabledTools = ; disabled tools: { $tools }
jouzu-cli-doctor-problem-extensionsManifestInvalid = Release extension inventory is unavailable: { $diagnostic }
jouzu-cli-doctor-problem-camoufoxRuntimeInvalid = The optional Camoufox runtime is invalid at { $path }; remove that directory and retry a browser tool
jouzu-cli-doctor-problem-lockUnreadable = A state lock could not be inspected: { $path }
jouzu-cli-doctor-problem-lockStale = A leftover state lock blocks Jouzu operations: { $path } ({ $status })

jouzu-cli-catalog-title = Jouzu model catalog
jouzu-cli-catalog-title-plural = Jouzu model catalogs
jouzu-cli-catalog-sourcesActive = { $active } of { $configured } sources active
jouzu-cli-catalog-notes = Notes
jouzu-cli-catalog-hint = Run "jz catalog status <source-id>" for one source, or add --json for the stored record.
jouzu-cli-catalog-unconfigured = No model catalog endpoint is configured. Jouzu continues using Pi and local model configuration.
jouzu-cli-catalog-state-unconfigured = unconfigured
jouzu-cli-catalog-state-empty = empty
jouzu-cli-catalog-state-active = active
jouzu-cli-catalog-state-stale = stale
jouzu-cli-catalog-state-degraded = degraded
jouzu-cli-catalog-problem = problem
jouzu-cli-catalog-problems = problems
jouzu-cli-catalog-warning = warning
jouzu-cli-catalog-warnings = warnings
jouzu-cli-catalog-field-endpoint = Endpoint
jouzu-cli-catalog-field-catalog = Catalog
jouzu-cli-catalog-field-models = Models
jouzu-cli-catalog-field-registration = Registration
jouzu-cli-catalog-field-thinkingLevels = Thinking levels
jouzu-cli-catalog-field-revision = Revision
jouzu-cli-catalog-field-sequence = Sequence
jouzu-cli-catalog-field-validated = Validated
jouzu-cli-catalog-field-credential = Credential
jouzu-cli-catalog-field-quarantined = Quarantined candidates
jouzu-cli-catalog-field-lastError = Last error
jouzu-cli-catalog-valid = Model catalog is valid.
jouzu-cli-catalog-invalid = Model catalog is invalid: { $message }
jouzu-cli-catalog-note-tokenMissing = token variable { $name } is not set and no token is saved for this source; refreshes are skipped until one is available.
jouzu-cli-catalog-note-registrationGaps = { $complete } of { $total } offerings carry the fields a new model needs ({ $gaps }). { $effect }
jouzu-cli-catalog-note-thinkingLevels = { $count } of { $total } offerings have no declared levels, so Jouzu cannot control their reasoning effort.
jouzu-cli-catalog-note-quarantined = { $count } candidate revisions are quarantined.
jouzu-cli-catalog-field-registrationValue = { $complete } of { $total } offerings carry the fields a new model needs
jouzu-cli-catalog-field-thinkingLevelsValue = { $count } of { $total } offerings have no declared levels
jouzu-cli-catalog-credential-environmentSet = environment variable { $name } (set)
jouzu-cli-catalog-credential-savedToken = saved token (environment variable { $name } not set)
jouzu-cli-catalog-credential-environmentNotSet = environment variable { $name } (not set)
jouzu-cli-catalog-status-disabled = disabled
jouzu-cli-catalog-sourceNotFound = catalog source not found: { $id }
jouzu-cli-catalog-tokenMissing = Catalog token variable { $name } is not set in this Jouzu process. Export it before starting Jouzu or save a token in Settings / Catalogs, then retry.
jouzu-cli-catalog-tokenMissingWithSaved = Catalog token variable { $name } is not set in this Jouzu process and no token is saved for this source. Export it before starting Jouzu or save a token in Settings / Catalogs, then retry.
jouzu-cli-catalog-attempt-http = HTTP { $status }
jouzu-cli-catalog-attempt-timedOut = timed out
jouzu-cli-catalog-discovery-authFailed = Catalog authentication failed (HTTP { $status }). Configure bearer-token authentication if this catalog requires it.
jouzu-cli-catalog-discovery-accessDenied = Catalog access was denied (HTTP { $status }). Configure bearer-token authentication if this catalog requires it.
jouzu-cli-catalog-discovery-authFailedBearer = Catalog authentication failed (HTTP { $status }). Check that { $name } or this source's saved token contains a bearer token accepted by the catalog.
jouzu-cli-catalog-discovery-accessDeniedBearer = Catalog access was denied (HTTP { $status }). Check that { $name } or this source's saved token contains a bearer token accepted by the catalog.
jouzu-cli-catalog-insecureTransport = This catalog uses HTTP, so its bearer token is sent in plain text and can be read on the network. Use HTTPS if the catalog supports it.
jouzu-cli-catalog-registrationEffect = An offering for a model Pi does not already provide is dropped, so that model never reaches the model list.
jouzu-cli-catalog-registrationGap-field = no { $field }
jouzu-cli-catalog-registrationGap-count = { $count } no { $field }
jouzu-cli-catalog-registrationGap-detail = { $model } — { $gap }
jouzu-cli-catalog-registrationField-textModality = text input
jouzu-cli-catalog-registrationField-contextWindow = context window
jouzu-cli-catalog-registrationField-maxOutputTokens = maximum output tokens
jouzu-cli-catalog-listSeparator = ,{" "}

# Catalog source configuration validation, endpoint discovery, and sync
# failure text. A source id, a field name, an index, a URL, a media type, and an
# HTTP status are protected values passed as arguments; the sentence around them
# resolves from the session bundle. The English values are byte-identical to the
# literals they replace.

jouzu-cli-catalogSource-context-source = catalog source { $index }
jouzu-cli-catalogSource-context-sourceAuth = catalog source { $index }.auth
jouzu-cli-catalogSource-context-sourceLabel = catalog source { $index } label
jouzu-cli-catalogSource-context-sourceLabelBare = catalog source label
jouzu-cli-catalogSource-context-override = catalog source override { $id }
jouzu-cli-catalogSource-context-registry = catalog source registry
jouzu-cli-catalogSource-context-overrides = catalog source overrides
jouzu-cli-catalogSource-context-credentials = catalog credentials
jouzu-cli-catalogSource-context-url = catalog source URL
jouzu-cli-catalogSource-context-token = catalog token
jouzu-cli-catalogSource-context-tokenFor = catalog token for { $id }
jouzu-cli-catalogSource-unknownField = { $context } contains unknown field: { $field }
jouzu-cli-catalogSource-notObject = { $context } must be an object
jouzu-cli-catalogSource-notBoundedText = { $context } must be non-empty, bounded, and control-free
jouzu-cli-catalogSource-invalidSourceId = catalog source id must use 1-64 lowercase letters, numbers, dots, dashes, or underscores
jouzu-cli-catalogSource-urlAbsolute = catalog source URL must be an absolute HTTP(S) URL or host
jouzu-cli-catalogSource-urlCredentials = catalog source URL must not contain credentials
jouzu-cli-catalogSource-urlQueryOrFragment = catalog source URL must not contain a query or fragment
jouzu-cli-catalogSource-urlScheme = catalog source URL must use HTTP or HTTPS
jouzu-cli-catalogSource-authBearerCredentialRef = { $context } bearer auth requires an environment credential reference
jouzu-cli-catalogSource-authInvalidCredentialRef = { $context } has an invalid environment credential reference
jouzu-cli-catalogSource-authType = { $context }.type must be none or bearer
jouzu-cli-catalogSource-sourceNotObject = catalog source { $index } must be an object
jouzu-cli-catalogSource-sourceRequiresFields = catalog source { $index } requires id, label, and url strings
jouzu-cli-catalogSource-sourceEnabledBoolean = catalog source { $index }.enabled must be boolean
jouzu-cli-catalogSource-registryNotObject = catalog source registry must be an object
jouzu-cli-catalogSource-registrySchema = catalog source registry requires schemaVersion 1 and a sources array
jouzu-cli-catalogSource-registryNotRegularFile = catalog source registry must be a bounded regular file
jouzu-cli-catalogSource-duplicateId = duplicate catalog source id: { $id }
jouzu-cli-catalogSource-duplicateUrl = duplicate catalog source URL: { $url }
jouzu-cli-catalogSource-overrideNotObject = catalog source override { $id } must be an object
jouzu-cli-catalogSource-overrideEnabledBoolean = catalog source override { $id }.enabled must be boolean
jouzu-cli-catalogSource-overridesNotObject = catalog source overrides must be an object
jouzu-cli-catalogSource-overridesSchema = catalog source overrides require schemaVersion 1 and an overrides object
jouzu-cli-catalogSource-overridesNotRegularFile = catalog source overrides must be a bounded regular file
jouzu-cli-catalogSource-credentialsNotObject = catalog credentials must be an object
jouzu-cli-catalogSource-credentialsSchema = catalog credentials require schemaVersion 1 and a tokens object
jouzu-cli-catalogSource-credentialsNotRegularFile = catalog credentials must be a bounded regular file
jouzu-cli-catalogSource-tokenNotString = catalog token for { $id } must be a string
jouzu-cli-catalogSource-builtinImmutableEdit = cannot edit the built-in { $label } catalog source; it can only be enabled or disabled
jouzu-cli-catalogSource-builtinImmutableRemove = cannot remove the built-in { $label } catalog source; it can only be enabled or disabled
jouzu-cli-catalogSource-reservedId = source id "{ $id }" is reserved for the built-in Shisa API catalog ({ $url }, env:{ $env }); this entry points elsewhere, so the built-in source stays inactive
jouzu-cli-catalogSource-signedOut = Signed out of Shisa. Run /login shisa to reconnect.
jouzu-cli-catalogSource-discoveryCanceled = Catalog endpoint discovery was canceled.
jouzu-cli-catalogSource-unsupportedContentType = unsupported Content-Type { $mediaType }
jouzu-cli-catalogSource-mediaTypeMissing = missing
jouzu-cli-catalogSource-attemptValid = valid
jouzu-cli-catalogSource-responseTooLarge = catalog response exceeds 16 MiB
jouzu-cli-catalogSource-noCatalogFound = No Jouzu catalog found. Attempts: { $attempts }

# Catalog sync failure text. A state-lock status word and an HTTP status
# are protected values passed as arguments.
jouzu-cli-catalog-sync-refreshBusy = model catalog refresh is busy ({ $status })
jouzu-cli-catalog-sync-operationBusy = model catalog operation is busy ({ $status })
jouzu-cli-catalog-sync-authFailed = Catalog authentication failed (HTTP 401). Sign in again or update this source's saved token or environment credential.
jouzu-cli-catalog-sync-accessDenied = Catalog access was denied (HTTP 403). Check this account's catalog access with the service operator.
jouzu-cli-catalog-sync-proxyAuth = The proxy requires authentication (HTTP 407). Check your proxy credentials and configuration.
jouzu-cli-catalog-sync-httpError = catalog endpoint returned HTTP { $status }
jouzu-cli-catalog-sync-noActiveAccount = no catalog account is active

# The interactive Pi configuration import prompt and its output. A file
# name, a path, and an error detail are protected values passed as arguments.
jouzu-cli-piImport-questionModels = Found existing Pi custom models at { $path }.{"\u000A"}Copy models.json into Jouzu's isolated configuration? The Pi source will not be changed. [y/N]{" "}
jouzu-cli-piImport-questionAuth = Found saved Pi provider credentials at { $path }.{"\u000A"}Copy auth.json into Jouzu's private configuration? The Pi source will not be changed. [y/N]{" "}
jouzu-cli-piImport-invalidSource = Existing Pi { $filename } was not imported because it is not a regular JSON object.
jouzu-cli-piImport-imported = Imported { $filename } into Jouzu.
jouzu-cli-piImport-skipped = Skipped { $filename } because Jouzu already has one.
jouzu-cli-piImport-importFailed = could not import { $filename }: { $detail }
jouzu-cli-piImport-lockBusy = another Pi import decision is in progress

# Catalog failure explanations and locale-selection fallback reasons.
# The failure code stays the identity of a refresh result; only the
# explanation is catalog text, so a resolved catalog renders it in the active
# locale while `--json` and the stored record keep the English value.
jouzu-cli-catalog-failure-dnsHostname = Catalog hostname could not be resolved. Check the endpoint, DNS, and VPN connection.
jouzu-cli-catalog-failure-dnsLookup = Catalog DNS lookup temporarily failed. Check the network connection and retry.
jouzu-cli-catalog-failure-connectionRefused = The catalog connection was refused. Check the endpoint and proxy address.
jouzu-cli-catalog-failure-connectionReset = The catalog connection was reset. Check the connection and any proxy or security software.
jouzu-cli-catalog-failure-connectionClosed = The catalog connection closed unexpectedly. Check the connection and proxy configuration.
jouzu-cli-catalog-failure-networkUnreachable = The catalog network is unreachable. Check the network, VPN, and proxy configuration.
jouzu-cli-catalog-failure-hostUnreachable = The catalog host is unreachable. Check the network, VPN, and proxy configuration.
jouzu-cli-catalog-failure-timeout = The catalog request timed out. Check connectivity and proxy configuration, then retry.
jouzu-cli-catalog-failure-connectTimeout = Connecting to the catalog timed out. Check connectivity and proxy configuration.
jouzu-cli-catalog-failure-headersTimeout = The catalog did not send response headers in time. Retry or check the catalog service.
jouzu-cli-catalog-failure-bodyTimeout = The catalog response stalled. Retry or check the catalog service.
jouzu-cli-catalog-failure-networkPermission = Permission to connect to the catalog was denied. Check the machine's outbound network policy.
jouzu-cli-catalog-failure-redirectBlocked = The catalog redirected the request. Use its final endpoint URL; Jouzu does not forward catalog credentials through redirects.
jouzu-cli-catalog-failure-filesystem = Jouzu could not read or write its local catalog data ({ $code }). Check the Jouzu data folder's permissions, available space, and whether another program is using it.
jouzu-cli-catalog-failure-certificate = Catalog certificate verification failed ({ $code }). Check the system clock and trusted certificates, including any organization proxy certificate. Do not disable certificate verification.
jouzu-cli-catalog-failure-network = The catalog request failed. Check the endpoint, network connection, proxy environment variables, and trusted certificates.
jouzu-cli-catalog-failure-cache = Jouzu could not access its local catalog data. Check the Jouzu data folder and retry.
jouzu-cli-catalog-sourceNotFoundOrDisabled = catalog source not found or disabled: { $id }
jouzu-cli-catalog-fallback-noCatalog = no catalog for "{ $requested }" (canonical locale "{ $canonical }"); using English
jouzu-cli-catalog-fallback-unsupported = unsupported locale "{ $requested }"; using English
jouzu-cli-catalog-fallback-canonical = no exact catalog for "{ $requested }"; using the canonical locale "{ $canonical }"

jouzu-cli-keybindings-title = Jouzu keybinding plan
jouzu-cli-keybindings-notes = Notes
jouzu-cli-keybindings-plan = Plan
jouzu-cli-keybindings-desired = Desired bindings
jouzu-cli-keybindings-actions = Actions
jouzu-cli-keybindings-field-policy = Policy
jouzu-cli-keybindings-field-config = Config
jouzu-cli-keybindings-noChanges = No keybinding changes are needed.
jouzu-cli-keybindings-applied = Applied keybinding transaction: { $id }
jouzu-cli-keybindings-reset = Reset keybinding transaction: { $id }
jouzu-cli-keybindings-alreadyConverged = Keybinding defaults already converged.
jouzu-cli-keybindings-alreadyDisabled = Keybinding defaults already disabled.
jouzu-cli-keybindings-backup = Backup: { $path }

# keybindings.json and keybindings-state.json validation. The file names,
# an action id, and a JSON error detail are protected values or arguments.
jouzu-cli-keybindings-config-notRegularFile = keybindings.json must be a regular file
jouzu-cli-keybindings-config-invalidJson = keybindings.json is invalid JSON: { $detail }
jouzu-cli-keybindings-config-notObject = keybindings.json must be an object
jouzu-cli-keybindings-config-bindingInvalid = keybindings.json binding for { $action } must be a key or array of keys
jouzu-cli-keybindings-state-notRegularFile = keybinding state must be a regular file
jouzu-cli-keybindings-state-invalidJson = keybinding state is invalid JSON: { $detail }
jouzu-cli-keybindings-state-notObject = keybinding state must be an object
jouzu-cli-keybindings-state-fieldsInvalid = keybinding state fields are invalid
jouzu-cli-keybindings-state-insertedNotObject = keybinding state inserted binding must be an object
jouzu-cli-keybindings-state-insertedInvalid = keybinding state inserted binding is invalid or duplicated

jouzu-cli-profile-title = Jouzu profile plan
jouzu-cli-profile-section = Profile
jouzu-cli-profile-actions = Actions
jouzu-cli-profile-field-manifest = Manifest
jouzu-cli-profile-field-agentRoot = Agent root
jouzu-cli-profile-noChanges = No profile changes are needed.
jouzu-cli-profile-applied = Applied transaction: { $id }
jouzu-cli-profile-alreadyConverged = Profile already converged
jouzu-cli-profile-backups = Backups: { $path }

# Profile-state and saved-profile-choice validation. A path and a JSON
# error detail are protected values passed as arguments.
jouzu-cli-profile-state-notRegularFile = profile state must be a regular file: { $path }
jouzu-cli-profile-state-invalidJson = profile state is invalid JSON at { $path }: { $detail }
jouzu-cli-profile-state-notObject = profile state must be an object
jouzu-cli-profile-state-unknownFields = profile state has unknown fields
jouzu-cli-profile-state-fieldsInvalid = profile state fields are invalid at { $path }
jouzu-cli-profile-state-targetNotObject = profile state managed target must be an object
jouzu-cli-profile-state-targetInvalid = profile state managed target is invalid or duplicated
jouzu-cli-profile-choice-notRegularFile = profile choice must be a regular file
jouzu-cli-profile-choice-invalidJson = profile choice is invalid JSON: { $detail }
jouzu-cli-profile-choice-notObject = profile choice must be an object
jouzu-cli-profile-choice-unknownFields = profile choice has unknown fields
jouzu-cli-profile-choice-fieldsInvalid = profile choice fields are invalid
jouzu-cli-profile-japaneseEnabled = Japanese support enabled.
jouzu-cli-profile-coreFallback = Continuing with the Core profile.

jouzu-cli-selfUpdate-title = Jouzu self-update status
jouzu-cli-selfUpdate-policy = Policy: { $value }
jouzu-cli-selfUpdate-installChannel = Install channel: { $value }
jouzu-cli-selfUpdate-automatic = Automatic startup update: { $value }
jouzu-cli-selfUpdate-installed = Installed version: { $version }
jouzu-cli-selfUpdate-latest = Latest observed version: { $value }
jouzu-cli-selfUpdate-lastResult = Last result: { $value }
jouzu-cli-selfUpdate-lastChecked = Last checked: { $value }
jouzu-cli-selfUpdate-nextCheck = Next check: { $value }
jouzu-cli-selfUpdate-lastUpdated = Last updated: { $value }
jouzu-cli-selfUpdate-previous = Previous version: { $value }
jouzu-cli-selfUpdate-lastError = Last error: { $value }
jouzu-cli-selfUpdate-value-eligible = eligible
jouzu-cli-selfUpdate-value-notEligible = not eligible
jouzu-cli-selfUpdate-value-notChecked = not checked
jouzu-cli-selfUpdate-value-never = never
jouzu-cli-selfUpdate-value-due = due
jouzu-cli-selfUpdate-value-none = none
jouzu-cli-selfUpdate-available = Jouzu { $version } is available (installed { $installed })
jouzu-cli-selfUpdate-current = Jouzu { $installed } is current (latest { $latest })
jouzu-cli-selfUpdate-applied = Updated Jouzu to { $version }. Restart Jouzu to use the new version.
jouzu-cli-selfUpdate-alreadyCurrent = Jouzu { $version } is already current.
jouzu-cli-selfUpdate-policySet = Jouzu self-update policy: { $policy }
jouzu-cli-selfUpdate-restarting = Updated Jouzu { $from } → { $to }; restarting…

# Self-update failure and recovery text. An npm command name, an exit
# status or error code, a version, and an npm error message are protected values
# passed as arguments.
jouzu-cli-selfUpdate-unsupportedChannel = automatic installation is available only for a real global npm install; update this source, local, or npx invocation through its owning channel
jouzu-cli-selfUpdate-npmCommandFailed = { $operation } failed ({ $code })
jouzu-cli-selfUpdate-npmCommandExit = { $operation } failed (npm exit { $status })
jouzu-cli-selfUpdate-integrityMismatch = downloaded update failed SHA-512 verification
jouzu-cli-selfUpdate-updateRolledBack = Jouzu { $version } failed verification and { $current } was restored
jouzu-cli-selfUpdate-updateNotInstalled = Jouzu { $version } was not installed; { $current } remains verified
jouzu-cli-selfUpdate-rollbackFailed = Jouzu update and automatic rollback both failed; reinstall the previous Jouzu version with npm
jouzu-cli-selfUpdate-restartFailed = updated Jouzu could not restart: { $message }
jouzu-cli-selfUpdate-invalidPolicy = unknown update policy: { $policy }
jouzu-cli-selfUpdate-updateFailed = Jouzu update failed
jouzu-cli-selfUpdate-checkFailed = update check failed

# Jouzu renderer startup notice, banner labels, help overlay, and the
# first-run profile prompt. A banner hint holds only the label because the
# renderer joins the hints with its own separator; an overlay value keeps the
# two-space alignment as a `{" "}` literal, so the catalog value itself has no
# run of spaces. The startup notice is the same message whether the model
# catalog refresh succeeds or fails; a damaged locale catalog falls back to
# this English text through `resolveCatalog`.

jouzu-cli-presentation-startupNotice = Fetching model catalog…
jouzu-cli-presentation-bannerHint-model = { $command } choose
jouzu-cli-presentation-bannerHint-hotkeys = { $command } shortcuts
jouzu-cli-presentation-bannerHint-status = { $command } session

jouzu-cli-help-overlay-title = Jouzu Help
jouzu-cli-help-overlay-models = { $key }{" "} Models
jouzu-cli-help-overlay-cycleFavorites = { $key }{" "} Cycle favorites
jouzu-cli-help-overlay-help = { $key }{" "} Help
jouzu-cli-help-overlay-allShortcuts = { $command }{" "} All shortcuts
jouzu-cli-help-overlay-sessionDetails = { $command }{" "} Session details
jouzu-cli-help-overlay-runtimeBuilds = { $command }{" "} Runtime and installed builds
jouzu-cli-help-overlay-agentsRuns = { $command }{" "} Agents and runs
jouzu-cli-help-overlay-childDashboard = { $command }{" "} Child run dashboard
jouzu-cli-help-overlay-close = { $key } close
jouzu-cli-help-overlay-shortcutSeparator = {" "}or{" "}
jouzu-cli-help-overlay-shortcutDescription = Open Jouzu help

jouzu-cli-profile-choice-intro = Jouzu can add an optional Japanese-support profile with Japanese-focused instructions and skills.
jouzu-cli-profile-choice-conflict = Existing profile files are checked for conflicts before Jouzu writes anything.
jouzu-cli-profile-choice-question = Enable Japanese support? / 日本語サポートを有効にしますか？ [y/N]

# The remaining pre-launch literals. The doctor field values are status
# and channel words a user reads, so they are text; the report keeps the English
# value and the human renderer resolves the same ID in the active locale. The
# `--json` fields stay English in every locale.

jouzu-cli-doctor-note-isolation = Isolation: stock Pi global config, auth, packages, and sessions are not imported. Project resources and ~/.agents/skills remain shared Pi compatibility surfaces.
jouzu-cli-doctor-value-unavailable = unavailable
jouzu-cli-doctor-value-upstreamSupportStage = The Jouzu-owned UI is available in English and Japanese, and the Jouzu-owned browser adapter renders its tool labels from the Jouzu catalog. The pinned Pi and the third-party bundled extensions render their own English.
jouzu-cli-doctor-value-other = other
jouzu-cli-doctor-value-globalNpmInstall = global npm install
jouzu-cli-doctor-value-localNpmInstall = local npm install
jouzu-cli-doctor-value-npxInstall = npx install
jouzu-cli-doctor-value-sourceCheckout = source checkout
jouzu-cli-doctor-value-complete = complete
jouzu-cli-doctor-value-noActiveCatalog = no active catalog
jouzu-cli-doctor-value-camoufoxNotInstalled = not installed; installs on first browser tool use
jouzu-cli-doctor-value-ready = ready
jouzu-cli-doctor-value-invalid = invalid
jouzu-cli-doctor-value-notFound = not found
jouzu-cli-doctor-value-notSet = not set
jouzu-cli-doctor-value-notDetected = not detected
jouzu-cli-doctor-value-notApplied = not applied
jouzu-cli-doctor-value-never = never
jouzu-cli-doctor-value-notChecked = not checked
jouzu-cli-doctor-value-eligible = eligible
jouzu-cli-doctor-value-notEligible = not eligible
jouzu-cli-doctor-value-none = none
jouzu-cli-doctor-value-unreadable = unreadable
jouzu-cli-doctor-value-absent = absent
jouzu-cli-doctor-value-present = present
jouzu-cli-doctor-value-yes = yes
jouzu-cli-doctor-value-no = no
jouzu-cli-doctor-value-lockFree = free
jouzu-cli-doctor-value-lockHeldLive = held by a live process ({ $age })
jouzu-cli-doctor-value-lockHeldDead = left by a dead process ({ $age }; recoverable after { $recover })
jouzu-cli-doctor-value-lockOwnerUnknown = owner unknown ({ $age }; recoverable after { $recover })
jouzu-cli-doctor-value-lockUnreadable = unreadable (lock inspection failed)
jouzu-cli-doctor-value-lockInvalid = invalid (not a regular lock file)
jouzu-cli-doctor-value-nodeSupported = { $version } (supported)
jouzu-cli-doctor-value-nodeUnsupported = { $version } (unsupported)
jouzu-cli-doctor-value-extensionsReleaseOwned = { $selected } selected; { $ready } ready; { $optional } optional unavailable
jouzu-cli-doctor-value-extensionsReleaseOwnedRequired = { $selected } selected; { $ready } ready; { $optional } optional unavailable; required unavailable
jouzu-cli-doctor-value-skillsPackageOwned = { $selected } selected; { $ready } ready
jouzu-cli-doctor-value-compatibilityDependencies = { $selected } selected
jouzu-cli-doctor-value-catalogRegistration = { $complete } of { $total } offerings can add a model
jouzu-cli-doctor-value-catalogThinkingLevels = { $count } of { $total } offerings without declared levels
jouzu-cli-doctor-value-catalogSource = { $offerings } offerings · { $complete } can add a model · { $levels } without thinking levels
jouzu-cli-doctor-value-modelPicker = { $defaults } project defaults; { $favorites } favorites; { $recents } global recents; { $scopes } project scopes
jouzu-cli-doctor-value-skillsSharedPresent = { $path } (present)
jouzu-cli-doctor-value-skillsSharedAbsent = { $path } (absent)

jouzu-cli-keybindings-portability-ctrlEnter = ctrl+enter requires the terminal to report modified Enter keys through the Kitty keyboard protocol or modifyOtherKeys
jouzu-cli-keybindings-portability-ctrlUp = ctrl+up requires the terminal to report modified arrow keys; tmux users should enable extended-keys with extended-keys-format csi-u
jouzu-cli-keybindings-portability-macMissionControl = macOS may reserve Control+Up for Mission Control until the system shortcut is changed
jouzu-cli-keybindings-portability-termDumb = TERM=dumb cannot provide reliable interactive key events
jouzu-cli-keybindings-status-uninitialized = uninitialized
jouzu-cli-keybindings-status-converged = converged
jouzu-cli-keybindings-status-customized = customized
jouzu-cli-keybindings-policy-applied = applied
jouzu-cli-keybindings-policy-disabled = disabled
jouzu-cli-keybindings-policy-unset = unset
jouzu-cli-keybindings-binding-piDefault = Pi default or unbound
jouzu-cli-keybindings-binding-unbound = unbound
jouzu-cli-keybindings-upgradeRemoved = Jouzu removed its previous { $previous } binding for { $action } because { $desired } is assigned to { $conflictingAction }; run `jz keybindings plan`.
jouzu-cli-keybindings-bootstrapFailed = Jouzu keybinding defaults were not applied: { $message }

jouzu-cli-selfUpdate-report-downloading = Downloading Jouzu { $version }…
jouzu-cli-selfUpdate-report-installing = Installing Jouzu { $version }…
jouzu-cli-selfUpdate-report-restoring = Jouzu { $version } failed verification; restoring { $current }…
jouzu-cli-selfUpdate-report-statusUnrecorded = Jouzu was updated and verified, but its update status could not be recorded.
jouzu-cli-selfUpdate-startup-skipped = Automatic update skipped: { $message }
jouzu-cli-selfUpdate-startup-checkFailed = Jouzu update check failed; continuing with { $current } ({ $code })
jouzu-cli-selfUpdate-startup-available = Jouzu { $version } is available; run "jouzu self-update apply"
jouzu-cli-selfUpdate-startup-failed = Jouzu update failed; continuing with { $current } ({ $code })

jouzu-cli-selfUpdate-policyValue-autoRestart = auto-restart
jouzu-cli-selfUpdate-policyValue-notify = notify
jouzu-cli-selfUpdate-policyValue-off = off
jouzu-cli-selfUpdate-channelValue-globalNpm = global-npm
jouzu-cli-selfUpdate-channelValue-localNpm = local-npm
jouzu-cli-selfUpdate-channelValue-ephemeralNpx = ephemeral-npx
jouzu-cli-selfUpdate-channelValue-source = source
jouzu-cli-selfUpdate-channelValue-other = other

jouzu-cli-usage-pinnedPiSelfUpdate = Jouzu pins its Pi runtime and cannot run Pi self-update. Upgrade Jouzu instead; package-only updates such as `jz update --extensions` remain available.
jouzu-cli-usage-catalogAcceptRevisionDigest = catalog accept requires an exact revision and digest
jouzu-cli-usage-catalogFileRequired = catalog { $operation } requires a file path
jouzu-cli-usage-selfUpdatePolicyValue = self-update policy requires a value

jouzu-cli-runtime-piLoadFailed = Jouzu could not load its pinned Pi runtime: { $diagnostic }
jouzu-cli-runtime-piLoadFailedUnavailable = Jouzu could not load its pinned Pi runtime: unavailable
jouzu-cli-runtime-piPinMismatch = loaded Pi { $loaded } does not match Jouzu's exact pin { $pinned }

jouzu-cli-catalog-fileNotFound = catalog file does not exist: { $path }
jouzu-cli-catalog-fileNotRegular = catalog path must be a regular file: { $path }

jouzu-cli-work-withheldRequest = Withheld request
jouzu-cli-work-outcomeUnknown = Outcome unknown
jouzu-cli-work-jobExit = exit { $code }

# Palette key-bar actions and shared view labels. The key itself is a resolved
# binding injected at render time; only the action label is catalog text.
jouzu-cli-palette-value-unknown = unknown
jouzu-cli-palette-action-refresh = refresh
jouzu-cli-palette-action-favorite = favorite
jouzu-cli-palette-action-compactAndSwitch = compact and switch
jouzu-cli-palette-action-cancel = cancel
jouzu-cli-palette-action-selectAndSaveForProject = select and save for project
jouzu-cli-palette-action-cursor = cursor
jouzu-cli-palette-action-move = move
jouzu-cli-palette-action-section = section
jouzu-cli-palette-action-browse = browse
jouzu-cli-palette-action-search = search
jouzu-cli-palette-action-close = close
jouzu-cli-palette-action-view = View
jouzu-cli-palette-action-edit = edit
jouzu-cli-palette-action-change = change
jouzu-cli-palette-action-toggle = toggle
jouzu-cli-palette-action-back = back
jouzu-cli-palette-action-next = next
jouzu-cli-palette-action-previous = previous
jouzu-cli-palette-action-confirm = confirm
jouzu-cli-palette-action-newline = newline
jouzu-cli-palette-action-returnToForm = return to form

# The Models view.
jouzu-cli-modelPicker-refreshingCatalog = Refreshing model catalog…
jouzu-cli-modelPicker-filterNotSaved = Filter choice was not saved: { $message }
jouzu-cli-modelPicker-modelUnavailable = This model is unavailable. Check its provider or catalog credentials.
jouzu-cli-modelPicker-compactAndSwitch = Compact the active context and switch to { $model }?
jouzu-cli-modelPicker-statePreserved = Unreadable model picker state was preserved at { $path }
jouzu-cli-modelPicker-filter-recent = Recent
jouzu-cli-modelPicker-filter-favorite = Favorite
jouzu-cli-modelPicker-filter-all = All
jouzu-cli-modelPicker-section-current = Current
jouzu-cli-modelPicker-section-previous = Previous
jouzu-cli-modelPicker-section-favorite = Favorite
jouzu-cli-modelPicker-section-project = Project
jouzu-cli-modelPicker-section-recent = Recent
jouzu-cli-modelPicker-section-all = All
jouzu-cli-modelPicker-title-confirm = Confirm
jouzu-cli-modelPicker-title-search = Search
jouzu-cli-modelPicker-detail = { $name } · context { $context } · max { $max }{ $default }
jouzu-cli-modelPicker-projectDefault = project default
jouzu-cli-modelPicker-refreshTimeout = Model refresh timed out; showing cached models.
jouzu-cli-modelPicker-refreshFailed = Model refresh failed; showing cached models: { $detail }
jouzu-cli-modelPicker-catalogRefreshed = Model catalog refreshed.
jouzu-cli-modelPicker-catalogRefreshTimeout = Model catalog refresh timed out; showing cached models.
jouzu-cli-modelPicker-catalogRefreshFailed = Model catalog refresh failed; showing cached models: { $detail }
jouzu-cli-modelPicker-compacting = Compacting before switching to { $model }…
jouzu-cli-modelPicker-selecting = Selecting { $model }…
jouzu-cli-modelPicker-favoriteAdded = Added { $model } to favorites.
jouzu-cli-modelPicker-favoriteRemoved = Removed { $model } from favorites.
jouzu-cli-modelPicker-catalogsNotRefreshed = Catalogs not refreshed: { $sources }. Cached catalog data remains available. Open Catalogs to retry.
jouzu-cli-modelPicker-catalogsWereNotRefreshed = Catalogs were not refreshed: { $message } Cached catalog data remains available. Open Catalogs to retry.
jouzu-cli-modelPicker-modelAvailabilityNotRefreshed = Model availability was not refreshed: { $message } Run /reload.
jouzu-cli-modelPicker-switchQueued = Model switch queued for the next model call: { $model }.
jouzu-cli-modelPicker-thinkingLevelNotApplied = Saved thinking level was not applied: { $message }
jouzu-cli-modelPicker-catalogSettingsRequireTui = Catalog settings require interactive TUI mode.
jouzu-cli-modelPicker-modelsNotRefreshed = Models were not refreshed: { $message } Open Models to retry.
jouzu-cli-modelPicker-providersNotRefreshed = Model providers not refreshed: { $providers }. Open Models to retry.
jouzu-cli-modelPicker-startup-projectDefault = Project default
jouzu-cli-modelPicker-startup-lastUsed = Last used model
jouzu-cli-modelPicker-startup-unavailable = { $label } is unavailable: { $model }
jouzu-cli-modelPicker-startup-notAuthenticated = { $label } is not authenticated: { $model }
jouzu-cli-modelPicker-startup-notApplied = { $label } was not applied: { $message }
jouzu-cli-modelPicker-thinkingLevelNotSaved = Thinking level was not saved: { $message }
jouzu-cli-modelPicker-recencyNotSaved = Model recency was not saved: { $message }
jouzu-cli-modelPicker-switchedTo = Switched to { $model }.
jouzu-cli-modelPicker-queuedSwitchFailed = Queued model switch failed: { $message }
jouzu-cli-modelPicker-modelSelectBinding = the model-select binding
jouzu-cli-modelPicker-favoriteSwitchInProgress = A favorite model switch is already in progress.
jouzu-cli-modelPicker-noFavoriteModelsAdd = No favorite models. Open Models with { $key } and press { $toggle } on a model to add one.
jouzu-cli-modelPicker-noFavoriteModelsAvailable = No favorite models are available in the current model scope.
jouzu-cli-modelPicker-noFavoriteFits = No favorite model can fit the active context. Open Models with { $key } to compact and switch.
jouzu-cli-modelPicker-onlyOneFavorite = Only one favorite model is available.
jouzu-cli-modelPicker-favoriteUnavailable = Favorite model is unavailable: { $model }
jouzu-cli-modelPicker-noAuthentication = No authentication for { $model }
jouzu-cli-modelPicker-favoriteSwitchFailed = Favorite model switch failed: { $message }
jouzu-cli-modelPicker-favoritesUsage = Jouzu uses Favorites for quick switching. Open Models with { $key } and press { $toggle } on a model to favorite it.
# The Models row markers and the picker's empty state, plus the three error
# sentences a `catch` passes to `ctx.ui.notify(…, "error")`. The leading space of
# a row marker is part of the value, written as a `{" "}` literal; a
# provider/model identifier arrives as a protected argument.
jouzu-cli-modelPicker-row-unavailable = {" "}unavailable
jouzu-cli-modelPicker-row-contextSmall = {" "}context-small
jouzu-cli-modelPicker-empty = No matching models
jouzu-cli-modelPicker-catalogDisabled = The selected model catalog is disabled or unavailable. Open Models to select a model.
jouzu-cli-modelPicker-modelUnavailableDetail = Model is unavailable: { $model }
jouzu-cli-modelPicker-noAuthenticationCredential = No authentication for { $model }. Open Catalogs to check its credential.
# The Models view's remaining failure text. A selection callback throws the first
# sentence to the picker's message area, and a refresh callback throws the last
# two as the `{ $detail }` of a refresh failure. Provider/model identifiers are
# protected arguments.
jouzu-cli-modelPicker-waitForActiveCall = Wait for the active model call to finish, then compact and switch.
jouzu-cli-modelPicker-refreshUnavailable = model refresh is unavailable
jouzu-cli-modelPicker-refreshAborted = model refresh was aborted
jouzu-cli-modelPicker-refreshFailedProviders = could not refresh { $providers }
jouzu-cli-modelPicker-modelsNotRefreshedDetail = models were not refreshed: { $message }
jouzu-cli-modelPicker-providersNotRefreshedDetail = model providers were not refreshed: { $providers }
jouzu-cli-modelPicker-catalogsNotRefreshedDetail = catalogs were not refreshed: { $message }
jouzu-cli-modelPicker-catalogIgnored = Cached model catalog was ignored: { $message }
jouzu-cli-modelPicker-runtimeDiagnosticsUnavailable = Runtime diagnostics are unavailable.

# The Workflow view's rows and confirmations.
jouzu-cli-workflow-row-subagents = Subagents
jouzu-cli-workflow-row-concurrency = Concurrency
jouzu-cli-workflow-row-childWriters = Child writers
jouzu-cli-workflow-row-addAgent = + Add agent
jouzu-cli-workflow-row-roleId = Role ID
jouzu-cli-workflow-row-description = Description
jouzu-cli-workflow-row-model = Model
jouzu-cli-workflow-row-placement = Placement
jouzu-cli-workflow-row-reviewOnly = Review only
jouzu-cli-workflow-row-childTools = Child tools
jouzu-cli-workflow-row-thinking = Thinking
jouzu-cli-workflow-row-timeoutSeconds = Timeout (seconds)
jouzu-cli-workflow-row-maximumTurns = Maximum turns
jouzu-cli-workflow-row-instructions = Instructions
jouzu-cli-workflow-row-save = Save
jouzu-cli-workflow-row-useInMainSession = Use in main session
jouzu-cli-workflow-row-launchAgent = Launch agent…
jouzu-cli-workflow-row-duplicateAsNewAgent = Duplicate as new agent
jouzu-cli-workflow-row-deleteDefinition = Delete definition…
jouzu-cli-workflow-row-deleteConfirm = Delete { $agent }? Existing runs remain.
jouzu-cli-workflow-row-cancel = Cancel
jouzu-cli-workflow-row-sameAsThisSession = Same as this session
jouzu-cli-workflow-row-assignment = Assignment
jouzu-cli-workflow-row-workspace = Workspace
jouzu-cli-workflow-row-readOutput = Read output
jouzu-cli-workflow-row-sendMessage = Send a message…
jouzu-cli-workflow-row-stopAgent = Stop agent…
jouzu-cli-workflow-row-stopConfirm = Stop { $agent }? Changes already made remain.
jouzu-cli-workflow-row-resumeWithTask = Resume with a task…
jouzu-cli-workflow-row-backToRuns = Back to runs
jouzu-cli-workflow-confirm-disableSubagents = Disable subagents and stop all queued and running children in this session? Changes already made remain.

# The rest of the Workflow view's display: the stage suffixes, the section and
# group headings, the field values, and the panel's status and error text. The
# mode and section values (`browse`, `agents`, `runs`, `parallel`) are internal
# identities that stay in code; only the display word is catalog text. Counts
# and resolved bindings are passed as arguments.
jouzu-cli-workflow-stage-editAgent = Edit agent
jouzu-cli-workflow-stage-chooseModel = Choose model
jouzu-cli-workflow-stage-run = Run
jouzu-cli-workflow-stage-output = Output
jouzu-cli-workflow-stage-confirm = Confirm
jouzu-cli-workflow-stage-editAssignment = Edit assignment
jouzu-cli-workflow-stage-editInstructions = Edit instructions
jouzu-cli-workflow-label-agents = Agents
jouzu-cli-workflow-label-runs = Runs
jouzu-cli-workflow-label-definition = Definition
jouzu-cli-workflow-label-setting = Setting
jouzu-cli-workflow-label-actions = Actions
jouzu-cli-workflow-label-models = Models
jouzu-cli-workflow-label-task = Task
jouzu-cli-workflow-value-on = On
jouzu-cli-workflow-value-off = Off
jouzu-cli-workflow-value-yes = Yes
jouzu-cli-workflow-value-no = No
jouzu-cli-workflow-value-inParallel = In parallel
jouzu-cli-workflow-value-oneAtATime = One at a time
jouzu-cli-workflow-value-characters = { $count } characters
jouzu-cli-workflow-value-writeTask = Write a task
jouzu-cli-workflow-value-unavailableSubagentsOff = Unavailable: subagents off
jouzu-cli-workflow-value-costUnknown = cost unknown
jouzu-cli-workflow-meta-thisSession = this session
jouzu-cli-workflow-meta-inSession = in session
jouzu-cli-workflow-headingMeta-defined = { $count } defined
jouzu-cli-workflow-headingMeta-runs = { $active ->
    [0] { $count } in session
   *[other] { $active } running · { $count } in session
}
jouzu-cli-workflow-headingMeta-followsSessionModel = follows the session model
jouzu-cli-workflow-headingMeta-more = more
jouzu-cli-workflow-action-enablingSubagents = Enabling subagents
jouzu-cli-workflow-action-disablingSubagents = Disabling subagents
jouzu-cli-workflow-action-launchAgent = Launch agent
jouzu-cli-workflow-action-sendMessage = Send message
jouzu-cli-workflow-action-resumeAgent = Resume agent
jouzu-cli-workflow-message-operationFailed = Operation failed.
jouzu-cli-workflow-message-operationFailedRetry = Operation failed. Retry.
jouzu-cli-workflow-message-couldNotLoad = Could not load Workflow.
jouzu-cli-workflow-message-childWritersParallel = Child writers may share a workspace; concurrent edits to the same files can conflict.
jouzu-cli-workflow-message-childWritersSerial = Child writers run one at a time per workspace.
jouzu-cli-workflow-hint-editAgent = edit agent
jouzu-cli-workflow-hint-inspectRun = inspect run
jouzu-cli-workflow-empty-noMatchingModels = No matching models. Edit the search.
jouzu-cli-workflow-empty-noChildRuns = No child runs in this session.

# The Workflow text that issue #53 moved off the `perform`, `openText`, and
# `detail` APIs. Those parameters take a catalog ID, so a literal sentence no
# longer type-checks at the call site. The run status and the context mode are
# protected values passed as arguments.
jouzu-cli-workflow-error-formUnavailable = Workflow form is unavailable. Cancel and reopen it.
jouzu-cli-workflow-error-saveOrCancelEdits = Save or cancel your edits before using this definition.
jouzu-cli-workflow-error-subagentsOff = Subagents are off. Enable them in Workflow before assigning work.
jouzu-cli-workflow-error-runNotFound = Agent run was not found.
jouzu-cli-workflow-error-writeAssignment = Write an assignment before sending it.
jouzu-cli-workflow-message-running = { $label }…
jouzu-cli-workflow-message-complete = { $label } complete.
jouzu-cli-workflow-message-saved = Saved { $agent }.
jouzu-cli-workflow-message-concurrencySet = Concurrency set to { $value }.
jouzu-cli-workflow-title = · Workflow{ $stage }
jouzu-cli-workflow-title-busy = · Busy
jouzu-cli-workflow-hint-saveInForm = Changes are saved only with Save in the form.
jouzu-cli-workflow-stage-editWorkspace = Edit workspace
jouzu-cli-workflow-action-applyingAgent = Applying agent
jouzu-cli-workflow-action-sendingTask = Sending task
jouzu-cli-workflow-action-stoppingAgent = Stopping agent
jouzu-cli-workflow-field-agent = Agent
jouzu-cli-workflow-field-model = Model
jouzu-cli-workflow-field-workspace = Workspace
jouzu-cli-workflow-field-context = Context
jouzu-cli-workflow-field-context-lookupOn = { $mode } · parent lookup on
jouzu-cli-workflow-field-context-lookupOff = { $mode } · parent lookup off
jouzu-cli-workflow-field-modelId = Model ID
jouzu-cli-workflow-field-usage = Usage
jouzu-cli-workflow-field-result = Result

# The TextGuard review view's other-list hints. The command name is a protected
# value passed as an argument, not catalog text.
jouzu-cli-textguard-otherView-decisions = items need a decision · { $command }
jouzu-cli-textguard-otherView-reports = findings did not block content · { $command }
# The rest of the TextGuard review overlay: the decision actions, the mode
# confirmations, the severity and verdict lines, and the notification and
# approval sentences. The `/textguard` command, the finding kinds, and the
# severity values are protected values passed as arguments, never catalog text.
jouzu-cli-textguard-action-allowSession = Allow for this session
jouzu-cli-textguard-action-allowAlways = Always allow this exact content
jouzu-cli-textguard-action-dismiss = Dismiss report
jouzu-cli-textguard-action-enable = Turn scanning back on
jouzu-cli-textguard-action-back = Back
jouzu-cli-textguard-mode-guarded = TextGuard scans again. Flagged web results reach the model labelled as untrusted data; flagged skills stay withheld until you approve them.
jouzu-cli-textguard-mode-strict = TextGuard now withholds every flagged input until you approve it with { $command }.
jouzu-cli-textguard-mode-off = TextGuard is off for this session. Content is admitted unscanned until you run { $command }.
jouzu-cli-textguard-banner-strict = strict mode — every flagged input is withheld
jouzu-cli-textguard-banner-off = scanning off for this session
jouzu-cli-textguard-severity-error = Error (blocks this content)
jouzu-cli-textguard-severity-warn = Warning
jouzu-cli-textguard-severity-info = Information
jouzu-cli-textguard-finding-line = { $severity }: { $name }{ $codepoint }.
jouzu-cli-textguard-finding-locatedLine = { $severity }: { $name }{ $codepoint } at { $location }.
jouzu-cli-textguard-counts-noErrors = No errors
jouzu-cli-textguard-counts-blocking = { $count ->
    [one] { $count } error that blocks this content until you approve it
   *[other] { $count } errors that block this content until you approve it
}
jouzu-cli-textguard-counts-delivered = { $count ->
    [one] { $count } error-level finding; the content reached the model labelled as untrusted data
   *[other] { $count } error-level findings; the content reached the model labelled as untrusted data
}
jouzu-cli-textguard-counts-warning = { $count ->
    [one] { $count } warning
   *[other] { $count } warnings
}
jouzu-cli-textguard-counts-informational = { $count ->
    [one] { $count } informational finding
   *[other] { $count } informational findings
}
jouzu-cli-textguard-counts-nonBlockingBoth = { $blocking }; { $warnings } and { $notes } do not block it.
jouzu-cli-textguard-counts-nonBlockingWarnings = { $blocking }; { $warnings } do not block it.
jouzu-cli-textguard-counts-nonBlockingNotes = { $blocking }; { $notes } do not block it.
jouzu-cli-textguard-evidence-withheld = This content stays withheld unless you approve it.
jouzu-cli-textguard-evidence-delivered = The content reached the model labelled as untrusted data.
# The reason an incomplete check did not finish. The user reads these in the
# review overlay and the alert detail; the model reads a separate fixed English
# copy in the withheld-result tool result, so this block is the user-facing half.
jouzu-cli-textguard-unavailable-inputLimit = the content is larger than TextGuard can scan
jouzu-cli-textguard-unavailable-unsupportedContent = part of the content is something the scanner cannot check, such as an image
jouzu-cli-textguard-unavailable-findingLimit = there were too many findings to report completely
jouzu-cli-textguard-unavailable-decodeLimit = the content has too many encoded layers to decode completely
jouzu-cli-textguard-unavailable-outputLimit = the scanner produced too much output
jouzu-cli-textguard-unavailable-scanner = the scanner could not run
jouzu-cli-textguard-unavailable-timeout = the scan ran out of time
jouzu-cli-textguard-unavailable-process = the scanner stopped unexpectedly
jouzu-cli-textguard-unavailable-version = the installed scanner version is not supported
jouzu-cli-textguard-unavailable-protocol = the scanner returned an unreadable result
jouzu-cli-textguard-unavailable-busy = the scanner was busy with other work
jouzu-cli-textguard-unavailable-closed = the review session ended
jouzu-cli-textguard-unavailable-file = the content could not be read
jouzu-cli-textguard-unavailable-budget = the time reserved for scanning ran out
jouzu-cli-textguard-evidence-unavailable = The check did not finish: { $reason }.
# The alert detail a user reads: the same summary the model banner carries, but
# resolved from the catalog so it can localize.
jouzu-cli-textguard-detail-errors = { $count ->
    [one] { $count } error-level finding
   *[other] { $count } error-level findings
}
jouzu-cli-textguard-detail-errorsWithKinds = { $count ->
    [one] { $count } error-level finding ({ $kinds })
   *[other] { $count } error-level findings ({ $kinds })
}
jouzu-cli-textguard-detail-warnings = { $count ->
    [one] { $count } warning
   *[other] { $count } warnings
}
jouzu-cli-textguard-detail-none = no findings
jouzu-cli-textguard-detail-unavailable = the check did not finish: { $reason }
jouzu-cli-textguard-detail-withheld = TextGuard review — withheld content
jouzu-cli-textguard-detail-delivered = TextGuard review — delivered with findings
jouzu-cli-textguard-detail-report = TextGuard review — scan report
jouzu-cli-textguard-alert-advisoryReport = ; { $command } shows the report
jouzu-cli-textguard-alert-approveInteractive = Run { $command } to review and approve it.
jouzu-cli-textguard-alert-approveNonInteractive = Approve it with { $command } in an interactive session.
jouzu-cli-textguard-alert-notApprovable = This content cannot be approved; retry the request.
jouzu-cli-textguard-review-pending = Use { $command } to review.
jouzu-cli-textguard-review-pendingNonInteractive = Content stays withheld. Review with { $command } in an interactive session.
jouzu-cli-textguard-review-nothing = TextGuard has nothing waiting for a decision.{ $extra }
jouzu-cli-textguard-review-incomplete = TextGuard could not identify the complete content. Retry the request; this content cannot be approved.{ $extra }
jouzu-cli-textguard-review-blockedNothing = { $count ->
    [one] { $count } finding did not block content; see { $command }.
   *[other] { $count } findings did not block content; see { $command }.
}
jouzu-cli-textguard-approved-persisted = Content approved. Future sessions admit these exact bytes; any change requires a new review. Resources will reload.
jouzu-cli-textguard-approved-session = Content approved for this session. Retry the request after resources reload.
# The TextGuard notification sentences the local `notify` helper shows. The
# `/textguard` and `/reload` command names and the mode values are protected
# values, so they stay as written; the finding source and the already-resolved
# report or approval sentence arrive as arguments.
jouzu-cli-textguard-commandUsage = Use /textguard to review findings, /textguard reports for findings that did not block anything, or /textguard on, strict, or off to set scanning.
jouzu-cli-textguard-mode-alreadySet = TextGuard is already set to { $mode }.
jouzu-cli-textguard-review-pendingSummary = TextGuard: { $count } { $count ->
    [one] item
   *[other] items
} waiting for your review. { $advice }
jouzu-cli-textguard-review-requiresTerminal = TextGuard review requires an interactive terminal. Content stays withheld.
jouzu-cli-textguard-review-requiresSize = TextGuard review requires at least 48 columns and 24 rows. Resize the terminal and retry /textguard.
jouzu-cli-textguard-review-unavailable = TextGuard review is unavailable for this session. Content stays withheld.
jouzu-cli-textguard-reports-empty = TextGuard has no findings to show for content that was not blocked.
jouzu-cli-textguard-terminalResized = Terminal size changed. Content stays withheld; resize and retry /textguard.
jouzu-cli-textguard-review-expired = This TextGuard review expired. Run /textguard again.
jouzu-cli-textguard-reloadFailed = TextGuard changed, but resources could not reload. Run /reload before retrying.
jouzu-cli-textguard-approved-reloadFailed = Content approved, but resources could not reload. Run /reload before retrying.
# The two alert frames a local helper returns. The source, the evidence detail,
# and the resolved report or approval sentence are protected values passed as
# arguments. A helper's returned template is not a detector position, so this
# prose moves onto the catalog without a shape reporting it.
jouzu-cli-textguard-alert-flagged = TextGuard flagged { $source }: { $detail }. The content reached the model labelled as untrusted data{ $report }.
jouzu-cli-textguard-alert-withheld = TextGuard withheld { $source }: { $detail }.{ $next }
# The finding kinds and their explanations the review overlay renders. The kind
# identifier (`bidi_control`, a `yara:` rule, or another scanner token) is a
# protected value passed as an argument; these names and explanations are the
# human text the review view shows.
jouzu-cli-textguard-kind-bidiControl = bidi control character
jouzu-cli-textguard-kind-bidiControl-explanation = This character can reverse the order in which text is displayed, so what you read can differ from what is processed.
jouzu-cli-textguard-kind-ansiEscape = terminal escape sequence
jouzu-cli-textguard-kind-ansiEscape-explanation = This sequence can change terminal colors or hide text on screen.
jouzu-cli-textguard-kind-invisibleChar = invisible character
jouzu-cli-textguard-kind-invisibleChar-explanation = This character changes the text without appearing on screen.
jouzu-cli-textguard-kind-combiningAbuse = stacked combining marks
jouzu-cli-textguard-kind-combiningAbuse-explanation = Stacked accent characters can disguise what a letter really is.
jouzu-cli-textguard-kind-softHyphen = soft hyphen
jouzu-cli-textguard-kind-softHyphen-explanation = This invisible character can split words to evade exact matching.
jouzu-cli-textguard-kind-tagCharacter = Unicode tag character
jouzu-cli-textguard-kind-tagCharacter-explanation = Tag characters can hide extra text inside ordinary-looking content.
jouzu-cli-textguard-kind-variationSelector = variation selector
jouzu-cli-textguard-kind-variationSelector-explanation = This invisible character can change how the character next to it renders.
jouzu-cli-textguard-kind-splitToken = split keyword
jouzu-cli-textguard-kind-splitToken-explanation = A protected keyword such as "system" or "instructions" appears split by separator characters, a common way to hide prompt injection.
jouzu-cli-textguard-kind-decoded = encoded text
jouzu-cli-textguard-kind-decoded-explanation = Part of the content was stored in an encoded form and was decoded before scanning.
jouzu-cli-textguard-kind-normalized = normalization change
jouzu-cli-textguard-kind-normalized-explanation = Part of the content was rewritten during normalization before scanning.
jouzu-cli-textguard-kind-stripped = removed characters
jouzu-cli-textguard-kind-stripped-explanation = Part of the content was removed during normalization before scanning.
jouzu-cli-textguard-kind-bundledRule = bundled detection rule ({ $rule }) match
jouzu-cli-textguard-kind-bundledRule-explanation = A bundled detection rule matched a pattern associated with attacks; the rule does not know whether this content is malicious.
jouzu-cli-textguard-kind-flaggedPattern = flagged pattern { $kind }
jouzu-cli-textguard-kind-flaggedPattern-explanation = The scanner matched a pattern it considers suspicious.
# A finding location. The offset, line, and column are protected numbers passed
# as arguments.
jouzu-cli-textguard-location-character = character { $offset } of the content, counting from 0
jouzu-cli-textguard-location-line = line { $line }, column { $column }
# The review body lines: the source label, the content fingerprint, the heading
# over the escaped body, and the closing risk notice. The source and the digest
# are protected values passed as arguments.
jouzu-cli-textguard-review-source = Source: { $source }
jouzu-cli-textguard-review-fingerprint = Content fingerprint (SHA-256): { $digest }
jouzu-cli-textguard-review-notRetained = The flagged content itself is not retained for viewing here.
jouzu-cli-textguard-review-flaggedHeading = Flagged content (controls and invisible characters shown as escapes):
jouzu-cli-textguard-review-riskNotice = Scans reduce risk but cannot prove content is safe. You decide whether to allow it.
jouzu-cli-textguard-review-findingsTruncated = Showing the first { $shown } of { $total } findings.
# The simple counts verdict when nothing else needs naming; the blocking clause
# is a resolved catalog value, and the trailing period is part of this message
# so the Japanese sentence can end with its own punctuation.
jouzu-cli-textguard-counts-line = { $blocking }.
# The review overlay chrome. The resolved keybinding hints and the view counts
# arrive as arguments; the status words are padded to a fixed width by the
# renderer, not in the catalog value.
jouzu-cli-textguard-off-title = TextGuard — scanning off for this session
jouzu-cli-textguard-off-body = Content is admitted unscanned. Skills and web results are not checked.
jouzu-cli-textguard-hint-select = { $keys } select
jouzu-cli-textguard-hint-open = { $keys } open
jouzu-cli-textguard-hint-close = { $keys } close
jouzu-cli-textguard-hint-action = { $keys } action
jouzu-cli-textguard-hint-scroll = { $keys } scroll
jouzu-cli-textguard-hint-back = { $keys } back
jouzu-cli-textguard-list-header = TextGuard review
jouzu-cli-textguard-list-summary = { $withheld } withheld · { $delivered } delivered
jouzu-cli-textguard-status-withheld = Withheld
jouzu-cli-textguard-status-delivered = Delivered
jouzu-cli-textguard-status-report = Report
jouzu-cli-textguard-list-progress = ({ $current }/{ $total })
jouzu-cli-textguard-list-notices = { $count ->
    [one] { $count } check could not identify the complete content; that content cannot be approved.
   *[other] { $count } checks could not identify the complete content; that content cannot be approved.
}
jouzu-cli-textguard-detail-progress = (lines { $start }-{ $end } of { $total })
# The `/textguard` command description the host shows in its command list.
jouzu-cli-textguard-commandDescription = Review TextGuard findings, or set scanning to on, strict, or off
# Settings view. A key-hint label is a short word in a narrow column; a row
# label is the identity column; a message is the panel's status or confirmation
# text. Resolved keybindings and key names arrive as arguments.
jouzu-cli-settings-hint-save = save
jouzu-cli-settings-hint-field = field
jouzu-cli-settings-hint-changeAuthentication = change Authentication
jouzu-cli-settings-hint-cancel = cancel
jouzu-cli-settings-hint-remove = remove
jouzu-cli-settings-hint-signOut = sign out
jouzu-cli-settings-hint-move = move
jouzu-cli-settings-hint-dashboard = dashboard
jouzu-cli-settings-hint-section = section
jouzu-cli-settings-hint-close = close
jouzu-cli-settings-hint-connect = connect
jouzu-cli-settings-hint-changeView = change view
jouzu-cli-settings-hint-view = view
jouzu-cli-settings-hint-autoLabels = auto labels
jouzu-cli-settings-hint-displayMode = display mode
jouzu-cli-settings-hint-contextLimit = context limit
jouzu-cli-settings-hint-edit = edit
jouzu-cli-settings-hint-add = add
jouzu-cli-settings-hint-refresh = refresh
jouzu-cli-settings-hint-enable = enable
jouzu-cli-settings-hint-models = models

jouzu-cli-settings-label-account = Shisa AI
jouzu-cli-settings-label-contextLimit = Maximum context
jouzu-cli-settings-label-dashboard = Dashboard
jouzu-cli-settings-label-autoLabels = Auto labels
jouzu-cli-settings-label-view = View
jouzu-cli-settings-offeringRow = { $provider }/{ $model }

jouzu-cli-settings-loadFailed = Catalog settings could not be loaded: { $message }
jouzu-cli-settings-savedTokensUnreadable = Saved tokens could not be read: { $message }
jouzu-cli-settings-saving = Saving catalog…
jouzu-cli-settings-savedWithNotes = { $base } { $notes }
jouzu-cli-settings-saveCanceled = Catalog save canceled.
jouzu-cli-settings-refreshing = Refreshing { $label }…
jouzu-cli-settings-contextLimitNotApplied = Context limit was not applied: { $message }. Models use their declared windows.
jouzu-cli-settings-contextLimitNotSaved = Context limit was not saved: { $message }
jouzu-cli-settings-autoLabelsSaved = Global auto labels saved: { $state ->
    [on] on
   *[off] off
}. Session off and pane pins remain respected.
jouzu-cli-settings-autoLabelsNotSaved = Auto labels were not saved: { $message }
jouzu-cli-settings-dashboardSaved = Dashboard display saved: { $mode }.
jouzu-cli-settings-dashboardNotSaved = Dashboard display was not saved: { $message }
jouzu-cli-settings-signOutConfirm = Press { $confirm } to sign out of Shisa on this device; { $cancel } cancels. Saved catalogs and voice stop using this account.
jouzu-cli-settings-removed = Removed { $label }.
jouzu-cli-settings-builtInSource = { $label } is a built-in Jouzu catalog source. { $key } enables or disables it; its endpoint and credential reference stay managed.
jouzu-cli-settings-builtInCannotRemove = { $label } is built in and cannot be removed. { $key } disables it.
jouzu-cli-settings-removeConfirm = Press { $confirm } to remove this catalog source; { $cancel } cancels.
jouzu-cli-settings-sourceToggled = { $label } { $state ->
    [enabled] enabled
   *[disabled] disabled
}.
jouzu-cli-settings-loginHint = Run /login shisa to connect this account.
jouzu-cli-settings-signOutFailed = Shisa sign-out could not complete. Wait for any sign-in or sign-out to finish, then retry.
jouzu-cli-settings-field-label = Label
jouzu-cli-settings-field-url = URL or host
jouzu-cli-settings-field-auth = Authentication
jouzu-cli-settings-auth-none = None
jouzu-cli-settings-auth-bearer = Bearer token
jouzu-cli-settings-field-credential = Token variable
jouzu-cli-settings-field-token = Token
jouzu-cli-settings-refresh-upToDate = Catalog is up to date.
jouzu-cli-settings-refresh-status = Catalog { $status }.
jouzu-cli-settings-hint-scroll = scroll

# Settings panel text that a conditional expression used to hold. The state
# words (credential, auto labels) are select variants keyed by an internal
# value; the view names stay English as Palette product nouns, by the owner
# decision.
jouzu-cli-settings-warning = Warning: { $message }
jouzu-cli-settings-savedQuarantined = Saved { $label }. Catalog revision quarantined: { $reasons }.
jouzu-cli-settings-savedWithCount = { $count ->
    [one] Saved { $label } with { $count } model.
   *[other] Saved { $label } with { $count } models.
}
jouzu-cli-settings-modelCount = { $count ->
    [one] { $count } model
   *[other] { $count } models
}
jouzu-cli-settings-savedWithoutCheck = Saved { $label } without checking the catalog.
jouzu-cli-settings-contextLimitOff = Context limit off. Models use their declared windows.
jouzu-cli-settings-contextLimitSet = Context limit { $limit } tokens. Models above it report { $limit } and compact sooner.
jouzu-cli-settings-dashboardOpened = Opened the Shisa dashboard: { $url }
jouzu-cli-settings-dashboardAddress = Shisa dashboard: { $url }
jouzu-cli-settings-form-addHeading = Add catalog
jouzu-cli-settings-form-editHeading = Edit { $label }
jouzu-cli-settings-credential-availability = { $name } { $state ->
    [set] is set in this Jouzu process.
    [saved] is not set; the saved token will be used in this Jouzu process.
   *[unset] is not set in this Jouzu process.
}
jouzu-cli-settings-credential-login = · Shisa login in use
jouzu-cli-settings-credential-state = · { $name } { $state ->
    [set] set
    [stored] not set, saved token in use
   *[unset] not set
}
jouzu-cli-settings-account-connectedDetail = Connected · { $detail }
jouzu-cli-settings-account-connected = Connected
jouzu-cli-settings-account-connectMeta = { $key } connects
jouzu-cli-settings-signIn-couldNotComplete = Shisa sign-in could not complete. Retry from this row or run /login shisa.
jouzu-cli-settings-autoLabelsState = { $state ->
    [error] Off (settings error)
    [on] On
   *[off] Off
}
jouzu-cli-settings-view-about = About
jouzu-cli-settings-view-catalogs = Catalogs
# Settings Language view. Three items show the effective value and the source
# that supplied it. A source token (cli, env, config, os, session, project,
# task, builtin) and a preview marker arrive as arguments or protected values.
jouzu-cli-settings-view-language = Language
jouzu-cli-settings-heading-language = Language
jouzu-cli-settings-label-displayLanguage = Display language
jouzu-cli-settings-label-responseLanguage = Response language
jouzu-cli-settings-label-artifactPolicy = Artifact policy
jouzu-cli-settings-hint-language = change
jouzu-cli-settings-hint-cancelPreview = cancel preview
jouzu-cli-settings-language-sourcePreview = preview
jouzu-cli-settings-language-previewNotice = Preview · not saved. { $cancel } cancels.
jouzu-cli-settings-language-previewCanceled = Preview canceled. Nothing was saved.
# The first-run language choice. Each language is listed by its own name so a
# user who picked the wrong language can find the way back. The self-names are
# the same in every catalog on purpose.
jouzu-cli-language-self-en = English
jouzu-cli-language-self-ja = 日本語
jouzu-cli-language-self-zhHans = 简体中文
jouzu-cli-language-self-zhHant = 繁體中文
jouzu-cli-language-auto = Automatic
jouzu-cli-language-choice-intro = Choose the interface language for Jouzu. Each language is listed by its own name.
jouzu-cli-language-choice-unavailable = not available in this build
jouzu-cli-language-choice-suggested = suggested
jouzu-cli-language-choice-question = Interface language (number, name, or Enter to skip)
jouzu-cli-language-choice-responseIntro = Choose the language Jouzu writes replies in. It can differ from the interface language.
jouzu-cli-language-choice-responseQuestion = Response language (number, name, or Enter to accept the interface language)
jouzu-cli-language-choice-invalid = Not a listed language: { $value }
jouzu-cli-language-choice-notShipped = The interface is not available in { $language } in this build.
jouzu-cli-language-choice-saveFailed = The language choice could not be saved: { $message }
jouzu-cli-language-choice-skipped = No language chosen. Jouzu will ask again next time.

# The reversible Japanese-profile migration. The plan's profile,
# source, response-language, and asset values, the diff lines, and the backup
# path are protected values passed as arguments; the sentences live here.
jouzu-cli-profileMigration-title = Jouzu profile migration plan
jouzu-cli-profileMigration-section = Migration
jouzu-cli-profileMigration-field-from = From
jouzu-cli-profileMigration-field-to = To
jouzu-cli-profileMigration-fromValue = { $profile } ({ $source })
jouzu-cli-profileMigration-toValue = response language { $responseLanguage }; display language { $uiLocale }
jouzu-cli-profileMigration-assets = Assets
jouzu-cli-profileMigration-conflicts = Conflicts
jouzu-cli-profileMigration-assetDeduplicate = remove the duplicated language instruction because the response language now supplies it
jouzu-cli-profileMigration-assetPreserve = keep the edited file and review the duplicated lines
jouzu-cli-profileMigration-assetReplace = remove the distribution-managed language instruction
jouzu-cli-profileMigration-diffKind = { $kind ->
    [remove] remove
   *[keep] keep
}
jouzu-cli-profileMigration-resolution-keepEdits = Resolve the duplicate by removing the repeated lines yourself, or re-apply the profile.
jouzu-cli-profileMigration-resolution-reapplyProfile = Re-apply the profile to restore the distribution-managed file.
jouzu-cli-profileMigration-temporary = The profile choice is temporary; the user-wide settings are not changed.
jouzu-cli-profileMigration-conflict = profile migration plan contains conflicts

# The Settings text that issue #53 moved off the plain-`string` seams: the
# token warning and save notes, the account row, the section heading, the empty
# states, the title, and the sign-in reports. The sign-in `report` closure takes
# a catalog ID, so a literal sentence no longer type-checks there.
jouzu-cli-settings-warning-tokenNotSet = Warning: token variable { $name } is not set and no token is saved for this source. Set it or save a token, then refresh.
jouzu-cli-settings-note-tokenNotSet = Token variable { $name } is not set and no token is saved; set it or save a token, then press R to refresh.
jouzu-cli-settings-note-tokenPrecedence = { $name } is set in this Jouzu process and takes precedence over the saved token.
jouzu-cli-settings-account-notConnected = Not connected
jouzu-cli-settings-heading-modelCatalogs = Model Catalogs
jouzu-cli-settings-empty-noSources = No catalog sources configured.
jouzu-cli-settings-empty-noOfferings = No cached model offerings.
jouzu-cli-settings-title = · Settings / { $view }
jouzu-cli-settings-signIn-requestingCode = Requesting a Shisa device code. { $cancel } cancels.
jouzu-cli-settings-signIn-deviceCode = Open { $uri } and enter code { $code } to approve this device. { $cancel } cancels.
jouzu-cli-settings-signIn-unexpectedPrompt = Unexpected Shisa sign-in prompt.
jouzu-cli-settings-signIn-connected = Connected to Shisa AI.

# The voice surface. The recording widget's state word and key hint, the
# microphone picker, the command notices, and the reviewed capture and transport
# diagnostics. The internal voice state values, the `/voice` subcommand names,
# and the `[garbled]` marker are protected values, never catalog text; the state
# word is a select variant keyed by the internal value.
jouzu-cli-voice-label = Voice
jouzu-cli-voice-state-connecting = Voice: connecting…
jouzu-cli-voice-state-recording = Voice: recording
jouzu-cli-voice-state-finishing = Voice: finishing transcription…
jouzu-cli-voice-hint-recording = /voice stop to insert · /voice cancel to discard
jouzu-cli-voice-hint-idle = /voice cancel to discard
jouzu-cli-voice-segment-final = Final
jouzu-cli-voice-segment-pending = Pending
jouzu-cli-voice-segment-live = Live
jouzu-cli-voice-segment-failed = Failed
jouzu-cli-voice-segment-progress = { $finalized } finalized · { $pending } awaiting final · { $failed } failed
jouzu-cli-voice-segment-retained = { $count } earlier chunks retained
jouzu-cli-voice-status = Voice: { $state ->
   *[starting] starting
    [recording] recording
    [finishing] finishing
}
jouzu-cli-voice-devices-default = Default microphone
jouzu-cli-voice-devices-title = Voice microphone (this machine)
jouzu-cli-voice-inserted-garbled = Voice text inserted with [garbled] for missing speech. Edit the prompt, then press Enter to send.
jouzu-cli-voice-inserted = Voice text inserted. Review it, then press Enter to send.
jouzu-cli-voice-noSpeech = No speech was transcribed. Your prompt is unchanged.
jouzu-cli-voice-finishFailed = Voice could not finish. Your prompt is unchanged; try recording again.
jouzu-cli-voice-stillFinishing = Voice is still preparing or finishing. Use /voice cancel to discard it.
jouzu-cli-voice-alreadyActive = Voice is already active. Stop or cancel it first.
jouzu-cli-voice-signedOut = Signed out of Shisa. Run /login shisa before using /voice.
jouzu-cli-voice-requiresLogin = Voice requires a Shisa login or SHISA_API_KEY. Run /login shisa or set SHISA_API_KEY.
jouzu-cli-voice-endpointInvalid = The saved Shisa voice endpoint is invalid. Run /login shisa again.
jouzu-cli-voice-startFailed = Voice could not start. Check your microphone, network, and Shisa access.
jouzu-cli-voice-nonInteractive = Voice input requires an interactive terminal on the machine with the microphone.
jouzu-cli-voice-cancelled = Voice cancelled. Your prompt is unchanged.
jouzu-cli-voice-devicesBusy = Stop or cancel voice before choosing a microphone.
jouzu-cli-voice-devicesFailed = Could not list microphones. Check audio device and platform support.
jouzu-cli-voice-languageBusy = Stop or cancel voice before changing language.
jouzu-cli-voice-languageSet = Voice language: { $language }.
jouzu-cli-voice-usage = Use /voice [start|stop|cancel|devices|language auto|language ja|language en|language zh].
jouzu-cli-voice-captureFailed = Microphone capture failed. Check your input device, microphone permission, and platform support.
jouzu-cli-voice-captureStartTimeout = Microphone startup timed out. Check your audio device.
jouzu-cli-voice-captureStopTimeout = Microphone did not respond to stop. Recording was cancelled.
jouzu-cli-voice-uploadSlow = Voice network upload is too slow. Check your connection and try again.
jouzu-cli-voice-uploadFailed = Voice network upload failed. Check your connection and try again.
jouzu-cli-voice-authFailed = Voice authentication failed. Run /login shisa again or check SHISA_API_KEY.
jouzu-cli-voice-accessDenied = Voice access denied. Your Shisa key needs shisa/asr-realtime access.
jouzu-cli-voice-connectionRejected = Voice connection was rejected. Check service availability and try again.
jouzu-cli-voice-connectionFailed = Voice connection failed. Check your network and Shisa access.
jouzu-cli-voice-transcriptionFailed = Voice transcription failed. Check Shisa service access and try again.
jouzu-cli-voice-transcriptInvalid = Voice returned an invalid or oversized transcript. Try a shorter recording.
jouzu-cli-voice-connectionEnded = Voice connection ended before transcription finished. Try recording again.
jouzu-cli-voice-connectionStartFailed = Voice connection could not start. Try again.
jouzu-cli-voice-transcriptInvalidIdentifier = Voice returned an invalid segment identifier.
jouzu-cli-voice-transcriptInvalidAudioRange = Voice returned an invalid audio range.
jouzu-cli-voice-transcriptInvalidReplacementRange = Voice returned an invalid replacement range.
jouzu-cli-voice-transcriptTooLarge = Voice transcription reached its text or segment limit. Record a shorter passage.
jouzu-cli-voice-commandDescription = Dictate into the prompt; start, stop, cancel, or configure voice
jouzu-cli-voice-shortcutDescription = Start or stop voice dictation
# The shisa-link authentication onboarding, device-flow, and logout surface.
# Command names (`/login shisa`, `/logout shisa`, `/reload`), the account
# identifiers, the verification URL, and the device code are protected values
# passed as arguments; the English values below are the default output.

jouzu-cli-shisa-onboarding-pointConnect = Connect to Shisa AI to access hosted models and voice input.
jouzu-cli-shisa-onboarding-pointCredits = Explore bonus credits and other offers, including eligibility: https://platform.shisa.ai/jouzu
jouzu-cli-shisa-onboarding-question = Connect now? [y/N]
jouzu-cli-shisa-onboarding-hint = (or later with /login shisa)
jouzu-cli-shisa-onboarding-later = You can connect later with /login shisa.
jouzu-cli-shisa-onboarding-setupChoiceFailed = Could not save the Shisa setup choice. Check Jouzu's storage permissions.
jouzu-cli-shisa-onboarding-openLink = Open the link below and approve this device in your browser. Press Ctrl+C to cancel sign-in.
jouzu-cli-shisa-onboarding-deviceCode = Device code: { $code }
jouzu-cli-shisa-onboarding-signedIn = Signed in to Shisa AI.
jouzu-cli-shisa-onboarding-cancelled = Shisa sign-in cancelled.
jouzu-cli-shisa-onboarding-couldNotComplete = Shisa sign-in could not complete.

jouzu-cli-shisa-signIn-confirmFailed = Shisa sign-in was saved, but confirmation failed. Sign in again to avoid losing access after the confirmation deadline.
jouzu-cli-shisa-signIn-confirmInterrupted = Shisa sign-in was saved, but confirmation was interrupted. Sign in again to avoid losing access after the confirmation deadline.
jouzu-cli-shisa-signIn-unexpectedResponse = Shisa sign-in returned an unexpected response. Start the sign-in again.
jouzu-cli-shisa-signIn-expired = The sign-in request expired. Start the sign-in again.
jouzu-cli-shisa-signIn-declined = The sign-in request was declined in the browser. Start the sign-in again to retry.
jouzu-cli-shisa-signIn-notRecognized = The sign-in request was not recognized. Start the sign-in again.
jouzu-cli-shisa-signIn-alreadyDelivered = This sign-in already delivered its API key. Start a new sign-in to link this device.
jouzu-cli-shisa-signIn-httpFailed = Shisa sign-in failed (HTTP { $status }). Start the sign-in again.
jouzu-cli-shisa-signIn-storageFailed = Could not save Shisa sign-in. Check Jouzu's storage permissions and sign in again.
jouzu-cli-shisa-signIn-platformUnreachable = Could not reach the Shisa platform: { $message }
jouzu-cli-shisa-signIn-startFailed = The Shisa platform could not start the sign-in request (HTTP { $status }).
jouzu-cli-shisa-signIn-unexpectedStart = The Shisa platform returned an unexpected sign-in response. Try again.
jouzu-cli-shisa-signIn-timedOut = Sign-in timed out before the request was approved. Start the sign-in again.
jouzu-cli-shisa-signIn-cancelled = Login cancelled

jouzu-cli-shisa-logout-busy = Shisa sign-in or sign-out is already running. Wait for it to finish.
jouzu-cli-shisa-logout-couldNotRemove = Could not remove saved Shisa credentials. Check Jouzu's storage permissions and retry /logout shisa.
jouzu-cli-shisa-logout-signedOutLocally = Signed out locally. Disconnect this device in the Shisa dashboard to revoke its key.
jouzu-cli-shisa-logout-signedOut = Signed out of Shisa.
jouzu-cli-shisa-logout-serverUnconfirmed = Server revocation is unconfirmed. Disconnect this device in the Shisa dashboard to revoke its key.
jouzu-cli-shisa-logout-envKeyRemains = { $message } SHISA_API_KEY remains set, but Jouzu will not use Shisa in this process until you sign in again. Unset the variable before restarting to stay signed out.

jouzu-cli-shisa-refreshFailed = Shisa model availability could not refresh. Run /reload.
jouzu-cli-shisa-signOutFailed = Shisa sign-out could not complete. Wait for any sign-in or sign-out to finish, then retry /logout shisa.
jouzu-cli-shisa-signedOutReconnect = Signed out of Shisa. Run /login shisa to reconnect.
# The subagent result renderer. The status table maps an internal run state to
# a display word; the state value is the table key and never changes. Run IDs,
# paths, model IDs, tool names, counts, and offsets are passed as arguments.
jouzu-cli-subagent-status-queued = Queued
jouzu-cli-subagent-status-starting = Starting
jouzu-cli-subagent-status-running = Running
jouzu-cli-subagent-status-completed = Completed
jouzu-cli-subagent-status-failed = Failed
jouzu-cli-subagent-status-cancelled = Cancelled
jouzu-cli-subagent-status-interrupted = Interrupted
jouzu-cli-subagent-status-unknown = Unknown
jouzu-cli-subagent-roleFallback = Agent
jouzu-cli-subagent-runLabel = Run { $id }
jouzu-cli-subagent-workspaceLabel = Workspace:
jouzu-cli-subagent-elapsed = Elapsed { $minutes }m { $seconds }s (including queue)
jouzu-cli-subagent-modelIdLabel = Model ID:
jouzu-cli-subagent-tokensLabel = Tokens:
jouzu-cli-subagent-cost = Cost: { $amount }
jouzu-cli-subagent-costUnknown = Cost: unknown
jouzu-cli-subagent-candidateIdentityLabel = Candidate identity:
jouzu-cli-subagent-candidateHeadLabel = Candidate HEAD:
jouzu-cli-subagent-identityStability = Identity stability is not review approval.
jouzu-cli-subagent-moreRuns = { $count } more runs; expand or use list
jouzu-cli-subagent-noChildRuns = No child runs.
jouzu-cli-subagent-nextOffset = Next offset: { $offset }
jouzu-cli-subagent-enabled-on = Subagents on
jouzu-cli-subagent-enabled-off = Subagents off
jouzu-cli-subagent-placementLabel = Placement:
jouzu-cli-subagent-toolsLabel = Tools:
jouzu-cli-subagent-moreRoles = { $count } more roles; expand to view
jouzu-cli-subagent-outputPage = Output page
jouzu-cli-subagent-eventOnPage = { $heading } · 1 event on this page
jouzu-cli-subagent-eventsOnPage = { $heading } · { $count } events on this page
jouzu-cli-subagent-resultLabel = Result:
jouzu-cli-subagent-assistantLabel = Assistant:
jouzu-cli-subagent-messageFallback = Message
jouzu-cli-subagent-outputReceived = { $role } · output received
jouzu-cli-subagent-result = Result
jouzu-cli-subagent-toolLabel = Tool: { $tool }
jouzu-cli-subagent-childSessionReady = Child session ready
jouzu-cli-subagent-messageLabel = Message: { $status }
jouzu-cli-subagent-runEnded = Run ended
jouzu-cli-subagent-assignmentLabel = Assignment:
jouzu-cli-subagent-event = Event: { $type }
jouzu-cli-subagent-earlierEvents = { $count } earlier events on this page
jouzu-cli-subagent-noOutputYet = No output yet.
jouzu-cli-subagent-partialRecords = Partial records omitted from preview.
jouzu-cli-subagent-moreOutput = More output available.
jouzu-cli-subagent-nextByteOffset = Next byte offset: { $offset }
jouzu-cli-subagent-endOfOutput = End of available output.
jouzu-cli-subagent-messageAccepted = Message accepted by controller
jouzu-cli-subagent-deliveryUnconfirmed = Delivery to the child is not yet confirmed.
jouzu-cli-subagent-receiptLabel = Receipt:
jouzu-cli-subagent-cancellationRequested = Child cancellation requested
jouzu-cli-subagent-noResult = No result
jouzu-cli-subagent-operationFailed = Subagent operation failed

# The Session UI: the session identity line, the status bar, the Palette
# shortcut hint, and the work dashboard. Provider display names, model IDs,
# paths, and URLs are protected values passed as arguments, never catalog
# text. The dashboard's section and attention keys are internal identities;
# only the resolved words live here.
jouzu-cli-session-line-noModel = no model
jouzu-cli-session-line-attention = attention
jouzu-cli-session-status-health = ! status
jouzu-cli-session-status-contextUnknown = ctx ?
jouzu-cli-session-status-detached = detached
jouzu-cli-session-hint-paletteShortcuts = { $select } models · { $cycle } favorites · { $help } help
jouzu-cli-session-dashboard-section-agent = Agents
jouzu-cli-session-dashboard-section-job = Jobs
jouzu-cli-session-dashboard-section-task = Tasks
jouzu-cli-session-dashboard-section-loop = Loops
jouzu-cli-session-dashboard-section-goal = Goals
jouzu-cli-session-dashboard-section-prompt = Scheduled
jouzu-cli-session-dashboard-section-flow = Flow
jouzu-cli-session-dashboard-attention-result = unread result
jouzu-cli-session-dashboard-attention-input = needs input
jouzu-cli-session-dashboard-attention-recovery = needs recovery
jouzu-cli-session-dashboard-attention-authority = needs decision
jouzu-cli-session-dashboard-stale = { $status } [stale]
jouzu-cli-session-dashboard-elapsed-seconds = { $count }s
jouzu-cli-session-dashboard-elapsed-minutes = { $count }m
jouzu-cli-session-dashboard-elapsed-hours = { $count }h
jouzu-cli-session-dashboard-elapsed-hoursMinutes = { $hours }h { $minutes }m
# The subagent command, workflow, and dashboard notifications. Command names,
# option words, JSON operation snippets, run IDs, paths, and counts are passed
# as arguments; only the sentence lives here.
jouzu-cli-subagent-commandHint = Use /subagents, /subagents show, or /subagents hide.
jouzu-cli-subagent-dashboardRestored = Dashboard restored to its saved display mode.
jouzu-cli-subagent-dashboardHidden = Dashboard hidden for this session. Use /subagents show to restore it.
jouzu-cli-subagent-paneEnabled = Subagent pane enabled; it appears when this session has child runs.
jouzu-cli-subagent-paneHidden = Subagent pane hidden. Use /subagents show to display it.
jouzu-cli-subagent-enabledNotice = Subagents on for this session.
jouzu-cli-subagent-disabledNotice = Subagents off for this session. Queued and running children stopped; existing changes remain.
jouzu-cli-subagent-workflowCommandHint = Use /workflow, /workflow on, /workflow off, or /workflow toggle.
jouzu-cli-subagent-settingChangeFailed = Could not change subagent setting.
jouzu-cli-subagent-workflowStorageUnavailable = Workflow storage is unavailable.
jouzu-cli-subagent-workflowAgentsUnreadable = Workflow: agents.json could not be loaded. Correct the configuration before launching agents.
jouzu-cli-subagent-notificationDeliveryFailed = Agent notification delivery failed. Read the retained results with subagent list/read; reload when idle to retry.
jouzu-cli-subagent-rolesDisabledReason = Subagents are disabled by the user for this session. Work directly; only the user should re-enable them.
jouzu-cli-subagent-fieldRequired = subagent { $op } requires a non-empty { $field }. { $hint } Omit unrelated fields; use null only if the interface requires them.
jouzu-cli-subagent-fieldHint-role = Call { $command } and use a returned child-capable role.
jouzu-cli-subagent-fieldHint-runId = Call { $command } and use a returned run ID.
jouzu-cli-subagent-fieldHint-batchId = Use the batchId from a completion delivered in this run.
jouzu-cli-subagent-fieldHint-task = Supply the assignment or follow-up in task.
jouzu-cli-subagent-dashboardMore = · +{ $count } more
jouzu-cli-subagent-batchSummary = Agents: { $total } finished — completed { $completed }, failed { $failed }, cancelled { $cancelled }, interrupted { $interrupted }.
jouzu-cli-subagent-batchOmitted = { $count } omitted; use subagent list for IDs and subagent read for output.
jouzu-cli-subagent-reviewCandidateWarning = Review candidate { $status }; this result does not establish the final workspace state.
jouzu-cli-subagent-workspaceError = Workspace: { $path } { $reason }. Choose an existing directory accessible to Jouzu; a restart is not required.
jouzu-cli-subagent-workspaceMissing = does not exist
jouzu-cli-subagent-workspaceInaccessible = is not accessible
jouzu-cli-subagent-workspaceNotDirectory = is not an accessible directory
jouzu-cli-subagent-modelUnavailable = Model: { $selector } is unavailable. Choose an available model in Workflow.
jouzu-cli-subagent-modelAmbiguous = Model: { $selector } matches { $count } providers: { $providers }. Retry with the full provider/model.
jouzu-cli-subagent-modelAmbiguousMore = , and { $count } more
jouzu-cli-subagent-validationLength = Validation: { $label } must be 1–{ $max } characters.
jouzu-cli-subagent-validationLengthMax = Validation: { $label } must be at most { $max } characters.
# The subagent launch, resume, read, and trace failure and recovery sentences the
# direct-string detector cannot reach, plus the command descriptions and the
# call preview. A model, a provider, a role, a workspace, a run ID, a byte
# offset, and a JSON operation snippet are passed as arguments; only the
# sentence lives here.
jouzu-cli-subagent-workflowRequiresSession = Workflow requires an active session.
jouzu-cli-subagent-sameModelNoSession = Model: the role model is "{ $model }", but this session has no model selected. Select a model, or give the role an explicit provider/model.
jouzu-cli-subagent-agentDefinitionNotFound = Agent definition was not found.
jouzu-cli-subagent-disabledForSession = Subagents are off for this session. The user can enable them in Workflow or with /workflow on.
jouzu-cli-subagent-providerInProcess = Model: this provider uses an in-process extension. Choose a provider with a built-in API for child agents.
jouzu-cli-subagent-sessionChangedBeforeStart = Session changed before the agent could start. Retry in this session.
jouzu-cli-subagent-settingChangedBeforeLaunch = Subagent setting changed before launch. Retry the assignment.
jouzu-cli-subagent-authenticationSignIn = Authentication: sign in to the selected agent provider and retry.
jouzu-cli-subagent-authenticationApiKeyProvider = Authentication: choose an API-key or token provider for child agents.
jouzu-cli-subagent-cacheWarmingSettingsUnreadable = Could not read cache-warming settings for the child. Check settings.json before retrying.
jouzu-cli-subagent-settingChangeInProgress = Wait for the subagent setting change to finish.
jouzu-cli-subagent-parentTranscriptUnavailable = Trace: the parent session has no saved transcript yet.
jouzu-cli-subagent-mainPlacementRequired = Choose a definition that allows use in the main session.
jouzu-cli-subagent-mainRoleIdleRequired = Wait for the main agent to finish before changing its role.
jouzu-cli-subagent-roleAuthenticationUnavailable = Model: authentication is unavailable for this role.
jouzu-cli-subagent-modelArgumentUserOnly = Only the user can change subagent models in Workflow. Omit the model argument.
jouzu-cli-subagent-resumeContextOmit = Resume keeps its original context. Omit launch-only fields context, entryIds, and parentContext (or use null).
jouzu-cli-subagent-resumeWorkspaceKeep = Resume keeps the original workspace. Launch a new agent to use another directory.
jouzu-cli-subagent-offsetNonnegative = Offset must be a nonnegative integer.
jouzu-cli-subagent-operationUnsupported = Choose a supported subagent operation.
jouzu-cli-subagent-commandDescription = Open child runs; use show or hide for the dashboard
jouzu-cli-subagent-workflowCommandDescription = Open agents and runs; on/off/toggle controls subagents for this session
jouzu-cli-subagent-callLabel = Subagent · { $operation }
jouzu-cli-subagent-callPreparing = preparing
jouzu-cli-subagent-agentNotRunning = Agent is no longer running.
jouzu-cli-subagent-storageRecordUnreadable = Storage: an agent record could not be read. Inspect the stored session before retrying.
jouzu-cli-subagent-sessionClosed = This agent session has closed.
jouzu-cli-subagent-agentsOwnedByAnotherProcess = This session's agents are controlled by another Jouzu process. Close it before starting more work.
jouzu-cli-subagent-invalidRunDirectory = Storage: invalid run directory.
jouzu-cli-subagent-invalidEventFile = Storage: invalid agent event file.
jouzu-cli-subagent-runNotFoundInSession = Agent run was not found in this parent session.
jouzu-cli-subagent-completionRecordNotFound = Agent completion record was not found.
jouzu-cli-subagent-readBounds = Read: use a nonnegative byte offset and a limit of 1–32000 bytes.
jouzu-cli-subagent-readPastEnd = Read offset is past the end of the agent output.
jouzu-cli-subagent-readCharacterBoundary = Read offset must begin at a UTF-8 character boundary. Use nextOffset from the previous page.
jouzu-cli-subagent-childSessionUnavailable = Trace: the saved child session is unavailable.
jouzu-cli-subagent-taskLength = Task: enter 1–32000 characters.
jouzu-cli-subagent-childPlacementRequired = Choose a role that can run as a child agent.
jouzu-cli-subagent-queueFull = Agent queue is full. Wait for work to finish.
jouzu-cli-subagent-resumeParentContextKeep = Resume keeps the original parent context. Launch a new agent to change it.
jouzu-cli-subagent-resumeActiveRun = Stop or finish this agent before resuming it.
jouzu-cli-subagent-resumeIdentityRequired = Resume requires the original workspace, role revision, and explicitly selected model.
jouzu-cli-subagent-parentContextUnavailable = The saved parent context is unavailable.
jouzu-cli-subagent-childFollowUpActive = This child session already has an active follow-up.
jouzu-cli-subagent-childSessionMissing = The saved child session is unavailable.
jouzu-cli-subagent-parentSnapshotTooLarge = Context: parent snapshot exceeds 32 MB. Use parentContext: false with fresh context or a focused splice.
jouzu-cli-subagent-messageLength = Message: enter 1–16000 characters.
jouzu-cli-subagent-notRunningUseResume = This agent is not running. Use Resume for a follow-up.
jouzu-cli-subagent-runNotFound = Agent run not found.
jouzu-cli-subagent-stopIncomplete = Some subagents could not be stopped. Inspect Runs and retry Stop for each active child.
jouzu-cli-subagent-storageSaveFailed = Storage failed while saving an agent result.
jouzu-cli-subagent-lockReleaseFailed = Process lock release failed; restart Jouzu before starting more agents. { $detail }
jouzu-cli-subagent-traceBounds = Trace: offset must be a nonnegative byte cursor and limit must be 1–100.
jouzu-cli-subagent-traceKind = Trace: choose all, messages, tools, errors, or compaction.
jouzu-cli-subagent-traceQuery = Trace: use a text query of at most 2000 characters and a string entryId.
jouzu-cli-subagent-traceNotRegularFile = Trace: session path is not a regular file.
jouzu-cli-subagent-tracePastEnd = Trace: offset is past the end of the session.
jouzu-cli-subagent-traceLineBoundary = Trace: offset must start a JSONL line. Use nextOffset from the previous page.
jouzu-cli-subagent-traceMalformedEntry = Trace: malformed complete JSONL entry at byte { $offset }. Inspect the saved session file.
jouzu-cli-subagent-traceEntryTooLarge = Trace: one entry exceeds the 8 MB scan limit. Read the saved session file directly.
jouzu-cli-subagent-contextMode = Context: choose fresh, fork, or splice.
jouzu-cli-subagent-contextParentLookup = Context: parentContext must be true or false.
jouzu-cli-subagent-contextEntryIdsMode = Context: entryIds is only valid with context: splice, but this launch uses { $mode }. Omit entryIds, or send null if the interface requires the field. Do not switch to splice unless you intend to share selected parent entries.
jouzu-cli-subagent-contextSpliceIds = Context: splice requires 1–100 message or compaction entry IDs from the active parent branch. Call subagent with { $command } to obtain IDs, then retry with those IDs. For a fresh assignment, omit both context and entryIds (or send null).

# The flow-control status view and its notices. State values, wait tokens,
# dependency handles, and provider/model IDs are passed as arguments, never
# stored here. A stage word is display text; an unknown internal stage stays
# as the producer named it.
jouzu-cli-flow-stage-contextPreparation = context preparation
jouzu-cli-flow-stage-modelConversion = model conversion
jouzu-cli-flow-input-continueAfterCompaction = Continue after compaction
jouzu-cli-flow-input-multiloopResume = Resume notice for a detached goal
jouzu-cli-flow-status-blockedOneRequest = Blocked: { $count } request was not sent.
jouzu-cli-flow-status-blockedManyRequests = Blocked: { $count } requests were not sent.
jouzu-cli-flow-status-requestEndedDuring = Request ended during { $stage }; no payload was admitted.
jouzu-cli-flow-status-requestEndedBeforeAdmission = Request ended before payload admission. No send was recorded; the receipt does not identify the cause.
jouzu-cli-flow-status-requiredInputRemovedBeforeSending = Required input was removed or changed before sending.
jouzu-cli-flow-status-requiredContextRemovedBeforeSending = Required context was removed or changed before sending.
jouzu-cli-flow-status-requiredInputRemovedDuring = Required input was removed or changed during { $stage }.
jouzu-cli-flow-status-requiredContextRemovedDuring = Required context was removed or changed during { $stage }.
jouzu-cli-flow-status-commandNotRun = Command was not run. Run it again only if still needed.
jouzu-cli-flow-status-extensionNoticeNotDelivered = Extension notice was not delivered. It is not queued for replay.
jouzu-cli-flow-status-notQueuedForReplay = Not queued for replay. Submit it again only if still needed.
jouzu-cli-flow-status-savedStateBlocksInput = Saved flow state still blocks this input. Run /flow details to inspect it before resetting.
jouzu-cli-flow-status-waitingForRequestBlock = Waiting for the request block above to be cleared.
jouzu-cli-flow-status-heldBehindBlocker = Held behind the blocker
jouzu-cli-flow-status-heldInput = Held input
jouzu-cli-flow-status-inputDetailsUnavailable = Input details unavailable
jouzu-cli-flow-status-taskDetailsUnavailable = Task: details unavailable
jouzu-cli-flow-status-taskLabel = Task #{ $id }: { $subject }
jouzu-cli-flow-status-showingEntries = Showing { $from }-{ $to } of { $total }.
jouzu-cli-flow-status-noEntriesOnPage = No entries on page { $page }.
jouzu-cli-flow-status-waitUnmetDeadline = { $unmet } unmet; deadline in { $minutes }m.
jouzu-cli-flow-status-waitUnmetPastDeadline = { $unmet } unmet; past its deadline.
jouzu-cli-flow-status-ageJustNow = just now
jouzu-cli-flow-status-ageMinutes = { $minutes }m ago
jouzu-cli-flow-status-ageHoursMinutes = { $hours }h { $minutes }m ago
jouzu-cli-flow-status-eligibleForAutomation = Eligible for automation.
jouzu-cli-flow-status-eligibleForAutomationWithStatus = Eligible for automation; task status: { $status }.
jouzu-cli-flow-status-taskCompleted = Task completed.
jouzu-cli-flow-status-taskState = Task state: { $state }
jouzu-cli-flow-status-taskDetailsChanged = Task details changed; flow status has not synchronized yet.
jouzu-cli-flow-status-liveWaitOne = { $count } live wait
jouzu-cli-flow-status-liveWaitMany = { $count } live waits
jouzu-cli-flow-status-noLiveWait = no live wait
jouzu-cli-flow-status-deadlineExpiresIn = expires in { $duration }
jouzu-cli-flow-status-deadlinePast = past its deadline
jouzu-cli-flow-status-repairCauseClear = Repair the cause, then run /flow clear and send a new message.
jouzu-cli-flow-status-resumeNow = Resume now with: /flow resume
jouzu-cli-flow-status-durationUnderMinute = under a minute
jouzu-cli-flow-status-durationMinutes = { $minutes }m
jouzu-cli-flow-status-durationHours = { $hours }h
jouzu-cli-flow-status-durationHoursMinutes = { $hours }h { $minutes }m
jouzu-cli-flow-status-senderExtension = Extension
jouzu-cli-flow-status-customMessage = Custom message
jouzu-cli-flow-status-messageWithNonTextContent = Message with non-text content
jouzu-cli-flow-status-stageRequestPreparation = request preparation
jouzu-cli-flow-status-titleUnavailable = Title unavailable
jouzu-cli-flow-status-workFallback = Work
jouzu-cli-flow-status-requestsNotSentHeading = Requests not sent
jouzu-cli-flow-status-correctCauseThenClear = Correct the reported cause, then run /flow clear to release the saved hold.
jouzu-cli-flow-status-automationAlsoPaused = Automation is also paused: { $reason }. /flow resume alone cannot clear the request block.
jouzu-cli-flow-status-inputLine = Input: { $id }
jouzu-cli-flow-status-moreRequiredInputs = { $count } more required inputs share this request.
jouzu-cli-flow-status-requiredContextUnlinked = - Required context (no submitted message is linked)
jouzu-cli-flow-status-reasonLine = Reason: { $reason }
jouzu-cli-flow-status-failureLine = Failure: { $code }, recorded { $recordedAt }
jouzu-cli-flow-status-destinationLine = Destination: { $provider } / { $model }
jouzu-cli-flow-status-providerFallback = provider
jouzu-cli-flow-status-modelFallback = model
jouzu-cli-flow-status-requestLine = Request: { $id }
jouzu-cli-flow-status-retryAfterCorrection = Retry after correction: /flow retry { $id }
jouzu-cli-flow-status-resetPreservesRecords = Reset preserves these records; it does not resend the failed request.
jouzu-cli-flow-status-blockedRecoveryDecision = Blocked: saved work needs a recovery decision.
jouzu-cli-flow-status-turnInProgress = A model turn is in progress.
jouzu-cli-flow-status-furtherAutomationPaused = Further automation is paused: { $reason }
jouzu-cli-flow-status-pausedLine = Paused: { $reason }
jouzu-cli-flow-status-resumeAutomation = Resume automation with /flow resume, or send a new message.
jouzu-cli-flow-status-otherRecoveryBlockersHeading = Other recovery blockers
jouzu-cli-flow-status-statusIncompleteHeading = Status incomplete
jouzu-cli-flow-status-unreadableState = Unreadable state has not been cleared. Run /flow runtime for build details.
jouzu-cli-flow-status-sentOutcomeUnknownHeading = Sent, outcome unknown
jouzu-cli-flow-status-sendAgain = Send again (may repeat work): /flow resolve { $id } retry
jouzu-cli-flow-status-doNotResend = Do not resend: /flow resolve { $id } discard
jouzu-cli-flow-status-waitingOnJobsHeading = Waiting on jobs
jouzu-cli-flow-status-waitingForDependency = Waiting for { $dependency }
jouzu-cli-flow-status-moreJobDependencies = { $count } more job dependencies.
jouzu-cli-flow-status-cancelWaitOnly = Cancel the wait only: /flow cancel { $token }
jouzu-cli-flow-status-undeliveredInputHeading = Undelivered input
jouzu-cli-flow-status-workEligibilityHeading = Work eligibility
jouzu-cli-flow-status-workLine = Work: { $id }
jouzu-cli-flow-status-pauseLine = Pause: /flow pause { $id }
jouzu-cli-flow-status-stopLine = Stop: /flow stop { $id }
jouzu-cli-flow-status-notAttachedHeading = Not attached to this session
jouzu-cli-flow-status-nothingHeld = Nothing is held, withheld, waiting, or unresolved.
jouzu-cli-flow-status-fullIdentifiers = Full identifiers and controls: /flow details
jouzu-cli-flow-status-moreEntries = More entries: /flow details { $page }
jouzu-cli-flow-status-previousEntries = Previous entries: /flow details { $page }
jouzu-cli-flow-notice-pauseAfterInterrupt = Flow control paused after an interrupt. Automated work resumes on your next message. Run /flow for details.
jouzu-cli-flow-notice-pauseAfterAdmissionFailure = Flow control paused after an admission failure. Pending work is held. Run /flow for details, /flow clear to release the hold, or /flow reset to reset delivery.
jouzu-cli-flow-notice-pausedAfterReopen = Flow control is paused after reopening this session. Inspect with /flow; resume automation with /flow resume or your next message.
jouzu-cli-flow-notice-flowOffHeadline = Flow control is off.
jouzu-cli-flow-notice-flowOnHeadline = Flow control is on again.
jouzu-cli-flow-notice-flowResetHeadline = Flow control reset.
jouzu-cli-flow-notice-flowOffTail = Jobs, tasks, and lanes now run and report through their own delivery paths.
jouzu-cli-flow-notice-flowOnTail = Held results and waits are live and run from the next idle boundary.
jouzu-cli-flow-notice-withheldRequestNeedsClear = A withheld request still needs /flow clear.
jouzu-cli-flow-notice-flowOffCommandUnavailable = /flow { $verb } works again after /flow on.
jouzu-cli-flow-notice-alreadyPaused = Already paused: { $reason }. Release it with /flow resume.
jouzu-cli-flow-notice-pausedEveryTurn = Paused every automated turn in this session. Release it with /flow resume.
jouzu-cli-flow-notice-resolvedSpent = Resolved { $target } as spent. Its work will not run again for this attempt.
jouzu-cli-flow-notice-resolvedUndelivered = Resolved { $target } as undelivered. Its work is eligible again and may repeat a turn the provider already answered.
jouzu-cli-flow-notice-stoppedWork = Stopped { $target }. Its waits are cancelled and no further automated turn runs for it. Any job it started keeps running.
jouzu-cli-flow-notice-pausedWork = Paused { $target }. Its automated turns are held until /flow resume { $target }.
jouzu-cli-flow-notice-resumedWork = Resumed { $target }. Its automated turns can run again.
jouzu-cli-flow-notice-flowClearReleasedOne = Flow clear released { $count } request hold. Receipt evidence was preserved. Continue with a new message.
jouzu-cli-flow-notice-flowClearReleasedMany = Flow clear released { $count } request holds. Receipt evidence was preserved. Continue with a new message.
jouzu-cli-flow-notice-flowClearReleasedOneReservation = Flow clear released { $count } request hold and cleared reservation { $attemptId }. Receipt evidence was preserved. Continue with a new message.
jouzu-cli-flow-notice-flowClearReleasedManyReservation = Flow clear released { $count } request holds and cleared reservation { $attemptId }. Receipt evidence was preserved. Continue with a new message.
jouzu-cli-flow-compaction-label = Compact Context
jouzu-cli-flow-message-work = ▶ work
jouzu-cli-flow-message-alert = ⚠ alert
jouzu-cli-flow-registry-rebuilt = This session's flow registry was incompatible with the current version and was dropped. Flow state was rebuilt from the transcript.
jouzu-cli-flow-registry-rebuiltSaved = This session's flow registry was incompatible with the current version and was dropped. Flow state was rebuilt from the transcript. The dropped state was saved to { $path }.
jouzu-cli-flow-noReply-label = End the turn without replying
jouzu-cli-flow-ownership-busy = This session branch is already owned by another attachment.
jouzu-cli-flow-ownership-failed = Flow ownership could not be acquired.
jouzu-cli-flow-native-editedInput = Edited native input requires a new observation.
jouzu-cli-flow-native-observationRetained = Native input observation could not be retained.
jouzu-cli-flow-native-queueAdmission = Queue admission could not complete.
jouzu-cli-flow-native-queueHeld = Queued input is held by session policy.
jouzu-cli-flow-native-compactionProviderFailed = Compaction provider failed before payload admission: { $message }
jouzu-cli-flow-native-maintenanceNoAdmission = Maintenance provider returned without payload admission.
jouzu-cli-flow-native-providerNoAdmission = Native provider returned without payload admission. Run /flow for recovery options.
jouzu-cli-flow-native-providerFailed = Provider request failed before payload admission ({ $provider } / { $model }): { $message }. Run /flow for recovery options.
jouzu-cli-flow-native-noFailureDescription = No failure description was returned.
jouzu-cli-flow-ingress-hostAdmission = Input is held by host admission policy.
jouzu-cli-flow-ingress-recoveryReconciliation = Input is waiting for recovery reconciliation.
jouzu-cli-flow-ingress-semanticAdmission = Input is waiting for updated semantic admission.
jouzu-cli-flow-ingress-providerOutcomeUnknown = Provider outcome is unknown.
jouzu-cli-flow-service-resolvedSpent = Resolved from /flow as spent.
jouzu-cli-flow-service-resolvedUndelivered = Resolved from /flow as undelivered.
jouzu-cli-flow-ledger-invalidRequestSummary = Invalid request summary.
jouzu-cli-flow-ledger-invalidRetiredAttempts = Invalid retired attempts.
jouzu-cli-flow-ledger-noComposedInput = No composed input survived filtering.
jouzu-cli-flow-ledger-outcomeUnknown = Request outcome unknown after attachment loss.
jouzu-cli-flow-ledger-requiredFiltered = Required input or intact aggregate metadata was filtered.
jouzu-cli-flow-ledger-handoffCancelled = Unsent handoff cancelled on reattachment.
jouzu-cli-flow-results-label = Read completion results
jouzu-cli-flow-submission-deferredContextCancellation = Deferred context cancellation requires removal reconciliation.
jouzu-cli-flow-submission-queueCancellation = Queue cancellation requires removal reconciliation.
jouzu-cli-flow-submission-deliveryUnknown = Sent, but whether the model received it is not known.
jouzu-cli-flow-submission-unavailable = Input was not dispatched and cannot be delivered. Submit it again to run it.
jouzu-cli-flow-task-continuationSkipped = Skipped a task continuation because its task changed.
jouzu-cli-flow-wait-label = Wait for dependencies
jouzu-cli-flow-wait-cancelLabel = Cancel dependency wait
jouzu-cli-selfUpdate-lockBusy = another Jouzu update is running
jouzu-cli-flow-message-reviewNote = Completion does not imply review approval.
jouzu-cli-flow-controller-producerInput = Producer input unavailable.
jouzu-cli-flow-controller-producerState = Producer state unavailable.
jouzu-cli-flow-controller-resultInput = Result input unavailable.
jouzu-cli-flow-controller-resultMetadata = Result metadata unavailable.
jouzu-cli-flow-controller-waitDecisionInput = Wait decision input unavailable.
jouzu-cli-flow-controller-aggregateCapacity = Aggregate metadata exceeds available capacity.
jouzu-cli-flow-controller-resultCapacity = Result exceeds the remaining composed-input capacity.

# Session labels: the /labels status block, its command list, the command
# description, and the command notices. The state words are catalog text so a
# locale change localizes them; the provider/model identity is a protected value
# passed as an argument.
jouzu-cli-sessionLabels-status-automaticNaming = Automatic naming: { $state }. Global: { $global }; session: { $session }.
jouzu-cli-sessionLabels-status-namingModel = Naming model: { $model }.
jouzu-cli-sessionLabels-status-sessionNamePane = Session name: { $name }. Pane: { $pane }.
jouzu-cli-sessionLabels-status-namingRequests = Naming requests: { $count }/20.
jouzu-cli-sessionLabels-status-globalInvalid = Global label settings are invalid; naming is disabled until the settings file is repaired.
jouzu-cli-sessionLabels-status-revisit = Ambiguous task: revisit after { $count } more completed user turn(s).
jouzu-cli-sessionLabels-status-runsAfterTurn = Naming runs after a completed task turn; saved labels are checked on resume.
jouzu-cli-sessionLabels-command-show = /labels — Show status and commands.
jouzu-cli-sessionLabels-command-global = /labels global on|off — Save the global naming setting.
jouzu-cli-sessionLabels-command-on = /labels on — Enable naming with the selected model.
jouzu-cli-sessionLabels-command-off = /labels off — Cancel pending naming and stop requests.
jouzu-cli-sessionLabels-command-pin = /labels pin — Protect the session name.
jouzu-cli-sessionLabels-command-auto = /labels auto — Allow automatic session-name changes.
jouzu-cli-sessionLabels-command-panePin = /labels pane pin — Protect this pane's title.
jouzu-cli-sessionLabels-command-paneAuto = /labels pane auto — Allow replacing this tmux pane's title.
jouzu-cli-sessionLabels-command-description = Configure automatic session names and tmux pane labels
jouzu-cli-sessionLabels-notify-requiresInteractive = Session labels require an interactive session.
jouzu-cli-sessionLabels-notify-globalUnavailable = Global label settings are unavailable.
jouzu-cli-sessionLabels-notify-selectModel = Select a model first.
jouzu-cli-sessionLabels-notify-enableBeforePane = Enable session and global labels before claiming a pane.
jouzu-cli-sessionLabels-notify-paneUnavailable = Pane unavailable or owned by another attachment; title preserved.
jouzu-cli-sessionLabels-notify-useCommand = Use /labels to see status and commands.
jouzu-cli-sessionLabels-value-on = on
jouzu-cli-sessionLabels-value-off = off
jouzu-cli-sessionLabels-value-pinned = pinned
jouzu-cli-sessionLabels-value-automatic = automatic
jouzu-cli-sessionLabels-value-guarded = guarded (unknown titles are protected)
jouzu-cli-sessionLabels-value-selectedModel = selected model at the first naming request
jouzu-cli-sessionLabels-value-none = none

# Dashboard policy recovery. The policy error text is a protected value passed
# as an argument.
jouzu-cli-settings-dashboardUnreadable = Dashboard settings could not be read: { $message }
# Jouzu-owned browser and delegation tool labels, plus the Camoufox tool-result
# screenshot lines. A tool name, a tool ID, and a parameter name stay in code;
# only the display text moves here.
jouzu-cli-tool-fetchUrl-label = Fetch URL
jouzu-cli-tool-searchWeb-label = Search web
jouzu-cli-tool-parentContext-label = Parent Context
jouzu-cli-tool-subagent-label = Subagent
jouzu-cli-camoufox-result-screenshotOmitted = screenshot omitted: { $size } exceeds the { $limit } attachment limit. Retry with screenshot.full_page=false, or lower screenshot.quality.
jouzu-cli-camoufox-result-screenshotAttached = screenshot: { $mimeType }, { $size } attached to this result.
# Pre-launch CLI text for the presentation banner and status command, the
# classic-host MCP notice, the keybinding and profile lock messages, the
# process lock errors, the runtime restart suffix, the compaction outcome, and
# the release-extension warnings. Lock file names, CLI option names, tool names,
# and stored diagnostic values are protected values passed as arguments.
jouzu-cli-presentation-windowTitle = Jouzu - { $workspace }
jouzu-cli-presentation-windowTitle-session = Jouzu - { $session } - { $workspace }
jouzu-cli-presentation-bannerVersion-jouzu = jouzu { $version }
jouzu-cli-presentation-bannerVersion-pi = pi { $version }
jouzu-cli-presentation-status-modelNotSelected = not selected
jouzu-cli-presentation-status-profileNotApplied = not applied
jouzu-cli-presentation-status-scopedModelsAll = all available
jouzu-cli-presentation-status-contextUsage = { $tokens }/{ $window } tokens ({ $percent }%)
jouzu-cli-presentation-status-heading = Jouzu session status
jouzu-cli-presentation-status-session = session: { $id }
jouzu-cli-presentation-status-workspace = workspace: { $name }
jouzu-cli-presentation-status-model = model: { $model }
jouzu-cli-presentation-status-thinking = thinking: { $level }
jouzu-cli-presentation-status-context = context: { $context }
jouzu-cli-presentation-status-scopedModels = scoped models: { $models }
jouzu-cli-presentation-status-profile = profile: { $id } ({ $state })
jouzu-cli-presentation-status-runtime = runtime: Jouzu { $jouzu } · Pi { $pi }
jouzu-cli-presentation-status-profileApplied = applied
jouzu-cli-presentation-command-statusDescription = Show the current Jouzu session, model, context, and profile status
jouzu-cli-classicHost-mcpUnavailable = Built-in Model Context Protocol (MCP) connections are not enabled in this session. Use Jouzu's file and web tools instead.
jouzu-cli-keybindings-action-conflictDetail = ; conflicts with { $action }
jouzu-cli-keybindings-action-currentDetail = ; current { $binding }
jouzu-cli-keybindings-lockBusy = another keybinding operation is in progress
jouzu-cli-profile-lockBusy = another profile operation is in progress
jouzu-cli-processLock-busy = The process lock is held by another process: { $path }
jouzu-cli-processLock-unavailable = The process lock could not be acquired: { $path }
# The `/flow runtime` report, the About view, and the startup warning. A
# package name, a path, a version, a start timestamp, and a SHA-256 hash are
# protected values passed as arguments.
jouzu-cli-runtime-patchDiffers = { $package }: required flow patch differs at { $path }. Repair the installation and restart; run /flow runtime for paths.
jouzu-cli-runtime-patchUnavailable = Runtime patch diagnostics are unavailable. Repair the installation to restore /flow runtime checks.
jouzu-cli-runtime-running = Running Jouzu { $version }
jouzu-cli-runtime-pi = Pi { $version }
jouzu-cli-runtime-started = Started { $started }
jouzu-cli-runtime-installed = Installed Jouzu { $version }
jouzu-cli-runtime-versionUnavailable = unavailable
jouzu-cli-runtime-installedDiffers = Installed build differs. Restart Jouzu to load it.
jouzu-cli-runtime-summary = Runtime: Jouzu { $version } · Pi { $pi }
jouzu-cli-runtime-reportHeading = Package paths and SHA-256 hashes captured at startup:
jouzu-cli-runtime-buildChanged = The installed Jouzu build changed. Restart Jouzu to load it; /flow runtime shows running and installed versions.
jouzu-cli-runtime-restartAvailable = · restart available
jouzu-cli-compaction-outcome = Context compacted at the agent's request. Earlier messages remain searchable.
jouzu-cli-compaction-outcome-piVcc = Context compacted at the agent's request (pi-vcc summary). Earlier messages remain searchable.
jouzu-cli-compaction-continueFailed = Could not continue after compaction: { $message }
jouzu-cli-releaseExtensions-disabledTools = Disabled tools: { $tools }.
jouzu-cli-releaseExtensions-unavailable = Optional extension { $package }@{ $version } is unavailable.{ $tools } { $error } Run `jz doctor` for details.
jouzu-cli-releaseExtensions-requiredUnavailable = release-owned extensions are unavailable: { $errors }
jouzu-cli-releaseExtensions-warning = Jouzu warning: { $message }
jouzu-cli-releaseExtensions-conflict-one = conflicts with Jouzu release-owned tool "{ $tool }"; disable this extension or its package with `jz config`
jouzu-cli-releaseExtensions-conflict-many = conflicts with Jouzu release-owned tools { $tools }; disable this extension or its package with `jz config`
jouzu-cli-flow-runtimeError = Jouzu flow control: { $message }
jouzu-cli-flow-runtimeDiagnosticsUnavailable = Runtime diagnostics are unavailable in this session.
