"""Reproduce the source ledger at fe0cf08. Reads sources; writes only adjacent CSVs.

This is an audit artifact, not a production extractor or proof of native execution.
Run from the repository root: python3 review/ja-localization/full-ui-audit/launcher-installer/build-ledgers.py
Existing outputs are preserved unless --refresh is explicitly supplied.
"""
import csv
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
OUT = Path(__file__).resolve().parent
A = 'apps/launcher/'
F = A + 'src/'
R = A + 'src-tauri/src/'
P = 'packaging/launcher/'
APP = F + 'App.tsx'
E2E = A + 'e2e/control-center.spec.ts'
ONBOARD = A + 'e2e/onboarding.spec.ts'
NATIVE = 'Static source only; no native execution, OS-language switching, installer run, or platform dialog verification.'
BROWSER = 'Source inspection only; referenced browser tests use mocked Tauri IPC and do not prove native behavior or Japanese layout.'
rows = []

def text(file):
    return (ROOT / file).read_text(encoding='utf-8-sig')

def add(id, file, symbol, entry, state, locale, finding, test='none found', limit=BROWSER, level='source-wired', anchor=None, owner=None, source_line=None):
    source = text(file)
    needle = anchor or symbol.split('/')[0]
    position = source.find(needle)
    assert position >= 0, (id, file, needle)
    line = source_line or source[:position].count('\n') + 1
    if level == 'source-candidate':
        if 'CANDIDATE' not in finding:
            finding = 'CANDIDATE (extracted diagnostic, not a reviewed UI state): ' + finding
        limit = 'Mechanical extraction only; individual state/reachability not independently reviewed. ' + limit
    rows.append(dict(surface_id=id, owner=owner or ('installer' if file.endswith(('.nsi','.nsh')) else 'launcher-native' if file.startswith(R) else 'launcher-scripts' if file.startswith(P) else 'development-launcher' if file.startswith(('scripts/','dev-build.sh')) else 'launcher-frontend'), source_file=file, source_symbol=symbol, entry_point=entry, state=state, locale_path=locale, source_finding=f'L{line}: {finding}', evidence_level=level, existing_test=test, coverage_limit=limit))

def app(id, symbol, entry, state, keys, finding, test=ONBOARD, limit=BROWSER, anchor=None):
    add(id, APP, symbol, entry, state, 'App.locale -> messages[locale].{' + keys + '} (src/i18n.ts ja)', finding, test, limit, anchor=anchor or symbol.split('/')[0])

