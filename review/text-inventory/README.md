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

The full inventory also needs direct source strings, inherited Pi and extension
wording, launcher and native dialogs, installers, Python and operator/development
commands, generated/exported views, and error payload paths. Arbitrary model,
tool, provider, operating-system, remote-service and user content cannot have a
finite English wording list: their source-defined wrappers and delivery
conditions need explicit boundary records. Current tables do not close those
areas or certify runtime layout or translation quality.

The older [Japanese review](../ja-localization/README.md) retains its own source
pin and translations; its counts must not be added to this inventory.

Recheck this catalog snapshot from the repository root:

```sh
node review/text-inventory/catalog-export.mjs
python -B review/text-inventory/verify-catalog.py
```

The exporter uses `@fluent/syntax` and TypeScript from the repository dependency
tree. It rejects production source changes relative to the stated pin. Its
default operation compares generated artifacts without writing; `--write`
regenerates them after source and context review. The independent verifier uses
the earlier lossless Python Fluent parser and checks exact values, attributes,
source anchors, source hashes and accounting. These checks validate the recorded
data, not complete semantic or runtime coverage.
