# Japanese translation drafts

**For the consolidated implementation backlog, start with [final-backlog/README.md](final-backlog/README.md).** It preserves the existing current-source drafts, adds source-anchored proposals for final audit findings and explicitly records undrafted families. It is not a complete-string or language/runtime approval claim.

**For v0.2.3 source, start with [the current-source reconciliation](CURRENT.md).** The original CSVs and `glossary.csv` below are a historical draft snapshot; they are not a current outstanding-work list. Use `*-reconciliation.csv` and `current-glossary.csv` to distinguish remaining gaps from fixes and changed wording on `main`.

These review files propose Japanese for the English inventory at `review/ja-localization/untranslated-text.md`, using source revision `c0caa9950988a4b6a41f40e6005d913d282df7a1`. They do not change runtime code, live catalogs, stored identifiers, or dependency packages.

The [startup wiring audit](STARTUP-AUDIT.md) supplements the drafts with runtime-discovered commands and selected detail paths. Its JSON evidence keeps existing translations, startup output, and exercised/unexercised paths separate; it is not included in the historical CSV counts below.

## Draft files and counts

| File | Rows | Scope |
| --- | ---: | --- |
| `jouzu-ui.csv` | 267 | Jouzu menus, Workflow, Catalogs, authentication, session UI |
| `pi-and-previews.csv` | 566 | Pi screens, nested settings, code previews |
| `extensions-cli-launcher.csv` | 661 | Other bundled extensions, CLI/flow reports, launcher, installer |
| **Total** | **1,494** | Identified source messages, templates, display values, and preservation boundaries |

The rows comprise 1,206 new translation proposals, 115 display-only proposals, 92 exact Japanese catalog reuses, 71 protected-text retentions, and 10 content-preservation boundaries. They are not 1,494 newly untranslated strings: shared source families can yield several messages, and retained text deliberately stays unchanged.

The `*-coverage.csv` files map all 107 numbered inventory families, the conditional Pi model-picker section, and separate preservation boundaries. The `*-glossary.csv` files retain each partition's terminology proposals; those proposals have been reconciled into the 85-term shared `glossary.csv`. Coverage means the identified inventory families were addressed, not that all repository English was extracted.

## Translation procedure

For every row, read the source and the callers/renderers that establish what the text does. Read `docs/localization-glossary.md`, the current Japanese catalogs, and this directory's `glossary.csv`. Do not translate from the inventory's abbreviated examples alone. Earlier files such as `proposed-changes.csv` are historical proposals, not the current glossary or catalog.

Use one row per concrete source message/template or display-value meaning. Expand grouped inventory examples into their actual source messages; do not put several unrelated labels in one cell. A shared string can cover several locations if the wording and behavior match, with additional locations in `behavior_note`. Add a coverage row explaining any inventory entry that cannot be proposed without a policy decision or additional evidence.

Preserve product/view names protected by the main glossary. Do not translate commands, option syntax, tool/setting identifiers, key names, URLs, paths, model/provider IDs, source errors, or saved user/model content. A raw status may receive a Japanese **display-only** proposal; the stored/machine value must remain unchanged. Do not propose automatic translation of existing artifacts.

Reuse an existing Japanese catalog pattern exactly when the defect is catalog propagation. Record its message ID and the missing-catalog call path. If that existing translation seems wrong, keep the reused value and explain the concern separately rather than silently changing catalog wording.

Understand the action before choosing a word: canceling a form does not delete saved data; canceling a wait does not stop its job; clearing a reservation does not erase receipts; timeout does not prove that external work stopped; local sign-out does not guarantee remote revocation. Preserve these boundaries and all negation, conditions, deadlines, limits, amounts, and recovery steps. Avoid adding reassurance or safety guarantees.

## CSV format

UTF-8, RFC 4180 CSV, with this header in each translation file:

```text
row_id,inventory_ids,owner,source_file,source_line,source_kind,message_id,english_source,japanese_draft,existing_ja,display_context,behavior_note,placeholders,protected_values,glossary_terms,disposition,review_status
```

