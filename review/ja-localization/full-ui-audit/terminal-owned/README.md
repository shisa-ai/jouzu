# Jouzu-owned terminal UI source ledger

Source revision: `fe0cf0878e35236ec9716f5d3ee237fff11c3480` on `jouzu-ja`.

## Artifacts and evidence

- `surfaces.csv`: 168 meaningful surface/state-family rows across 65 source files.
- `files.csv`: 255 source/asset dispositions, reconciled against `source-census.json`: 222 CLI source files, 20 Session UI source files, and 13 profile assets/manifests.
- Every source path and each of the 62 distinct named test paths exists. Symbol-presence screening passed; that check is not semantic verification of a symbol or its callers.

**Every surface row is source-only evidence. No row is runtime-verified.**

`source-wired` and `source-only-wiring` mean a producer and its actual caller/default were inspected. `source-conditional` means the route depends on a fallback, optional resource, child, or other condition not exercised here. `source-boundary` records preserved model/source content or an ownership boundary, not translation completion.

The `ja-wired` prefix in `locale_path` records a route to the resolved catalog that can supply Japanese. It does **not** certify that every rendered word is Japanese. Literal strings, unchanged catalog values, English defaults in nested helpers, ordinary `Error.message`, internal state arguments, and preserved source values may still appear. A catalog-aware container does not translate those values. `mixed-preserved`, `english-confirmed`, and each row's finding/limit narrow the claim.

`existing_test` is a pointer to relevant existing test source, not a passing-test claim or a claim that the suite covers every state in the row. Combined test evidence reports 456 focused existing UI/locale tests passing; that result is separate from these source-only records. Existing startup evidence exercises 57 offered Core entries, not every alternate-profile or custom-resource combination.

## Strong confirmed findings

1. `runMainCli` omits the catalog argument for `createSessionLabelsExtension` and `createTextGuardReviewExtension`; both constructors use their English default despite Japanese-capable helpers.
2. `createRuntimeDiagnostics` has the signature `(metadata, packageRoots, options = {}, catalog = defaultCatalog())`. Actual startup passes **only the first two arguments**. Its `about()`, `report()`, `summary()`, and `warnings()` therefore capture the English bundle. A localized About container, `/flow runtime`, or `/session` footer does not translate the resulting strings.
3. Catalog Settings has literal English status/credential guidance and English state arguments. Its manual refresh calls `this.refreshSource(this.paths, view.source, { env: this.env })`, omitting catalog. This differs from form save, which **does** pass the catalog to discovery and activation. Save catches preserve ordinary error text and quarantine reasons.
4. `sessionActivity` constructs English child/job counts. The shared dashboard also prints selected raw state values. `/flow` contains hard-coded action/recovery/catch notices despite receiving the active catalog. The no-context flow formatter is a separate conditional English path, not the normal context-rich report.
5. The conditional native subagent widget has English summary/footer/status text. Workflow preserves ordinary validation errors and role descriptions. Child `parent_context` registration passes only its path, selecting the helper's English default. Compaction completion uses catalog copy, but skipped/failed compaction notifications come from a literal English helper with no catalog argument.
6. Profile skill descriptions and the derived `jouzu-review` description participate in slash completion ownership checks. Their prompt bodies are separate preserved model-facing content. The Japanese profile inherits Core metadata and adds a model-facing Japanese policy, not a new set of translated completion assets. Custom same-name resources with different descriptions intentionally retain their text.
7. Release-loaded browser labels and screenshot framing select the English default. `registerJouzuCamoufoxExtension` calls `createJouzuCamoufoxExtension(pi, stateDir)` without catalog options (`camoufox-adapter.ts:1014-1017`). `release-extensions.ts:177-183,259-278,628-643` resolves and forwards an extension path, not a catalog. Japanese-capable helper tests do not establish release catalog injection. This is a source-confirmed wiring gap, not a runtime observation.
8. `/status` receives the active catalog through `main-cli.ts:757-760`. Its description, labels, context framing and profile-state words use that bundle, while `unknown`, `off`, and `workspace` remain literal fallbacks (`presentation.ts:549-589`). Session/model/profile identities, workspace basename and versions remain protected values. The multiline notification has no producer-local width/height fitting; narrow/short terminal visibility is unverified.
9. External-user receipts include human-readable `reason.text` resolved through the catalog, separately from stable `reason.code` (`user-input-receipts.ts:26-46,99-104,219-244,282-342`). They exclude submitted message content, not reason sentences. `user-input-adapters.ts:273-276,407-415` passes the owner's catalog; `pi-session-ingress.ts:113-118,168` supplies that callback. Final display-consumer visibility remains unresolved: structured receipt copy is not automatically an English terminal screen.

## Inspection limits

A disposition is not a claim of complete semantic review. `files.csv` explicitly marks 94 files reviewed only through export/comment excerpts and 28 through partial implementation excerpts. Most excerpt-only files are flow storage, ownership, wait/producer, and host-hook infrastructure. Receipt producer/caller and ingress catalog-forwarding records are partial implementation reviews, not full diagnostic or final-consumer reviews. Full error-generation and propagation paths remain unreviewed. Evidence cells describe the inspected role and remaining limit; an empty mechanical scan does not establish the absence of UI.

The ledger covers the principal owned view modes, empty/error/confirmation/cancellation cases, and narrow/short layouts found in source. It does not prove exhaustive branch coverage. Remaining review pockets include nested infrastructure diagnostics, custom role/resource combinations, alternate-profile discovery, conditional fallback widgets, child tool catalogs, source-dependent task/job/loop text, and real terminal behavior.

No providers, account operations, microphone, browser, child process, live UI session, or settings writes were used for validation. Dependency-owned Pi and shipped third-party extension implementations and launcher/installers retain explicit ownership boundaries. CLI operator/report paths are cross-referenced to `operator-cli/files.csv`; those references do not establish independent semantic coverage of the files here.

## Checks

- CSV schema, nonempty fields, unique surface IDs/source paths, source/test path existence, symbol-presence screen, and scoped census equality: passed.
- `python3 review/ja-localization/full-ui-audit/validate.py`: passed with no reported errors or undispositioned source files at check time. The validator explicitly does not establish runtime signoff.
- Product tests/build were not run for these audit-artifact changes. Combined test evidence remains separate from source records.

Product code, catalogs and settings were not changed.
