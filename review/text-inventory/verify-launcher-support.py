"""Read-only, source-traced checks for launcher support text and diagnostic boundaries.

This inventories definitions/transport, not observed native UI or a runtime security test.
No imports from product code, downloads, builds, or dependency execution are performed.
"""
import csv
import hashlib
import json
import re
import subprocess
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
REVISION = "346d1e481757a55eb62fc066e43bbc7999b8e6dd"
COLUMNS = ["item_id", "message_id", "english", "english_location", "display_location",
           "trigger", "consumer_evidence", "translation_boundary", "evidence"]
SCOPE_COLUMNS = ["source", "status", "coverage", "sha256", "revision", "detail"]
RUST = "apps/launcher/src-tauri/src/"
FRONT = "apps/launcher/src/"
SPECS = []


def text(path):
    return (ROOT / path).read_text(encoding="utf-8")


def line(path, number):
    return text(path).splitlines()[number - 1]


def literals(value):
    """Exact raw string/template payloads, preserving escapes and ${...} syntax.

    The selected sites contain ordinary double/single quoted or backtick literals;
    no selected Rust raw-string literal is passed through this scanner.
    """
    result, index = [], 0
    while index < len(value):
        if value[index] not in "\"'`":
            index += 1
            continue
        quote, start = value[index], index + 1
        index += 1
        while index < len(value):
            if value[index] == "\\":
                index += 2
            elif value[index] == quote:
                result.append(value[start:index])
                index += 1
                break
            else:
                index += 1
        else:
            raise AssertionError((value, "unterminated selected source literal"))
    return result


def add(file, number, index, category, display, trigger, consumer, boundary):
    path = (FRONT if file.endswith((".ts", ".tsx")) else RUST) + file
    SPECS.append((path, number, index, category, display, trigger, consumer, boundary))


LOG_DISPLAY = "Retained managed-root/logs/launcher.log; accessible via System > Open logs (folder opener), not rendered as log lines by the launcher."
ALL_LOG_DISPLAY = "Retained managed-root/logs/launcher.log or session.log according to caller; System > Open logs opens directory, not an inline log viewer."
SESSION_DISPLAY = "Retained managed-root/logs/session.log; accessible via System > Open logs; last matching end line can enter backend report runtimeIdentity."
CRASH_DISPLAY = "Managed-root/logs/crash-{stamp}.json; System crash card renders record.message/location after diagnostics refresh."
LOG_CONSUMER = RUST + "logs.rs:22; " + RUST + "main.rs:179; " + FRONT + "report-section.tsx:18"
CRASH_CONSUMER = RUST + "logs.rs:93; " + RUST + "logs.rs:149; " + RUST + "main.rs:87; " + FRONT + "diagnostics.ts:10; " + FRONT + "App.tsx:299"
REPORT_DISPLAY = "Backend bug_report command facts/runtimeIdentity; fixed managed cache request file and helper JSON return only; no active frontend draft caller."
REPORT_CONSUMER = RUST + "bug_report.rs:64; " + RUST + "bug_report.rs:72; packaging/launcher/bug-report.mjs:41; " + RUST + "main.rs:112; " + FRONT + "report.ts:6"
OWN_LOG = "Owned fixed English diagnostic template; dynamic paths/errors/versions stay data. No i18n lookup. Native append does not apply frontend note filtering."
OWN_CRASH = "Owned fixed English diagnostic wording, shown verbatim even with a non-English launcher locale; SDK enums select owned phrases, not localized SDK strings."
OWN_REPORT = "Owned English report-facts wording, not an active UI label; paths/versions/log lines are data. No translation or redaction in this producer."
NOTE_CONSUMER = FRONT + "log-event.ts:8; " + RUST + "main.rs:190; " + RUST + "logs.rs:39; " + FRONT + "update-schedule.ts:33"
OWN_NOTE = "Owned English log template; computed JavaScript template preserved raw. log_event removes control characters, keeps at most 300 Unicode chars, drops blank notes, swallows write failures; no secret redaction."

# Every new owned prose/template occurrence is selected individually.
add("renderer.rs", 56, 0, "prose", CRASH_DISPLAY,
    "Windows: watch has a managed root, CoreWebView2 access and handler registration succeed, ProcessFailed callback has args, and crash write succeeds; this is the record location.", CRASH_CONSUMER, OWN_CRASH)
add("renderer.rs", 71, 0, "prose", CRASH_DISPLAY,
    "Windows ProcessFailed callback with args calls failure; kind was initialized to SDK default and ProcessFailedKind return status is ignored; kind_name supplies the suffix.", CRASH_CONSUMER, OWN_CRASH)
add("renderer.rs", 77, 0, "prose", CRASH_DISPLAY,
    "Windows failure formatter: cast to ICoreWebView2ProcessFailedEventArgs2 succeeds AND Reason read succeeds; append selected reason_name wording.", CRASH_CONSUMER, OWN_CRASH)
add("renderer.rs", 81, 0, "prose", CRASH_DISPLAY,
    "Windows failure formatter: extended interface cast succeeds AND ExitCode read succeeds; append numeric exit code independently of Reason success.", CRASH_CONSUMER, OWN_CRASH)
