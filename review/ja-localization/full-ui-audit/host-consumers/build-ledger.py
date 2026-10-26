#!/usr/bin/env python3
"""Rebuild this finite static ledger; never import or execute product modules."""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
BASELINE = "62dee0ff79ad83afa96947ea58e5c426bb1563e8"
PI = "packages/cli/node_modules/@earendil-works/pi-coding-agent/"
CORE = "packages/cli/node_modules/@earendil-works/pi-agent-core/"
OWN = "packages/cli/src/"
SURFACE_HEADER = ["surface_id", "owner", "source_file", "source_symbol", "entry_point", "state", "locale_path", "source_finding", "evidence_level", "existing_test", "coverage_limit"]
FILE_HEADER = ["source_file", "disposition", "evidence"]
ANCHOR_HEADER = ["anchor_id", "source_file", "line", "kind", "exact_text"]
BOUNDARY_HEADER = ["boundary_id", "status", "surface_ids", "finding", "remaining"]

# Inclusive inspected intervals, not claims that the rest of a large file was read.
# None means EOF. Full-body records are deliberately a separate, small set.
FILES = {
    "pin": ("upstream/pi.lock.json", [(1, None)], "full-body"),
    "patch": ("upstream/pi-content-policy/patch.lock.json", [(1, None)], "full-body"),
    "apply": ("scripts/apply-pi-content-policy.mjs", [(1, None)], "full-body"),
    "pkg": (PI + "package.json", [(1, None)], "full-body"),
    "index": (PI + "dist/index.js", [(1, None)], "full-body"),
    "corepkg": (CORE + "package.json", [(1, None)], "full-body"),
    "coreindex": (CORE + "dist/index.js", [(1, None)], "full-body"),
    "main": (PI + "dist/main.js", [(630, 689)], "bounded-regions"),
    "session": (PI + "dist/core/agent-session.js", [(1, 45), (185, 229), (320, 539), (750, 1079), (1240, 1310), (1810, 1865), (2340, 2429), (2828, 3019), (3044, 3136)], "bounded-regions"),
    "sdk": (PI + "dist/core/sdk.js", [(1, 100), (220, None)], "bounded-regions"),
    "agent": (CORE + "dist/agent.js", [(1, 40), (400, None)], "bounded-regions"),
    "loop": (CORE + "dist/agent-loop.js", [(250, 294), (340, None)], "bounded-regions"),
    "runner": (PI + "dist/core/extensions/runner.js", [(494, 501), (542, 547), (690, 734), (811, 974), (1003, 1067)], "bounded-regions"),
    "wrapper": (PI + "dist/core/extensions/wrapper.js", [(1, None)], "full-body"),
    "definition": (PI + "dist/core/tools/tool-definition-wrapper.js", [(1, None)], "full-body"),
    "nested": (PI + "dist/core/nested-tool-calls.js", [(1, None)], "full-body"),
    "history": (PI + "dist/core/session-manager.js", [(165, 304), (810, 884), (1118, 1133)], "bounded-regions"),
    "messages": (PI + "dist/core/messages.js", [(1, None)], "full-body"),
    "interactive": (PI + "dist/modes/interactive/interactive-mode.js", [(1515, 1614), (1743, 1752), (2396, 2414), (2828, 2970), (3233, 3336), (3422, 3429), (3458, 3462)], "bounded-regions"),
    "component": (PI + "dist/modes/interactive/components/tool-execution.js", [(1, None)], "full-body"),
    "renderers": (PI + "dist/core/tools/renderers/index.js", [(1, None)], "full-body"),
    "renderutils": (PI + "dist/core/tools/render-utils.js", [(1, 90)], "bounded-regions"),
    "entry": (OWN + "main-cli.ts", [(101, 103), (357, 365), (690, 810)], "bounded-regions"),
    "policy": (OWN + "textguard-policy.ts", [(1, None)], "full-body"),
    "runtime": (OWN + "textguard-runtime.ts", [(1, None)], "full-body"),
    "direct": (OWN + "classic-host-policy.ts", [(1, None)], "full-body"),
    "context": (OWN + "subagents/context.ts", [(1, None)], "full-body"),
    "childpolicy": (OWN + "subagents/tool-policy.ts", [(1, None)], "full-body"),
    "worker": (OWN + "subagents/worker.ts", [(1, None)], "full-body"),
    "resources": (OWN + "subagents/resources.ts", [(96, 179)], "bounded-regions"),
    "trace": (OWN + "subagents/trace.ts", [(1, None)], "full-body"),
    "manager": (OWN + "subagents/manager.ts", [(337, 416), (597, 624)], "bounded-regions"),
    "integration": (OWN + "subagents/integration.ts", [(620, 699), (757, None)], "bounded-regions"),
    "childrender": (OWN + "subagents/render.ts", [(31, 110), (180, None)], "bounded-regions"),
    "noreply": (OWN + "flow-control/no-reply-tool.ts", [(1, None)], "full-body"),
    "results": (OWN + "flow-control/result-tools.ts", [(1, None)], "full-body"),
    "waits": (OWN + "flow-control/wait-tools.ts", [(250, None)], "bounded-regions"),
    "models": (OWN + "model-picker.ts", [(1284, 1320), (1405, 1468)], "bounded-regions"),
    "modelstate": (OWN + "model-picker-state.ts", [(120, 146), (356, 391), (439, 441)], "bounded-regions"),
    "settings": (OWN + "catalog-settings.ts", [(1241, 1260), (1741, 1746)], "bounded-regions"),
    "localize": (OWN + "pi-ui-localization.ts", [(944, None)], "bounded-regions"),
    "output": (OWN + "runtime-output.ts", [(1, None)], "full-body"),
}

