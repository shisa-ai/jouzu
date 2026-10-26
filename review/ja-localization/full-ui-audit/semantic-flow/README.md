# Flow-control source-semantic audit

## Status: finite primary-body set closed; consumer and native limits remain

The primary universe is unchanged: paths in `terminal-owned/files.csv` under `packages/cli/src/flow-control/` whose original disposition contains `excerpt` or `partial`. That predicate selects exactly **84 files**. It does not select every Flow UI-tool producer.

The source baseline is `52171752ca6b0a03bf5b6e8cda4f796fb10d3d62`; the continuation inspected checkout `39a34b0cd9659d9d1c9c3d7b3ad3b4f3cb1d039d`. All 84 primary source hashes matched the earlier receipt before it was regenerated. Current hashes and line counts are retained in `source-read-receipt.json`; checkout identity alone is not the evidence for unchanged bytes.

Computed accounting:

| Evidence | Files | Source lines |
| --- | ---: | ---: |
| Fixed primary universe | 84 | 21,872 |
| Primary bodies read before continuation | 60 | 10,033 |
| Exact prior residual bodies read in continuation | 24 | 11,839 |
| Primary full-body reads now complete | 84 | 21,872 |
| Remaining primary full bodies | 0 | 0 |
| Additional full-read tool producers, outside primary count | 3 | 576 |

`residual.csv` now contains its header only: **no primary body remains unread**. `continuation-reads.json` preserves the exact prior residual membership and inclusive full-read ranges, rather than erasing the starting boundary. The read records are inspection declarations, not independently machine-proven semantic correctness.

`surfaces.csv` has **32 newly identified or substantively clarified state families**, not 32 defects, screens or translated views. `traced-files.csv` has **19 nonprimary entries**: the three additional full-read producers and 16 scoped consumer/catalog/test traces. Scoped traces do not contribute to primary full-body coverage.

This closes the finite implementation-body reading set, **not an exhaustive consumer, runtime or localization audit**. Imported Pi implementations, every provider adapter, external receipt displays, dashboard consumers and native tool/terminal behavior are not all reviewed. Semantic and native-rendering sign-offs remain false.

## Separate additional producer scope

The following original `ui-label-and-model-tool-wiring` dispositions fell outside the fixed primary predicate. Their complete producer bodies were read, including refusal, success, result and error paths, without adding them to primary membership:

- `packages/cli/src/flow-control/no-reply-tool.ts`
- `packages/cli/src/flow-control/result-tools.ts`
- `packages/cli/src/flow-control/wait-tools.ts`

`additional-full-read-findings.json` records each producer's findings, immediate consumers and limits. `additional-source-read-receipt.json` records its source hash, line count and full-read depth; its primary-count contribution is explicitly zero. Their `traced-files.csv` disposition is `full-body-read-additional-producer`, not a scoped-call-site claim.

All three use catalog-backed tool labels but fixed English descriptions, guidance or local diagnostics. Those model instructions are distinct from returned tool-result content:

- No-reply returns English success text and `terminate:true`; refusals throw English diagnostic text.
- Results returns JSON retained metadata. References, cursors, status/count fields and producer titles/warnings are protocol or preserved source content, not locally invented interface copy.
- Waits returns the response helper's English summary/adjustment notices alongside preserved reasons and dependency data.

None declares `renderCall` or `renderResult`. `exposure: "model-only"` does **not** establish that returned results or errors are hidden from terminal history. Native fallback rendering, result persistence and batch termination remain unverified. No tool was invoked.

## Source-specific findings

### Stored reasons have mixed provenance

`receipt-ledger.ts` catalog-resolves reattachment and filtered/empty-composition reasons, but `cancel`, `withholdRequest`, `uncertain`, `emergencyReset` and `resolveUncertain` preserve their caller's reason string. `pi-ledger-store.ts` archives those strings unchanged.

