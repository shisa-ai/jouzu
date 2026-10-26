# Host consumers: TextGuard and direct/nested tool visibility

## Result: selected host boundaries closed in source, not runtime-approved

This follow-up traces the specific open host edges in [semantic-owned](../semantic-owned/README.md) and [semantic-flow](../semantic-flow/README.md) at source baseline `62dee0ff79ad83afa96947ea58e5c426bb1563e8`. It does not replace the broader [coverage limits](../COVERAGE.md) or grant whole-package approval.

The important distinctions are:

- **Fresh TextGuard filtering is not just model projection.** The execution-time replacement feeds the live tool-result event, and the later message-end pass feeds state and transcript storage. Live rendering precedes that second pass and can differ from restored history.
- **Restored-history request filtering is projection-only.** It filters a cloned request context; it does not rewrite the old transcript or drive native history rendering.
- **`model-only` does not hide terminal results.** It permits model declaration but excludes `ctx.executeTool()` lookup. Direct Flow results still follow ordinary event/history rendering. A catalog label does not localize the returned body or even select the generic call header.
- **Nested calls are not separate transcript results.** Their parent receives the outcome; bounded metadata can be stored on the parent's result. Whether a parent embeds or renders a nested body is parent-specific, not a universal host visibility guarantee.

[boundaries.csv](boundaries.csv) records **8 selected-source closures and 4 remaining boundaries**. Every closure retains its runtime/producer limitations.

## Evidence and finite scope

Computed by [verify.py](verify.py):

| Evidence | Count | Meaning |
| --- | ---: | --- |
| Source/file records | 42 | Exact selected dependency, owned callsite and authority paths |
| Full-body records | 23 | Small implementation bodies and metadata read through EOF |
| Full-body source lines | 2,840 | UTF-8 `splitlines()` lengths, not a semantic completion metric |
| Bounded-region records | 19 | Only the inclusive regions recorded in the receipt were inspected |
| Inspected source lines | 7,131 | Union of intervals per source path; includes full-body records |
| Exact declaration/expression anchors | 91 | Checked against installed or repository source lines |
| Meaningful surface/state families | 19 | Common eleven-column schema; not defects or executed screens |
| Distinct existing product-test pointers | 11 | Pointers only; none executed by this audit |
| Selected installed patch outputs matched | 6 | Immediate policy/session/history/native consumers, not every lock entry |

[files.csv](files.csv) uses the shared three-column file schema. [source-read-receipt.json](source-read-receipt.json) adds explicit depth, inclusive intervals, source length and SHA-256. A whole-file hash pins bytes; it does **not** turn a bounded read into a full-body review. The interval records declare inspection, not independently proven understanding.

[surfaces.csv](surfaces.csv) uses the exact common eleven-column schema with `host-consumers.` IDs. Its `entry_point` cells contain exact producer/consumer `path:L` anchors; [anchors.csv](anchors.csv) retains their exact source lines and distinguishes declarations from expressions. Original partitions are unchanged. The Flow additional-producer findings were read from `semantic-flow/additional-full-read-findings.json`; there is no Markdown file of that basename.

### Actual selected dependency output

- `packages/cli/src/main-cli.ts:L101` imports `@earendil-works/pi-coding-agent`. The selected package under `packages/cli/node_modules/` declares version `1.4.0` and `exports["."].import = "./dist/index.js"`; that index exports `main`, `AgentSession`, `createAgentSession` and the interactive components from the unbundled files inspected here.
- `dist/core/sdk.js:L2` imports agent-core. Its selected package is also `1.4.0`, exporting `dist/index.js`, then `agent.js` and `agent-loop.js`. The checker inspects only these two importers' package-ancestor candidates, without importing modules. Root-level and CLI-local package trees are not assumed interchangeable.
- `upstream/pi.lock.json` pins Pi and the content-policy deviation. The checker verifies the deviation manifest hash and the selected installed `dist/main.js`, `core/agent-session.js`, `core/sdk.js`, `core/session-manager.js`, `core/extensions/runner.js` and `modes/interactive/interactive-mode.js` against the manifest's `after` hashes. The apply script was read, **not executed**.
- Main wiring at `packages/cli/src/main-cli.ts:L740` passes `nativeTextguard.createPolicy`; selected Pi `dist/main.js:L645` supplies it to resource-loader construction. Child wiring passes the policy through `subagents/resources.ts` into the same session implementation. This is source selection, not proof that startup was run or a build artifact was launched.

Dependency paths below are relative to `packages/cli/node_modules/@earendil-works/`; complete paths and exact lines are in the CSVs.

## TextGuard: three separate passes