- `row_id`: Stable per-file ID, such as `jouzu-0001`; unique across the batch.
- `inventory_ids`: Inventory IDs separated by `|`, such as `J20|C01`. Use `BOUNDARY` for a separate raw/protected/content boundary, or `P-MODEL-FALLBACK` for the inventory's unnumbered conditional Pi picker section.
- `owner`: Jouzu or the exact dependency package/version.
- `source_file`, `source_line`: Repository-relative path and source line. Dependency paths start with `packages/cli/node_modules/`. Use the inspected source, not a guessed location.
- `source_kind`: `literal`, `template`, `catalog_pattern`, `display_value`, or `boundary`.
- `message_id`: Existing Fluent ID if reusing a catalog pattern; otherwise empty.
- `english_source`: Full decoded literal or template, not an abbreviated example. For catalog reuse, use the English Fluent value pattern. Preserve multiline patterns and selection branches.
- `japanese_draft`: Proposed Japanese, or unchanged protected/source content when disposition requires preservation.
- `existing_ja`: Exact current Japanese pattern when reusing a message; otherwise empty.
- `display_context`: Navigation/screen and trigger.
- `behavior_note`: Explain what the text/action means, citing the read call/render path where useful. State conditional/unverified reachability and implementation boundaries.
- `placeholders`: Placeholder tokens separated by `|`. Preserve source `${expression}` or Fluent `{ $name }` tokens exactly in both languages. Do not replace them with invented placeholder names. Record a necessary normalization explicitly in `behavior_note` and do not claim literal identity.
- `protected_values`: Exact technical tokens to preserve, separated by `|`; include only tokens actually present in both source and proposal.
- `glossary_terms`: Shared draft glossary term IDs separated by `|`. New terms go in that partition's glossary-proposal CSV, not in a concurrently edited shared file.
- `disposition`: `translate`, `reuse_existing_ja`, `display_only`, `retain_protected`, `preserve_content`, or `needs_context`.
- `review_status`: Start with `draft-code-context-checked`. This is source-based review, not expert language approval or live UI verification.

Each partition also supplies a glossary-proposal CSV with the same header as `glossary.csv`, and a coverage CSV:

```text
inventory_id,status,row_ids,notes
```

Use `covered`, `retained_by_policy`, or `needs_context`. Coverage is of the inventory's identified source families, not all English in the repository. Each numbered ID occurs once across coverage files; `BOUNDARY` may occur in more than one partition because those partitions cover different content boundaries.

## Shared glossary

`glossary.csv` is the working terminology authority **for these drafts only**, subordinate to `docs/localization-glossary.md`. Its `proposed` rows are review additions, not enacted changes to product policy. Read the semantic scope and exclusions, not just the preferred Japanese word. Preserve protected view names even when the same English word has a translated generic sense.

Draft glossary additions are reconciled centrally before consistency review. Do not modify the main product glossary or live catalogs in this batch. Any remaining terminology conflict must be recorded rather than concealed by a blanket replacement.

A bounded source review checked action-sensitive wording and catalog reuse. Corrections include referring to the translated theme option **自動** in its instructions, translating generic configuration **settings** as **設定** without changing the protected **Settings** view name, preserving the updater's paired-or-both-absent metadata condition, and matching the launcher's existing **Jouzu を修復** label. All rows remain drafts, not language or runtime approval.

### Documented template normalizations

The validator intentionally reports 15 warnings for these rows:

- `ecl-0059`, `ecl-0060`, `ecl-0093`, `ecl-0095`
- `ecl-0427`, `ecl-0433`, `ecl-0438`, `ecl-0453`
- `ecl-0479`, `ecl-0480`, `ecl-0483`, `ecl-0485`
- `ecl-0554`, `ecl-0633`, `ecl-0634`

These were checked against their source expressions: the Japanese omits only English singular/plural or verb-agreement suffix expressions. Numeric counts and other behavior-bearing expressions remain, including the conditional review-note suffix in `ecl-0095`. The differences are documented in each row's `behavior_note`; they are not literal placeholder identity and must be implemented deliberately rather than copied as a mechanical template replacement. Warnings remain visible for future implementation review.

## Validate the review files

From the repository root:

```sh
python -m unittest discover -s review/ja-localization/translation-drafts -p 'validate_test.py' -v
python review/ja-localization/translation-drafts/validate.py
```

The validator checks CSV schemas, unique row IDs, source-file/line existence, coverage links for the inventory IDs, glossary references, exact preservation of declared technical values, placeholder-token correspondence, and unchanged reused Japanese. It also flags documented grammatical-template normalizations and avoided glossary forms for manual review. A passing result does not establish natural Japanese, complete source extraction, correct Fluent rendering, terminal layout, or runtime behavior.
