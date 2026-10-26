# Owned-source semantic follow-up

## Result and scope

The non-flow excerpt/partial source universe has been read in full against source baseline `5217175` on `jouzu-ja`: **38 files, 9,799 lines**. This closes the full-file enumeration gap for those paths, not the Japanese UI audit as a whole.

The universe is derived from [terminal-owned/files.csv](../terminal-owned/files.csv), without using catalog contents or an English-string scan to choose source files:

```python
"/flow-control/" not in row["source_file"] and any(
    word in row["disposition"] for word in ("excerpt", "partial")
)
```

Each selected implementation was read from its first through final line, including exception replacement, suppression, persistence and cleanup. Immediate consumers were read only where needed to distinguish display framing from data or determine the catalog argument. The two depths are explicit in [files.csv](files.csv):

| Record | Computed count | Meaning |
| --- | ---: | --- |
| Primary implementations | 38 | Exact predicate result; full implementation reads |
| Primary source lines | 9,799 | Sum of UTF-8 `splitlines()` lengths |
| Additional source files | 23 | `bounded-trace-only`; only identified consumer regions, not full-file sign-off |
| File disposition rows | 61 | Primary and bounded records together |
| Surface/state-family rows | 33 | Newly identified or clarified families; not unique defects or exhaustive state permutations |
| `source-only-semantic` rows | 25 | Owned behavior and selected display consumers traced in source |
| `source-only-boundary` rows | 8 | Model/protocol/layout or unresolved final-consumer boundary |
| Existing test-file pointers | 42 | Distinct pointers, not tests executed or assertions of Japanese coverage |

[surfaces.csv](surfaces.csv) uses the exact eleven-column schema in [validate.py](../validate.py) and the `semantic-owned.` identifier namespace. Original ledgers are unchanged. A file-level full read or a catalog-supported message does not establish startup execution, native behavior, correct Japanese wording or layout.

## Findings with display consequences

1. **Language recovery has direct English UI copy.** `LocalizationRecoveryError` in `packages/cli/src/localization-ops.ts` owns the recovery instruction. `catalog-settings.ts` displays that message directly for apply/reset, bypassing even the ordinary localized failure wrapper. Other session-store errors are local English mixed with inherited filesystem error text inside the wrapper. Planning a confirmation can throw before the apply catch; its final host consumer is not established here. See `semantic-owned.language.recovery` and `.store-failures`.

2. **Stable language-plan codes are also display arguments.** The Settings apply branch prints `unsupported-value` or `environment-settings-unusable` as the detail of a localized failure message. The codes should remain stable data; localized presentation would need a separate mapping. Receipts format backup/transaction/count data, but the examined consumer only counts notices for other sessions. It does not deliver them. See `semantic-owned.language.conflict-codes` and `.receipt-notices`.

3. **English validation text does not always reach a screen.** Successful Models quarantine replaces malformed-state errors with a catalog warning and a protected path; regular-file and size-limit errors instead escape. Inbox delivery callbacks discard their raw invariant errors and show a catalog warning. Credential reads suppress invalid files; login persistence failures become a generic catalog storage error and logout failures become receipt state. Voice cancellation/transport control errors usually become generic notices, snapshot insertion or no notice for a stale run. These routes must not be classified by their error literals alone.

4. **Subagent results contain local framing as well as source/model text.** `subagents/manager.ts` persists fixed English interruption, timeout, cancellation and incomplete-result sentences plus finalization notes. `subagents/worker.ts` produces fixed English failure/limit framing and preserves provider error or partial-answer detail on a normal failed completion; its outer catch replaces arbitrary exceptions. Workflow and the result renderer display these outcomes without translating the local framing. Model-authored answers, assignments, provider errors and stored conversation evidence remain a separate preservation boundary. See the `semantic-owned.subagents.*` rows.

5. **The same English value can have different consumer visibility.** The Models/Workflow same-model display re-resolves a metadata default with the active catalog. The tool read renderer replaces the raw `No output yet.` sentinel, whereas Workflow output retains it. Inbox acknowledgement bypasses the delivery-error replacement and returns `No reply needed.` or an English refusal. These are distinct routes, not one screen family inferred from an export.

6. **TextGuard has separate model and human readers, with an English startup default on the human route.** Native/cache/admission failures become coded reasons, not raw native stderr. Human alert/review formatting resolves the reason map through its extension bundle; `main-cli.ts:755` constructs that extension without a catalog, selecting English. Model-side withheld/advisory instructions remain fixed English. The host's filtered-result display/storage ordering is not established by the owned code. Skill notice source labels are not shown by the examined count-only UI. Cache/approval persistence errors are swallowed, not English error toasts.

7. **Voice diagnostics need identity-aware classification.** Tagged `VoiceError` messages are resolved by the active bundle passed at `main-cli.ts:596-598`, despite English backing `Error.message`. `VoiceReviewRequired` is consumed as snapshot insertion rather than printed; the generated `[garbled]` marker becomes editor content. Segment labels are catalog-backed, while the status argument remains `starting`/`recording`/`finishing`. Speech and native device names remain sanitized source values.

8. **Identity, model contracts and layout are not translation percentages.** Model/provider/catalog names, hashes, paths, versions, policy pairs, tool names and protocol codes remain data. Request/schema/argument transforms do not translate descriptions or generate new UI copy. Role/context language instructions are model prompts. tmux title ownership preserves generated or prior title data and suppresses raw command errors. Japanese punctuation wrapping changes rendered layout without translating content. None of these facts proves native presentation or model-language compliance.

## Catalog paths traced

