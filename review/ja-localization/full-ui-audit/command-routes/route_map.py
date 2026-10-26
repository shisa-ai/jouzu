"""Hand-reviewed route -> family assertions, independent of source discovery.

This file is audit data, not a list from which the route universe is generated.
The reconciler discovers selected source registrations first and rejects any
extra/missing mapping. Arguments below are a bounded vocabulary, not a claim of
exhaustive parser, action or state coverage.
"""
PI = "packages/cli/node_modules/@earendil-works/pi-coding-agent/dist/"
IM = PI + "modes/interactive/interactive-mode.js"
MAPPING = {}
LIMIT = "Source-family mapping only; nested states, callbacks, failures, layout and runtime selection are not exhaustively certified."


def dep(*numbers):
    return [f"dependencies/surfaces.csv#dep-{number:04d}" for number in numbers]


def owned(*names):
    return ["terminal-owned/surfaces.csv#" + name for name in names]


def added(*names):
    return ["command-routes/surfaces.csv#command-routes." + name for name in names]


def anchor(path, needle):
    return {"path": path, "needle": needle}


def entry(key, states, descriptions=(), anchors=(), arguments="No finite subcommand vocabulary at this boundary.", limit=LIMIT):
    MAPPING[key] = {"state_families": states, "description_families": list(descriptions), "anchors": list(anchors), "argument_routes": arguments, "coverage_limit": limit}


# Ordered exactly as the pinned declaration list, but source discovery does not
# depend on this order or list. Native fallback families remain mapped.
BUILTINS = [
    ("settings", dep(*range(1, 20)), "showSettingsSelector()"),
    ("model", dep(41, 42, 354, 355), "async handleModelCommand(searchTerm)"),
    ("tree", dep(*range(32, 38), 47, 48, 49), "showTreeSelector(initialSelectedId)"),
    ("thinking", dep(20, 21, 353), "handleThinkingCommand(searchTerm)"),
    ("scoped-models", dep(43, 44), "showModelsSelector() {"),
    ("export", dep(342), "async handleExportCommand(text)"),
    ("import", dep(97, 348), "async handleImportCommand(text)"),
    ("share", dep(99, 100), "async handleShareCommand()"),
    ("bug", dep(101, 102, 103, 104, 105), "async handleBugCommand(hint)"),
    ("copy", dep(343, 344), "async handleCopyCommand(options = {})"),
    ("name", dep(98), "handleNameCommand(text)"),
    ("session", dep(90, 91), "handleSessionCommand()"),
    ("changelog", dep(96), "handleChangelogCommand()"),
    ("hotkeys", dep(95), "handleHotkeysCommand()"),
    ("fork", dep(38, 39, 40, 346), "showUserMessageSelector()"),
    ("clone", dep(345), "async handleCloneCommand()"),
    ("trust", dep(45, 46), "showTrustSelector()"),
    ("login", dep(*range(50, 69)) + owned("account.command.login", "account.device-errors"), "async handleLoginCommand(providerRef)"),
    ("logout", dep(52, 53, 54, 55, 69, 70) + owned("account.command.logout"), 'showOAuthSelector(mode)'),
    ("new", dep(347), "async handleClearCommand()"),
    ("compact", dep(351) + dep(186), "async handleCompactCommand(customInstructions)"),
    ("resume", dep(*range(24, 32), 348), "showSessionSelector()"),
    ("reload", dep(110, 339, 340, 341), "async handleReloadCommand()"),
    ("quit", added("quit"), "async shutdown(options)"),
]
for number, (name, states, method) in enumerate(BUILTINS, 439):
    entry("builtin:/" + name, states, dep(number), [anchor(IM, method if method.endswith(" {") else method + " {")])

entry("hidden-dispatch:/debug", dep(356), anchors=[anchor(IM, "handleDebugCommand() {")], limit=LIMIT + " Writes a debug log when invoked; not executed.")
entry("hidden-dispatch:/arminsayshi", dep(357), anchors=[anchor(IM, "handleArminSaysHi() {")])
entry("hidden-dispatch:/dementedelves", added("dementedelves"), anchors=[anchor(IM, "handleDementedDelves() {"), anchor(PI + "modes/interactive/components/earendil-announcement.js", "export class EarendilAnnouncementComponent")])