for number in range(91, 102):
    branch = line(RUST + "renderer.rs", number).split("=>")[0].strip()
    add("renderer.rs", number, 0, "prose", CRASH_DISPLAY,
        "Windows ProcessFailed failure(kind,args): kind_name match arm " + branch + (" (all remaining enum values)." if branch == "_" else "."), CRASH_CONSUMER, OWN_CRASH)
for number in range(108, 116):
    branch = line(RUST + "renderer.rs", number).split("=>")[0].strip()
    add("renderer.rs", number, 0, "prose", CRASH_DISPLAY,
        "Windows failure formatter: extended interface cast and Reason read succeed; reason_name match arm " + branch + (" (all remaining enum values)." if branch == "_" else "."), CRASH_CONSUMER, OWN_CRASH)

for number, index, trigger in [
    (21, 1, "facts(): root/runtime/git/PortableGit.exe is a file; shape is an archive-presence test, not a complete installation health check."),
    (21, 2, "facts(): root/runtime/git/PortableGit.exe is not a file; shape does not attest which runtime components are installed elsewhere."),
    (22, 2, "facts(): launcher.log cannot be read, is empty, or contains no line with substring update; scan only current file, not .1 backup."),
    (23, 2, "facts(): session.log cannot be read, is empty, or contains no line with substring end exit=; scan only current file, not .1 backup."),
    (27, 0, "facts(): Git Bash report fails or report.effective.path is not a string."),
    (31, 0, "facts(): terminal report fails or report.effective is not a string; this wording is a fallback, not proof of the actual host."),
    (32, 0, "facts(): selected slot package file cannot be read/parsed, or version field is not a string."),
    (34, 0, "facts() assembles runtimeIdentity from launcher version, archive shape, payload version, installation path, last matching update/session lines, Git Bash path and host; only draft() calls facts() in native runtime.")]:
    add("bug_report.rs", number, index, "protected-value" if number == 21 else "prose", REPORT_DISPLAY, trigger, REPORT_CONSUMER,
        "Protected shape enum value serialized as facts.shape and interpolated into runtimeIdentity; not a translated UI label. Keep stable machine values separate from report prose." if number == 21 else OWN_REPORT)

for number, index, trigger in [
    (229, 1, "launch_jouzu: runtime::launch returns Err AND managed_root resolves; record caller folder and returned error before returning same Err."),
    (234, 1, "launch_jouzu: runtime::launch returns Ok AND managed_root resolves; records spawn request before launcher_state/history writes, not child health or successful completion."),
    (339, 0, "terminal_install: application_root resolves, blocking install task joins Ok(Ok(path)), and managed_root resolves; fragment enters windows terminal install wrapper."),
    (340, 0, "terminal_install: blocking task joins Ok(Err(error)) and managed_root resolves; fragment retains helper/native error before command returns it."),
    (341, 0, "terminal_install: blocking task join fails and managed_root resolves; fragment replaces join error details in retained log."),
    (343, 1, "terminal_install: blocking task returned or join failed AND managed_root resolves; wrap one of installed-path/failed-error/failed-task fragments; application_root failure returns before logging."),
    (397, 0, "Tauri setup callback begins and managed_root resolves; appended before executable cleanup, webview directory creation and window construction, so this is not proof setup finished.")]:
    add("main.rs", number, index, "prose", LOG_DISPLAY, trigger, LOG_CONSUMER + "; " + FRONT + "App.tsx:182; " + FRONT + "App.tsx:324", OWN_LOG)
for number, index, trigger in [
    (44, 0, "repair_jouzu: application/managed roots resolve, blocking restore task joins successfully and restore_bundled returns Ok after lock, bundled metadata/health and active-selection recovery steps."),
    (45, 0, "repair_jouzu: roots resolve, blocking restore task joins successfully but restore_bundled returns Err; error retained; task join error returns before any result log."),
    (47, 1, "repair_jouzu: blocking task joins successfully, irrespective of inner restore result; wraps restored/failed fragment. UI reaches command only after recovery confirmation.")]:
    add("recovery.rs", number, index, "prose", LOG_DISPLAY, trigger, LOG_CONSUMER + "; " + FRONT + "App.tsx:290", OWN_LOG)

for number, index, trigger in [
    (82, 1, "Console mode (not jz/jouzu entry): roots, shared update lock, active app and Bash resolve; log before child spawn, so spawn may still fail."),
    (85, 1, "Console mode child status returns; code is status.code or 1 when absent; errors before status instead enter main error wrapper."),
    (104, 1, "jz/jouzu entry: no successful early Windows Terminal handoff, shared lock and app/Bash resolve; logs before environment application and child spawn."),
    (109, 1, "jz/jouzu entry: child status returns; code is status.code or 1; early host handoff returns 0 without this start/end pair."),
    (131, 1, "jz/jouzu entry apply_saved_settings: environment::apply returns Err; records error, continues launching without returning this error; environment values are not formatted here."),
    (181, 1, "Console main: run_entry or run_console returns Err AND managed_hint is Some; records fixed exit 1 plus error; may have no start row if earlier setup failed.")]:
    add("bin/console.rs", number, index, "prose", SESSION_DISPLAY, trigger, LOG_CONSUMER + "; " + RUST + "bug_report.rs:23", OWN_LOG)
