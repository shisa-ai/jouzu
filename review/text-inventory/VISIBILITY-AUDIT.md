# Visibility classification audit

This document records the checks behind `visibility-classification.csv` and the
limits of what it claims. The decision procedure is in
[VISIBILITY-RULES.md](VISIBILITY-RULES.md).

## Coverage

Every one of the 253 review tables is assigned by a body-level rule or by an
ordered predicate chain that covers the table without residue.

| Shard | Rows | always | optional | never | unresolved |
| --- | ---: | ---: | ---: | ---: | ---: |
| A-tooling | 14,611 | 226 | 0 | 14,272 | 113 |
| B-tests | 3,965 | 0 | 0 | 3,965 | 0 |
| C-optional | 1,861 | 295 | 1,433 | 125 | 8 |
| D-pi-runtime | 7,286 | 4,640 | 375 | 1,807 | 464 |
| E1-pi-bundles | 3,727 | 0 | 0 | 209 | 3,518 |
| E2-pi-bundles | 3,726 | 0 | 0 | 1,256 | 2,470 |
| F1-product | 6,882 | 2,780 | 121 | 1,824 | 2,157 |
| F2-product | 6,875 | 3,163 | 1,116 | 2,234 | 362 |
| **Total** | **48,933** | **11,104** | **3,045** | **25,692** | **9,092** |

Distinct exact English values: 7,686 always, 2,553 optional, 11,598 never, 6,991
unresolved. The same value can appear in several classes, so these do not sum to
the 23,476 distinct values in the inventory.

## Checks run

`compile_rules.py` fails on any of the following, and the committed run reports
`tables=253 body_rules=118 predicates=398 problems=0`:

- a table whose declared row count differs from the worklist;
- a predicate whose declared count differs from the rows it actually takes under
  first-match-wins;
- a table whose predicates plus `unmatched` do not cover every row;
- a rule name that maps to more than one classification.

`visibility-classification.py` additionally asserts that every occurrence has
exactly one classification, that the reviewed sample identities still match, and
that no rule disagrees with a reviewed sample row. Eighty-four reviewed rows are
now covered by rules; generation fails unless every one agrees.

`audit_rules.py` reports `rules=460 rows=48933 problems=0`: every rule is
single-class, has at least one occurrence, and carries substantive evidence that
is not a copy of the English value.

Two independent contradiction scans over all 48,933 rows returned zero:

- no `always` or `optional` row whose recorded boundary says "not shipped",
  "repository-only", "test-only", "not displayed", "not painted", "unreachable",
  or "no render";
- no `always` row whose English looks like source code or whose disposition names
  a comment, hashbang, import specifier, schema key, or recognition alias.

## Manual review

Rule samples were read against their source bodies for every `always` rule with
at least 50 occurrences, every `never` body rule in the tooling shard, every
`optional` rule, and the full `pi.csv` settings surface. That is a stratified
sample, not an exhaustive re-review of all 460 rules. Defects found and fixed
during review:

- shipped JSON schema prose was classified `never` by one shard and `optional` by
  another; it is now `optional` everywhere, and provider-code schema metadata
  stays `never`;
- four `/llama` auth-source and env-name rows were swept into an `always`
  catch-all; they are comparison keys the client never paints and are now
  `never`;
- one `cli-entry.csv` profile-ID row whose boundary says the first-run choice is
  not displayed was swept into an `always` catch-all; it is now `never`.

## What remains unresolved

9,092 occurrences (18.6%) keep `unresolved`, which is not `never`:

| Reason | Rows |
| --- | ---: |
| Compiled Pi bundle copy with no proven unbundled route | 5,988 |
| Catalog definition without a traced caller | 1,692 |
| Source occurrence whose route is not established | 1,363 |
| Catalog reference without a traced caller | 49 |

The bundle block is the largest single limit. A compiled body does not prove that
Jouzu reaches that string, so those rows stay unresolved even where the same
English is `always` through an unbundled Pi table. Closing them needs a bundle
map that names the invoking entry point per table, not a broader rule.

## Limits

- Categories describe occurrences at the pinned revisions, not translation
  quality or translatability.
- The CSV evidence column is the decisive opening clause of each rule (300
  characters); the full evidence is embedded in `visibility-classification.py`.
  The per-shard JSON sources and the shard scripts are untracked working
  artifacts under `test-results/`.
- Rule counts are derived from the pinned worklist and the rule files. Changing
  either requires rerunning `integrate.py`; the snapshot check fails otherwise.
- `translation-worklist.csv` is not tracked on this branch. The classifier needs
  it in `review/text-inventory/` to run; without it the script stops with a
  message rather than producing a partial result.