| Pass | Producer/consumer anchors | State/storage effect | Human content consumer |
| --- | --- | --- | --- |
| Executed tool result | `textguard-policy.ts:L370/L431` → Pi `core/agent-session.js:L352/L389` → agent-core `agent-loop.js:L615/L663` | Extension `tool_result`, image normalization, policy replacement, then finalized result event. Inspected original merge source is cleared so omitted fields do not reappear. | Interactive `tool_execution_end` at `interactive-mode.js:L2945` updates the live tool component. A native/preview/custom renderer can shorten or omit content. |
| Final message | agent-core `agent.js:L460` → Pi `agent-session.js:L751/L810/L966/L1023/L850` → `session-manager.js:L871/L838` | Agent state receives the object first. Policy mutates that object; later `message_end` extensions may replace it; public listeners run; then append/JSONL serialization uses the resulting message. | The live tool row already consumed its end event. History rebuild later consumes the final stored message, not necessarily the earlier event copy. |
| Next model request | Pi `sdk.js:L290` → `extensions/runner.js:L1007` → agent-core `agent-loop.js:L266` | Runner clones messages before context hooks; policy filters the request copy before conversion/streaming. No history rewrite is made by this pass. | Native rebuild at `interactive-mode.js:L3321` uses raw context entries and `session-manager.js:L172`, not the filtered provider-request copy. |

These routes close the prior display/storage-ordering uncertainty without claiming that one identical string appears everywhere.

`textguard-policy.ts` generates fixed English withholding/advisory text for model use. On these execution/history routes it can also be human-visible tool content. Guarded advisory retains the scanned text snapshot but removes flagged metadata/structured/nested fields without a programmatic advisory channel; strict withholding substitutes notice content. Successful policy checks and `off`/uninspected routes differ. Native renderer selection, not the producer's “model-facing” comment, decides what a human row displays.

The selected host also owns English fallback text: `Tool result withheld after cancellation.`, `TextGuard could not check this result; content withheld.`, `TextGuard could not check this message; content withheld.`, and `TextGuard could not check model context; request withheld.` These are separate from the catalog-backed human TextGuard alert/review route. Main still constructs the review extension without a catalog at `main-cli.ts:L755`; this follow-up does not change that prior finding.

Persistence here means the normal enabled/successful path, not a durability test: `SessionManager` retains entries in memory, delays initial file creation until conversation/forced flush, serializes JSONL when enabled, and can fail on native writes. This trace does not assert an unfiltered result archive is retained elsewhere.

Selected summarization helper `agent-session.js:L2344` similarly returns replacement entry objects for model summary input, without rewriting original message entries. Only the helper and immediate manual-compaction call were traced; this is not an audit of all summarizer/provider paths.

### Progress and later mutation limits

Direct inspected `tool_execution_update` events are suppressed by `agent-session.js:L751`. Nested execution is different: `L425` rejects an explicitly requested progress callback for checked calls, but otherwise nested runner events go through `extensionRunner.emit` and session `_emit`, not `_handleAgentEvent`. The native UI ignores nested starts and has no separate row to update; that does not prove arbitrary event clients receive nothing.

`message_end` extension replacement occurs **after** the message policy pass. The checker pins this ordering, not every possible extension's behavior. Nor does a model-request clone establish redaction of an already stored transcript, exported file, parent payload or another client.

## Model-only Flow tools, labels and native fallback

The selected factories register `agent_no_reply`, `agent_results`, `agent_wait` and `agent_wait_cancel` with `exposure: "model-only"`, catalog labels and no custom call/result renderers. See `no-reply-tool.ts:L36/L43/L61`, `result-tools.ts:L9`, and `wait-tools.ts:L269/L397`.

Pi `agent-session.js:L3129` permits direct/model-only declaration. `L1252` allows nested execution only for registered `codemode`/`deferred` tools and active `direct` tools. Consequently a nested model-only Flow request normally returns `Tool <name> not found` **before** either the owned direct-call refusal hook or the tool body. This is an execution-exposure rule, not a terminal hiding rule.

The native consumer chain is:

1. `interactive-mode.js:L1747` resolves tool renderer middleware, then `core/tools/renderers/index.js:L35` fills missing builtin renderer methods by name. These Flow names have no builtin renderer.
2. Live tool events and restored assistant tool calls create `ToolExecutionComponent` without checking exposure (`interactive-mode.js:L2918/L2945/L3233`). Restored results match call IDs.
3. Generic call fallback uses **raw tool name**, not `definition.label` (`tool-execution.js:L95`). Generic result fallback joins text blocks, showing the first ten lines collapsed and all lines expanded, with English remaining-line/expand framing (`L98`; `render-utils.js:L56`). Missing methods and throwing methods fall back independently.