# Enumerated from actual render branches, not dictionary keys.
add('launcher-locale-initial', APP, 'App/locale', 'main.tsx -> App mount', 'saved preference; navigator fallback; unsupported locale', 'localStorage[jouzu.ui.language] ?? navigator.language -> resolveLocale -> messages[locale]', 'WIRED: saved value wins over navigator.language; no CLI locale/profile is read here. Unsupported languages resolve to English. document.lang and saved preference update in an effect.', F+'i18n.test.ts', anchor='const [locale')
add('launcher-locale-resolution', F+'i18n.ts', 'resolveLocale', 'App initializer', 'ja-JP; ja prefix; zh variants; unsupported; null', 'resolveLocale -> ja / zh-Hans / zh-Hant / en', 'WIRED: Japanese prefix maps to ja; unknown values and null fall back to en. Messages are indexed directly, not per-key English-fallback lookup.', F+'i18n.test.ts')
add('launcher-dictionary-contract', F+'i18n.ts', 'messages', 'App and component locale prop', 'Japanese table lookup', 'messages: Record<Locale, Messages>; ja: Messages', 'WIRED: main launcher labels use an in-source typed table, not the product Fluent catalogs. Key-parity test is dictionary evidence only.', F+'i18n.test.ts', anchor='export const messages')
add('launcher-package-bootstrap', A+'package.json', 'scripts/version', 'npm run dev/build/tauri; tauri.conf version ../package.json', 'development Vite entry; embedded production frontend; native application version', 'version/product metadata unchanged; no locale initialization in package scripts', 'WIRED: dev=vite, build=tsc --noEmit && vite build, tauri=tauri. Tauri config consumes package version for desktop version display/installer metadata. Scripts do not pass App.locale or bridge to installer language; bundle.active=false in base config needs release overlay.', 'none found', NATIVE, anchor='"scripts"')
add('launcher-html-before-mount', A+'index.html', 'html', 'WebView loads index.html', 'before React effect; tab/window document title', 'literal lang="en"; literal Jouzu Launcher title', 'GAP: initial document language is English until App effect; title is product name Jouzu Launcher and is not localized.', 'none found', anchor='<html')
app('launcher-startup-loading', 'App/!setup', 'initial control_request(status)', 'pending/hung; no page frame', 'connecting', 'WIRED: dot loader and screen-reader live status; Settings and other header actions withheld until setup or statusError; minimize/close remain.', anchor='!setup ? <section')
app('launcher-startup-error', 'readStatus', 'control_request(status) rejects or parseControlState fails', 'connection failed; retry', 'connectFailed,retry', 'GAP: localized outer failure but statusError is String(error), rendered verbatim in code, tooltip and clipboard; loader remains visible.', anchor='async function readStatus')
app('launcher-startup-copy', 'copyStatusError', 'startup failure -> Copy', 'copy; copied icon; clipboard failure', 'copy', 'WIRED: title/aria label is localized; success changes icon for two seconds, not copied text; fallback uses document.execCommand. Copy failure uses global raw error.')
app('launcher-onboarding-preferences', 'App/!setup.profile', 'modelReady === false and no profile', 'initial preferences screen', 'setupMake,setupPreferencesHint,language,languageHint,profile,setupJapaneseHint,setupContinue', 'WIRED: four language autonyms and Japanese-first switch; default follows locale === ja until user override. Continue persists profile via control_request.', anchor='!setup?.profile ? <div')
app('launcher-onboarding-language', 'japaneseChoice', 'first-use language buttons', 'locale switch; explicit Japanese-first override', 'language,profile', 'WIRED: Japanese-first choice is not UI locale persistence. Before explicit override the switch follows ja selection; changing interface locale does not alter already saved profile.', anchor='const japaneseChoice')
app('launcher-onboarding-model', 'showSetup', 'modelReady === false with profile saved', 'connect model screen', 'setupConnect,setupHint', 'WIRED: Shisa.AI and provider form share providerContent; successful model source routes to workspaces.', anchor='const showSetup')
app('launcher-onboarding-navigation', 'workspacePage', 'onboarding with recents -> Return to workspaces', 'back to model setup; attempted launch while not modelReady', 'setupWorkspaces,setupModels', 'WIRED: bypass to recents only if recents exist; opening a workspace without ready model returns to setup rather than launching.', anchor='const [workspacePage')
app('launcher-header-tooltips', 'App/header', 'status settled or failed', 'terminal; report; check/update ready; settings', 'openTerminal,reportTitle,checkUpdates,updateReady,settings', 'WIRED: each icon has localized title and aria-label. Update-ready opens System and focuses the pending row; busy update disables update button.', E2E, anchor='<header')
app('launcher-native-window-controls', 'App/isTauri', 'Tauri window header', 'minimize; close; failure', 'minimize,closeWindow', 'WIRED: no maximize button rendered; minimize/close rejection enters raw global error. Product title Jouzu stays exact.', E2E, NATIVE, anchor='{isTauri() && <>')
app('launcher-workspaces', 'App/recent', 'model configured or workspacePage override', 'folder list; ready; not-ready disabled', 'heading,intro,launch,addFolder', 'WIRED: recent folder basename/path stay unchanged; path tooltip; Open Jouzu here action; disabled when busy/not ready. ready is installation-root result, not a native startup proof.', E2E, anchor='recent.map(workspace')
app('launcher-workspaces-search-sort', 'recent', 'workspace search and sort dropdown', 'added/name/path; persisted sort; locale comparison', 'search,sort,sortAdded,sortName,sortPath', 'WIRED: Japanese labels from table; user paths never translated. name/path sort uses localeCompare(locale); added order is native array order.', 'none found', anchor='const recent =')
app('launcher-workspaces-empty', 'App/empty', 'recent empty and query empty', 'empty list', 'dropHint,addFolder', 'WIRED: actual empty state is Drop folders here plus Add folder; dictionary empty/emptyHint are not rendered.', 'none found', anchor='!query && !recent.length')
app('launcher-workspaces-no-match', 'App/noResults', 'search query matches no recent paths', 'search empty', 'noResults', 'WIRED: same noResults key is also supplied to provider picker, whose text still refers to folders in ja/en.', 'none found', anchor='query && !recent.length')
app('launcher-workspaces-drop', 'addFolders', 'native drag/drop inside list bounds', 'hover ring; accepted folders; ignored while busy/settings', 'saving', 'WIRED: drop feedback is visual ring only; saving state localized; backend validates all input folders; raw rejection enters global error.', 'none found', NATIVE)
app('launcher-folder-picker', 'chooseFolder', 'Add folder', 'native folder picker; selection; cancel', 'picker,choosing', 'WIRED: explicit localized dialog title; directory=true/multiple=false. Cancel returns no path, clears operation with no success/error message. OS buttons, location labels and file-system errors are not controlled here.', 'none found', NATIVE)
app('launcher-forget-workspace', 'forget', 'remove icon on recent row', 'remove without confirmation; success notice', 'remove,removed,saving', 'WIRED: localized tooltip/aria label includes unchanged full path; no confirm dialog; removed notice lasts four seconds. Backend only updates recent history.', 'none found')
app('launcher-launch-workspace', 'launch', 'Open Jouzu here', 'launching; requested notice; missing path/runtime', 'launching,requested', 'WIRED: launch_jouzu follows optional console repair; request success is not session success. Backend errors shown verbatim.', E2E, NATIVE, anchor='async function launch(')
app('launcher-footer-operations', 'App/footer', 'operation or notice or !ready', 'choosing; saving; launching; repair; preparing branch', 'choosing,saving,launching,removed,requested,repair,preparing', 'WIRED: footer has polite live status. preparing branch exists but no setOperation("preparing") call is present, so not an established runtime state.', 'none found', anchor='(busy || notice')
app('launcher-global-error', 'App/error', 'native/UI promise failures', 'alert; expand Technical details; dismiss', 'error,details,dismiss', 'GAP: outer text localized; String(error) shown verbatim in technical details and also as an unwrapped alert inside open Settings. No locale argument/error-code translation layer.', 'none found', anchor='{error && <div role="alert"')
app('launcher-settings-frame', 'App/settingsOpen', 'header Settings or pending update', 'providers; environment; language; system tabs', 'settings,preferences,providers,environment,general,system,dismiss', 'WIRED: localized title, screen-reader description, tab labels and explicit dismiss. Close/escape/outside close calls cancel_control only while device panel exists; pending operations are not generally cancelled.', E2E, anchor='<DialogContent showCloseButton={false}')
app('launcher-provider-shisa-disconnected', 'providerContent', 'onboarding connect or Settings/Model providers', 'not signed in', 'shisaHint,signIn', 'WIRED: Shisa.AI brand stays exact; button disabled busy or setup absent. Browser/account UI outside launcher is not audited.', ONBOARD, anchor='const providerContent')
app('launcher-provider-shisa-connected', 'providerContent/signedIn', 'Shisa login result/account status', 'connected; sign out', 'shisaConnected,signOut', 'WIRED: localized connected hint and sign-out. Backend modelReady may route out of inline onboarding; Settings retains provider card.', ONBOARD, anchor='setup?.account.signedIn ? t.shisaConnected')
app('launcher-provider-shisa-revocation', 'providerContent/revocation', 'logout clears local state but remote revoke unconfirmed', 'partial sign-out', 'signOutUnconfirmed', 'WIRED: dedicated advisory appears when revocation === unconfirmed and no device panel. Remote dashboard content not verified.', 'none found', anchor='setup?.account.revocation')
app('launcher-provider-device', 'App/device', 'control-device native event', 'waiting; URL/code read-only; open browser', 'waitingAuthorization,loginUrl,deviceCode,loginHint,openBrowser,cancel', 'WIRED: localized labels/hint; URL/code unchanged and selectable. Browser URL requires https://platform.shisa.ai/connect with no credentials; invalid URL becomes global error.', ONBOARD, NATIVE, anchor='const [device')
app('launcher-provider-device-cancel', 'configure', 'device Cancel or close Settings', 'cancel; native timeout; device cleared', 'cancel,saving', 'GAP: native cancellation eventually rejects with English cancellation/timeout text; configure finally clears device. invoke(cancel_control) is fire-and-forget without a local catch.', ONBOARD, NATIVE, anchor='async function configure(')
app('launcher-provider-list', 'providerContent/connections', 'Settings/Model providers', 'credential saved; configured without saved key; no saved rows', 'connections,credentialSaved,configuredNoKey,addConnection', 'WIRED: runtime provider names/IDs displayed unchanged; deduplicated saved credentials/custom IDs. No special empty-list explanation beyond Add provider.', E2E, anchor='setup.credentials.length + setup.customProviders.length > 5')
app('launcher-provider-list-search', 'providerQuery', 'more than five credentials + custom providers', 'search matches; no saved provider matches', 'searchProviders,addConnection', 'WIRED: search field only above threshold; empty filtered saved-provider list has no no-results copy.', 'none found', anchor='setProviderQuery(event.target.value)')
app('launcher-provider-add-edit', 'addingConnection', 'Add provider or saved provider row', 'add; editable custom; built-in/advanced custom', 'editConnection,addConnection,backConnections,service', 'WIRED: editable custom locks provider selector/ID; non-editable custom routes as built-in form, not full JSON editing.', E2E, anchor='(inlineProviders || addingConnection)')
add('launcher-provider-picker', F+'components/ui/provider-picker.tsx', 'ProviderPicker', 'provider form Service combobox', 'open; filter; ArrowUp/Down; Enter; dismiss', 'props from App messages[locale]', 'WIRED: custom Popover passes localized label/search/placeholder; dynamic provider names unchanged; query resets on open/close.', E2E)
add('launcher-provider-picker-no-match', F+'components/ui/provider-picker.tsx', 'ProviderPicker/filtered', 'search unmatched provider', 'no results', 'App passes t.noResults -> empty prop', 'GAP: empty text comes from folder-specific noResults: ja="一致するフォルダーはありません。"; runtime wire is provider search, not folders.', 'none found', anchor='!filtered.length')
app('launcher-provider-key', 'providerContent/token', 'built-in provider selected', 'password entry; empty disabled save; saved key remove', 'apiKey,save,removeCredential', 'WIRED: key not read back; Save disabled if blank. No removal confirmation; backend sanitized English mutation error is relayed if failure.', E2E, anchor='connectionMode === "builtin" && provider')
app('launcher-provider-model', 'providerContent/defaultModel', 'built-in provider selected', 'model dropdown; empty models; save immediately', 'defaultModel', 'WIRED: runtime model names retained; empty models yields dropdown without a separate localized unavailable reason; selection invokes default-model immediately.', 'none found', anchor='Label>{t.defaultModel}')
app('launcher-provider-custom', 'providerContent/custom', 'Service -> Custom provider', 'new/edit; optional key; ID/URL/model required', 'customHint,providerId,endpoint,modelId,apiKey,save', 'WIRED: labels and 32K/4K capability hint localized. Save chains custom-provider then optional provider-key; if second fails custom provider may already be saved. Form client only checks nonempty; detailed rejection uses sanitized English backend message.', ONBOARD, anchor='connectionMode === "custom" &&<div')
app('launcher-environment-empty', 'readEnvironment', 'Settings opens; Environment tab', 'loading; empty rows; read failure', 'environment,envHint,addEntry,save', 'WIRED: Add/Save disabled until envLoaded; no explicit empty/loading text. Read failure becomes global raw alert.', E2E)
app('launcher-environment-edit', 'App/envRows', 'Environment -> Add variable/Edit', 'password edit; name; enable; delete unsaved row', 'variableName,variableValue,editValue,enabled,deleteEntry,addEntry', 'WIRED: variable name tooltip remains exact; values masked while editing; delete has localized aria label but no confirmation. Changes stay local until Save.', E2E, anchor='envRows.map(')
app('launcher-environment-save', 'saveEnvironment', 'Environment -> Save', 'saving; successful edit collapsed; validation/protection failure', 'save,saving', 'GAP: Rust validation and storage messages displayed verbatim in English; no environment-specific success notice. Refreshing setup after successful file write can still fail and show global error.', E2E)
app('launcher-general-language', 'App/general', 'Settings -> Language', 'locale dropdown; persistence; UI profile independence', 'language,languageHint', 'WIRED: dropdown labels English/日本語/简体中文/繁體中文; changing locale updates all main tables and local component tables without restarting. No native/installer preference is updated.', E2E, anchor='<TabsContent value="general"')
app('launcher-general-profile', 'App/profileSwitch', 'Settings -> Language -> Japanese-first mode', 'on/off; disabled busy/setup missing', 'profile,profileHint,profileOffHint', 'WIRED: independent control_request(profile) stores ja/core; translated explanation does not imply answer language is fixed by launcher locale.', E2E, anchor='id="japanese-first"')
app('launcher-system', 'App/system', 'Settings -> System', 'versions; updater/component rows; optional crash and report', 'system,unavailable', 'WIRED: Jouzu and launcher versions separate; missing values localized as unavailable. Runtime files + config determine updater flags; development variable has no rendered badge.', E2E, anchor='<TabsContent value="system"')
app('launcher-system-recovery', 'App/repair_jouzu', 'System -> missing Jouzu version outside Vite DEV', 'repair action; native warning confirmation; cancel; busy; failure', 'saving', 'WIRED: recoveryText[locale] action/title/description supplied to native confirm. No explicit confirm/cancel button text is set. Missing control-service startup may require opening Settings from statusError. Raw recovery failure becomes global alert.', 'none found', NATIVE, anchor='if (!await confirm(recoveryText')
add('launcher-recovery-copy', F+'recovery-text.ts', 'recoveryText', 'App missing-component repair', 'confirm description/title/action Japanese', 'recoveryText[locale]', 'WIRED: separate four-locale table; restore installer-carried version and preserve settings/sign-ins/projects claim is explained. No locale fallback or key-parity test for this table.', 'none found', NATIVE)
app('launcher-console-repair-pending', 'repairConsole', 'launch -> console_repair_needed true', 'installing Windows Terminal dialog', 'consoleRepairTitle,consoleRepairHint,installingUpdate', 'WIRED: repair runs before launch_jouzu; spinner/status localized; error detail retained in repair state but not rendered.', E2E, NATIVE)
app('launcher-console-repair-failure', 'App/repairDialog', 'terminal_install rejects during launch', 'failed; retry; close/outside/escape', 'consoleRepairFailed,retry', 'WIRED: localized generic failure hides raw repair.error. Retry installs Terminal but does not itself resume the original launch call. Closing dialog clears UI state without cancelling terminal_install.', 'none found', NATIVE, anchor='<Dialog open={repair !== null}')
app('launcher-crash-records', 'App/diagnostics', 'System with diagnostics.crashes > 0', 'crash list; timestamp; version/location; message; dismiss', 'crashTitle,crashHint,dismiss', 'GAP: headings localized; panic/WebView2 message/location retained verbatim; timestamp uses toLocaleString() without selected launcher locale. Dismiss uses try/finally without catch; native rejection has no explicit translated alert.', F+'diagnostics.test.ts', NATIVE, anchor='diagnostics !== null')
add('launcher-diagnostics-unavailable', F+'diagnostics.ts', 'parseDiagnostics', 'refreshDiagnostics -> native diagnostics', 'missing/invalid result; malformed entries', 'none; hide card', 'WIRED: null answer or failures suppress crash section, not a localized error. Only path/message/time types are required even though version/location are displayed.', F+'diagnostics.test.ts')
add('launcher-report-section', F+'report-section.tsx', 'ReportSection', 'Settings/System -> Report a problem', 'GitHub open; busy; failure; Open log folder', 'messages[locale].{reportTitle,reportAction,logsOpen}', 'WIRED: localized actions; failures shown String(failure) unchanged. This UI does not invoke bug_report or show a report-draft form.', E2E)
add('launcher-report-target', F+'report.ts', 'openReport', 'header bug button or ReportSection', 'open issues page', 'none; URL preserved', 'WIRED: opens https://github.com/shisa-ai/jouzu/issues (not /issues/new). Header calls void openReport() without catch; section catches failures. Browser text is external.', 'none found', NATIVE)
add('launcher-dialog-default-close', F+'components/ui/dialog.tsx', 'DialogContent', 'console repair and launcher restart confirmation', 'screen-reader close control; escape/outside close', 'literal Close; no locale prop', 'GAP: default close icon has sr-only English "Close" in Japanese dialogs. Settings opts out and uses localized dismiss; these two dialogs retain default.', 'none found', anchor='<span className="sr-only">Close')
add('launcher-dialog-unused-footer', F+'components/ui/dialog.tsx', 'DialogFooter', 'no current production import/call', 'showCloseButton optional', 'literal Close', 'EXCLUDED: footer helper contains visible English Close but no current production caller; do not count it as reachable.', 'none found', level='source-unreferenced')
add('launcher-narrow-page-frame', F+'components/launcher-page.tsx', 'LauncherPage', 'onboarding/workspaces headings', 'narrow width; long Japanese description; long action label', 'localized props; description title tooltip', 'UNKNOWN: fixed two-row heading grid truncates description with full title tooltip; title and action column can compete. Existing geometry test is English default viewport, not Japanese minimum-width validation.', ONBOARD)
add('launcher-narrow-settings', APP, 'App/settings narrow', 'Settings at min window 560x480', 'narrow/short; long provider/variable/error text', 'same locale tables', 'UNKNOWN: sidebar w-36 (sm:w-48), bounded 85dvh dialog and ScrollArea; many buttons nowrap/min-height and raw error may wrap. No Japanese narrow/DPI test found.', 'none found', anchor='h-[min(560px,85dvh)]')
add('launcher-narrow-list', APP, 'App/recent narrow', 'recent paths or search at min window width', 'long path; filtered list; scroll', 'localized labels; unchanged paths', 'UNKNOWN: basename/path truncate with title tooltip; fixed w-40 sort leaves search remainder. Native drag target scaling uses devicePixelRatio, not tested here.', 'none found', anchor='w-40 shrink-0')
add('launcher-motion-state', F+'styles.css', 'prefers-reduced-motion', 'OS motion preference', 'loader wait; transitions', 'no text; App live status provides connecting', 'WIRED: reduced motion disables loader-dot animation and all transitions; source does not disable every animate-spin utility. Visual/motion/native accessibility not executed.', 'none found', anchor='@media (prefers-reduced-motion')