- `cli-messages.ts` `defaultCatalog()` caches `resolveCatalog("en").bundle`; it does not consult the chosen UI locale. `catalogText` unwraps protected arguments without translating their content.
- `main-cli.ts` supplies the forwarding display bundle to Models and Voice. Models supplies it to Workflow, the manager/factory, Settings and context validation. Settings supplies its active/preview bundle to transaction and deferral helpers.
- The TextGuard review registration and session-label extension omit their optional catalog. The latter converts a failed explicit tmux claim to its own notice rather than showing tmux stderr.
- Both process-lock calls in the subagent manager omit the lock helper's catalog. Busy failures are replaced or queued, while storage/release errors have different propagation. The immediate flow ownership consumer replaces acquisition errors with its own message; this is a bounded consumer trace, not a flow audit.
- Startup response resolution uses saved settings and marks project policy untrusted. Consequently, an optional resolver's English fallback does not alone establish a reachable English startup screen. Settings session parsing also rejects unsupported override values before ordinary row resolution.

## Exact unresolved boundaries

Primary implementation-read remainder: **none**. Semantic coverage is limited to the primary files and named consumer regions; there is no claim that every source importer was fully audited.

| Boundary | What is established | What remains |
| --- | --- | --- |
| Settings planning failure | `openLanguageConfirm` calls `planLanguageChange` before the apply catch | Pi handling/display of that thrown planning exception |
| Other-session language notices | Transaction returns structured notices; Settings displays their count | A separate delivery/display consumer is not established |
| Activity observations | Settings local remove/logout confirmations and Models streaming/tool events | Native IME/update signal integration and interaction acceptance |
| Models unsafe/oversize state | Store rethrows rather than quarantining; `syncSession` has no local load catch | Final host startup-event exception display |
| Nested context tool and policy refusals | English default tool label/trace helper and fixed English block reasons are produced | Host direct/nested label, refusal and tool-hook exception rendering |
| TextGuard filtered results | Owned model projection returns fixed English replacement/advisory content | Dependency order of model projection, stored transcript and visible tool rendering |
| Voice asynchronous audio callback | `onAudio` calls `sendAudio`; the latter can throw an untagged frame/closed error | Host/event-loop handling beyond the inspected callback, without assuming a localized notice |
| Native resources | Owned code maps scanner/audio/tmux failures and protects source data | Native scanner, microphone, audio driver, tmux/terminal, font/IME and platform acceptance |
| Language and layout | Catalog selection and display/source boundaries traced | Qualified Japanese review, real rendering and native interaction tests |

### Other direct-import candidates not followed

`verify.py` independently lists direct, non-type-only imports of primary modules from outside the recorded read/trace set. This is a finite discovery residual, not a list of confirmed visible errors. It excludes explicit type-only imports and can include constants or identity-only uses. It does not recursively enumerate dependencies or indirect imports.

The remaining 25 candidate paths are:

- `packages/cli/src/camoufox-adapter.ts`
- `packages/cli/src/catalog-sources.ts`
- `packages/cli/src/context-clamp.ts`
- `packages/cli/src/dashboard-policy.ts`
- `packages/cli/src/flow-control/local-storage.ts`
- `packages/cli/src/flow-control/subagent-observation-extension.ts`
- `packages/cli/src/flow-control/subagent-waits.ts`
- `packages/cli/src/flow-control/user-input-grants.ts`
- `packages/cli/src/keybindings.ts`
- `packages/cli/src/label-policy.ts`
- `packages/cli/src/language-choice.ts`
- `packages/cli/src/model-catalog-sync.ts`
- `packages/cli/src/pi-import.ts`
- `packages/cli/src/profile-choice.ts`
- `packages/cli/src/profile-manager.ts`
- `packages/cli/src/profile-migration-command.ts`
- `packages/cli/src/profile-migration.ts`
- `packages/cli/src/runtime-diagnostics.ts`
- `packages/cli/src/shisa-link/extension.ts`
- `packages/cli/src/shisa-link/onboarding.ts`
- `packages/cli/src/startup-settings.ts`
- `packages/cli/src/subagents/dashboard.ts`
- `packages/cli/src/subagents/roles.ts`
- `packages/cli/src/ui-locale.ts`
- `packages/cli/src/updater.ts`

In particular, shared filesystem/state-lock helpers have more consumers than the bounded Language/Models/account/subagent traces. Those additional catches are not assumed to preserve or suppress the same text. The flow paths remain outside the primary non-flow universe.

## Checks and safety

Run the static checks from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 review/ja-localization/full-ui-audit/semantic-owned/verify.py
PYTHONDONTWRITEBYTECODE=1 python3 review/ja-localization/full-ui-audit/validate.py
```

`verify.py` compares both CSV headers to the existing validator, recomputes the exact primary predicate and line counts, checks unique source/ID rows and required fields, verifies source/test/file/range pointers, and reports the additional direct-import candidates. It also checks the audit prose for machine-specific paths and non-public terminology. This is a structural check, not independent proof that source was understood correctly. The original validator additionally checks the complete audit's dispositions, ID uniqueness and saved census staleness.

Check results:

- `semantic-owned/verify.py`: **pass, exit 0**; 38 primary paths, 9,799 lines, 23 bounded traces, 61 file rows, 33 surface rows, 42 distinct existing test pointers and 25 additional direct-import candidate files.
- `full-ui-audit/validate.py`: **pass, exit 0**; no malformed/schema/pointer/census errors and no undispositioned sources. The validator explicitly does not grant semantic or runtime sign-off.
- Git comparison of all 61 recorded source paths with `5217175`: **pass, exit 0**; no source differences. `git diff --check` also passed. The local checker separately checks whitespace in these new audit files, which Git's unstaged-diff check does not cover while they are untracked.

Existing product tests are pointers only and were not run. No product/catalog/dependency/settings edits, installs, microphone/browser/model/subagent runtime, network/account operations or native integration runs were performed.