add("bin/console.rs", 183, 0, "prose", "Console stderr, after optional session.log error row.",
    "Console main run_entry/run_console returns Err; print error and choose exit 1, even if managed_hint was unavailable and no log could be written.", RUST + "bin/console.rs:177", "Owned stderr wrapper already in launcher.csv; arbitrary returned native/helper error remains data, unlocalized. Actual console visibility depends on host and attached streams.")
add("bin/console.rs", 190, 0, "prose", "Console stderr then stdin pause before exit.",
    "Console executable is not named jz/jouzu (entry is None) AND resulting exit code is nonzero, including child nonzero status; print then attempt read_line, ignoring its result.", RUST + "bin/console.rs:189", "Owned direct console text already in launcher.csv; fixed Enter key name is prose; numeric exit code data. Entry mode returns to shell without this pause.")

for number, index, trigger in [
    (21, 0, "Configured updater, refresh not locked: prior candidate closes and check(timeout:20000) resolves with Update; logs available version, including silent scheduled checks."),
    (21, 1, "Configured updater, refresh not locked: prior candidate closes and check resolves null; logs current, including silent scheduled checks."),
    (22, 0, "Configured updater, refresh not locked: candidate close or update check throws; always logs String(e); only non-silent checks set visible error/phase."),
    (27, 0, "install(): candidate.current exists and lock is false; logs target version before entering download try; phase already downloading."),
    (37, 0, "install(): candidate exists, download or install({restartAfterInstall:true}) throws; logs String(e), sets visible update error and unlocks.")]:
    add("use-launcher-update.ts", number, index, "prose", LOG_DISPLAY, trigger + " Initial check is non-silent; periodic every 6h and focus after >=30min since last scheduled check are silent; manual refresh non-silent.", NOTE_CONSUMER, OWN_NOTE)
add("use-jouzu-update.ts", 26, 0, "prose", LOG_DISPLAY,
    "Configured Jouzu updater, run not locked: check OR install invoke/processing/onInstalled throws. Source wording says check even for install failure. Always logs; only non-silent run sets visible error. Initial/manual checks non-silent; periodic 6h and >=30min focus checks silent.", NOTE_CONSUMER + "; " + RUST + "jouzu_update.rs:36", OWN_NOTE)