# Exact declaration/expression lines; no earlier call is substituted for a declaration.
ANCHORS = [
    ("entry.import", "entry", "async function loadPiRuntime()", "declaration"),
    ("entry.policy", "entry", "contentPolicyFactory: nativeTextguard.createPolicy,", "expression"),
    ("entry.direct", "entry", "createDirectToolPolicyExtension(),", "expression"),
    ("entry.review", "entry", 'factory: createTextGuardReviewExtension(nativeTextguard)', "expression"),
    ("host.policy", "main", "contentPolicy: await options?.contentPolicyFactory?.", "expression"),
    ("session.before", "session", "async _beforeToolCall(", "declaration"),
    ("session.after", "session", "async _afterToolCall(", "declaration"),
    ("session.replace", "session", "const replaceInspectedResult = (admitted)", "expression"),
    ("session.nested", "session", "async _executeNestedToolCall(", "declaration"),
    ("session.events", "session", "_handleAgentEvent = async (event)", "declaration"),
    ("session.message-filter", "session", "const admitted = await policy.filterContext([event.message]", "expression"),
    ("session.persist", "session", "entryId = this.sessionManager.appendMessage(event.message);", "expression"),
    ("session.mutate", "session", "_replaceMessageInPlace(target, replacement)", "declaration"),
    ("session.message-hooks", "session", "const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);", "expression"),
    ("session.callable", "session", "_getCallableTools(active =", "declaration"),
    ("session.declarable", "session", "_isDeclarable(name) {", "declaration"),
    ("session.registry", "session", "_refreshToolRegistry(options) {", "declaration"),
    ("session.command", "session", "async _tryExecuteExtensionCommand(text)", "declaration"),
    ("session.bind", "session", "async bindExtensions(bindings)", "declaration"),
    ("session.summary", "session", "async _filterSummarizationEntries(entries, signal, label)", "declaration"),
    ("sdk.transform", "sdk", "transformContext: async (messages, signal)", "expression"),
    ("loop.projection", "loop", "async function streamAssistantResponse(", "declaration"),
    ("loop.prepare", "loop", "async function prepareToolCall(", "declaration"),
    ("loop.execute", "loop", "async function executePreparedToolCall(", "declaration"),
    ("loop.finalize", "loop", "async function finalizeExecutedToolCall(", "declaration"),
    ("loop.terminate", "loop", "function shouldTerminateToolBatch(", "declaration"),
    ("loop.events", "loop", "async function emitToolExecutionEnd(", "declaration"),
    ("loop.message", "loop", "function createToolResultMessage(", "declaration"),
    ("agent.state", "agent", "async processEvents(event)", "declaration"),
    ("runner.toolcall", "runner", "async emitToolCall(event)", "declaration"),
    ("runner.toolresult", "runner", "async emitToolResult(event)", "declaration"),
    ("runner.message-end", "runner", "async emitMessageEnd(event)", "declaration"),
    ("runner.emit", "runner", "async emit(event)", "declaration"),
    ("runner.context", "runner", "async emitContext(messages, afterClone)", "declaration"),
    ("runner.nested", "runner", "createToolContext(toolCallId, signal) {", "declaration"),
    ("runner.renderers", "runner", "resolveToolRenderers(toolName, base)", "declaration"),
    ("wrap.definition", "definition", "export function wrapToolDefinition(", "declaration"),
    ("history.persist", "history", "_persistUnobserved(entry, force = false)", "declaration"),
    ("history.append", "history", "appendMessage(message) {", "declaration"),
    ("history.raw", "history", "export function sessionEntryToContextMessages(entry)", "declaration"),
    ("history.projection", "history", "export function buildSessionProjection(entries, leafId, byId)", "declaration"),
    ("ui.definition", "interactive", "getRegisteredToolDefinition(toolName) {", "declaration"),
    ("ui.start", "interactive", 'case "tool_execution_start":', "expression"),
    ("ui.end", "interactive", 'case "tool_execution_end":', "expression"),
    ("ui.history", "interactive", "renderSessionItems(items, options = {})", "declaration"),
    ("ui.entries", "interactive", "renderSessionEntries(entries, options = {})", "declaration"),
    ("ui.extension-error", "interactive", "showExtensionError(extensionPath, error, stack)", "declaration"),
    ("ui.bind", "interactive", "async bindCurrentSessionExtensions()", "declaration"),
    ("component.call", "component", "createCallFallback() {", "declaration"),
    ("component.result", "component", "createResultFallback() {", "declaration"),
    ("component.display", "component", "updateDisplay() {", "declaration"),
    ("renderers.merge", "renderers", "export function withBuiltInRenderers(", "declaration"),
    ("render.text", "renderutils", "export function getTextOutput(", "declaration"),
    ("policy.withheld", "policy", "private withheld(review?", "declaration"),
    ("policy.check", "policy", "private async checkResult(", "declaration"),
    ("policy.context", "policy", "async filterContext(messages:", "declaration"),
    ("policy.tool", "policy", "async filterToolResult(event:", "declaration"),
    ("nested.execute", "nested", "async execute(callerId, name, args, options = {})", "declaration"),
    ("nested.error", "nested", "finish(record, isError, errorText)", "declaration"),
    ("nested.take", "nested", "takeRecord(toolCallId) {", "declaration"),
    ("direct.policy", "direct", "export function createDirectToolPolicyExtension()", "declaration"),
    ("child.policy", "childpolicy", "export function createChildToolPolicy(", "declaration"),
    ("context.tool", "context", "export function parentContextTool(", "declaration"),
    ("context.execute", "context", "const result = await readSessionTrace(path, options, catalog);", "expression"),
    ("trace.read", "trace", "export async function readSessionTrace(", "declaration"),
    ("worker.context", "worker", "[parentContextTool(launch.parentContextFile)]", "expression"),
    ("worker.policy", "worker", "createChildToolPolicy({", "expression"),
    ("worker.direct", "worker", "createDirectToolPolicyExtension(),", "expression"),
    ("worker.bind", "worker", 'await session.bindExtensions({ mode: "print", onError:', "expression"),
    ("worker.message", "worker", 'role: `tool:${message.toolName}`,', "expression"),
    ("manager.receive", "manager", "private receive(id: string, event: WorkerEvent)", "declaration"),
    ("manager.read", "manager", "read(id: string, offset = 0, limit = 12_000)", "declaration"),
    ("manager.trace", "manager", "async trace(id: string, options?: TraceQuery)", "declaration"),
    ("childrender.read", "childrender", 'operation === "read" && typeof root.text === "string"', "expression"),
    ("childrender.parse", "childrender", "export function parseSubagentResult(content:", "declaration"),
    ("integration.trace", "integration", 'case "trace":', "expression"),
    ("integration.render", "integration", "renderResult(result, { expanded }, theme, renderContext)", "declaration"),
    ("integration.exposure", "integration", 'name: "subagent",', "expression"),
    ("childrender.component", "childrender", "export function subagentComponent(", "declaration"),
    ("noreply.factory", "noreply", "export function createFlowNoReplyExtension(", "declaration"),
    ("noreply.exposure", "noreply", 'exposure: "model-only",', "expression"),
    ("noreply.body", "noreply", 'text: "Ended this turn without a reply."', "expression"),
    ("results.factory", "results", "export function createFlowResultExtension(", "declaration"),
    ("waits.exposure", "waits", 'name: "agent_wait",', "expression"),
    ("waits.cancel", "waits", 'name: "agent_wait_cancel",', "expression"),
    ("models.sync", "models", "const syncSession = (ctx:", "declaration"),
    ("models.start", "models", 'pi.on("session_start", async (event, ctx)', "expression"),
    ("modelstate.load", "modelstate", "export function loadModelPickerState(", "declaration"),
    ("settings.plan", "settings", "this.languageConfirm = this.planLanguageChange(request);", "expression"),
    ("localize.patches", "localize", "function installPrototypePatches(", "declaration"),
    ("output.scope", "output", "export async function withJouzuOutput<T>(", "declaration"),
]

