# Release resource diagnostics and recorded coverage

This supplementary pass reads both complete implementations, `release-extensions.ts` and `release-surface-record.ts`: **two files, 912 lines**, plus two bounded consumer traces. Five grouped source families distinguish diagnostic wrappers, local validation, compatibility errors and the versioned record. It closes those body-read gaps, not all startup, loader or dependency diagnostics.

The original `terminal-owned/files.csv` evidence left these bodies incomplete even though their disposition names did not contain `partial` or `excerpt`. Selecting only those words misses declared shallow reviews. These records therefore supplement, rather than silently expand, the fixed primary universes in other passes.

## Findings

- `main-cli.ts:550` omits the third catalog argument to `createReleaseExtensionDiagnostics`. Optional-package notices, disabled-tool framing and console warning prefixes select the English default. Runtime warning strings are forwarded directly. The once-per-session set suppresses duplicates; it does not translate text.
- `main-cli.ts:782` omits the fourth catalog argument to `withReleaseExtensionConflictPolicy`. Its consolidated release-tool conflict messages select English. Nonmatching loader diagnostics are preserved. The native placement of each loader error remains delegated rather than observed.
- Required-extension argument construction **does** receive the active bundle. Its wrapper can therefore be Japanese while local manifest/package/resource/adapter/compatibility diagnostics remain English. `messageFromError` also owns the English `Caused by:` framing; OS, module-loader and JSON detail have separate source provenance.
- Compatibility probe/repair catches feed required/degraded failure routes. This source audit did not run imports, dependency validation, rename/remove/rollback or package operations.
- `release-surface-record.ts` is a versioned structured ownership/disposition record with recheck/count helpers, not a per-string source census or current rendering proof. Its recorded adapter `translated` label does not override the production default-registration evidence. No downstream render or exhaustive import graph is established by a re-export.

`files.csv` records complete producers separately from bounded consumers. `surfaces.csv` uses the common eleven-column schema; `receipt.json` stores computed counts/hashes and false runtime sign-off. The generator materializes authored conclusions, not independent semantic proof.

```sh
python -B review/ja-localization/full-ui-audit/semantic-release/build-ledger.py
python -B review/ja-localization/full-ui-audit/validate.py
```

Review producer/caller changes before accepting regenerated hashes. The shared validator checks structure, paths and tracked-source census consistency, not localized language quality or successful UI traversal. Other loader/doctor consumers, native failure placement, actual resource selection, Japanese wording and CJK layout remain separate checks.