# Serialization keys, filenames and date envelopes are protected data, not prose.
META = [
    ("logs.rs", 17, 0, "All diagnostics use managed-root/logs, separate from effective JOUZU_HOME; fixed directory name.", ALL_LOG_DISPLAY),
    ("logs.rs", 29, 0, "Before append, current file metadata length >=1MiB: attempt one rename to file.1; ignored rename failure, write can overshoot threshold; no guaranteed strict byte cap.", ALL_LOG_DISPLAY),
    ("logs.rs", 32, 0, "Directory creation succeeds and append-open succeeds: write UTC timestamp, a space and caller message; all write errors ignored.", ALL_LOG_DISPLAY),
    ("logs.rs", 46, 0, "Frontend log_event note after dropping control characters and taking first 300 Unicode chars is not whitespace-only; fixed launcher log filename.", LOG_DISPLAY),
    ("logs.rs", 55, 0, "System clock is before UNIX_EPOCH: timestamp fallback is fixed ISO UTC data.", ALL_LOG_DISPLAY),
    ("logs.rs", 64, 0, "System clock duration is nonnegative; timestamp formatted in UTC with numeric calendar fields; no localizer.", ALL_LOG_DISPLAY),
    ("logs.rs", 100, 0, "Crash write after directory creation succeeds: filename uses whole epoch seconds (or 0 before epoch); create+truncate means same-second records may overwrite.", CRASH_DISPLAY),
    ("logs.rs", 102, 0, "Crash record time field: epoch seconds, same stamp as filename at creation; later read trusts JSON time independently of filename.", CRASH_DISPLAY),
    ("logs.rs", 103, 0, "Crash record version field: compile-time CARGO_PKG_VERSION supplied by panic/renderer caller.", CRASH_DISPLAY),
    ("logs.rs", 104, 0, "Crash record location field: panic file:line or owned webview process string; no redaction.", CRASH_DISPLAY),
    ("logs.rs", 105, 0, "Crash record message field: PanicHookInfo.to_string or owned WebView2 failure formatter; no note sanitizer.", CRASH_DISPLAY),
    ("logs.rs", 108, 0, "Crash file opened successfully: one JSON object line, serialization escapes content but does not translate or redact; prune runs only after successful write.", CRASH_DISPLAY),
    ("logs.rs", 140, 0, "Panic hook has a source location: record compiler file path and source line; missing location becomes empty string; previous panic hook still runs.", CRASH_DISPLAY),
    ("logs.rs", 163, 0, "crash_records reads and parses matching filename JSON object: insert/overwrite path with actual path, not stored JSON path.", CRASH_DISPLAY),
    ("logs.rs", 164, 0, "crash_records parses matching filename numeric stamp and JSON object: insert/overwrite stamp; sorts newest filename stamp first, missing/nonobject stamp default 0.", CRASH_DISPLAY),
    ("main.rs", 90, 0, "diagnostics command managed_root resolves: logs field contains directory path, not file contents; frontend parser requires string.", "Native diagnostics JSON response; current UI offers folder opener rather than rendering logs path."),
    ("main.rs", 91, 0, "diagnostics command managed_root resolves: crashes field is logs::crash_records result, possibly empty; unreadable/malformed files skipped.", CRASH_DISPLAY),
    ("bug_report.rs", 39, 0, "facts(): launcherVersion is compile-time cargo version; helper returns it as facts.", REPORT_DISPLAY),
    ("bug_report.rs", 40, 0, "facts(): payloadVersion is selected package version or unknown fallback.", REPORT_DISPLAY),
    ("bug_report.rs", 41, 0, "facts(): installRoot is application root via lossy path conversion; not user-redacted.", REPORT_DISPLAY),
    ("bug_report.rs", 42, 0, "facts(): managedRoot is managed root via lossy path conversion; not effective JOUZU_HOME.", REPORT_DISPLAY),
    ("bug_report.rs", 43, 0, "facts(): shape field retains full/launcher-only selected by bundled archive presence.", REPORT_DISPLAY),
    ("bug_report.rs", 44, 0, "facts(): runtimeIdentity field contains assembled English prose and values; delegated reporter receives this one-line identity.", REPORT_DISPLAY),
    ("bug_report.rs", 65, 0, "draft(): caller-supplied description copied verbatim as JSON data after facts/slot resolution.", REPORT_DISPLAY),
    ("bug_report.rs", 66, 0, "draft(): caller-supplied expected copied verbatim as JSON data after facts/slot resolution.", REPORT_DISPLAY),
    ("bug_report.rs", 67, 0, "draft(): caller-supplied actual copied verbatim as JSON data after facts/slot resolution.", REPORT_DISPLAY),
    ("bug_report.rs", 68, 0, "draft(): caller-supplied reproduction copied verbatim as JSON data after facts/slot resolution.", REPORT_DISPLAY),
    ("bug_report.rs", 69, 1, "draft(): fixed managed/cache/bug-report-facts.json, created/overwritten before helper spawn; not a user-selected report destination. Cleanup best effort only after command.output returns; spawn error returns before cleanup.", REPORT_DISPLAY),
    ("main.rs", 114, 0, "bug_report wrapper: any draft Err becomes Ok JSON available:false, replacing error details.", "Native command response only; no active frontend draft consumer."),
    ("main.rs", 115, 0, "bug_report wrapper on any draft Err: title set to empty string; no fixed user prose survives.", "Native command response only."),
    ("main.rs", 116, 0, "bug_report wrapper on any draft Err: body set to empty string; no fixed user prose survives.", "Native command response only."),
    ("main.rs", 117, 0, "bug_report wrapper on any draft Err: issueUrl uses fixed GitHub new-issue endpoint; report.ts current UI independently opens issues list.", "Native command response only."),
    ("bug_report.rs", 52, 0, "Backend fallback endpoint only; returned in wrapper/helper JSON, no automatic submission.", "External GitHub browser page if a consumer uses returned endpoint."),
    ("report.ts", 4, 0, "Current UI header Report when setup or statusError, or System report action: openReport opens issues list via OS browser; no draft/log upload or file picker here.", "System browser GitHub issues page, external content."),
]
for file, number, index, trigger, display in META:
    add(file, number, index, "metadata", display, trigger,
        CRASH_CONSUMER if file == "logs.rs" and number >= 93 else REPORT_CONSUMER if file == "bug_report.rs" else LOG_CONSUMER if file == "logs.rs" else FRONT + "App.tsx:168; " + FRONT + "report-section.tsx:28; " + RUST + "main.rs:112",
        "Protected serialization key, filename, endpoint or formatting syntax; do not translate keys/tokens. Values have the ownership/retention stated in trigger; this row does not count as fixed English prose.")