# Actual update state render, one row per phase/channel plus transition rules.
U=F+'update-preview.tsx'
add('launcher-update-local-tables', U, 'labels', 'App -> UpdatePreview(locale, live)', 'Japanese System/update labels and notes shell', 'labels[locale]; noteText[locale] (separate from i18n.ts)', 'WIRED: separate four-locale tables; direct lookup, no English fallback and no shared dictionary-parity test.', E2E, anchor='const labels')
for channel,index in [('jouzu',0),('launcher',1)]:
    for phase,desc in [
        ('idle','No phase text; unconfigured row can still show version and unavailable reason.'),
        ('checking','Localized checking status + spinner; shared Check disabled while either row busy.'),
        ('current','Localized up-to-date state; no install button.'),
        ('available','Localized badge/target/action; version preserved; notes box or localized empty-notes fallback.'),
        ('downloading','Localized status; numeric progress if total known, otherwise indeterminate; no cancel action.'),
        ('installing','Localized installing status; indeterminate progress; no cancel action.'),
        ('error','Retry checks when target absent; retries installation when target retained. Error uses raw live.errors[index], only null uses localized checkFailed.'),
    ]:
        add(f'launcher-update-{channel}-{phase}', U, f'UpdatePreview/{channel}/{phase}', f'Settings/System -> update row {index}', phase, 'labels[locale]; errors passthrough; version strings unchanged', ('GAP: ' if phase=='error' else 'WIRED: ')+desc, E2E, anchor='export function UpdatePreview')
add('launcher-update-jouzu-complete', U, 'UpdatePreview/complete', 'Jouzu installation resolved', 'updated; notes; refresh component versions', 'labels[locale].updated; noteText[locale]', 'WIRED: Jouzu completion clears target; App refreshes component versions. CleanupPending returned by backend is not rendered as an extra warning.', E2E, anchor="phase === 'complete'")
add('launcher-update-unconfigured', U, 'UpdatePreview/configured', 'component_versions updater flags false', 'offline/unavailable; enabled check button with no-op hook calls', 'labels[locale].unavailable', 'WIRED: reason is generic localized Online updates unavailable for this version, not the unused i18n.ts signing/source hints. Base tauri.conf has empty signing key/endpoints; release overlay supplies configuration.', E2E, anchor='!live.configured[index]')
add('launcher-update-notes', U, 'noteItems', 'available or complete with nonempty notes', 'markdown-ish headings/bullets/plain lines; scrolling; source marker', 'noteText[locale] shell; live.notes/live.sources unchanged', 'GAP: release-note body is not translated by locale; changelog/feed content is shown verbatim. Source strings such as unavailable (...) are metadata, not localized. Source is rendered only when notes nonempty.', E2E)
add('launcher-update-empty-notes', U, 'UpdatePreview/empty notes', 'available/complete with empty notes', 'no description published', 'noteText[locale][2]', 'WIRED: Japanese fallback exists independently of main dictionary. Missing notesSource is not displayed without notes.', E2E, anchor='noteText[locale][2]')
add('launcher-update-restart-confirm', U, 'confirmRestart', 'Launcher -> Update and restart or install Retry', 'confirmation; cancel; confirm; close', 'labels[locale].{updateLauncher,restart,cancel}; default DialogContent Close literal', 'WIRED: local React confirmation, not OS native confirm. Cancel/escape/outside dismissal prevents install. Confirm calls install(1); generic default close accessibility remains English.', E2E, anchor='Dialog open={confirmRestart}')
add('launcher-update-header-focus', U, 'focusIndex', 'header update-ready', 'row highlighted and scrolled', 'no extra text; row labels localized', 'WIRED: App chooses Jouzu row first when both available, sets System tab; highlight timeout and smooth scroll do not provide a separate localized notification.', 'none found', anchor='if (focusIndex === null')
add('launcher-update-jouzu-progress', F+'use-jouzu-update.ts', 'useJouzuUpdate', 'jouzu_update IPC + jouzu-update-progress event', 'preparing/verifying/activating/staged -> installing; complete/error', 'phase identifiers -> App phase mapping -> labels[locale]', 'WIRED: only locked in-flight update listens to progress; backend strings are not localized. App collapses preparation/check/activation to Installing. No UI update cancellation.', E2E)
add('launcher-update-launcher-native', F+'use-launcher-update.ts', 'install', 'signed Tauri updater candidate', 'download; installing; quiet native installer; restart', 'frontend labels; plugin error String(e) unchanged; NSIS separate language', 'GAP: all updater plugin check/install errors displayed verbatim. install({restartAfterInstall:true}); configuration quiet means native pages not established by frontend tests.', E2E, NATIVE, anchor='async function install')
add('launcher-update-schedule', F+'update-schedule.ts', 'startUpdateChecks', 'configured hook mounts; interval; focus', 'initial visible check; silent repeat; stale-focus check', 'no extra labels during silent check', 'WIRED: interval six hours, stale-focus thirty minutes. Hooks suppress error UI for silent failures but log English diagnostics; success can change phase/candidate. Manual check does not update schedule timestamp.', F+'update-schedule.test.ts')

# Components: enumerate each real conditional branch and native confirmation.
for stem,file,title,states in [
 ('git',F+'git-bash-section.tsx','GitBashSection',[
 ('loading','No state: localized Checking; action disabled; raw read error can coexist.'),
 ('owned','Bundled then managed copy in use; localized Jouzu Git Bash plus unchanged Git version; install action disabled if no update.'),
 ('system','System copy in use; localized installed-on-this-PC text; offer installing Jouzu copy.'),
 ('missing','Nothing effective and no present copy: localized Not installed and required hint; recommended install.'),
 ('owned-broken','No effective/own usable copy but bundled/managed directory present: localized does-not-run status and Repair action.'),
 ('system-broken','No effective copy and system directory present: localized system copy broken, recommended owned install.'),
 ('older-owned','Owned working copy update_available true: localized update note and Repair and use action; version unchanged.'),
 ('busy-error','Spinner, disabled action; raw install/read error beneath row; helper state is reread on failure.')]),
 ('terminal',F+'terminal-section.tsx','TerminalSection',[
 ('loading','No state: localized Checking; action disabled; raw read error can coexist.'),
 ('owned','Bundled effective copy: localized Jouzu Windows Terminal plus file version; install action disabled.'),
 ('system','System Windows Terminal effective: localized system status and version; recommended bundled install action.'),
 ('missing','No effective host and no bundled directory: localized Not installed; recommended install.'),
 ('broken','No effective host but bundled directory exists: localized does-not-run text and Repair action.'),
 ('busy-error','Spinner, disabled action; raw install/read error beneath row; native output not localized.')]),
 ('command',F+'command-entry-section.tsx','CommandEntrySection',[
 ('loading','No state: localized Checking with disabled install action.'),
 ('broken','shims false: localized missing command files; Repair action without precedence confirmation.'),
 ('installed','shims plus first or onPath without foreign resolution: localized jz and jouzu on PATH; Remove action without confirmation.'),
 ('absent-shadowed','shims exist but not installed/precedent: localized Not installed reused from Git Bash; install action.'),
 ('busy-error','Shared row spinner/disabled action; raw helper error inline; denied native confirm returns old state.')])]:
    for state,desc in states:
        add(f'launcher-component-{stem}-{state}',file,title+'/'+state,'Settings/System -> component row',state,'messages[locale] -> ComponentSection props', 'GAP: '+desc if state=='busy-error' else 'WIRED: '+desc, F+'git-bash-section.test.tsx; '+E2E if stem=='git' else E2E, anchor='export function '+title)
