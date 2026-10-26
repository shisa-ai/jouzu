# Dependency semantic sinks and exported HTML viewer

**Continuation status:** the first-pass findings, tables and check results below are preserved as a snapshot. The [finite continuation](#finite-continuation-exact-residual-producerconsumer-audit) appends evidence and gives the current state of each original residual. `residuals.csv` is the unchanged original question set, not a claim that all 13 remain source-open. Current totals are in `validation.json`.

## Result and scope

All **27 primary files** in [`../dependencies/unresolved-candidates.csv`](../dependencies/unresolved-candidates.csv) have a source-based disposition and a clarified surface, payload or route family here. The exported viewer's immediate implementation/asset graph is dispositioned. **This closes those candidate and immediate-asset boundaries, not the whole dependency diagnostic graph or a Japanese runtime audit.**

The candidate list defines the primary universe independently of this ledger. Full candidate implementations were inspected along with immediate selection/caller code. Supporting files extend the inventory only where needed to identify text ownership or the selected consumer. No product, dependency, catalog or settings source was changed. No runtime modules were imported; no browser, provider, network, account, installer or package-install actions were performed. The original partitions are unchanged by this inventory.

Counts below are computed in [`validation.json`](validation.json), not inferred from translated keys or source hashes. A state-family row is neither a unique-string count nor a completed runtime scenario.

| Evidence | Records |
| --- | ---: |
| Primary candidate paths / dispositioned | 27 / 27 |
| Primary paths without a clarified family | 0 |
| Additional file dispositions | 15 |
| Total `files.csv` dispositions | 42 |
| `surfaces.csv` state/payload/route families | 73 |
| Distinct surface source files | 39 |
| Immediate export implementation/assets / dispositioned | 9 / 9 |
| Verified surface declaration/expression anchors | 73 |
| Verified immediate route anchors | 37 |
| Families with an existing test pointer | 22 |
| Explicit residual source/consumer boundaries | 13 |

### Artifacts

- [`files.csv`](files.csv): exact three-column audit schema; per-file semantic, caller, payload and adaptation conclusions. The additional dispositions cover immediate viewer assets and direct diagnostic/settings/preview producers.
- [`surfaces.csv`](surfaces.csv): exact eleven-column schema required by the full audit validator; IDs start with `semantic-dependencies.`. Fixed interface copy, local diagnostics, arbitrary payload, conditional selection and exclusions are distinguished in the findings and evidence levels.
- [`source-anchors.csv`](source-anchors.csv): exact matched source lines for each surface. `implementation:function`, `implementation:class` and `implementation:method` anchor declarations/bodies, never earlier calls/imports. `declaration:initializer` anchors a variable initializer without asserting a function body. Markup, style and source-expression anchors explicitly identify their different evidence.
- [`routes.csv`](routes.csv): declaration/expression anchors and conclusions for release selection, renderer merging, export embedding, adaptation, widget claims and direct consumers. Surface entry points cite these source paths and lines.
- [`residuals.csv`](residuals.csv): exact source files, consumers and remaining checks at the stopping boundary. These are not undispositioned primary candidates.
- [`build-ledger.py`](build-ledger.py), [`validate.py`](validate.py): source-only regeneration and independent structural checks. Hash equality is not used as semantic proof.
- [`check-results.json`](check-results.json): executed check commands, exit codes and bounded result summaries; no product-runtime test claim.

| `evidence_level` | Records | Meaning |
| --- | ---: | --- |
| `reviewed-source-family` | 57 | Grouped implementation/state finding; no runtime observation |
| `reviewed-payload-and-consumer-boundary` | 7 | Data/layout/forwarding behavior and consumer traced; arbitrary producer text is not all classified |
| `reviewed-route-exclusion` | 6 | Native codemode or old WebAIO registration/renderer not selected by the inspected release host |
| `reviewed-route-selection` | 2 | Export or preview renderer ownership resolved |
| `reviewed-non-sink` | 1 | Comment-only mechanical match, not executable UI |

## Findings that change the candidate interpretation

### A comment is not a sink

The `agent-session.js` candidate at line 1738 is the documentation comment mentioning `pi.registerCommand`. It is not an executable registration or displayed sentence. The actual `prompt` and `_tryExecuteExtensionCommand` implementations are anchored separately: command-handler exceptions are forwarded through `emitError` to the extension-error consumer. That payload can include locally produced diagnostics; neither blanket translation nor blanket remote-content exemption is justified.

`FooterDataProvider.onBranchChange`, `VisualLinePreview`'s measuring `Text`, the cooperative preview wrapper's fallback `Text`, and the stacked widget's `setWidget` calls are also not independent fixed-English defects. Their producers and consumers determine text ownership. The footer does create a local `detached` marker for native presentation, but Jouzu's selected replacement footer refreshes its own Git state; a source marker is not proof of its active placement.

### Preview settings are not a native-renderer switch

The release preview entry registers tool overrides at `session_start`. `getEnabledCodePreviewTools` applies the environment/saved set **and** `getEffectiveCodePreviewToolSet`; disabling certain content/result previews can require the preview override so that it can hide the content. The settings UI describes tool-registration changes as taking effect after `/reload`, and the session tracks already-registered tools. A setting value alone does not prove which renderer is selected.

A non-builtin tool conflict yields `skipped-conflict` and keeps that extension's tool. It does **not** automatically select Pi's native renderer. `withBuiltInRenderers` fills missing call/result methods individually. Existing extension/preview methods win; a throwing method falls back to generic rendering in `ToolExecutionComponent`, not a second native-renderer attempt.

For `find` and `ls`, the preview tool spreads the native definition to retain execution/schema, then replaces both renderers. Loading, error fallback, empty-result labels, hidden previews and count/expand footers belong to the preview implementation. Real path lists, patterns, source output and technical tool names remain payload. The native renderer families remain conditional routes with separately identified English framing.

### The viewer is a separate language surface

`/export` passes a custom tool HTML renderer through `AgentSession.exportToHtml`; the standalone file-export route does not supply one. Both reach `generateHtml`, which embeds:

- `template.html`, `template.css` and `template.js`;
- `vendor/marked.min.js`, `vendor/marked-cjk-friendly.min.js` and `vendor/highlight.min.js`;
- base64 session data and resolved theme colors.

`tool-renderer.js` and `ansi-to-html.js` complete the immediate render-adapter graph. Source maps and TypeScript declarations are not extra executable viewer assets. The inspected installed Node package selects the `dist` asset directory because it has no `src` directory; binary packaging branches were read but not executed.

No selected Jouzu locale/catalog is injected into the viewer. The document has `lang="en"` and the title `Session Export`. Browser-default date/number formatting is not evidence that Jouzu's selected language is wired through.

The source-English UI families include:

- Sidebar search, five filters and tooltips, open/close controls and resize accessible name; tree roles/event labels, no-text/aborted states and visible/total entry count.
- Session/statistics headings and unknown values; thinking/tools/hidden-message buttons, shortcut hints and pressed states; JSONL download title.
- Copy-link tooltip and temporary success mark. Clipboard fallback exceptions log `Failed to copy:` to the browser console; no visible failure toast is implemented.
- Thinking placeholder, skill expansion hint, assistant error/abort and shell cancel/exit framing; model-switch, compaction, branch-summary and terminal-hidden custom-message framing.
- Output line-count/expand/limit hints, invalid argument/type messages, nested-call count/incomplete/omitted-arguments framing, system-prompt and available-tool headings, required/optional parameter labels.
- **CSS-generated** `[click to show parameters]` and `[hide parameters]`. A terminal sink scan cannot inventory these controls.

`bash`, `read`, `write`, `edit` and `ls` are rendered by browser branches even when a terminal preview override exists. Other tool names can carry pre-rendered custom terminal UI. The HTML adapter returns `undefined` on missing/throwing renderers, allowing structured browser fallback; it does not add a render-error banner. Async native edit preview work is not awaited by that adapter.

Sidebar width persistence failures are swallowed without a visible error. The template contains image-modal markup but the inspected browser script has no handlers that activate it; the markup is not counted as a working zoom control. `safeMarkedParse` directly calls `marked.parse` without a catch; malformed-Markdown behavior remains unexecuted. Highlighting exceptions fall back to escaped source. CJK emphasis support in the vendored parser is not Japanese interface localization.

### Exclusions are tied to actual selection

- **Native codemode:** `main-cli.ts` supplies `classicHostBuiltinOverrides()`. Its builtin `codemode` factory is empty. `DefaultResourceLoader.loadExtensionPaths` resolves supplied builtin factories; it does not substitute the native `createCodemodeExtension` implementation in that case. The native renderer's English strings are inventoried as an alternate-factory route, not an active Jouzu screen.
- **The five WebAIO candidates:** the release manifest selects `dist/src/jouzu-extension.js`. Release argument injection and configured-release-resource suppression establish that selection. The selected entry registers only `web_fetch` and `batch_web_fetch` through `webfetch-api.js`; it does not register/import the candidate `tools/lazy.js`, `tools/render-result.js`, `tools/search-render.js`, `tools/webfetch.js` or `tools/websearch.js` routes. These exclusions do **not** exclude the active static API, its local extractor/transport diagnostics, or arbitrary alternate user imports.
- **Stacked background widget:** the stack owns ordering/layout, not every producer's wording. The background producer requires visible tasks and no active presentation claim. A claimed dashboard source can suppress that native widget and later release it. This does not prove all stacked widgets are hidden or that their replacement placement was exercised.

### Local diagnostics are not remote content

Native edit previews expose fixed local access/match/duplicate/empty/no-change/overlap diagnostics from `edit-diff.js`. Loader validation and invalid-factory/load wrappers are local diagnostics even though they live in dependency code. Preview settings reset/save notices and nested category/value/expand text are extension-owned UI.

Jouzu's adaptation patches selected Pi components and owned `SettingsList`/`SelectList` graphs, not every generic `Text`, notification, renderer or `ui.custom` subtree. `/code-preview-settings` constructs third-party lists/submenus outside that ownership path. Localizing a slash description or root label does not localize nested setting values, summary sentences, save warnings or theme-selection hints.

Preserve user messages, model/reasoning text, summaries, shell output, code/diffs/files, paths, URLs, IDs, configured key bindings and technical tokens. Tool/schema descriptions and dynamic error/status strings need producer-specific ownership; they are not automatically remote or user-authored just because they arrive dynamically. Translate the separately identified local interface framing rather than rewriting arbitrary payloads.

## Closed and open boundaries

**Closed at source level:** every primary candidate; its immediate selection/caller/adaptation disposition; all immediate exported-viewer implementation/assets and control/state families; the `find`/`ls` preview override/native distinction; the five WebAIO module exclusions and native codemode replacement; helper-versus-copy ownership for the candidate layout/data sinks.

**Still open:** the exact residual producer/consumer pairs in `residuals.csv`: execution diagnostics in the eight native tool implementation files; arbitrary loader/factory errors; arbitrary extension status producers/native-versus-replacement footer placement; active `webfetch-api.js` transport/extractor/PDF/security diagnostics; malformed-Markdown browser outcomes; preview timing/width behavior. The immediate interfaces of the vendor scripts are dispositioned, not every syntax grammar or transitive dependency branch.

No viewer/terminal execution, screenshots, Japanese wording approval, CJK/narrow-width fit, cancellation restoration, clipboard/download capability test, native platform certification or whole-transitive-package completeness is established. Existing test paths are relevant contracts inspected as source, not tests rerun or proof of Japanese rendering. The broader audit's original unfinished records remain unchanged; this bounded ledger supplies new evidence rather than silently replacing those historical records.

## Executed checks

All three source checks below exited **0**, with their commands and results saved in `check-results.json`. Regeneration comparison and independent validation reported all primary paths, all immediate export assets and no errors. The combined validator reported 500 tracked source candidates dispositioned, 1,583 combined surface rows, no undispositioned tracked sources and no structural/staleness errors. These combined counts include other audit partitions and do not imply semantic or runtime completion.

A separate read-only check found no trailing whitespace, missing final newlines, NUL characters or broken relative README links in the new artifacts. Product/runtime suites were not run under this source-only scope.

## Reproduce source checks

Run from the repository root; these commands do not import product runtime modules:

```sh
python3 -B review/ja-localization/full-ui-audit/semantic-dependencies/build-ledger.py --check
python3 -B review/ja-localization/full-ui-audit/semantic-dependencies/validate.py
python3 -B review/ja-localization/full-ui-audit/validate.py
```

Omit `--check` only when intentionally regenerating the new ledger files after reviewing source changes. The builder writes only this directory. It independently derives the primary universe from the candidate CSV, resolves unique declarations/explicit expressions, checks source membership and all immediate export implementation/assets, and computes record counts. The independent validator checks exact schemas, required cells, unique IDs, source/test references, declaration shapes, exact source lines and count parity. The full validator adds combined-partition schema/source-census checks. None can certify semantic exhaustiveness or runtime language behavior.

## Finite continuation: exact residual producer/consumer audit

This continuation resolves the statically answerable part of the **13 original residuals**, without rewriting their original row content, order or meaning. It inspected every named native tool implementation in full and traced its immediate authored diagnostics into result/error conversion and selected preview/native/browser consumers. It also inspected the full active `webfetch-api.js` and selected single/batch adapter, then the relevant security, bot, redaction, transport, HTML extraction, PDF and diagnostic-capture paths.

**Nine boundaries are closed at the selected-source level; four remain open for runtime or unbounded-producer reasons.** “Closed at selected source” means the named default implementation's authored framing and immediate consumer route are classified. It does not certify every possible filesystem, shell, native binary, PDF.js worker, DOM/converter grammar or injected-operation error string. Those technical payload boundaries remain explicit rather than being relabeled as local UI or remote content.

### Appended evidence and current counts

The continuation's surface IDs begin `semantic-dependencies.continuation.`; its route IDs begin `continuation.`. Existing `files.csv` records remain first, with newly identified paths appended rather than sorted back into the snapshot.

| Evidence | First pass | Appended | Current |
| --- | ---: | ---: | ---: |
| File dispositions | 42 | 42 | 84 |
| Surface families / exact surface anchors | 73 | 62 | 135 |
| Immediate route anchors | 37 | 8 | 45 |
| Original residual questions | 13 | 0 | 13 |
| Original residual source-resolution records | 0 | 13 | 13 |
| Active non-source/technical-payload limit records | 0 | 7 | 7 |

The primary candidate and immediate export-asset boundaries remain **27/27** and **9/9**. The current families cover **81 distinct source files**; **22** retain existing test pointers from the first pass. No runtime test was run, and an existing test pointer is not execution evidence.

New supporting artifacts:

- [`residual-resolutions.csv`](residual-resolutions.csv): `original-01` through `original-13`, in the exact order of the unchanged `residuals.csv`. Each record states source status, linked continuation evidence, and the remaining limit/check.
- [`continuation-limits.csv`](continuation-limits.csv): the retained runtime, arbitrary-producer and opaque technical-payload limits. Cross-cutting clipboard/browser capability limits are retained separately; they are not counted as an additional original residual.
- [`snapshot-preservation.json`](snapshot-preservation.json): original CSV headers, row hashes/order and byte-prefix receipts, plus historical JSON receipts. These prove preservation, not semantic correctness. `check-results.json` remains byte-identical; `validation.json` intentionally contains updated totals.
- [`continuation.py`](continuation.py): appended source-only evidence definitions consumed after the original builder's rows. The builder checks the original CSV byte prefixes before writing.
- [`test-validation.py`](test-validation.py): seven source-ledger guard tests covering the valid snapshot, original residual/surface mutation, false runtime closure, missing continuation evidence, stale anchors and rewritten historical check results. Temporary fixtures stay in this directory and are cleaned up.
- [`continuation-check-results.json`](continuation-check-results.json): continuation command outcomes, including the initial guard-test deadline and the successful rerun. The historical `check-results.json` is not overwritten.

### Exact disposition of the 13 original boundaries

| ID | Original source boundary | Current status | Remaining limit |
| --- | --- | --- | --- |
| `original-01` | `core/tools/bash.js` | Closed at selected source | Actual shell/OS output, custom operations/hooks, process/timing/platform outcomes remain payload or execution boundaries. |
| `original-02` | `core/tools/powershell.js` | Closed at selected source | Shared shell framing and PowerShell discovery are traced, not native Windows behavior verified. |
| `original-03` | `core/tools/read.js` | Closed at selected source | File/image data and concrete filesystem/image-worker outcomes are not translated or runtime-certified. |
| `original-04` | `core/tools/write.js` | Closed at selected source | Native and preview replacement producers differ; filesystem results and concrete cancellation remain unexecuted. |
| `original-05` | `core/tools/edit.js` | Closed at selected source | Local validation/access/match/success framing is separated from source/diffs and external errors; runtime application is untested. |
| `original-06` | `core/tools/find.js` | Closed at selected source | Authored availability/abort/spawn/limit framing is separated from `fd` stderr and path data. |
| `original-07` | `core/tools/grep.js` | Closed at selected source | Authored availability/read-fallback/limit framing is separated from `rg` stderr and matching source. |
| `original-08` | `core/tools/ls.js` | Closed at selected source | Authored path/directory/read/empty/limit framing is separated from names and underlying error messages. |
| `original-09` | `core/extensions/loader.js` | Open: unbounded producers | Arbitrary imported modules/factories/handlers can create errors. Known wrappers do not classify that entire universe. |
| `original-10` | `core/footer-data-provider.js` | Open: unbounded producers and runtime | Status carrier and selected replacement reads are source-traced; arbitrary status authors and actual placement/width are not closed. |
| `original-11` | `pi-webaio` `webfetch-api.js` | Closed at selected source | Immediate local API/extractor/transport framing and consumers are resolved; native/PDF.js/DOM/grammar payload universes and input-dependent execution remain explicit limits. |
| `original-12` | exported viewer `vendor/marked.min.js` | Open: runtime | Source establishes direct parsing without a catch, not malformed-input document/console outcomes. |
| `original-13` | preview `tool-timing.ts` | Open: runtime | Duration units/state producers are known; elapsed/repaint/Japanese/key-binding/narrow-width fit needs execution. |

### Findings from the continuation

**Native results do not have one universal consumer.** Agent-core copies a thrown `Error.message` or `String(error)` into result text; it does not add an `Error:` prefix at that conversion. An `afterToolCall` hook can replace content and its error flag. Native rendering, preview overrides and exported-browser branches then consume different fields or suppress different text:

- The selected read/edit/grep error preview shows the first result line; write shows the full error text. Bash selects output lines and may hide an appended status outside its collapsed limit. Exact find/grep/ls empty markers select preview-owned empty states.
- Native write success suppresses its `Successfully wrote to` result text. A normal preview write replaces execution with its own `Successfully wrote <bytes> bytes to` producer and before-content state; it does not merely replace rendering.
- Browser `bash`/`read`/`write`/`edit`/`ls` branches consume result text or diff details directly. Other names may use custom pre-rendered terminal output. Terminal preview selection is therefore not proof of browser copy selection.
- `ensureTool` is called by find/grep without its optional status callback. Download/progress/failure messages inside that helper are silent on these result routes; the tools produce their own unavailable diagnostics. No download/install was performed.

**The active fetch route contains local diagnostics, not just returned page text.** Authored option/URL/security/budget/redirect/retry/cancellation/HTTP/type/JSON/bot/empty/PDF framing flows through `failureResult` and the selected adapter. Its generic `network_error` classification can contain a PDF/parser/DOM/native failure and is not provenance proof. Default wreq `statusText` is derived from Node `STATUS_CODES`; it is not the remote server's reason phrase. An injected transport can supply a different value.

Single-fetch model/history output retains the full failure framing, but the original terminal renderer shows only `Fetch failed[: code]`. Batch expanded rows show the per-item message, phase and retryability. The appended diagnostic renderer is a separate route from that original compact result.

**Defuddle warnings survive successful fallbacks.** `defuddle/node` receives a Document, uses `useAsync:false`, and runs synchronous extraction plus optional Markdown conversion. The scoped console bridge retains bounded, redacted diagnostics in tool text/details; the final renderer adds a diagnostic count when collapsed or entries when expanded. These are not necessarily failures of `result.ok`:

- Core document/schema/media/style, registry, metadata, MathML/LaTeX, ChatGPT/Grok citation and synchronous YouTube DOM/inline-JSON diagnostics have authored prefixes, with page/technical values kept separate.
- `Error converting HTML to Markdown:` and `Problematic content:` are captured prefixes. The conversion fallback also returns **`Partial conversion completed with errors. Original HTML:`** inside successful content. The following HTML remains page content.
- PDF handling adds **`PDF Content (<pages> pages)`** and can add the default **`-- <page> of <total> --`** separator. These are extractor-authored framing inside returned text, not verbatim document text. `getException` preserves underlying error messages; its class defaults are not proof of which message a corrupt document produces.
- Async transcript/network/opened-DOM paths are excluded by `useAsync:false`; the selected static extractor supplies a network-denying fetch seam. The package's old tool modules remain excluded as in the first pass.
- wreq native-binding loading occurs during module evaluation. Its authored unsupported-platform/load instructions therefore take the extension-loader diagnostic route, outside fetch-result failure normalization. The audit did not import that native module.

**Non-source limits remain limits.** No terminal/browser layout, repaint, cancellation restoration, clipboard permissions/fallback, download capability, malformed-Markdown outcome, Japanese wording/width or native platform behavior was executed. Arbitrary extensions/status/error producers and injected operation/hook values remain open universes. The source receipt and validator cannot certify those behaviors.

### Continuation checks

The final source checks and seven guard tests passed; exact commands and captured outcomes are in `continuation-check-results.json`. The initial guard-test run reached the shell deadline while repeatedly reading/statting the same source paths; the independent validator now caches those reads/checks within one validation call. The unchanged rules and mutation tests pass on rerun. This was a ledger-check timeout, not a product/UI test.

In addition to the three original source commands, run:

```sh
python3 -B review/ja-localization/full-ui-audit/semantic-dependencies/test-validation.py
```

The combined validator's counts include concurrent audit partitions and are recorded as observations, not attributed entirely to this continuation. No original partition, product/dependency/catalog/settings source, staging area or commit was changed by this continuation. No runtime imports, browser/network/account/provider operations or installations were performed.
