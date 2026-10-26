# Japanese translation implementation backlog

This directory combines the current-source draft rows with translation reconciliation for the confirmed groups in [the final findings](../../full-ui-audit/FINDINGS.md). It is a review supplement, not an applied catalog change or an exhaustive extraction of every source string.

## Status: consolidated backlog; additional drafting remains

The snapshot contains **2,084 wording and display-reference entries**: 1,309 conservatively deduplicated existing entries plus 775 source-anchored supplements. The supplements comprise 319 translation proposals, 422 display-only proposals or preservation references, and 34 exact existing-Japanese reuse references. They are not 775 newly untranslated strings. All 28 confirmed finding groups have implementation mappings. The 37 row-level follow-ups retain context/source-change questions and already wired wording concerns; they are not additional confirmed English leaks.

**Not all remaining messages have drafts.** The `limits` column in `findings.csv` names the undrafted diagnostic/control families and compatibility or policy decisions. A finding marked `matched` or `supplemented` records reconciliation work, not complete translation coverage. These counts cannot establish an exact total number of code fixes.

The completed dependency and launcher/operator passes close only their named finite residual sets. Remaining undrafted coverage includes Flow's `Producer snapshot timed out.` message and native admission/recovery, queue/receipt, store/journal and wait-store/authority diagnostic families. About metadata-parser and browser runtime-install/path/extraction diagnostics are not exhaustively drafted. Python's library-generated argparse labels require a separate locale/library strategy. These are explicit limits of this snapshot, not completed translations. Fixed-English model content, persisted history/hashes, default-role metadata and public report language also retain their recorded implementation or policy boundaries.

## Files to use

- `translations.csv`: One entry per exact wording/context key, with Japanese proposal, all original row references, occurrence contexts and linked final finding areas.
- `findings.csv`: One implementation-action record per confirmed finding group. It separates catalog propagation from wording work and retains the area's limits.
- `followups.csv`: Existing `needs_context` and `source_changed` entries, plus the already wired Pi wording concerns. These are not silently counted as confirmed English leaks or discarded as completed.
- `counts.json`: Computed accounting, input hashes and explicit limits. Wording entries, finding groups and follow-ups overlap; do not add them into a total number of fixes.
- `owned.json`, `dependencies.json`, `launcher-operator.json`: Source-context reconciliation and new Japanese proposals. Each new proposal retains an exact source-line anchor, placeholder declaration and implementation notes.

The earlier draft files remain unchanged. Existing Japanese in a `resolved` row may be linked from a finding when the remaining fix is passing that catalog to a caller; it is not counted again as a new missing translation.

## Deduplication rule

Existing `remaining_gap` rows are grouped by exact English and Japanese plus either a shared catalog message ID or, when no message ID exists, the source file. Different translations or different noncatalog source files remain separate. Every original occurrence and its evidence/next action remain in the JSON-valued `occurrences` cell. A shared wording entry can still require several callsite changes.

New proposals use the same rule. Matching an existing wording entry adds provenance rather than another count. This is conservative text deduplication, not proof that two implementations or meanings are interchangeable. It deliberately does not merge synonyms, similar templates, or unrelated generic labels across files.

Import CSVs as **UTF-8, comma-separated, double-quote-delimited, with all columns as text**. Quoted fields may contain newlines; importing as text also prevents source snippets from being evaluated as spreadsheet formulas.

## Implementation order

1. Fix shared catalog propagation using existing Japanese patterns.
2. Apply owned menu/dashboard and diagnostic wording with stable display labels for stored values.
3. Adapt pinned dependency panels and separate exported-viewer controls through the repository's reproducible build workflow.
4. Implement launcher/installer and operator-tool wording within their existing locale mechanisms.
5. Run the recorded scenario, compatibility and language/layout checks before claiming completion.

Use per-row source context and the product [glossary](../../../../docs/localization-glossary.md). Commands, IDs, paths, hashes, stored enums and actual user/model/external/native payload remain protected. Changing human display prose must not silently change persisted receipt hashes or machine schemas.

## Validation

```sh
python -B -m unittest discover -s review/ja-localization/translation-drafts/final-backlog -p '*_test.py' -v
python -B review/ja-localization/translation-drafts/final-backlog/build_backlog.py
python -B review/ja-localization/translation-drafts/validate_current.py
```

The builder checks finding membership, source-line anchors, row links, exact catalog reuse, proposal identity, placeholder preservation and deterministic derived artifacts. Twelve regression tests cover these guards, canonical CSV line endings and preservation of all existing gap-row references. Six reviewed display-literal substitutions inside JavaScript expressions are explicitly allowlisted; conditions, escaping and dynamic identities remain unchanged. These are documented composition changes, not literal placeholder identity. Use `--write` only after inspecting input changes. The current-source draft validator retains its documented normalization warnings.

These checks do not approve natural Japanese, semantic coverage of an entire family, Fluent rendering, terminal layout or native behavior. Read each finding's `limits`; representative proposals must not be treated as complete wording coverage. The remaining boundaries in [COVERAGE.md](../../full-ui-audit/COVERAGE.md) still apply. No runtime, catalog, dependency or global-setting change is made here.
