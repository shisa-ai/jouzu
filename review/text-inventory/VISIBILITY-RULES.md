# Visibility classification rules

This document defines how `visibility-classification.py` assigns `always`,
`optional`, `never` or `unresolved` to a worklist occurrence. It extends the
conservative first pass without weakening its evidence standard.

## What is being classified

One **occurrence**, not one English string. The same value can be `always` in a
catalog and `never` in a build script. Categories describe whether the pinned
source occurrence can reach a **Jouzu product user** through a **current** route
at the pinned revision. They do not describe translation quality, translatability,
or whether a value should be translated.

- **always** — the occurrence is part of an ordinary Jouzu or shipped Pi surface
  and can reach a product user, including conditional errors, help, prompts,
  status lines, tool results and rendered protected values (brands, commands,
  paths) that appear on that surface.
- **optional** — the occurrence can reach a user only through an explicitly
  activated Pi example, optional packaged resource, or separately enabled
  example extension.
- **never** — the occurrence cannot reach a product user. The evidence must be
  affirmative, not merely missing: a repository-only body, a source-only
  construct, or a recorded lookup/recognition/internal role with no render.
- **unresolved** — none of the above is established. `unresolved` is not `never`.

Developer-facing output from repository tooling (test reporters, CI logs, build
scripts, release helpers) does not make an occurrence `always`. Those bodies are
not shipped to product users, so their occurrences are `never` under the
body-level rule below.

## Decision order

Rules are ordered. The first match wins. The existing individually reviewed
samples override everything.

1. **Reviewed sample** — an occurrence present in
   `visibility-reviewed-sample.csv` or `visibility-reviewed-catalog-sample.csv`
   keeps its recorded category and evidence.
2. **Explicit target caller** — the six target model-picker catalog definitions
   with a pinned target caller are `always` (existing rule).
3. **Body-level `never`** — every occurrence whose owning body belongs to a
   repository-only unit is `never`:
   - CI workflow and action metadata (`ci-text.csv`),
   - build, release, qualification, validation and operator scripts,
   - Python review/audit tools and their tests,
   - JavaScript/TypeScript test and fixture bodies,
   - repository metadata, review exports and census artifacts.
   The unit's scope record pins the bodies; the bodies are absent from the
   published package and are not invoked by the product. Evidence cites the
   table, the body path and the non-shipped role.
4. **Body-level `optional`** — every occurrence whose owning body is a packaged
   Pi example or optional resource that requires explicit activation is
   `optional`. Evidence cites the activation prerequisite recorded in the table.
5. **Row-level `never`** — the occurrence's recorded disposition affirmatively
   denies a product display route: source comment, hashbang, import specifier,
   schema/AST key, lookup or recognition alias, API-only metadata, or a protected
   token explicitly recorded as having no independent render. The rule must
   match the recorded `display_location`/`translation_boundary`, not merely the
   English value.
6. **Row-level `always`** — the recorded disposition affirms an ordinary display
   or output route: catalog render, human report, prompt, status, footer,
   notification, printed CLI output, tool result, or a conditional error that the
   consumer evidence routes to one of those sinks.
7. **Row-level `optional`** — the recorded disposition requires an explicit
   example/resource activation that is not part of ordinary product use.
8. **`unresolved`** — otherwise.

## Prohibited inferences

- A catalog definition is not `always` merely because it exists. It needs a
  traced BASE trigger or an explicit target caller.
- A protected value is not `never` merely because it is protected. If it is
  rendered on a product surface (model name, command, path, brand), it is
  `always`; protected means "do not translate", not "do not display".
- A test, CI or build body is not `always` because a developer can run it.
- An English match across rows is not evidence of shared classification.
- A compiled Pi body does not prove ordinary unbundled activation. Where the
  table records that the compiled path is not the ordinary Jouzu entry, the row
  stays `unresolved` unless the table also records an ordinary route.

## Settled boundary cases

These cases recur across shards; apply them the same way everywhere.

- **Shipped JSON schema prose** (`schemas/*.schema.json` titles and
  descriptions) is `optional`. The file is a packaged resource that a user can
  read directly or through an associated editor, but no ordinary command paints
  it. Schema description strings compiled into provider code
  (`dist/providers/compat-schema.js`) are `never`: they are API metadata with no
  shipped resource and no render.
- **Packaged Pi example bodies** (`examples/`) are `optional` at body level. The
  table records the explicit import/run prerequisite, and packaged source
  presence is not default activation. Raw interpolation or plural-control
  suffixes do not change visibility; they change translatability.
- **Compiled or vendored bundle copies** do not inherit the activation of the
  unbundled source. A bundle row is `always` only when the table records an
  ordinary product route for that occurrence, `never` only when it records an
  affirmative absence, and `unresolved` otherwise.
- **Repository-only scripts** (build, release, qualification, validation,
  operator, review tools, CI) are `never` at body level. The evidence cites the
  body path, the scope record, and the package `files` list that excludes it.
- **Developer instrumentation behind an environment flag** (`PI_TUI_DEBUG*`,
  `PI_TIMING`) is not an ordinary surface; it is `never` when the table records
  the flag gate and no product route, and `unresolved` when the sink is not
  established.

## Evidence requirements

Every rule emits a deterministic evidence string containing:

- the rule name,
- the source table and the recorded disposition phrase that triggered it,
- for body-level rules, the body path and the non-shipped or activation fact.

A rule may not be introduced for a single occurrence. Single-occurrence
judgements belong in the reviewed sample with individual evidence.

## Verification

`visibility-classification.py` asserts:

- every worklist occurrence has exactly one classification,
- reviewed sample identities and categories still match,
- rule counts and class counts in the snapshot match the generated CSV,
- no `always`/`optional`/`never` rule matches a row whose recorded disposition
  contradicts it (checked by the rule predicates themselves).

An independent reviewer samples rows per rule and checks them against the source
tables and source bodies before a rule family is committed.

## Tooling

Shard agents write `test-results/visibility-rules/<shard>.json`; that directory and
the shard scripts are untracked working artifacts, and the compiled rules are
embedded in `visibility-classification.py` before commit. The pipeline is:

```bash
python test-results/visibility-shards/compile_rules.py            # validate + report
python test-results/visibility-shards/integrate.py                 # splice + audit + regenerate
python test-results/visibility-shards/audit_rules.py --samples 1   # per-rule samples
```

`compile_rules.py` rejects a table whose declared row count differs from the
worklist, a predicate whose declared count differs from its match count, a table
whose predicates plus `unmatched` do not cover it, and a rule name that maps to
more than one class. `integrate.py` re-adds hand-written body rules that no shard
JSON owns, so a splice cannot drop them.