The fully read wrappers supply owned English sentences: host idle-before-handoff and unknown-provider-outcome reasons, queue-change cancellation, controller-not-consumed cancellation, provider-before-handoff withholding and emergency-clear guidance. `pi-session-ingress.ts` exposes uncertain attempts to `flow-status-report.ts`, which sanitizes their reason without translating it. This does not prove that every cancelled attempt's stored reason is displayed; the uncertain section specifically selects uncertain attempts.

`submission-store.ts` likewise preserves admission hold prose. Its `Admission revalidated.` placeholder is used to validate a clear request, not stored as a new hold. The submission view can expose actual retained hold text to `/flow`, while external receipt projection substitutes its own catalog reason.

### Native failures are not all provider prose

`pi-native-requests.ts` creates optional bounded/sanitized failure diagnostics; `native-request-store.ts` validates them and may drop optional diagnostics under byte pressure. Failure stage/code and source membership are separate protocol evidence. Maintenance receipts deliberately have no source membership.

`flow-status-context.ts` copies the diagnostic and derives a spaced English stage fallback; `flow-status-report.ts` displays the bounded/redacted message inside catalog framing. Genuine provider error text must remain distinct from local admission errors, including the store's English full-history and consumed-input `/flow clear` guidance.

A settled length outcome locally synthesizes `Response was truncated before completion.`. The ingress passes that detail through `flow-pause.ts` to the status extension's English pause notification route. By contrast, the admission-failed callback uses selected `FlowLedgerError` codes rather than forwarding the error message as a pause reason. These are source-confirmed callback routes, not induced failures or observed notifications.

### Queue diagnostics are not automatically notifications

`PiNativeDispatch.beforeQueueClaim` stores four catalog-resolved queued-refusal reasons in an accessor-visible map. A scoped search of `packages/cli/src` found declarations but no call to `PiNativeDispatch.heldInputs`; the separate ingress accessor reads persisted admission reasons instead. The native accessor alone is not evidence of user-visible text, nor is the scoped search a universal no-consumer claim.

Queue edit/cancellation errors can reject through the service's management methods. The inspected `/flow` catch sanitizes `Error.message` and sends fixed English operation-failed framing to `ctx.ui.notify`. Native checkpoint rejection handling is a different, incompletely inspected boundary.

### The custom Flow message has a source-confirmed renderer

`PiControllerHost.enqueue` creates a `display:true` `jouzu-flow` custom message. `flow-status-extension.ts` registers `renderFlowMessage` with the active catalog.

The renderer has fixed English wait/dependency/result/more-results/warnings/notification-only and image framing; work, alert and review-note labels use catalog IDs. Expanded or unknown content includes sanitized original text/JSON. The model-facing result envelope's review note and the collapsed warning label are different producers: the renderer resolves its own catalog review-note label rather than displaying the envelope's sentence directly.

This establishes a Jouzu renderer and its registration in source. It does not establish native `Text` layout, Japanese width or language quality, terminal execution, or unrelated tool fallback rendering.

### Wait response text has receipt-compatibility constraints

`wait-store.ts` validates retained tool-content hashes by rebuilding `waitToolResponse` formats 1, 2 and 3. Adjustment notices must match `WAIT_ADJUSTMENT_NOTICES`. `observedWaitToolReceipt` and ingress/wait-decision consumers require exact successful content hashes.

The response helper's English deadline/check/unmet/mode summaries and notices therefore participate in observation evidence, not just a display label. A text change needs compatibility consideration; this audit does not implement or test a migration.

`wait-producers.ts` supplies owned English exact-launch/handle/health-policy repair guidance. Tool execution rethrows refusals after subscription rollback; restoration and asynchronous observation failures go through supplied `onError` callbacks, with owned wrapping or an aggregate error where reporting also fails. Producer health detail remains preserved content. The fully read `wait-store.observeWaitHealth` confirms that the monitor writes only verdict state, not the health reducer's English reason prose.

### Storage and navigation do not produce a screen by themselves