# Blank English explicitly identifies an unbounded value or a behavior boundary.
BOUNDARIES = [
    ("logs.rs", 142, "Dynamic Rust panic text", "Panic hook installed when main managed_root resolves, then Rust panics; capture info.to_string and source location before invoking previous hook. Native release GUI binary has windows subsystem; previous-hook delivery/console visibility is environment-dependent.", CRASH_DISPLAY, CRASH_CONSUMER, "Rust/toolchain/dependency/user panic contents are not finite owned English here. No runtime panic exercised."),
    ("logs.rs", 130, "Best-effort retention", "After a successful crash write, scan crash-N.json numeric names, sort ascending stamp, attempt removals while list >5. Failed read_dir/remove may leave more; malformed JSON names still count for pruning. read path skips unreadable/invalid JSON and frontend filters path/message/time only.", CRASH_DISPLAY, RUST + "logs.rs:109; " + RUST + "logs.rs:159; " + FRONT + "diagnostics.ts:17", "Filename and retention protocol, not user-facing prose; no guaranteed hard cap or proof of confidentiality."),
    ("logs.rs", 178, "Dismissal guard and suppressed display", "Dismiss requires lexical candidate.parent == logs directory; no filename/schema/canonical containment check. Remove failure maps to already-gone wording. Frontend finally refreshes diagnostics but has no catch/rendered alert for rejected dismiss promise.", "System crash dismiss handler; original fixed Result strings remain in launcher.csv.", RUST + "main.rs:96; " + FRONT + "App.tsx:304", "Static guard postcondition only; not a security/containment guarantee. No deletion executed."),
    ("logs.rs", 42, "Frontend note value", "logEvent caller passes message IPC, invoke failure swallowed; note removes all control chars then truncates to 300 chars; blank result dropped. Native append/write_crash bypass this filter and do not redact arbitrary interpolated paths/errors.", LOG_DISPLAY, NOTE_CONSUMER, "Dynamic error/plugin text remains untranslated and may contain caller data; one-line guard is not secret redaction."),
    ("bug_report.rs", 10, "Last matching log line", "facts(): read whole current log file, reverse lines, choose first substring match update or end exit=. Can match arbitrary error/path text and retains timestamp/whole line; does not read .1 backup or validate structured event semantics.", REPORT_DISPLAY, RUST + "bug_report.rs:22; " + RUST + "bug_report.rs:23; packaging/launcher/bug-report.mjs:46", "Retained diagnostic values copied raw into prose, no redaction/localization. No active frontend calls draft/facts."),
    ("bug_report.rs", 83, "Delegated report title/body", "draft(): helper process returns success, stdout JSON parses; native returns any JSON value without additional shape validation. Helper discovers installed Pi module and calls buildBugReportDraft, or returns available:false plus facts if absent.", REPORT_DISPLAY, "packaging/launcher/bug-report.mjs:17; packaging/launcher/bug-report.mjs:39; packaging/launcher/bug-report.mjs:41; " + RUST + "main.rs:112", "Installed payload reporter owns generated title/body and URLs; helper unit already inventories its own usage text. No automatic network submission or user-selected file export in these sources."),
    ("main.rs", 112, "Draft failures replaced by wrapper", "Any root/slot/facts-file/helper-spawn/nonzero/JSON failure from bug_report::draft becomes Ok available:false with empty title/body and fixed new-issue URL; errors in launcher.csv are not rendered by this wrapper.", "Native command response only; current UI calls openReport instead.", RUST + "bug_report.rs:70; " + RUST + "bug_report.rs:81; " + RUST + "bug_report.rs:83; " + FRONT + "report.ts:7", "Owned fallback errors remain in launcher.csv; dynamic OS/helper stderr is suppressed here. Cache file may remain on spawn failure; no product changes."),
    ("main.rs", 184, "OS folder/browser opener failures", "System open-logs action: managed root/directory creation/open_path can fail; report-section catches String(failure) into its own alert. Browser action catches openUrl failure there; header void openReport handler lacks an explicit catch/display.", "System ReportSection local alert; header route has no explicit alert handling.", FRONT + "report-section.tsx:18; " + FRONT + "report-section.tsx:30; " + FRONT + "report-section.tsx:45; " + FRONT + "App.tsx:243", "OS/Tauri opener error strings are external, locale/environment dependent; no invented English or success guarantee."),
    ("main.rs", 340, "Terminal errors retained versus replaced UI", "terminal_install inner failure logged as failed {error}; task join failure logged failed task and returned fixed install-failed text. Automatic pre-launch repair catches result and renders translated consoleRepairFailed; System terminal component can show backend String(error).", "launcher.log and automatic-repair dialog/System terminal error; different wrappers.", FRONT + "App.tsx:180; " + FRONT + "App.tsx:192; " + FRONT + "App.tsx:324; " + FRONT + "terminal-section.tsx:31; " + FRONT + "components/component-row.tsx:24; " + FRONT + "components/component-row.tsx:56", "Log English is not translated; native/helper error values follow previous catalogs; automatic repair suppresses technical details in its dialog."),
    ("launcher_script.rs", 29, "Native/helper stderr selection", "Non-success helper routes that call failure(): lossy UTF-8 stderr, trim lines, first nonempty line not starting At / + / CategoryInfo / FullyQualifiedErrorId; otherwise caller fallback. stdout treated separately as JSON/path. Language-sensitive filters do not guarantee elimination of all PowerShell framing.", "Returned command error; can enter raw UI technical details, session/launcher logs, or wrapper suppression depending caller.", RUST + "launcher_script.rs:32; " + RUST + "git_environment.rs:13; " + RUST + "terminal.rs:28; " + RUST + "command_path.rs:26; " + RUST + "bug_report.rs:81", "Dynamic OS/PowerShell/external stderr is an explicit boundary; fixed helper producer occurrences in launcher-helpers.csv, fallback Results in launcher.csv."),
    ("control.rs", 68, "Configuration/device service data", "control_request serializes request to child stdin, reads stderr JSON lines and emits only type=device; stdout JSON returned, nonzero result.error string returned or fixed fallback. Request/token not added to support logs by this Rust module; event payload and external messages remain dynamic.", "Provider configuration UI/device event flow, not native support log output.", RUST + "control.rs:73; " + RUST + "control.rs:98; " + FRONT + "App.tsx:100", "Protected request values, JSON keys and device/service fields are data; sanitized helper error messages separately inventoried. This does not promise arbitrary external errors are secret-free."),
    ("jouzu_update.rs", 32, "Updater progress/error data", "jouzu_update child stderr lines parsing as JSON become progress events without shape filtering here; frontend listener acts only while lock.current, uses phase/downloaded/total. Nonzero stdout JSON error returns string and frontend catches/logs; fixed check-failed wrapper used for install failures too.", "Update UI progress/error and filtered frontend log note.", RUST + "jouzu_update.rs:36; " + FRONT + "use-jouzu-update.ts:14; " + FRONT + "use-jouzu-update.ts:26", "Progress field values/remote notes are service-owned data, fixed helper text already in helper unit. Source tracing only; no service executed."),
    ("environment.rs", 133, "Protected environment values", "environment_save validates names/values, serializes entries then Windows DPAPI encrypts before tempfile write/persist; environment_read decrypts/validates and returns values by IPC. UI uses password input while editing, displays name/enabled. Non-Windows protect returns fixed error; support producers do not directly enumerate values.", "Managed data/launcher-environment.bin protected storage; Settings environment UI; child process environment.", RUST + "environment.rs:81; " + RUST + "environment.rs:122; " + RUST + "environment.rs:146; " + FRONT + "App.tsx:81; " + FRONT + "App.tsx:265", "Environment entry keys/names/values are data, not diagnostic prose. DPAPI applies to this state only, not plaintext logs/crash JSON/report cache; no claim of log redaction."),
    ("App.tsx", 302, "Crash metadata direct UI", "Diagnostics fetch after Tauri mount/recovery/dismiss; no crash-created event refresh in this frontend. Parser requires logs string, crashes array and record path/message string,time number; version/location not separately validated. System card requires nonempty accepted crashes; date uses host toLocaleString without explicit selected-locale argument.", "System crash-card metadata row: localized date | raw record.version | raw record.location.", FRONT + "App.tsx:168; " + FRONT + "App.tsx:175; " + FRONT + "App.tsx:292; " + FRONT + "App.tsx:299; " + FRONT + "diagnostics.ts:17", "Host date formatting and recorded metadata are dynamic data, not fixed English; separators remain formatting."),
    ("App.tsx", 303, "Crash message direct UI", "System diagnostics snapshot has accepted nonempty crash list; map renders each record.message as React text (not HTML). Native panic and WebView2 crash sources above; externally edited record content also passes if minimal types match.", "System crash-card message paragraph, independent of selected launcher language.", CRASH_CONSUMER, "Owned renderer fragments are individually listed; arbitrary panic/file message content has no finite English source and is not translated."),
    ("App.tsx", 159, "User-requested diagnostic clipboard copy", "readStatus control request fails: statusError stores String(error); when setup absent the connection failure view shows raw statusError. Copy button copies it using navigator.clipboard.writeText, or selected temporary textarea plus execCommand(copy); copy exception enters shared error details. No report file is created by this action.", "Connection-failure code field/title and user-requested clipboard; copied status indicator lasts 2 seconds.", FRONT + "App.tsx:145; " + FRONT + "App.tsx:156; " + FRONT + "App.tsx:160; " + FRONT + "App.tsx:330", "User-directed clipboard export of dynamic service/native error, no translation/redaction in handler; browser clipboard/execCommand success is not runtime-proven."),
    ("update-preview.tsx", 109, "Update error direct UI versus silent log", "Update row phase is error: show live.errors[index] when non-null, otherwise translated checkFailed fallback. Launcher and Jouzu hooks set String(e) on non-silent checks and install failures; silent check errors log without setting visible error/phase. Notes displayed separately only in available/complete phases.", "System update row error alert; logged note separately truncated/filtered by native log_event.", FRONT + "App.tsx:286; " + FRONT + "use-launcher-update.ts:22; " + FRONT + "use-launcher-update.ts:37; " + FRONT + "use-jouzu-update.ts:26", "Plugin/service/native error strings are dynamic external data; fixed fallback label already launcher.csv. Remote notes/source text ownership remains updater/helper boundaries, not translated here."),
    ("App.tsx", 209, "No user-selected report file output", "Inspected launcher report flow only opens issues browser page or logs folder; native draft writes fixed cache and returns JSON. This file picker selects a workspace directory (directory:true,multiple:false) and adds folders; no report Save dialog/export writer in these inspected sources.", "Workspace folder picker versus fixed diagnostic files and external browser report page.", FRONT + "report.ts:7; " + FRONT + "report-section.tsx:18; " + RUST + "bug_report.rs:69; " + RUST + "bug_report.rs:83", "Source-scoped absence of file export/automatic submission; does not describe browser/downstream reporter capabilities."),
]
for file, number, title, trigger, display, consumer, boundary in BOUNDARIES:
    add(file, number, None, "boundary", display, title + ": " + trigger, consumer, boundary)