# Each family links exact producer/consumer anchor IDs, expanded to path:L in the CSV.
SURFACES = [
    ("textguard.execution", "Jouzu TextGuard / Pi", "policy", "checkResult; _afterToolCall; finalizeExecutedToolCall", ["policy.check", "session.after", "session.replace", "loop.finalize", "loop.events", "ui.end"], "fresh inspected tool result: admitted/advisory/withheld", "fixed-English-result: not exclusively model projection", "Execution goes through extension tool_result, image normalization, then filterToolResult. For inspected sources the host clears the original merge source before returning the replacement. Agent-core emits tool_execution_end with that finalized result before creating its transcript message. The native live row receives that event result; a selected renderer may suppress or shorten it. Guarded advisory retains scanned text but omits flagged details/usage/structured/nested metadata; strict withholding substitutes English notice content.", "packages/cli/test/textguard-policy.test.mjs; packages/cli/test/textguard-reader-split.test.mjs", "Selected source ordering, not a scanner run or proof every renderer displays the full notice."),
    ("textguard.message-storage", "Jouzu TextGuard / Pi", "session", "_handleAgentEvent; _replaceMessageInPlace; appendMessage", ["session.events", "session.message-filter", "agent.state", "session.mutate", "session.message-hooks", "session.persist", "history.append", "history.persist"], "tool message_end recheck and successful persistence", "fixed-English-result: final message mutates state and feeds storage", "Agent-core pushes the finalized message into state before awaited listeners. Session message_end policy rechecks eligible noncancelled results, mutates that same object, then runs message_end extensions, public listeners, and appendMessage in that order. JSONL serialization writes the resulting message when persistence is enabled and succeeds. This is not a separate retained raw tool-result copy. Extensions may replace the message after the policy pass. Live tool_execution_end precedes this second pass, so live rows need not equal saved/restored text.", "packages/cli/test/textguard-reader-split.test.mjs", "No durability/fault/timing exercise; arbitrary later message_end handlers not classified. Not a guarantee that every native renderer sees the second pass."),
    ("textguard.history-projection", "Jouzu TextGuard / Pi", "sdk", "transformContext; emitContext; streamAssistantResponse", ["sdk.transform", "runner.context", "loop.projection", "history.projection", "ui.entries", "history.raw"], "restored history or changed policy at next model request", "model-only-copy: request recheck is distinct from persisted transcript", "emitContext starts from structuredClone(messages); SDK then filters that request copy before convertToLlm/streaming. This filter has no transcript append/rewrite. In contrast native rebuild reads buildContextEntries and sessionEntryToContextMessages, not this filtered provider-request copy. Old stored results can therefore remain visible while their request copy is withheld. Do not generalize this request-only property to the earlier execution/message_end passes.", "packages/cli/test/textguard-reader-split.test.mjs", "No restored-history render or provider handoff; downstream provider serialization and model behavior not approved."),
    ("textguard.host-failures", "Pi content-policy host", "session", "_afterToolCall; _handleAgentEvent; SDK transformContext", ["session.after", "session.message-filter", "sdk.transform"], "cancelled/invalid/throwing policy result or context", "host-fixed-English: separate fallback messages", "Inspected execution cancellation returns Tool result withheld after cancellation.; failed/invalid execution checking returns TextGuard could not check this result; content withheld. Failed message_end checking replaces eligible tool/user content with TextGuard could not check this message; content withheld. Uninspected execution results retain native results on failure; cancelled message_end skips recheck. SDK request checking throws TextGuard could not check model context; request withheld. These are host-authored English, not catalog TextGuard alert text.", "packages/cli/test/textguard-reader-split.test.mjs", "No failure injection; frozen/unreplaceable result and abort races not executed. Request rejection may become an assistant error, not a tool result."),
    ("textguard.progress", "Pi content-policy host", "session", "_handleAgentEvent; _executeNestedToolCall", ["session.events", "session.nested", "nested.execute", "ui.start"], "inspected progress: direct versus nested", "visibility-routing: direct update suppression is not a universal event filter", "Direct session tool_execution_update is dropped for inspected sources (and on inspection failure). Nested inspected calls reject an explicitly requested onUpdate callback before runner creation. Otherwise nested runner events go straight through extensionRunner.emit and session._emit, bypassing _handleAgentEvent. Native UI ignores parentToolCallId starts and has no separate pending row for their updates/results. This does not establish that arbitrary nested event subscribers see no progress.", "", "Other extension listeners and arbitrary parent-tool progress consumers remain unbounded; no native timing execution."),
    ("tools.model-only", "Pi host / Jouzu Flow", "session", "_isDeclarable; _getCallableTools; _applyToolLoadout", ["session.declarable", "session.callable", "session.registry", "noreply.exposure", "waits.exposure", "waits.cancel"], "agent_wait/cancel/no_reply/results declared directly but requested through executeTool", "exposure-contract: not a display:false flag", "direct and model-only are declarable/activated by default; _getCallableTools permits registered codemode/deferred tools and active direct tools, excluding model-only. A nested attempt to a model-only Flow name fails tool lookup before tool_call hooks or the tool body; Tool <name> not found is returned as an error. No exposure check hides these tools in native live/history ToolExecutionComponent creation.", "packages/cli/test/flow-no-reply.test.mjs", "No tool invoked; extension overrides/loadout changes are conditional. Tool names are stable identifiers, not localized labels."),
    ("tools.flow-body", "Jouzu Flow / Pi native fallback", "noreply", "createFlowNoReplyExtension; createFlowResultExtension; wait tools", ["noreply.factory", "noreply.body", "results.factory", "waits.exposure", "waits.cancel", "ui.definition", "renderers.merge", "component.call", "component.result"], "direct Flow success/refusal/result with no custom renderer", "catalog-label-not-body: fallback uses raw tool name and returned text", "These selected Flow definitions have catalog labels but no renderCall/renderResult. Builtin renderer lookup has no matching names. Native generic call fallback uses toolName, not definition.label; result fallback joins text content. Consequently the English no-reply success, wait summaries/notices and retained results JSON can enter human-visible terminal rows/history despite model-only. English description/prompt guidance is separate model instruction, not the returned result body. No blanket translation of retained reasons, references or hashes is justified.", "packages/cli/test/flow-no-reply.test.mjs; packages/cli/test/flow-wait-tools.test.mjs", "Resolver middleware can override presentation; no fixture run. Wait receipt hash compatibility remains as recorded by semantic-flow."),
    ("tools.termination", "Pi agent-core / Jouzu Flow", "loop", "shouldTerminateToolBatch; executeToolCallsSequential/Parallel", ["noreply.body", "loop.terminate", "loop.events", "loop.message", "ui.end"], "terminate:true no-reply versus sibling nonterminating result", "termination-not-invisibility: normal result events and history still exist", "Sequential and parallel batches emit normal end/message events for results before evaluating termination; shouldTerminateToolBatch requires at least one finalized result and every finalized result terminate===true. A nonterminating sibling prevents that batch termination. terminate is not persisted by createToolResultMessage; the success content is. This does not make the no-reply body invisible or acknowledge another tool's result.", "packages/cli/test/flow-no-reply.test.mjs", "No batch/abort executed; broader Flow continuation policy is not re-audited."),
    ("tools.native-fallback", "Pi native tool UI", "component", "createCallFallback; createResultFallback; updateDisplay", ["ui.history", "ui.end", "component.call", "component.result", "component.display", "render.text"], "no renderer; renderer throws; collapsed/expanded result", "native-English-framing-plus-preserved-payload", "A known definition without a call/result method and a throwing method use generic fallback independently. Call header is raw toolName plus arguments; result text is sanitized text blocks, first ten lines collapsed and all lines expanded. Remaining-line/to-expand framing is English. The no-definition branch formats name/JSON/output separately. Tool labels do not rewrite bodies; existing renderers can deliberately omit results. Native restored results match calls by toolCallId and have no exposure gate.", "", "Actual widths, key hint resolution, CJK layout, image capability and selected third-party renderer behavior remain unexecuted."),
    ("tools.nested-record", "Pi nested tool host", "nested", "NestedToolCallRunner; NestedCallRecorder; _handleAgentEvent", ["runner.nested", "session.nested", "nested.execute", "nested.error", "nested.take", "session.events", "ui.start", "ui.history"], "nested success/refusal/error beneath a parent tool", "nested-not-separate-transcript: metadata and optional parent payload", "Nested calls share runToolCall hooks and emit parentToolCallId events but add no individual toolResult message. Recorder stores name/id/status/duration, bounded arguments, first 500 error characters and completeness/usage; it does not store successful result bodies. takeRecord attaches metadata to the parent message before message_end; an inspected parent policy may remove it. Native UI skips nested starts and generic fallback does not read nestedCalls. The parent tool receives full outcome and can choose to embed/render it; no universal nested result panel follows from host metadata.", "packages/cli/test/subagents-tool-policy.test.mjs", "Arbitrary parent tools/resolver middleware and other event clients are not enumerated. Default native codemode is disabled by the selected owned override."),
    ("context.direct-nested", "Jouzu child context / Pi", "context", "parentContextTool; runGuardedWorker; readSessionTrace", ["context.tool", "context.execute", "worker.context", "worker.bind", "session.callable", "wrap.definition", "trace.read", "component.call"], "parent lookup enabled: direct child result versus nested lookup", "default-English-label-and-trace-diagnostics; JSON history evidence preserved", "Worker registers parent_context as customTools and adds its name to active tools without passing a catalog. Its exposure defaults direct, so active nested lookup is callable too. It has no owned renderer. execute returns JSON trace records/notices; trace validation uses its default English catalog and limit/incomplete notices are English literals. A direct call creates a child transcript result; a nested call yields parent outcome/metadata instead. The selected child binds print mode, not a native child TUI, so the fallback's raw parent_context header is a conditional native-view rule, not a screen observed in the child process.", "packages/cli/test/subagent-context.test.mjs; packages/cli/test/subagent-trace.test.mjs", "Parent snapshot is preserved evidence; OS read errors retain source provenance. No lookup, worker process or native renderer executed."),
    ("tools.child-refusals", "Jouzu child policy / Pi", "childpolicy", "createChildToolPolicy; prepareToolCall; NestedToolCallRunner", ["child.policy", "worker.policy", "session.before", "runner.toolcall", "loop.prepare", "nested.execute", "nested.error", "worker.context"], "inactive enabled-tool check or call budget exceeded", "owned-English-reason: direct error body versus nested outcome", "Child hook returns Access denied: tool is not enabled for this child session. or Tool limit reached. Report remaining work. Pi turns block reason into text isError without adding Error:. Direct calls feed ordinary result events and child history; a native presentation can render the refusal. Nested eligible calls return it to the caller and bound it into metadata, not a separate transcript result. Unknown, excluded or inactive direct tools can fail lookup before the hook in nested execution, so not every denied call reaches this reason. Budget exhaustion also sets worker exhausted and produces a separate Agent limit reached. Work is incomplete. outcome.", "packages/cli/test/subagents-tool-policy.test.mjs", "No permission/budget fixture run. Parent output inclusion and child final result normalization differ from a direct TUI row."),
    ("tools.direct-refusals", "Jouzu direct-call policy / Pi", "direct", "requiresDirectToolCall; createDirectToolPolicyExtension", ["direct.policy", "entry.direct", "worker.direct", "session.callable", "loop.prepare", "integration.exposure"], "nested obligation tool that remains callable", "owned-English-reason: only reachable after host lookup", "Owned main and child hosts register the direct-call policy. For a listed nested name with callable exposure reaching its hook it blocks execution with Call <tool> directly, not from another tool, so its result can be acknowledged. Selected Flow and subagent definitions are model-only and excluded from nested callable lookup earlier, so their nested result is Tool <name> not found, not this reason. This finite trace proves no active direct member of the policy list; other registrations or exposure overrides are conditional, not confirmed visible refusals. Default native codemode factory is empty, but extension tools can still call ctx.executeTool.", "packages/cli/test/classic-host-policy.test.mjs", "No nested tool executed and no exhaustive extension-caller inventory."),
    ("errors.execution-and-call", "Pi execution host", "loop", "prepareToolCall; executePreparedToolCall; finalizeExecutedToolCall", ["loop.prepare", "session.before", "runner.toolcall", "loop.execute", "loop.finalize", "loop.events", "loop.message"], "execute throw; tool_call hook throw; blocked or unknown call", "dynamic-error-preserved: local/OS/extension provenance must be classified", "execute exceptions and argument/tool_call preparation failures become Error.message/String(error) text with isError true, not an Error: prefix. emitToolCall deliberately has no catch; session preserves Error or wraps a non-Error as Extension failed, blocking execution: <value>. Immediate lookup/validation/block failures skip afterToolCall; executed results go through it and can be replaced by policy. The same conversion returns nested outcomes without separate messages. Arbitrary error producers are not automatically provider prose or localized copy.", "packages/cli/test/subagents-tool-policy.test.mjs", "No exceptions induced; arbitrary schema/native/extension messages remain unbounded. A later message_end recheck can further replace direct stored content."),
    ("errors.result-hook", "Pi extension runner", "runner", "emitToolResult; emitMessageEnd; emitError", ["runner.toolresult", "runner.message-end", "session.message-hooks", "ui.bind", "ui.extension-error"], "tool_result or message_end handler throws", "extension-error-UI: distinct from tool execution failure", "Unlike tool_call, emitToolResult catches each handler failure, emits extension error with stack and continues using current result; this alone does not convert the tool into a failed result. emitMessageEnd likewise reports handler failure and continues. Interactive onError calls showExtensionError, adding Extension \"<path>\" error: <message> plus dim stack lines to chat; it does not append a transcript tool result. Arbitrary extension error detail remains producer-owned.", "", "No fault injection or arbitrary handler inventory; child print binding instead aborts its failure controller."),
    ("errors.command", "Pi command host", "session", "_tryExecuteExtensionCommand; showExtensionError", ["session.command", "ui.bind", "ui.extension-error", "localize.patches", "output.scope"], "awaited extension command handler rejects", "native-English-error-frame: command identity plus preserved detail", "Awaited command handler failure emits command:<name> extension error and returns handled=true. Interactive binding shows Extension \"command:<name>\" error: <message>; this catch does not route it through Jouzu's catalog generic error frame or store it as a toolResult. Selected localization patches cover named selectors/owned lists, not this error Text or generic tool component. Output rewriting brands title/resume hints, not these sentences.", "", "Only exceptions rejecting the awaited handler are covered; later custom-view keyboard callbacks are a separate boundary."),
    ("errors.startup-models", "Jouzu Models / Pi event host", "models", "syncSession; session_start; ExtensionRunner.emit", ["modelstate.load", "models.sync", "models.start", "session.bind", "runner.emit", "ui.bind", "ui.extension-error"], "unsafe/oversize Models state escapes session_start", "owned-English-detail-in-native-English-extension-frame", "syncSession store.load has no local load catch; regular-file and size-limit errors bypass quarantine. bindExtensions installs onError before emitting session_start. Runner.emit catches the async handler failure, sends message/stack to onError and continues later handlers. Interactive sink therefore displays the owned English state error in native Extension framing. Successful quarantine still uses the catalog warning and protected saved path instead. This closes the earlier startup-event consumer gap, not every initialization failure.", "packages/cli/test/model-picker-state.test.mjs; packages/cli/test/model-picker.test.mjs", "No preferences corrupted and no startup executed. Child workers do not install this owned Models picker extension via this main assembly."),
    ("context.parent-consumers", "Jouzu child history consumers", "worker", "runGuardedWorker subscribe; manager.receive/read/trace; subagent renderer", ["worker.message", "manager.receive", "manager.read", "manager.trace", "integration.trace", "integration.render", "childrender.component", "childrender.read", "childrender.parse"], "parent inspects direct child parent_context/refusal results", "stored-child-content-not-automatically-parent-visible-body", "Worker forwards direct tool message_end text as tool:<name>, bounded to 16000 characters, and manager records the event. Child session JSONL retains the normal direct result as well. Parent subagent read custom renderer shows a catalog output-received role summary rather than the tool message body even expanded; trace reads the saved child session and generic result rendering can expose JSON/text excerpts. Nested bodies are not forwarded as separate message_end events. Do not equate retained child result, event-page summary, trace JSON and parent final answer.", "packages/cli/test/subagent-render.test.mjs; packages/cli/test/subagent-trace.test.mjs", "Workflow/dashboard alternate viewers and arbitrary model quotation are not re-audited. No IPC or read/trace tool run."),
    ("textguard.summaries", "Pi summarization host", "session", "_filterSummarizationEntries", ["session.summary", "policy.context"], "manual compaction or branch-history check", "model-summary-input: entry replacement without transcript rewrite", "Selected summarization helper filters eligible message entries, validates returned roles/count, and returns replacement entry objects for changed messages. It does not append a rewritten raw history record. Failures produce English session-history/compaction/branch-withheld guidance. This request-input boundary differs from fresh message_end mutation and does not prove native old-history redaction.", "", "Only helper and immediate manual compaction call inspected; summarizer/provider internals, all summary paths and final summary rendering not approved."),
]

