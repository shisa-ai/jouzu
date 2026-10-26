#!/usr/bin/env python3
"""Read-only dependency UI census; writes only this audit directory, never imports runtime code.

Run from the repository root: python3 review/ja-localization/full-ui-audit/dependencies/build-ledger.py
The family definitions are reviewed source findings, not translation-map discovery.
"""
from pathlib import Path
import csv
import hashlib
import json
import re
import os
from collections import Counter
from source_anchors import resolve_source_anchor

ROOT = Path(__file__).resolve().parents[4]
OUT = Path(__file__).resolve().parent
NM = 'packages/cli/node_modules/'
PI = '@earendil-works/pi-coding-agent'
TUI = '@earendil-works/pi-tui'
BG = '@vanillagreen/pi-background-tasks'
TASK = '@lhl/pi-tasks'
VCC = '@sting8k/pi-vcc'
PRE = 'pi-code-previews'
LOOP = 'pi-multiloop'
SCHED = 'pi-schedule-prompt'
WEB = 'pi-webaio'
COLS = ['surface_id','owner','source_file','source_symbol','entry_point','state','locale_path','source_finding','evidence_level','existing_test','coverage_limit']
rows = []
files = {}
anchor_records = []

def read(path, disposition='source-inspected'):
    path = str(path)
    data = (ROOT/path).read_text(encoding='utf-8')
    if path not in files:
        files[path] = [disposition, 'Read-only source capture; review depth is stated by disposition and surface evidence_level; sha256=' + hashlib.sha256((ROOT/path).read_bytes()).hexdigest()]
    return data

