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

[textguard-native.csv](textguard-native.csv) records 418 native TextGuard
occurrences and boundaries, including 122 native English occurrences, protected
protocol values, ignored rule metadata, build diagnostics and two JavaScript API
errors. The [scope table](textguard-native-scope.csv) accounts for all 22
non-vendored Go bodies and 13 bundled rule bodies. Generic bridge errors have
separate conditions from the production helper, which returns structured
evidence/reason codes; the JavaScript supervisor discards helper stderr.
Admission's reparse and later abort/generation checks can replace those codes
again. The vendor runtime pass follows below; broader policy/review UI producers
remain pending. No scanner, compiler or rules were executed.

[textguard-dependencies.csv](textguard-dependencies.csv) adds 423 vendor records:
149 diagnostic/help occurrences, 256 technical/format tokens, six table versions
and 12 payload boundaries. The
[scope table](textguard-dependencies-scope.csv) covers 30 ordinary Go bodies and
six generated Unicode tables with complete lexical/data censuses. It supersedes
the native pass's pending vendor dispositions for those exact source hashes.
TOML, IDNA, normalization and bidi errors are qualified by library/API callers
and production suppression. Compiler/stdlib/OS wording and arbitrary input
excerpts remain external boundaries; generated mapping data is not prose.

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
python -B review/text-inventory/verify-doctor.py
python -B review/text-inventory/verify-updater.py
python -B review/text-inventory/verify-profiles.py
python -B review/text-inventory/verify-profile-migration.py
python -B review/text-inventory/verify-catalog-settings.py
python -B review/text-inventory/verify-model-picker.py
python -B review/text-inventory/verify-launcher.py
python -B review/text-inventory/verify-launcher-helpers.py
python -B review/text-inventory/verify-launcher-support.py
python -B review/text-inventory/verify-installer-dependencies.py --cache-dir <archive-directory>
python -B review/text-inventory/verify-flow.py
python -B review/text-inventory/verify-flow-report.py
node review/text-inventory/verify-flow-storage.cjs
node review/text-inventory/verify-flow-receipts.cjs
python -B review/text-inventory/verify-python-console.py --observe
python -B review/text-inventory/verify-textguard-native.py
python -B review/text-inventory/verify-textguard-dependencies.py
node review/text-inventory/verify-pi.cjs --node-modules <root-node-modules> --cli-node-modules <cli-node-modules> --agent-archive <agent-1.4.0.tgz> --tui-archive <tui-1.4.0.tgz>
node review/text-inventory/verify-pi-tools.cjs --node-modules <root-node-modules> --cli-node-modules <cli-node-modules> --agent-archive <agent-1.4.0.tgz> --tui-archive <tui-1.4.0.tgz> --negative-controls 1
node review/text-inventory/verify-pi-runtime.cjs --node-modules <root-node-modules> --cli-node-modules <cli-node-modules> --agent-archive <agent-1.4.0.tgz> --tui-archive <tui-1.4.0.tgz> --negative-controls 1
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