entry("owned:/catalogs", added("palette.entry") + owned("settings.browse", "settings.empty", "settings.source-status", "settings.source-details", "settings.source-toggle", "settings.source-remove", "settings.form.fields", "settings.form.save", "settings.form.cancel", "settings.refresh", "settings.narrow-scroll", "language.effective-state", "language.preview", "language.confirm", "language.reset", "language.conflict-error"), owned("session.slash-owned"), [anchor("packages/cli/src/model-picker.ts", 'const openSettings = async'), anchor("packages/cli/src/main-cli.ts", "runtime: runtimeDiagnostics")])
entry("owned:/about", added("palette.entry") + owned("settings.about", "startup.runtime.identity"), owned("session.slash-owned"), [anchor("packages/cli/src/model-picker.ts", "if (options.runtime)")])
entry("owned:/fast", owned("fast.command"), owned("session.slash-owned"), [anchor("packages/cli/src/fast-mode.ts", 'handler: async (args, ctx)')], "on; off; empty status; invalid argument")
entry("owned:/status", owned("status.available-context", "status.unavailable-context", "status.literal-fallbacks", "status.protected-identities", "status.multiline-layout"), owned("status.command-description"), [anchor("packages/cli/src/presentation.ts", 'handler: async (_args, ctx)')])
entry("owned:/labels", owned("labels.command-status", "labels.persistence-error", "labels.generated-name") + added("labels.identity-controls"), owned("session.slash-owned"), [anchor("packages/cli/src/session-labels.ts", 'handler: async (args, context)')], "on; off; pin; auto; pane pin; pane auto; global on; global off; empty status; usage")
entry("owned:/textguard", owned("textguard.command", "textguard.off-empty", "textguard.queue", "textguard.detail", "textguard.unavailable", "textguard.approval-confirm", "textguard.narrow-cancel"), owned("session.slash-owned"), [anchor("packages/cli/src/textguard-review.ts", 'const requested = MODE_ARGS[argument]')], "on|guarded (same mode); strict; off; reports; empty review; usage")
entry("owned:/scrollback", owned("scrollback.entry-header", "scrollback.busy-guards", "scrollback.message-kinds", "scrollback.special-entries", "scrollback.export-cancel-error", "scrollback.narrow"), owned("session.slash-owned"), [anchor("packages/cli/src/scrollback.ts", 'handler: async (_args, ctx)')])
entry("owned:/voice", owned("voice.command", "voice.devices", "voice.login-errors", "voice.widget-states", "voice.cancel-lifecycle", "voice.insert-result"), owned("session.slash-owned"), [anchor("packages/cli/src/voice/integration.ts", "const command = async (args: string")], "start; stop; cancel; devices; language auto|ja|en|zh; empty toggle; usage")
entry("owned:/subagents", owned("subagents.command-controls", "subagents.native-widget", "workflow.browse", "workflow.run-detail", "workflow.output", "workflow.confirm"), owned("session.slash-owned"), [anchor("packages/cli/src/subagents/integration.ts", 'if (action && action !== "show"')], "show; hide; empty opens runs; usage; non-TUI report")
entry("owned:/workflow", owned("workflow.browse", "workflow.policy-controls", "workflow.role-form", "workflow.role-errors", "workflow.model-choice", "workflow.text-editor", "workflow.task-launch", "workflow.run-detail", "workflow.confirm", "workflow.output", "workflow.narrow", "subagents.command-controls"), owned("session.slash-owned"), [anchor("packages/cli/src/subagents/integration.ts", 'if (!["on", "off", "toggle"].includes(action))')], "on; off; toggle; empty browse; usage; non-TUI report")
entry("owned:/flow", owned("flow.status-report", "flow.status-details", "flow.status-fallback", "flow.toggle", "flow.pause-resume", "flow.retry-cancel-resolve", "flow.clear", "flow.reset-confirm", "flow.command-error", "startup.runtime.identity"), owned("flow.command-description"), [anchor("packages/cli/src/flow-control/flow-status-extension.ts", 'const [verb, target, choice, ...rest]')], "runtime; on; off; details [page]; pause; resume; retry; cancel; resolve; clear; reset [confirm]; empty status; usage")

entry("interception:/model", owned("session.prompt-shortcuts", "models.list", "models.empty", "models.search", "models.compact-confirm", "models.select-busy-error", "models.cancel-busy", "models.refresh", "models.narrow") + dep(41, 42, 354, 355), anchors=[anchor("packages/cli/src/main-cli.ts", "onModelPicker: (query)"), anchor("packages/session-ui/src/prompt-frame.ts", "if (opened) return;")], arguments="empty or arbitrary query; false result restores original input to Pi")
entry("interception:/scoped-models", owned("session.prompt-shortcuts") + added("scoped-guidance") + dep(43, 44), anchors=[anchor("packages/cli/src/model-picker.ts", "handleScopedModelsCommand"), anchor("packages/session-ui/src/prompt-frame.ts", "if (handled) return;")], arguments="exact trimmed /scoped-models; false/caught rejection restores input; hidden from suggestions")
entry("interception:/logout shisa", owned("account.command.logout"), anchors=[anchor("packages/cli/src/shisa-link/extension.ts", 'return { action: "handled" }')], arguments="exact trimmed provider-specific input; builtin /logout has no space-argument branch")