BOUNDARIES = [
    ("textguard-fresh", "closed-selected-source", "textguard.execution;textguard.message-storage;textguard.host-failures", "Replacement ordering reaches event then final state/storage; separate message_end pass can diverge from live row.", "Selected renderer suppression, cancellation/frozen-result timing and persistence success require controlled execution."),
    ("textguard-restored", "closed-selected-source", "textguard.history-projection;textguard.summaries", "Request/history filters do not rewrite existing persisted transcript; native rebuild uses raw entries.", "No restored-session/native rendering or summarizer/provider execution."),
    ("flow-model-only", "closed-selected-source", "tools.model-only;tools.flow-body;tools.termination;tools.native-fallback", "Model-only excludes nested lookup, not direct native rows/history. Label and returned body are independent.", "No Flow tool or batch executed; alternate renderer middleware and wait hash migration remain separate."),
    ("nested-host", "closed-selected-source", "tools.nested-record;textguard.progress", "No separate nested transcript result; bounded metadata attaches to parent; native generic UI has no nested row/body renderer.", "Parent tools can embed outcomes and other event clients can consume events; neither is universally hidden."),
    ("parent-context", "closed-selected-source", "context.direct-nested;context.parent-consumers", "Child direct and nested lookup, English default and parent read-versus-trace distinction source-traced.", "No child TUI launched; alternate Workflow/dashboard/native views are not re-audited."),
    ("tool-refusals", "closed-selected-source", "tools.child-refusals;tools.direct-refusals;errors.execution-and-call", "Direct and nested hook/error conversions are known; pre-hook lookup changes the reason.", "Arbitrary source diagnostics and parent outcome consumption remain producer-specific."),
    ("extension-errors", "closed-selected-source", "errors.result-hook;errors.command", "Awaited command/event/result failures have native extension error consumer distinct from tool_call failure.", "Other run modes and arbitrary handlers are not exhaustively audited."),
    ("startup-models", "closed-selected-source", "errors.startup-models", "Models load throw reaches runner session_start catch and native error chat.", "No unsafe-state fixture or native startup run."),
    ("settings-key-callback", "open-source-consumer", "errors.command", "catalog-settings language confirmation plans synchronously from handleInput; not proved a rejection of an awaited command handler.", "Final Pi TUI event-loop/custom-view keyboard exception handling was not traced. Do not use the command catch as closure."),
    ("arbitrary-parent-renderer", "open-unbounded-producer", "tools.nested-record;tools.flow-body", "ctx.executeTool returns outcomes; resolver middleware and parent tools can render or embed them.", "Cannot prove all nested results hidden/visible without selecting the actual parent tool and renderer. Selected native codemode is disabled, not a universal absence of nesting."),
    ("native-layout", "open-native", "tools.native-fallback;errors.startup-models;textguard.execution", "Source establishes consumers, not screen placement or terminal acceptance.", "Japanese wording, CJK widths, expansion/key bindings, image support, clipping, focus, abort and native scanner/OS behavior unexecuted."),
    ("downstream-model", "open-out-of-scope", "textguard.history-projection", "Trace stops at converted model request input, not every provider adapter or remote response.", "No provider/network/model request; language compliance and downstream transport behavior unestablished. External receipt renderer remains outside this finite trace."),
]