def write_csv(name, fields, items):
    with (OUT/name).open('w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fields, lineterminator='\n')
        w.writeheader()
        w.writerows(items)

def src(owner, rel):
    return NM+owner+'/'+rel

def symbol_line(path, symbol, anchor='', line_no=None):
    return resolve_source_anchor(read(path), symbol, anchor=anchor, line_no=line_no)

def add(owner, rel, symbol, entry, state, finding, route='unadapted', anchor='', test='', limit='', level='reviewed-source-family', line_no=None):
    path = rel if owner == 'Jouzu transform' or rel.startswith(('packages/','scripts/','upstream/')) else src(owner, rel)
    location = symbol_line(path, symbol, anchor=anchor, line_no=line_no)
    surface_id = f'dep-{len(rows)+1:04d}'
    anchor_records.append({'surface_id':surface_id, 'source_file':path, 'source_symbol':symbol, **location})
    line = '['+location['anchor_kind']+'] L'+str(location['line'])
    routes = {
        'unadapted': 'No general locale hook in this dependency path; outside the selected Pi component patches and slash-description adapter.',
        'selected': 'packages/cli/src/pi-ui-localization.ts selected-component render wrapper; source pattern and component-graph membership must match.',
        'slash': 'packages/session-ui/src/prompt-frame.ts ownership-aware slash-description adapter only; command identifier preserved.',
        'preserve': 'Preserve user/model/service/source payload verbatim; translate only separately identified interface framing.',
        'fallback': 'Normally replaced/intercepted by Jouzu Session UI; native fallback remains when interception cannot open.',
        'conditional': 'Conditional dependency route; startup reachability/rendering not established in this audit.',
        'transform': 'Jouzu build transform emits dependency UI text; no locale parameter at the emitted callsite.',
    }
    rows.append(dict(zip(COLS,[surface_id,owner,path,symbol+' '+line,entry,state,routes.get(route,route),finding,level,test or 'No locale-specific runtime test established by this audit.',limit or 'Source evidence only; no terminal render or runtime action executed in this audit.'])))

FAMILY_TEST = 'packages/cli/test/runtime-localization.test.mjs (selected component fixtures; not exhaustive real startup)'
START_TEST = 'packages/cli/test/localization-startup-audit.test.mjs; review/ja-localization/translation-drafts/STARTUP-AUDIT.md (prior bounded observations only)'
BEHAVIOR = 'packages/cli/test/release-extension-behavior.test.mjs (workflow tests, not Japanese panel coverage)'

# Explicit source state families. Multiple rows may share a component, never count rows as strings/screens.
def family(owner, rel, symbol, entry, states, route='unadapted', test='', limit=''):
    for state, finding in states:
        add(owner,rel,symbol,entry,state,finding,route,test=test,limit=limit)

family(PI,'dist/modes/interactive/components/settings-selector.js','SettingsSelectorComponent','/settings',[
 ('root/navigation/filter/cancel','Search-enabled SettingsList; arrows wrap, Enter/space cycles values or opens submenu, Esc exits. Labels and descriptions are adapted only during render; backing English data is not itself an English-screen finding.'),
 ('image-capability-dependent','Show images and Image width inserted only when getCapabilities().images is supported; auto-resize/block image fields remain available without it.'),
 ('warning-submenu','Warnings opens WarningSettingsSubmenu with Anthropic extra usage boolean, immediate callback, Esc returns.'),
 ('model-thinking-step-1-empty','No models available / Log in to a provider or configure an API key first is a selectable __none__ item; step prefix is composed by SteppedSubmenu.'),
 ('model-thinking-step-1-populated','Configured model identifiers/providers sorted with current/default first; overrides shown as technical levels. Searchable list, selection opens level step.'),
 ('model-thinking-step-2-reasoning','Reasoning model uses getSupportedThinkingLevels, non-reasoning model only off; current checkmark, optional clear override, loop returns to model step.'),
 ('theme-single/preview/cancel','ThemeSubmenu previews single theme/automatic mode on selection movement; cancel restores original theme setting.'),
 ('theme-automatic/light/dark/apply','Automatic Theme has Light theme, Dark theme, Apply and Change mode; light/dark select submenus preview, apply saves, Esc restores original.'),
 ('display-values-not-translated','Wrapper changes labels/descriptions, not currentValue/values. Human values configure, none, N configured, Ask/Always trust/Never trust, save and go back, switch to single theme remain source English. Boolean and protocol/setting tokens are a separate display-policy question, not payload corruption.'),
], 'selected', FAMILY_TEST)
family(PI,'dist/modes/interactive/components/settings-submenu.js','SteppedSubmenu','/settings -> model-thinking',[
 ('composed-step-prefix','buildStep prepends Step 1/2 · or Step 2/2 · to description. Exact standalone description matching cannot match the composed text; prior startup audit observed mixed English step 1.'),
 ('step-cancel/back/complete','Esc at later step removes that step key and goes back; Esc at first step cancels; loop=true resets after completion. No additional cancellation toast.'),
], 'selected', START_TEST)
family(PI,'dist/modes/interactive/components/settings-submenu.js','SelectSubmenu','settings/theme/model submenus',[
 ('search/no-match','Optional Input filters English backing labels/descriptions; a new SelectList is built. Empty list uses shared No matching commands wording; ownership marking happens during selected parent render.'),
 ('hint/narrow','Type to filter · Enter to select · Esc to go back versus Enter to select · Esc to go back; select descriptions omitted by generic list at narrow width.'),
], 'selected', FAMILY_TEST)
family(TUI,'dist/components/settings-list.js','SettingsList','Pi settings and extension SettingsList panels',[
 ('empty/no-match','No settings available and No matching settings are shared widget literals; only lists marked owned by the Pi wrapper receive translated hints.'),
 ('search/scroll/narrow','Search is optional; values are width-truncated after fixed label alignment, selected description wraps, scroll position is numeric.'),
 ('submenu/cancel/change','Enter/space activates or cycles; submenu callback updates currentValue only when supplied, Esc calls onCancel. Extension-owned lists are not automatically Pi-owned.'),
], 'selected', FAMILY_TEST)
family(TUI,'dist/components/select-list.js','SelectList','autocomplete and SelectSubmenu users',[
 ('empty','No matching commands is shared fallback even for model/theme lists. Pi adapter rewrites it only on owned SelectLists.'),
 ('narrow/description-hidden','renderItem uses descriptions only at width > 40 and sufficient remaining description width. Labels/technical values still display; a wide fixture is not narrow proof.'),
 ('filter/navigation/cancel','Prefix filtering, wrapped up/down, page/selection callbacks and cancel; row contents belong to supplying command/provider/extension.'),
], 'selected', FAMILY_TEST)
family(PI,'dist/modes/interactive/components/thinking-selector.js','ThinkingSelectorComponent','/thinking; cycle-thinking shortcut',[
 ('levels/current/default/save','Thinking Level, in-session cycle hint, level descriptions and optional default suffix use selected wrapper; level IDs remain off/minimal/low/medium/high/xhigh/max.'),
 ('filter/no-match/cancel','Fuzzy filters levels and descriptions; Enter selects session level, save shortcut persists default, Esc cancels.'),
], 'selected', FAMILY_TEST)
family(PI,'dist/modes/interactive/components/theme-selector.js','ThemeSelectorComponent','native ThemeSelectorComponent API',[
 ('current/preview/select/cancel','Theme identifiers/current descriptions; selection previews theme and cancel callback restores externally. Component is patched but active /settings uses ThemeSubmenu instead; do not claim a separate reachable command.'),
], 'selected', FAMILY_TEST)
family(PI,'dist/modes/interactive/components/show-images-selector.js','ShowImagesSelectorComponent','native image selector API',[
 ('yes/no/cancel','Yes/No with Show images inline in terminal / Show text placeholder instead. Component is patched but /settings uses boolean setting, so independent launch reachability is not established.'),
], 'selected', FAMILY_TEST)
family(PI,'dist/modes/interactive/components/session-selector.js','SessionSelectorComponent','/resume; startup session picker',[
 ('current/all/loading/progress','Current/all asynchronous loaders with abort, Loading current/total progress and scope markers. Wrapper rewrites header left title only; right-side Current Folder/All/Loading/sort/name labels remain native.'),
 ('sort/name/path/search','Threaded/Recent/Fuzzy; Name All/Named; path on/off, regex and quoted phrase hints. Header builds strings in render, not traversed Text nodes.'),
 ('empty-folder/empty-all/no-match','Empty current folder suggests Tab to view all; empty all and unmatched filters use distinct messages. These list-render strings are outside the header-title-only rewrite.'),
 ('rename/save/cancel/error','Rename Session title adapted; save/cancel hint and failed rename status not generally adapted. Enter persists trimmed nonempty name; cancel returns to base layout.'),
 ('delete-confirm/cancel/current-protection','Delete confirmation changes hints, second delete confirms; cancel aborts, active session cannot be deleted. Trash success, unlink fallback, delete failure status are native English.'),
 ('load-error/cancel/dispose','Failed to load sessions message; AbortController per scope, cancels on exit/dispose. Error details preserve filesystem/source error.'),
 ('narrow','Header fits right-hand sort/scope strings and truncated left title; list rows truncate user session title/path, numeric age/count remain data.'),
], 'selected', FAMILY_TEST)
family(PI,'dist/modes/interactive/components/session-selector-search.js','parseSearchQuery','/resume search',[
 ('empty-regex/invalid-regex','Empty regex is Pi-authored; invalid regular-expression error comes from JavaScript. Query, session names and message text are user/source content, not translation candidates.'),
], 'unadapted')
family(PI,'dist/modes/interactive/components/tree-selector.js','TreeSelectorComponent','/tree; double-Esc when configured',[
 ('root/search/filters','Session Tree and Type to search adapted. Tree list and dynamic hint component render directly, leaving filters and navigation/copy/label/branch hint words outside Text translation.'),
 ('empty/no-match','No entries found (0/0) comes directly from TreeList.render, not adapted by tree search/label wrappers.'),
 ('entry-kind-labels','user:, assistant:, aborted/no content, compaction token label, branch summary/model/thinking/custom/context omit/replace/label/title labels are Pi framing, not payload. TreeList dynamic row render is unadapted.'),
 ('fold/unfold/current/label-time','Fold markers, active path/current leaf, label-time toggle [+label time], branch paging and filter cycle. User labels/timestamps are data; status labels are interface.'),
 ('label/edit/remove/cancel','Label (empty to remove): is specifically adapted on labelInput render; current user label must remain exact. Enter confirms, Esc returns without change.'),
 ('narrow/hint-priority','Hints choose full/short forms based on width; content and branch geometry truncated independently. Render narrow variants, not only title.'),
], 'selected', FAMILY_TEST)
family(PI,'dist/modes/interactive/components/user-message-selector.js','UserMessageSelectorComponent','/fork',[
 ('empty','No user messages found specifically rewritten only when message list is empty.'),
 ('rows/position/preserve','Fork from Message and description adapted; per-row Message N of total rewritten on known row index. User message text is preserved even if identical to interface words.'),
 ('selection/cancel/narrow','Up/down selects, Enter forks, cancel callback exits; multi-line user text and scroll position width-constrained.'),
], 'selected', FAMILY_TEST)
family(PI,'dist/modes/interactive/components/model-selector.js','ModelSelectorComponent','native /model fallback',[
 ('refresh/cached/success/error','Refreshing model catalogs…, refreshed success, timeout and provider-count refresh failure; configured-provider warning, all/scoped modes, default save.'),
 ('empty/search/default/narrow/cancel','No matching models; Model Name; save default / select / cancel. Model IDs and provider names preserved; native labels are unadapted.'),
], 'fallback', 'packages/session-ui/test/prompt-frame.test.mjs (routing and fallback); no native Japanese panel proof')
family(PI,'dist/modes/interactive/components/scoped-models-selector.js','ScopedModelsSelectorComponent','manual /scoped-models fallback',[
 ('enabled/disabled/unavailable','Model Configuration; Session-only save hint; all enabled, [unavailable], Model unavailable, footer counts. Jouzu hides slash suggestion and intercepts exact submission; native route remains fallback.'),
 ('search/refresh/reorder/save/cancel','No matching models, refresh status supplied by InteractiveMode; enable/toggle/order/save configured bindings and Esc. Technical model IDs are not UI translation.'),
], 'fallback', 'packages/session-ui/test/prompt-frame.test.mjs (interception, not rendered native panel)')
family(PI,'dist/modes/interactive/components/trust-selector.js','TrustSelectorComponent','/trust; project trust decisions',[
 ('saved-none/local/inherited','Project trust title; saved trusted/untrusted/inherited/none and current trusted/untrusted; wrapper loads prototype by dynamic import and skips cwd Text deliberately.'),
 ('session/parent/save/cancel','Trust, Trust parent path, Trust for this session and negative decisions with current markers. Navigate/save/cancel hint pattern handled separately.'),
], 'selected', FAMILY_TEST)
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.showTreeSelector','/tree -> select another entry',[
 ('summary-choice','Summarize branch? No summary / Summarize / Summarize with custom prompt are generic ExtensionSelector strings, outside tree-specific wrapper.'),
 ('custom-summary-editor/back','Custom summarization instructions editor; cancelling editor returns to choice, cancelling choice reopens tree at same selection.'),
 ('busy/summary-running/abort/navigation','Wait for current compaction/navigation error; streaming abort, summarization spinner; abort restores tree; navigation cancelled/success notices.'),
])
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.showLoginAuthTypeSelector','/login',[
 ('root-auth-methods','Select authentication method: / for provider, Sign in with an account, Sign in with an API key, Sign in with Radius. Generic/animated extension selector, not OAuthSelector; no locale wrapper.'),
 ('no-methods/single-method','No login methods available.; single available method bypasses selector. Provider-specific loginLabel may be Pi/provider-authored, not remote service content by default.'),
])
family(PI,'dist/modes/interactive/components/oauth-selector.js','OAuthSelectorComponent','/login -> provider; /logout',[
 ('title/status-basic','Login/logout title and terminal configured/not configured suffix are selected-wrapper targets. Runtime proof still needed for active root-to-provider route.'),
 ('status-type-mismatch/env','API key/account/subscription badges, mismatched auth-type configured suffix and env: SOURCE are composed. Basic suffix replacement does not translate type badges or env prefix. Environment variable names and provider names are preserved.'),
 ('empty/no-match','No providers available / No providers logged in. Use /login first. / No matching providers are not in the adapter OAuth status matcher.'),
 ('filter/selection/cancel/narrow','Fuzzy provider search includes provider id/auth type/method name; 8 visible rows and numeric position; TruncatedText at narrow width. Cancel may return to auth-method root.'),
], 'selected', FAMILY_TEST)
family(PI,'dist/modes/interactive/components/login-dialog.js','LoginDialogComponent','provider authentication dialog',[
 ('login-title/unwrapped','Login to provider is a matching template in buildTextTranslator, but LoginDialogComponent is not installed as a patched selector and is not inside OAuthSelector after selection. A key alone does not establish localization.'),
 ('auth-url/instructions','Auth URL plus optional instructions, opens browser. URLs are exact; instructions require provenance: Pi-authored provider code is UI, truly remote service text is preserved.'),
 ('device-code/wait','Verification URL, Ctrl+click/Cmd+click to open, Enter code: CODE; host Waiting for authentication...; code/URL preserved, framing unadapted.'),
 ('prompt/manual-code/placeholder','Prompt text plus e.g., placeholder and to cancel/to submit key hints. Placeholder parameter of ExtensionInput is ignored elsewhere, but LoginDialog explicitly renders it.'),
 ('info/details/close','showDetails and showInfo render provider/setup information and links; optional to close hint; ambient external authentication explanation supplied by host.'),
 ('cancel/submit/progress','Esc aborts signal/rejects Login cancelled and restores prior selector; submitted input replaced with > value; progress/wait messages appended. User-entered credential value must not be translated or recopied into audit evidence.'),
], 'unadapted')
family(PI,'dist/modes/interactive/components/auth-url.js','AuthUrlComponent','LoginDialog.showAuth; MCP auth URL',[
 ('click/copy/success/error','Ctrl+click or Cmd+click to open; key hint to copy; Copied URL to clipboard; error text from clipboard source. URLs remain exact.'),
])
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.completeProviderAuthentication','login success/failure',[
 ('stored/selected/no-default','Logged in / Saved API key, Credentials saved to path, selected model; no default, missing default, no models and selection failure guidance. Auth path and model IDs preserved.'),
 ('refresh/timeout/failure','Authenticated but refresh timed out/could not refresh, cached catalog fallback; state can complete before async refresh and must not overwrite switched session/model.'),
])
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.showApiKeyLoginDialog','/login API key/ambient/Radius',[
 ('bedrock-details','You can also use an AWS profile, IAM keys, or role-based credentials. See: provider docs path. This is Pi source-authored guidance, not service payload.'),
 ('ambient-setup','Provider setup / Authentication is configured outside APP_NAME. shown with close hint; provider identity and method name preserved.'),
 ('credential-synchronization-error','Saved credentials but local model state could not be synchronized distinguished from failed save/login. Error cause is source content, wrapper is interface.'),
 ('radius-mcp-offer','Configure provider MCP in path? Yes/No, save failure; generic selector and reload, not OAuth component wrapper.'),
])
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.showOAuthSelector','/logout',[
 ('empty/storage-error','No stored credentials to remove; /logout affects only /login credentials, not env/models.json. Could not read stored credentials error.'),
 ('removed/logout/sync-error','Logged out versus Removed stored API key; credential removed but local synchronization failed versus Logout failed. Source errors preserved separately.'),
])
family(PI,'dist/modes/interactive/components/extension-selector.js','ExtensionSelectorComponent','ctx.ui.select/confirm; Pi command dialogs',[
 ('options/description/cancel/timeout','Title, optional description and caller labels rendered verbatim. Timeout adds (Ns), auto-cancels; Escape/Ctrl+C cancel. No general locale translation for caller text.'),
])
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.showExtensionConfirm','ctx.ui.confirm; schedule confirmations',[
 ('yes/no','showExtensionConfirm supplies Yes/No labels to generic selector and combines title/message. Unadapted shared English affects extensions even when caller title is translated.'),
])
family(PI,'dist/modes/interactive/components/extension-input.js','ExtensionInputComponent','ctx.ui.input; command flows',[
 ('title/description/timeout/placeholder','Title/optional description; (Ns) timeout; constructor _placeholder unused, so a source placeholder is not proof it is painted. Enter submit, Escape cancel.'),
])
family(PI,'dist/modes/interactive/components/extension-editor.js','ExtensionEditorComponent','ctx.ui.editor; bug report/custom summary',[
 ('submit/cancel/external-editor','submit / newline / cancel / external editor key hints plus caller title/prefill. editInExternalEditor returns failed without rendering a nonzero-exit error here; do not invent an error dialog. User instructions/draft are data; hint/framing unadapted.'),
])
family(PI,'dist/modes/interactive/components/status-indicator.js','RetryStatusIndicator','agent retry; compaction retry',[
 ('retry/countdown/cancel','Retrying (attempt/max) in Ns... (key to cancel), interval countdown. Session UI can replace working indicator but this status class is not a selected-localization target.'),
])
family(PI,'dist/modes/interactive/components/status-indicator.js','CompactionStatusIndicator','manual/threshold/overflow compaction',[
 ('manual/auto/overflow','Compacting context... versus Auto-compacting... and Context overflow detected, prefix; cancellation key hint. English source UI, not model summary.'),
])
family(PI,'dist/modes/interactive/components/status-indicator.js','BranchSummaryStatusIndicator','/tree summarize',[
 ('running/cancel','Summarizing branch... (key to cancel). Native spinner/status implementation; rendering on Jouzu border route needs deterministic probe.'),
])
family(PI,'dist/modes/interactive/components/assistant-message.js','AssistantMessageComponent','assistant transcript',[
 ('normal/thinking','Assistant text and reasoning Markdown are model content: preserve. Hidden Thinking... label is interface; Jouzu can supply a custom hidden label via UI context.'),
 ('truncated/aborted/error','Response was truncated before completion.; Operation aborted fallback; Error: cause and Unknown error. Custom errorMessage preserved, not automatically a translation omission.'),
])
family(PI,'dist/modes/interactive/components/tool-execution.js','ToolExecutionComponent','all tools, custom-renderer fallback',[
 ('call/result/no-renderer','Fallback call uses tool name/arguments, result uses returned text. Preserve identifiers/JSON/result source content. Renderer can override result shell and output.'),
 ('collapsed/expanded/partial/images','... N more lines, key to expand fallback; partial execution/running/result update; images via Image component. Shared interface hints remain native, code previews often replace tool-specific views.'),
])
family(PI,'dist/modes/interactive/components/bash-execution.js','BashExecutionComponent','! and !! user shell',[
 ('running/cancel','Running... (key to cancel); command text preserved.'),
 ('complete/exit/cancel/truncated','Collapsed hidden-line count, to expand/to collapse, exit code, cancelled status, Output truncated. Full output: path. Shell stdout/stderr is source content, wrappers interface.'),
])
for rel,sym,entry,states in [
 ('compaction-summary-message','CompactionSummaryMessageComponent','compaction transcript',[('collapsed/expanded','[compaction], Compacted from N tokens and to expand are interface; summary body is model content.')]),
 ('branch-summary-message','BranchSummaryMessageComponent','branch summary transcript',[('collapsed/expanded','[branch], Branch Summary / Branch summary (key to expand) interface; summary body preserved.')]),
 ('skill-invocation-message','SkillInvocationMessageComponent','/skill:name invocation',[('collapsed/expanded','[skill] plus to expand interface; skill name/path/instructions are resource content, preserve.')]),
 ('custom-message','CustomMessageComponent','extension sendMessage display:true',[('custom/fallback','Registered custom renderer first; fallback [customType] and Markdown message content. Caller owns payload; do not globally translate exact English-like user text.')]),
 ('custom-entry','CustomEntryComponent','custom session entry renderer',[('renderer-failure','[customType] renderer failed: cause is interface prefix plus source error; custom renderer may be absent/return empty.')]),
 ('user-message','UserMessageComponent','user transcript',[('normal/images','User Markdown and attachments preserved. No interface translation should alter user text that matches UI words.')]),
]: family(PI,'dist/modes/interactive/components/'+rel+'.js',sym,entry,states)
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.handleSessionCommand','/session',[
 ('empty/in-memory/basic-stats','Session Info, Name/File/ID, In-memory, Messages/Total/User/Assistant/Tools calls/results, Tokens/Input/Output/Total are native UI labels.'),
 ('cache/cost/provider-breakdown','Cached/Uncached/written to cache, Cache Warming Mode/Status/unavailable, economics, Cost, Cache Re-billed/misses and tokens. Values/provider-model attribution preserved.'),
])
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.updatePendingMessagesDisplay','streaming/compaction queued input',[
 ('steering/follow-up/edit','Steering: message / Follow-up: message; key to edit all queued messages. User message contents must remain exact; prefixes/hints native English.'),
])
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.addCacheMissNotice','provider/cache notices',[
 ('cache-miss/model-switch/idle','Cache miss / after model switch / after Nm idle, tokens re-billed/cost. Interface notices not model prose.'),
 ('compaction-cost/thinking-dropped','Compaction or Branch summary tokens billed and Anthropic dropped N thinking blocks (details in session); provider diagnostics are model-dependent UI routes.'),
])
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.handleHotkeysCommand','/hotkeys',[
 ('navigation/editing/other/extensions','Keyboard Shortcuts, Markdown section/table/action labels and extension shortcut descriptions built directly. Key bindings are protected technical tokens; actions are UI wording.'),
])
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.handleChangelogCommand','/changelog',[
 ('nonempty/empty','What\'s New title and No changelog entries found fallback; versioned changelog body is source-owned prose, not live interface labels.'),
])
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.handleImportCommand','/import path.jsonl',[
 ('usage/confirm/missing-cwd/cancel/success/error','Usage notice; Import session / Replace current session with path? confirmation; missing cwd choice and retry, Import cancelled / Session imported from path / Failed to import session. No import executed.'),
])
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.handleNameCommand','/name',[
 ('show/usage/normalize/set','Session display name retrieval, Usage: /name <name>, normalized-from/to warning and Session name set. Name is user content.'),
])
family(PI,'dist/modes/interactive/session-share.js','shareSession','/share',[
 ('auth-missing/tool-missing','Radius authentication not configured / gh not installed / gh not logged in, export error; paths/commands/URLs protected.'),
 ('radius/gist/progress/cancel/success/error','Uploading to Radius... or Creating gist..., Share cancelled, Share URL/Gist labels, upload/create/parse failure. Returned service URL/error body preserved, interface prefix unadapted.'),
])
family(PI,'dist/modes/interactive/bug-report.js','reportBug','/bug',[
 ('intro/inputs/optional-fields','Jouzu transform replaces bug flow with local public-issue draft. Report a Jouzu bug, Expected behavior, Actual behavior, Steps to reproduce inputs; optional missing fields become Not provided.'),
 ('review/body/title/cancel','Review report body/editor and issue title; cancel before draft versus cancel after visible draft keeps draft. Labels and review warnings are source UI.'),
 ('gh-missing/unauthenticated/draft-ready','No submission offered; reason and Draft ready; nothing was posted. New-issue link remains visible. Stub gh detection for deterministic audit, no account operations.'),
 ('public-confirm/decline','Submit this public issue? / No, keep the draft / Submit as ACCOUNT using gh; public repository warning. Account/repository/title/body are data; explicit consent path not exercised.'),
 ('success/uncertain-submission','Issue created URL; uncertain failure tells user to check issue list before retrying, retains draft. Treat uncertain result as separate state; never submit in localization probe.'),
], 'transform', 'scripts/pi-bug-report.test.mjs (functional/local stub and 48-column routing, not Japanese localization)')
family(PI,'dist/modes/interactive/external-editor.js','editInExternalEditor','external-editor shortcut; editor dialog',[
 ('launch/exit/error','Launching external editor: command / Pi will resume when the editor exits.; result complete/nonzero error. Command and edited user text preserved.'),
])
family(PI,'dist/modes/interactive/components/first-time-setup.js','FirstTimeSetupComponent','Pi startup if settings missing',[
 ('theme/telemetry/skip','Welcome/Pick a theme, System/Dark/Light, anonymous usage sharing explanation/options, continue/finish/skip setup. cli/startup-ui.js requires official package/app/config identity, PI_EXPERIMENTAL=1, default agent dir and absent settings. This is not a normal Jouzu startup claim; evaluate the complete predicate before probing.'),
], 'conditional')
family(PI,'dist/modes/interactive/components/config-selector.js','ConfigSelectorComponent','Pi config subcommand, not interactive slash registry',[
 ('global/project/inherit/empty','Global Resources/Project Local Resources, Built-in/User/Project group labels, inherited global/project load/unload, No resources found; prefix configuration states. Jouzu package command interception means normal launcher exposure is not established.'),
], 'conditional')
family(PI,'dist/modes/interactive/components/footer.js','FooterComponent','native footer fallback',[
 ('model/context/git/status','Jouzu normally installs its own footer; native footer fields/statuses are fallback. Do not duplicate Jouzu-owned status bar audit or infer native footer is active.'),
], 'fallback')
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.showLoadedResources','startup/reload resource disclosure',[
 ('context/skills/prompts/extensions/themes/diagnostics','Pi builds resource source labels, trust-ignored resources and warning/error diagnostics; user paths and resource descriptions preserved. Normal startup disclosure suppressed/replaced in Jouzu; /reload may still expose host output.'),
], 'conditional')
family(PI,'dist/extensions/llama/index.js','llamaExtension','/llama',[
 ('unconfigured/noninteractive/unavailable','Configure llama.cpp with /login llama.cpp; interactive-only notice; server connection Retry/Close. Native built-in extension is active, unlike codemode override.'),
 ('load/unload/replace/confirm','Loaded models choice Unload all and load / Keep loaded and load, restoring models, Load started/Loaded/Unloaded, unload confirmation.'),
 ('download/details/gated/quantization','Loading model details, manual approval or access terms and HF_TOKEN guidance, Continue/Back, quantization selection, download progress and completion. Server/model IDs and remote card prose preserved.'),
 ('cancel/error','Stop loading? / Stop download? confirmation, abort operation, network normalized error versus source action error.'),
])
family(PI,'dist/extensions/llama/ui.js','LlamaView','/llama custom panel',[
 ('list/loading/details','llama.cpp models, Loading…, download model row and context/status metadata; keyboard footer load/unload/download/close.'),
 ('search/loading/empty/error','Download model search needs 2 characters; Searching Hugging Face…, No GGUF models found; fetched model IDs/download counts remain data.'),
 ('progress/narrow/cancel','Progress bar ratio/message/detail, terminal width constraints, back/select/cancel; native custom component not selected Pi locale wrapper.'),
])
family(PI,'dist/extensions/mcp/index.js','createMcpExtension','/mcp; /mcp login/logout/reconnect',[
 ('root/loading/empty/errors','Jouzu deferred MCP factory calls this native implementation. MCP servers title; no config instructions, config/override warnings and server state connected/needs sign-in/failed/disconnected.'),
 ('server-actions/enabled/disabled/project','Enable/Enable in this project, Sign in, Tools, Reconnect, Sign out, Exposure, Disable/Disable in this project; session/config/global/project scope and persistence explanations.'),
 ('tools/empty/exposure','Tools of SERVER; no tools; Exposure of SERVER and direct/deferred/codemode/hidden explanations. Tool descriptions from service/schema are payload; built-in framing remains English.'),
 ('auth/contact/browser/manual/cancel','Contacting authorization server…, approve browser, fallback redirected URL input, Sign-in cancelled/failed, signed in but reconnect failed. Never perform login for audit.'),
 ('command-usage/no-match/noninteractive','Usage notice, no named server, no enabled OAuth server, interactive requirement, no reconnect candidates, signed out/no credentials, reconnect result.'),
 ('startup/attention/deferred','MCP failed to load; servers still connecting; need attention run /mcp; deferred tool-search exposure. Source errors and server names preserved.'),
])
family(PI,'dist/extensions/mcp/ui.js','McpManagerView','/mcp manager',[
 ('menus/empty/details/error/back','Menu title/details/error text and confirm/cancel labels supplied by index.js; Nothing to show fallback. Custom SelectList not automatically owned by Pi adapter.'),
 ('signin/progress/cancel','Status frame and browser/manual-URL approval form; submit/cancel hint, signal abort; native auth panel is outside selected-component wrapper.'),
])