def expected_rows():
    prior = list(csv.DictReader((HERE / "launcher.csv").open(encoding="utf-8", newline="")))
    rows = []
    for serial, (path, number, index, category, display, trigger, consumer, boundary) in enumerate(SPECS, 1):
        source_line = line(path, number)
        english = "" if index is None else literals(source_line)[index]
        location = f"{path}:{number}"
        overlap = [r["item_id"] for r in prior if r["english_location"] == location and r["english"] == english and english]
        evidence = f"kind={category}; source_revision={REVISION}; source_line=" + json.dumps(source_line, ensure_ascii=False)
        if index is not None:
            evidence += f"; raw_literal_index={index}; raw_source_payload_preserved=true"
        if overlap:
            evidence += "; prior_launcher_item_id=" + ",".join(overlap)
        evidence += "; static definition/caller tracing only; no runtime/native UI execution"
        rows.append(dict(zip(COLUMNS, [f"launcher-support-{serial:04d}", f"launcher.support.{category}.{serial:04d}",
                                     english, location, display, trigger, consumer, boundary, evidence])))
    return rows


FULL_FRONT = ["log-event.ts", "use-launcher-update.ts", "use-jouzu-update.ts", "update-schedule.ts", "diagnostics.ts", "report.ts", "report-section.tsx", "components/component-row.tsx"]
SUPPORT_FRONT = ["App.tsx", "terminal-section.tsx", "update-preview.tsx"]
HELPER = "packaging/launcher/bug-report.mjs"
PRODUCERS = {"logs.rs", "renderer.rs", "bug_report.rs", "main.rs", "recovery.rs", "bin/console.rs"}