add('launcher-command-precedence-confirm', F+'command-entry-section.tsx', 'CommandEntrySection/confirm', 'foreign jz or jouzu resolves outside managed directory -> Install', 'native warning; allow or cancel', 'messages[locale].commandEntryConfirm; OS/default button labels', 'WIRED: localized body says another program provides jz even though check includes either command. No title/confirm/cancel label override; OS language may differ from App.locale.', E2E, NATIVE, anchor='if (provided && !await confirm')
add('launcher-component-shared-errors', F+'components/component-row.tsx', 'useComponent', 'git_bash / terminal / command_entry_report', 'invalid non-object; read failure; run failure', 'String(failure) raw; parent localized Checking', 'GAP: failed first read leaves Checking plus raw error indefinitely; run failure rereads state but has no error-code translation. ComponentSection passes raw strings to role=alert.', E2E)

# Native wiring/platform boundaries, kept separate from frontend dictionary evidence.
add('native-window-platform', A+'src-tauri/tauri.conf.json', 'windows', 'Tauri main setup builds configured window', '900x680 default; minimum 560x480; no decorations/maximize', 'product title Jouzu; OS WebView/platform locale', 'WIRED: title stays exact; frontend owns custom controls. Windows-only paths in runtime prevent inferring macOS/Linux desktop feature parity from platform() enum.', 'none found', NATIVE, anchor='"windows"')
add('native-dialog-permissions', A+'src-tauri/capabilities/default.json', 'permissions', 'main window dialog/opener IPC', 'folder open; confirm; browser links', 'no locale bridge; allowed plugin actions', 'WIRED: dialog open/confirm permissions exist; only approved Shisa/GitHub URLs permitted. Native buttons/system errors come from plugin/OS, not React tables.', 'none found', NATIVE, anchor='"permissions"')
add('native-single-instance', R+'main.rs', 'main/single_instance', 'second launcher start', 'focus existing window', 'no new text', 'WIRED: second start unminimizes/focuses existing window; no second dialog/window or translated status emitted.', 'none found', NATIVE, anchor='tauri_plugin_single_instance::init')
add('native-launch-history', R+'main.rs', 'launcher_state', 'App refresh', 'legacy folder preferences; recent history; missing application', 'native errors -> App.error unchanged', 'GAP: legacy JSON/history parse/read errors and installation-root errors use English; no locale parameter on command. Legacy recent values are paths, not translation strings.', R+'main.rs::tests', NATIVE, anchor='fn launcher_state')
add('native-launch-platform', R+'runtime.rs', 'launch', 'App launch_jouzu', 'new Windows Terminal tab or console host fallback', 'terminal title Jouzu; raw errors', 'WIRED: semicolon in install/project path prevents WT command splitting and uses console host; requested launch does not verify actual session. macOS/Linux paths not implemented by substituting platform labels.', R+'runtime.rs::path_tests', NATIVE, anchor='pub fn launch')
add('native-control-cancel-timeout', R+'control.rs', 'control_request', 'App configure/readStatus', 'concurrent request; cancellation; timeout; protocol failure', 'English native Result errors -> String(error)', 'GAP: cancellation/190-second timeout and service/response errors have no locale input; English fallback if JSON.error absent. Device event body emitted unchanged; not a native sign-in success verification.', ONBOARD, NATIVE, anchor='pub async fn control_request')
add('native-helpers-stderr-fallback', R+'launcher_script.rs', 'failure', 'Git/Terminal/command-path helper failure', 'stderr first non-frame line; fallback', 'PowerShell output or English fallback unchanged', 'GAP: strips common English PowerShell frames, not a translation step; localized PowerShell frames may be selected differently. Printed paths/errors validated by callers.', 'none found', NATIVE, anchor='pub fn failure')
add('native-secure-storage-platform', R+'environment.rs', 'protect', 'environment read/save/apply', 'Windows DPAPI; other OS unsupported', 'no locale; English Result errors', 'GAP: protect on non-Windows returns Secure environment storage is not available on this platform. DPAPI flags avoid user prompt; OS-generated errors are not translated here.', R+'environment.rs::tests', NATIVE, anchor='fn protect')
add('native-update-session-lock', R+'update_lock.rs', 'lock', 'configuration/update/recovery/session consumer', 'active sessions; writer contention; non-Windows', 'English Result errors; no locale input', 'GAP: explicit close-running-sessions message and non-Windows unsupported message; these are pre-service errors and not replaced by update-service sanitized message.', R+'update_lock.rs::tests (Windows only)', NATIVE, anchor='pub fn lock')
add('native-recovery-active-interrupted', R+'recovery.rs', 'restore_bundled', 'repair_jouzu', 'operation.lock present; failed startup; active selection backup', 'English Result errors -> App global alert', 'GAP: operation.lock blocks recovery; advice to restart/retry does not remove stale lock. Restore checks bundled startup, saves recovery.json then removes active.json; it is not UI rollbackJouzu invocation.', R+'recovery.rs::tests', NATIVE, anchor='pub fn restore_bundled')
add('native-application-selection', R+'active_app.rs', 'resolve_app', 'launch/control/update/report', 'bundled default; invalid/incomplete selected version', 'English Result errors', 'GAP: selection errors propagate to launch/control callers. component_versions deliberately suppresses them and returns null Jouzu, permitting repair channel.', R+'active_app.rs::tests', NATIVE)
add('native-component-versions-flags', R+'main.rs', 'component_versions', 'App mount and post-install refresh', 'missing slot metadata; updater configured/unconfigured', 'data only; localized frontend unavailable', 'WIRED: app slot resolution/metadata errors collapse to null Jouzu; launcher update flags independent. Flags check file/config presence, not native endpoint availability/signature qualification.', 'none found', NATIVE, anchor='fn component_versions')
add('native-renderer-failure', R+'renderer.rs', 'failure', 'WebView2 ProcessFailed -> logs -> next System crash card', 'browser/render/frame/GPU/utility failure; reason; exit code', 'English SDK-kind/reason names; raw message in crash record', 'GAP: Windows-only native callback composes English webview failure text; frontend does not translate crash record content. Other platforms watch is no-op.', R+'renderer.rs::tests (Windows only)', NATIVE, anchor='fn failure')
add('native-panic-crash-record', R+'logs.rs', 'install_panic_hook', 'Rust panic -> crash record -> System', 'retained/pruned crash record; missing logs; dismiss', 'panic message/location unchanged', 'WIRED: max five crash files, invalid entries ignored; no log-write failure blocks operation. Source location/panic error exact, not a user-facing translation target by default.', R+'logs.rs::tests', NATIVE)
add('native-report-draft-unreached', R+'bug_report.rs', 'draft', 'registered bug_report IPC; no current frontend caller', 'reporter available/unavailable; English runtime identity', 'not App.locale; payload reporter', 'EXCLUDED: draft command is registered but current ReportSection/openReport only open issues URL. Do not count payload draft form or English facts as current reachable launcher screen.', P+'bug-report.test.mjs', NATIVE, 'source-unreferenced', anchor='pub fn draft')
add('native-components-library-unreached', R+'components.rs', 'Release', 'src-tauri/src/lib.rs -> public components module', 'validation/download-plan errors', 'English library errors; no main.rs mod components', 'EXCLUDED: pure release-plan library and tests; main binary does not import it, so its validation strings are not runtime UI.', R+'components.rs::tests', NATIVE, 'source-unreferenced', anchor='pub struct Release')
add('native-console-failure-pause', R+'bin/console.rs', 'main', 'desktop launch console.exe', 'nonzero exit; error; Press Enter to close', 'literal English; no locale input', 'GAP: console failure writes Jouzu: {error}; then Jouzu exited with code {code}. Press Enter to close. This launcher-owned failure pause is included; interactive Jouzu terminal panels are excluded.', R+'bin/console.rs::tests', NATIVE, anchor='eprintln!("Jouzu exited')
add('native-console-entry-error', R+'bin/console.rs', 'run_entry', 'jz.exe/jouzu.exe installed copies', 'missing root; session error; host continuation', 'Jouzu: {error}; product CLI output delegated elsewhere', 'BOUNDARY: entry prints raw launcher/bootstrap errors and returns shell prompt, no desktop pause. Main product CLI noninteractive reports and terminal UI are outside this ledger.', R+'bin/console.rs::tests', NATIVE, anchor='fn run_entry')

