# Direct-import helper consumers

## Result: the fixed candidate list is dispositioned, not a full importer audit

This source-only pass resolves the **25 exact paths** in [semantic-owned/README.md](../semantic-owned/README.md#other-direct-import-candidates-not-followed) at source baseline `62dee0ff79ad83afa96947ea58e5c426bb1563e8`. They were discovery leads, not confirmed defects. Each record traces the named value imports from that pass's primary modules, their uses, local error replacement/suppression/forwarding, and an immediate consumer where needed.

No full importer-body reread was required or credited. `traces.json` records selected inclusive read ranges and named helper-use line numbers. The small files whose entire ranges were inspected still receive the same bounded **review claim**: this pass concerns the imported helper, not an exhaustive screen or consumer graph. [semantic-roles](../semantic-roles/README.md) owns the earlier complete `roles.ts` read; [semantic-flow](../semantic-flow/README.md) owns its Flow body reads and substantive Flow findings. [semantic-release](../semantic-release/README.md) remains the release-resource/default-catalog authority. These are cross-references, not extra whole-body credit.

`surfaces.csv` adds newly identified or substantively clarified propagation families in the shared eleven-column schema. Family rows are not defect, screen, translation or execution totals. Existing findings remain in their original partitions.

<!-- computed-counts:start -->
| Record | Computed count |
| --- | ---: |
| `candidate_traces` | 25 |
| `named_value_import_bindings` | 69 |
| `recorded_helper_use_lines` | 108 |
| `primary_helper_modules` | 10 |
| `new_full_importer_body_claims` | 0 |
| `additional_source_records` | 27 |
| `source_snapshots` | 52 |
| `surface_families` | 11 |
| `distinct_existing_finding_refs` | 33 |
| `product_tests_executed` | 0 |
<!-- computed-counts:end -->

The table is recomputed and checked by `verify.py`. Import bindings count each importer/helper pairing, not distinct exported functions; use lines are lexical symbol occurrences outside imports, not branch coverage. Additional source records are inspected helper/consumer regions, not an expanded candidate universe. Whole-file hashes detect stale evidence and do not certify whole-body reading. The complete `private-fs.ts` and `state-lock.ts` helper implementations were read; their inspection ranges and the other bounded implementations/reports are in `support-reads.json`.

## Exact dispositions

Paths below are relative to `packages/cli/src/`. Each `IC` record in [traces.json](traces.json) supplies named imports/use lines, source and consumer anchors, handling, provenance, existing finding references and remaining ambiguity. All entries are statically dispositioned even when their final host/native boundary remains open.

| Record | Exact importer | Disposition for the imported helper |
| --- | --- | --- |
| IC01 | `camoufox-adapter.ts` | Inspection hides path errors in status; installation forwards them or retries busy errors. Lazy execution rethrows; final host tool-error display remains unresolved. Argument normalization is not translation. |
| IC02 | `catalog-sources.ts` | Private registry/token writes and path errors can reach Settings save detail. Credential presence suppresses read failures. Remove/toggle host handling remains separate. |
| IC03 | `context-clamp.ts` | Atomic-write failures reach localized Settings save framing with unchanged detail; the separately inspected policy read omits its available catalog argument. |
| IC04 | `dashboard-policy.ts` | Save errors preserve private-write detail in Settings framing. Load errors can reach a conditional startup/dashboard warning, while mode-only reads drop them. |
| IC05 | `flow-control/local-storage.ts` | Directory failures precede the metadata replacement catch and propagate to attachment cleanup/rethrow or aggregation. Existing Flow storage/sink findings apply; no universal host-display assertion. |
| IC06 | `flow-control/subagent-observation-extension.ts` | `notificationHash` is observation identity, not inbox error text. It returns hashes/indices/receipt evidence, not a human sentence. |
| IC07 | `flow-control/subagent-waits.ts` | `isActiveRun` is a predicate, not a manager-result/error reader. Existing Flow receipt and console-error findings cover the separate warning/callback branches. |
| IC08 | `flow-control/user-input-grants.ts` | Private-path errors become catalog denial reasons; the inspected authorization caller discards that reason and returns its separate stable-code API refusal. |
| IC09 | `keybindings.ts` | Domain/generic catches retain helper detail; compensation can replace an earlier error. Startup resolves a catalog reference but omits the bootstrap helper's catalog. |
| IC10 | `label-policy.ts` | Write errors reach a catalog Settings wrapper or direct `/labels` error notification; load-state labels are a different consumer. |
| IC11 | `language-choice.ts` | Only a language constant is imported from the earlier primary set. Tags/self-names do not forward language-resolver exceptions; saving uses the separately dispositioned UI-locale writer. |
| IC12 | `model-catalog-sync.ts` | Refresh replaces ordinary private/OS failures through an English-default classifier; activation/accept instead forward them. Human status and JSON/result-message exposure differ. |
| IC13 | `pi-import.ts` | Destination `EEXIST` is replaced; other destination failures get a catalog wrapper. Receipt write/lock-preflight errors can bypass the domain error class and reach generic framing. |
| IC14 | `profile-choice.ts` | Read wrapping and writes retain private detail at startup/operator consumers. Migration replaces read errors with stable conflict keys. |
| IC15 | `profile-manager.ts` | Catalog busy versus literal invalid-lock framing; backup/write failures propagate. Profile selection forwards reads; migration replaces them with conflict keys. |
| IC16 | `profile-migration-command.ts` | Receipt-read private errors become `invalid` and a catalog notice. Receipt writes after apply, and rollback failures, can escape to generic error display. |
| IC17 | `profile-migration.ts` | Planning replaces private/profile-read detail with conflict keys printed by the report. Apply/backup/restore writes forward their diagnostics. |
| IC18 | `runtime-diagnostics.ts` | Metadata reread errors are suppressed into unavailable/no-change state, not echoed. Existing startup English-default evidence still applies to the generated report/warnings. |
| IC19 | `shisa-link/extension.ts` | Imported helpers supply silent endpoint fallback and process-local auth state/listeners, not credential-file error text. Signed-out provider refusal uses the supplied catalog; final host display is unresolved. |
| IC20 | `shisa-link/onboarding.ts` | Marker-write detail is discarded in favor of catalog recovery; `EEXIST` returns silently. Auth-change listener failures are already suppressed by the helper. |
| IC21 | `startup-settings.ts` | Malformed JSON returns false, but imported write failures escape uncaught to generic startup error framing. Saved settings/version bytes are not display prose. |
| IC22 | `subagents/dashboard.ts` | Predicate-only import. Existing English widget labels remain, but normal main assembly supplies `dashboardVisibility`, so integration does not attach this standalone widget there. |
| IC23 | `subagents/roles.ts` | Bounded helper sites only: identity projection is data-only; private writes/English busy errors reach the already traced Workflow consumer. No duplicate full-body claim. |
| IC24 | `ui-locale.ts` | Imported language helpers return validation data, not resolver errors. Lock errors are catalog-aware; private writes can reach first-run/Settings framing or existing compensation recovery. |
| IC25 | `updater.ts` | Read/state/status/pre-lock failures can retain detail; in-try check/apply failures may be replaced. Successful-install status-write errors become a catalog notice; startup often reports stable codes. |

## Consequences and preservation boundaries

- **Error class conversion is not localization.** `PrivatePathError` owns English directory/root-safety sentences plus paths. Profile, import and keybinding domain errors sometimes retain those bytes; generic `protectedSourceError` wrapping does not turn owned prose into an OS diagnostic. The OS/native/parser detail and paths still need preservation, separately from owned framing.
- **The same helper has different visibility by phase.** Onboarding discards marker-write detail; startup-settings forwards it. Catalog refresh replaces ordinary helper failures with a classifier explanation, while catalog activation and acceptance forward them. Updater lock acquisition happens before the apply catch; later private failures can be normalized. The relevant branches are anchored in `traces.json` and the new families, not inferred from a throw literal.
- **Localized containers can contain English generated text.** Startup keybinding bootstrap omits its catalog before its outer reference is localized. Catalog refresh calls `describeCatalogFailure(error, phase)` without the classifier catalog. Context policy reload also omits its catalog. Existing runtime-diagnostics and release-diagnostics default findings are not relabeled as new defects.
- **Not every result message is the human report.** Catalog operator refresh prints `catalogStatus` in human mode, not top-level `result.message`; a retained `lastError` depends on error recording succeeding. Migration conflict keys and updater result/error codes are stable machine data also shown by reports. JSON/persisted compatibility cannot be treated as a display-only wording change.
- **An importer is not automatically an error or screen.** `notificationHash`, `isActiveRun`, language tags and projection identity helpers do not import their module's other diagnostics. The standalone subagent widget's renderer is real, but its attachment is conditional; normal source wiring selects another dashboard route. Model instructions, historical/model/tool content, fetched pages, user asset bytes, secrets and protocol hashes remain distinct from owned labels.

## Static remainder and stopping boundary

All fixed importer candidates have a bounded disposition; there is no new importer-body residual. This does **not** close final host/tool rejection rendering, native layout or every importer of these helpers. Specifically:

- Camoufox lazy-install rejection conversion/rendering/persistence and optional runtime internals remain outside this source boundary.
- Settings source remove/toggle exceptions have no equivalent local save catch in the inspected regions; final host presentation is unresolved.
- Flow attachment failures can be rethrown/aggregated; the inspected console callback is not proof that every host attachment rejection uses it. Grant APIs and tool-result fallback display remain distinct external consumers.
- Settings planning exceptions before apply remain open as recorded in `semantic-owned`; the new imported-helper traces do not close them.
- Provider `getApiKey` refusal display, nonserializable injected hash values, post-save listener/callback failures and unenumerated callers remain separate limits.
- No source reading establishes transactional recovery, native filesystem/lock outcomes, Japanese language quality, terminal width/CJK/IME behavior, or runtime visibility. No recursive all-import closure or runtime/native sign-off is claimed.

## Artifacts and checks

- `build-ledger.py` contains authored dispositions and generates the ledgers; it reads source as text, never importing product modules. Regeneration refreshes hashes, so review changed source before accepting it.
- `files.csv` is the common file-disposition schema for exactly the candidate paths.
- `surfaces.csv` is the common eleven-column family schema. Empty test-pointer fields mean this pass supplies no new test-coverage claim.
- `traces.json` is the detailed per-importer record. `support-reads.json` records additional helper/consumer inspection ranges separately.
- `source-receipt.json` records source hashes/counts, the baseline and false semantic/runtime/native sign-offs.
- `verify.py` checks exact scope/order, imported named value symbols/use lines, inspected ranges, source hashes, source/finding pointers, schema/ID integrity, README counts and absence of importer full-body claims. These structural checks cannot prove semantic understanding. The import scan is bounded lexical discovery, not a TypeScript parser or recursive import analysis.
- `verify_test.py` tests the scope/pointer/use/hash guards without loading product code. `record-checks.py` saves the check receipts and checks byte-identical regeneration; `check-evidence.json` records exact static check results.

Final check results:

- `verify.py`: **pass, exit 0**; exact candidate membership, named imports/use lines, read/source/finding pointers, source hashes, schema and README counts match.
- Static checker regression suite: **11 tests passed, exit 0**, with no warnings in the saved final run. An earlier run exposed an unclosed review CSV handle; it was corrected before this final receipt.
- Shared `full-ui-audit/validate.py`: **pass, exit 0**; no errors, stale census or undispositioned candidate sources. Its output includes other concurrent review partitions; it is not an exclusive count for this directory and grants no semantic/runtime sign-off.
- Recorded source comparison with the baseline: **pass, exit 0**; no changes to any recorded source path. `git diff --check` also **passed, exit 0**; local verification checks whitespace in these untracked review files as well.
- Both generator reruns: **pass, exit 0**, with all generated ledger/receipt byte hashes unchanged. This verifies artifact determinism, not semantic correctness.

From the repository root:

```sh
python3 -B review/ja-localization/full-ui-audit/import-consumers/build-ledger.py
python3 -B review/ja-localization/full-ui-audit/import-consumers/verify.py
python3 -B -m unittest discover -s review/ja-localization/full-ui-audit/import-consumers -p '*_test.py' -v
python3 -B review/ja-localization/full-ui-audit/validate.py
```

Only this directory is written. No product edit, runtime import, model/provider/tool/account operation, network request, install, native run, staging or commit is part of this pass. Other concurrently present review directories are not included in this review's ownership or source-read claims.