def csv_bytes(header, rows):
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(header)
    writer.writerows(rows)
    return stream.getvalue().encode()


def generate():
    source_rows, receipt = [], []
    for key, (path, intervals, depth) in FILES.items():
        data = (ROOT / path).read_bytes()
        lines = data.decode("utf-8").splitlines()
        ranges = [[a, len(lines) if b is None else b] for a, b in intervals]
        assert all(1 <= a <= b <= len(lines) for a, b in ranges), path
        if depth == "full-body":
            assert ranges == [[1, len(lines)]], path
        receipt.append({"key": key, "source_file": path, "depth": depth, "ranges": ranges, "line_count": len(lines), "sha256": hashlib.sha256(data).hexdigest()})
        source_rows.append([path, "full-body-read" if depth == "full-body" else "bounded-region-trace", "Inclusive inspected ranges " + "; ".join(f"{a}-{b}" for a, b in ranges) + ". See source-read-receipt.json and linked surface/anchor records; file hash pins bytes, not full-file understanding or runtime approval."])
    anchors, by_id = [], {}
    for ident, key, needle, kind in ANCHORS:
        path = FILES[key][0]
        lines = (ROOT / path).read_text(encoding="utf-8").splitlines()
        matches = [(n, line) for n, line in enumerate(lines, 1) if needle in line]
        assert len(matches) == 1, (ident, matches)
        line, exact = matches[0]
        row = [ident, path, line, kind, exact]
        anchors.append(row)
        by_id[ident] = f"{path}:L{line}"
    surfaces = []
    for suffix, owner, key, symbol, refs, state, locale, finding, tests, limit in SURFACES:
        surfaces.append(["host-consumers." + suffix, owner, FILES[key][0], symbol, "; ".join(by_id[ref] for ref in refs), state, locale, finding, "source-only-host-trace", tests, limit])
    boundaries = [[ident, status, "; ".join("host-consumers." + s for s in refs.split(";")), finding, remaining] for ident, status, refs, finding, remaining in BOUNDARIES]
    return {
        "files.csv": csv_bytes(FILE_HEADER, source_rows),
        "surfaces.csv": csv_bytes(SURFACE_HEADER, surfaces),
        "anchors.csv": csv_bytes(ANCHOR_HEADER, anchors),
        "boundaries.csv": csv_bytes(BOUNDARY_HEADER, boundaries),
        "source-read-receipt.json": (json.dumps({"baseline": BASELINE, "method": "static source inspection; intervals inclusive; no product imports or execution", "semantic_whole_package_signoff": False, "runtime_signoff": False, "files": receipt}, ensure_ascii=False, indent=2) + "\n").encode(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Compare without writing any artifact")
    args = parser.parse_args()
    expected = generate()
    mismatches = [name for name, data in expected.items() if not (HERE / name).exists() or (HERE / name).read_bytes() != data]
    if args.check:
        print(json.dumps({"generated_files": len(expected), "mismatches": mismatches}, indent=2))
        return bool(mismatches)
    for name, data in expected.items():
        (HERE / name).write_bytes(data)
    print(json.dumps({"generated_files": len(expected)}, indent=2))
    return False


if __name__ == "__main__":
    raise SystemExit(main())
