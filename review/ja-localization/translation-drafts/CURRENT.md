# Japanese localization reconciliation for v0.2.3

This review compares the translation drafts at `2251cb9fc106df2f5478d4158d02d5e455deb8f4` with product source at `ff6e6bbc1400fb919a6259647d9a662bb9ee86f6` (`main`, v0.2.3). The latter was merged into `jouzu-ja` as `1733e03c91477fd05ffc51e068f73be83e1bec33`.

The original inventory, translation CSVs, coverage files, and `glossary.csv` are historical snapshots. Do not treat every original row as an outstanding translation request. Use the reconciliation files and `current-glossary.csv` for this source revision. No runtime translation or product-glossary edits are made by this review.

**Runtime supplement:** [the startup wiring audit](STARTUP-AUDIT.md) independently discovers the active slash-menu entries and exercises selected help, error, and settings paths. Its current snapshot verifies Japanese `/labels` and `/textguard` descriptions and selected notices after shared catalog propagation; settings submenus still expose recorded English gaps. Historical-row completeness is not complete UI coverage; keep catalog presence, startup wiring, rendered output, and language review separate.

## Files

| File | Purpose |
| --- | --- |
| `jouzu-ui-reconciliation.csv` | Jouzu menus, settings, model selection, account actions, and session UI |
| `pi-and-previews-reconciliation.csv` | Pi settings/selectors, authentication, session navigation, slash-command descriptions, and code previews |
| `extensions-cli-launcher-reconciliation.csv` | Bundled extensions, flow reports, external-input surfaces, launcher, and installer |
| `current-glossary.csv` | Shared terminology for these current-source review files, subordinate to the product glossary |
| `*-current-glossary.csv` | Partition terminology changes retained as review evidence |
| `en-catalog-changes.csv` | Exact English catalog additions, changes, and removals, with the current Japanese source patterns |

Import CSVs as **UTF-8, comma-separated, double-quote-delimited, with all columns as text**. Some fields contain quoted newlines. Importing as text prevents formula-like source strings from being evaluated by a spreadsheet.

## Reconciled counts and priorities

All **1,494 historical rows** have one reconciliation each. The audit adds **145 rows** for changed/new source surfaces, for **1,639 current review rows** and a **96-term current glossary**.

| Status | Jouzu UI | Pi / previews | Extensions / CLI / launcher | Total |
| --- | ---: | ---: | ---: | ---: |
| `remaining_gap` | 188 | 413 | 713 | 1,314 |
| `resolved` | 39 | 154 | 2 | 195 |
| `retained_by_policy` | 78 | 14 | 4 | 96 |
| `needs_context` | 1 | 2 | 28 | 31 |
| `source_changed` | 0 | 1 | 1 | 2 |
| `removed` | 0 | 1 | 0 | 1 |
| **Total** | **306** | **585** | **748** | **1,639** |

Filter `status` in the reconciliation CSVs to work through confirmed gaps. Inspect `next_action` for all other statuses before excluding them: wired translations can still have semantic defects, and changed source is not automatically an English leak. These are rows, not deduplicated counts of distinct strings or live screens.

Notable findings:

- Pi settings labels/descriptions are substantially wired, but native setting values and step-prefixed per-model instructions remain separate gaps. Authentication dialogs are not covered just because the provider chooser has localized labels.
- Code-preview command descriptions are localized; settings panels, health reports, and preview bodies remain separate translation work.
- New external-input receipts reach the selected catalog, but **11 Japanese receipt patterns are still English**. New rows `new-ecl-0001`–`new-ecl-0011` include Japanese proposals.
- The **28 grant-reason candidates** (`new-ecl-0012`–`new-ecl-0017` and `new-ecl-0066`–`new-ecl-0087`) need context: the production adapter caller discards `decision.reason`. Do not count those as confirmed visible English leaks. The other three context items are two alternative preview-tools definitions with no established active rendering caller and a defensive artifact-policy error with no established supported UI route.
- `ecl-0614` restores the full `/goal ${operation} <lane/run-tag>` instruction. Its `source_changed` status corrects an incomplete historical extraction, not an upstream wording change. `pi-previews-0324` records current catalog-backed `Quit Jouzu` wording; its completion is already Japanese.
- `ecl-0078` uses **提出された入力**, not **送信済みの入力**: recovery includes dispatch intents with unknown outcomes and must not assert transmission, delivery, or execution.

## Reading the reconciliation

Each original `row_id` occurs exactly once in its partition. `inventory_ids` retains its historical links. Added review rows use a `new-` prefix and the `NEW` marker. These added rows record bounded audits of changed/new source surfaces, not a complete extraction of every string in those files.

| Status | Meaning and next step |
| --- | --- |
| `remaining_gap` | The inspected Japanese display path still emits English. `current_japanese` is a translation proposal, not deployed text. |
| `resolved` | The identified display path has Japanese wiring and text. It is no longer a missing-translation gap, but this is not semantic approval: inspect `next_action` for remaining wording defects or conditional limits. |
| `source_changed` | The original English or behavior changed. Use the current source and revised Japanese proposal, not the historical wording. |
| `retained_by_policy` | The text is protected technical content or another preservation boundary, not a missing translation. |
| `removed` | The old source/path was removed. The evidence must distinguish removal from code merely moving. |
| `needs_context` | The available source or reachability evidence is insufficient to classify the row. Complete the stated investigation before applying a translation. |