# Third-party scheduled prompt panels.
family(SCHED,'src/index.ts','default','/schedule-prompt',[
 ('root/select/cancel','Scheduled Prompts -> Jobs / Settings; cancel returns silently. Generic select labels are source English; slash description localization does not cover panel.'),
 ('settings/visibility/scope/back','Widget visibility shown/hidden; Bind new jobs to session yes/no; Back; toggles persist, failure warning says session only; no success toast.'),
 ('scheduled-message/inline/subagent-start/done/error','Scheduled / finished / failed and subagent badge, Unknown fallback; prompt/job/model/output/error values are source data, not missing interface translation.'),
], test=BEHAVIOR)
family(SCHED,'src/ui/add-flow.ts','runAddFlow','/schedule-prompt -> Jobs -> a',[
 ('name/duplicate/cancel','Job Name input and duplicate-name error. Placeholder passed to ctx.ui.input is ignored by native ExtensionInputComponent, so distinguish caller text from rendered text.'),
 ('type/cron/once/interval','Job Type offers Cron (recurring), Once (one-shot), Interval (periodic); selection controls validation/parser.'),
 ('schedule/invalid/retry/cancel','Schedule input, cron field count/syntax, invalid interval/timestamp/past/too soon errors supplied as replacement placeholder. Native input currently does not paint placeholder, so validation feedback visibility uncertain, not proven translated.'),
 ('prompt/scope/default-order','Prompt input; Scope session-bound vs Shared every pi in cwd warning; default scope listed first, cancel silent. Prompt/name are user content.'),
 ('confirm/decline/create','Confirm Save NAME? Schedule/Scope/Prompt summary; generic Yes/No; false/cancel saves nothing; created notification. Cron humanization is English source helper.'),
])
family(SCHED,'src/ui/jobs-view.ts','JobsView','/schedule-prompt -> Jobs',[
 ('empty','No scheduled prompts. Press a to add one or q to quit; Jobs a add/q quit header.'),
 ('populated/running/error/disabled/foreign','Own enabled/running/error/disabled status icons, shared tag; Other sessions (read-only), actions ignore foreign jobs.'),
 ('selected/details','Selected name/id, Type/Next/Last/Runs/Prompt footer; user names/prompts exact, schedules/ISO timestamps data.'),
 ('remove/cleanup-confirm/cancel','Remove NAME? (y/n) and Remove N disabled job(s) in this session?; y commits, n/Esc cancels; no confirmation when zero disabled.'),
 ('narrow/long-data','Fixed name/schedule/prompt character columns and full-width rule. Header/details not globally width-clamped; measure long/CJK data at narrow terminal.'),
])
family(SCHED,'src/ui/cron-widget.ts','CronWidget','session_start; cron:change',[
 ('hidden/empty','Hidden when disabled or no loaded jobs; foreign jobs excluded. Jouzu consolidated dashboard claims other source widgets, but this below-editor scheduler widget must be checked independently.'),
 ('nonempty/time/model-badge','Scheduled Prompts (N jobs), in Xm / Xm ago / never, human schedule, status icons/model notify badge. User prompt/name/model preserved.'),
])
family(SCHED,'src/scheduler.ts','CronScheduler','schedule validation and status formatting',[
 ('cron/once/interval-errors','Six cron fields example; invalid cron; interval format; timestamp invalid/past/too soon. Errors consumed by tool and add-flow placeholder; library exception text preserved separately.'),
 ('humanized/time','every second/minute/hour, weekday/time descriptions, every interval and ISO short month string. Interface formatting, not developer-only console output.'),
])
family(SCHED,'src/tool.ts','createCronTool','schedule_prompt tool transcript',[
 ('call/add/list/remove/update/enable/disable','Adding/Removing/Updating/Listing cron jobs labels, created/removed/enabled/disabled summaries, configured list Type/Schedule/Model/Prompt/Last run/Runs.'),
 ('empty/error/cleanup','No cron jobs configured; No disabled jobs to clean up; missing parameters/duplicate/job not found/invalid model/unknown action errors. Returned Error wrapper is interface; prompt/output data preserved.'),
])
# Background task menus and result framing.
family(BG,'extensions/dashboard.ts','openDashboard','/bg; /bg watch id; dashboard shortcut',[
 ('empty/noninteractive','No background tasks yet use /bg run command or bg_task; no UI fallback notifies plain formatted list.'),
 ('tasks/output/follow/scroll','Tasks / Watch panes, running/finished totals, earlier/more tasks, Select a task to inspect output, follow/top/line, status/start/expiry/command/cwd/log/wakeups fields.'),
 ('command-expand/narrow','x expand/collapse command, left/right/tab pane navigation, paging output, follow toggle; width-responsive detail layout and wrapped footer.'),
 ('stop/clear/cancel','s stops selected running task immediately via requestStop; c clears finished, no confirmation implemented; Esc/Ctrl+C closes. Do not invent a confirmation state.'),
])
family(BG,'extensions/render.ts','renderBgToolResult','bg_task/bg_status transcript',[
 ('pending/spawn/log/stop/clear','starting/tailing/stopping/clearing/checking labels; started id/pid, log count and expansion hints; stop result, removed-finished count.'),
 ('list/ack/empty/error','list intentionally renders empty; acknowledge Background results · No reply needed; task absent fallback, Background task failed and no output yet.'),
 ('expanded/details/truncation','Status/Title/Command/Cwd/Log/Timeout/Wakeups details, older-line omission/full log notice. Command/stdout/log paths are source content; labels/notices interface.'),
 ('event-output/exit','Background task finished/output labels, matched Pattern, Recent output and full background log; collapsed ctrl+o hint and expanded output. Flow-host delivery may replace native event route.'),
])
family(BG,'extensions/completion-render.ts','renderCompletionBatch','native completion batch display',[
 ('collapsed/expanded/omitted','Background tasks N finished; completed/failed/timed out/stopped counts, time range, task/log rows, more-results hint. Native batch versus Jouzu flow result renderer must be exercised separately.'),
])
family(BG,'extensions/background-tasks.ts','backgroundTasks','startup/tool lifecycle/widget',[
 ('widget/compact/expanded/hidden','Background tasks N running/N finished, toggle/dashboard shortcut hints, rows with status/relative time and more count. Jouzu dashboard can claim widget visibility; fallback remains.'),
 ('forced/automatic-background-notice','Next bash/not-yet-started bash armed with finite window; auto-backgrounded bash/user bash moved id/pid notices. Source-authored UI, not model text.'),
 ('state/stop/error','Persistence warning includes where/cause, completion delivery failed warning, stop errors, already terminal/flushing distinction.'),
])
family(BG,'extensions/format.ts','summarizeTaskStatus','background lists/panels/results',[
 ('statuses/time/truncation','completed/failed exit code/timed out/stopped, termination reason; now/just now/from now/ago; log truncated showing last chars/full log. IDs/exit codes/commands and log data preserved.'),
])
family(BG,'extensions/registrations.ts','registerAll','/bg and bg:* aliases; bg tools',[
 ('argument-completion','list/next/run/log/watch/stop/clear action descriptions and id completion status · command are unadapted argument completions; slash root description rewrite is not recursive.'),
 ('invalid/missing-id/clear/spawn','Unknown /bg action / Usage / no matched task, removed finished task count and spawn notification; command aliases registered independently.'),
])
# Tasks menu.
family(TASK,'src/index.ts','default','/tasks',[
 ('root/count-dependent/cancel','View all tasks N, Create task, Start/Stop auto mode, Clear completed N, Clear all N and Settings; items depend on tasks/mode; cancel returns.'),
 ('list/empty/back','No tasks -> Back, otherwise status-icon [status] subject rows and Back. Subject/description data must remain exact.'),
 ('task-detail/actions','Per-task title/status/description; Start, Mark complete, Delete and Back based on current state. State changes mutate store; no destructive confirmation implemented.'),
 ('create/subject/description/cancel','Task subject and Task description input; cancelling/empty subject or description aborts creation and returns to main menu; entered subject and description preserved.'),
 ('auto-command/usage/status','/tasks auto [on|off|cascade|status], invalid usage, enabled/disabled/cascade/status notices and scheduling outcome.'),
 ('auto-idle-decision/stop/cancel','Task still in progress: Mark complete / Continue (re-queue) / Stop auto mode; cancel stops auto mode. Model-driven continuation prompt is separate content.'),
 ('corrupt-store/finished/stale/error','Could not read store warning/in-memory recovery; auto-mode finished, marked complete, stale continuation skipped, scheduling/no-progress failure.'),
], test=BEHAVIOR)
family(TASK,'src/ui/settings-menu.ts','openSettingsMenu','/tasks -> Settings',[
 ('six-settings/root/cancel','Task Settings; Task storage, Auto-advance mode, Show task widget, Collapse completed tasks, Max visible tasks, Auto-clear completed tasks; current technical enum values and selected English descriptions. Native SettingsList is not marked Pi-owned; cancel reopens Tasks.'),
])
family(TASK,'src/ui/task-widget.ts','TaskWidget','task lifecycle widget fallback',[
 ('empty/hidden/active/blocked/complete/overflow','N tasks done/in progress/open, pending blocker suffix, activeForm spinner, started/ended timing, collapsed completed count, more count. Consolidated Jouzu dashboard claims can suppress widget; custom source text remains independent fallback.'),
])
family(TASK,'src/task-continuation.ts','installTaskContinuationGuard','native task follow-up messages',[
 ('collapsed/expanded/stale','Collapsed Task #id · subject (or full text expanded), stale skipped notice; continuation body is generated workflow guidance plus user task data. Distinguish model prompt text from human interface summary.'),
])
family(TASK,'src/index.ts','textResult','TaskCreate/CreateMany/List/Get/Update/Reorder/Output/Stop/Execute',[
 ('tool-success/list/details','Created/Updated/Moved/Scheduled task summaries, list Status/Owner/Description/Blocked by/Blocks/Run order/Execution stats/Metadata; source interface plus user task data.'),
 ('tool-empty/blocked/not-found/invalid/processless','No tasks; nothing can run/open blockers; no process for prompt-queued tasks; invalid before/after, unknown IDs, output status; separate raw process output from English framing.'),
])
# Multiloop command panels.
family(LOOP,'extensions/pi-multiloop/index.ts','formatLoopList','/multiloop ls [--archived]',[
 ('empty/active/paused/completed/archived','No loops registered; no non-archived loops with archived hidden count; Active / resumable, Paused, Completed / stopped, Archived group headings and hint.'),
])
family(LOOP,'extensions/pi-multiloop/index.ts','formatLoopStatusOverview','/multiloop status; /multiloop',[
 ('attached/detached/history/empty','pi-multiloop status; Attached running loops, Detached resumable loops, Inactive/history, archived hidden and no existing state guidance. Goals/IDs/metrics preserved.'),
 ('startup-resumable-notice','announceResumableLoops supplies custom multiloop-resume rendered by registered renderer; count/status/command hints and goal excerpt are English framing with user goal content.'),
])
family(LOOP,'extensions/pi-multiloop/index.ts','archiveHandler','/multiloop archive / rm / pause / stop / resume',[
 ('resolved/ambiguous/unknown/error','Resolved target success, no state/invalid id/ambiguous handing to agent/error; no active loops; archive failed/missing directory/skipped/still active summaries.'),
 ('delete-no-confirm','rm lane/run-tag deletes state after target lookup; no confirmation selector implemented. Do not run against real state in audit.'),
])
family(LOOP,'extensions/pi-multiloop/index.ts','formatGoalStatus','/goal and /goal list/help',[
 ('none/current/list/help','No active goal/start hint; goal id/status/objective/mode/steps/accounting, running/paused list and command help. Objective remains user data.'),
 ('replace-current/confirm/cancel','A goal is already active. Pause current and start / Stop current and start / Keep current; cancel keeps current. Non-UI path defaults to pause; native select is unadapted.'),
 ('pause/stop/resume/clear','Resumed/paused/stopped/detached messages, missing state, target disambiguation agent handoff. Commands are user-facing control, generated resolution prompt is model content.'),
 ('token-budget/allow-open-tasks/invalid','Show/change/remove cap, limit validation, objective too long, allow-open-tasks on/off notices and completion blocker; command syntax/technical flags preserved.'),
])
family(LOOP,'extensions/pi-multiloop/index.ts','updateStatus','loop lifecycle status',[
 ('running/paused/stopped/completed/blocked','multiloop: N states · N blocked (see /flow) is transform-injected status. Jouzu Session UI consumes extension statuses; verify whether raw value survives activity adapter.'),
], 'transform')
family(LOOP,'extensions/pi-multiloop/ui.ts','formatDashboardText','loop dashboard/text helpers',[
 ('empty/metric-delta/summary','No active loops.; formatted table and Loop/Mode/Status/Iteration/Goal/Baseline/Current/Change/Best/Consecutive failures/Pivots. Direct import/use reachability must be checked; do not count helper as rendered merely because it exists.'),
], 'conditional')
family(LOOP,'extensions/pi-multiloop/index.ts','textResult','multiloop_* / get_goal / update_goal tool results',[
 ('phase-and-verifier-results','Start/iterate/measure/decide/log; required metric/check/verifier validation, keep/revert/log statuses and failure results. Structured protocol names/commands and objective are protected; English result framing is dependency source.'),
 ('goal-completion/no-goal/wrong-state/blocked','No active quick goal, wrong completion status/non-running goal, open-task blocker and marked complete. Human pause/resume restriction is literal source tool response.'),
])
family(LOOP,'extensions/pi-multiloop/goal.ts','parseGoalCommand','/goal arguments',[
 ('empty/too-long/invalid-token/usage','Objective length/budget positive-number validation and usage; user objective treated as data, generated start/continuation prompts are model-directed instructions, not a missing screen translation by themselves.'),
])
# VCC and skill completion.
family(VCC,'src/commands/pi-vcc.ts','registerPiVccCommand','/pi-vcc [keep/prompt]',[
 ('compact/start/success/error','ctx.compact invokes native compaction UI, optional follow-up user message; custom instructions not human panel. No standalone custom settings menu.'),
], test=BEHAVIOR)
family(VCC,'src/commands/vcc-recall.ts','registerVccRecallCommand','/pi-vcc-recall',[
 ('no-session/result/page','No session file available.; visible vcc-recall message from runRecall, page hints; command returns triggerTurn:true. Recall payload is session history, framing still interface/source-authored.'),
])
family(VCC,'src/core/recall-run.ts','runRecall','/pi-vcc-recall and vcc_recall',[
 ('search/recent/empty/widen','Nothing on current path showing edited/retried branches; no earlier matches/current-turn-only, scope all, match counts and truncation/refine guidance.'),
 ('range/expand/drill/touched/paging/errors','Invalid/out-of-range/empty range; expansion outside history/off-path note, paired result clipping, query/range pagination and file content references. Preserve quoted history/paths/tool args.'),
 ('ignored/precedence','Ignored parameters/reasons for exclusive actions; source UI wrapper, not arbitrary user/model text.'),
])
family(VCC,'src/hooks/before-compact.ts','registerBeforeCompactHook','manual/auto compaction',[
 ('nothing/too-few/tail/stats','pi-vcc Nothing to compact, Too few messages, kept turns/tokens / mid-turn cut reason and summarized count; resulting summary body/sections are generated model context, preserve as history.'),
])
family('pi-skill-dollar','dist/extension.js','skillDollarExtension','$skill autocomplete; input fallback',[
 ('skills/filtered/empty','No menu/command registrations. Adds autocomplete provider; $name rows draw command.description; no skills/no match returns null with no empty UI. Resource names/descriptions user or bundled provenance, not global translation targets.'),
 ('completion/cancel/escaped/inline','Leading completion uses slash-shaped prefix and submit; inline only inserts; space ends picker; escaped dollar untouched/submit escape transform; typed user text preserved.'),
], 'preserve')
# Web fetch wrappers and carried diagnostic strings.
family(WEB,'dist/src/jouzu-extension.js','createWebFetchTool','web_fetch tool transcript',[
 ('call/progress','web_fetch URL call; Fetching URL with the static fingerprinted transport... progress. URL/proxy credentials sanitized; no command/settings menu registered.'),
 ('success/error/metadata/truncation','Fetched destination (N chars), Fetch failed: code, response metadata URL/Final URL/Status/Content-Type/Format/Characters/Title/Author and tool output truncation notice. Article text is remote source content; labels are UI.'),
])
family(WEB,'dist/src/jouzu-extension.js','createBatchWebFetchTool','batch_web_fetch transcript',[
 ('queued/fetching/settled/partial-failure','Fetching/Fetched completed/total URLs, ok/failed counts, row queued/fetching/failed statuses elapsed/char count, item errors; URL/content protected.'),
 ('expanded/collapsed/narrow/fallback/abort','Compact progress and expanded rows width-truncate URL; batch fallback summaries and aborted state; concurrency order and full model text separate from compact preview.'),
])
family(WEB,'dist/src/jouzu-extension.js','jouzuDiagnosticTool','web_fetch / batch_web_fetch final result',[
 ('diagnostic-collapsed','N extraction diagnostic(s); expand this tool to review. Added by scripts/webaio-defuddle-transform.mjs, rendered as warning below original result. Confirmed source UI English, not developer-only log.'),
 ('diagnostic-expanded/omitted','Extraction diagnostics (Defuddle):, Batch extraction diagnostics (Defuddle):, Request N:, additional diagnostics omitted. Transform retains redacted underlying extractor errors; translate framing separately.'),
 ('diagnostic-bounded/retained/failure','[shortened; expand this tool for retained details] bounding suffix; retained in tool result/session history, also on fallback/failure. No live fetch needed: stub extractionDiagnostics details to render this state.'),
], 'transform', 'scripts/webaio-defuddle-transform.test.mjs; scripts/apply-webaio-defuddle-quiet.test.mjs (English functional coverage, not locale proof)')
# Preview panels.
family(PRE,'src/settings/ui/index.ts','createSettingsCategoryItems','/code-preview-settings',[
 ('root/categories','Appearance, Output previews, Enabled tools, Warnings & safety, Advanced and English summaries. Third-party SettingsList not marked owned by Pi locale wrapper.'),
 ('output-subgroups','Read previews, Write previews, Edit diff previews, Search/list previews, Bash previews nested group menus; English descriptions and summary values.'),
])
family(PRE,'src/settings/ui/submenus.ts','ThemeSelectSubmenu','code-preview Appearance -> Syntax theme',[
 ('theme/select/cancel/narrow','Syntax theme / Select a Shiki theme for code previews. / Enter to select · Esc to go back. Theme IDs are technical names; no filter Input implemented in this theme submenu.'),
])
family(PRE,'src/settings/ui/submenus.ts','ToolPreviewSettingsSubmenu','code-preview Enabled tools',[
 ('active/pending/disabled/conflict','Preview tools and per-tool toggles; currently active / takes effect after /reload, disabled OWNER conflict and ownership remediation. Owner/source/tool identifiers preserved.'),
])
family(PRE,'src/commands/panels/settings.ts','createCodePreviewSettingsList','code-preview setting changes',[
 ('reset/saved/error/cancel','Restore defaults keep current/reset now cycles then resets, no separate confirmation dialog. Reset success notice, failed save warning; cancel flushes save queue then exits.'),
])
family(PRE,'src/commands/health.ts','HealthPanel','/code-preview-health',[
 ('healthy/pending/conflict/uninitialized','Code preview health; Shiki yes/no, settings/render ownership, cache/language/path/settings-file fields and none; Press any key to close. Values are technical config; labels interface.'),
 ('narrow/close','Frame max(4,width), per-line ellipsis; closes on any key, not only Escape. No locale wrapper.'),
])
for rel,sym,entry,states in [
 ('src/tool-renderers/read.ts','registerRead','read',[('empty/error/image/large/truncated','Read failed, Empty file, Syntax highlighting skipped for large file, Output truncated by read. File content/image metadata are source payload; labels/hints UI.')]),
 ('src/tool-renderers/write.ts','registerWrite','write',[('new/applied/no-change/unavailable/skip','New file N lines; Write applied; no changes; previous content unavailable; diff skipped reason/large content/complex rewrite and Rendering write diff…; source code/diff contents preserved.')]),
 ('src/tool-renderers/edit.ts','registerEdit','edit',[('proposed/pending/applied/error/large/collapsed','Rendering proposed edit diff…/edit diff…; proposed edit blocks; Edit applied/no diff; Edit failed; Showing N diff lines; skip highlighting. Diff/source strings must not be translated.')]),
 ('src/tool-renderers/bash.ts','registerBash','bash',[('warnings/running/success/error/no-output/truncated','Preview warning labels, timeout, No output, Output truncated by bash, Full output path and hidden count/expand footer; source command/output/error preserved.')]),
 ('src/tool-renderers/grep.ts','registerGrep','grep',[('none/matches/truncated/collapse','Grep result framing, matched lines and source paths protected; shared collapse/expand/hint helpers are English.')]),
 ('src/tool-renderers/shared/path-list-result.ts','renderPathListResult','find/ls',[('none/paths/hidden/error','Path list result count, overflow/truncation, error prelude and show/hidden states; path/file names exact.')]),
 ('src/preview/format.ts','showingFooter','all preview renderers',[('hidden/expand/narrow','N lines hidden, Showing N of total noun · expand and hidden-output expansion hints; numeric values/binding preserved.')]),
 ('src/warnings/bash.ts','getBashWarnings','bash preview call',[('destructive-warning-families','recursive delete, elevated privileges, recursive permission/ownership change, discards git changes, removes untracked files/Docker data, writes to system path. Source-authored interface warnings, not shell stdout.')]),
 ('src/warnings/secrets.ts','getSecretWarnings','read/write/bash preview',[('secret-warning-families','private key, AWS secret key, API key, GitHub token, JWT labels; redact/preserve matched secret value, do not include sample credentials in audit.')]),
]: family(PRE,rel,sym,entry,states)