# NSIS pages and platform-supplied dialogs: template/config execution is not proven.
I=P+'installer.nsi'; H=P+'installer-hooks.nsh'; M=P+'installer-messages.nsh'
add('installer-language-selection', I, '.onInit', 'full setup interactive start', 'language selection; remembered preference; cancel', 'MUI_LANGDLL_DISPLAY; MUI_LANGDLL_ALLLANGUAGES; HKCU Installer Language', 'WIRED: English/Japanese/SimpChinese/TradChinese selected in tauri.conf; NSIS preference separate from localStorage UI locale. Language selector and standard button translations supplied by NSIS/Tauri, not checked in as rendered text.', 'none found', NATIVE, anchor='Function .onInit')
add('installer-update-language-fallback', I, '.onInit/UpdateMode', '/UPDATE or quiet updater installer', 'no language prompt; remembered value or English', 'StrCpy $LANGUAGE 1033 -> registry Installer Language override', 'GAP: English fallback for update/silent initial use; no bridge from selected App.locale to installer language. A Japanese launcher does not establish Japanese native setup text.', P+'update-configuration.test.mjs', NATIVE, anchor='StrCpy $LANGUAGE 1033')
for id,anchor,state,desc in [
 ('welcome','!insertmacro MUI_PAGE_WELCOME','welcome','Standard MUI welcome/navigation; skipped passive.'),
 ('license','!insertmacro MUI_PAGE_LICENSE','license conditional','Only when LICENSE nonempty; legal body remains source language; acceptance/navigation supplied by MUI.'),
 ('install-mode','!insertmacro MULTIUSER_PAGE_INSTALLMODE','per-user/per-machine conditional','Only template INSTALLMODE=both; current bundling explicitly currentUser, so not established in shipped installer.'),
 ('directory','!insertmacro MUI_PAGE_DIRECTORY','choose location','Standard location/browse/error labels; current-user default LOCALAPPDATA/Shisa.ai/Jouzu; prior location restored.'),
 ('start-menu','!insertmacro MUI_PAGE_STARTMENU','start menu conditional','Page skipped if STARTMENUFOLDER empty; generated build input not inspected as native artifact.'),
 ('installing','!insertmacro MUI_PAGE_INSTFILES','install progress/details','Progress/details standard strings; no autoclose in normal interactive finish transition; system copying/errors external to tables.'),
 ('finish','!insertmacro MUI_PAGE_FINISH','completed; run app; create desktop shortcut','Uses createDesktop Tauri language key as readme action and MUI run toggle; not a translated local dictionary screen.'),
 ('uninstall-confirm','!insertmacro MUI_UNPAGE_CONFIRM','uninstall confirm and Delete app data checkbox','MUI body + injected deleteAppData key checkbox; preference retrieved by MUI_UNGETLANGUAGE; no launcher localStorage read.'),
 ('uninstalling','!insertmacro MUI_UNPAGE_INSTFILES','uninstall progress/completion/error','Standard progress text; passive/update auto-close. Confirmation omitted passive; silent avoids standard pages.')]:
    add('installer-page-'+id,I,'MUI/'+id,'Windows setup/uninstall executable',state,'NSIS MUI + generated Tauri language_files -> $LANGUAGE','UNKNOWN (native): '+desc,'none found',NATIVE, anchor=anchor)
for state,desc in [
 ('same','alreadyInstalledLong/addOrReinstall/uninstallApp; chooseMaintenanceOption.'),
 ('upgrade','olderOrUnknownVersionInstalled/uninstallBeforeInstalling/dontUninstall; older/unknown marker.'),
 ('downgrade','newerVersionInstalled; dontUninstallDowngrade disabled if ALLOWDOWNGRADES=false.'),
 ('previous-uninstall-cancel','MSI exit 1602 or NSIS exit 1 aborts back to maintenance selection; no separate translated new error.'),
 ('previous-uninstall-failed','Other nonzero or remaining main executable shows unableToUninstall and aborts.'),
 ('passive-update','Passive calls leave handler; /UPDATE always proceeds without uninstall after WiX branch; no normal maintenance prompt.')]:
    add('installer-maintenance-'+state,I,'PageReinstall/'+state,'previous installation detected',state,'Tauri language keys $(...) + $LANGUAGE','WIRED (template): '+desc,'none found',NATIVE,anchor='Function PageReinstall')
add('installer-downgrade-silent', I, 'EarlyChecks', 'silent install when downgrades disabled', 'downgrade refused; console output', '$(silentDowngrades) -> $LANGUAGE', 'WIRED (template): attaches parent console and writes localized key, then aborts; release-generated allow_downgrades value not established by frontend tests.', 'none found', NATIVE, anchor='Section EarlyChecks')
for state,anchor,desc in [
 ('download','DetailPrint "$(webview2Downloading)"','Download progress/success/error from Tauri keys; NSISdl own errors/vendor UI remain native.'),
 ('install','install_webview2:','Embedded/download/offline bootstrapper; installing/success/error/abort Tauri keys; WebView2 installer external.'),
 ('old-runtime-retry','MB_ABORTRETRYIGNORE','Existing runtime below minimum: native Abort/Retry/Ignore with webview2InstallError; Retry reruns and Ignore continues.'),
 ('update-skip','; Skip if updating','Missing WebView2 setup skipped /UPDATE; no separate translated recovery prompt here.')]:
    add('installer-webview-'+state,I,'WebView2/'+state,'WebView2 missing or below minimum',state,'$(webview2*) -> $LANGUAGE; external Microsoft installer','UNKNOWN (native): '+desc,'none found',NATIVE,anchor=anchor)
add('installer-running-app-macro', I, 'CheckIfAppIsRunning', 'pre-install/uninstall after Jouzu hooks', 'app running; close/retry/abort behavior inherited', 'generated utils.nsh / Tauri language files (not in tree)', 'UNKNOWN: CheckIfAppIsRunning macro is invoked, but expanded utils.nsh/plugin messages are not in this repository. Hooks do not prove all native running-process text is Japanese.', 'none found', NATIVE,anchor='!insertmacro CheckIfAppIsRunning')
add('installer-process-close-confirm',H,'JOUZU_STOP_ALL','full install or uninstall','warning; OK/Cancel; cancel aborts','$(jouzuCloseSessions) -> $LANGUAGE','WIRED: localized explicit save-work warning; skipped silent; process helper failure uses localized jouzuCloseFailed plus unchanged $1 technical detail. Passive is not checked by this macro, so do not assume all passive hooks are noninteractive.','none found',NATIVE,anchor='!macro JOUZU_STOP_ALL')
add('installer-launcher-only-replace-error',H,'JOUZU_LAUNCHER_ONLY_REPLACE','launcher-only update','locked executable cannot delete/rename; abort','literal $1 helper output; no LangString wrapper','GAP: failure MessageBox displays English helper text directly; silent suppresses box, sets exit code 1. Launcher-only replacement otherwise leaves active sessions running.','none found',NATIVE)
add('installer-prepare-partial',H,'NSIS_HOOK_POSTINSTALL','full installer component preparation','git/terminal failure; continue install; exit 2; warning/details','$(jouzuPrepareFailed) + $JouzuPreparationFailures','GAP: Japanese outer warning, but appended component identifiers + prepare-component output remain English with a path. Passive and silent suppress this warning dialog; DetailPrint remains.',P+'prepare-component.test.mjs (contains forbidden installer execution; do not run for this audit)',NATIVE)
add('installer-command-entry-silent-failure',H,'NSIS_HOOK_POSTINSTALL/entries','post-install copies/shims/PATH append','helper failure; no explicit user message','helper $0/$1 popped but not checked','GAP: command-entries and command-path failure outputs are discarded by hook; System row reports later state. No translated completion/error specific to these hook calls.',P+'runtime-pins.test.mjs',NATIVE,anchor='jouzu_entries_done:')
add('installer-uninstall-delete-opt-in',I,'un.ConfirmLeave','Delete app data checked','Yes/No destructive confirmation; No returns to page','$(jouzuDeleteData) -> installer-messages.nsh language','WIRED: default No; explains credentials/settings/conversations/sessions/history deletion and exclusions for projects, remote accounts, separate npm/custom JOUZU_HOME. System buttons depend on native dialog.', 'none found',NATIVE,anchor='Function un.ConfirmLeave')
add('installer-uninstall-delete-incomplete',I,'Uninstall/delete failed','confirmed deletion partially fails','incomplete; preserve program/uninstaller; retry','$(jouzuDeleteFailed)','WIRED: localized data-loss/retry warning; may already have deleted some data. Unlike other boxes this MessageBox is not guarded by IfSilent at this point; actual silent state reachability not executed.','none found',NATIVE,anchor='MessageBox MB_OK|MB_ICONSTOP "$(jouzuDeleteFailed)"')
add('installer-uninstall-program-incomplete',I,'Uninstall/remove failed','updates/runtime/git or hook leftover files','abort/retry advice','$(jouzuRemoveFailed)','WIRED: localized locked-program message; hook also checks payload/runtime/shims/old executables. Native file locks/process timing not verified.','none found',NATIVE,anchor='MessageBox MB_OK|MB_ICONSTOP "$(jouzuRemoveFailed)"')
add('installer-os-shell-surface',I,'Install/metadata','install registration and shortcuts','Add/Remove Programs; shortcut names; signing/UAC/SmartScreen','PRODUCTNAME/manufacturer/version; native Windows UI','BOUNDARY: Jouzu Launcher/product/publisher retained, system security/dialog wording belongs to Windows/certificate/plugin. CurrentUser RequestExecutionLevel=user; do not assert an elevation prompt for normal setup.','none found',NATIVE,anchor='"DisplayName"')
add('installer-file-association-template',I,'APP_ASSOCIATE','conditional generated file association list','Explorer Open with item','literal Open with ${PRODUCTNAME}','EXCLUDED: English template exists but tauri.conf and current resource overlay do not configure file_associations; no established current runtime item.', 'none found',NATIVE,'source-unreferenced',anchor='"Open with ${PRODUCTNAME}"')
add('installer-extractor-vendor-dialog',P+'extract-portable-git.ps1','Invoke-PortableGitExtraction','Git preparation','private-desktop SFX progress; timeout; Win32 failure','vendor/private desktop; English timeout/system exception','UNKNOWN: script creates a private desktop to keep vendor SFX progress off user desktop. Static code is not evidence no dialog leaks under errors/security policy; no install/extraction performed.','none found',NATIVE)