Thus a localized tool label does not localize the English no-reply result, wait summary/adjustment notices, JSON metadata, refusal or generic call header. Retained references, cursors, reasons, source titles, hashes and other protocol fields must not be blanket-translated. Wait-result hashes remain a compatibility constraint established in `semantic-flow`, not revalidated by running a wait here.

`terminate:true` also does not hide the result. Both execution modes emit end/message events before batch termination; agent-core `agent-loop.js:L482` requires every finalized result to terminate. A nonterminating sibling prevents this batch termination. `createToolResultMessage` at `L673` keeps the content but does not copy `terminate` into the transcript message. No no-reply operation was performed.

## Nested calls and child context

### What the host actually retains

`extensions/runner.js:L697` supplies `ctx.executeTool()`. Pi `agent-session.js:L425` delegates to `NestedToolCallRunner`; the same tool preparation/execution/hook implementation returns an outcome to the parent.

`core/nested-tool-calls.js:L98` emits events with `parentToolCallId`, but does not create an individual transcript result. The recorder retains bounded arguments, name/ID/status/duration, completeness and usage; errors keep at most 500 characters (`L56`). Successful nested result bodies are **not** retained in that metadata. `takeRecord` at `L168` attaches the summary to the parent result before its message-end policy pass. An inspected parent can lose that metadata through policy replacement.

The native UI skips nested starts (`interactive-mode.js:L2918`); generic fallback never consumes `nestedCalls`. A parent tool can still embed the outcome in its returned content, forward progress or install a custom renderer. Therefore “no separate row” is not “no possible visible nested content.” Default native codemode's factory is empty in `classic-host-policy.ts`; arbitrary extension-tool callers remain possible. No alternate codemode renderer is certified as active here.

### `parent_context` is a child tool, not an observed child screen

`subagents/worker.ts:L68` creates `parentContextTool(path)` without a catalog, registers it as a custom tool and adds its name to the child's tools. `subagents/context.ts:L136/L155` has no custom renderer and no exposure override, so exposure defaults `direct`: it is directly model-callable and, while active, callable through `executeTool()`.

Its English default label is not proof of a visible English label: the generic native header uses `parent_context`, and the selected worker binds **print mode** at `worker.ts:L158`, not a child interactive TUI. The body is JSON trace records with preserved parent evidence; `subagents/trace.ts:L125` uses its default catalog for validation and owns additional fixed English pagination/incomplete-line notices. Direct lookup creates a child result message; nested lookup returns a parent outcome plus bounded metadata instead.

A direct child tool result is forwarded as `tool:<name>` message text, bounded to 16000 characters (`worker.ts:L212`), and recorded by manager `L597`. Parent inspection is consumer-dependent:

- `subagent` **read** obtains event-page text (`manager.ts:L380`). Its registered `renderResult` (`integration.ts:L646`) selects `subagentComponent`; the read branch at `render.ts:L183` shows the catalog-backed output-received role summary rather than tool-message body, including expanded mode.
- **trace** reads the saved child session (`manager.ts:L407`, `integration.ts:L787`); the generic result branch can show JSON/text excerpts. It is not the same event-page summary.
- Nested calls do not emit their own child `message_end`, so their bodies are not independently forwarded by that callback.

The parent final answer, alternate Workflow/dashboard viewers and model quotations remain separate consumers; no claim that they all hide or expose the same body is made.

## Refusals and exception conversion

- **Child permissions/budget:** `subagents/tool-policy.ts:L4`, registered at `worker.ts:L109`, returns owned English access/budget reasons. Pi `agent-loop.js:L498` turns a block into text with `isError:true`, without an `Error:` prefix. Eligible direct calls feed ordinary result events/child history; nested calls return the reason to their parent and bound it into error metadata. Missing/excluded/inactive nested tools can fail lookup before reaching this hook. Budget exhaustion also selects the worker's separate English incomplete outcome.
- **Direct-call policy:** `classic-host-policy.ts:L26`, registered at `main-cli.ts:L744` and `worker.ts:L115`, blocks listed nested names with callable exposure that reach its hook with `Call <tool> directly, not from another tool, so its result can be acknowledged.` Selected Flow and `subagent` (`integration.ts:L625`) are model-only and excluded earlier. No active direct member of this policy list is proven by the finite selection here; other registrations or exposure overrides remain conditional, not confirmed visible refusals.
- **Tool execution or `tool_call` failure:** `agent-loop.js:L498/L585/L615` copies `Error.message` or `String(error)` into error-result text. Runner `emitToolCall` at `L958` deliberately does not catch; session `L330` preserves an `Error` or adds `Extension failed, blocking execution:` for a non-Error. Immediate lookup/validation/block failures skip `afterToolCall`; executed outcomes pass through it and can be replaced by TextGuard.
- **`tool_result`/`message_end` handler failure:** runner `L901` and its message-end implementation catch/report/continue; they do not automatically replace the tool result with that error. Interactive error binding instead adds native extension-error chat with a dim stack. The child print binding aborts its failure controller rather than mounting that chat.
- **Awaited extension command failure:** session `L1812` emits `command:<name>` through `emitError` and treats the command as handled. Interactive `L1516/L2399` shows `Extension "<path>" error: <message>`; this is not Jouzu's catalog generic-error wrapper or a stored tool result. The scoped localization adapter and output branding do not translate this generic error component.