# Remaining shared terminal states and native fallback renderers.
family(TUI,'dist/autocomplete.js','CombinedAutocompleteProvider','editor slash/path/@ completion',[
 ('root/argument-hint','Builtin, extension, prompt and skill commands become label/description rows. argumentHint is prepended with an em dash; root slash translation does not adapt every argumentHint or callback result.'),
 ('argument-provider/preserve','getArgumentCompletions delegated after first space, returning supplying extension labels/status descriptions. File path completions / @ fuzzy files preserve paths, quote state and directory suffixes; no-result returns null, not necessarily No matching commands screen.'),
 ('async/abort/apply','Path search may use fd subprocess; abort cancels in-flight suggestion generation. Selection changes editor text/cursor; source/user paths must remain exact.'),
], 'preserve')
family(TUI,'dist/components/editor.js','Editor','main editor and extension editors',[
 ('paste-marker','[paste #N +N lines] or [paste #N N chars] are synthetic parseable editor markers, not pasted source text. Marker recognition regex is structural; a translated display must preserve expansion semantics.'),
 ('scroll/hidden/narrow','Up/down N more scroll-border labels, shortened at narrow width; dynamic rendering outside Pi selected component patch. Original pasted text is recovered on submit and must be preserved.'),
 ('autocomplete/force/cancel','Editor builds SelectList from supplied rows. Slash description adapter runs on provider items, not shared No matching commands fallback. Tab/selection/Escape controls trigger/cancel without translating insertion value.'),
])
family(TUI,'dist/alt-screen-search.js','AltScreenSearchComponent','fullscreen find-in-transcript binding',[
 ('placeholder/empty/no-match/results','Find in transcript placeholder, No matches, selected/total count, previous/next shortcut-only buttons. Query and transcript content preserved; component owns these English labels.'),
 ('narrow/escape/return','Search overlay truncates input and chooses fitting previous/next buttons; Enter navigation, Escape closes/restores prior viewport through host. No Japanese render proof.'),
])
family(TUI,'dist/tui-alt-screen.js','copyActiveSelectionToClipboard','fullscreen selection copy',[
 ('copy/success/failure','Copied! / Copy failed flash or supplied string result; OSC52 fallback requests clipboard write without completion acknowledgment. Pi host may replace with Copy requested; preserve failure source details.'),
])
family(PI,'dist/modes/interactive/components/keybinding-hints.js','keyHint','native component and extension key hints',[
 ('configured/unbound','Key text can be disabled when unbound; action label is caller-supplied English. Shortcuts themselves remain exact. Selected-component wrappers rewrite some composed patterns, not this helper globally.'),
])
family(PI,'dist/modes/interactive/components/bordered-loader.js','BorderedLoader','share, tree summary and extension loaders',[
 ('message/cancel/dispose','Caller message rendered by CancellableLoader with cancellation hint; abort triggers controller, restoration handled by caller. Loader is not generally localized by selected Pi wrapper.'),
])
family(PI,'dist/modes/interactive/components/radius-login-selector.js','createLoginMenuSelector','/login root Radius entry',[
 ('selected/animated/narrow/cancel','RadiusLoginMenuComponent subclasses ExtensionSelectorComponent and shimmers exact selected label; at wrapping width animation does not match and normal option renders. It is not the OAuthSelectorComponent localization target.'),
])
family(PI,'dist/modes/interactive/components/earendil-announcement.js','EarendilAnnouncementComponent','exact hidden /dementedelves input',[
 ('text/image/fallback','pi has joined Earendil and Read the blog post:; optional bundled image absent falls back to text. Source branch exists in InteractiveMode despite not being registered in builtin slash completion. No browser action executed.'),
])
family(PI,'dist/core/project-trust.js','formatProjectTrustPrompt','unresolved project trust before resources load',[
 ('ask/trust/cancel','Trust project folder? title and explicit allow-settings/resources/packages/extensions explanation supplied to generic startup selector. /trust selected-component adapter does not cover this separately constructed generic selector.'),
 ('prior-decision/override/noninteractive','Saved decision/trust override/extensions project_trust result/default always or never bypass prompt; no UI returns untrusted, cancel returns untrusted. Rendering must be confirmed in Jouzu host bootstrap.'),
], 'conditional')
family(PI,'dist/core/trust-manager.js','getProjectTrustOptions','project trust prompt and /trust',[
 ('current/parent/session','Trust, Trust parent folder (path), Trust (this session only), Do not trust and session-only negative. /trust handles strings via its wrapper, generic startup prompt does not automatically inherit that.'),
 ('read/lock/write-errors','Failed to read trust store / Invalid trust store path/type/value error templates may reach startup/interactive error handlers; filenames and filesystem cause are preserved.'),
], 'conditional')
family(PI,'dist/cli/session-picker.js','selectSession','native --resume startup',[
 ('loading/scopes/cancel/exit','Creates SessionSelectorComponent with showRenameHint:false. Pi selector prototype adaptation depends on whether Jouzu wrapping has started before this route; startup native picker versus /resume must be tested separately.'),
], 'conditional')
family(PI,'dist/cli/startup-ui.js','showStartupSelector','startup trust generic selector',[
 ('select/input/confirm','Creates TuiMainScreen, generic ExtensionSelectorComponent/ExtensionInputComponent; separate lifetime from InteractiveMode and with no guaranteed selected wrapper. Startup input also does not paint native ignored placeholder.'),
], 'conditional')
family(PI,'dist/modes/interactive/theme/theme-controller.js','InteractiveThemeController','theme apply/automatic color updates',[
 ('load-failure/system-fallback','showError on failed theme apply; system theme starts grayscale until terminal colors; late replies re-render without UI error. Theme error details preserved, host prefix interface.'),
])
for rel,sym in [('read','readRenderers'),('write','writeRenderers'),('edit','editRenderers'),('find','findRenderers'),('grep','grepRenderers'),('ls','lsRenderers'),('bash','createShellRenderers')]:
    family(PI,'dist/core/tools/renderers/'+rel+'.js',sym,'native '+rel+' renderer fallback',[
      ('call/result/empty/truncated/expanded','Native tool-specific call and result implementation contains progress/hidden-line/expand/truncation/path/limit framing. Code previews owns selected tool renderers in normal Jouzu; native fallback remains on disabled, conflict or unclaimed tool. Raw file/code/stdout/error content stays exact. Inspect source excerpt for tool-specific literals; do not assume fallback runtime ownership.'),
    ], 'fallback')