add('launcher-control-protocol-error',F+'control-state.ts','parseControlState','readStatus/configure/saveEnvironment -> parseControlState','incompatible schema; malformed fields; invalid provider/model response','literal English Error; no locale argument','GAP: Configuration service response is incompatible. Restart the development launcher and retry. This can be rendered by production App as well; no locale mapping exists.',F+'control-state.test.ts; '+E2E,anchor='const fail =')
add('launcher-browser-preview-unavailable',APP,'App/browser branch','npm run dev browser without Tauri IPC','startup remains pending; no mock backend','t.connecting; unused t.preview is not rendered','BOUNDARY: production effects return early on !isTauri(); setup stays null, so plain browser preview stays loader rather than a usable launcher. E2E installs a mock IPC backend; do not treat unused preview dictionary text as reachable.','none found',BROWSER,anchor='if (!isTauri()) return;')
add('native-startup-failure-no-recovery-view',R+'main.rs','main/setup','Tauri bootstrap before App loads','data directory/window/WebView create failure','native/OS errors; expect Unable to start Jouzu launcher','UNKNOWN: setup propagates filesystem/WebView/config errors before frontend can show localized retry; expect invokes panic hook/standard panic behavior. No separate localized startup dialog is defined in this source.','none found',NATIVE,anchor='.setup(|app|')
for id,file,anchor,entry,message in [
 ('native-control-operation-fallback',R+'control.rs','Configuration operation failed','control service nonzero exit without JSON.error','Configuration operation failed'),
 ('native-update-operation-fallback',R+'jouzu_update.rs','Jouzu update failed','update service nonzero exit without JSON.error','Jouzu update failed'),
 ('native-command-report-fallback',R+'command_path.rs','Cannot read the terminal command state','PowerShell failed without usable stderr','Cannot read the terminal command state'),
 ('native-terminal-install-fallback',R+'terminal.rs','Windows Terminal installation failed','PowerShell path/result failure','Windows Terminal installation failed'),
 ('native-terminal-report-fallback',R+'terminal.rs','Cannot read the Windows Terminal state','PowerShell failed without usable stderr','Cannot read the Windows Terminal state'),
 ('native-git-report-fallback',R+'git_environment.rs','Cannot read the Git Bash state','PowerShell failed without usable stderr','Cannot read the Git Bash state'),
 ('native-git-find-fallback',R+'git_environment.rs','Git Bash is unavailable. Install it from the launcher.','PowerShell launch detection failed without usable stderr','Git Bash is unavailable. Install it from the launcher.'),
 ('native-git-install-fallback',R+'git_environment.rs','Git Bash installation failed','PowerShell install failed without usable stderr','Git Bash installation failed'),
 ('native-command-copy-fallback',R+'command_path.rs','Cannot restore the terminal command','command_entry_repair copy/shim failure without usable stderr','Cannot restore the terminal command'),
]:
    add(id,file,'fallback',entry,'missing/unusable error detail','literal English fallback','GAP: '+message,'none found',NATIVE,anchor=anchor)
for message in ['Missing application directory','Cannot find the installation directory','Missing managed directory','Could not start {}: {error}']:
    add('native-console-diagnostic-'+str(len(rows)),R+'bin/console.rs','console diagnostic','desktop console or jz/jouzu entry helper','startup/continuation failure','literal English; no locale input','GAP: '+message,R+'bin/console.rs::tests',NATIVE,anchor=message)
add('native-os-error-passthrough',R+'main.rs','main/native errors','registered commands and Tauri/plugin failures','filesystem; child spawn; JSON; window events','error.to_string() / OS/plugin text; rendered unchanged','BOUNDARY: raw dependency/OS/file/JSON errors can reach App technical details or startup code. Their set/language is environment-dependent; no finite static wording catalog or Japanese native verification is claimed. Preserve raw source error detail.','none found',NATIVE,anchor='map_err(|error| error.to_string())')
for number,line in enumerate(text(R+'renderer.rs').splitlines(),1):
    match=re.match(r'\s*(\w+|_) => "([^"]+)",',line)
    if match:
        variant,label=match.groups()
        add('native-renderer-diagnostic-'+str(number),R+'renderer.rs','kind_name/reason_name/'+variant,'WebView2 ProcessFailed -> crash record -> System crash card','SDK failure kind/reason '+variant,'raw English diagnostic label; not App locale','BOUNDARY: '+label+' | Composed diagnostic content is retained verbatim; native callback not exercised.',R+'renderer.rs::tests (Windows only)',NATIVE,'source-candidate',anchor=line.strip(),source_line=number)
add('native-renderer-no-other-platform',R+'renderer.rs','watch/non-Windows','non-Windows main setup','no WebView2 watcher','none; no text','BOUNDARY: #[cfg(not(windows))] watch is no-op; platform-specific crash recording is not parity proof.','none found',NATIVE,anchor='pub fn watch(_window:')
add('script-helper-external-errors',P+'git-environment.ps1','Get-GitEnvironment','Get-AuthenticodeSignature/process/extraction/network cmdlets','timeout; network/proxy/signature/file access error','raw PowerShell/Win32 message selected by launcher_script::failure','BOUNDARY: authored errors are enumerated separately; cmdlet/system/network error vocabulary depends on platform language. No external operations executed and no assumption native text follows App.locale.','none found',NATIVE,anchor='Get-AuthenticodeSignature')
add('script-command-entry-success-internal',P+'command-entries.ps1','Write-Output','installer or command_entry_repair','success output consumed/discarded','literal Command entries are in place','INTERNAL: Command entries are in place is not rendered as a desktop notice. Native repair subsequently rereads state; installer pops and ignores helper output.',P+'command-entries.test.mjs',NATIVE,'source-internal',anchor="Write-Output 'Command entries are in place'")

# Exact LangString definitions and their call sites: catalog membership alone is not reachability.
for key in re.findall(r'^LangString (\w+) \$\{LANG_JAPANESE\}',text(M),re.M):
    value=re.search(r'^LangString '+key+r' \$\{LANG_JAPANESE\} "(.*)"$',text(M),re.M).group(1)
    callers=[file for file in [I,H] if '$('+key+')' in text(file)]
    add('installer-lang-'+key,M,key,'; '.join(callers),'Japanese custom message definition','LangString '+key+' ${LANG_JAPANESE} -> $(...) at callers','WIRED: '+value+' | Caller references found; native rendering not established.','none found',NATIVE,anchor='LangString '+key+' ${LANG_JAPANESE}')

# Script output routing is audited independently of its strings.
add('script-control-error-map',P+'control.mjs','messages','Rust control_request -> packaged/embedded adapter','sanitized action-specific failures','English messages[action]; no locale request field','GAP: all eight action-specific error messages plus unsupported fallback are English and sent as JSON.error; Rust returns them unchanged to App. Inner validation/provider errors are deliberately suppressed, not additional user-visible errors.','none found',NATIVE,anchor='const messages =')
control_tail=text(P+'control.mjs').split('const messages =',1)[1]
for quoted,key,msg in re.findall(r"(?:^|\n)\s*(?:'([^']+)'|(\w+)):\s*'([^']*)'", control_tail):
    key=quoted or key
    add('script-control-failure-'+key,P+'control.mjs','messages.'+key,'App configure('+key+') -> control_request -> JSON.error',key+' failed','literal English; no App.locale propagated','GAP: '+msg,'none found',NATIVE,anchor=msg)
add('script-control-unsupported',P+'control.mjs','messages/fallback','unlisted action or import failure','unsupported operation','messages[action] ?? literal English','GAP: Unsupported configuration operation. Import action exists in adapter but has no current frontend caller; its failures use this fallback.','none found',NATIVE,anchor='Unsupported configuration operation.')
add('script-update-service-error',P+'update-service.mjs','catch','jouzu_update -> update-service JSON.error','source/signature/permissions/disk/staging/health error','literal English; no locale input','GAP: public fallback is Jouzu update failed. Check the update source, permissions and available disk space; the active version was not intentionally removed. Underlying arbitrary package/network messages suppressed.',P+'update-service.test.mjs',NATIVE,anchor='Jouzu update failed.')
add('script-runtime-full-installer-repair',P+'runtime-requirements.mjs','RUNTIME_REPAIR_MESSAGE','update staging detects old/missing Node or pnpm','full installer required; launcher-only/Repair insufficient','RUNTIME_REPAIR_CODE -> fixed English RUNTIME_REPAIR_MESSAGE','GAP: exact user guidance: '+re.search(r"RUNTIME_REPAIR_MESSAGE = '([^']*)'",text(P+'runtime-requirements.mjs')).group(1),P+'runtime-requirements.test.mjs; '+P+'update-service.test.mjs',NATIVE,anchor='export const RUNTIME_REPAIR_MESSAGE')
add('script-update-install-cleanup',P+'install-update.mjs','installJouzuUpdate','download -> stage -> health -> activate','cleanupPending; original failure retained; complete event','phase identifiers; JSON result; no cleanup warning UI','WIRED: cleanup failure after activation returns cleanupPending but App only shows Updated. Stage/current selection retained on failed checks; no desktop rollback button is wired.',P+'install-update.test.mjs',NATIVE)
add('script-update-rollback-unreached',P+'activate-update.mjs','rollbackJouzu','exported helper; tests only in scoped production','rollback previous or bundled slot; no UI entry','internal English errors; not launcher locale','EXCLUDED: exported rollback helper has no launcher/service caller in this tree. User repair is Rust restore_bundled, not this API.',P+'activate-update.test.mjs',NATIVE,'source-unreferenced')
add('script-bootstrap-error-boundary',P+'bootstrap.mjs','root','console.exe -> app/bootstrap.mjs','module/JSON/lock/filesystem startup failure','uncaught Node error/stack; no locale wrapper','GAP: launcher-owned bootstrap has no catch or localized error mapping; early errors surface in launched console. CLI import/output after bootstrap belongs to the other audit.','none found',NATIVE,anchor='const root =')
add('script-terminal-spawn',P+'open-terminal.mjs','spawn','header terminal_open -> helper','Jouzu-titled Git Bash tab; asynchronous spawn failure','terminal title Jouzu; raw Node error; native main generic failure','WIRED: helper detached spawn has no error listener; backend status checks helper exit, not host/tab readiness. Usage string is not normally reached because Rust supplies all arguments.',E2E,NATIVE,anchor='spawn(host')
add('script-notes-source',P+'jouzu-notes.mjs','fetchReleaseNotes','release build -> signed manifest -> UI notes','changelog section available; fetch/section failure','raw changelog; notesSource unavailable (...) marker','WIRED: exact release commit changelog travels in signed manifest. No Japanese translation selection by runtime locale; empty description localized in UpdatePreview.',P+'jouzu-notes.test.mjs',NATIVE)