entry("pi-extension:/llama", dep(*range(111, 118)), dep(423), [anchor(PI + "extensions/llama/index.js", "await showLlamaUi(ctx")], "arguments ignored; nested configured-client/manage/download actions")
entry("pi-extension:/mcp", dep(*range(118, 126)), dep(424), [anchor("packages/cli/src/mcp.ts", "return createMcpExtension({")], "login [server]; logout [server]; reconnect [server]; empty manager/status; usage")
entry("release-extension:/schedule-prompt", dep(*range(126, 139), 141, 142), dep(425), [anchor("packages/cli/node_modules/pi-schedule-prompt/src/index.ts", 'ctx.ui.select("Scheduled Prompts"')], "arguments ignored; Jobs and Settings are nested UI choices, not command names")
BG = "packages/cli/node_modules/@vanillagreen/pi-background-tasks/extensions/registrations.ts"
entry("release-extension:/bg", dep(145, 146, 147, 148, 158, 159), dep(426), [anchor(BG, "pi.registerCommand(BG_COMMAND"), anchor("packages/cli/node_modules/@vanillagreen/pi-background-tasks/extensions/constants.ts", 'BG_COMMAND = "bg"')], "list; next; clear; run <command>; watch|log <id-or-pid>; stop <id-or-pid>; empty dashboard; unknown action")
for number, name in enumerate(["list", "next", "clear", "run", "stop"], 427):
    entry("release-extension:/bg:" + name, dep(158, 159) + (dep(145, 146) if name == "list" else []), dep(number), [anchor(BG, 'pi.registerCommand(`${BG_COMMAND}:' + name + '`')], "colon spelling of /bg " + name + "; shares the named action, with alias-specific argument handling")
entry("release-extension:/code-preview-health", dep(206, 207), dep(432), [anchor("packages/cli/node_modules/pi-code-previews/src/commands/health.ts", "new HealthPanel(")])
entry("release-extension:/code-preview-settings", dep(*range(201, 206)), dep(433), [anchor("packages/cli/node_modules/pi-code-previews/src/commands/settings.ts", "createCodePreviewSettingsList({")], "arguments ignored; Appearance/Output/Enabled tools categories are nested states")
entry("release-extension:/tasks", dep(*range(160, 168)), dep(434), [anchor("packages/cli/node_modules/@lhl/pi-tasks/src/index.ts", "function parseAutoArg(")], "auto [on|auto|off|stop|disable|cascade|status|?]; empty auto argument means on; non-auto input opens menu; nested task actions")
ML = "packages/cli/node_modules/pi-multiloop/extensions/pi-multiloop/index.ts"
entry("release-extension:/goal", dep(177, 178, 179, 180, 185), dep(435), [anchor(ML, 'if (/^(?:list|ls|status)?$/i.test(trimmed))')], "list|ls|status|empty; pause|stop|resume [target]; help; clear; tokens; allow-open-tasks; --tokens; objective fallback")
entry("release-extension:/multiloop", dep(*range(172, 177)) + added("multiloop.setup"), dep(436), [anchor(ML, 'trimmed === "guide" || trimmed === "wizard" || trimmed === "setup"')], "resume; stop; pause; list|ls [--archived]; status; archive; rm <id>; guide|wizard|setup; help; empty status/setup; seed fallback")
entry("release-extension:/pi-vcc", dep(186), dep(437), [anchor("packages/cli/node_modules/@sting8k/pi-vcc/src/commands/pi-vcc.ts", "const { followUpPrompt, keepUserTurns }")], "keep/prompt parser; completion notice; nothing to compact; optional follow-up prompt")
entry("release-extension:/pi-vcc-recall", dep(*range(187, 191)), dep(438), [anchor("packages/cli/node_modules/@sting8k/pi-vcc/src/commands/vcc-recall.ts", "const request = parseCommandRequest(args)")], "query; recent; scope:all; page:N; range/expand/drill/touched request forms; result or no-session")

# Fixed shipped names are deliberately asserted here so a new profile/release
# skill cannot silently acquire the generic family through a discovery loop.
for name in ["jouzu-reference", "jouzu-delegation", "jouzu-clear-writing", "jouzu-anti-slop", "jouzu-source-check", "multiloop"]:
    entry("skill:/skill:" + name, added("skills.admission", "skills.expand") + dep(86), owned("session.slash-owned"), [anchor(PI + "modes/interactive/interactive-mode.js", 'const commandName = `skill:${skill.name}`'), anchor(PI + "core/agent-session.js", "async _expandSkillCommand(text)"), anchor(PI + "core/skills.js", "function loadSkillFromFile(")], "optional user arguments, preserved; unknown names pass through; enableSkillCommands gates slash offering only", LIMIT + " Shipped resource candidate; actual installed/admitted resource presence is conditional.")
    entry("skill-alias:$" + name, added("skills.dollar", "skills.expand") + dep(86), owned("session.slash-owned"), [anchor("packages/cli/node_modules/pi-skill-dollar/dist/extension.js", 'return { action: "transform", text: `/skill:${skillName}${args}` }')], "dollar completion and direct-submit alias for /skill:" + name, LIMIT + " Direct transform accepts the name grammar even if the resource is not installed.")
entry("prompt:/jouzu-review", added("prompt.expand"), anchors=[anchor(PI + "core/prompt-templates.js", "export function expandPromptTemplate("), anchor(PI + "modes/interactive/interactive-mode.js", "const templateCommands = this.session.promptTemplates.map")], arguments="optional arguments parsed but shipped template has no argument placeholder; prompt body preserved")