def source_paths():
    return sorted([p.relative_to(ROOT).as_posix() for p in (ROOT / RUST).rglob("*.rs")] +
                  [FRONT + p for p in FULL_FRONT + SUPPORT_FRONT] + [HELPER])


def test_start(path):
    return next((n for n, value in enumerate(text(path).splitlines(), 1)
                 if re.match(r"#\[cfg\(.*\btest\b", value)), None)


def scope_rows():
    result = []
    for path in source_paths():
        cutoff = test_start(path) if path.startswith(RUST) else None
        body = len(text(path).splitlines()) if cutoff is None else cutoff - 1
        if path.startswith(RUST):
            filename = path[len(RUST):]
            status = "fully read native non-test body"
            coverage = "owned support producer and boundary occurrences enumerated" if filename in PRODUCERS else "no additional owned support logging/report-facts prose producer"
            detail = f"Full runtime body lines 1-{body}; fixed Result errors remain in launcher.csv. "
            if filename not in PRODUCERS:
                detail += "Module returns domain/service/OS data or errors; no new append/write_crash/facts prose definition. Protocol/path/type constants and internal comments excluded as non-prose. "
            if filename == "logs.rs":
                detail += "Timestamp/envelope/JSON keys separately classified; best-effort rotation/pruning and lexical dismissal guard recorded, not runtime containment proof. "
        elif path == HELPER:
            status, coverage = "fully read supporting helper", "reporter call/JSON consumer only; fixed prose already launcher-helpers.csv"
            detail = "All 49 lines reviewed; no re-inventory of helper usage message or installed Pi reporter definitions. "
        elif path[len(FRONT):] in FULL_FRONT:
            status, coverage = "fully read frontend body", "support log producers/diagnostic/report/schedule boundaries; existing i18n labels excluded"
            detail = f"Full body lines 1-{body}; comments/imports/style/protocol tokens excluded as non-prose. "
        else:
            status, coverage = "supporting consumer only", "partial: diagnostic/report/environment/error consumer regions"
            detail = "No claim of new full-file JSX/i18n review; original launcher.csv covers owned frontend labels. App diagnostic/report/environment/clipboard/folder handlers, terminal error route, and update error/notes row revalidated where applicable. "
        detail += "Pinned published main source; static source tracing, no native UI/process execution."
        result.append(dict(zip(SCOPE_COLUMNS, [path, status, coverage, hashlib.sha256((ROOT / path).read_bytes()).hexdigest(), REVISION, detail])))
        if cutoff:
            result.append(dict(zip(SCOPE_COLUMNS, [f"{path}#test-module:{cutoff}", "excluded tests", "not user runtime text", "", REVISION,
                                                  f"cfg(test) or cfg(all(test,...)) body begins at line {cutoff}; fixtures/assertions excluded from owned runtime prose counts."])))
    for name in ["diagnostics.test.ts", "update-schedule.test.ts"]:
        path = FRONT + name
        result.append(dict(zip(SCOPE_COLUMNS, [path, "excluded tests", "not user runtime text", hashlib.sha256((ROOT / path).read_bytes()).hexdigest(), REVISION, "Test-only assertions/fixtures; not counted as runtime source occurrences."])))
    result.append(dict(zip(SCOPE_COLUMNS, ["@scope", "complete finite support remainder", "53 owned prose/template occurrences; two protected shape values; metadata/boundaries separate", "", REVISION,
        "Finite scope: all 20 native Rust modules full non-test bodies; eight full frontend support modules; one full report helper; three partial frontend consumer files. Existing fixed Result/i18n definitions and packaged helper prose remain previous catalogs; dependency/native OS wording remains installer dependency boundaries. No product source/dependency changes; no generated NSIS re-inventory. No uninspected module within this finite native support pass. External arbitrary panic/OS/service/reporter/browser text unresolved by design with ownership recorded."])))
    return result


