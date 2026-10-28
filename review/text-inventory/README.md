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

The older [Japanese review](../ja-localization/README.md) retains its own source
pin and translations; its counts must not be added to this inventory.

[acp.csv](acp.csv) contains 104 ACP occurrences: 62 fixed wording occurrences
(including catalog and SDK prefixes) and 42 dynamic payload boundaries. Each
records the protocol field or stderr sink and its trigger. Protocol fields are
potentially visible: each ACP client controls which fields it renders.
[acp-scope.csv](acp-scope.csv) pins the four reviewed ACP source modules and
supporting files. SDK routing, schema and framing text remains pending beyond
the specifically listed prefixes; suppressed internal labels and guards are
recorded separately.

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

[pi.csv](pi.csv) records 657 inherited Pi source occurrences, with per-occurrence
conditions and 155 links to Jouzu catalog IDs.
[pi-boundaries.csv](pi-boundaries.csv) records 112 dynamic content boundaries.
[pi-scope.csv](pi-scope.csv) covers 69 candidate files: two partial files and
67 fully read source bodies with explicit text,
no-prose, startup-gated or conditional-error dispositions.
[pi-exclusions.csv](pi-exclusions.csv) accounts for 2,439 exact lexical occurrences
in those 67 bodies, including imports, code tokens, layout and native output
suppressed by Jouzu's startup configuration. These dispositions do not establish
whole-product or runtime coverage. `source_text_json` preserves source whitespace
and control characters as a JSON string. [pi-evidence.json](pi-evidence.json) records the
exact Pi 1.4.0 archive integrity and comparisons with both installed trees:
66 scoped files match archive bytes and three match the pinned patch outputs.
Canonical English used by Jouzu's adapter is distinguished from untranslated
display text; command names and payloads retain their ownership boundaries.
Selector records distinguish host fallbacks, native startup and exported
consumers. Show-images/theme exported activation remains qualified; two large
sources and transitive text producers still need further coverage.
Editor records distinguish content-row paste markers from border labels that
Jouzu's prompt frame replaces at widths of four columns or more. Tree search
aliases are excluded from visible wording when their only consumer is filtering.
Native login cancellation control signals and an overwritten loader initializer
also remain in the exclusions; exported callback/default activation is qualified
separately from the shipped consumers.

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

Counts describe records in each table. Catalog links, repeated wording,
different consumers and dynamic boundaries overlap; do not add these counts as
a number of unique messages or translation fixes. `english_location` locates a
fixed definition when one is known; on a boundary row it locates the forwarding
expression or dependency call that still needs tracing.

Recheck this catalog snapshot from the repository root:

```sh
node review/text-inventory/catalog-export.mjs
python -B review/text-inventory/verify-catalog.py
python -B review/text-inventory/verify-acp.py
python -B review/text-inventory/verify-startup-language.py
python -B review/text-inventory/verify-cli-entry.py
python -B review/text-inventory/verify-doctor.py
python -B review/text-inventory/verify-launcher.py
python -B review/text-inventory/verify-launcher-helpers.py
python -B review/text-inventory/verify-installer-dependencies.py --cache-dir <archive-directory>
python -B review/text-inventory/verify-flow.py
python -B review/text-inventory/verify-flow-report.py
python -B review/text-inventory/verify-python-console.py --observe
node review/text-inventory/verify-pi.cjs --node-modules <root-node-modules> --cli-node-modules <cli-node-modules> --agent-archive <agent-1.4.0.tgz> --tui-archive <tui-1.4.0.tgz>
```

The exporter uses `@fluent/syntax` and TypeScript from the repository dependency
tree. It rejects production source changes relative to the stated pin. Its
default operation compares generated artifacts without writing; `--write`
regenerates them after source and context review. The independent verifier uses
the earlier lossless Python Fluent parser and checks exact values, attributes,
source anchors, source hashes and accounting. These checks validate the recorded
data, not complete semantic or runtime coverage.

The ACP verifier also needs the exact `@agentclientprotocol/sdk` `2.0.2` source
package. Its default is the root `node_modules`; `--sdk-root <package-directory>`
can point to another copy. It reads files without installing or executing Jouzu.