# Diagnostic extraction candidates below are not independently reviewed UI states.
native_routes={
 'active_app.rs':'resolve_app -> launch/control errors or suppressed by component_versions',
 'command_path.rs':'command_entry_* -> useComponent inline alert',
 'control.rs':'control_request -> startup code block or global error',
 'environment.rs':'environment_read/save/apply -> global error (run_entry logs apply failure only)',
 'git_environment.rs':'git_bash/install or launch -> inline/global error',
 'jouzu_update.rs':'jouzu_update -> UpdatePreview raw error',
 'launcher_script.rs':'shared helper -> component/global error',
 'logs.rs':'crash_dismiss -> rejection (App handler lacks catch)',
 'main.rs':'registered command -> App raw error; main expect -> panic/startup failure',
 'managed_paths.rs':'managed root -> caller raw error or early startup failure',
 'recovery.rs':'repair_jouzu -> App raw global error',
 'runtime.rs':'launch/application root -> App raw global error',
 'terminal.rs':'terminal/report/install -> inline error or generic console repair failure',
 'update_lock.rs':'update/control/recovery preflight -> raw error',
}
for name,route in native_routes.items():
    file=R+name
    source=text(file).split('#[cfg(test)]',1)[0].split('#[cfg(all(test,',1)[0]
    for number,line in enumerate(source.splitlines(),1):
        matches=re.findall(r'(?:Err|ok_or|expect)\(\s*(?:format!\()?"([^"\n]+)"|(?:ok_or_else|map_err)\(\|[^|]*\|\s*(?:format!\()?"([^"\n]+)"',line)
        literals=[first or second for first,second in matches]
        for index,message in enumerate(literals):
            # Dynamic diagnostic prefixes (format!) remain quoted verbatim, including placeholders.
            functions=re.findall(r'^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)', '\n'.join(source.splitlines()[:number]),re.M)
            symbol=(functions[-1] if functions else 'module')+'/diagnostic@'+str(number)
            add(f'native-error-{name[:-3].replace("_","-")}-{number}-{index}',file,symbol,route,'authored diagnostic/error branch','English Result/string; no locale argument','CANDIDATE (extracted diagnostic, not a reviewed UI state): '+message+' | Caller family identified; OS/dependency substitutions preserved.','inline Rust tests in '+file if '#[test]' in text(file) else 'none found',NATIVE,'source-candidate',anchor=line.strip(),source_line=number)

# PowerShell helper diagnostics, reachable directly or through a localized NSIS wrapper.
ps_routes={
 'git-environment.ps1':('GitBashSection/git_bash_install or full installer -Prepare','raw helper stderr -> component alert; -Prepare details in diagnostic report'),
 'terminal-environment.ps1':('TerminalSection/terminal_install or full installer -Prepare','raw helper stderr -> component alert; launch repair uses generic localized failure; -Prepare diagnostic report'),
 'prepare-component.ps1':('installer JOUZU_PREPARE_COMPONENT','English summary -> $JouzuPreparationFailures inside localized warning; inner detail retained in log'),
 'command-entries.ps1':('command_entry_repair or installer postinstall','raw stderr -> row error on repair; postinstall discards output'),
 'command-path.ps1':('command_entry_use/remove/repair/report or installer hooks','raw stderr -> row error; postinstall/preuninstall result not displayed'),
 'stop-managed-processes.ps1':('JOUZU_STOP_ALL install/uninstall','raw output -> $1 in localized jouzuCloseFailed technical details'),
 'replace-locked-launcher-files.ps1':('launcher-only NSIS preinstall','raw output -> MessageBox $1 with no localized wrapper'),
 'extract-portable-git.ps1':('git-environment preparation','exception -> raw stderr or sanitized diagnostic report'),
}
for name,(route,routing) in ps_routes.items():
    file=P+name
    for number,line in enumerate(text(file).splitlines(),1):
        if not re.search(r'\bthrow\b|Write-Output "\$Component preparation|new TimeoutException',line):
            continue
        quoted=re.findall(r'(?:\bthrow\s+|Write-Output\s+|new TimeoutException\()(?:\x27([^\x27]*)\x27|"([^"]*)")',line)
        # Ignore comments and rethrow-only lines; preserve literal variable placeholders.
        if line.lstrip().startswith('#') or not quoted:
            continue
        message=' | '.join(a or b for a,b in quoted if (a or b) and (' ' in (a or b) or (a or b).startswith('$')))
        if not message:
            continue
        companion=P+name.replace('.ps1','.test.mjs')
        add(f'script-error-{name[:-4]}-{number}',file,'script/diagnostic@'+str(number),route,'failure/timeout branch','English/system text; '+routing,'CANDIDATE (extracted diagnostic, not a reviewed UI state): '+message,companion if (ROOT/companion).exists() else 'none found',NATIVE,'source-candidate',anchor=line.strip(),source_line=number)

# Sanitized updater diagnostic candidates: not direct UI and not extra reviewed states.
for name in ['authenticate-recipe','download-recipe','stage-update','activate-update','check-update-health','installed-target','verify-runtime','prune-updates','update-transport']:
    file=P+name+'.mjs'
    for number,line in enumerate(text(file).splitlines(),1):
        if 'throw ' not in line and 'reject(new Error' not in line:
            continue
        messages=re.findall(r'(?:Error\(|throw Error\()(?:\x27([^\x27]*)\x27|"([^"]*)"|`([^`]*)`)',line)
        for index,parts in enumerate(messages):
            message=next((part for part in parts if part),'')
            if not message:
                continue
            add(f'update-internal-{name}-{number}-{index}',file,'diagnostic@'+str(number),'update-service -> install/check dependencies','internal rejected validation/download/stage/health/activation/cleanup','internal English; replaced by update-service public error','CANDIDATE (internal extracted diagnostic, not a reviewed UI state): '+message+' | Caller service replaces its error; not direct renderer text.',P+name+'.test.mjs' if (ROOT/(P+name+'.test.mjs')).exists() else 'none found',NATIVE,'source-candidate',anchor=line.strip(),source_line=number)

# Development launcher authored output: no install/build/global-link command is executed.
add('development-usage','dev-build.sh','usage','./dev-build.sh --help/help/-h or invalid command','help; allowed verbs; prerequisites; lock configuration','literal English heredoc; no localization lookup','GAP: development helper help text is English. Commands, environment variables, versions, Jouzu/TextGuard/Node.js/Go names must remain exact. This is developer launcher output, not product CLI report.', 'scripts/test_dev_build.py', 'Static only; no dev-build invocation, package install, Git-hook installation or global link performed.',anchor='usage()')
for number,line in enumerate(text('dev-build.sh').splitlines(),1):
    if not re.search(r'\becho "dev-build:',line) and 'console.error(`dev-build:' not in line:
        continue
    previous=text('dev-build.sh').splitlines()[:number]
    functions=[m.group(1) for l in previous if (m:=re.match(r'(\w+)\(\) \{',l))]
    function=functions[-1] if functions else 'main'
    message=line.strip()
    add(f'development-output-{number}','dev-build.sh',function+'/output@'+str(number),'./dev-build.sh '+('install-hooks/uninstall-hooks/__hook' if 'hook' in function else 'build/link'),function+' branch','literal English stdout/stderr; no locale input','CANDIDATE (extracted script output, not a reviewed UI state): '+message,'scripts/test_dev_build.py','Hermetic POSIX fixture tests exist; not run; do not infer native Git Bash/macOS behavior.','source-candidate',anchor=message,source_line=number)
add('development-smoke-output','scripts/dev-smoke.mjs','smokeDevelopmentRuntime','dev-build build/link -> offline smoke','pass; timeout; malformed/nonidle/persistent RPC reply','literal dev-build: English messages','GAP: English runtime smoke success/failure details; bounded startup and temporary JOUZU_HOME. Product CLI output parsed, not itself a translated launcher surface.','scripts/dev-smoke.test.mjs','Static only; fixture tests can run without invoking a real build.')
add('development-build-identity','scripts/write-dev-build-info.mjs','build','npm run build:dev','version + commit/dirty identity','literal Jouzu development build: + formatDisplayVersion','GAP: helper console output prefix English; metadata formatted by CLI implementation (other audit). This file writes dist only during builds; not invoked.','none found','Static only; no dist/build mutation.',anchor='const build =')
add('development-dist-freshness','scripts/check-dist-fresh.mjs','assertFresh','dev-build after build or product test wrapper','missing/newer source; passed','literal stale dist:/dist is fresh; commands unchanged','GAP: development validation messages are English; report tells run npm run build. No product CLI report UI audited.','none found','Static only; no build invoked.')
add('development-release-bundle-output','scripts/install-release-extensions.mjs','installReleaseBundle','CLI build -> release-owned extension install','retry; required source missing; receipt warning; current/success','literal English build diagnostics','BOUNDARY: developer-install output only; no interactive extension panels included. Actual npm install never run; inherited npm/TypeScript errors outside source-authored strings.','scripts/release-bundle-receipt.test.mjs','Infrastructure dependency installer; no package manager or lifecycle scripts executed.')

# Unreferenced dictionary keys are explicitly not promoted into screens/states.
main_i18n=text(F+'i18n.ts')
en_block=main_i18n.split('const en = {',1)[1].split('\n};',1)[0]
keys=set(re.findall(r'(?:^|[,\n])\s*(\w+)\s*:',en_block))
frontend='\n'.join(text(str(p.relative_to(ROOT)).replace('\\','/')) for p in (ROOT/F).rglob('*') if p.suffix in {'.ts','.tsx'} and '.test.' not in p.name and p.name!='i18n.ts')
used=set(re.findall(r'\bt\.(\w+)',frontend)) | {'requested','removed'}
unreferenced=sorted(keys-used)
for key in unreferenced:
    add('launcher-dictionary-only-'+key,F+'i18n.ts','en/ja.'+key,'no production render reference found','dictionary-only; not a reachable UI state','messages[locale].'+key,'EXCLUDED: key exists in main table but no t.'+key+' reference or mapped dynamic use found. Component-local labels tables are separate; dictionary presence is not reachability.',F+'i18n.test.ts','Lexical cross-check of production TS/TSX plus explicit dynamic notice keys; no runtime verification.','source-unreferenced',anchor=key+':')