Error payload provenance remains explicit: a dynamic message can be owned English, extension-authored, OS/native/library-derived or source/provider content. Known conversion does not classify every possible producer.

### Immediately reachable startup exception closed

`model-picker.ts:L1284` calls `store.load()` outside a load catch; `model-picker-state.ts:L356` rethrows unsafe regular-file and size-limit errors instead of quarantining. The `session_start` handler at `model-picker.ts:L1405` calls `syncSession`.

Pi `bindExtensions` at `agent-session.js:L2828` installs the error listener before emitting startup. Runner `emit` at `extensions/runner.js:L814` catches the awaited handler error, sends message/stack to that listener and continues subsequent handlers. Interactive `L1516/L2399` displays native English extension framing around the owned state error. This closes the previous uncaught-startup-event consumer question; successful quarantine remains a different catalog warning route. No corrupt-state fixture or startup was run.

## Exact remaining boundaries and stopping point

The four open records in [boundaries.csv](boundaries.csv) are not unread primary-body claims:

| Boundary | What remains |
| --- | --- |
| Settings keyboard callback | `catalog-settings.ts:L1257` plans synchronously from `handleInput` (`L1744`). The final Pi custom-view/TUI keyboard exception handler was not traced. An awaited command catch does not establish this later callback's display. |
| Arbitrary parent tool/renderer | The host returns nested outcomes and permits renderer middleware. Selecting every extension parent/renderer is unbounded; no universal hidden/visible result claim is possible from this trace. |
| Native presentation | Japanese wording, CJK width, clipping, expand/key behavior, images, focus, abort races, scanner/native/OS behavior and real storage success were not exercised. |
| Downstream model/other clients | Trace stops at converted request input. Provider implementations, remote response language, final external-receipt rendering and alternate clients are not approved. |

This finite follow-up stops after these host boundaries. No provider sweep, arbitrary extension census, audio callback continuation, exported-viewer re-audit or whole-package approval is implied.

## Reproduce the static checks

From the repository root:

```sh
python3 -B review/ja-localization/full-ui-audit/host-consumers/build-ledger.py --check
python3 -B review/ja-localization/full-ui-audit/host-consumers/verify.py
python3 -B review/ja-localization/full-ui-audit/host-consumers/test-verify.py
python3 -B review/ja-localization/full-ui-audit/validate.py
```

Omit `--check` only to intentionally regenerate this partition's five derived artifacts from the reviewed definitions. The generator writes only this directory. It cannot prove the authored findings; it resolves exact anchors and records bytes/depth.

`verify.py` independently checks common schemas, required cells, unique file/anchor/surface/boundary membership, source hashes/lengths, read intervals, full-body depth, anchor lines inside inspected ranges, route and test pointers, selected import/export/patch identity and false-signoff guards. `test-verify.py` has **9 in-memory validator tests** covering the valid snapshot and malformed schema, stale anchor/hash, false full-body depth, missing boundary, false native/runtime closure and unanchored route. These test the audit machinery, not the product.

Refresh the complete command outputs, repeated check-only generation comparison and artifact hygiene receipt with:

```sh
python3 -B review/ja-localization/full-ui-audit/host-consumers/record-checks.py
```

[check-evidence.json](check-evidence.json) records exact commands, exit statuses and complete stdout/stderr. The generator comparison (including its repeat), local validator, 9-test guard suite and shared validator all passed with **exit 0**; no local structural or artifact hygiene errors were reported. The shared check reports no stale census or undispositioned candidates; its combined row count includes concurrent audit partitions and is not this partition's count. `git diff --check` and a separate relative README-link check also passed.

Structural success is not semantic exhaustiveness or Japanese/native approval. Both runtime and whole-package sign-offs stay false.

Only `review/ja-localization/full-ui-audit/host-consumers/` is written. No product/runtime modules imported, product tests executed, scanner/model/tool operations, network, installs, provider/account actions, product/catalog/dependency/settings edits, staging or commits were performed.
