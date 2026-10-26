"""Append finite producer/consumer findings while preserving the first-pass CSV rows.

This module reads source text only. It never imports product/runtime packages.
"""

from collections import Counter
import csv
import hashlib
import io
import json
from pathlib import Path
import re

PI = "packages/cli/node_modules/@earendil-works/pi-coding-agent/dist/"
PRE = "packages/cli/node_modules/pi-code-previews/src/"
WEB = "packages/cli/node_modules/pi-webaio/dist/src/"
DEF = "packages/cli/node_modules/pi-webaio/node_modules/defuddle/dist/"
PDF = "packages/cli/node_modules/pi-webaio/node_modules/pdf-parse/dist/pdf-parse/esm/"
WREQ = "packages/cli/node_modules/wreq-js/dist/wreq-js.js"
CORE = "packages/cli/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js"
PREFIX = "semantic-dependencies.continuation."
RESOLUTION_HEADER = ["boundary_id", "original_record", "source_file", "status", "source_resolution", "surface_ids", "remaining_limit", "remaining_check"]
LIMIT_HEADER = ["limit_id", "boundary_ids", "kind", "source_file", "consumer", "remaining_limit", "remaining_check"]


def row_hash(row):
    return hashlib.sha256(json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def extend(products, counts, root, here):
    tables, headers = {}, {}
    for name, text in products.items():
        if name.endswith(".csv"):
            reader = csv.DictReader(io.StringIO(text))
            headers[name], tables[name] = reader.fieldnames, list(reader)
    baseline_counts = dict(counts)
    original_paths = {row["source_file"] for row in tables["files.csv"]}
    paths = set(original_paths)
    source_cache = {}

    def lines(source):
        assert not Path(source).is_absolute() and ".." not in Path(source).parts
        if source not in source_cache:
            source_cache[source] = (root / source).read_text(encoding="utf-8").splitlines()
        return source_cache[source]

    def anchor(source, name, kind="function"):
        if kind == "function":
            pattern = rf"^(?:export )?(?:default )?(?:async )?function {re.escape(name)}(?:[<(])"
        elif kind == "method":
            pattern = rf"^(?:(?:private|public|protected|static|async) )*{re.escape(name)}\("
        elif kind == "class":
            pattern = rf"^(?:export )?class {re.escape(name)}(?:\s|\{{)"
        elif kind == "initializer":
            pattern = rf"^(?:export )?(?:const|let|var) {re.escape(name)}\s*="
        else:
            pattern = "^" + re.escape(name) + "$"
        matches = [(n, text) for n, text in enumerate(lines(source), 1) if re.search(pattern, text.strip())]
        assert len(matches) == 1, (source, name, kind, [n for n, _ in matches])
        number, text = matches[0]
        category = "implementation" if kind in {"function", "method", "class"} else "declaration" if kind == "initializer" else "source-expression"
        return dict(source_file=source, source_symbol=f"{category}:{kind} {name}:L{number}", line=number, matched_line=text)

    def route(identifier, source, name, conclusion, kind="function"):
        item = anchor(source, name, kind)
        tables["routes.csv"].append(dict(route_id="continuation." + identifier, **item, conclusion=conclusion))
        return f"{source}:L{item['line']}"

    def family(identifier, source, name, state, finding, entry, kind="function", level="reviewed-source-family", limit=None):
        item = anchor(source, name, kind)
        if source not in paths:
            tables["files.csv"].append(dict(source_file=source, disposition="reviewed-continuation-producer-consumer", evidence="Continuation: " + finding + " Consumer/route: " + entry + ". Selected diagnostic path only unless a full tool implementation is explicitly stated; no recursive-package or runtime signoff."))
            paths.add(source)
        identifier = PREFIX + identifier
        tables["surfaces.csv"].append(dict(zip(headers["surfaces.csv"], [
            identifier, "Dependency continuation", source, item["source_symbol"], entry, state,
            "No selected-locale injection in this producer/consumer chain; authored framing and technical/source payload have separate ownership.",
            finding, level, "",
            limit or "Static selected-path review only. Preserve user/model/page/file/shell/OS/native and injected-operation data; no blanket translation or blanket remote-content exemption for caught error.message. No runtime/layout/platform signoff.",
        ])))
        tables["source-anchors.csv"].append(dict(surface_id=identifier, **item))
        return identifier

    transport = route("fetch-transport", WEB + "webfetch-api.js", "download", "Validated pins -> wreq transport -> manual redirects/retries -> bounded body -> cleanup. No browser escalation or extractor network; cleanup failures are swallowed.")
    caught = route("execution-errors", CORE, "executePreparedToolCall", "Thrown Error.message/String(error) becomes createErrorToolResult text, without a new translation or error prefix; returned isError and content are retained.")
    finalized = route("execution-hooks", CORE, "finalizeExecutedToolCall", "afterToolCall can replace content/details/error flag. Arbitrary extensions/hooks are an unbounded producer seam, not classified as local UI.")
    recorded = route("error-content", CORE, "createErrorToolResult", "Text result stores the supplied message verbatim; createToolResultMessage stores content/details/isError for terminal/history/export.")
    browser = route("browser-result-content", PI + "core/export-html/template.js", "renderToolCall", "bash/read/write/edit/ls browser branches use result.content or details.diff; other names may use preRenderedTools, otherwise generic result text. Not every terminal preview is the browser consumer.")
    preview = "continuation execution -> " + caught + " -> " + finalized + " -> " + recorded + "; terminal-renderer-selection/native-renderer-merge/preview-selection (original routes); " + browser
    ids = {}

    ids["bash"] = family("bash-execution", PI + "core/tools/bash.js", "createShellToolDefinition", "full implementation; streaming/final; empty; truncated; nonzero/null exit; abort/timeout", "Authored (no output), Showing lines/last line/byte limit + Full output, Command aborted, Command timed out after <seconds> seconds, Command terminated without an exit code and Command exited with code <code> are local framing. Shell stdout/stderr and paths are payload. Abort/timeout errors append framing to accumulated output; other thrown errors pass through and do not automatically retain that output. structuredContent.output excludes these appended status sentences.", preview)
    family("shell-preflight", PI + "core/tools/bash.js", "createLocalShellOperations", "timeout bounds; pre-abort; missing cwd; spawn/close/signal", "Invalid timeout bounds and Working directory does not exist / Cannot execute <shellName> commands are authored diagnostics. Internal aborted and timeout:<n> sentinels are remapped by createShellToolDefinition, not independently displayed. Spawn errors from waitForChildProcess are forwarded without being local English by definition.", preview)
    ids["powershell"] = family("powershell-execution", PI + "core/tools/powershell.js", "createPowerShellToolDefinition", "full implementation; shared shell backend; custom operations", "Delegates all output/status/error composition to createShellToolDefinition using PowerShell identity and PS> prompt. UTF8_OUTPUT_PREFIX changes command execution, not UI. Default operations use getPowerShellConfig; no PowerShell-specific preview override is registered by the inspected preview registry.", preview)
    family("shell-configuration", PI + "utils/shell.js", "getShellConfig", "custom shell missing; Windows bash not found; Unix fallback", "Custom shell path not found and No bash shell found Options/Install/Add/Set/Searched Git Bash instructions are local diagnostic framing. Configured paths/environment entries and executable names remain technical data. Lookup failures are swallowed until the explicit fallback/error.", preview)
    family("powershell-configuration", PI + "utils/shell.js", "getPowerShellConfig", "not Windows; pwsh/PowerShell discovery fails", "The powershell tool is only available on Windows. and No PowerShell executable found. Install PowerShell or add powershell.exe/pwsh.exe to PATH. are local authored diagnostics, not OS-supplied prose. This is source evidence, not an actual platform run.", preview)
    family("shell-spawn-errors", PI + "utils/child-process.js", "waitForChildProcess", "error/exit/close; inherited stdio; idle grace", "No fixed diagnostic English is composed. error event rejects its original error, exit/close resolves code. Idle-grace timing and actual process teardown need execution; this helper cannot turn all OS error messages into local UI.", preview, level="reviewed-payload-and-consumer-boundary")
    ids["read"] = family("read-execution", PI + "core/tools/read.js", "createReadToolDefinition", "full implementation; aborted; offset invalid; text/limit/bytes; image/nonvision", "Operation aborted, Offset <n> is beyond end of file, Read image file [mime], current-model image omission note, oversized-line bash hint, Showing lines and more lines/Use offset continuation notices are authored framing. File bytes/images/MIME/path/counts remain payload. access/read errors are forwarded. Image failures return a note as successful text, not a thrown error.", preview)
    family("image-processing-notes", PI + "utils/image-process.js", "processImage", "supported/converted/resize-fails/oversize; hints", "Image omitted: could not be converted to a supported inline image format and could not be resized below the inline image size limit are fixed authored notes. Image converted from <format> to <format> and dimension hints are local framing. Image bytes and dimensions are data, not prose to translate.", preview)
    family("image-coordinate-note", PI + "utils/image-resize.js", "formatDimensionNote", "resized versus unchanged image", "[Image: original <w>x<h>, displayed at <w>x<h>. Multiply coordinates by <scale> to map to original image.] is authored explanatory framing with numeric payload. Worker/Photon conversion failures are caught/fallback/null at the selected processImage path rather than a generic visible error banner.", preview)
    ids["write"] = family("write-execution", PI + "core/tools/write.js", "createWriteToolDefinition", "full implementation; queue; mkdir/write; abort after await; success", "Operation aborted and Successfully wrote to <path> are local authored copy. Filesystem/injected-operation errors are forwarded unprefixed. Native success renderer suppresses this content; selected preview normal writes use a different producer, while browser write branch displays result text.", preview)
    ids["edit"] = family("edit-execution", PI + "core/tools/edit.js", "createEditToolDefinition", "full implementation; input validation; access/read/write; matching; abort; success", "Edit tool input is invalid. edits must contain at least one replacement., Operation aborted, Could not edit file: <path>. Error code: <code>. and Successfully replaced <n> block(s) in <path>. are authored framing. Access error without code uses String(error); read/write errors remain their producer data. Success details.diff/patch is source, not UI. Preview error shows only first result line; native edit can suppress duplicate preview errors.", preview)
    family("edit-match-errors", PI + "core/tools/edit-diff.js", "applyEditsToNormalizedContent", "empty oldText; not found; repeated match; overlapping edits; identical replacement", "getEmptyOldTextError/getNotFoundError/getDuplicateError/getNoChangeError and overlap instructions are locally authored. Single/multiple-edit variants retain edits[index], paths, counts and oldText/newText identifiers. Replacement range and line-count invariant errors are also authored helper diagnostics; no arbitrary source code is translated.", preview)
    ids["find"] = family("find-execution", PI + "core/tools/find.js", "createFindToolDefinition", "full implementation; default fd/custom glob; absent/abort/spawn/nonzero/empty/limits", "Operation aborted, Path not found, fd is not available and could not be downloaded, Failed to run fd:, fallback fd exited with code, No files found matching pattern and result/byte limit/refine-pattern notices are authored. fd stderr wins over exit fallback and is technical external-binary output, not automatically local UI; nonzero with stdout may still return paths. Preview recognizes exact empty marker and may replace it.", preview)
    ids["grep"] = family("grep-execution", PI + "core/tools/grep.js", "createGrepToolDefinition", "full implementation; rg availability; stat/read fail; spawn; no match; capped/truncated", "Operation aborted, ripgrep (rg) is not available and could not be downloaded, Path not found, Failed to run ripgrep:, fallback ripgrep exited with code, No matches found, (unable to read file), matches/bytes/long-line/refine-pattern notices are local framing. stderr, matching source, paths and regexes are payload. JSON parse failures are ignored, not a visible parse diagnostic.", preview)
    ids["ls"] = family("ls-execution", PI + "core/tools/ls.js", "createLsToolDefinition", "full implementation; missing/not-directory/readdir failure; skipped stat; empty/capped/bytes", "Operation aborted, Path not found, Not a directory, Cannot read directory:, (empty directory), entries/byte limits and Use limit instructions are authored framing. Cannot read directory interpolates external error.message. Per-entry stat failure is silently skipped; real names/suffix slash and paths remain data. Preview recognizes the exact empty marker.", preview)
    family("search-tool-acquisition", PI + "utils/tools-manager.js", "ensureTool", "existing; offline/Android; acquisition fails", "find/grep call ensureTool without onStatus. Its local download/progress/failure messages (and downloadTool nested framing) therefore do not reach these tool results: optional onStatus calls are silent and errors return undefined. The tools create their own unavailable diagnostics. No download or install was executed.", preview)
    family("agent-error-conversion", CORE, "executePreparedToolCall", "tool returns isError; throws; updates finish; after-hook replaces", "Error.message/String(error) is copied into text result, not prefixed by Error: here. A dynamic message can be locally authored, OS/native/library-derived or extension-authored. Result and error flag can be rewritten by afterToolCall; source closure is for default selected paths, not every possible hook.", preview, level="reviewed-payload-and-consumer-boundary")

    for tool, finding in [
        ("read", "First text is joined from result.content. Errors show only the first line (or Read failed); image success changes leading Read image file to image, retains remaining notes, and text truncation notices are split into previewFooter. File/code content is highlighted without a translator."),
        ("edit", "Errors show first text line or Edit failed, not the full multi-line result. Success uses details.diff and Edit applied/count/no diff, rather than Successfully replaced result text. Old/new text and diff stay source payload."),
        ("write", "Errors show all result text or Write failed. Success derives Write applied/new file/no changes/diff skipped from before snapshot and args, suppressing underlying Successfully wrote wording. Normal execute is replaced; malformed args delegate native execute."),
        ("bash", "Errors and success both flow through selected escaped output lines, collapsed to a limit then expand. No output, Output truncated by bash, Full output and output-lines footer are local copy; appended command status can be outside collapsed lines. No line-by-line translation of shell data."),
        ("grep", "Errors show first line or Grep failed; exact No matches found is an empty-result state. Other text including local producer notices enters highlighted grep output and may collapse; raw match lines remain source data."),
    ]:
        family("preview-" + tool + "-consumer", PRE + "tool-renderers/" + tool + ".ts", "register" + tool.title(), "selected override partial/error/success; collapsed/expanded/hidden", finding, preview)
    family("preview-write-producer", PRE + "write/preview-execution.ts", "executeWriteWithPreviewLock", "normal preview write; queue; snapshot; abort; success", "Selected preview write performs mkdir/write itself, not native execute. Operation aborted and Successfully wrote <bytes> bytes to <path> are authored. Bytes/path are data; fs errors forward. before-content cache/detail redaction changes diff availability, not source ownership.", preview)
    family("preview-write-skip-reasons", PRE + "write/diff.ts", "readExistingFileForPreview", "stat/read/unavailable/non-file/old-or-new-too-large", "previous content unavailable, previous path is not a regular file, previous file too large and new content too large are authored skip reasons; getWriteDiffSkipReason also falls back to preview unavailable. renderWrite uses diff skipped + reason with size numbers, not raw fs error prose.", preview)

    api = WEB + "webfetch-api.js"
    selected = route("selected-fetch-consumer", WEB + "jouzu-extension.js", "registerJouzuWebfetch", "Only patched createWebFetchTool/createBatchWebFetchTool are registered. fetchPage uses createStaticWebFetcher diagnostic capture, not excluded old tools modules.")
    fetch_entry = selected + " -> fetchPage -> " + transport + " -> failureResult/createResult -> responseText/detailsFrom -> single or batch renderer; " + browser
    ids["api"] = family("fetch-validation", api, "validateRuntimeOptions", "full API inspected; options/url/type/profile/os/numeric validation", "Plain-object/unknown option/format/headers/type/browser/os/removeImages/includeReplies/signal diagnostics are authored. numericOption integer ranges, URL must be a string, Invalid URL/redirect URL and unsupported protocol framing are authored separately. Names, bounds, supplied URLs/protocols and option identifiers are data; redaction is not localization.", fetch_entry)
    family("fetch-cancellation-budget", api, "readBody", "request deadline/parent abort; content-length and streaming aggregate budget", "The request timed out/was aborted; Response Content-Length exceeds remaining byte input budget; Response exceeded aggregate input budget are authored. requestSignal's Request timed out after <ms>ms reason is remapped by abortException, not an additional displayed sentence. safeCancel/boundedCleanup errors are swallowed.", fetch_entry)
    family("fetch-security-redirect-retry", api, "download", "proxy invalid/protocol/blocked/pins; request secrets/SSRF; redirects/loop/retries", "Invalid proxy URL, allowed proxy protocols, Proxy/Request destination was blocked (<reason>), Request URL contains potential secret material (<matches>), hostname did not produce validated DNS pins, Server returned an invalid redirect URL, Redirect limit exceeded/Redirect loop detected and Request failed after retries are authored diagnostics. retry request is an internal RetryAttempt sentinel. URLs/host pins/headers/reasons remain technical data.", fetch_entry)
    family("fetch-response-errors", api, "createResult", "HTTP non-2xx; binary/type mismatch; invalid JSON; bot; empty content; PDF", "The response body is binary, Server returned HTTP, Unsupported binary response (unknown content type fallback), HTML output requires an HTML response, The response was not valid JSON/not JSON, and No readable content was extracted; use a browser renderer for JavaScript-only pages are authored. Default wreq statusText comes from Node STATUS_CODES, not the remote reason phrase; injected transport statusText has separate provenance. Raw page/body/JSON/article metadata remain payload.", fetch_entry)
    family("fetch-failure-normalization", api, "failureResult", "StaticFetchException versus arbitrary thrown error", "Known exception code/message/phase/retryable fields survive; otherwise redactErrorText(error.message/String(error)) is returned with timeout/network_error classification. That fallback label does not establish network provenance: PDF loader/parser/native/DOM failures can reach it. No blanket claim that all messages are remote or authored local UI.", fetch_entry, level="reviewed-payload-and-consumer-boundary")
    family("fetch-pdf-framing", api, "extractPdf", "unsupported format; load/parser empty text; PDF markdown success; cleanup", "PDF responses support markdown or text output, not <format>; No text was extracted from the PDF; Document fallback title; and ## PDF Content (<pages> pages) are authored, even though the last frame is inside successful extracted content. PDF text/title filename/counts remain data. load/getText rejections reach failureResult; destroy failures are swallowed.", fetch_entry)
    family("fetch-pdf-loader", WEB + "types.js", "loadPdfParseCtor", "polyfills; dynamic module export normalization; import/constructor errors", "pdf-parse did not export PDFParse is an authored local diagnostic. Module import or ctor/load/getText failures are not rewritten by the loader. formatErrorInfo labels in this same file are NOT imported/called by selected webfetch-api/jouzu-extension, so they are not active selected failure framing.", fetch_entry)
    family("pdf-load-text", PDF + "PDFParse.js", "load", "selected constructor/load/getText/getPageText/destroy methods inspected", "Selected PDF parser uses pdfjs.getDocument({data}) and getPageText. load catches and getException remaps known errors, preserving message; getText does not add an error prefix. Image conversion/getTable/screenshot-only errors in this module are not on this path. getPageText mutates the shared params with an authored default pageJoiner, so getText appends page-number framing inside extracted text.", fetch_entry, kind="method", level="reviewed-payload-and-consumer-boundary")
    family("pdf-page-separator", PDF + "ParseParameters.js", "setDefaultParseParameters", "selected default getText/getPageText options; page separator", "Default pageJoiner is \\n-- page_number of total_number --. getPageText installs it into params, then getText replaces the tokens with page counts and appends it after each page. The fixed of separator is extractor-authored framing inside returned PDF text, not verbatim document content.", fetch_entry)
    family("pdf-exception-boundary", PDF + "Exception.js", "getException", "known PDF error class; arbitrary Error; non-Error", "Invalid PDF, Password required or incorrect, PDF format error, Unknown error, Response error and Operation aborted are class fallback messages when message is nullish. getException passes underlying error.message, preserving it; it does not prove such fallback is selected for a particular corrupt PDF. PDF.js/native/parser bytes/errors remain technical producer data; syntax-grammar and worker universes are not exhaustively classified.", fetch_entry, level="reviewed-payload-and-consumer-boundary")
    family("fetch-bot-producer", WEB + "bot-detection.js", "detectBotBlock", "matched signature; secondary indicators; no block", "Cloudflare/Anubis/PerimeterX/DataDome/Incapsula/Akamai/generic bot-protection messages and Bot protection likely detected (<matches>) are authored descriptions selected by detectBotBlock; raw page challenge text is not copied as this message. No bot protection detected is not a failure message. Other login-redirect helpers are not called by the selected API.", fetch_entry)
    family("fetch-security-producer", WEB + "security.js", "validateUrlForSsrf", "DNS/empty/unparseable/private/reserved/metadata/port verdict", "Returns verdict reason tokens plus pinnedIps, not a rendered security sentence. download composes Request/Proxy destination was blocked; scanForSecrets supplies type tokens. createSsrfError and other module helpers are not called on this selected route, so [SECURITY] wrapper text is not counted as active. DNS failure payload is reduced to dns-error verdict here.", fetch_entry)
    family("fetch-redaction", api, "redactErrorText", "URLs/credentials/secrets in caught diagnostics", "Redaction masks credential values and URL userinfo before forwarding. [REDACTED] and typed placeholders are technical safety markers, not permission to translate arbitrary error/page/source values. redactSecrets does not localize a diagnostic's authored prefix.", fetch_entry, level="reviewed-payload-and-consumer-boundary")
    family("wreq-native-import", WREQ, "loadNativeBinding", "module evaluation before registration; target unsupported/load fails", "Unsupported platform / Supported platforms and Failed to load native module / Tried / Make sure package installed correctly are authored JS diagnostics. wreq binding loads at import time, so these failures are outside fetchPage failureResult and propagate through extension-loader error handling instead. No native module was imported by this audit.", "extension loader -> module evaluation -> showLoadedResources; not a returned fetch result")
    family("wreq-transport-errors", WREQ, "createTransport", "selected browser/os/resolve/trustStore validators; native create failure", "Selected options expose JS validation framing for empty/invalid browser profile or OS, resolve object/addresses and default trust-store contract. Preset path skips custom-emulation validators when undefined. Native create errors are wrapped as RequestError(String(error)), not a new authored sentence. Generic wreq websocket/session-only diagnostics are outside this entrypoint.", fetch_entry)
    family("wreq-request-body-errors", WREQ, "dispatchRequest", "selected fetch -> GET/manual/headers/existing transport -> native request/body", "dispatchRequest preserves RequestError/AbortError or wraps String(native error). Header name must be a string/must not be empty and Header value must not be null or undefined are authored guards; Transport has been closed and Response body is already used are authored lifecycle guards if reached. The inspected API sends plain validated headers, an open transport and consumes each response once; no successful-path assertion that those guards fire. API defaults exclude conflicting session/custom body/websocket inputs. Response.statusText uses Node STATUS_CODES; native body stream forwards errors. Transport.close failures are swallowed by API boundedCleanup, not displayed as fetch failures.", fetch_entry, level="reviewed-payload-and-consumer-boundary")
    family("fetch-html-extractor", api, "extractHtml", "linkedom Document -> Defuddle node; nonempty/empty/reject; fallback", "Passes useAsync:false and fetch:denyExtractionNetwork. Defuddle warnings can be retained by capture even on success or DOM fallback; a caught Defuddle rejection itself is swallowed unless aborted. Network access is disabled in the static extraction entrypoint is authored defensive error text, not evidence of a request. fallbackHtmlContent returns page text/title, without an authored fallback banner.", fetch_entry)
    node = route("defuddle-node", DEF + "node.js", "Defuddle", "defuddle/node export is dist/node.js; Document input skips string/JSDOM branches, calls parseAsync then toMarkdown. No package-default browser bundle/fetch utility on this route.")
    family("defuddle-sync-selection", DEF + "defuddle.js", "parseAsync", "useAsync:false; sync parse/retries/site extractor", "useAsync:false skips both preferred and fallback async extractors. parse/parseInternal -> synchronous registry/extract -> normal cleanup or error fallback. Debug defaults false, so _log/removal debug messages, stylesheet/rule debug warnings and problematic-schema JSON are not emitted on this selected path. Async-only error warnings are not active here.", node + " -> " + fetch_entry, kind="method")
    family("defuddle-document-diagnostics", DEF + "defuddle.js", "parseInternal", "registry/metadata/schema; pipeline error; media/style diagnostics", "Defuddle Error processing document:, Error evaluating media queries:, Error applying styles for selector: and Error parsing schema.org data: are authored prefixes. Selector, JSON parser Error and arbitrary DOM/library error summary remain technical/page-derived data. Error fallback can still return body content; no separate visible extraction-failed toast is created.", node + " -> jouzu-diagnostics.cjs -> " + fetch_entry, kind="method")
    family("defuddle-registry-diagnostic", DEF + "extractor-registry.js", "findByPredicate", "fixed installed mappings; canExtract/constructor throws", "Error finding extractor: is authored and captured; returns null after error. Registry mappings select installed synchronous extractors. This finite installed registry is not an arbitrary extension producer universe, but does not exhaust PDF.js/DOM/MathML library grammar errors.", node + " -> capture -> " + fetch_entry, kind="method")
    family("defuddle-metadata-diagnostics", DEF + "metadata.js", "extract", "metadata URL/base URL invalid; schema traversal error", "Failed to parse URL:, Failed to parse base URL: and Error in getSchemaProperty for <property>: are authored captured framing. Canonical/meta/schema URLs and underlying errors are page/technical data. Empty metadata fallback is not an English error label.", node + " -> capture -> " + fetch_entry, kind="method")
    family("defuddle-markdown-failure", DEF + "markdown.js", "createMarkdownContent", "turndown conversion error; diagnostic log and returned fallback", "Error converting HTML to Markdown: and Problematic content: are authored captured prefixes; logged HTML excerpt remains page content. Partial conversion completed with errors. Original HTML: is ALSO authored framing returned inside successful content, not merely console output. Original HTML follows it verbatim; do not translate the entire fallback as local UI.", node + " -> toMarkdown -> capture + result.content -> " + fetch_entry)
    family("defuddle-math-diagnostics", DEF + "elements/math.full.js", "getLatexFromElement", "MathML/LaTeX converter throws; raw fallback", "standardize.js -> elements/math.js -> math.full.js is selected. Failed to convert MathML to LaTeX: and Failed to convert LaTeX to MathML: are authored warnings captured by the shim. Raw formula/underlying converter error remain technical payload; fallback preserves LaTeX rather than adding a UI banner.", node + " -> parseInternal -> standardize -> capture -> " + fetch_entry, kind="initializer")
    family("defuddle-chatgpt-diagnostic", DEF + "extractors/chatgpt.js", "extractMessages", "sync conversation citation URL/fragment decoding fails", "Failed to parse URL: <url> is authored captured framing with page URL/error payload. Author headings and conversation messages are page/provider content, not diagnostic UI to translate.", node + " -> sync registry -> ConversationExtractor -> capture -> " + fetch_entry, kind="method")
    family("defuddle-grok-diagnostic", DEF + "extractors/grok.js", "processFootnotes", "sync conversation footnote URL parse fails", "GrokExtractor: Could not parse URL for footnote: <url> is authored captured warning. Conversation fallback title/description/You role are extractor-authored content metadata, not Jouzu chrome; message bodies remain page data. Do not label every extracted metadata value as verbatim remote text.", node + " -> sync registry -> ConversationExtractor -> capture -> " + fetch_entry, kind="method")
    family("defuddle-conversation-error", DEF + "extractors/_conversation.js", "createTemporaryDocument", "no document implementation/DOMParser", "Unable to create a temporary document for conversation extraction is an authored thrown diagnostic reaching parseInternal Error processing document capture. Conversation / <site> conversation with <count> messages fallback metadata is extractor-authored, while original messages remain source content.", node + " -> sync conversation -> parseInternal catch -> " + fetch_entry, kind="method")
    family("defuddle-youtube-diagnostic", DEF + "extractors/youtube.js", "extractTranscriptFromExistingDom", "sync extract/buildResult; existing DOM/inline chapters", "YoutubeExtractor: failed to extract transcript from existing DOM and YoutubeExtractor: failed to parse inline JSON are authored captured framing on the synchronous path. parseInlineJson reads page script text from getValidatedPlayerResponse/getInlineChapters; no script execution is needed for that diagnostic. fetchTranscript/opened-DOM/mobile-panel diagnostics require async extractAsync, excluded by useAsync:false. Transcript/video text remains page data.", node + " -> sync registry -> capture -> " + fetch_entry, kind="method")
    capture = route("defuddle-capture", DEF + "jouzu-diagnostics.cjs", "capture", "AsyncLocalStorage scoped console captures local warnings plus normalized error/page data; max 50 entries, max 500 escaped characters after sanitization; no process-global console output.")
    family("diagnostic-capture-framing", DEF + "jouzu-diagnostics.cjs", "record", "formatting/sanitize failure; max count/length; error normalization", "[unredacted diagnostic omitted], [invalid sanitized diagnostic] and [unformattable diagnostic] are authored capture placeholders. [Circular]/[Object]/[Getter], Error fallback name and (code:)/(input:) are technical normalization markers. Error stacks are omitted, controls escaped and full value sanitized before truncation; unknown error.message remains its producer's payload.", capture + " -> createStaticWebFetcher -> " + fetch_entry)
    family("diagnostic-api-bridge", api, "createStaticWebFetcher", "captured diagnostics present/absent/omitted; fetch result success/failure", "Wraps the full fetcher with scoped capture and re-redacts messages, appending extractionDiagnostics/extractionDiagnosticsOmitted to returned result. Does not itself translate or add a failure sentence. Because extraction catches can fall back, diagnostics do not imply result.ok=false.", capture + " -> " + fetch_entry)
    family("fetch-selected-response-text", WEB + "jouzu-extension.js", "jouzuOriginalresponseText", "model/history failure/success; metadata/output truncation", "Fetch failed [code] (HTTP status): <message> and URL/Final URL/Status/Content-Type/Format/Characters/(truncated)/Title/Author plus tool-output truncation notice are authored. API message retains its mixed provenance. This is model/history text; single terminal renderResult shows only Fetch failed[: code] or Fetched <destination> (<chars> chars[, truncated]), not full failure message.", fetch_entry)
    family("fetch-selected-batch-errors", WEB + "jouzu-extension.js", "batchErrorText", "batch item failure; expanded row; absent snapshot fallback; aborted", "Fetch failed [code] (HTTP status): <message> (phase: <phase>; retryable: yes/no) is authored. Expanded renderBatchProgress displays per-item errors; collapsed view shows failed status/count. executeBatch final cancellation throws The batch fetch was aborted into agent-core error-content. Queued/fetching/failed/done and ms/s/chars/URLs summaries are local view framing, not URL content.", fetch_entry)
    family("fetch-diagnostic-history", WEB + "jouzu-extension.js", "jouzuDiagnosticText", "captured/omitted; model text budgets; single/batch final", "Extraction diagnostics (Defuddle):, <n> additional diagnostics omitted., Batch extraction diagnostics (Defuddle):, Request <n>: and [shortened; expand this tool for retained details] are authored. responseText and batchResponseText prepend bounded diagnostics before article content and retain full bounded entries in details; count/URL/level/error fields are data.", capture + " -> " + fetch_entry)
    family("fetch-diagnostic-renderer", WEB + "jouzu-extension.js", "jouzuDiagnosticTool", "partial bypass; no entries; collapsed count; expanded entries", "Wraps selected renderer; adds <count> extraction diagnostic(s); expand this tool to review. when collapsed, URL+diagnostic heading/messages when expanded. Partial updates bypass this panel. Single-tool original renderer ignores expanded and omits full failure message, while this wrapper still shows captured Defuddle entries. Browser non-builtins can pre-render this selected custom UI.", fetch_entry)

    family("selected-status-map-consumer", "packages/session-ui/src/extension.ts", "createSessionUiExtension", "session_start; replacement footer; status map/activity callback", "Replacement footer publishes the live getExtensionStatuses map to Session Line activity callbacks; it renders StatusBarComponent rather than replaying every native status value. main-cli runMainCli reads the multiloop key for sessionActivity and FAST_MODE_STATUS for the on state. Arbitrary status-map entries are not automatically displayed here. Actual placement/width remains unexecuted.", "packages/session-ui/src/extension.ts -> packages/cli/src/main-cli.ts runMainCli -> sessionActivity/SessionLineComponent; native FooterComponent is conditional", level="reviewed-payload-and-consumer-boundary")

    # One status for each immutable original residual, in its original order.
    resolutions = []
    for index, original in enumerate(tables["residuals.csv"], 1):
        source = original["source_file"]
        if index <= 8:
            tool = Path(source).stem
            linked = [ids[tool]]
            status = "closed-at-selected-source"
            conclusion = "Full native " + tool + " implementation and immediate authored diagnostic producers traced through error/result content into selected preview/native and browser consumers. Local framing separated from source/technical payload."
            remaining = "Actual platform failure/output/cancellation/layout outcomes and arbitrary custom operations/hooks are not source or runtime signoff; preserve source/OS/external-binary payload."
            check = "No further selected default producer source check. Execution would be needed for concrete platform/UI fixtures; new injected producers need their own review."
        elif index == 11:
            linked = [ids["api"]] + [row["surface_id"] for row in tables["surfaces.csv"] if row["surface_id"].startswith(PREFIX) and row["source_file"] in {api, WEB + "jouzu-extension.js", WREQ, DEF + "node.js", DEF + "defuddle.js", DEF + "jouzu-diagnostics.cjs", PDF + "PDFParse.js"} and row["surface_id"] != ids["api"]]
            status = "closed-at-selected-source"
            conclusion = "Full active static API and selected adapter; immediate validation/security/bot/transport/HTML/PDF/capture diagnostic framing and consumer selection resolved. Not an exhaustive native binary/PDF.js/DOM/grammar error-message inventory."
            remaining = "Concrete network/parser/native/environment outcomes and arbitrary injected dependencies remain unexecuted/opaque technical payload. Underlying library data is not automatically local UI or remote-content exempt."
            check = "No further selected API/framing route source check. Concrete corrupt-input/native error wording needs producer-specific evidence, not blanket rewriting; runtime outcomes remain untested."
        else:
            spec = {
                9: ("loader-unbounded", PI + "core/extensions/loader.js", "loadExtension", "open-unbounded", "Known wrapper/validation source is closed; module import/factory/handler error producers can be arbitrary installed/user extensions, not a finite source universe.", "Enumerate only a specifically assigned extension producer with source/fixtures; preserve arbitrary message/stack data."),
                10: ("status-unbounded-runtime", PI + "core/footer-data-provider.js", "getExtensionStatuses", "open-unbounded-and-runtime", "Status carrier/native/replacement consumers are source-traced; arbitrary ctx.ui.setStatus producers are unbounded and actual replacement placement requires execution.", "Review a named status producer separately and run isolated native/replacement terminal fixtures for actual placement/width."),
                12: ("viewer-markdown-runtime", PI + "core/export-html/template.js", "safeMarkedParse", "open-runtime", "Direct marked.parse call without catch is established; malformed transcript parse/exception/render/document/console outcomes were not executed.", "Deterministic malformed Markdown browser fixtures are required; no parser outcome signoff from source anchors."),
                13: ("timing-layout-runtime", PRE + "preview/tool-timing.ts", "updateToolCallTiming", "open-runtime", "Timing producer, duration units, pending/final state and border-slot consumers are source-traced; elapsed/repaint/width/Japanese configured-key fit require runtime.", "Run deterministic timing/partial/final/narrow-width Japanese terminal fixtures; preserve configured key binding data."),
            }[index]
            identifier, source_anchor, name, status, remaining, check = spec
            linked = [family(identifier, source_anchor, name, status, remaining, original["consumer"], kind="method" if index == 10 else "function", level="reviewed-payload-and-consumer-boundary", limit=remaining)]
            conclusion = "Source interface refined; original non-source/unbounded remainder is intentionally not closed."
        resolutions.append(dict(zip(RESOLUTION_HEADER, [f"original-{index:02}", index, source, status, conclusion, "; ".join(linked), remaining, check])))

    limits = []
    def limit(identifier, boundaries, kind, source, consumer, remainder, check):
        limits.append(dict(zip(LIMIT_HEADER, [identifier, boundaries, kind, source, consumer, remainder, check])))
    limit("arbitrary-tool-payload", "original-01; original-02; original-03; original-04; original-05; original-06; original-07; original-08", "unbounded-payload", CORE, "tool content -> selected native/preview/browser", "Arbitrary files/shell/OS/external-binary output, injected operations and afterToolCall hooks are not a finite authored-UI universe. The reviewed default framing route is closed, not every value.", "Preserve payload; inspect any newly assigned concrete producer before translating its diagnostics.")
    limit("fetch-native-parser-payload", "original-11", "opaque-technical-payload-and-runtime", api, "wreq native/PDF.js/DOM/converter error -> failureResult/capture -> selected views", "Immediate JS framing and selected path are closed; native binary/PDF.js worker/grammar error strings and input-dependent parser/network results are not exhaustively classified or executed. A network_error label is not provenance proof.", "Keep underlying message/stack/source content distinct; obtain producer-specific source or execution evidence for a concrete value. No whole-transitive-package signoff.")
    for row in resolutions:
        if row["status"].startswith("open-"):
            limit(row["boundary_id"] + "-remainder", row["boundary_id"], row["status"].removeprefix("open-"), row["source_file"], tables["residuals.csv"][row["original_record"] - 1]["consumer"], row["remaining_limit"], row["remaining_check"])
    limit("clipboard-browser-capability", "original-12; original-13", "runtime-cross-cutting", PI + "core/export-html/template.js", "copyToClipboard/downloadSessionJson/sidebar and exported document", "Clipboard permission/fallback exceptions, downloads, rendered Markdown/layout/keyboard outcomes and browser storage behavior were not exercised. These cross-cutting limits are retained, not newly closed original residuals.", "Browser/terminal capability and Japanese layout fixtures required; source route inspection does not verify platform permissions or timing.")

    headers["residual-resolutions.csv"], tables["residual-resolutions.csv"] = RESOLUTION_HEADER, resolutions
    headers["continuation-limits.csv"], tables["continuation-limits.csv"] = LIMIT_HEADER, limits
    for name, rows in tables.items():
        stream = io.StringIO(newline="")
        writer = csv.DictWriter(stream, fieldnames=headers[name], lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
        products[name] = stream.getvalue()
    surfaces = tables["surfaces.csv"]
    counts.update({
        "additional_file_dispositions": baseline_counts["additional_file_dispositions"] + len(paths - original_paths),
        "file_dispositions": len(tables["files.csv"]),
        "surface_state_families": len(surfaces),
        "surface_source_files": len({row["source_file"] for row in surfaces}),
        "families_with_existing_test_pointer": sum(bool(row["existing_test"]) for row in surfaces),
        "verified_route_anchors": len(tables["routes.csv"]),
        "verified_surface_anchors": len(tables["source-anchors.csv"]),
        "evidence_levels": dict(sorted(Counter(row["evidence_level"] for row in surfaces).items())),
        "file_dispositions_by_kind": dict(sorted(Counter(row["disposition"] for row in tables["files.csv"]).items())),
        "continuation": {
            "original_residuals": len(resolutions),
            "source_closed_original_residuals": sum(row["status"] == "closed-at-selected-source" for row in resolutions),
            "open_original_residuals": sum(row["status"].startswith("open-") for row in resolutions),
            "original_residual_statuses": dict(sorted(Counter(row["status"] for row in resolutions).items())),
            "appended_file_dispositions": len(paths - original_paths),
            "appended_surface_families": len(surfaces) - baseline_counts["surface_state_families"],
            "appended_route_anchors": len(tables["routes.csv"]) - baseline_counts["verified_route_anchors"],
            "active_limit_records": len(limits),
            "baseline": {key: baseline_counts[key] for key in ["file_dispositions", "surface_state_families", "verified_route_anchors", "verified_surface_anchors"]},
        },
    })
    products["validation.json"] = json.dumps(counts, ensure_ascii=False, indent=2) + "\n"
    # Assert original rows, row order and serialized CSV prefix before any output write.
    receipt = json.loads((here / "snapshot-preservation.json").read_text(encoding="utf-8"))["files"]
    for name, info in receipt.items():
        if name.endswith(".csv"):
            records = list(csv.reader(io.StringIO(products[name])))
            assert records[0] == info["header"], name
            assert [row_hash(row) for row in records[1:1 + info["rows"]]] == info["row_sha256"], name
            assert hashlib.sha256(products[name].encode()[:info["bytes"]]).hexdigest() == info["sha256"], name
    return products, counts
