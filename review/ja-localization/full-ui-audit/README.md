# Full Japanese UI audit

## Status: inventory snapshot; semantic and runtime audit unfinished

Start with [FINDINGS.md](FINDINGS.md) for the confirmed gaps and [COVERAGE.md](COVERAGE.md) for evidence levels and unfinished work. The partition CSVs retain detailed source/state records and candidate leads; their rows are not a unique-defect or completed-screen count.

The scope is all repository-owned user-interface text and the pinned runtime/extension UI shipped by Jouzu, with Japanese selected. The earlier [startup audit](../translation-drafts/STARTUP-AUDIT.md) supplies a reproducible baseline, not the universe of screens.

The audit separates these claims:

1. A production source file has a documented disposition.
2. A reachable surface/state family has been identified and its locale path traced.
3. A component was rendered with a selected catalog in a fixture.
4. Real startup passed the selected catalog and emitted the observed output.
5. A native application/terminal/installer was exercised on its target platform.
6. A qualified language review approved the wording and layout.

Evidence at one level does not establish the others. No percentage of translated UI is derived from file counts, catalog counts, test counts, or grouped state rows. A source sink is a discovery lead, not necessarily visible human text. English backing data, technical identifiers, user/model content, remote service text, and source errors need explicit preservation boundaries rather than blanket replacement.

## Scope and independent discovery

`census.py` enumerates tracked candidates from production CLI/session UI, launcher and native backend, installer packaging, the separate Python CLI, shipped catalog/profile/schema metadata, and root tooling. It records exact source hashes and syntax signals without consulting translation maps or excluding files that have no signal. Tests, fixtures, icons and build output are excluded from this first-party source census. Source scope itself is a review boundary: downloaded native binaries and external service pages require separate ownership/native evidence.

Pinned dependencies are enumerated separately from the exact release/runtime authorities. Applied build transforms must be inspected through shipped installed output as well as checked-in transformation source. Dependency-owned does not mean localized or unreachable.

Partitions:

- `terminal-owned/`: Jouzu terminal menus, controls, dialogs, notifications, dashboard, workflow, voice, TextGuard, account and language/settings routes.
- `dependencies/`: Pi interactive components and shipped extension panels, plus applied text transforms and package ownership.
- `launcher-installer/`: launcher frontend/backend, recovery/update paths, native dialogs and installer/development-launcher text.
- `operator-cli/`: noninteractive command reports, parser failures, diagnostics, migration/update/profile/keybinding commands and the separate Python reservation CLI.
- `semantic-launcher/`: full-read caller tracing and candidate-by-candidate dispositions for the earlier launcher diagnostic extraction.
- `semantic-owned/`: full reads of the 38 non-Flow files previously labelled partial/excerpt, with separately bounded consumer traces and explicit remaining edges.
- `semantic-roles/`: complete role-parser/store read and bounded Workflow error consumers, a gap not selected by that earlier disposition-name filter.
- `semantic-release/`: complete release-resource and versioned-record reads, with startup catalog omissions and diagnostic provenance separated.
- `semantic-flow/`: all 84 fixed primary bodies and three additional tool producers read; external receipt, host and native limits remain explicit.
- `semantic-dependencies/`: 27 original candidates, the immediate exported-viewer graph and bounded diagnostic continuations; runtime and arbitrary extension producer boundaries remain open.

`owned-command-coverage.csv` reconciles literal Jouzu-owned `registerCommand` calls against named source families. It does not cover dynamic, dependency, builtin, resource-derived or Session UI interception routes, and a mapped family is not exhaustive branch coverage.

Each partition has a source disposition table and surface/state ledger. Existing tests are pointers, not assertions that every listed state was run or that a test checks Japanese. Combined state names describe families, not exhaustive permutations.

## Reproduce discovery and validation

From the repository root:

```sh
python review/ja-localization/full-ui-audit/census.py --output review/ja-localization/full-ui-audit/source-census.json
node review/ja-localization/full-ui-audit/catalog-candidates.mjs
python review/ja-localization/full-ui-audit/classify_catalog.py
python review/ja-localization/full-ui-audit/reconcile_commands.py
python -m unittest discover -s review/ja-localization/full-ui-audit -p '*_test.py' -v
python review/ja-localization/full-ui-audit/validate.py
```

Regeneration changes evidence: inspect differences, do not blindly accept new hashes or remove missing-source errors. The validator checks structure, candidate-source dispositions and staleness, not runtime reachability or Japanese correctness. A delegated/pending/uninspected disposition cannot satisfy source coverage.

`catalog-identical.csv` records exact Fluent source equality across English/Japanese values and attributes. It includes protected values and placeholder-only patterns as well as English prose. Equality needs contextual classification; unequal source does not prove correct Japanese or startup wiring.

The safe CLI probe uses fresh temporary homes and strips ambient provider credentials. It invokes read-only commands, confirmation-refusal paths and invalid inputs; it does not request real installation, account changes or model execution. It replaces known machine-specific paths with explicit placeholders in saved output. Human and machine-readable output remain distinct.

```sh
node review/ja-localization/full-ui-audit/operator-cli/observe.mjs review/ja-localization/full-ui-audit/operator-cli/observations.json
```

## Runtime and native blockers

Authenticated and model-dependent dialogs, nonempty findings/approvals, platform/terminal capabilities, clipboard/image support, locale changes during active work, startup corruption/recovery, external service pages, native installers and real account/update transactions cannot be signed off from source inspection or mocked tests. Safe fixtures should exercise them where possible; remaining native/credential/external-effect requirements must stay visible.

No runtime translation changes, dependency installations, provider-credit spending, global link changes or real installation/account operations are authorized by this audit. The source census can be fully dispositioned while semantic review, native/runtime execution or language sign-off remains unfinished; report those separately.