family(PI,'dist/extensions/mcp/tools.js','createMcpTool','MCP tool transcript',[
 ('result/collapsed/expanded/truncated','Native MCP renderer displays server tool identifier/arguments and service text, with hidden-line/expand/full-output/truncation framing. Remote descriptions/results are payload, renderer labels/hints interface. read_mcp_resource follows linked-resource semantics.'),
], 'preserve')
family(LOOP,'extensions/pi-multiloop/summary.ts','formatRunSummary','goal/measured run durable transcript card',[
 ('complete/stopped/paused','Goal complete/stopped/paused and Run complete/stopped/paused; elapsed/active, steps/iterations, turns/tool calls/tokens, mode/counters and metric accounting. Appended custom entry does not enter model context: this is human UI, not generated prompt.'),
 ('resume-hint/reason/narrow','Resume with /goal resume or /multiloop resume target unless complete; holding reason and goal included. Long goal/metric/id data exact; date/time formatting is locale-specific concern independent of string mapping.'),
])
family(PRE,'src/preview/async.ts','AsyncPreview','large code/diff preview',[
 ('pending/completed/failed','Caller supplies Rendering … label; setTimeout replaces with result, failure displays escaped exception.message. Async error is source diagnostic content; loading labels covered by renderer rows.'),
])
family(PRE,'src/tool-renderers/shared/result-prelude.ts','renderResultPrelude','preview result prelude',[
 ('partial/error/hidden','Partial loadingLabel from renderer; errorText escaped unchanged; hidden preview expansion hint from tool-shell. Do not classify arbitrary tool errorText as Pi-authored English merely because the prelude paints it.'),
], 'preserve')
family(WEB,'dist/src/webfetch-api.js','StaticFetchException','web_fetch / batch_web_fetch failures',[
 ('validation/transport/redirect/security/timeout','StaticFetchException is local source error framing with code/phase/status and redacted cause. Option validation, unsupported profile/OS/format, SSRF, redirect, retry, timeout/cancel/content-size failures may be human-visible in error results; underlying HTTP/service body remains source content.'),
 ('extractor/unsupported/malformed','Content extraction/parser diagnostics can be retained by Jouzu Defuddle transform. No need for a live site: stub validation/request/extraction dependencies to render error code, interface prefix and retained diagnostics separately.'),
])