`scalar-storage.ts` and `journal-storage.ts` emit owned English validation/closed/fenced errors while preserving stored payload. A failed append initially rethrows the source error; subsequent writes receive owned reopen guidance. `local-storage.ts` replaces its metadata-preflight failures with its own error, but journal-open failures can propagate through attachment/registry cleanup aggregates. No storage operation was executed.

`pi-session-registry.ts` rebuild returns a dropped count and optional saved path. Write-aside failure is swallowed, so a saved path is not guaranteed. Branch binding forwards the optional path through the service to runtime catalog framing; the inspected main-CLI sink wraps diagnostics with catalog-backed `console.error` text. Branch markers, verified hashes and transcript lifetimes establish source identity, not provider delivery or native navigation display.

### Earlier receipt and model-context boundaries still apply

- External receipt `reason.code` is stable protocol data; `reason.text` is catalog display prose. The adapter, inspected Pi forwarding methods and example transport pass receipts onward without a final receipt renderer. Ultimate client visibility remains unresolved.
- Grant authorization discards the detailed grant reason and throws a separate fixed English API error. Grant catalog equality is not evidence that its detailed sentences appear on that route.
- Native submission admission has a separate callback route to `announceHeldInput` and conditionally `ctx.ui.notify`. Not every hold notifies; automation and authorization branches differ.
- Host sender `You` and derived failure-stage labels remain local English arguments inside otherwise catalog-aware status reports. Dashboard final consumption remains unverified.
- Hidden wait snapshots use `display:false`; model-history repair placeholders do not rewrite the persisted transcript. Their wrapper bodies are now read, but imported host hidden-message handling and all downstream fallback consumers are not closed.

## Artifacts and reproducible checks

- `files.csv` / `full-read-findings.json`: exact fixed primary membership, full-body depth, source-specific producers/consumers and limits.
- `residual.csv`: header-only current remainder.
- `continuation-reads.json`: exact prior 24-file residual, starting counts and full-read ranges.
- `source-read-receipt.json`: primary hashes/counts and separate body-set completion versus false semantic/native sign-offs.
- `additional-full-read-findings.json` / `additional-source-read-receipt.json`: the three additional producer bodies, findings and hashes, outside primary counts.
- `traced-files.csv`: distinguishes additional full-read producers from scoped traces.
- `surfaces.csv`: unchanged shared eleven-column schema with `semantic-flow.` identifiers.
- `check-evidence.json` / `shared-check-evidence.json`: command, exit status and complete structural output; both checks exited 0 with no errors. The local check verified 103 pointer paths; the shared check reported no stale census or undispositioned sources. Structural success cannot prove reading, semantic correctness, exhaustive consumers or native behavior.
- `record-checks.py` / `regeneration-check-evidence.json`: repeat the bounded generator twice and save byte-hash comparisons plus both check receipts. Generated CSVs remained unchanged; refreshing the JSON receipts under Windows changed their byte hashes. The two local regeneration runs were identical. This is artifact determinism, not semantic evidence.

Reproduce without modifying original partitions:

```sh
python3 -B review/ja-localization/full-ui-audit/semantic-flow/build-ledger.py
python3 -B review/ja-localization/full-ui-audit/semantic-flow/check.py
python3 -B review/ja-localization/full-ui-audit/validate.py
```

The check receipts and regeneration comparison can be refreshed together with:

```sh
python3 -B review/ja-localization/full-ui-audit/semantic-flow/record-checks.py
```

The local check validates schemas, exact membership, source hashes/line counts, additional-scope separation, continuation range/count consistency and pointer existence. The shared check validates audit structure and census freshness, not semantic coverage. Regeneration determinism and final exact check outcomes are saved in the check receipts after validation.

Only `semantic-flow` artifacts were changed. No product tests, runtime jobs, Flow/tool operations, model/provider requests, network/account operations, installations, catalog/dependency/settings edits, native application runs, staging or commits were performed. The inspected test source is not a test-execution receipt. This bounded continuation stops here; remaining consumer/native limits are not new primary-body residuals or access failures.
