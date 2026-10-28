# User-visible English text inventory

Source: [GitHub main at `346d1e4`](https://github.com/shisa-ai/jouzu/tree/346d1e481757a55eb62fc066e43bbc7999b8e6dd).
This inventory lists wording and the conditions under which it can reach a user,
including errors and diagnostics. It is being assembled for a translation pass.
The current snapshot is **incomplete**; catalog membership, source references and
runtime visibility are separate claims.

Start with [catalogs.csv](catalogs.csv). It contains all **1,804 English Fluent
messages** at this source commit, with exact English patterns, file and line,
attributes, variables, and trigger status. **110** messages currently have
source-traced trigger descriptions: CLI help, argument-parser errors, and
slash-command autocomplete descriptions. Other messages explicitly retain
`caller-trace-required`; this includes one message with no static reference,
`jouzu.cli.classicHost.mcpUnavailable`. Its presence in a catalog does not prove
it can appear.

[catalog-links.csv](catalog-links.csv) joins every catalog ID to its primary
context count and matching occurrence-table row IDs, so the detailed trigger
records can be found without searching every file. The snapshot counts IDs with
at least one primary context or occurrence record separately from those with
neither. Linked records include guarded, inactive, API-only and canonical adapter occurrences.
Presence in this index does not certify complete caller coverage or visibility.
[catalog-links-snapshot.json](catalog-links-snapshot.json) pins the inputs and
records the overlap counts; these are navigation counts, not unique fixes.

[catalog-contexts.json](catalog-contexts.json) supplies the traced display
locations, trigger conditions, consumer anchors and translation boundaries.
[catalog-references.jsonl](catalog-references.jsonl) contains **3,506 source
references**, grouped by message ID, from production CLI and Session UI
TypeScript. References include ID definitions and backing tables. The surrounding
function, call name and lexical conditions are navigation aids, not evaluated
conditions or proof of reachability. Early returns, callback timing, dynamic
lookups, mutations and caller state require source tracing. An initializer
reference records its source assignment, not a guarantee of its runtime value.

English patterns retain Fluent syntax: variables, selections, plural branches,
quoted literals and indentation. They are not flattened rendered sentences.
Translate each prose branch while preserving protected arguments, commands,
identifiers, paths and externally supplied text. A row may have several callers
or rendered variants. English can appear when English is selected, on catalog
fallback, or through a caller that uses a default English catalog; each caller's
locale path still needs review.

Import CSV as **UTF-8, comma-separated, double-quote-delimited, with every column
as text**. Fields may contain quoted newlines. Text import also prevents source
snippets from becoming spreadsheet formulas.

Coverage remains open for direct source strings, inherited Pi and extension
wording, launcher helpers and native dialogs, installer dependencies, Python and
operator/development commands, generated/exported views, and error payload paths. Arbitrary model,
tool, provider, operating-system, remote-service and user content cannot have a
finite English wording list: their source-defined wrappers and delivery
conditions need explicit boundary records. Current tables do not close those
areas or certify runtime layout or translation quality.

[source-census.csv](source-census.csv) lists all 1,206 tracked blobs at the source
pin, their immutable Git object IDs and references into the reviewed scope
tables or English catalog export. It includes source, commands, tests, resources,
documentation and vendored files. A scope reference may be partial, supporting,
excluded or pending; its presence is not a completed file review. Path categories
are navigation aids and do not exclude wording from review. Installed dependencies
and generated outputs need their separate provenance and consumer traces.

[pi-runtime-census.csv](pi-runtime-census.csv) accounts for the exact two-package
Pi 1.4.0 installed JavaScript runtime universe: 382 canonical bodies and two
pinned additions. Of the canonical bodies, 358 match npm archive bytes and 24
match public source patches. Its frozen review baseline links 192 full Pi local
body reviews and three full checked-in verbatim bodies; 189 bodies remain pending,
including 24 with bounded support only. All 46 terminal-library bodies have local
reviews. The pending set contains 81 compiled bundles totaling 9,211,377 bytes;
physical line counts alone understate that scope. The
[evidence](pi-runtime-census-evidence.json) pins 102 source/artifact snapshots,
33 review inputs, canonical archives, both installed trees and 74 patch after
hashes. Twelve corruption controls reject missing bodies and unsupported review
promotions. These are local-body review references; resource, native, transitive
dependency and complete consumer coverage remain open. No audited module is loaded.

The older [Japanese review](../ja-localization/README.md) retains its own source
pin and translations; its counts must not be added to this inventory.

[acp.csv](acp.csv) contains 104 ACP occurrences: 62 fixed wording occurrences
(including catalog and SDK prefixes) and 42 dynamic payload boundaries. Each
records the protocol field or stderr sink and its trigger. Protocol fields are
potentially visible: each ACP client controls which fields it renders.
[acp-scope.csv](acp-scope.csv) pins the four reviewed ACP source modules and
supporting files; suppressed internal labels and guards are recorded separately.
The dependency pass below supplies the SDK routing, schema and framing wording.

[acp-dependencies.csv](acp-dependencies.csv) adds 386 dependency records: 377
exact source occurrences and nine dynamic boundaries. The
[scope table](acp-dependencies-scope.csv) covers all 43 SDK runtime JavaScript
bodies and bounded Zod English validation support. The package root selects
stable V1 with batches disabled; alternative API exports have separate conditions.
Invalid parameters return a formatted issue tree, while stream and batch failures
can close the connection without an automatic error response. SDK console output
has its own stderr route. Client rendering, arbitrary values and native errors
remain boundaries. Both locked npm archives are integrity checked; their code
was read without executing the SDK or validation/compiler paths.

[startup-language.csv](startup-language.csv) records 143 startup and language
occurrences: 62 catalog occurrences across 48 IDs, 25 direct prose/layout
occurrences, 38 displayed protected machine values and 18 dynamic boundaries.
The [scope table](startup-language-scope.csv) covers four reviewed source bodies
and distinguishes 21 internal errors caught or replaced by their callers.
Defensive helper errors and returned diagnostics without a proven display
consumer remain explicitly qualified rather than counted as ordinary screens.

[cli-entry.csv](cli-entry.csv) supplies 225 entry/startup records: 122 catalog
occurrences across 93 IDs, 35 fixed literals/display values and 68 imported or
dynamic boundaries. It traces bootstrap/main CLI dispatch, presentation and
runtime diagnostics. The [scope table](cli-entry-scope.csv) records parser
postconditions for defensive guards, source-only model guidance, and pending
report/error producers. A catalog value used only in a proved unreachable
guard remains in the English catalog rather than being counted as a normal
invalid-argument response.

[cli-startup-support.csv](cli-startup-support.csv) adds 52 helper records:
twelve catalog occurrences, 28 fixed/protected fragments and twelve boundaries.
Thirteen complete startup, policy, metadata, provider-adapter, output and shim
bodies cover 926 lines. The [scope](cli-startup-support-scope.csv) pins 28 sources;
all 262 AST string/template/regex nodes are partitioned against 222
[exclusions](cli-startup-support-exclusions.csv), with fifteen Error constructors
and five catches. Settings context-policy causes use default English on the
current caller while surrounding messages use its active catalog. Fast mode has
explicit print stdout and conditional native UI delivery. Dashboard read/save
causes, metadata corruption versus API guards, technical mode/build identities
and silent JSON fallbacks remain distinct. Resume rewriting requires one matching
string chunk; protected titles are subsequently filtered on current main. Native
resolver warning fields are discarded by the thinking-suffix helper. Five
corruption controls pass; no startup, file, provider, UI or stdout producer ran.

[host-ui.csv](host-ui.csv) adds 30 help/host-policy records: 14 catalog
occurrences, ten fixed or protected command/key/refusal occurrences and six
payload boundaries. Three complete bodies and all 65 lexical occurrences are
accounted for in the [scope](host-ui-scope.csv) and
[exclusions](host-ui-exclusions.csv). Help shortcut descriptions can also enter
native hotkeys after shortcut resolution. The nested-tool refusal becomes tool
result text through the native before-call hook. Argument compatibility defines
no own diagnostic prose; tool-list refresh failures are suppressed and other
callback/schema/native messages retain explicit boundaries.

[scrollback.csv](scrollback.csv) records 101 transcript-export occurrences:
67 fixed labels/placeholders/formats, 23 catalog occurrences and 11 payload
boundaries. Two complete bodies and all 231 lexical occurrences are covered in
the [scope](scrollback-scope.csv) and [exclusions](scrollback-exclusions.csv).
Conditions cover stored message roles, summaries, image placeholders, empty
content, capability/busy gates and terminal recovery. Custom messages marked
`display:false` still enter this export with a notice. System prompts, tool details
and raw image data are omitted from this plain-text route. Failure details are
cleaned and bounded; earlier notices or unavailable UI can suppress them. Native
HTML export has its own separate visibility and producer graph.

[doctor.csv](doctor.csv) supplies 548 report records: 287 catalog occurrences
across 185 IDs, 149 fixed or protected machine occurrences and 112 computed or
payload boundaries. It traces all 77 field labels, diagnoses, six lock contexts
and the shared report renderer. The [scope table](doctor-scope.csv) distinguishes
default-English JSON data from human output that resolves catalog descriptors
again in the active locale. Human formatting runs even when `--json` selects the
JSON result. Raw diagnostic producers remain explicit boundaries; caught errors
that are replaced or suppressed have separate dispositions. This pass reads
source without running doctor filesystem probes.

[updater.csv](updater.csv) records 212 update occurrences: 74 catalog occurrences
across 55 IDs, 108 fixed or protected machine occurrences and 30 dynamic
boundaries. The [scope table](updater-scope.csv) accounts for all 35 updater error
constructors and separates check/apply, startup, status, JSON, doctor and restart
consumers. Installed-verification errors are replaced by outcome messages;
ordinary startup failures report codes rather than their underlying messages.
The relaunch failure's inner sentence uses the default English catalog because
its caller omits the catalog argument. Child-process output and native/dependency
error producers remain explicit boundaries. No update operation was executed.

[profiles.csv](profiles.csv) adds 176 profile records: 49 catalog occurrences,
95 fixed or protected machine occurrences and 32 payload boundaries. Its
[scope table](profiles-scope.csv) covers the manifest loader, saved choice and
profile manager, with actual plan/apply, JSON, doctor and startup consumers.
Rows distinguish conflict previews from successful apply output, and raw saved
target/root-escape diagnostics from catalog errors. Three prompt patterns are
explicitly API-only because their helper has no production caller. Migration
and copied asset bodies retain separate producer boundaries.

[profile-migration.csv](profile-migration.csv) adds 133 migration records:
48 catalog occurrences across 32 IDs, 52 fixed or protected machine occurrences
and 33 payload boundaries. Both migration bodies are fully read in the
[scope table](profile-migration-scope.csv). It records plan/apply/rollback,
confirmation and receipt-validation conditions, plus the distinction between raw
JSON file-content lines and cleaned human previews. Rollback computes a fresh
plan before reading its receipt; failures in that preliminary work can prevent
the later notices. Renderer branches without a current planner producer and
settings-helper guards with proved caller preconditions remain excluded.

[catalog-settings.csv](catalog-settings.csv) records 364 Settings/deferral
occurrences: 232 catalog occurrences across 138 IDs, 77 fixed or protected
key/format occurrences and 55 payload boundaries. The
[scope table](catalog-settings-scope.csv) covers both complete bodies, actual
selector states, reload/error replacement and language-change attempts. Root
host observations are limited to streaming/tool signals; other injected activity
states are explicitly qualified. Several helper calls omit the catalog argument,
including logout formatting and login progress, and direct bearer-input English
is retained. Source/account/token/sync helper bodies remain separate producers.

[model-picker.csv](model-picker.csv) records 206 picker/state/ranking occurrences:
107 catalog occurrences across 88 IDs, 56 fixed or protected machine occurrences
and 43 dynamic boundaries. The [scope table](model-picker-scope.csv) covers three
complete bodies, recovery and doctor routes, selection/search/cycle consumers
and swallowed native-host fallback errors. Normal recovery generally replaces
parse details with a quarantine notice; doctor reads without recovery and can
retain those details. Recovery also matches `/regular file/` against an error
message, so translating that message requires preserving its control behavior.
Injected API guards and registration labels retain their qualified consumers.

[palette.csv](palette.csv) adds 66 frame/key-hint records: 57 fixed display,
glyph or format occurrences, four catalog definitions and five payload
boundaries. Two complete helper bodies and all 148 lexical occurrences are
accounted for in the [scope](palette-scope.csv) and
[exclusions](palette-exclusions.csv). Records distinguish rendered text from
width-only measurements, active tabs, scrolling markers and compact footer
fallbacks. `Unbound` is both a formatter result and a caller control sentinel;
translating its definition alone changes filtering/replacement behavior. Unknown
counts and missing factories retain their exported-helper activation conditions.

[keybindings.csv](keybindings.csv) records 98 configuration/command occurrences:
42 catalog occurrences across 34 IDs, 39 fixed or protected values and 17 payload
boundaries. Two complete bodies are covered in the
[scope table](keybindings-scope.csv). Conditions distinguish explicit CLI/doctor
errors, default-English bootstrap payloads, formatted conflict plans, rollback
replacement and portability warnings rendered again in the active human catalog.
Private-plan guards and manager descriptions without an owned display consumer
retain explicit exclusions. The bootstrap conflict summary has a qualified
external-file race trigger; native loaders and shared filesystem/lock errors
remain separate producers.

[model-catalog.csv](model-catalog.csv) supplies 490 source/catalog/sync/projection
records: 116 catalog occurrences across 89 IDs, 344 fixed or protected machine
occurrences and 30 payload boundaries. The
[scope table](model-catalog-scope.csv) covers four complete producer bodies and
two failure/response helpers, all 131 error/fail sites and 19 catches. It expands
schema diagnostics by their concrete field callers and distinguishes refresh
JSON, persisted human status, picker failed-source summaries and Settings
cancellation replacement. Several classifier calls use default English.
An exact `unexpected redirect` message comparison is recorded as translation
control coupling. Parser postconditions and returned-only diagnostics retain
explicit dispositions; account/token/OS/remote producers remain separate.

[auth-account.csv](auth-account.csv) records 65 Shisa account/auth occurrences:
42 catalog occurrences across 33 IDs, eight protected names/link/marker values
and 15 payload boundaries. Nine complete bodies and 12 supplemental native
consumers are pinned in the [scope table](auth-account-scope.csv). Settings login
progress and logout formatting include calls that default to English; outer
Settings errors can replace the underlying message. Onboarding compares a
storage error to the same catalog rendering, and its confirmation accepts English
`y`/`yes` tokens. Both translation-sensitive controls are recorded. Browser,
remote, filesystem and arbitrary callback wording remains separately bounded.

[launcher.csv](launcher.csv) records 406 occurrences and boundary records across
launcher dictionaries, frontend consumers, Rust failures and installer text.
Inactive dictionary entries are identified explicitly. Thirty-six native or
generated dependency boundaries have blank English fields in that initial table;
the dependency pass below supplies their individual dispositions.
[launcher-scope.csv](launcher-scope.csv) distinguishes
inspected source from pending helper messages, support logging and report facts.

[launcher-helpers.csv](launcher-helpers.csv) supplies the follow-on helper pass:
278 fixed source occurrences and 37 dynamic forwarding/masking records from all
43 packaging PowerShell/MJS helpers. Its
[scope table](launcher-helpers-scope.csv) supersedes the earlier pending helper
dispositions for those same source hashes; supporting callers remain partial.
Rows preserve raw source escapes, interpolations and the two constructed log
expressions rather than inventing flattened English. Conditions distinguish
direct operator output, frontend replacement messages, retained diagnostics and
acceptance-only fixtures. Generated installer dependencies remain separate.

[installer-dependencies.csv](installer-dependencies.csv) adds 234 records: 228
individual dependency definitions or raw compiler formats and six ownership or
substitution boundaries. All 36 original dependency boundaries are linked.
The [scope table](installer-dependencies-scope.csv) pins seven inert archives
through the locked Tauri, NSIS and dialog dependency chains. Each definition
records its page, feature, compile-time or runtime conditions; inactive defaults
remain identified. One misspelled LangString reference resolves to an empty
subtitle if compilation continues, rather than its similarly named upstream
English definition. Its compiler warning is suppressed at default Tauri
verbosity and forwarded in verbose builds. Native Windows resource wording and
remote response payloads remain explicit external boundaries. These are source
traces; no installer, compiler or native dialog was executed.

[launcher-support.csv](launcher-support.csv) adds 107 support records: 53 prose
or template occurrences, two protected values, 34 metadata/key/path/envelope
occurrences and 18 delivery boundaries. The
[scope table](launcher-support-scope.csv) covers all 20 native modules' non-test
bodies, eight frontend support modules, one helper and partial consumers. It
supersedes earlier pending support dispositions for those same source hashes.
Rows distinguish retained log lines, raw crash-card content, clipboard export
and backend report facts. The Report action opens the issues page; the backend
draft-facts API has no active frontend caller. Log retention and crash-file
limits are qualified by their actual best-effort I/O and naming behavior.

[pi.csv](pi.csv) records 925 inherited Pi source occurrences, with per-occurrence
conditions and 155 links to Jouzu catalog IDs.
[pi-boundaries.csv](pi-boundaries.csv) records 166 dynamic content boundaries.
[pi-scope.csv](pi-scope.csv) covers the 69 original candidate files, all with
fully read source bodies and explicit text,
no-prose, startup-gated or conditional-error dispositions.
[pi-exclusions.csv](pi-exclusions.csv) accounts for 3,725 exact lexical occurrences
in those 69 bodies, including imports, code tokens, layout and native output
suppressed by Jouzu's startup configuration. These dispositions do not establish
whole-product or runtime coverage. `source_text_json` preserves source whitespace
and control characters as a JSON string. [pi-evidence.json](pi-evidence.json) records the
exact Pi 1.4.0 archive integrity and comparisons with both installed trees:
66 scoped files match archive bytes and three match the pinned patch outputs.
Canonical English used by Jouzu's adapter is distinguished from untranslated
display text; command names and payloads retain their ownership boundaries.
Selector records distinguish host fallbacks, native startup and exported
consumers. Show-images/theme exported activation remains qualified; the wider
tool, RPC, SDK, export/viewer and other imported producer graph remains open.
Editor records distinguish content-row paste markers from border labels that
Jouzu's prompt frame replaces at widths of four columns or more. Tree search
aliases are excluded from visible wording when their only consumer is filtering.
Native login cancellation control signals and an overwritten loader initializer
also remain in the exclusions; exported callback/default activation is qualified
separately from the shipped consumers.
AgentSession records distinguish manual and automatic compaction, extension
errors, retry protocol fields and prompt content shown only in an expanded skill
invocation. Supplemental consumer hashes are recorded separately from the 69-file
canonical archive comparison.
InteractiveMode records include native help/session/debug-file prose, constructor
and event dispatch, startup/version gates and host overrides. Manual compaction
error, automatic status and migration-warning sinks have separate conditions.

[pi-compaction-text.csv](pi-compaction-text.csv) adds 16 inherited compaction,
branch-summary and usage-label definitions, with 13
[boundaries](pi-compaction-text-boundaries.csv) and 179 exact
[exclusions](pi-compaction-text-exclusions.csv). Six complete runtime bodies cover
1,359 lines and 195 string/template occurrences; twelve directory declarations
and maps have nonruntime dispositions in the
[scope](pi-compaction-text-scope.csv). Canonical comparison checks 29 assets:
20 match archive bytes and nine match pinned source patches, with no unexplained
difference. Thirty-four prior sink records are crosslinked without duplication.
Accepted summaries can persist branch preambles, split-turn headings and empty
history/content text; standalone request instructions and conversion prefixes
remain qualified by their separate request/observer routes. The nonempty branch
preamble excludes the final empty-summary fallback. Error records distinguish
compaction-end painting from independent callback notifications/RPC rejection.
Seven in-memory corruption controls pass. No model, native, parser, export or
state operation was executed; provider/retry/transitive helper bodies remain open.

[pi-tui-utilities.csv](pi-tui-utilities.csv) adds eight inherited utility
occurrences: seven conditional colour diagnostics and one image fallback wrapper,
with eleven [boundaries](pi-tui-utilities-boundaries.csv). Seven complete bodies
cover 2,768 lines; 376 string/template occurrences are partitioned against 368
[exclusions](pi-tui-utilities-exclusions.csv). The
[scope](pi-tui-utilities-scope.csv) also records 31 protected regexes, 50 control
literals, 25 new expressions, nine Error/throw sites and five catches. Theme
string validation, guarded numeric APIs, fullscreen screen parsing and image
fallbacks keep their distinct activation conditions. Jouzu's replacement header
does not provide the stock logo click activation. Canonical checks cover 48
runtime/support/nonruntime assets: 45 match archive bytes and three match pinned
patches. The resolved external width helper is 1.6.0 in both installed trees; the
shadowed CLI dependency path lacks an exact entry in the main lockfile, so its body/archive and
broader dependency coverage remain open. Eight corruption controls pass; no
terminal, image, child, native or rendering operation was executed.

[pi-tui-engines.csv](pi-tui-engines.csv) adds 21 inherited renderer occurrences:
seven clipboard/composed-error fragments and fourteen conditional diagnostic-file
outputs, with eleven [boundaries](pi-tui-engines-boundaries.csv). Three complete
bodies cover 3,276 lines and 367 string/template occurrences, partitioned against
346 [exclusions](pi-tui-engines-exclusions.csv). The
[scope](pi-tui-engines-scope.csv) records eleven regexes, 82 control literals,
26 new expressions, one composed Error/throw and three catches. Clipboard
callback true/string/fallback cases have separate native/API activation. The
width diagnostic is reached only on the guarded differential-render path;
initial/full redraws bypass it, and earlier crash-file/stop failures can replace
it. File wording retains exact debug flags, write success, append/overwrite and
user-inspection conditions. Canonical checks cover 22 assets: nineteen match
archive bytes and three match pinned patches. Ten corruption controls pass;
input/native helpers follow below; external dependencies remain open. No terminal,
clipboard, file-writing, child or rendering operation was executed.

[pi-tui-input.csv](pi-tui-input.csv) adds 56 inherited occurrences: nine search
overlay labels and 47 descriptions in the shipped keybinding schema, with ten
[boundaries](pi-tui-input-boundaries.csv). Ten complete terminal, input, key,
search, status and native-loader bodies cover 2,823 lines. All 903 string/template
occurrences are partitioned against 847 [exclusions](pi-tui-input-exclusions.csv).
The [scope](pi-tui-input-scope.csv) accounts for twenty regexes, 206 control
literals, sixteen new expressions and ten catches, with no local Error/throw.
Search activation, empty/whitespace queries, platform key names and responsive
controls have separate guards. Schema descriptions have a pinned-file/editor
sink; no current remote schema contents or terminal-description paint is assumed.
Raw terminal logs add no English caption. Canonical checks cover 49 assets:
48 match archive bytes and one matches a pinned patch. Ten corruption controls
pass; native addons, terminal clients and transitive dependencies remain open.
No input, terminal, native or file-writing producer was executed.

[pi-tui-text-support.csv](pi-tui-text-support.csv) adds four conditional math
display fragments, with ten [boundaries](pi-tui-text-support-boundaries.csv).
Eight complete autocomplete, fuzzy, math, word-motion, kill/undo and export bodies
cover 2,396 lines and 1,160 string/template occurrences, partitioned against 1,156
[exclusions](pi-tui-text-support-exclusions.csv). The
[scope](pi-tui-text-support-scope.csv) accounts for 39 regexes, six control
literals, eighteen new expressions and four catches, with no local Error/throw.
Math wording requires enabled, completed and successfully parsed Markdown math;
raw fallbacks, condition prefixes and original session/export content retain
separate guards. Command/path suggestions preserve caller data, and fd stderr
has no local forwarder. Canonical checks cover forty assets: 39 match archive
bytes and one matches a pinned patch. Eleven corruption controls pass; external
parsers, native/process/Intl and resolved width dependencies remain boundaries.
No math renderer, autocomplete, child, native or callback code was executed.

[pi-tools.csv](pi-tools.csv) supplies 172 inherited tool/helper occurrences,
with 27 [payload boundaries](pi-tools-boundaries.csv). Its
[scope table](pi-tools-scope.csv) covers 37 complete source bodies: 24 tool and
renderer modules plus 13 shared process, image, path, download and output helpers.
[Exclusions](pi-tools-exclusions.csv) account for the other 1,083 lexical
occurrences. Native rendering suppresses several success messages that remain in
JSON/RPC or exported results; shell footer replacement and edit-preview errors
have separate conditions. Model-only descriptions, guarded API errors and disabled
tool modes are explicitly qualified. The [evidence](pi-tools-evidence.json) ties
36 files to exact archive bytes and one to the pinned path patch. Imported native,
HTTP and WASM error text remains a boundary; the wider Pi producer graph is open.

[pi-runtime.csv](pi-runtime.csv) adds 83 runtime/argument/SDK/RPC occurrences and
31 [payload boundaries](pi-runtime-boundaries.csv). Seven complete source bodies
are covered in the [scope table](pi-runtime-scope.csv), with 541 lexical
[exclusions](pi-runtime-exclusions.csv). Explicit `jouzu pi --help` and version
forwarding can reach inherited English; root help and startup setup have different
host gates. RPC response data, direct API returns and terminal diagnostics retain
separate delivery conditions. The [evidence](pi-runtime-evidence.json) verifies
two archive-identical bodies and five pinned patch outputs. Imported auth,
session, package, viewer and engine-owned diagnostics remain separate producers.

[pi-auth-model.csv](pi-auth-model.csv) adds 64 inherited authentication/model
occurrences and 19 [payload boundaries](pi-auth-model-boundaries.csv). Seven
complete bodies and all 354 lexical occurrences are covered in the
[scope](pi-auth-model-scope.csv) and 290
[exclusions](pi-auth-model-exclusions.csv). Auth checks replace some resolver or
read-only storage details with a status code; credential-printing commands retain
their errors. Virtual-model routes, optional SDK returns and an exported restore
helper have separate activation conditions. The
[evidence](pi-auth-model-evidence.json) verifies six archive-identical bodies and
one pinned patch output; imported provider, catalog and native-lock errors remain
separate producers. Credential values and remote account content are protected.

[pi-session-config.csv](pi-session-config.csv) adds 49 inherited session/settings/
resource occurrences and 21 [payload boundaries](pi-session-config-boundaries.csv).
Ten complete bodies and all 700 lexical occurrences are covered in the
[scope](pi-session-config-scope.csv) and 651
[exclusions](pi-session-config-exclusions.csv). Scan limits caught by their callers,
session invariants, prevalidated setters and collision metadata have distinct
dispositions. The [evidence](pi-session-config-evidence.json) verifies seven
archive-identical bodies and three pinned patch outputs. Package-manager, skill,
prompt, extension, native and schema error producers remain separately open.

[pi-packages.csv](pi-packages.csv) records 114 inherited package/config command
occurrences and 24 [payload boundaries](pi-packages-boundaries.csv). Six complete
bodies and all 829 lexical occurrences are accounted for in the
[scope](pi-packages-scope.csv) and 715
[exclusions](pi-packages-exclusions.csv). Command dispatch gates, progress events,
suppressed probes and inherited child output have separate conditions. The
[evidence](pi-packages-evidence.json) verifies all six bodies against exact archive
bytes. Git/version/config, npm/native/installer, skill/prompt and extension error
producers remain separate; no package operation was executed.

[pi-resource-text.csv](pi-resource-text.csv) records 71 inherited resource and
extension occurrences and 23 [payload boundaries](pi-resource-text-boundaries.csv).
Fourteen complete bodies contain 543 lexical occurrences, partitioned with 472
[exclusions](pi-resource-text-exclusions.csv). The
[scope](pi-resource-text-scope.csv) includes the entire eight-file core extensions
JavaScript directory plus skills, prompt templates, MCP server discovery,
execution, source information and frontmatter helpers. Eleven bodies match the
locked archive and three match pinned patches. Conditions distinguish retained
versus content-policy-suppressed resource warnings, extension callbacks and schema
validation. Five skill instruction fragments have persisted System Prompt export
routes; forced request text and recorded sections remain distinct. The
[evidence](pi-resource-text-evidence.json) keeps bounded export support separate
from full export-template coverage. Tool metadata corrections for earlier Pi
partitions follow below; transitive loaders, parsers and native errors remain open. No
extension, command, server or resource execution was performed.

[pi-export-metadata.csv](pi-export-metadata.csv) corrects earlier inherited
metadata dispositions with 44 conditional visual occurrences: seven tool
descriptions, 21 top-level input descriptions, eight prompt snippets and eight
guidelines. The [scope](pi-export-metadata-scope.csv) accounts for all 125 prior
candidate occurrences. Two nested descriptions remain serialized without recursive
visual rendering; two output-schema descriptions are omitted by direct export;
76 configuration-schema descriptions have no active-tool export lineage; one SDK
image placeholder belongs to request conversion. Prior IDs, English and source
anchors are preserved. Conditions distinguish current active tool metadata from
persisted prompt text, which may retain earlier recorded sections after a tool is
deactivated. Section overrides, custom prompts, loadout replacements, guideline
deduplication and viewer expansion are explicit. Twenty canonical source snapshots
have archive or pinned-patch proof; these are bounded route sources, not new
whole-body coverage. Export asset bodies continue in the next unit; other prompt
producers remain open. No product or browser code was executed.

[pi-export-text.csv](pi-export-text.csv) records 121 export/prompt occurrences:
62 direct lexical nodes and 59 individually anchored embedded HTML captions or
attributes. Seven complete native bodies cover 3,798 lines. All 802 JavaScript,
static HTML and CSS occurrences are partitioned with 740
[exclusions](pi-export-text-exclusions.csv); 13
[payload boundaries](pi-export-text-boundaries.csv) distinguish file/live export,
current prompt replay, renderer failures and browser/vendor data. Records include
search and filter text, titles, placeholders, accessibility labels, role/summary
captions, hidden/expanded state, parameter hints and all four Error constructor
headlines with their actual CLI/TUI/RPC/API sinks. Clipboard console diagnostics
are console-only. [Scope](pi-export-text-scope.csv) pins 19 assets: seven full native
bodies, nine nonruntime declaration/maps and three vendor bodies followed below. Eighteen
assets match the locked archive and system-prompt matches the pinned patch. The
Markdown parser/highlighter body review follows below; no browser, DOM,
renderer or parser code was executed.

[pi-export-vendor.csv](pi-export-vendor.csv) records 11 conditional browser
console/error definitions and ten [boundaries](pi-export-vendor-boundaries.csv)
from three complete vendor bodies: 1,300 lines and 171,121 bytes. All 4,869
string/template nodes are partitioned with 4,858
[exclusions](pi-export-vendor-exclusions.csv); 1,028 regex literals and 36 grammar
factories have independent protected censuses. Twenty-three Error constructors
and composed-message builders are accounted for. Eight actual viewer API calls
bound the routes. Library/custom-grammar diagnostics retain their guarded
conditions; inactive silent/DOM/deprecated APIs are qualified separately. Native
highlight catches, console output and unhandled Markdown type guards have distinct
sinks. [Scope](pi-export-vendor-scope.csv) closes the earlier three vendor-body
boundaries and pins four supporting native sources, with exact archive/pinned-patch
proof for all seven. No parser, highlighter, DOM or browser code was executed.

[flow-display.csv](flow-display.csv) records 94 occurrences in the Flow status
extension and message renderer: 57 direct wording occurrences, 29 catalog
occurrences and eight dynamic boundaries. It includes notices, invalid-command
help, failures, recovery and count/plural states. The
[scope table](flow-display-scope.csv) limits this pass to those two display
modules and selected supporting paths; report, admission, receipt and store
producers still need their own wording inventory.

[flow-report.csv](flow-report.csv) adds 104 report/source-description records,
including 78 catalog occurrences, sender labels, derived failure-stage words
and 20 payload boundaries. Each records the conditions for withheld requests,
recovery decisions, read failures, waiting dependencies, held input, task
metadata and pagination. [flow-report-exclusions.csv](flow-report-exclusions.csv)
retains 47 comparison-only, defensive or context-free occurrences with their
source conditions. The production formatter passes source context and bypasses
the context-free branch. The [scope table](flow-report-scope.csv) records three
fully read modules and bounded supporting consumers; the underlying diagnostic,
task and stored-reason producers remain separately in scope.

[flow-storage.csv](flow-storage.csv) records 79 storage and attachment occurrences:
67 fixed error or replacement-marker occurrences, two catalog occurrences and
ten payload boundaries. The [scope table](flow-storage-scope.csv) covers seven
fully read storage/ownership bodies plus supporting consumers.
[flow-storage-exclusions.csv](flow-storage-exclusions.csv) completes the partition
of 287 lexical occurrences, including two caught/replaced preflight errors and
private backend guards. Specific journal-header diagnostics are qualified by
the earlier identity check, which normally replaces them with a metadata error.
Rows distinguish the original append failure from later fence errors, cleanup
headlines from retained causes, and sanitized `/flow` notifications from raw
stderr messages. This does not close the other stores or native error producers.

[flow-receipts.csv](flow-receipts.csv) supplies 96 receipt/retention records:
82 fixed errors, four stored catalog reasons and ten payload boundaries. Seven
complete ledger, adapter, retention and identity-helper bodies are covered in
the [scope table](flow-receipts-scope.csv), with all 402 lexical occurrences
partitioned between fixed records and
[exclusions](flow-receipts-exclusions.csv). Validator errors retain their own
messages through the ledger wrapper; two non-Error fallback catalog branches
have no current plain-state producer. A serialized second-header-read guard is
also excluded with its storage precondition. Stored caller reasons and imported
admission/request/tool failures still require their own producer traces.

[flow-waits.csv](flow-waits.csv) adds 81 wait-storage/reducer/result records:
72 fixed occurrences and nine payload boundaries. Five complete bodies are
covered in the [scope table](flow-waits-scope.csv); all 310 lexical occurrences
are partitioned between those records and 238
[exclusions](flow-waits-exclusions.csv). Rows distinguish stored cancellation and
lifecycle reasons, tool summary formats, receipt checks, retirement failures and
deadline callbacks. Two initialization guards are excluded by the successful
attachment lifecycle. Other defensive APIs retain their precise conditions.
Tool results, cleaned `/flow` warnings, raw runtime stderr and direct API data
have separate consumers. Authority, health and producer helper wording remains
separate; this unit does not close the full wait graph.

[flow-wait-authority.csv](flow-wait-authority.csv) records 30 authority/health
errors and five payload boundaries across three complete bodies. All 141 lexical
occurrences are accounted for in the [scope](flow-wait-authority-scope.csv) and
[exclusions](flow-wait-authority-exclusions.csv). Conditions cover work ownership,
execution evidence, policy validation and monitor failures. Three returned health
reason templates have no owned display consumer: the monitor retains only their
verdict state and schedules the next check. Original producer detail, lifecycle
reasons, callback errors and native failures retain separate transport boundaries.

[flow-wait-producers.csv](flow-wait-producers.csv) adds 47 fixed errors and nine
payload boundaries for the producer registry, execution subscriptions and wait
decisions. Two complete bodies and all 176 lexical occurrences are covered in the
[scope](flow-wait-producers-scope.csv) and
[exclusions](flow-wait-producers-exclusions.csv). Restored-source warnings retain
the original error as a cause; subscription cleanup can replace startup failure.
Observation reporting can retain an aggregate headline and both causes. Readiness
and validated-snapshot preconditions exclude two internal errors. Serialized wait
decisions are model input; arbitrary stored reasons and imported producer errors
remain separately qualified.

[flow-model-input.csv](flow-model-input.csv) adds 46 composition/request-helper
records: 29 fixed error definitions, two protected JSON frame templates, five
diagnostic replacement/suffix formats, one retained reason and nine boundaries.
Six complete bodies cover 702 lines. The
[scope](flow-model-input-scope.csv) pins 16 sources, with all 209
string/template/regex nodes partitioned against 172
[exclusions](flow-model-input-exclusions.csv); 29 Error constructors and six
catches have exact dispositions. Controller held/deferred reasons are inspection
state, with no direct ordinary display established. Native request failures have
separate retention/report conditions. Queued visible custom messages retain raw
frames; terminal summaries hide them until expanded or unrecognized. Redaction
markers/capture syntax and JSON grammar stay protected. Ledger preparation and
withholding can replace earlier failures; optional/native callbacks remain
qualified. Four corruption controls pass without product/state/parser execution.

[native-request-state.csv](native-request-state.csv) adds 75 retained-request
records: 66 fixed Error message occurrences and nine payload/native boundaries.
Four complete bodies cover 1,355 lines, with 11 pinned sources in the
[scope](native-request-state-scope.csv). All 283 string/template/regex nodes are
partitioned with 217 [exclusions](native-request-state-exclusions.csv). Every
Error has its exact nearest source guard; these bodies have no catches. Records
distinguish Flow status read warnings, repair-command notifications, lifecycle
rejections and reconciliation callbacks. Snapshot inspection can run transactional
validation/index repair; the inventory never invokes it. Optional failure text
can be dropped at the byte budget, while projection views can retain explicit
custom/tool-result content. Stored hashes, status codes and retention IDs remain
protected; forwarding alone does not establish a visual publisher. Four
corruption controls pass without product/store/native execution.

[flow-request-policy.csv](flow-request-policy.csv) adds 34 provider/payload/cache
records: 25 fixed diagnostic definitions and nine API/native boundaries. Four
complete bodies cover 317 lines, with seven pinned sources in the
[scope](flow-request-policy-scope.csv). All 109 string/template/regex nodes are
partitioned against 84 [exclusions](flow-request-policy-exclusions.csv); 26 Error
constructors and three catches are accounted for. The Google signal sentinel is
replaced, while cache capture and native refresh suppress their failure headlines
in the ordinary route. Provider-route and payload-copy errors have separate
preparation/admission publishers. Generic JSON callbacks, Bedrock binary/data
rules, cancellation handling and hook restoration keep their conditions. One
bounded native consumer matches the exact public patch after hash and both
installed Pi1.4.0 trees; its full body remains pending. Four corruption controls
pass without product/provider/payload/cache/state execution.

[native-request-transport.csv](native-request-transport.csv) adds 61 request/turn
records: 46 fixed/protected occurrences, five catalog occurrences and ten payload
boundaries. Four complete bodies cover 1,023 lines, with 17 pinned sources in the
[scope](native-request-transport-scope.csv). All 196 lexical occurrences are
partitioned against 150 [exclusions](native-request-transport-exclusions.csv),
including two request-only tool-history notices. Thirty-eight Error constructors
and seven catches retain exact source/forwarding dispositions. The default model
projection leaves saved transcript messages unchanged. Admission causes take
precedence over no-admission wrappers; storage/cleanup callbacks can replace
thrown errors. Conversational and maintenance retention/publication remain
separate. Pause text has shared equality/prefix classifiers, and settled provider
pauses honor current-run, enabled and aborted gates. Three qualified native consumer sources
trace raw failures into assistant error painting and text stderr; no new native body closure is
claimed. Four corruption controls pass without requests, models, UI or state
execution.

[session-primitives.csv](session-primitives.csv) adds 26 formatting/boundary
records: 18 protected frame/spacing/ANSI compositions and eight caller, native,
callback or forwarding boundaries. The
[scope](session-primitives-scope.csv) covers seven complete helper/barrel/shim
bodies, 517 lines and 14 pinned sources. All 297 string/template/regex nodes are
partitioned, with 279 [exclusions](session-primitives-exclusions.csv); these bodies
have no own Error constructors or catches. Frame defaults, tiny/zero widths,
terminal-control removal, optional colour probes and live appearance lookup keep
their conditions. Helper composition introduces no fixed English words. Caller
labels and native Pi width/theme implementations remain separate producers.
Four in-memory corruption controls verify rejection without executing renderers.

[session-ui-text.csv](session-ui-text.csv) adds 108 Session UI records:
78 catalog-definition/consumer occurrences across 74 IDs, eleven fixed/protected
occurrences and nineteen payload boundaries. Seven complete bodies cover 1,425
lines. The [scope](session-ui-text-scope.csv) pins 17 sources and accounts for
579 lexical tokens, 74 ID definitions, 23 formatter accesses, 21 exact English
ownership matchers, three catches and two rejected-probe handlers. Dictionary
membership is distinguished from conditional editor/footer/dashboard consumers.
The injected catalog supplies wording; brands, numeric notation and the local
workspace fallback retain separate ownership. Probe rejection causes are replaced
by health state; registry catches retain ownership evidence or allow the exit
alias. Full prompt/dashboard/probe-source bodies follow below;
no UI, probe, child, native or product operation was executed.

[session-ui-components.csv](session-ui-components.csv) adds 109 records:
68 catalog occurrences across 67 IDs, 21 fixed/protected occurrences and twenty
payload boundaries. The [scope](session-ui-components-scope.csv) covers nine
complete editor, dashboard and probe-source bodies, 1,215 lines and 18 pinned
sources. It accounts for 401 lexical tokens, one Error site and eleven catches.
Together with the preceding two units this covers all twenty Session UI source
bodies; CLI activity and work-source producers follow below. Slash-description
ownership, dashboard counts and state words, duplicate-source API errors and
probe rejection versus nonzero-exit behavior retain distinct conditions. The
default editor bypasses its SessionLine callback below four columns; standalone
formatters have separate width guards. No UI, probe or native code was executed.

[session-ui-producers.csv](session-ui-producers.csv) adds 28 CLI activity and work
projection records: three catalog calls, twelve fixed/protected occurrences and
thirteen payload boundaries. The [scope](session-ui-producers-scope.csv) covers
two complete bodies, 327 lines, seventeen source hashes and 124 lexical tokens.
Twenty-one prior full-body crosslinks preserve Session UI and subagent dashboard
ownership. Plural subagent/job text and the English loop-status regex have
separate translation/control conditions. Stale retained units can still affect
counts; swallowed claim/release errors, task detachment, source-read retention,
responsive detail slots and snapshot-time labels keep their distinct guards.
These bodies add no direct print/JSON/RPC writer. Flow/task/background upstream
orchestration remains separately bounded; no UI, callback, claim event, inventory
read, child or native producer was executed.

[workflow.csv](workflow.csv) records 210 Workflow items: 167 catalog occurrences,
11 fixed or protected occurrences and 32 payload boundaries. The
[scope](workflow-scope.csv) covers the complete 1,327-line component and 35-line
model-display helper, including every catalog use, five Error sites and eight
catches. Conditions distinguish empty configurations, model fallback labels,
transcript detail, copied agent IDs and required-form invariants. Default role
descriptions and instructions have editor consumers; their producer definitions
follow in the subagent unit below. The component does not own a stdout route: bounded integration
traces distinguish the non-TUI `/workflow` notification from the `/subagents`
print-mode JSON summary. No UI, worker, state or native operation was executed.

[subagent-runtime.csv](subagent-runtime.csv) adds 199 role/manager/integration
records: 95 catalog occurrences across 76 IDs, 73 fixed occurrences and 31 payload
boundaries. Seven complete bodies cover 2,224 lines. The
[scope](subagent-runtime-scope.csv) accounts for 764 lexical tokens, 85 catalog
references, 77 Error sites and 23 catches, with 29 pinned sources. Default role
instructions/descriptions have editor consumers; prompt/tool export routes retain
their conditions. Records distinguish storage failures, API/schema guards,
delayed messages, raw/default-English model labels and active TUI labels. The
standalone dashboard widget is guarded on the current main route. Standard
print/json notify suppression and native onError stderr delivery remain separate.
Worker/output/resource helper bodies are covered by the follow-on unit below. No worker,
model, git snapshot, state or native operation was executed.

[subagent-output.csv](subagent-output.csv) adds 197 output/context records:
93 catalog occurrences across 64 IDs, 76 fixed occurrences and 28 payload
boundaries. Ten complete bodies cover 1,972 lines. The
[scope](subagent-output-scope.csv) accounts for 622 lexical tokens, 76 catalog
references, 30 Error sites and 13 catches, with 27 pinned sources. Saved custom
context has transcript/export consumers; structured system metadata is retained
for export but omitted from trace text. Trace notices/errors reach the trace tool
operation; child tool events have a separate indirect saved-trace route. Language
report parsing couples its tag and contract/requested fields to control flow.
Cancellation records qualify the receiver's terminal-state guard. Worker resource
failures and provider causes retain their separate replacement/delivery rules.
No worker, model, state, native or UI operation was executed.

[voice-text.csv](voice-text.csv) adds 95 voice records: 66 catalog occurrences
across 46 IDs, 11 fixed/protected occurrences and 18 payload boundaries. The
[scope](voice-text-scope.csv) covers all six voice bodies, 1,076 lines and 16
pinned sources, accounting for 279 lexical tokens, 54 catalog references, 42 error
producers and 13 catches. Records distinguish active-catalog VoiceError rendering
from replacement/suppression during cancellation, capture stop and transcript
review. Footer status selects display text through Fluent branches; its state
keys stay protected. Draft markers, redaction, argument completions and native
hotkey help retain concrete consumers. TUI/terminal guards and non-TUI notification
behavior remain explicit. ASR text, device names and native/provider errors are
separate payload/dependency boundaries. No microphone, worker, WebSocket, model,
native or UI operation was executed.

[flow-tools.csv](flow-tools.csv) supplies 36 wait/no-reply tool records: 24 fixed
occurrences, three catalog labels and nine payload boundaries. Four full bodies
and all 234 lexical occurrences are accounted for in the
[scope](flow-tools-scope.csv) and [exclusions](flow-tools-exclusions.csv).
Validation conditions identify argument fields, deadlines, copied dependency
identity, branch changes and cancellation. The success result of no-reply remains
visible transcript text. Parsed-dependency and nonempty-ledger preconditions
exclude two guarded diagnostics. Model guidance and schema descriptions have
conditional export routes in the follow-up below; optional client presentation
remains separate.

[flow-metadata.csv](flow-metadata.csv) follows 26 earlier model-metadata records
through native live-session HTML export: 23 conditional visual occurrences and
three nested parameter descriptions retained in embedded data without native
visual rendering. Exact prior IDs and English are preserved. Active tool
selection, allowed/excluded filters, description replacements, hidden declarations,
custom prompts and later section overrides have distinct conditions. Exported
System Prompt text comes from persisted transcript state; a forced request prompt
can differ. The [scope](flow-metadata-scope.csv) pins 14 bounded producer/consumer
sources. It does not close the full HTML template, standalone export or optional
client rendering. No product or browser code was executed.

[prompt-text.csv](prompt-text.csv) records 78 fixed prompt definitions or format
fragments and five payload boundaries. All 121 lexical occurrences in
`presentation.ts` lines 154-368 and the complete model-guidance/prompt-sections
helpers are partitioned with 43 [exclusions](prompt-text-exclusions.csv). This
supersedes the earlier CLI-entry prompt-body exclusion. The
[scope](prompt-text-scope.csv) pins 15 producer/consumer sources. Export conditions
cover Jouzu identity and guidance, capability table rows, tool rules, documentation
paths, local date and model-specific instructions. Each route retains its selected
tool, available skill or model predicate. Custom/forced prompt guards and later
section replacements can suppress or change the recorded text. Child addendum
use is qualified by its separate consumer; caller-authored language sections,
Intl output and imported validation remain distinct producer boundaries. No
prompt, browser, model or native code was executed.

[language-contract-text.csv](language-contract-text.csv) records 17 fixed language
contract occurrences and five payload boundaries. The complete 462-line body and
all 81 lexical occurrences are partitioned with 64
[exclusions](language-contract-text-exclusions.csv). Four language names and
conversational/artifact instructions have conditional persisted-prompt export
routes. Artifact policy still adds instructions with response language `auto`;
legacy resumed state may omit that policy. Resume, staged input changes,
compaction and tree navigation have separate timing conditions. The unused
private preserve-language name is guarded; the sole local Error is qualified by
a direct API call before session start, with no production caller found.
[Scope](language-contract-text-scope.csv) records 14 source pins and distinguishes
native append/hash/clock failures and protected epoch data. No session, clock,
crypto or native operation was executed.

[pi-ui-adapter.csv](pi-ui-adapter.csv) records 193 catalog-definition/recognition
occurrences across 154 IDs and nine matching, fallback or error boundaries. The
complete 1,220-line adapter has 350 string/template nodes partitioned with 157
[exclusions](pi-ui-adapter-exclusions.csv). English matching-key occurrences are
qualified separately from replacement text. Records identify owned settings and
selector lists, temporary label/description changes, bilingual search, shortcut
extraction, OAuth suffixes, trust captions, resume headers, fork positions and
tree prompts. Exact compaction error matching and native English catalog matching
are translation-control dependencies. Fixed-English bypass, dynamic getter
fallback to the initial bundle, suppressed trust import errors and restoration
failures have explicit conditions. [Scope](pi-ui-adapter-scope.csv) pins 21 sources,
including 17 native snapshots linked to prior canonical archive evidence. This
adapter does not localize arbitrary extension output or HTML exports. No terminal,
product or browser code was executed.

[session-label-text.csv](session-label-text.csv) records 29 catalog definitions,
nine fixed or qualified API occurrences and 13 payload boundaries across the
session-label, label-policy and tmux helpers. Three full bodies contain 828 lines
and 264 string/template nodes, partitioned with 226
[exclusions](session-label-text-exclusions.csv). All 30 catalog-alias uses, seven
Error sites and eight catches are accounted for. Conditions distinguish `/labels`
status/help, policy save failures, model/ownership gates and default pane labels.
Automatic naming suppresses its raw model/parse errors; direct helper API errors
retain their qualified conditions. A separate model request does not itself add
its naming prompt to the main transcript. Native print/json notifications are
no-ops; RPC notifications remain client requests. Default tmux failures return
failure or are suppressed, with a conditional user warning. The
[scope](session-label-text-scope.csv) pins 11 sources. No model, git, tmux, session
or native operation was executed.

[human-fallback.csv](human-fallback.csv) records 45 English resolver templates,
two qualified helper Error messages and four forwarding boundaries. The complete
225-line resolver and 30-line terminal re-export shim contain 114 string/template
nodes, partitioned with 67 [exclusions](human-fallback-exclusions.csv). Source
fallback templates use `{argument}` syntax; their related Fluent IDs use a
separate formatter. All 36 parser constructor calls supply the required values.
Ordinary CLI handling rerenders retained descriptors with its catalog, while
external parser/resolver consumers can inspect raw English `Error.message` or
returns. Templates with no current parser constructor caller are explicitly
qualified; table membership alone does not establish a display gap. The shim
adds no human prose and does not close its forwarded layout/color modules.
[Scope](human-fallback-scope.csv) pins five source bodies. No resolver, parser or
terminal code was executed.

[python-console.csv](python-console.csv) records 30 occurrences and boundaries
for the separate Python console package, including 11 inherited `argparse`
patterns. [python-console-observations.json](python-console-observations.json)
contains 16 safe command observations with runtime-valued doctor fields replaced
by placeholders. The [scope table](python-console-scope.csv) identifies the two
owned modules and exact inspected CPython 3.12.11 `argparse` source hash.
That is a reference interpreter with C locale and captured 80-column output;
the package permits Python >=3.10, so these observations do not qualify the
whole supported interpreter range or its locale resources. Native exception and
output-stream failures remain explicit runtime boundaries.

[operator-scripts.csv](operator-scripts.csv) records 500 operator/test/CI script
items: 98 wording occurrences, eight display-format templates, 361 protected or
internal literal dispositions and 33 delivery boundaries. All 467 nonempty
literals across twelve complete bodies are anchored in the
[scope table](operator-scripts-scope.csv). Conditions distinguish child TAP and
native errors, replaced smoke-test details, saved timing/build/path facts and
GitHub output values. The root candidate census identifies 81 command/helper
paths: these twelve, one separately covered TextGuard build helper and 68
candidates addressed by follow-on passes below. Scope references for pending
paths do not claim their text is reviewed.
No operator scripts, CI setup or native security commands were executed.

[build-scripts.csv](build-scripts.csv) adds 1,136 build/patch records: 844
top-level literal occurrences, 268 individually anchored nested generated-code
literals and 24 payload boundaries. The [scope](build-scripts-scope.csv) covers
18 complete bodies, eight locked patch manifests and 13 copied-source hashes.
Records distinguish operator errors/status, old match anchors, installed generated
wording, protected code/state values and unused-helper APIs. Nested literals retain
their exact escaped locations without evaluating interpolations or transforms.
The remaining 50 root candidates continue in follow-on units; copied runtime
bodies and delegated branding/error producers retain separate wording boundaries.

[copied-runtime.csv](copied-runtime.csv) adds 686 copied-runtime records: 507
primary literal/template/regex occurrences, 157 nested JSON-code occurrences and
22 delivery boundaries. The [scope](copied-runtime-scope.csv) covers all 13
copied bodies, 42 individual before/after pairs, five manifest pins and 13 copied
source hashes. Records distinguish retained result titles, warnings and lifecycle
reasons, log-loss markers, canonical validation failures and suppressed probe or
matcher errors. Partial generated-template tails are classified only after their
complete recipes are checked. Declaration-only types contain no runtime output.
The target diagnostics helper remains an unresolved consumer; these records do
not assert a stderr route or close uncopied target dependencies. No runtime,
transform, probe or state operation was executed. Root-script follow-ups continue
below.

[release-scripts.csv](release-scripts.csv) adds 1,069 release/package records:
966 primary literal/regex occurrences, 12 protected hashbang headers, three nested
literals, 52 default/dynamic assertion boundaries and 36 other delivery boundaries.
The [scope](release-scripts-scope.csv) covers 18 complete bodies, 2,092 lines and
128 pinned source hashes. Conditions distinguish operator errors, protected
receipt/fingerprint fields, input-source match guards, registry checks, retries,
child output and the deliberate broken-CLI smoke fixture. Native assertions and
JSON/filesystem/network exceptions retain their exact call/argument boundaries.
Its root census snapshot partitions 81 scripts into these 18, 31 previously covered
bodies and 32 candidates continued in following units. No publication, registry, install, native or network
operation was executed.

[build-integration.csv](build-integration.csv) adds 1,237 integration/build records:
875 primary literal/regex occurrences, 11 protected hashbangs, 315 nested source
occurrences and 36 delivery boundaries. The
[scope](build-integration-scope.csv) covers 15 complete bodies, 3,083 lines and
140 source hashes. It distinguishes old patch matches, generated installed text,
String.raw regex fragments, copied data, operator failures and diagnostics
replaced by runtime catches. Thirty-five policy targets and exact deviation,
after/copy hashes are checked. No default Node assertion producer occurs in these
bodies. That root partition snapshot has 64 covered scripts and 17 pending, continued below; six upstream
copied/delegated bodies retain explicit separate boundaries. No transform,
installation, runtime, native or network operation was executed.

[validation-scripts.csv](validation-scripts.csv) adds 715 validation/review-script
records: 658 primary literal/regex occurrences, six protected hashbangs, 14 nested
literals, 13 assertion boundaries and 24 other delivery boundaries. The
[scope](validation-scripts-scope.csv) covers six complete bodies, 1,899 lines and
136 pinned source hashes. Records distinguish source-matching text, generated
API probes and review samples from operator diagnostics and returned audit
results. Native assertion messages and child/process/filesystem failures retain
qualified delivery boundaries. Its root census has 70 covered scripts and 11
pending; copied inputs and dependency producers remain separate. No validation
producer, review sample, child, native or network operation was executed.

[qualification-scripts.csv](qualification-scripts.csv) adds 1,679 operator-script
records: 1,526 primary literal/regex occurrences, eight hashbangs, 34 nested
occurrences, 66 main and eight generated assertion boundaries, one embedded echo
fragment and 36 other delivery boundaries. The
[scope](qualification-scripts-scope.csv) covers ten complete bodies, 3,068 lines
and 131 pinned source hashes/Git blob identities. Records distinguish emitted
reports, fixture/model inputs, generated code, streamed/captured child output,
retry/cleanup replacement and native assertions. This root-script snapshot has
80 covered bodies and one pending body, the 656-line dev-build.sh continued below. Six copied
upstream bodies are covered by the copied-bootstrap unit below. Verification reads source and
frozen blob metadata without running Git, scripts, models, children, network or
product producers.

[dev-build-text.csv](dev-build-text.csv) adds 1,515 bootstrap records: 1,492 exact
shell/nested lexical occurrences and 23 delivery/native boundaries. Its
[scope](dev-build-text-scope.csv) covers all 656 lines and 33 functions, with 131
source SHA256/Git blob identities. Sixty echo occurrences, the quoted help
heredoc, Node dependency-probe templates and parameter fallbacks retain raw source
spelling and branch conditions. Hook return status, successful receipt warnings,
lock status 75, argument return 2, unresolved generated quoting and redirection
order have separate dispositions. The finite root-script census now accounts
for all 81 bodies: eighty prior plus this one, with zero root bodies pending.
Six copied upstream bodies follow below. Verification executes no Bash,
Node producer, Git, build, hook, install, native or network operation.

[copied-bootstrap.csv](copied-bootstrap.csv) adds 338 checked-in upstream records:
313 primary nonempty literal/template/regex occurrences, seven nested patch
occurrences and eighteen boundaries. Its [scope](copied-bootstrap-scope.csv)
covers six complete bodies, 1,192 lines, 26 source hashes and frozen main blob
identities. Four runtime/applicator bodies have separate dispositions from two
declaration files. Twenty-eight empty strings and 77 comments are structurally
accounted for. Five before/after replacement pairs retain their role and raw
escaping; 22 Flow ingress Error/TypeError branches keep their caller guards.
Build activation, copied destinations, bug-report replacements, receipts,
clipboard failures and suppressed catches have distinct delivery evidence.
External GitHub, tmux, Node and native UI wording remains separately delegated.
No applicator, copied producer, build, child, native or network code was executed.

[ci-text.csv](ci-text.csv) adds 3,754 authored workflow records: 2,167 YAML
keys/scalars, 1,200 inline lexical/nested occurrences, 201 unresolved workflow
expressions and 186 delivery boundaries. The [scope](ci-text-scope.csv) covers
all ten first-party workflow bodies, 1,545 lines and ten source hashes/frozen main
blob identities. Human wording includes ten workflow labels, 98 explicit step
labels, 24 input descriptions and sixteen inline prose occurrences. Log errors,
step summaries, PowerShell/Python/Node guards and public issue/release copy have
separate source conditions. Secret references remain unresolved identifiers;
no secret value was read. Called scripts, 77 external action uses, two local
reusable workflow calls and runner/service/native wording retain boundaries;
ten-file source coverage is not transitive CI coverage. No workflow, action,
child, install, network or publication producer was executed.

[textguard-native.csv](textguard-native.csv) records 418 native TextGuard
occurrences and boundaries, including 122 native English occurrences, protected
protocol values, ignored rule metadata, build diagnostics and two JavaScript API
errors. The [scope table](textguard-native-scope.csv) accounts for all 22
non-vendored Go bodies and 13 bundled rule bodies. Generic bridge errors have
separate conditions from the production helper, which returns structured
evidence/reason codes; the JavaScript supervisor discards helper stderr.
Admission's reparse and later abort/generation checks can replace those codes
again. The vendor runtime and policy/review passes follow below. No scanner,
compiler or rules were executed.

[textguard-dependencies.csv](textguard-dependencies.csv) adds 423 vendor records:
149 diagnostic/help occurrences, 256 technical/format tokens, six table versions
and 12 payload boundaries. The
[scope table](textguard-dependencies-scope.csv) covers 30 ordinary Go bodies and
six generated Unicode tables with complete lexical/data censuses. It supersedes
the native pass's pending vendor dispositions for those exact source hashes.
TOML, IDNA, normalization and bidi errors are qualified by library/API callers
and production suppression. Compiler/stdlib/OS wording and arbitrary input
excerpts remain external boundaries; generated mapping data is not prose.

[textguard-owned.csv](textguard-owned.csv) adds 204 policy/review records:
141 catalog occurrences across 126 IDs, 51 fixed/protected fragments and twelve
delivery boundaries. Five complete policy, review, approval, payload and skill
bodies cover 1,767 lines; the [scope](textguard-owned-scope.csv) pins nineteen
sources. All 491 string/template/regex nodes are partitioned against 382
[exclusions](textguard-owned-exclusions.csv), with 55 catalog aliases, twelve
Error/SnapshotFailure constructors, nine catches and two suppressed catch callbacks.
Together with the native unit this covers all ten CLI TextGuard source bodies.
Fixed English tool-result banners retain conditional result, persistence and
export sinks. Localized alerts use the active catalog and explicit non-TUI stderr
delivery; overlay geometry, approval rechecks and source/body escaping remain
separate. Warning-only summary branches and the off-list banner have no ordinary
producer; skill framing is recognition-only. Native wrappers replace the original
context-interruption headline. Five corruption controls pass without loading any
policy, view, scanner, native producer or user state.

Counts describe records in each table. Catalog links, repeated wording,
different consumers and dynamic boundaries overlap; do not add these counts as
a number of unique messages or translation fixes. `english_location` locates a
fixed definition when one is known; on a boundary row it locates the forwarding
expression or dependency call that still needs tracing.

Recheck this catalog snapshot from the repository root:

```sh
node review/text-inventory/catalog-export.mjs
python -B review/text-inventory/verify-catalog.py
python -B review/text-inventory/catalog-links.py
python -B review/text-inventory/source-census.py
python -B review/text-inventory/verify-acp.py
python -B review/text-inventory/verify-acp-dependencies.py
python -B review/text-inventory/verify-startup-language.py
python -B review/text-inventory/verify-cli-entry.py
node review/text-inventory/verify-cli-startup-support.cjs
node review/text-inventory/verify-host-ui.cjs
node review/text-inventory/verify-scrollback.cjs
python -B review/text-inventory/verify-doctor.py
python -B review/text-inventory/verify-updater.py
python -B review/text-inventory/verify-profiles.py
python -B review/text-inventory/verify-profile-migration.py
python -B review/text-inventory/verify-catalog-settings.py
python -B review/text-inventory/verify-model-picker.py
node review/text-inventory/verify-palette.cjs
python -B review/text-inventory/verify-keybindings.py
python -B review/text-inventory/verify-workflow.py
python -B review/text-inventory/verify-subagent-runtime.py
python -B review/text-inventory/verify-subagent-output.py
python -B review/text-inventory/verify-voice-text.py
python -B review/text-inventory/verify-model-catalog.py
python -B review/text-inventory/verify-auth-account.py
python -B review/text-inventory/verify-launcher.py
python -B review/text-inventory/verify-launcher-helpers.py
python -B review/text-inventory/verify-launcher-support.py
python -B review/text-inventory/verify-installer-dependencies.py --cache-dir <archive-directory>
python -B review/text-inventory/verify-flow.py
python -B review/text-inventory/verify-flow-report.py
node review/text-inventory/verify-flow-storage.cjs
node review/text-inventory/verify-flow-receipts.cjs
node review/text-inventory/verify-flow-waits.cjs
node review/text-inventory/verify-flow-wait-authority.cjs
node review/text-inventory/verify-flow-wait-producers.cjs
node review/text-inventory/verify-flow-tools.cjs
node review/text-inventory/verify-flow-model-input.cjs
node review/text-inventory/verify-native-request-state.cjs
node review/text-inventory/verify-flow-request-policy.cjs
node review/text-inventory/verify-native-request-transport.cjs
python -B review/text-inventory/verify-flow-metadata.py
node review/text-inventory/verify-prompt-text.cjs
node review/text-inventory/verify-language-contract-text.cjs
node review/text-inventory/verify-pi-ui-adapter.cjs
node review/text-inventory/verify-session-label-text.cjs
node review/text-inventory/verify-human-fallback.cjs
node review/text-inventory/verify-session-primitives.cjs
python -B review/text-inventory/verify-session-ui-text.py
python -B review/text-inventory/verify-session-ui-components.py
python -B review/text-inventory/verify-session-ui-producers.py
python -B review/text-inventory/verify-python-console.py --observe
python -B review/text-inventory/verify-operator-scripts.py
python -B review/text-inventory/verify-build-scripts.py
python -B review/text-inventory/verify-copied-runtime.py
python -B review/text-inventory/verify-release-scripts.py
python -B review/text-inventory/verify-build-integration.py
python -B review/text-inventory/verify-validation-scripts.py
python -B review/text-inventory/verify-qualification-scripts.py
python -B review/text-inventory/verify-dev-build-text.py
python -B review/text-inventory/verify-copied-bootstrap.py
python -B review/text-inventory/verify-ci-text.py
python -B review/text-inventory/verify-textguard-native.py
python -B review/text-inventory/verify-textguard-dependencies.py
node review/text-inventory/verify-textguard-owned.cjs
node review/text-inventory/verify-pi.cjs --node-modules <root-node-modules> --cli-node-modules <cli-node-modules> --agent-archive <agent-1.4.0.tgz> --tui-archive <tui-1.4.0.tgz>
node review/text-inventory/verify-pi-tools.cjs --node-modules <root-node-modules> --cli-node-modules <cli-node-modules> --agent-archive <agent-1.4.0.tgz> --tui-archive <tui-1.4.0.tgz> --negative-controls 1
node review/text-inventory/verify-pi-runtime.cjs --node-modules <root-node-modules> --cli-node-modules <cli-node-modules> --agent-archive <agent-1.4.0.tgz> --tui-archive <tui-1.4.0.tgz> --negative-controls 1
node review/text-inventory/verify-pi-auth-model.cjs --node-modules <root-node-modules> --cli-node-modules <cli-node-modules> --agent-archive <agent-1.4.0.tgz> --tui-archive <tui-1.4.0.tgz> --negative-controls 1
node review/text-inventory/verify-pi-session-config.cjs --node-modules <root-node-modules> --cli-node-modules <cli-node-modules> --agent-archive <agent-1.4.0.tgz> --tui-archive <tui-1.4.0.tgz> --negative-controls 1
node review/text-inventory/verify-pi-packages.cjs --node-modules <root-node-modules> --cli-node-modules <cli-node-modules> --agent-archive <agent-1.4.0.tgz> --tui-archive <tui-1.4.0.tgz> --negative-controls 1
node review/text-inventory/verify-pi-resource-text.cjs --node-modules <root-node-modules> --cli-node-modules <cli-node-modules> --agent-archive <agent-1.4.0.tgz> --tui-archive <tui-1.4.0.tgz> --negative-controls 1
node review/text-inventory/verify-pi-export-metadata.cjs --node-modules <root-node-modules> --cli-node-modules <cli-node-modules> --agent-archive <agent-1.4.0.tgz> --tui-archive <tui-1.4.0.tgz> --negative-controls 1
node review/text-inventory/verify-pi-export-text.cjs --node-modules <root-node-modules> --cli-node-modules <cli-node-modules> --agent-archive <agent-1.4.0.tgz> --tui-archive <tui-1.4.0.tgz> --negative-controls 1
node review/text-inventory/verify-pi-export-vendor.cjs --node-modules <root-node-modules> --cli-node-modules <cli-node-modules> --agent-archive <agent-1.4.0.tgz> --tui-archive <tui-1.4.0.tgz> --negative-controls 1
node review/text-inventory/verify-pi-compaction-text.cjs --node-modules <root-node-modules> --cli-node-modules <cli-node-modules> --agent-archive <agent-1.4.0.tgz> --tui-archive <tui-1.4.0.tgz> --negative-controls 1
node review/text-inventory/verify-pi-tui-utilities.cjs --node-modules <root-node-modules> --cli-node-modules <cli-node-modules> --agent-archive <agent-1.4.0.tgz> --tui-archive <tui-1.4.0.tgz> --negative-controls 1
node review/text-inventory/verify-pi-tui-engines.cjs --node-modules <root-node-modules> --cli-node-modules <cli-node-modules> --agent-archive <agent-1.4.0.tgz> --tui-archive <tui-1.4.0.tgz> --negative-controls 1
node review/text-inventory/verify-pi-tui-input.cjs --node-modules <root-node-modules> --cli-node-modules <cli-node-modules> --agent-archive <agent-1.4.0.tgz> --tui-archive <tui-1.4.0.tgz> --negative-controls 1
node review/text-inventory/verify-pi-tui-text-support.cjs --node-modules <root-node-modules> --cli-node-modules <cli-node-modules> --agent-archive <agent-1.4.0.tgz> --tui-archive <tui-1.4.0.tgz> --negative-controls 1
node review/text-inventory/verify-pi-runtime-census.cjs --node-modules <root-node-modules> --cli-node-modules <cli-node-modules> --agent-archive <agent-1.4.0.tgz> --tui-archive <tui-1.4.0.tgz> --negative-controls 1
```

The exporter uses `@fluent/syntax` and TypeScript from the repository dependency
tree. It rejects production source changes relative to the stated pin. Its
default operation compares generated artifacts without writing; `--write`
regenerates them after source and context review. The independent verifier uses
the earlier lossless Python Fluent parser and checks exact values, attributes,
source anchors, source hashes and accounting. These checks validate the recorded
data, not complete semantic or runtime coverage.

After adding a reviewed occurrence table, include it in `catalog-links.py` and
regenerate the navigation index with `python -B review/text-inventory/catalog-links.py --write`.
Its default operation checks the stored index and input hashes without writing.
Update `source-census.py`'s scope list and regenerate it with `--write` when a new
scope table is added. Its source tree remains the stated immutable Git pin.

The ACP verifier also needs the exact `@agentclientprotocol/sdk` `2.0.2` source
package. Its default is the root `node_modules`; `--sdk-root <package-directory>`
can point to another copy. It reads files without installing or executing Jouzu.