# Provider-auth instructions are local Pi AI source UI, not remote provider page prose.
AI='@earendil-works/pi-ai'
for rel in ['dist/auth/helpers.js','dist/providers/amazon-bedrock.js','dist/providers/cloudflare-auth.js','dist/providers/google-vertex.js','dist/auth/oauth/anthropic.js','dist/auth/oauth/github-copilot.js','dist/auth/oauth/kimi-coding.js','dist/auth/oauth/meta.js','dist/auth/oauth/openai-chatgpt.js','dist/auth/oauth/openai-codex.js','dist/auth/oauth/openrouter.js','dist/auth/oauth/radius.js','dist/auth/oauth/xai.js','dist/auth/oauth/callback-server.js']:
    text=read(src(AI,rel),'provider-auth-source-inspected')
    for match in re.finditer(r'(?:message|instructions|placeholder|loginLabel|label): [^\n]+|oauth(?:Success|Error)Html\([^\n]+',text):
        expression=match.group(0).strip()
        if not re.search('["\'`]',expression):continue
        add(AI,rel,'auth-interaction/callback-local-text','/login provider -> native LoginDialog; local OAuth callback','provider-dependent-auth-source-ui',
            'Local source expression: '+expression+' User credentials, account/project identifiers, URLs, auth codes and remote error details remain verbatim. Source-authored prompt/instructions/progress labels are interface translation work, not exempt remote prose.',
            'unadapted',anchor=expression,limit='Source expression extracted under the reviewed auth route; not a separate full semantic state review. No network, provider login, browser approval, API key entry or account operation executed. Placeholder visibility depends on dialog path.',level='extracted-provider-expression',line_no=text[:match.start()].count('\n')+1)

# Additional command-handler and lifecycle families, independently traced in InteractiveMode.
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.handleReloadCommand','/reload',[
 ('streaming/compacting/busy','Wait for the current response to finish before reloading. / Wait for compaction to finish before reloading.; no reload occurs.'),
 ('loading/success/project-trust','Reloading keybindings, extensions, skills, prompts, themes, and context files... temporarily replaces editor. Success restores chat/editor and optionally adds saved project trust suffix; keybindings/theme/autocomplete refreshed.'),
 ('diagnostics/failure','models.json error prefix, reloaded resource diagnostics even when quiet, Reload failed cause with previous editor restored. Source paths/resource prose/cause remain exact.'),
])
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.handleExportCommand','/export [path]',[
 ('html/jsonl/success/error','Path ending .jsonl calls JSONL export; other or absent path uses HTML. Session exported to: path or Failed to export session: cause. Exported HTML viewer is a separate out-of-terminal UI boundary, not semantically inventoried here.'),
])
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.handleCopyCommand','/copy; copy-agent/selection binding',[
 ('no-agent/selection/agent','No agent messages to copy yet.; selected text copies through TuiAltScreen without assistant fallback; otherwise last assistant text. Selected/agent source text must not be changed.'),
 ('flash/status/failure','Copy requested flash versus Clipboard copy requested for last agent message notice; injected selected-message notice and Clipboard copy failed: cause on helper failure. Request wording does not prove desktop clipboard contents changed.'),
])
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.handleCloneCommand','/clone',[
 ('empty/cancel/success/error','Nothing to clone yet; runtime fork cancelled silently; Cloned to new session and editor cleared; runtime error is displayed verbatim without an invented clone-specific prefix.'),
])
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.showUserMessageSelector','/fork handler boundary',[
 ('no-messages/cancel/success/error','No messages to fork from occurs before patched empty selector is constructed. Forked to new session on success; selectedText restored to editor; runtime cancel silent, source error verbatim.'),
])
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.handleClearCommand','/new',[
 ('cancel/success/fatal','runtimeHost.newSession cancel silent; checkmarked New session started native ThemedText; failure through handleFatalRuntimeError with Failed to create session. No confirmation dialog implemented here.'),
])
family(PI,'dist/core/session-cwd.js','formatMissingSessionCwdPrompt','resume/import missing original directory',[
 ('prompt/continue/decline','cwd from session file does not exist / continue in current cwd with preserved paths; Session cwd not found generic Yes/No confirmation supplies decision. Stored working directory error includes optional session file and fallback cwd.'),
])
family(PI,'dist/core/auth-guidance.js','getProviderLoginHelp','no-model/no-auth runtime errors',[
 ('no-model/no-selected/no-api-key','No models available. / No model selected. / No API key found for provider; Use /login to log into a provider via OAuth or API key; provider/model docs paths and Then use /model. These local helper strings are interface guidance despite core/ location.'),
])
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.handleEvent','agent/model/compaction lifecycle',[
 ('aborted/retry-failure','Operation aborted or Aborted after N retry attempts replaces assistant errorMessage and pending tool errors; Retry failed after N attempts: cause final notice, unknown error fallback.'),
 ('compaction-manual/automatic/cancel/error','Compaction cancelled is error for manual; Auto-compaction cancelled is status for automatic; compaction result summary preserved as model content; dynamic event.errorMessage requires provenance classification, not blanket translation.'),
 ('nested/pending-tool/settled','Parented nested calls skipped in top-level transcript, pending calls become completed/error results; agent_end removes pending working state. Tool return data remains exact; fallback renderer framing separately recorded.'),
])
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.showThinkingSelector','/thinking [level]',[
 ('select/default/unsupported/error','Thinking selector selection updates default or session; Thinking level: level / Default thinking level: level notices outside selector wrapper. Command accepts exact supported level or search input; level ID preserved.'),
])
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.handleModelCommand','native /model argument fallback',[
 ('exact-match/refresh/timeout/error','Exact cached model selects directly and shows Model: id; uncached triggers Refreshing model catalogs… with timeout/cached fallback warning. Native fallback conditional on Jouzu interception; no provider refresh performed.'),
 ('subscription-warning','Anthropic subscription auth warning depends on warning setting, selected provider and OAuth/subscription key; shown once, source constant is Pi-authored UI advice, not remote API prose.'),
], 'fallback')
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.handleDebugCommand','/debug or TUI debug binding',[
 ('file-written','Checkmarked Debug log written and file path render in transcript; debug file body captures exact rendered/source content and is not itself a menu. No debug file generated by this audit.'),
])
family(PI,'dist/modes/interactive/interactive-mode.js','InteractiveMode.handleArminSaysHi','exact hidden /arminsayshi input',[
 ('3d/fallback','Attempts animated playArmin3d, falls back to ArminComponent; not builtin slash registry. Nonverbal art is not a translation omission; runtime animation reachability on Jouzu not tested.'),
])

# Exact-source setting records, enumerated from implementation rather than adapter map.
settings_path = src(PI,'dist/modes/interactive/components/settings-selector.js')
settings_text = read(settings_path)
for match in re.finditer(r'id: "([^"\n]+)",\n\s*label: "([^"\n]+)",', settings_text):
    block = settings_text[match.start():settings_text.find('\n            },',match.start()) if '\n            },' in settings_text[match.start():] else match.end()+400]
    value = re.search(r'currentValue: ([^\n]+)',block)
    item_id,label=match.groups()
    add(PI,'dist/modes/interactive/components/settings-selector.js','setting:'+item_id,'/settings or implemented submenu','field/selected-description/current-value',
        'Source setting '+item_id+' label='+label+'; currentValue='+ (value.group(1).rstrip(',') if value else 'see implementation')+'. Labels/descriptions may be adapted, stored tokens and currentValue are not rewritten.',
        'selected',anchor=match.group(0),test=START_TEST,limit='Mechanically extracted source field, not a rendered-screen or full semantic state review. Capability/submenu predicates determine visibility.',level='extracted-setting-field')
pre_registry = read(src(PRE,'src/settings/ui/registry.ts'))
for match in re.finditer(r'^  (\w+): \{\n\s*label: "([^"\n]+)",',pre_registry,re.M):
    item,label=match.groups()
    add(PRE,'src/settings/ui/registry.ts','setting:'+item,'/code-preview-settings -> category','field/description/values',
        item+' renders '+label+' with source English description/options. Theme IDs, paths, numeric/config enum values are protected underlying data; display-label policy separate.',anchor=match.group(0),level='extracted-setting-field')

# Registrations are discovered directly from checked-in installed entry source.
registration_files = [
 (PI,'dist/extensions/llama/index.js'),(PI,'dist/extensions/mcp/index.js'),
 (SCHED,'src/index.ts'),(BG,'extensions/registrations.ts'),(PRE,'src/commands/health.ts'),
 (PRE,'src/commands/settings.ts'),(TASK,'src/index.ts'),(LOOP,'extensions/pi-multiloop/index.ts'),
 (VCC,'src/commands/pi-vcc.ts'),(VCC,'src/commands/vcc-recall.ts')]
for owner,rel in registration_files:
    text=read(src(owner,rel))
    for match in re.finditer(r'registerCommand\(([^\n]+)',text):
        command=match.group(1).split(',')[0].strip().strip('"\'`')
        command=command.replace('${BG_COMMAND}','bg')
        if command=='BG_COMMAND': command='bg'
        following=text[match.end():match.end()+450]
        desc=re.search(r'description:\s*"([^"\n]*)"',following)
        add(owner,rel,'registerCommand:'+command,'/'+command,'registered-slash-description',
            'Registration description: '+(desc.group(1) if desc else 'see registration')+'. Registration does not prove command detail/panel localization.',
            'slash',anchor=match.group(0),test=START_TEST,limit='Mechanically extracted registration under inspected entry point, not full semantic state review. Prior startup discovers slash descriptions only.',level='extracted-command-registration')
slash=read(src(PI,'dist/core/slash-commands.js'))
for match in re.finditer(r'\{ name: "([^"\n]+)", description: ([^\n]+)',slash):
    command,desc=match.groups()
    add(PI,'dist/core/slash-commands.js','BUILTIN_SLASH_COMMANDS:'+command,'/'+command,'registered-builtin-description',
        'Builtin declaration '+desc+'; details are handled by InteractiveMode. /model intercepted, /scoped-models suggestion hidden by Jouzu editor.',
        'slash',anchor=match.group(0),test=START_TEST,limit='Mechanically extracted declaration/completion description only; does not establish rendered dropdown or detail state coverage.',level='extracted-command-registration')
mode_text=read(src(PI,'dist/modes/interactive/interactive-mode.js'))
for match in re.finditer(r'text === "(/[^"\\\n]+)"',mode_text):
    command=match.group(1)
    add(PI,'dist/modes/interactive/interactive-mode.js','input-branch:'+command,command,'exact-input-handler-discovery',
        'Exact command input branch exists independently of builtin slash registrations. Full branch behavior must be resolved to reviewed family rows, not inferred from mapping keys.',
        anchor=match.group(0),level='extracted-input-branch',line_no=mode_text[:match.start()].count('\n')+1)

# Notification/error callsites retain literal or dynamic expression and enclosing native method.
# Supplement family rows, not a claim that all emitted errors are translation omissions.
notify_paths=[(PI,'dist/modes/interactive/interactive-mode.js')]+[(o,r) for o,r in registration_files if o not in (PI,PRE)]
notify_paths += [(BG,'extensions/background-tasks.ts'),(TASK,'src/task-continuation.ts')]
for owner,rel in notify_paths:
    text=read(src(owner,rel)); lines=text.splitlines(); symbol='module'
    for i,line in enumerate(lines):
        method=re.match(r'^    (?:async )?([A-Za-z_]\w*)\([^;]*\) \{',line) if owner==PI else None
        if method: symbol='InteractiveMode.'+method.group(1)
        sink=re.search(r'(this\.show(?:Error|Warning|Status)|(?:ctx|activeCtx|latestCtx|ui)(?:\?\.)?(?:\.ui)?(?:\?\.)?\.(?:notify))\(',line)
        if not sink: continue
        expr=line[sink.start():].strip()
        if re.search(r'\(\s*$',expr): expr+=' '+' '.join(s.strip() for s in lines[i+1:i+4])
        literal=bool(re.search('["\'`]',expr))
        add(owner,rel,symbol if owner==PI else 'notification-callsite','interactive lifecycle or command; see enclosing source','notification/error/status-callsite',
            ('Source UI expression: ' if literal else 'Dynamic payload boundary (not a confirmed English interface gap): ')+expr,
            'unadapted' if literal else 'preserve',anchor=line.strip(),
            limit='Mechanical sink expression only: not a reviewed semantic state or runtime reachability proof. Conditional predicate and payload provenance remain for review. Dynamic exception/extension/model/service text may remain exact.',level='mechanical-notification-candidate' if literal else 'mechanical-dynamic-candidate',line_no=i+1)