`current_source_file`, `current_source_line`, and `source_revision` identify the inspected source. `message_id` identifies a relevant deployed catalog message when applicable. `evidence` explains callers, behavior, and qualifications; `next_action` states what remains. A Japanese catalog key alone is not evidence that a screen uses it.

A source-changed row is a revised draft, not necessarily a new untranslated gap: read its evidence and next action to determine whether current Japanese wiring already handles the change. Row counts are not counts of distinct remaining strings; templates, shared messages, display-only values, and preserved boundaries have different meanings.

### Wired Japanese wording that still needs review

The Pi audit records four deployed descriptions as `resolved` for rendering coverage while identifying meaning differences in `next_action`:

- `pi-previews-0006`: the one-at-a-time follow-up mode description omits waiting for a response.
- `pi-previews-0016`: the cache-warming description does not explicitly preserve the economic/profitability condition.
- `pi-previews-0034`: the project-trust fallback description omits the extension decision boundary.
- `pi-previews-0051`: the mouse-wheel acceleration description omits the condition that the terminal is not already providing acceleration.

These are wording-review items, not English leaks. The CSV records actual deployed Japanese, not a silently corrected replacement. Correcting them requires a separate catalog change and behavior-aware review.

## English catalog changes

The catalog comparison has **240 rows**: **226 added**, **10 changed**, and **4 removed** messages. Every added or changed English message has a current Japanese counterpart. The Fluent parser was used to compare complete value patterns at the two source revisions; comments and line movement alone do not count as wording changes. Catalog correspondence does not establish display wiring or natural Japanese.

The current locale consistency check reports **1,799 IDs per locale**, with matching keys and arguments across the four catalog directories. The offered interface languages remain English and Japanese; Chinese catalogs are contributor drafts.

## Terminology

Read `docs/localization-glossary.md` before translating. In this source revision, the Catalogs view is **カタログ**, and route prose uses **設定 / カタログ**. Preserve `/catalogs` and catalog identifiers. Other protected Palette product nouns remain governed by the product glossary; do not apply the historical blanket protection of Catalogs to the current review.

## Validation and limits

From the repository root:

```sh
python -m unittest discover -s review/ja-localization/translation-drafts -p '*_test.py' -v
python review/ja-localization/translation-drafts/validate.py
python review/ja-localization/translation-drafts/validate_current.py
node scripts/check-locales.mjs
node scripts/check-direct-strings.mjs
npm run test:affected
```

`validate.py` checks the historical CSV structure and declared preservation constraints; it does not refresh that snapshot. `validate_current.py` checks one-to-one reconciliation coverage, schemas, statuses, current repository anchors, glossary references, preserved content, and draft placeholder correspondence. It requires current locked commit evidence for the changed task and multiloop dependencies. Dependency source statements still require human review: the validator does not fetch remote files or attest that installed bytes match the lock. Documented grammatical-template normalizations remain warnings for implementation review.

The dependency pins changed to `@lhl/pi-tasks` commit `ec7eb8625a98b15926fba7377f22614c12b524d7` and `pi-multiloop` commit `4b79f551c901f85c73141025c42e1df0b818009b`. An installed copy from the earlier lock is not current-source evidence. Inspect pinned source and the checked-in transforms, or leave affected claims qualified.

The merged checkout's `npm run check` was attempted. Type checking failed because installed Pi declarations lack the external-input interfaces required by the merged source (`FlowSubmission.externalUser`, `FlowIngress.registerUserInputAdapter`, and `FlowIngress.authorizeExternal`). No dependency installation or lock rewrite was performed for this review. This is a validation blocker for the merged runtime; passing review-file checks does not establish a passing product build. Refresh the locked development environment and rerun the product gate before relying on runtime validation.

The new review validators have **27 passing fixture tests**. The aggregate current-source validator reports no errors and 15 documented plural/agreement template warnings. Locale consistency and direct-string checks pass; the latter reports 191 detected strings covered by 187 allowlist entries, not proof that all UI English has been found. `npm run test:affected` initially selected no Node tests before documentation links were edited. With all review changes present it selected three files, then refused to execute them because the compiled CLI was stale (`camoufox-adapter.js`); no passing affected-suite result is claimed. Running those three selected source/metadata suites directly through `npm run test:node -- packages/session-ui/test/sources.test.mjs scripts/affected-tests.test.mjs scripts/check-release-metadata.test.mjs` passed all 22 tests without building or modifying installed dependencies.

The focused `runtime-localization.test.mjs` attempt also failed before test bodies because `packages/cli/dist/pi-ui-localization.js` was missing. No build or installation was performed. Runtime and terminal claims are therefore source/test-code observations, not successful live execution evidence.

This remains a bounded static review of the original inventory and changed/new source families. It is not an exhaustive repository-wide string export, a live Japanese UI walkthrough, terminal-width qualification, or language-quality approval.