# Full tracked tree dispositions (including tests/config/assets as explicit exclusions/infrastructure).
tracked=subprocess.check_output(['git','ls-files','apps/launcher','packaging/launcher'],cwd=ROOT,text=True).splitlines()
extras=['dev-build.sh','scripts/dev-smoke.mjs','scripts/dev-smoke.test.mjs','scripts/test_dev_build.py','scripts/write-dev-build-info.mjs','scripts/check-dist-fresh.mjs','scripts/install-source-dependencies.mjs','scripts/install-release-extensions.mjs']
tracked=sorted(set(tracked+extras))
file_rows=[]
infra_notes={
 'prepare-windows-bundle.ps1':'Build-only authenticated runtime download/resource mapping and currentUser NSIS template/hooks selection; native installer input, not a desktop screen.',
 'finalize-windows-bundle.ps1':'Release-only signing/build/bundling; carries NSIS language config from base; no signing/account operation executed.',
 'prepare-published-runtime.mjs':'Release-only npm tarball/recipe/runtime preparation and health qualification; not installed runtime UI.',
 'prepare-starter.mjs':'Build-only frozen/offline pnpm installation; installArguments reused by stage-update; English build failures not renderer-localized UI.',
 'stage-application.mjs':'Build-only prepared prefix inventory/copy with JSON summary; not reachable desktop screen.',
 'export-recipe.mjs':'Build-only curated package export/pack invocation; no renderer call.',
 'published-input.mjs':'Infrastructure official npm tarball identity/integrity validation for build.',
 'runtime-source.mjs':'Release workflow artifact source validation via GitHub API when run; no launcher screen.',
 'check-update-feed.mjs':'Release guard compares npm/version/signed recipe; operator report, not product desktop UI.',
 'sign-recipe.mjs':'Release manifest/signature producer; notes included but not localized; signed notes rendered by UpdatePreview.',
 'sign-windows.ps1':'Release-only Artifact Signing callback/log output; Windows publisher metadata kept exact; not invoked.',
 'publish-launcher.ps1':'Release-only upload/feed generation; changelog notes used verbatim by launcher; external operations not invoked.',
 'signing-preflight.mjs':'Release-only key/identity/configuration validation; no desktop UI.',
 'verify-updater-signature.mjs':'Release-only minisign verification/operator output; not native install UI.',
 'update-configuration.mjs':'Build configuration wiring for signed feeds and quiet Windows installer; no UI language binding.',
 'package-root.mjs':'Internal module-resolution helper; called by runtime verifyRuntime as well as build/export; service replaces errors with public fallback, so not an independent desktop screen.',
 'launcher-notes.mjs':'Release-feed notes producer: reads exact version section from changelog; body reaches update UI verbatim, no selected UI-locale lookup.',
 'network-acceptance.mjs':'Acceptance harness (not shipped app entry); creates loopback server and launches target; product CLI reports/interactive UI assigned elsewhere; do not execute.',
}
for file in tracked:
    base=Path(file).name
    ids=[r['surface_id'] for r in rows if r['source_file']==file]
    refs='; '.join(ids[:10]) + ('; additional rows in surfaces.csv' if len(ids)>10 else '')
    if '.test.' in base or '/e2e/' in file or base=='test_dev_build.py':
        disp='exclusion:test'
        evidence='Existing test only; not production UI. Referenced tests inspected as evidence, not executed. '+('Mocked browser IPC; not native Japanese proof.' if '/e2e/' in file else 'Native/installer/PowerShell tests require separate safety review before execution.' if base in {'prepare-component.test.mjs','command-path.test.mjs','command-entries.test.mjs','git-environment.test.mjs','terminal-environment.test.mjs'} else 'No run result claimed.')
    elif file==R+'components.rs' or file==R+'lib.rs' or file==F+'history.ts':
        disp='exclusion:unreferenced-runtime-helper'
        evidence={'components.rs':'Pure release selection library exported by lib.rs; main binary does not declare mod components. Its English validations are not established runtime UI.', 'lib.rs':'Only exports pub mod components; main.rs separately defines launcher modules.', 'history.ts':'Workspace type used by App, but environmentLabel/rememberWorkspace helpers are not imported at runtime. Windows/macOS/Linux/WSL labels do not establish launcher platform support.'}[base]
    elif base=='package-root.mjs':
        disp='wiring:runtime'; evidence=infra_notes[base]
    elif file==A+'package.json':
        disp='wiring:bootstrap-version'
        evidence='Read: dev=vite; build=tsc --noEmit && vite build; tauri=tauri; test=vitest run. tauri.conf version=../package.json; launcher version appears in System/native package metadata. No language or native dialog locale argument. See launcher-package-bootstrap.'
    elif file==A+'index.html':
        disp='ui-producer:document-bootstrap'
        evidence='Read: initial html lang=en, document title Jouzu Launcher, root div, module /src/main.tsx. App effect later sets document.lang; title is unchanged product name. See launcher-html-before-mount; native WebView title independently set by tauri.conf.'
    elif file==P+'network-acceptance.mjs':
        disp='delegated'
        evidence='Boundary inspected: local acceptance harness drives installed product CLI catalog/status/inference commands, not launcher UI. Substantive CLI reports, provider/model rejection content and terminal UI are delegated to other audit partitions; this ledger does not claim those surfaces inspected or complete.'
    elif base in infra_notes:
        disp='wiring:runtime' if base=='package-root.mjs' else 'wiring:release-notes' if base=='launcher-notes.mjs' else 'exclusion:acceptance-harness' if base=='network-acceptance.mjs' else 'infrastructure:release-build'
        evidence=infra_notes[base]
    elif file.startswith(P) and base in {'NOTICES.md','README.md'}:
        disp='exclusion:documentation'
        evidence='Public packaging/user documentation; not production UI text. Source implementations, not narrative claims, govern this ledger.'
    elif base.endswith(('.lock','.json')) or base in {'.gitignore','tsconfig.json','vite.config.ts','vitest.config.ts','playwright.config.ts','vite-env.d.ts','build.rs'} or base.endswith(('.ico','.svg')):
        disp='wiring:configuration' if base in {'tauri.conf.json','default.json','package.json','Cargo.toml','vite.config.ts','index.html'} else 'infrastructure:build-test-asset'
        evidence='Configuration/metadata/dependency lock/type declaration/asset; not independently a translated screen. '+(refs if refs else 'Relevant runtime UI comes from App/registered IPC or NSIS, not from this file.')
    elif base=='Cargo.toml':
        disp='wiring:configuration'; evidence='Native binaries, platform dependencies and plugins; module presence does not establish native execution.'
    elif file in {R+'bug_report.rs',P+'bug-report.mjs'}:
        disp='exclusion:unreferenced-ui-adapter'
        evidence='Registered bug_report command and installed reporter helper exist, but current App/ReportSection/openReport never call the command; no reachable draft form. Tests do not establish current UI reachability.'
    elif file.startswith(F+'components/ui/') and base not in {'dialog.tsx','provider-picker.tsx'}:
        disp='wiring:ui-primitive'; evidence='Read: passes parent text/aria props; no authored natural-language labels. Layout/focus/state styling may affect Japanese rendering; no visual/native execution.'
    elif ids:
        disp='ui-producer' if any(r['evidence_level']=='source-wired' for r in rows if r['source_file']==file) else 'wiring:internal-diagnostics'
        evidence='Read implementation and caller routing; see '+refs+'. Extracted source-candidate diagnostics are leads, not individually reviewed UI states. No test execution/native verification claimed.'
    else:
        disp='wiring:runtime'
        evidence={
          'main.tsx':'React StrictMode entry mounts App and imports styles.',
          'lib.ts':'cn className merge helper; no user-facing strings.',
          'log-event.ts':'Best-effort native log_event IPC; failure ignored, not rendered.',
          'report.ts':'Opens fixed GitHub issues URL; no draft form.',
          'node_path.rs':'Windows verbatim-path conversion at Node boundary; no user-facing labels.',
          'managed_paths.rs':'Windows managed root and debug isolation; errors reflected in caller ledger.',
          'install-source-dependencies.mjs':'Developer infrastructure npm-ci wrapper; temporarily rewrites source dependency declarations/restores finally. Inherited install output; no independent authored launcher UI. Not executed.',
          'update-schedule.ts':'Timed/focus update wiring, no independent UI labels.',
          'jouzu-loader.tsx':'Four decorative aria-hidden dots; parent App supplies localized live status.',
        }.get(base,'Read source: runtime wiring/helper with no independent screen; authored diagnostics and calling UI are covered in surfaces.csv.')
    file_rows.append(dict(source_file=file,disposition=disp,evidence=evidence))

assert len(rows)==len({r['surface_id'] for r in rows}), 'duplicate surface IDs'
assert all((ROOT/r['source_file']).is_file() for r in rows)
assert all(all(str(v).strip() for v in row.values()) for row in rows), 'blank surface cell'
assert all(r['source_file'] in tracked for r in rows), 'surface outside file ledger'
for name,data,fields in [
 ('surfaces.csv',rows,['surface_id','owner','source_file','source_symbol','entry_point','state','locale_path','source_finding','evidence_level','existing_test','coverage_limit']),
 ('files.csv',file_rows,['source_file','disposition','evidence']),
]:
    target=OUT/name
    if target.exists() and '--refresh' not in sys.argv:
        assert target.read_text(encoding='utf-8').startswith(','.join(fields)+'\n'), 'Unexpected existing artifact: '+name
        print('Existing output preserved:',name)
        continue
    with target.open('w',encoding='utf-8',newline='') as handle:
        writer=csv.DictWriter(handle,fieldnames=fields,lineterminator='\n');writer.writeheader();writer.writerows(data)
print('surfaces:',len(rows))
print('files:',len(file_rows))
print('evidence_level:',dict(Counter(r['evidence_level'] for r in rows)))
print('owner:',dict(Counter(r['owner'] for r in rows)))
print('disposition:',dict(Counter(r['disposition'] for r in file_rows)))
print('dictionary-only keys:',len(unreferenced),', '.join(unreferenced))