# Transform routes with explicit origin, including emitted text (not merely build-time logs).
transform_families = [
 ('scripts/webaio-defuddle-transform.mjs','transformWebaioDiagnosticHistory','web_fetch/batch_web_fetch','emitted-warning/expanded/omitted','Installed pi-webaio/dist/src/jouzu-extension.js adds Extraction diagnostics (Defuddle), batch heading, diagnostic count, omitted and shortened-expand hint. These are dependency tool UI, not developer-only diagnostics.'),
 ('scripts/apply-webaio-defuddle-quiet.mjs','SIDECAR_NAME','Defuddle diagnostics captured into web tool details','emitted-sanitizer-fallbacks','Generated sidecar emits [unredacted diagnostic omitted], [invalid sanitized diagnostic], [unformattable diagnostic] through capture data. These can reach warning renderer; real parser text remains source diagnostics.'),
 ('scripts/pi-content-policy-transform.mjs','dist/modes/interactive/interactive-mode.js','Pi transcript/copy/crash/session/bug','emitted-notices','Clipboard copy requested for selected/last agent message; /bug drafts report hint; session info footer hook. Installed InteractiveMode and bug-report replacement are human UI routes.'),
 ('upstream/pi-content-policy/bug-report.js','reportBug','/bug','emitted-entire-flow','Applied replacement matches installed dist/modes/interactive/bug-report.js; source contains public issue draft input/review/confirm/cancel/uncertain submission UI.'),
 ('scripts/pi-content-policy-transform.mjs','TextGuard could not check model context','request/summary/tool-result failures','emitted-errors','TextGuard could not check model context; request withheld.; TextGuard could not check session history; compaction/branch summarization withheld.; Tool result withheld after cancellation.; physical-model request-check guidance can surface through interactive error/result handling.'),
 ('scripts/background-flow-transform.mjs','reportProblem','background persistence warning','emitted-warning','Background task state persistence failed (where): message injected into activeCtx.ui.notify; retained source diagnostics can be nested in warning, not exclusively a build diagnostic.'),
 ('upstream/background-flow/resource-edits.json','has exited; its log is being flushed','background stop/log/status','emitted-stop-and-pattern-warning','Adds task has exited; its log is being flushed. and log warning metadata; forwards OutputMatcherBudgetError.message to ui.notify. Applied installed background-tasks.ts and helper sources preserve these UI routes.'),
 ('upstream/background-flow/resources/output-matcher.ts','OutputMatcherBudgetError','background pattern timeout','emitted-warning-body','Notify pattern exceeded 25 ms; output matching is disabled for this task. is helper-authored text forwarded by patched background-tasks.ts into ui.notify; not a build-time diagnostic.'),
 ('upstream/background-flow/resources/log-writer.ts','failedLogMarker','background log-write failure','emitted-log-markers','[log dropped N bytes: log write failed: error] and stalled variant are written into the log stream. These become source diagnostic content under background tool framing; not a build-only console error.'),
 ('upstream/background-flow/resources/jouzu-resources.ts','logWarning','background completion/result warnings','emitted-result-warning','Task log may be incomplete because a write failed or stalled. is assigned to task.logWarning and propagated to completion/result metadata by the applied resource edits. Human-visible route depends on result renderer.'),
 ('scripts/pi-flow-control-transform.mjs','Flow queue claim cancelled before execution.','queued prompt execution failure','emitted-exception','Flow queue claim cancelled before execution. is generated into pi-agent-core/dist/agent.js. It is a runtime exception, not a build-applier error; final interactive propagation is not established here and remains a candidate rather than confirmed rendered text.'),
 ('upstream/pi-terminal-clipboard/patch.mjs','Clipboard unavailable: tmux forwarding failed','/copy and transcript copy failure','emitted-exception','Clipboard unavailable: tmux forwarding failed (status) is generated into Pi dist/utils/clipboard.js; InteractiveMode catches clipboard helper errors and shows their message. Underlying tmux status remains technical source data.'),
 ('scripts/multiloop-flow-transform.mjs','blocked (see /flow)','multiloop status','emitted-status','Adds N blocked (see /flow) to extension status consumed by Jouzu Session UI. Also Finding the goal to resume… notice and live goal guidance; model-directed continuation instructions must be distinguished from human notice.'),
 ('scripts/task-flow-transform.mjs','paused or waiting for user input','task queue result','emitted-result','Adds #id: paused or waiting for user input result, waitForUser/paused tool parameter descriptions, generated task instructions. Queue feedback can be human-visible; prompt instructions are model content.'),
 ('scripts/pi-oauth-branding-transform.mjs','aria-label="Jouzu"','Pi AI local OAuth callback HTML','emitted-branding/not-translation','Changes Jouzu logo/aria-label and colors, not Authentication successful/failed headings. Branding is not locale adaptation; browser callback page is local dependency UI.'),
]
for path,anchor,entry,state,finding in transform_families:
    add('Jouzu transform',path,'transform/source',entry,state,finding,'transform',anchor=anchor,
        limit='Source and applied installed path traced; read-only hash evidence in transforms.csv where pinned; no provider/network/account action performed.')
family('@earendil-works/pi-ai','dist/utils/oauth-page.js','oauthSuccessHtml','local OAuth callback HTML',[
 ('success/failure','Authentication successful / Authentication failed title and heading; html lang=en in render template. Jouzu logo transform does not translate these. Body supplied by local OAuth code; remote provider site itself remains outside scope.'),
], 'unadapted', 'scripts/pi-oauth-branding.test.mjs (branding, not Japanese)')

# Whole-source structural census, explicitly distinguished from family-level tracing.
# No recursion into nested node_modules or minified duplicate bundles.
def walk_sources(root):
    for directory, dirs, names in os.walk(ROOT/root):
        dirs[:]=sorted(d for d in dirs if d not in ('node_modules','.git','examples','test','tests','vendor','bundle','bun'))
        for name in sorted(names):
            p=Path(directory)/name
            if p.suffix in ('.js','.ts','.mjs') and not name.endswith(('.d.ts','.test.ts','.test.js','.test.mjs')):
                yield p.relative_to(ROOT).as_posix()

ui_sinks=re.compile(r'registerCommand|registerMessageRenderer|renderCall\(|renderResult\(|\.ui\.(?:select|input|confirm|editor|notify|custom|setWidget|setStatus)|new (?:Text|TruncatedText|SettingsList|SelectList)\b|show(?:Error|Warning|Status)\(')
scan_roots=[NM+PI+'/dist',NM+TUI+'/dist']
scan_roots += [NM+o+('/extensions' if o in (BG,LOOP) else '/src') for o in [SCHED,BG,TASK,LOOP,VCC,PRE]]
scan_roots += [NM+'pi-skill-dollar/dist',NM+WEB+'/dist/src',NM+'@earendil-works/pi-ai/dist/auth',NM+'@earendil-works/pi-ai/dist/providers']
source_excerpt=[]
for root in scan_roots:
    for path in walk_sources(root):
        data=read(path,'structural-source-scan')
        hits=[]
        for i,line in enumerate(data.splitlines()):
            if ui_sinks.search(line):
                hits.append(i+1)
                source_excerpt.append({'source_file':path,'line':i+1,'source':line.strip()})
        if files[path][0]=='structural-source-scan':
            if root==NM+WEB+'/dist/src' and '/jouzu-extension.js' not in path and not path.endswith('/webfetch-api.js'):
                disposition='support-or-unselected-web-module; mechanical-scan-only'
            elif path not in {r['source_file'] for r in rows} and hits:
                disposition='unresolved-ui-or-error-sink-candidate; mechanical-scan-only'
            elif hits:
                disposition='mechanical-scan; source-families-cited-separately'
            else:
                disposition='mechanical-scan; no-direct-ui-sink-found-by-bounded-pattern'
            files[path][0]=disposition
        files[path][1]+='; UI/registration sink lines='+(','.join(map(str,hits)) if hits else 'none under bounded sink scan')

# Trace support framing outside interactive component tree (auth providers, autocomplete/tool renderers).
extra_paths=[]
for path in [NM+PI+'/dist/core/auth-guidance.js',NM+PI+'/dist/core/project-trust.js',NM+PI+'/dist/cli/project-trust.js',NM+PI+'/dist/cli/startup-ui.js',NM+PI+'/dist/cli/session-picker.js',NM+PI+'/dist/core/slash-commands.js']:
    extra_paths.append(path)
for path in sorted((ROOT/(NM+'@earendil-works/pi-ai/dist')).glob('**/*.js')):
    rel=path.relative_to(ROOT).as_posix()
    if '/utils/oauth/' in rel or rel.endswith('/utils/oauth-page.js') or '/auth/' in rel:
        extra_paths.append(rel)
for path in extra_paths:
    read(path,'auth/startup-boundary-source-scan')

# Record adaptation only; do not audit Jouzu-owned screens assigned to another partition.
for path in ['packages/cli/src/pi-ui-localization.ts','packages/session-ui/src/extension.ts','packages/session-ui/src/prompt-frame.ts','packages/cli/src/main-cli.ts','packages/cli/src/classic-host-policy.ts','packages/cli/src/mcp.ts','packages/cli/src/release-extensions.ts','packages/cli/package.json','upstream/pi.lock.json','packages/cli/release-extensions.json']:
    read(path,'scope/adaptation-boundary-only')

# All carried transform/apply files and source payloads: inspect text for emitted UI/errors,
# record actual hash pins separately. Do not execute appliers (even in check mode).
transform_patterns=['scripts/*transform.mjs','scripts/apply-*.mjs','scripts/install-release-extensions.mjs','scripts/prepare-cli.mjs','scripts/build-textguard.mjs','upstream/*/*.mjs','upstream/*/*.js','upstream/*/*.ts','upstream/*/*.json','upstream/background-flow/resources/*.ts']
for pat in transform_patterns:
    for path in sorted(ROOT.glob(pat)):
        rel=path.relative_to(ROOT).as_posix()
        if '.test.' in rel: continue
        data=read(rel,'transform/support-source-scan')
        if rel.startswith('scripts/apply-') and 'webaio-defuddle' not in rel:
            files[rel][0]='build-applier/hash-guard; not-itself-runtime-ui'
        elif rel.endswith('patch.lock.json'):
            files[rel][0]='exact-transform-lock'
        elif rel not in [t[0] for t in transform_families]:
            files[rel][1]+='; support transform/runtime; emitted errors require consumer routing, no direct panel inferred'
        for i,line in enumerate(data.splitlines()):
            if ui_sinks.search(line) or re.search(r'extraction diagnostic|Authentication successful|Finding the goal|Background task state|TextGuard could not|logWarning|blocked \(see /flow\)',line):
                source_excerpt.append({'source_file':rel,'line':i+1,'source':line.strip()})

# Package inventory: union of release lock entries and every direct CLI runtime dependency.
pi_lock=json.loads(read('upstream/pi.lock.json'))
release=json.loads(read('packages/cli/release-extensions.json'))
cli=json.loads(read('packages/cli/package.json'))
lock=json.loads(read('package-lock.json','package-pin-boundary'))
for extension in release['packages']:
    for entry in extension['extensions']:
        path=NM+extension['name']+'/'+entry
        if (ROOT/path).is_file(): read(path,'release-entry-point-source')
package_rows=[]
all_names=sorted(set(cli['dependencies'])|set(pi_lock['packages'])|{p['name'] for p in release['packages']+release['compatibilityDependencies']})
for name in all_names:
    ext=next((p for p in release['packages'] if p['name']==name),None)
    compat=next((p for p in release['compatibilityDependencies'] if p['name']==name),None)
    pin=(ext or compat or pi_lock['packages'].get(name) or {})
    metadata_path=ROOT/(NM+name+'/package.json')
    metadata=json.loads(metadata_path.read_text()) if metadata_path.exists() else None
    lockentry=lock.get('packages',{}).get(NM+name.rstrip('/')) or lock.get('packages',{}).get('node_modules/'+name,{})
    version=pin.get('version') or (metadata or {}).get('version') or lockentry.get('version','unknown')
    if metadata:
        read(NM+name+'/package.json','package-identity')
        assert metadata['version']==version,(name,metadata['version'],version)
    if name==PI: disposition='active-native-interactive-ui; selected localization; Jouzu replacements/fallbacks distinguished'
    elif name==TUI: disposition='active-shared-widget/autocomplete rendering; no standalone command panel'
    elif name=='@earendil-works/pi-ai': disposition='active-provider auth prompts/errors and local OAuth callback HTML; remote service pages excluded'
    elif ext and name!='jouzu-camoufox-adapter': disposition='active-release-extension UI/tool-result surfaces; see family rows'
    elif name=='jouzu-camoufox-adapter': disposition='Jouzu-owned optional adapter; tool UI belongs to the Jouzu UI partition; no third-party extension menu'
    elif name=='@earendil-works/pi-server': disposition='non-terminal-service; not bundled in CLI; network/server UI outside interactive audit'
    elif name=='@earendil-works/pi-codemode': disposition='runtime library; native codemode extension replaced by empty Jouzu override; no active standalone panel'
    elif name=='@earendil-works/pi-mcp': disposition='protocol/client library; terminal MCP manager UI owned by pi-coding-agent and inventoried there'
    elif name in ['@earendil-works/pi-agent-core','@earendil-works/pi-telemetry']: disposition='runtime support/protocol/error propagation; no standalone terminal panel; generated core errors may surface through Pi'
    else: disposition='non-UI support/library/native/build dependency; no release command/menu entry point'
    package_rows.append({'package':name,'pinned_version':version,'pin_authority':('packages/cli/release-extensions.json' if ext or compat else 'upstream/pi.lock.json' if name in pi_lock['packages'] else 'packages/cli/package.json; package-lock.json'),
        'source_pin':pin.get('source') or pin.get('commit') or cli['dependencies'].get(name,''),
        'integrity_or_commit':pin.get('integrity') or pin.get('commit') or lockentry.get('integrity',''),
        'installed_version':(metadata or {}).get('version','not a node_modules package' if name=='jouzu-camoufox-adapter' else 'not installed at CLI root'),
        'release_entry_points':'; '.join((ext or {}).get('extensions',[])),
        'bundled':str(name in cli.get('bundleDependencies',[]) or name=='jouzu-camoufox-adapter').lower(),
        'ui_disposition':disposition,'evidence':'Installed package metadata plus exact manifest; no provider/account operations or dependency installs. Direct-support classification is entry-point-level, not a recursive audit of every transitive library.'})

