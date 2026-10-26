# Japanese localization review

For the v0.2.3 source reconciliation of remaining English and translation drafts, start with [the current-source review](translation-drafts/CURRENT.md). For independently discovered command descriptions and selected help, error, and settings output, see [the startup wiring audit](translation-drafts/STARTUP-AUDIT.md). Neither is an exhaustive UI inventory. The catalog export described below is pinned to its own older candidate and is not refreshed by those reviews.

The source links identify the exact candidate commit. This inventory does not
approve a release or a translation.

Source repository: `shisa-ai/jouzu`.

Candidate: [`e0e3014d4855d32ba93975a834dd953c05d7e494`](https://github.com/shisa-ai/jouzu/tree/e0e3014d4855d32ba93975a834dd953c05d7e494).
All 1,577 Fluent IDs in all four locales are included: `en`, `ja`,
`zh-Hans`, and `zh-Hant` (6,308 locale entries). Every row
starts with `unreviewed-in-this-review`.
The candidate's existing review claims are retained as source evidence; they do
not approve any row in this review. The Chinese drafts are included for reference,
not as a claim that the CLI offers them.

## Start reviewing

1. Open [catalogs.html](catalogs.html) in a browser. No Jouzu, Node, Python,
   network connection, or installation is needed to read it. English and Japanese
   appear together; expand the Chinese reference and comment sections as needed.
   Browser search works without JavaScript; the search box filters when JavaScript
   is enabled.
2. Make a separate copy of [catalogs.csv](catalogs.csv) for annotations. Import
   it as **UTF-8, comma-separated, double-quote-delimited, with all columns as
   text**. Fields can contain quoted newlines. Do not split the file on lines.
   Importing as text also prevents spreadsheet formulas in source strings from
   being evaluated. The exporter preserves exact text rather than adding formula
   escape prefixes.
3. Fill `reviewer`, `finding`, `severity`, `suggested_ja`, `context_or_steps`, and
   `decision`; change `review_status` only after reviewing that row. Keep IDs,
   source text, and source links unchanged. Note the command, screen, width, or
   action needed to reproduce layout or behavioral findings.
4. Review [sources.html](sources.html) and annotate a copy of
   [non-fluent.csv](non-fluent.csv) for desktop, installer, prompt, and language
   policy findings. Use `source_lines_or_symbol` to locate each finding. Add rows
   when one source file has multiple findings. Use [the root review guide](../../JA-REVIEW.md)
   for the isolated build/run procedure.

## Fluent coverage

| Source file (per locale) | IDs |
| --- | ---: |
| `cli.ftl` | 1493 |
| `localization-deferral.ftl` | 9 |
| `localization-settings.ftl` | 19 |
| `profile-migration-command.ftl` | 15 |
| `runtime.ftl` | 41 |
| **Total per locale** | **1577** |

The exporter rejects duplicate IDs within or across files, missing or extra locale
keys, mismatched file namespaces, attribute keys, placeholder names, lock digests,
and counts. Values are **Fluent source**, not rendered text: indentation, newlines,
`{ $variables }`, quoted literals, select/plural branches, and attributes remain
intact. The `*_source` CSV fields contain the full entry, including the identifier;
`*_value_source` starts immediately after `=`. `*_attributes_json` separately
records attributes without flattening their patterns. Dotted `stable_id` values
follow the candidate loader's hyphen-to-dot transform; `fluent_id` preserves the
original identifier. `namespace` is the catalog filename.

Preceding comment blocks are included with each message. All comments (including
standalone, file-level, and trailing comments) and blank lines are also retained in
[catalogs.json](catalogs.json). The source index also provides immutable links to complete source files.
Comments on protected values remain source evidence. Read the
[shared glossary](https://github.com/shisa-ai/jouzu/blob/e0e3014d4855d32ba93975a834dd953c05d7e494/docs/localization-glossary.md) and
[protected-value checks](https://github.com/shisa-ai/jouzu/blob/e0e3014d4855d32ba93975a834dd953c05d7e494/packages/cli/test/protected-values.test.mjs)
before proposing changes to commands, identifiers, paths, or placeholders.

`same_as_en` flags exact source-value and attribute equality: `ja` 29,
`zh-Hans` 45, `zh-Hant` 54. No identical value is
removed or marked approved. Equality can be intentional for protected names and
placeholder-only messages; it can also expose untranslated wording. It is not a
complete English-language detector or a translation-quality judgment.

## Non-Fluent boundary

There are 126 indexed source files, including all 20 Fluent files.
Outside Fluent, the inventory provides **immutable links to complete source files, not a complete
flattened string table**. TypeScript dictionaries, inline arrays, generated prompt
text, NSIS installer syntax, and runtime language choices are not executed or
reinterpreted by this exporter. Review their original structure through `sources.html`.

No `sources/` copies or embedded non-Fluent source bodies are generated. Open pinned links online, or read the same paths in a checkout at the candidate commit. The Fluent tables remain available offline without a product installation.

Evaluation, terminal-check, and approval records are optional context, not required
product inputs. Omitted known context files: `docs/evaluation/per-language-eval-record.md`, `docs/localization-zh-hans-review.md`, `docs/localization-zh-hant-review.md`
The manifest records these omissions; an absent review record is not evidence of approval.

| Source category | Files |
| --- | ---: |
| additional-localization-source | 6 |
| allowlisted-direct-string-source | 45 |
| catalog-contract-and-protected-values | 8 |
| desktop-localization | 3 |
| direct-string-check-and-allowlist | 3 |
| fluent-catalog | 20 |
| installer-localization | 3 |
| language-contract-and-wiring | 19 |
| language-review-context | 8 |
| profile-prompt-asset | 8 |
| residual-English-ownership | 3 |

The source index includes:

- Desktop dictionaries in `apps/launcher/src/i18n.ts`, recovery text in
  `recovery-text.ts`, and the `labels` and `noteText` tables in `update-preview.tsx`.
- All four languages in `packaging/launcher/installer-messages.nsh`, plus the
  installer template and language configuration. Standard NSIS/Tauri page text is
  dependency-owned and is not copied from uninstalled dependencies.
- Every checked-in Core/JA profile asset and manifest, including the exact Japanese
  `APPEND_SYSTEM.md`; response/role language-contract sources, defaults, resource
  assembly, settings, choice, migration, and runtime wiring.
- Catalog support/review records, glossary/context documents, and protected-value
  checks. Existing source prose may describe behavior or prior review; this export
  does not independently validate those claims.

[discovery.json](discovery.json) records every non-Fluent tracked text file outside
`upstream/` that contains Japanese/Chinese characters, quoted `zh-Hans`/`zh-Hant`,
or `LANG_JAPANESE`, with matching lines and its indexed-source or test-fixture disposition.
The explicit source list adds English-only contract and ownership files. This
search is a reproducible coverage aid, **not a proof that every hard-coded English
literal in the application is translatable or cataloged**. Test fixtures are linked
as evidence rather than treated as product strings. Binary files, symlinks, installed
third-party packages, vendored Unicode/security data, service pages, user files,
and live provider responses are not a string inventory in this package.

## Direct strings outside the catalog

[direct-strings.csv](direct-strings.csv) includes all **165 allowlist entries**,
with exact recorded text, category, reason, immutable source links, and annotation
columns. Templates in that record use the candidate checker's `{…}` notation;
read the linked complete source file for exact executable syntax. All 53 files
named by the allowlist are indexed. The allowlist is an ownership/exception
record, not a Japanese translation table or reviewer approval.

Read the [exact allowlist](https://github.com/shisa-ai/jouzu/blob/e0e3014d4855d32ba93975a834dd953c05d7e494/scripts/direct-strings-allowlist.json),
[checker and its stated detection limits](https://github.com/shisa-ai/jouzu/blob/e0e3014d4855d32ba93975a834dd953c05d7e494/scripts/check-direct-strings.mjs),
and [checker tests](https://github.com/shisa-ai/jouzu/blob/e0e3014d4855d32ba93975a834dd953c05d7e494/packages/cli/test/direct-strings.test.mjs).
One allowlist entry can cover multiple locations. This exporter validates the
165-entry record and indexes its source
files; it does **not** rerun the TypeScript-based detector or claim that its
syntactic detection shapes find all hardcoded UI strings. In a built candidate,
`node scripts/check-direct-strings.mjs --all` prints its matching file/line locations.

The 1,577 Fluent rows are **not all hardcoded UI strings**. Desktop/installer
localization, prompt prose, direct-string exceptions, dependency English, and
dynamic/error text have separate source and ownership boundaries here.

## Residual English and ownership

Read the [residual-English guide](https://github.com/shisa-ai/jouzu/blob/e0e3014d4855d32ba93975a834dd953c05d7e494/docs/localization.md) and
[ownership record](https://github.com/shisa-ai/jouzu/blob/e0e3014d4855d32ba93975a834dd953c05d7e494/packages/cli/src/release-surface-record.ts).
Use that commit's guide and source record for its surface counts; these count
surfaces, not individual strings. This is a bounded ownership record, not a
complete desktop/installer audit or a new reviewer sign-off. Upstream Pi/extension English, protected identifiers, and service-owned
screens remain distinct from untranslated Jouzu-owned wording. Report additional
English with its source or reproduction steps; do not infer approval from ownership.

## Public disclosure boundary

[disclosure-review.json](disclosure-review.json) flags personal/local paths,
milestone naming conventions, local hostnames, and internal-operation references
in the source. These are heuristic flags, not a credential scan or a
publication approval. Examples and standard local development endpoints need
different treatment from a person's home path or private planning references.
Do not edit copied content while retaining its source digests. Review and sanitize
the candidate source where necessary, then regenerate from its clean commit.
Do not copy snapshots from another candidate into this package.

## Provenance and regeneration

[manifest.json](manifest.json) records the pin, source-file SHA-256 digests, source
links, per-locale counts, equality flags, exporter digest, and output digests.
[SHA256SUMS](SHA256SUMS) covers every output except itself, including the manifest.
No generation time or local checkout path is embedded, so repeated exports from
the same input bytes are byte-identical. HTML is escaped presentation only.
Source delivery mode: `links`.

Regeneration requires Python 3.10+ and Git, not a product installation. Maintainers
can run the exporter from its repository against a clean source checkout:

```sh
python3 -m unittest discover -s scripts -p 'test_ja_review_inventory.py' -v
python3 scripts/ja_review_inventory.py --source /path/to/clean/candidate --repository https://github.com/shisa-ai/jouzu --expected-commit e0e3014d4855d32ba93975a834dd953c05d7e494 --expected-ids 1577 --source-mode links --output /path/to/new/inventory
```

Add `--check` with the same source, pin, options, and output path to compare the
export without writing. `--source-mode links` avoids copying source files and
embedding their bodies in `sources.html`; use it when the package accompanies the
original repository. `--source-mode snapshots` includes byte-exact offline copies.
Optional context absent from the candidate is recorded as omitted, not imported
from another checkout.

The commit must match HEAD exactly; branch names are not accepted as immutable pins.
Every export checks the per-file and per-locale counts in `PIN_COUNTS`, its allowlist
entry count, four-locale key/namespace/attribute/placeholder parity, and catalog-lock
digests. `--expected-ids` must agree with the file-count contract; it cannot bypass
those checks. Repin `PIN` and `PIN_COUNTS` together when the candidate changes.
Set `JOUZU_JA_REVIEW_SOURCE` to a clean checkout to run the pinned-source integration
tests against that configured candidate. Without it, only unit tests run.

`--check` reads and compares every expected output, detects extra/missing files,
and writes nothing. Generation accepts an empty/new directory or already-identical
output; it refuses to overwrite changed output or reviewer annotations. Keep
annotations outside the generated directory. Source HEAD and cleanliness are
checked before and after reading. No package installation, code execution from the
candidate, provider calls, or network requests occur.

The dependency-free Fluent validator deliberately accepts only the expression
forms used by this pin (variables, quoted literals, nested placeables, variable
selects), plus multiline values and attributes. Unsupported syntax fails instead
of being dropped. It is not the full Fluent grammar or a runtime rendering test.
Native layout, input methods, installed dependency UI, and response-language behavior
still require the separate working-build review.