# Guard and delivery postconditions checked against exact source bytes as well as
# the authority commit; these checks make the intended finite coverage reviewable.
GUARDS = {
    "logs.rs": ["const MAX_BYTES: u64 = 1024 * 1024;", "const MAX_NOTE: usize = 300;", "const MAX_CRASHES: usize = 5;",
                ".filter(|character| !character.is_control())", ".take(MAX_NOTE)", "if !line.trim().is_empty()",
                ".create(true).truncate(true).write(true)", "previous(info);", "candidate.parent() != Some(directory.as_path())",
                "let _ = std::fs::remove_file(path);"],
    "renderer.rs": ["let _ = unsafe { args.ProcessFailedKind(&mut kind) };", "if let Ok(extended)", "extended.Reason(&mut reason)", "extended.ExitCode(&mut code)"],
    "bug_report.rs": ["text.lines().rev().find(|line| line.contains(needle))", "let _ = std::fs::remove_file(&file);", "serde_json::from_slice(&output.stdout)"],
    "main.rs": ["windows_subsystem = \"windows\"", "bug_report::draft(&app, &description, &expected, &actual, &reproduction).unwrap_or_else(|_|", "\"available\": false"],
    "environment.rs": ["CryptProtectData(", "CryptUnprotectData(", "let encrypted = protect(&bytes, false)?;", "command.env(entry.name, entry.value);"],
    "control.rs": ["if value[\"type\"] == \"device\"", "serde_json::to_vec(&request)", ".write_all(&bytes)"],
}


def read_csv(name, columns):
    with (HERE / name).open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        assert reader.fieldnames == columns, (name, reader.fieldnames)
        rows = list(reader)
        assert all(set(r) == set(columns) and None not in r.values() for r in rows)
        return rows


def main():
    rows = read_csv("launcher-support.csv", COLUMNS)
    expected = expected_rows()
    assert rows == expected, "Inventory differs from exact source sites/route/guard specification"
    assert len({r["item_id"] for r in rows}) == len(rows)
    assert len({(p, n, i) for p, n, i, *_ in SPECS}) == len(SPECS), "Duplicate selected occurrence"
    assert sum(s[3] == "prose" for s in SPECS) == 53
    assert sum(s[3] == "protected-value" for s in SPECS) == 2
    assert all(r["english"] for r in rows if ".boundary." not in r["message_id"])
    assert all(not r["english"] for r in rows if ".boundary." in r["message_id"])
    assert read_csv("launcher-support-scope.csv", SCOPE_COLUMNS) == scope_rows(), "Source hashes/scope/exclusions changed"
    # Exact repository object authority, independent of current branch review commits.
    for path in source_paths() + [FRONT + "diagnostics.test.ts", FRONT + "update-schedule.test.ts"]:
        authority = subprocess.run(["git", "show", f"{REVISION}:{path}"], cwd=ROOT, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
        assert (ROOT / path).read_bytes().replace(b"\r\n", b"\n") == authority.replace(b"\r\n", b"\n"), path
    for name, required in GUARDS.items():
        assert all(value in text(RUST + name) for value in required), name
    # Native producer set is finite; no other Rust module calls these log writers.
    discovered = set()
    for path in (ROOT / RUST).rglob("*.rs"):
        value = path.read_text(encoding="utf-8").split("#[cfg(test)]")[0]
        if re.search(r"(?:logs::append|logs::write_crash|pub fn append|pub fn write_crash)", value):
            discovered.add(path.relative_to(ROOT / RUST).as_posix())
    assert discovered == {"logs.rs", "main.rs", "recovery.rs", "renderer.rs", "bin/console.rs"}, discovered
    assert text(FRONT + "use-launcher-update.ts").count("logEvent(") == 4
    assert text(FRONT + "use-jouzu-update.ts").count("logEvent(") == 1
    frontend_log_producers = {p.relative_to(ROOT / FRONT).as_posix() for p in (ROOT / FRONT).rglob("*.ts*")
                              if ".test." not in p.name and re.search(r"(?<!function )logEvent\(", p.read_text(encoding="utf-8"))}
    assert frontend_log_producers == {"use-launcher-update.ts", "use-jouzu-update.ts"}, frontend_log_producers
    assert "typeof entry.path === \"string\" && typeof entry.message === \"string\" && typeof entry.time === \"number\"" in text(FRONT + "diagnostics.ts")
    assert "entry.version" not in text(FRONT + "diagnostics.ts") and "entry.location" not in text(FRONT + "diagnostics.ts")
    assert not re.search(r"invoke[^\n]*[\"']bug_report[\"']", "\n".join(p.read_text(encoding="utf-8") for p in (ROOT / FRONT).rglob("*.ts*") if ".test." not in p.name))
    assert "await openUrl(ISSUES_URL)" in text(FRONT + "report.ts")
    assert "record.message}" in line(FRONT + "App.tsx", 303)
    assert "catch" not in line(FRONT + "App.tsx", 304)
    assert "role=\"alert\"" in line(FRONT + "report-section.tsx", 45)
    assert line(RUST + "bug_report.rs", 79).strip().startswith("let _ = std::fs::remove_file")
    assert text(RUST + "bug_report.rs").index(".output()") < text(RUST + "bug_report.rs").index("std::fs::remove_file(&file)")
    # Every printed path:line reference must name an existing inspected source line.
    inspected = set(source_paths())
    for row in rows:
        for path, number in re.findall(r"((?:apps/launcher|packaging/launcher)/[A-Za-z0-9_./-]+):(\d+)", " ".join(row.values())):
            assert path in inspected, (row["item_id"], "unscoped source reference", path)
            assert 1 <= int(number) <= len(text(path).splitlines()), (row["item_id"], path, number)
    counts = Counter(s[3] for s in SPECS)
    print(f"PASS launcher support: {len(rows)} rows {dict(counts)}; {len(source_paths()) + 2} source hashes/authority objects; exact sites/schema/scope/guard/delivery checks; static only")


if __name__ == "__main__":
    main()