# Optional first-use runtime is a separate packaged dependency boundary. Record exact
# direct pins without installing it or implying that its upstream UI is active.
cam_manifest=json.loads(read('packages/cli/camoufox-runtime/package.json','optional-runtime-pin-boundary'))
cam_lock=json.loads(read('packages/cli/camoufox-runtime/package-lock.json','optional-runtime-pin-boundary'))
for name,version in cam_manifest['dependencies'].items():
    record=cam_lock['packages']['node_modules/'+name]
    assert record['version']==version,(name,version,record['version'])
    package_rows.append({'package':name,'pinned_version':version,'pin_authority':'packages/cli/camoufox-runtime/package.json; packages/cli/camoufox-runtime/package-lock.json',
        'source_pin':record.get('resolved',''),'integrity_or_commit':record.get('integrity',''),'installed_version':'not installed or executed by this audit',
        'release_entry_points':'Jouzu optional adapter delegates tool execution only','bundled':'first-use-runtime-manifest',
        'ui_disposition':'optional Camoufox runtime boundary; no native upstream command/menu loaded by this partition; Jouzu adapter UI belongs to the Jouzu UI partition; dependency errors/tools require separate provenance review',
        'evidence':'Exact manifest/lock checked read-only; no provider/browser/network/install operation. This is not recursive semantic review of optional upstream runtime.'})

# Read-only hash validation of all exact carried lock.files and installed additions where specified.
transform_rows=[]
for deviation in pi_lock['deviations']:
    path=deviation['path']; payload=(ROOT/path).read_bytes(); obj=json.loads(payload)
    transform_rows.append({'lock_file':path,'installed_file':'','expected_sha256':deviation['sha256'],'actual_sha256':hashlib.sha256(payload).hexdigest(),'result':'match' if hashlib.sha256(payload).hexdigest()==deviation['sha256'] else 'MISMATCH','role':'Pi deviation manifest'})
    owner=obj.get('package')
    targets=[]
    for target,spec in obj.get('files',{}).items(): targets.append((target,spec['after'],'patched dependency source'))
    if path.endswith('/task-flow/patch.lock.json'):targets.append(('src/index.ts',obj['after'],'patched task registrations'))
    if 'extension' in obj: targets.append((obj['extension']['path'],obj['extension']['after'],'patched multiloop source'))
    if 'lanes' in obj: targets.append((obj['lanes']['path'],obj['lanes']['after'],'patched multiloop lanes'))
    for target,spec in obj.get('additions',{}).items(): targets.append((target,spec['sha256'],'copied runtime addition'))
    for target,spec in obj.get('helpers',{}).items():targets.append(('extensions/'+target,spec,'copied background helper'))
    for target,digest,role in targets:
        p=NM+owner+'/'+target
        if not (ROOT/p).exists():
            transform_rows.append({'lock_file':path,'installed_file':p,'expected_sha256':digest,'actual_sha256':'','result':'not-present-at-cli-root','role':role});continue
        read(p,'patched-source/hash-inspected')
        actual=hashlib.sha256((ROOT/p).read_bytes()).hexdigest()
        transform_rows.append({'lock_file':path,'installed_file':p,'expected_sha256':digest,'actual_sha256':actual,'result':'match' if digest==actual else 'MISMATCH','role':role})

# Read-only build/source dispositions: distinguish generated runtime wording from
# guards that run only while preparing the package. This does not close every
# runtime exception consumer or every unreferenced source helper.
transform_notes={
 'scripts/background-resource-transform.mjs':'Applies upstream/background-flow/resource-edits.json and copies helpers; emitted human text attributed to resource-edits/helpers, anchor mismatch is build-only.',
 'scripts/background-widget-transform.mjs':'Widget claim/lifecycle adaptation; introduces no new human label. Its source-anchor exception is build-only; runtime rethrow preserves original error.',
 'scripts/code-previews-transform.mjs':'Exact mutation-path semantics only; no generated UI literal. Contract/unknown-path errors execute in build applier.',
 'scripts/pi-path-utils-transform.mjs':'Read-path fallback and exact write-path semantics only; no generated UI literal. Contract/unknown-path errors execute in build applier.',
 'scripts/pi-provider-receipts-transform.mjs':'Provider conversion/accounting hooks plus OAuth branding; local HTML text boundary attributed to pi-ai oauth-page. No panel localization added.',
 'scripts/vcc-goals-transform.mjs':'Goal metadata/summary extraction; Session Goal header is summary/history structure, not standalone dialog. Source-anchor error is build-only.',
 'scripts/webaio-redirect-transform.mjs':'Script end-tag parsing correction only; no generated UI literal. Anchor error executes in build applier.',
 'scripts/build-textguard.mjs':'Builds pinned helper artifacts; shown compiler/inventory/integrity messages are build-only. Runtime TextGuard request-withheld UI originates in the content-policy transform and Jouzu adapter, not these build checks.',
}
for path,note in transform_notes.items():
    read(path,'transform-source-reviewed')
    files[path][0]='reviewed-transform-disposition; not whole runtime semantic closure'
    files[path][1]+='; '+note

# A terminal-sink scan does not classify browser UI. Keep this known boundary
# unfinished even when template.js contains no match for the bounded sink pattern.
html_viewer = src(PI,'dist/core/export-html/template.js')
read(html_viewer,'unfinished-exported-html-viewer')
files[html_viewer][0] = 'unfinished-exported-html-viewer-semantic-inventory; mechanical-scan-only'
files[html_viewer][1] += '; Exported HTML viewer controls and states remain unreviewed; absence of terminal sink matches is not exclusion or semantic coverage.'

# Record evidence depth honestly; source-family references are file-level, never an
# assertion that every source line or exception in that file was semantically reviewed.
for row in rows:
    if ('Native tool-specific call and result implementation' in row['source_finding'] or
        row['state'] in ['phase-and-verifier-results','tool-success/list/details','call/add/list/remove/update/enable/disable']):
        row['evidence_level']='reviewed-route-scope; details-unresolved'
semantic_by_file={}
for row in rows:
    if row['evidence_level']=='reviewed-source-family':
        semantic_by_file.setdefault(row['source_file'],[]).append(row['surface_id'])
for path,item in files.items():
    refs=semantic_by_file.get(path,[])
    if refs:
        item[0]='reviewed-source-families; not whole-file semantic coverage; '+item[0]
        item[1]+='; reviewed family refs='+','.join(refs)
    elif item[0]=='source-inspected':
        item[0]='extracted-source-records; no reviewed semantic family'

# Every discovered render/notification sink remains mechanically sourced, even in
# a file containing reviewed families. File-level cross-reference is not closure.
seen=set(); deduped=[]
for item in source_excerpt:
    key=(item['source_file'],item['line'])
    if key in seen: continue
    seen.add(key)
    item['evidence_level']='mechanical-sink-candidate'
    item['family_refs_same_file']=';'.join(semantic_by_file.get(item['source_file'],[]))
    item['coverage_limit']='Mechanical candidate only; same-file refs do not establish exact-line semantic review or human-visible reachability.'
    deduped.append(item)
source_excerpt=deduped
unresolved=[]
for path in sorted({x['source_file'] for x in source_excerpt}):
    if path in semantic_by_file: continue
    if path.startswith(NM+WEB+'/dist/src/') and path not in {src(WEB,'dist/jouzu-extension.js'),src(WEB,'dist/src/jouzu-extension.js'),src(WEB,'dist/src/webfetch-api.js')}:
        disposition='unselected-or-support-web-route; not proven active'
    elif path.startswith(('scripts/','upstream/')):
        disposition='transform/support candidate; distinguish emitted code from applier diagnostics'
    else: disposition='unresolved-semantic-sink-candidate'
    unresolved.append({'source_file':path,'disposition':disposition,'candidate_lines':';'.join(str(x['line']) for x in source_excerpt if x['source_file']==path),
        'remaining_work':'Resolve call graph, payload ownership, implemented states and localization coverage; do not treat mechanical candidates as reviewed or rendered UI.'})
if not any(item['source_file']==html_viewer for item in unresolved):
    unresolved.append({'source_file':html_viewer,'disposition':'unfinished-exported-html-viewer; scan-absence-not-exclusion',
        'candidate_lines':'none under bounded terminal-sink pattern',
        'remaining_work':'Inventory exported HTML viewer controls, messages and state families semantically; the terminal-sink scan provides no exclusion evidence.'})
unresolved.sort(key=lambda item:item['source_file'])
write_csv('unresolved-candidates.csv',['source_file','disposition','candidate_lines','remaining_work'],unresolved)
write_csv('source-anchors.csv',list(anchor_records[0]),anchor_records)
write_csv('surfaces.csv',COLS,rows)
write_csv('files.csv',['source_file','disposition','evidence'],[dict(zip(['source_file','disposition','evidence'],[p,*v])) for p,v in sorted(files.items())])
write_csv('packages.csv',list(package_rows[0]),package_rows)
write_csv('transforms.csv',list(transform_rows[0]),transform_rows)
with (OUT/'source-sinks.jsonl').open('w',encoding='utf-8') as f:
    for item in source_excerpt:f.write(json.dumps(item,ensure_ascii=False)+'\n')
report={'basis_commit':'fe0cf0878e35236ec9716f5d3ee237fff11c3480','pi_version':pi_lock['packages'][PI]['version'],
        'surface_rows':len(rows),'surface_source_files':len({r['source_file'] for r in rows}),'file_rows':len(files),'package_rows':len(package_rows),
        'release_extension_records':len(release['packages']),'third_party_extension_records':sum(p['name']!='jouzu-camoufox-adapter' for p in release['packages']),
        'compatibility_dependency_records':len(release['compatibilityDependencies']),'pi_lock_package_records':len(pi_lock['packages']),
        'registered_slash_description_rows':sum(r['state'].startswith('registered-') for r in rows),
        'source_sink_records':len(source_excerpt),'unresolved_candidate_files':len(unresolved),'reviewed_family_source_files':len(semantic_by_file),
        'source_anchor_records':len(anchor_records),'source_anchor_kinds':dict(Counter(item['anchor_kind'] for item in anchor_records)),
        'exported_html_viewer_semantic_inventory':'unfinished; no terminal sink match is not exclusion',
        'optional_runtime_direct_package_records':len(cam_manifest['dependencies']),
        'transform_rows':len(transform_rows),'transform_results':dict(Counter(r['result'] for r in transform_rows)),
        'evidence_levels':dict(Counter(r['evidence_level'] for r in rows)),
        'owners':dict(Counter(r['owner'] for r in rows)),
        'checks':{'unique_surface_ids':len({r['surface_id'] for r in rows})==len(rows),'all_surface_sources_in_files':all(r['source_file'] in files for r in rows),
                  'source_anchor_ids_match_surfaces':[item['surface_id'] for item in anchor_records]==[r['surface_id'] for r in rows],
                  'all_source_paths_exist':all((ROOT/p).is_file() for p in files),'required_cells_nonempty':all(all(r[c] for c in COLS) for r in rows)},
        'runtime_execution':'none; source audit only; prior startup observations cited separately',
        'completion_assessment':'Primary panel/state families reviewed; exhaustive semantic audit is NOT closed. See unresolved-candidates.csv and README.md.',
        'limitations':'See README.md; mechanical source scan is not full semantic review or runtime rendering proof.'}
assert all(report['checks'].values()),report
(OUT/'validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
