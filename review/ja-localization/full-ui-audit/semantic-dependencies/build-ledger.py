#!/usr/bin/env python3
"""Build a bounded semantic source ledger without importing product modules."""

import argparse
from collections import Counter
import csv
import io
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
AUDIT = HERE.parent
PI = "packages/cli/node_modules/@earendil-works/pi-coding-agent/dist/"
PREVIEW = "packages/cli/node_modules/pi-code-previews/src/"
BG = "packages/cli/node_modules/@vanillagreen/pi-background-tasks/extensions/"
WEB = "packages/cli/node_modules/pi-webaio/dist/src/"
CLI = "packages/cli/src/"
SURFACE_HEADER = ["surface_id", "owner", "source_file", "source_symbol", "entry_point", "state", "locale_path", "source_finding", "evidence_level", "existing_test", "coverage_limit"]
FILE_HEADER = ["source_file", "disposition", "evidence"]


def read_csv(path):
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def csv_text(header, rows):
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=header, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue()


def build():
    primary = {row["source_file"] for row in read_csv(AUDIT / "dependencies/unresolved-candidates.csv")}
    files, surfaces, anchors, routes, residuals = {}, [], [], [], []
    texts = {}

    def lines(source):
        if source not in texts:
            assert not Path(source).is_absolute() and ".." not in Path(source).parts, source
            texts[source] = (ROOT / source).read_text(encoding="utf-8").splitlines()
        return texts[source]

    def anchor(source, name, kind="function"):
        if kind == "function":
            pattern = rf"^(?:export )?(?:default )?(?:async )?function {re.escape(name)}(?:[<(])"
        elif kind == "class":
            pattern = rf"^(?:export )?class {re.escape(name)}(?:\s|\{{)"
        elif kind == "method":
            pattern = rf"^\s+(?:private |public |protected )?(?:async )?{re.escape(name)}\("
        elif kind == "initializer":
            pattern = rf"^\s*(?:export )?(?:const|let) {re.escape(name)}\s*="
        else:
            pattern = "^" + re.escape(name) + "$"
        matches = [(number, line) for number, line in enumerate(lines(source), 1)
                   if re.search(pattern, line if kind == "method" else line.strip())]
        assert len(matches) == 1, (source, name, kind, [number for number, _ in matches])
        number, matched = matches[0]
        prefix = "implementation" if kind in {"function", "method", "class"} else "declaration" if kind == "initializer" else kind
        symbol = f"{prefix}:{kind} {name}:L{number}"
        return {"source_file": source, "source_symbol": symbol, "line": number, "matched_line": matched}

    def ref(source, name, kind="function"):
        item = anchor(source, name, kind)
        return f"{source}:L{item['line']}"

    def route(identifier, source, name, conclusion, kind="function"):
        item = anchor(source, name, kind)
        routes.append({"route_id": identifier, **item, "conclusion": conclusion})
        return f"{source}:L{item['line']} ({identifier})"

    def file(source, disposition, evidence):
        lines(source)
        assert source not in files, source
        files[source] = {"source_file": source, "disposition": disposition, "evidence": evidence}

    def surface(identifier, source, name, entry, state, finding, locale=None, owner="Pi", test="", limit=None, kind="function", level="reviewed-source-family"):
        item = anchor(source, name, kind)
        if not test:
            if identifier == "codemode-inactive":
                test = "packages/cli/test/classic-host-policy.test.mjs (selection contract; not run here)"
            elif identifier.startswith("webaio-"):
                test = "packages/cli/test/release-extensions.test.mjs (release selection contract; not run here)"
            elif identifier.startswith(("preview-", "cooperative-")):
                test = "scripts/code-previews.test.mjs (build/source contracts, not Japanese rendering; not run here)"
            elif identifier == "stacked-widget":
                test = "packages/cli/test/work-dashboard-sources.test.mjs (claim-source contract; not run here)"
        row = dict(zip(SURFACE_HEADER, [
            "semantic-dependencies." + identifier, owner, source, item["source_symbol"], entry, state,
            locale or "Source English; no catalog argument or matching terminal adaptation at this renderer.",
            finding, level, test,
            limit or "Static implementation and immediate caller evidence only; no rendered Japanese fixture or runtime traversal. Preserve source payload rather than translating arbitrary output.",
        ]))
        surfaces.append(row)
        anchors.append({"surface_id": row["surface_id"], **item})

    def residual(source, consumer, boundary, check):
        lines(source)
        residuals.append({"source_file": source, "consumer": consumer, "boundary": boundary, "remaining_check": check})

    manifest = route("release-manifest", "packages/cli/release-extensions.json", '"extensions": ["dist/src/jouzu-extension.js"],', "Selects Jouzu's WebAIO extension file, not the package-default entry or tools/lazy.js.", "source-expression")
    release = route("release-paths", CLI + "release-extensions.ts", "withReleaseExtensionArguments", "Prepends resolved manifest extension/skill paths except package-management commands; required failures stop launch.")
    suppress = route("release-suppression", CLI + "release-extensions.ts", "suppressConfiguredReleaseResources", "Suppresses configured resources belonging to bundled release package names before release paths are loaded.")
    policy = route("release-policy", CLI + "release-extensions.ts", "withReleaseExtensionConflictPolicy", "Wraps package resolution and extension diagnostics; calls suppression, conflict consolidation and optional-failure filtering.")
    main = route("main-selection", CLI + "main-cli.ts", "runMainCli", "Uses release arguments/conflict policy, withPiUiLocalization and classicHostBuiltinOverrides in the interactive host.")
    disabled = route("codemode-replacement", CLI + "classic-host-policy.ts", "classicHostBuiltinOverrides", "Registers builtin codemode with an empty factory; native codemode extension is not the selected implementation.")
    resource = route("builtin-factory-selection", PI + "core/resource-loader.js", "loadExtensionPaths", "For builtin:<name>, resolves the supplied builtinExtensions map and loads that factory.", "method")
    native_code = route("native-codemode-registration", PI + "extensions/codemode/index.js", "createCodemodeExtension", "The native factory would register the native tool when enabled; Jouzu supplies a different builtin factory.")
    component = route("terminal-renderer-selection", PI + "modes/interactive/interactive-mode.js", "getRegisteredToolDefinition", "Extension renderer resolvers wrap withBuiltInRenderers(toolName, session.getToolDefinition(toolName)).", "method")
    merge = route("native-renderer-merge", PI + "core/tools/renderers/index.js", "withBuiltInRenderers", "Fills missing call/result methods independently; existing extension renderer methods win, including conflicts.")
    resolve = route("extension-renderer-chain", PI + "core/extensions/runner.js", "resolveToolRenderers", "Calls resolver chain in extension load order, then the supplied base renderer.", "method")
    fallback = route("renderer-exception-fallback", PI + "modes/interactive/components/tool-execution.js", "updateDisplay", "Missing or throwing renderer methods use generic call/result fallbacks, not a second attempt through the native tool renderer.", "method")
    preview_entry = route("preview-entry", PREVIEW + "extension/index.ts", "codePreviews", "Manifest index.ts re-exports this factory; registers settings/health and chooses tool overrides at session_start.")
    preview_select = route("preview-selection", PREVIEW + "tool-renderers/registration.ts", "registerToolRenderers", "Registers enabled tools only; non-builtin owners yield skipped-conflict, leaving the other owner selected. Already-registered overrides remain registered in this session.")
    preview_policy = route("preview-policy", PREVIEW + "tools/policy.ts", "getEffectiveCodePreviewToolSet", "Unions configured tools with required overrides. Disabling result/content preview can REQUIRE an override to hide it; it is not a native-fallback switch.")
    preview_env = route("preview-environment", PREVIEW + "tools/selection.ts", "getEnabledCodePreviewTools", "CODE_PREVIEW_TOOLS or saved tools feeds the effective set; policy can add tools back.")
    adaptation = route("terminal-adaptation", CLI + "pi-ui-localization.ts", "installPrototypePatches", "Only owned SettingsList/SelectList graphs and explicitly selected Pi component prototypes are adapted; no global Text/notification/tool renderer/browser translation.")
    custom = route("custom-view-construction", PI + "modes/interactive/interactive-mode.js", "createExtensionUIContext", "Generic ui.custom presents caller components; invoking it does not enroll a third-party SettingsList in Jouzu's owned graph.", "method")
    export_command = route("interactive-export", PI + "modes/interactive/interactive-mode.js", "handleExportCommand", "/export calls session.exportToHtml; terminal status/failure framing is distinct from the generated viewer.", "method")
    export_session = route("export-custom-renderers", PI + "core/agent-session.js", "exportToHtml", "Supplies extension resolver chain over getToolDefinition, theme and cwd to createToolHtmlRenderer; no viewer locale is supplied.", "method")
    export_dir = route("export-asset-directory", PI + "config.js", "getExportTemplateDir", "Node package branch chooses src if present, otherwise dist/core/export-html. This installed package has no src directory; binary branches are separate.")
    export_assets = route("viewer-asset-embedding", PI + "core/export-html/index.js", "generateHtml", "Reads template.html, template.css, template.js and all three vendor scripts; embeds them and base64 session data without locale injection.")
    web_selected = route("selected-web-registration", WEB + "jouzu-extension.js", "registerJouzuWebfetch", "Registers web_fetch and batch_web_fetch only, using static webfetch-api.js; does not register aio-webfetch or aio-websearch.")
    web_api = route("selected-web-api-imports", WEB + "webfetch-api.js", 'import { loadPdfParseCtor } from "./types.js";', "Immediate selected API imports transport/extraction/security/redaction/PDF helpers, not the five candidate tools modules.", "source-expression")
    bg_claim = route("background-claim", BG + "widget-visibility.ts", "shouldRenderBackgroundWidget", "Requires UI, tracked and visible tasks, showWidget, visible mode and no active presentation claim.")
    claimed = route("dashboard-claim-consumer", CLI + "work-dashboard-sources.ts", "createClaimedWorkSource", "Dashboard source reads units and acquires a versioned claim; missing inventory or detach releases it. Placement requires runtime evidence.")
    bg_widget = route("background-widget-producer", BG + "background-tasks.ts", "syncWidget", "Calls shouldRenderBackgroundWidget with widgetClaims.claimed(), then registers/removes the stacked native widget.")
    footer_consumer = route("native-footer-consumer", PI + "modes/interactive/components/footer.js", "FooterComponent", "Native footer consumes branch and extensionStatuses as data; does not own all status strings.", "class")
    owned_footer = route("session-ui-footer", "packages/session-ui/src/extension.ts", "createSessionUiExtension", "Installs a replacement footer, subscribes to branch changes, and makes extension status map available to Session Line activity.")

    agent = PI + "core/agent-session.js"
    file(agent, "reviewed-false-positive-and-route-boundary", "Candidate line 1738 is a documentation comment mentioning pi.registerCommand, not an executable sink: " + ref(agent, "* - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming", "source-expression") + ". Actual prompt dispatch calls _tryExecuteExtensionCommand, which routes handler exceptions through emitError. Export custom-renderer wiring: " + export_session + ". No claim that every session/model/provider exception has been classified.")
    surface("session-comment-candidate", agent, "prompt", "Source comment -> actual prompt -> _tryExecuteExtensionCommand", "documentation-only scan hit; actual extension-command dispatch", "The candidate pi.registerCommand text is inside the prompt documentation comment, not a registration, notification or rendered human sentence. Actual command dispatch is traced separately; no missing translation is inferred from the scan hit.", locale="Not interface copy: source comment. Actual command diagnostics are a separate producer/consumer boundary.", level="reviewed-non-sink", kind="method")
    surface("command-error-forwarding", agent, "_tryExecuteExtensionCommand", "prompt -> registered extension command -> emitError -> InteractiveMode.showExtensionError", "command handler rejection; handled command with error", "Forwards err.message or String(err), sets event=command and command:<name>. This sink cannot classify all payload as remote or interface copy; exact local producers must be treated separately.", locale="Native terminal error framing is separate from producer-owned error text; no blanket translation or preservation exemption.", level="reviewed-payload-and-consumer-boundary", kind="method")

    index = PI + "core/export-html/index.js"
    file(index, "reviewed-export-route-and-assets", "Full generator/export/pre-render implementations reviewed. " + export_assets + "; " + export_command + "; " + export_session + ". Standalone exportFromFile has no tools/system prompt/custom pre-renderer. TEMPLATE_RENDERED_TOOLS bypasses custom renderers for bash/read/write/edit/ls; other names can use pre-rendered HTML. Fixed export errors are local framing, paths are payload. Theme injection is not localization.")
    surface("export-rejections", index, "exportSessionToHtml", export_command + " -> " + export_session, "in-memory session; missing session file; successful file write", "Cannot export in-memory session to HTML; Nothing to export yet - start a conversation first are local fixed exceptions. They flow through /export failure framing. Output filename/path is technical data.")
    surface("export-file-rejection", index, "exportFromFile", "Pi main.js --export -> exportFromFile; independent of /export tool rendering", "missing input file; standalone export", "File not found: is local diagnostic framing; preserve resolved path. Standalone sessionData omits systemPrompt/tools/renderedTools.")
    surface("export-renderer-routing", index, "preRenderCustomTools", export_session + " -> preRenderCustomTools -> browser renderToolCall", "template-owned five tool names; custom successful/missing/throwing renderer; collapsed/expanded result", "bash/read/write/edit/ls always use viewer branches even if terminal preview overrides exist. Other tool names may embed custom terminal-renderer HTML. No renderer or caught error leaves structured browser fallback; standalone export supplies no custom renderer.", locale="Separate browser-owned source English and captured custom-renderer text. Terminal localization does not localize the viewer.", level="reviewed-route-selection")
    toolhtml = PI + "core/export-html/tool-renderer.js"
    file(toolhtml, "reviewed-render-adapter-payload-boundary", "Full createToolHtmlRenderer reviewed: saves args/state/components, renders width=100, showImages=false, result collapsed then expanded, converts ANSI lines. Catch/no-method returns undefined, selecting browser structured fallback rather than an error message. Callers: " + export_session + "; " + ref(index, "preRenderCustomTools") + ". No fixed English control copy in this adapter.")
    surface("export-ansi-adapter", toolhtml, "createToolHtmlRenderer", export_session + " -> preRenderCustomTools", "call renderer absent/throws; collapsed/expanded result differ or match; blank result", "Only adapts selected renderer output to HTML. Exceptions are swallowed, not displayed as Failed to render. Captured extension UI, local diagnostics and source output retain their separate ownership; asynchronous edit preview completion is not awaited.", locale="No translator here; captured selected-renderer strings can remain English. ANSI conversion must not rewrite command/code/result payload.", level="reviewed-payload-and-consumer-boundary")

    template = PI + "core/export-html/template.js"
    file(template, "reviewed-exported-viewer-state-families", "Full browser implementation reviewed, including data decoding, tree filtering/navigation, tool/message/header rendering, markdown configuration, clipboard/download, sidebar persistence/resize and key handlers. Consumer: " + export_assets + ". No catalog/locale data input; dates use browser defaults. See viewer families and template.html/CSS dispositions; lack of terminal sink match is not used as evidence.")
    viewer = "Generated export HTML -> embedded template.js (" + export_assets + ")"
    def view(identifier, name, state, finding, **kwargs):
        surface("viewer-" + identifier, template, name, viewer, state, finding,
                locale="Browser-owned source English; no Jouzu catalog injection. Timestamp/number calls with undefined locale follow the browser, not the selected Jouzu language.", **kwargs)
    view("tree-labels", "getTreeNodeDisplayHtml", "user/skill/assistant/tool/bash entries; no text; aborted/error; compaction/summary/model/thinking/context edits; labels", "Fixed role/event labels include user:, skill:, assistant:, (aborted), (no text), compaction/tokens, branch summary, model, thinking and context omit/replace. Preserve labels, snippets, summaries, identifiers and diagnostic payloads; command names in tool summaries remain technical identifiers.")
    view("tree-filter", "filterNodes", "default/no-tools/user-only/labeled-only/all; multi-token query; active leaf always retained; no visible matches", "Filtering changes tree entries, not message content. Current leaf bypasses filters; tool-call-only assistant rows are hidden unless stopped abnormally. No separate no-results sentence exists; renderTree reports counts.")
    view("tree-count", "renderTree", "initial/full rebuild; marker update; zero/nonzero visible rows; selected branch/target", "Composes <visible> / <total> entries. Clicking navigates to newest descendant and scrolls to clicked target; prefix glyphs and entry IDs are not translatable prose.")
    view("tool-summary", "formatToolCall", "read range; write/edit/bash; grep/find pattern and path; ls; generic JSON summary", "Command/tool names remain exact; English in in grep/find summary is interface framing. Paths, patterns, command and JSON arguments remain payload.")
    view("expand-output", "formatExpandableOutput", "plain or highlighted output; within limit or collapsed/expanded; syntax-highlighter throws", "... (<count> more lines) is local UI. Code/output is escaped or highlighted, not translated; highlighter errors fall back to escaped source without an error banner.")
    view("builtin-tool-calls", "renderToolCall", "pending/success/error styling; bash/read/write/edit/ls; invalid type; content absent/present; generic/pre-rendered fallback", "Fixed [invalid arg], [invalid content arg - expected string], lines and limit annotations belong to the viewer. Tool names, shell commands, paths, source/diff/image/result content and generic JSON are payload. Status classes themselves contain no visible English sentence.")
    view("nested-calls", "renderToolCall", "nested calls absent/present; complete/incomplete; arguments retained/omitted; ok/error/unfinished", "Nested calls:, (incomplete record), [arguments omitted, <bytes> bytes] are fixed local framing. Preserve nested names, argument JSON, duration values and nested error text; its producers are not all classified here.")
    view("message-thinking", "renderEntry", "assistant text/thinking/tool calls; reasoning expanded/collapsed; user content and image blocks", "Thinking ... is viewer UI; reasoning/model prose, user content and embedded images remain payload. Skill label and (click to expand) frame the preserved skill body/name and optional user message.")
    view("message-errors", "renderEntry", "assistant aborted/error/unknown error; bash cancelled/nonzero exit; normal success", "Aborted, Error:, Unknown error, (cancelled), (exit <code>) are local framing. msg.errorMessage and shell output are producer payload with mixed possible local/remote provenance, not all exempt remote text.")
    view("event-cards", "renderEntry", "model switch; compaction collapsed/expanded; branch summary; custom message visible/hidden", "Switched to model:, [compaction], Compacted from <count> tokens, Branch Summary, Hidden in terminal are fixed UI. Model/provider IDs, summary and arbitrary custom_message content/type remain payload. thinking_level_change/context_edit can appear in tree but have no standalone card branch.")
    view("header-stats", "renderHeader", "known/unknown session/date/models; nonzero/zero message families; tokens/cost", "Session:, unknown, Date:, Models:, Messages:, Tool Calls:, Tokens:, Cost:, user/assistant/tool results/custom/compactions/branch summaries are local UI. Session IDs/model IDs and numeric counts are data; R/W and currency formatting are presentation choices, not proof of locale selection.")
    view("header-controls", "renderHeader", "thinking/tools pressed states; show/hide hidden messages; download; system prompt and tool metadata present/absent", "T toggle thinking · O toggle tools · H toggle hidden messages, Toggle thinking/tools titles/buttons, Show/Hide hidden messages, Download session as JSONL, System Prompt, Available Tools, more lines/click to expand and required/optional are fixed UI. Tool/schema descriptions are preserved declared metadata with their own producer ownership, not assumed remote or user-authored.")
    view("hidden-toggle", "setHiddenMessagesVisible", "hidden messages default off; explicit button/H; deep-linked hidden entry turns visibility on", "Updates aria-pressed and Show hidden messages / Hide hidden messages. Terminal-hidden custom content is retained in export and gated by CSS, not removed from downloaded data.")
    view("thinking-toggle", "setThinkingExpanded", "initial expanded; button/T; cached nodes re-applied after navigation", "Switches thinking-text/thinking-collapsed display and aria-pressed. The fixed Thinking ... placeholder is created by renderEntry; does not change reasoning text.")
    view("tools-toggle", "setToolOutputsExpanded", "initial collapsed; button/O; output/compaction/skill cards; cached nodes re-applied", "Switches expanded classes on output, compaction and skill invocation, not every read/edit/tool branch. Collapse framing text belongs to the card producer.")
    view("copy-link", "renderCopyLinkButton", "message link button title", "Copy link to this message is fixed tooltip text; entry IDs and generated share URLs remain exact.")
    view("clipboard", "copyToClipboard", "Clipboard API success/refusal; execCommand fallback success/failure; temporary success mark", "Success changes button to ✓ then restores it. Fallback exception logs Failed to copy: to browser console; there is no visible failure toast. Clipboard errors are not displayed as a translated sentence.")
    view("download", "window.downloadSessionJson = function() {", "JSONL download with header and all entries; session-ID/default filename", "JSONL is a technical format label. Reconstructs whole exported data, not filtered path; session fallback filename and application/x-ndjson MIME are not ordinary UI copy. No download completion/failure banner is implemented.", kind="source-expression")
    view("navigation", "navigateTo", "URL leaf/target; branch click; tool-result target remaps to tool call; hidden custom target; cache", "Rebuilds path/header, attaches copy links, reapplies toggle states. DOM IDs/deep-link parameters remain exact. Missing/invalid URL target uses implemented fallback without a diagnostic sentence.")
    view("markdown", "safeMarkedParse", "Markdown with CJK emphasis, HTML-like source, safe/disallowed URLs; language-known/auto/failure code highlighting", "Returns marked.parse directly: despite its name, no catch surrounds parse failures. Marked/hljs configuration lives in the initialization block; highlight failures escape source. No language catalog and no user-facing parser-error fallback are supplied.", limit="Vendor interfaces and selected calls inspected; parser/highlighter failure behavior not executed and not every grammar/transitive diagnostic enumerated.")
    view("sidebar", "setupSidebarResize", "desktop saved/default/clamped width; drag/up/cancel; double-click reset; mobile; storage refusal", "Pointer resize and persisted width add no sentence. localStorage read/write failure is swallowed; resize aria-label is in template.html. No error banner is implemented. Mobile open/close is handled by adjacent hamburger/overlay/close callbacks.")
    view("keyboard", "const isEditableTarget = (element) => {", "T/O/H plain shortcuts; input/editable/modifier suppression; Escape reset", "Key handler ignores ordinary shortcuts while editing, but Escape clears search and navigates to the original leaf before that guard. Escape does not reset filterMode or explicitly close the sidebar; no extra shortcut hint is supplied for Escape.", kind="source-expression")

    html = PI + "core/export-html/template.html"
    file(html, "reviewed-immediate-viewer-asset", "Embedded by generateHtml. Full markup inspected: lang=en, Session Export title, sidebar search/filter/open/close labels, resize accessible name, empty content mounts, inert image-modal markup and inline script placeholders. Browser handlers are in template.js. There are no additional external script/link asset declarations.")
    surface("viewer-document", html, '<html lang="en">', viewer, "document language and title", "lang=en and Session Export are fixed independently of selected Jouzu language; there is no localized title/document-language injection.", owner="Pi exported viewer", kind="markup")
    surface("viewer-sidebar-controls", html, '<input type="text" class="sidebar-search" id="tree-search" placeholder="Search...">', viewer, "search; five filters and tooltips; mobile open/close; resize accessible name", "Search..., Default/Hide settings entries, No-tools/Default minus tool results, User/Only user messages, Labeled/Only labeled entries, All/Show everything, Open sidebar, Close and Resize session tree sidebar are local fixed UI; filter data tokens must stay stable.", owner="Pi exported viewer", kind="markup")
    css = PI + "core/export-html/template.css"
    file(css, "reviewed-immediate-viewer-asset", "Full stylesheet inspected. Generates [click to show parameters] / [hide parameters] text; styles thinking/hidden-message/expanded states and mobile breakpoint. Other selectors/colors/glyphs are layout data, not independent localization claims. Consumer: generateHtml -> template.html inline CSS.")
    surface("viewer-css-parameter-hints", css, "content: '[click to show parameters]';", viewer + " -> renderHeader tool-item params-expanded", "parameter collapsed/expanded pseudo-element", "CSS content supplies [click to show parameters] and [hide parameters]; these controls cannot be discovered by terminal Text/notify scanning.", owner="Pi exported viewer", kind="style")
    ansi = PI + "core/export-html/ansi-to-html.js"
    file(ansi, "reviewed-immediate-render-adapter", "Full ANSI conversion implementation inspected. ansiLinesToHtml maps lines through ansiToHtml; SGR colors/styles become escaped spans and blank lines are preserved. No fixed control/notification text or catalog path. Called only on selected renderer strings by createToolHtmlRenderer.")
    surface("viewer-ansi-preservation", ansi, "ansiLinesToHtml", export_session + " -> createToolHtmlRenderer", "plain/styled/empty lines; ANSI escapes and HTML-sensitive characters", "Formatting conversion is not UI text ownership: preserve renderer payload, translate only separately identified framing at its producer.", locale="No translation in ANSI converter.", level="reviewed-payload-and-consumer-boundary")
    for vendor, evidence in [
        ("marked.min.js", "marked.use/parse and renderer/tokenizer interfaces inspected against template initialization. Emits markup from transcript content; includes local parser error/bug-report diagnostics and silent-mode error-HTML behavior. template uses default parse without a catch or silent=true; no additional viewer controls."),
        ("marked-cjk-friendly.min.js", "markedCjkFriendly().tokenizer.emStrong is the consumed interface. CJK emphasis tokenization only; no menus, labels or catalog selection. CJK token support is not Japanese interface translation."),
        ("highlight.min.js", "hljs.highlight/highlightAuto/getLanguage consumed by template. Returns highlighted code HTML; language registry contains programming-language keywords/aliases, not UI copy. Local library diagnostics can reach console/throws, while template highlight catches render escaped source. No separately invoked highlightAll browser control."),
    ]:
        file(PI + "core/export-html/vendor/" + vendor, "reviewed-immediate-vendor-interface", evidence + " Embedded inline by generateHtml. Review closes the immediate asset/interface boundary, not every grammar branch or all transitive package text.")

    loader = PI + "core/extensions/loader.js"
    loader_route = route("extension-load-errors", loader, "loadExtension", "Missing default export, module/factory errors produce error records; initializeExtension discards failed registrations and pending runtime changes.")
    resources_ui = route("extension-diagnostic-consumer", PI + "modes/interactive/interactive-mode.js", "showLoadedResources", "Converts getExtensions errors/warnings into diagnostic rows under Extension issues; formatDiagnostics renders each message and path.", "method")
    file(loader, "reviewed-registration-and-diagnostic-boundary", "Full loader/API/lifecycle reviewed. Candidate lines registerTool/registerCommand/registerFlag metadata and callbacks: callback/label presence alone is not a rendered control. registerCommand/Tool/Flag validation and runtime not-initialized/stale/failed API checks are local diagnostics. Captured module/factory exceptions may be local or external. " + loader_route + "; " + resources_ui + "; " + policy + ". Conflict consolidation localizes only matching release-tool conflicts, not all loader messages.")
    surface("loader-validation", loader, "createExtensionAPI", "extension factory -> registration validation -> load error record -> " + resources_ui, "invalid parameter schema; empty command/missing handler; flag default mismatch; failed/stale API; pre-bind action", "Fixed validation instructions are library-owned local diagnostics with interpolated identifiers/paths. Registration callbacks and arbitrary command/tool descriptions remain extension-owned metadata; no human label is inferred from function identifiers.")
    surface("loader-failures", loader, "loadExtension", loader_route + " -> " + resources_ui, "invalid/missing default function; module import/factory throw; failed registration discard", "Missing-default failure and Failed to load extension wrapper are local diagnostics; caught err.message/stack is a separate producer boundary. Loaded-resource framing is not covered by the tool-conflict catalog consolidation.", kind="function")
    footer = PI + "core/footer-data-provider.js"
    file(footer, "reviewed-data-provider-and-consumers", "Full provider inspected. Candidate onBranchChange forwards callback, not text. Branch/status/count accessors supply data; branch resolution creates local detached marker and catches filesystem/git failure to null. Arbitrary extension statuses retain producer ownership. " + footer_consumer + "; " + owned_footer + ". Replacement footer refreshes its own Git state, so native branch marker is conditional, not a proven active Jouzu label.")
    surface("footer-payload", footer, "getExtensionStatuses", footer_consumer + "; " + owned_footer, "status set/clear; branch name/detached/unavailable; branch-change callback", "Map values originate at extension ctx.ui.setStatus; onBranchChange invokes callbacks without producing English. resolveGitBranchSync/Async returns local detached only for native branch presentation; preserve real branch names and independently inspect status producers.", locale="Data provider has no translator. Jouzu replaces footer and reads status map separately; no blanket status-string localization claim.", level="reviewed-payload-and-consumer-boundary", kind="method")

    native_entry = component + " -> " + merge + "; " + preview_select
    for tool, title, finding, callname, resultname in [
        ("bash", "shell", "timeout <n>s; earlier lines/to expand; Full output; Truncated/showing/line-or-byte limit; Elapsed/Took from render-utils. Shared shell renderer also serves powershell. Shell output remains payload.", "formatShellCall", "rebuildBashResultRenderComponent"),
        ("find", "find", "Call joins pattern with in/path and limit. Result clips after 20 logical lines unless expanded; more lines/to expand and Truncated/results/byte limit are fixed framing. File paths and pattern are payload.", "formatFindCall", "formatFindResult"),
        ("grep", "grep", "Call in/limit and optional glob; result clips after 15 logical lines unless expanded; more lines/to expand, matches limit, byte limit, some lines truncated are fixed framing. Preserve matching source lines/pattern/glob.", "formatGrepCall", "formatGrepResult"),
        ("ls", "ls", "Call limit annotation; result clips after 20 logical lines unless expanded; more lines/to expand and Truncated/entries/byte limits are fixed framing. Directory entries remain payload.", "formatLsCall", "formatLsResult"),
        ("read", "read", "Compact skill/docs/resource call labels and to expand; successful collapsed result returns empty. Expanded success or collapsed errors show content; first-line-exceeds, line/byte truncation notices are local framing. Preserve file/source text and requested line range.", "formatCompactReadCall", "formatReadResult"),
        ("write", "write", "[invalid content arg - expected string], more lines/total/to expand are local framing; normal success result is suppressed, error result forwards producer text. Source content is normalized for display/highlighting, not translated.", "formatWriteCall", "formatWriteResult"),
    ]:
        source = PI + "core/tools/renderers/" + tool + ".js"
        factory = PI + "core/tools/" + tool + ".js"
        factory_symbol = "createShellToolDefinition" if tool == "bash" else "create" + tool.title() + "ToolDefinition"
        factory_ref = route("native-" + tool + "-definition", factory, factory_symbol, "Tool definition spreads its native renderers; execution-produced content has separate ownership.")
        file(source, "reviewed-conditional-native-renderer", "Full renderer inspected. " + finding + " Selection: " + native_entry + "; " + factory_ref + ". Existing preview/extension renderer methods win; absent renderer methods can be filled natively. Preview-off is not sufficient evidence of native selection; per-user effective tool set and registration history matter. Not localized by global Text rewriting.")
        surface("native-" + title + "-call", source, callname, native_entry, "conditional native call; complete/incomplete/invalid arguments; collapsed/expanded", finding, limit="Conditional source route only. Non-builtin conflict keeps its own renderer; not automatically native. No runtime or exact-width evidence.")
        surface("native-" + title + "-result", source, resultname, native_entry, "conditional native result; partial/final; empty/error; preview/full; truncation flags", finding, limit="Native renderer family reviewed; dynamic execution-error producer graph is not exhausted. Preserve output/source and translate local framing separately.")
    edit = PI + "core/tools/renderers/edit.js"
    file(edit, "reviewed-conditional-native-preview-renderer", "Full async preview/state/result implementation inspected. Args-complete triggers computeEditsDiff; header shows preview error/diff and result replaces preview without double-printing identical errors. Native selection: " + native_entry + ". Displayed diff is source payload; preview errors include local edit-diff validation, not only filesystem/remote errors.")
    surface("native-edit-preview", edit, "buildEditCallComponent", native_entry + " -> editRenderers.renderCall -> computeEditsDiff", "incomplete args; async pending/success/error; stale request discarded; final result updates header", "Tool name/path and actual diff remain exact. preview.error is displayed in error-colored Text; producer computeEditsDiff creates local access/match/duplicate/no-change/overlap errors as well as forwarding errors. Do not exempt this whole dynamic sink as source content.")
    surface("native-edit-result", edit, "formatEditResult", native_entry + " -> editRenderers.renderResult", "error absent/same as preview/different; new result diff; no output", "Suppresses identical preview errors, shows distinct error text or final changed diff. No fixed success sentence here; local error framing belongs at producer and diff/source bytes remain payload.")
    diff = PI + "core/tools/edit-diff.js"
    file(diff, "reviewed-immediate-local-diagnostic-producer", "Full helper inspected through computeEditsDiff/access/read/normalize/apply/diff. Fixed access wrapper, exact-match/uniqueness/empty/no-change/overlap and replacement-range/line-count validations are local; paths/indices/counts and code excerpts are data. Returns error.message for caught exceptions. Consumer: native edit preview; no locale parameter.")
    surface("edit-preview-local-errors", diff, "computeEditsDiff", native_entry + " -> edit preview Text", "access failure; content validation error; successful diff", "Could not edit file: and Error code: are locally composed. applyEditsToNormalizedContent can emit exact-text mismatch, repeated match, empty oldText, overlap and no-change instructions; filesystem error.message must retain its exact technical payload.")
    visual = PI + "modes/interactive/components/visual-truncate.js"
    file(visual, "reviewed-shared-layout-not-copy", "Full truncateToVisualLines/VisualLinePreview reviewed. Candidate new Text renders supplied text to measure visual lines, not a new English message. Caller-supplied formatHint owns earlier/more lines wording. Used by native shell/codemode and bash-execution; dynamic layout has no catalog path.")
    surface("visual-preview", visual, "VisualLinePreview", "native shell/codemode or bash-execution -> VisualLinePreview", "empty/fits/overflows; keep start/end; width/cache changes", "The helper only appends caller-provided formatHint on overflow, truncating to width. It does not own the English hint and must not translate arbitrary measured output.", locale="Layout helper; localize each hint producer, not Text payload globally.", kind="class", level="reviewed-payload-and-consumer-boundary")
    code = PI + "extensions/codemode/renderer.js"
    file(code, "reviewed-not-selected-by-release-host", "Full native renderer inspected: code preview, nested-call status/cost/error, earlier calls, Model calls, Full output and timing; strips Script completed/failed protocol header. " + native_code + "; " + disabled + "; " + resource + "; " + main + ". Empty replacement factory registers no native tool/renderers. This is a route exclusion for the selected host, not proof that SDK/explicit alternate extensions cannot use this module.")
    surface("codemode-inactive", code, "codemodeRenderers", main + " -> " + disabled + " -> " + resource, "native code/call-list/output/cost/timer renderer under alternate native factory", "Native English earlier/more lines, Model calls, Full output and timing exists but is not selected by the release host's empty builtin codemode factory. Preserve scripts/nested args/errors. Do not count as an active Japanese-runtime screen.", locale="Not selected in the inspected release host. Alternate SDK/factory configurations need separate evidence.", level="reviewed-route-exclusion", kind="initializer")

    stacked = BG + "stacked-widget.ts"
    file(stacked, "reviewed-layout-and-conditional-widget-consumer", "Full registry/sort/component/sync implementation reviewed. Candidate setWidget calls mount factory-supplied components; stack itself has no fixed prose. It ranks, replaces/disposes, clips and moves components. " + bg_widget + "; " + bg_claim + "; " + claimed + ". Dashboard claim hides the native background widget; other stacked producers retain their own visibility/copy. No global component translation.")
    surface("stacked-widget", stacked, "stackComponent", bg_widget + " -> syncStack -> ctx.ui.setWidget; " + claimed, "empty/remove; add/update/reorder; above/below placement; claim suppresses background producer; width clipping", "Stacked lines come from each entry.factory and are clipped without adding an ellipsis. No local title/status/notification is produced by the stack. Rendering/mounting a factory is not proof of localizable strings at that sink.", owner="pi-background-tasks", locale="No stack-owned prose; producer text is outside generic widget localization. Native placement under replacement editor/dashboard needs runtime evidence.", level="reviewed-payload-and-consumer-boundary")

    cooperative = PREVIEW + "api/cooperative-tools.ts"
    file(cooperative, "reviewed-cooperative-render-payload-boundary", "Full wrapper/fallback implementations reviewed. withCodePreviewShell wraps only callers opting in; leaves renderShell=self tools unchanged by default and preserves underlying definition/execute/schema. Fallback call uses label/name; fallback result escapes supplied output and returns empty container when absent. Candidate Text calls are not new fixed English. Builtin override selection is independently governed by registration.ts.")
    surface("cooperative-shell", cooperative, "withCodePreviewShell", "Package authors -> withCodePreviewShell -> createCodePreviewToolShell; not automatic discovery", "self-shell unchanged; original renderer present/absent; partial/error/empty output", "Fallback label/name and result text are owned by caller/tool producers; wrapper adds framing but no fixed English at candidate Text sinks. Original renderers retain their own UI/diagnostic ownership. No registered-tool sweep occurs.", owner="pi-code-previews", locale="No translator in cooperative wrapper. Preview shell expand/timing chrome has its own producer.", level="reviewed-payload-and-consumer-boundary")
    command = PREVIEW + "commands/settings.ts"
    file(command, "reviewed-active-extension-command", "Full registerSettingsCommand reviewed. /code-preview-settings -> ui.custom -> createCodePreviewSettingsList. Description may be slash-description-adapted, but custom SettingsList and its nested menus are not globally enrolled for localization. " + preview_entry + "; " + custom + "; " + adaptation + ". Immediate panels/metadata/save-notice producers are separately inventoried.")
    surface("preview-settings-command", command, "registerSettingsCommand", preview_entry + " -> /code-preview-settings -> ui.custom", "open settings and return/cancel after save queue settles", "Configure code preview settings is command metadata. Native panel is not localized merely because slash descriptions can be adapted; third-party SettingsList is not marked owned by this route.", owner="pi-code-previews")
    panel = PREVIEW + "commands/panels/settings.ts"
    file(panel, "reviewed-immediate-settings-consumer", "Full SettingsList controller reviewed. Creates categories, refreshes values after settings changes, initializes new syntax theme, queues save, emits reset success or formatSettingsSaveError warning, waits for queue on exit. Generic ui.custom does not make the list Jouzu-owned.")
    surface("preview-settings-notices", panel, "createCodePreviewSettingsList", "/code-preview-settings -> ui.custom -> category/submenu items", "ordinary change; theme change; reset success; save failure; exit flush", "Code preview settings reset to defaults is local success copy. Save warning wraps a dynamic underlying error; dismissal flush catches failure and returns, not an invented visible success/error screen.", owner="pi-code-previews")
    registry = PREVIEW + "settings/ui/registry.ts"
    file(registry, "reviewed-immediate-settings-copy", "Full setting/category/group metadata inspected; fixed labels, descriptions, on/off/reset/action and option labels are local extension UI; IDs/theme identifiers remain technical values. Consumed by settings/ui/index.ts and submenus.ts, not generic Jouzu owned-list adaptation.")
    surface("preview-settings-items", registry, "SETTING_ITEM_DEFINITIONS", "/code-preview-settings -> createSettingsCategoryItems -> registry", "content/result visibility; appearance; syntax theme; advanced/reset; option values", "Setting labels/descriptions and human option values are source English. Preserve machine setting IDs, tool names, paths and syntax theme identifiers. Source family is grouped metadata, not one completed state per setting.", owner="pi-code-previews", kind="initializer")
    categories = PREVIEW + "settings/ui/index.ts"
    file(categories, "reviewed-immediate-settings-composition", "Full category/group/item composition inspected. Owns Appearance, Output previews, Enabled tools, Warnings & safety, Advanced plus descriptions and file & defaults. Builds nested SettingsGroupSubmenu/ToolPreviewSettingsSubmenu/ThemeSelectSubmenu; reads settings path/value and summary helpers. Not covered by owned-list enrollment.")
    surface("preview-settings-categories", categories, "createSettingsCategoryItems", "/code-preview-settings -> createCodePreviewSettingsList -> category/group items", "root categories; nested preview families; settings path/reset; theme/tools submenus", "Appearance, Output previews, Enabled tools, Warnings & safety, Advanced, group labels/descriptions and file & defaults are local English UI. Settings path is data. Root-label translation alone would not cover nested values, summaries and hints.", owner="pi-code-previews")
    summaries = PREVIEW + "settings/ui/summaries.ts"
    file(summaries, "reviewed-immediate-settings-value-copy", "Full summary helpers inspected. Compose syntax/timing/on/off, bg/words/lines, paths, tools/all tools/none and secrets around saved values/tool/theme IDs. Returned currentValue text is local UI composition, not arbitrary remote content.")
    surface("preview-settings-values", summaries, "summarizeTools", "/code-preview-settings -> category/group currentValue summaries", "zero/all/subset tools; syntax/timing; line lengths; warning toggles", "none, all tools, tools, syntax, timing, bg, words, lines, paths and secrets are local summary framing; booleans come through formatOnOff. Tool commands/theme IDs and numeric values remain exact. Item-label adaptation does not translate these composed values.", owner="pi-code-previews")
    submenus = PREVIEW + "settings/ui/submenus.ts"
    file(submenus, "reviewed-immediate-settings-submenus", "Full submenu implementation reviewed: SettingsList/SelectList builders, descriptions and hints, query/theme/current selection and change callbacks. Descendant selection does not acquire the owned-graph marker. User query, theme IDs and chosen technical values remain data.")
    surface("preview-settings-submenus", submenus, "ThemeSelectSubmenu", "/code-preview-settings -> category/group submenu -> theme selector", "select/cancel theme; nested group SettingsList and tools list", "Syntax theme, Select a Shiki theme for code previews., Enter to select · Esc to go back and grouped settings use extension source strings. Their descendants are not covered by owned SettingsList/SelectList adaptation just because the generic prototypes are patched.", owner="pi-code-previews", kind="class")
    persistence = PREVIEW + "settings/persistence.ts"
    file(persistence, "reviewed-immediate-settings-diagnostic", "Full queue/flush/error formatter reviewed. formatSettingsSaveError creates local Failed to save code preview settings: framing around error.message/String(error); queue writes are behavior read from source only, not executed by this audit.")
    surface("preview-save-error", persistence, "formatSettingsSaveError", "settings panel queueSettingsSave rejection -> ctx.ui.notify warning", "Error/non-Error save rejection", "Save error prefix is local fixed copy; underlying filesystem/serialization error text has its own technical provenance and must not be globally rewritten.", owner="pi-code-previews")
    bordered = PREVIEW + "preview/bordered-tool-call.ts"
    file(bordered, "reviewed-shell-layout-and-hint-producer", "Full border/state/cache implementation reviewed. Candidate renderHiddenPreviewExpandHint uses helper-generated hint, not tool output. <4 columns renders unframed body; regular borders place timing/expand labels if they fit; hidden preview label moves into current call/result border slot. Helper copy in preview/format.ts; timing text from tool-timing.ts.")
    surface("preview-border-hint", bordered, "hiddenPreviewExpandHintForShell", "preview renderers/createCodePreviewToolShell -> border slot", "call/result slot set; no slot fallback; tiny width; label too wide; partial/error border color", "Without a slot returns hiddenPreviewExpandHint; with a slot stores hiddenPreviewExpandLabel for border and returns empty. English expand originates in preview/format.ts, not BorderedToolCall payload. Timing label is composed separately.", owner="pi-code-previews")
    fmt = PREVIEW + "preview/format.ts"
    file(fmt, "reviewed-immediate-preview-copy", "Full line-window and metadata/footer/hint helpers inspected. Fixed lines hidden, expand, Showing X of Y plus caller-provided noun are UI framing; key bindings and source lines remain payload. Consumers: bordered-tool-call, path-list-result and other preview renderers.")
    surface("preview-expand-label", fmt, "hiddenPreviewExpandLabel", "bordered-tool-call hidden preview -> border or plain hint", "binding configured/empty; hidden call/result preview", "expand is local UI; actual configured app.tools.expand key text is technical data and must stay exact.", owner="pi-code-previews")
    surface("preview-count-footer", fmt, "showingFooter", "path-list-result and preview renderers -> preview footer", "hidden line count; shown/total count; paths/entries noun", "Showing <shown> of <total> <label> · <keys> expand is composed local UI. hiddenLinesMarker adds --- <count> lines hidden ---. Preserve caller source lines, names and key bindings.", owner="pi-code-previews")
    for tool, findings in [
        ("find", "find title/name is technical; in is fixed call framing. Finding…, Find failed and No files found are local UI. Exact No files found matching pattern marker switches empty-result behavior; underlying output is not generally translated. Footer noun paths."),
        ("ls", "ls is technical. Listing…, List failed and Empty directory are local UI; exact (empty directory) marker is input protocol for empty-result detection. Footer noun entries. Preserve directory entries/path."),
    ]:
        source = PREVIEW + "tool-renderers/" + tool + ".ts"
        file(source, "reviewed-active-preview-override", "Full registration and per-tool resultConfig reviewed. " + findings + " Selected by " + preview_select + "; " + preview_policy + ". Shared path-list tool spreads native execute/schema but replaces both renderers; per-result preview disabled can still select this override.")
        surface("preview-" + tool, source, "register" + tool.title(), preview_entry + " -> " + preview_select + " -> registerPathListTool", "partial loading; error with/without text; exact empty marker; preview hidden/expanded; truncated path list", findings, owner="pi-code-previews")
    path_tool = PREVIEW + "tool-renderers/shared/path-list-tool.ts"
    file(path_tool, "reviewed-renderer-override-consumer", "Full registerPathListTool reviewed. Spreads original createToolDefinition then overwrites renderShell/renderCall/renderResult with preview shell and path-list consumers. Original execute/schema stays native; renderer copy ownership does not. No fixed English at wrapper sink.")
    surface("preview-path-registration", path_tool, "registerPathListTool", preview_select + " -> registerFind/registerLs", "native definition spread; call/result methods overwritten; preview shell mode", "Native tool execution output is passed to preview renderer, not native formatFindResult/formatLsResult. Returned path-list component owns UI framing while source result/path entries remain payload.", owner="pi-code-previews", locale="Preview-owned rendering; native execution is not proof of native UI fallback.", level="reviewed-route-selection")
    path_result = PREVIEW + "tool-renderers/shared/path-list-result.ts"
    file(path_result, "reviewed-immediate-preview-result-consumer", "Full renderPathListResult reviewed. Partial/error prelude first, hidden preview prelude next, then exact empty marker/empty label, raw expanded hidden-preview output or formatted selected path list/footer. Error prelude takes first output line over fallback label; provenance remains dynamic.")
    surface("preview-path-results", path_result, "renderPathListResult", "registerPathListTool -> renderPathListResult -> result-prelude/format", "loading; error; hidden; empty; collapsed/expanded visible paths", "Loading/fallback error/empty labels come from find/ls config; actual first error line may be local diagnostic or external output. No automatic native fallback when preview is disabled: collapsed preview hides, expanded shows escaped raw result. Source paths and control-character escaping remain payload-preserving.", owner="pi-code-previews")

    web_reason = manifest + "; " + release + "; " + suppress + "; " + policy + "; " + main + "; " + web_selected + "; " + web_api
    for name, symbol, finding in [
        ("lazy", "registerLazyTools", "Lazy aio-* registry awaits selected old tool module and delegates render methods, with local fallback labels/output. It is not called by selected registerJouzuWebfetch."),
        ("render-result", "createResultComponent", "Old fetch progress/success/empty/error/metadata/outline/expanded previews contain local labels and dynamic source payload. Selected Jouzu renderer builds its own compact static-fetch and batch rows; it does not call this helper."),
        ("search-render", "createSearchResultComponent", "Old multi-provider search progress/status/result rows contain provider status framing and remote result snippets; selected Jouzu extension registers no search tool and does not import this helper."),
        ("webfetch", "registerWebfetchTool", "Old aio-webfetch registration composes old render-result helper, orchestration errors and fetched content. It is distinct from selected web_fetch using webfetch-api.js; the shared word fetch does not establish route selection."),
        ("websearch", "registerWebsearchTool", "Old aio-websearch registration composes search-render and provider/remote results. It is not registered/imported by selected static web_fetch/batch_web_fetch extension."),
    ]:
        source = WEB + "tools/" + name + ".js"
        file(source, "reviewed-not-selected-by-release-entry", "Full candidate implementation inspected. " + finding + " Selection evidence: " + web_reason + ". Exclusion is bounded to these registration/renderer modules in the inspected release host, not all WebAIO APIs or alternate user-supplied imports.")
        surface("webaio-" + name, source, symbol, web_reason, "candidate module under package-default/alternate old registration, not selected release entry", finding + " Fixed local UI is distinguished from fetched/model/user text even though this route is not selected.", owner="pi-webaio", locale="Not selected by manifest-selected Jouzu extension. Active static API/diagnostic producers remain a separate boundary, not excluded with these five files.", level="reviewed-route-exclusion")

    for tool in ["bash", "powershell", "read", "write", "edit", "find", "grep", "ls"]:
        residual(PI + "core/tools/" + tool + ".js", "native or preview tool result -> Text/browser export", "Only renderer selection and direct displayed framing are closed; execution-produced errors/output may mix local diagnostics, filesystem/shell errors and source content.", "Review exact execution diagnostics reaching result.content before changing payload translation; do not recursively expand all libraries from this ledger.")
    residual(loader, "module import/factory/API -> load error record -> showLoadedResources; handler errors -> showExtensionError", "Known local validation/wrapper copy is classified; arbitrary third-party module/factory errors retain unresolved producer provenance.", "Trace specific failing extension producers with deterministic fixtures; preserve technical error/stack data.")
    residual(footer, "ctx.ui.setStatus -> extensionStatuses -> native footer/Session Line activity", "Data carrier closed; each arbitrary extension status producer is not semantically exhausted.", "Verify selected status consumers and native/replacement placement with isolated terminal fixtures.")
    residual(WEB + "webfetch-api.js", "selected jouzu-extension web_fetch/batch_web_fetch -> fetchPage", "Selected static transport/extractor/API is active, unlike excluded tools modules. Every transport/PDF/parser/security failure is not enumerated here.", "Audit local API/extractor diagnostic producers separately from returned page/service content; no network execution was performed.")
    residual(PI + "core/export-html/vendor/marked.min.js", "template safeMarkedParse -> marked.parse", "Immediate parser interface is closed; malformed transcript parse/exception behavior has no browser test evidence.", "Render deterministic malformed Markdown fixtures and verify whether any local parser diagnostic reaches document or console.")
    residual(PREVIEW + "preview/tool-timing.ts", "preview shell timing label -> border", "Immediate timing producer inspected; localized units/formatting and narrow-width fit lack runtime evidence.", "Check timing/pending/final label layout with Japanese and actual configured keys.")

    assert primary <= files.keys(), sorted(primary - files.keys())
    ids = [row["surface_id"] for row in surfaces]
    assert len(ids) == len(set(ids))
    for row in surfaces:
        assert row["source_file"] in files, row["source_file"]
        assert list(row) == SURFACE_HEADER
        assert all(row[key].strip() for key in SURFACE_HEADER if key != "existing_test")
    for route_row in routes:
        assert lines(route_row["source_file"])[route_row["line"] - 1] == route_row["matched_line"]
    for row in surfaces:
        for test in re.findall(r"(?:packages|apps|scripts|packaging|python)/[^\s;,()]+\.(?:mjs|tsx|ts|py|ps1)\b", row["existing_test"]):
            assert (ROOT / test).is_file(), test
    export_paths = {str(path.relative_to(ROOT)).replace("\\", "/") for path in (ROOT / PI / "core/export-html").rglob("*")
                    if path.is_file() and not path.name.endswith((".map", ".d.ts"))}
    assert export_paths <= files.keys(), sorted(export_paths - files.keys())
    counts = {
        "primary_candidate_files": len(primary),
        "primary_candidate_files_dispositioned": len(primary & files.keys()),
        "primary_without_surface_family": sorted(primary - {row["source_file"] for row in surfaces}),
        "additional_file_dispositions": len(files.keys() - primary),
        "file_dispositions": len(files),
        "surface_state_families": len(surfaces),
        "surface_source_files": len({row["source_file"] for row in surfaces}),
        "families_with_existing_test_pointer": sum(bool(row["existing_test"]) for row in surfaces),
        "immediate_export_implementation_assets": len(export_paths),
        "immediate_export_implementation_assets_dispositioned": len(export_paths & files.keys()),
        "verified_route_anchors": len(routes),
        "verified_surface_anchors": len(anchors),
        "residual_source_consumer_records": len(residuals),
        "evidence_levels": dict(sorted(Counter(row["evidence_level"] for row in surfaces).items())),
        "file_dispositions_by_kind": dict(sorted(Counter(row["disposition"] for row in files.values()).items())),
        "runtime_imports_or_actions_performed": False,
        "runtime_signoff": "not-established",
        "exhaustive_transitive_package_claim": False,
        "errors": [],
    }
    products = {
        "files.csv": csv_text(FILE_HEADER, [files[key] for key in sorted(files)]),
        "surfaces.csv": csv_text(SURFACE_HEADER, surfaces),
        "source-anchors.csv": csv_text(["surface_id", "source_file", "source_symbol", "line", "matched_line"], anchors),
        "routes.csv": csv_text(["route_id", "source_file", "source_symbol", "line", "matched_line", "conclusion"], routes),
        "residuals.csv": csv_text(["source_file", "consumer", "boundary", "remaining_check"], residuals),
        "validation.json": json.dumps(counts, ensure_ascii=False, indent=2) + "\n",
    }
    # The original products above remain the immutable first-pass prefix.
    from continuation import extend
    return extend(products, counts, ROOT, HERE)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="compare regenerated evidence without writing files")
    args = parser.parse_args()
    products, counts = build()
    for name, content in products.items():
        path = HERE / name
        if args.check:
            assert path.read_text(encoding="utf-8") == content, f"stale artifact: {name}"
        else:
            path.write_text(content, encoding="utf-8", newline="\n")
    print(json.dumps(counts, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
