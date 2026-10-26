#!/usr/bin/env python3
"""Record bounded dashboard and external-receipt source consumer findings."""
import csv
import hashlib
import json
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
HEADER = ["surface_id", "owner", "source_file", "source_symbol", "entry_point", "state", "locale_path", "source_finding", "evidence_level", "existing_test", "coverage_limit"]
FULL = [
    "packages/cli/src/work-dashboard-sources.ts",
    "packages/session-ui/src/work-dashboard-controller.ts",
    "packages/session-ui/src/work-dashboard-renderer.ts",
    "packages/session-ui/src/work-dashboard-component.ts",
    "packages/cli/src/flow-control/user-input-adapters.ts",
    "examples/user-input-adapter/extension.ts",
]
TRACES = {
    "packages/cli/src/main-cli.ts": "Read dashboard assembly/source callbacks at 616-700: active catalog supplied to Flow source and job framing; controller attached before widget rendering. Not full dispatcher review.",
    "packages/cli/src/flow-control/flow-runtime.ts": "Read dashboardStatus at 157-192: projection omits context catalog, constructs local lane/task descriptions; scoped work projection consumers do not display the complete context. Not full runtime reread.",
    "packages/session-ui/src/extension.ts": "Read catalog text creation/options and session_start widget installation at 1-169: text.dashboard passes to WorkDashboardComponent, aboveEditor placement only for TUI. Not full extension reread.",
    "packages/cli/src/flow-control/pi-session-ingress.ts": "Read registerUserInputAdapter and adjacent retirement/revalidation region at 305-388. It delegates registration, not receipt rendering. Not full ingress reread.",
    "packages/cli/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js": "Read registerUserInputAdapter at 311-343: guarded methods/receipt listener forward objects; stale errors get a code and retain cause. No receipt display here.",
    "packages/cli/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js": "Read bindCore adapter forwarding at 2933-2961: no Flow binding returns fixed unsupported-host error; otherwise delegates to binding. No receipt renderer here.",
    "packages/cli/node_modules/@earendil-works/pi-coding-agent/dist/core/jouzu-flow-ingress.js": "Read registerUserInputAdapter at 199-254: passes host identity/prepared dispatch to handler with lifetime/authorization guards. No display call in inspected registration region.",
}
# An exact source fragment is a staleness anchor, not semantic proof.
FINDINGS = [
    ("dashboard-counts", FULL[2], "sectionTitle", "`${running} running`", "shared above-editor work dashboard", "nonzero running/open/done/failed section counts", "local-English-despite-catalog-sections", "sectionTitle composes running/open/done/failed English count segments independently of text.sections. Active catalog section/attention/duration support does not translate these segments. This clarifies original dashboard.summary, which did not inventory the count prose explicitly."),
    ("dashboard-states", FULL[2], "rowStatus", '` · ${unit.state}`', "dashboard row without attention", "failed/cancelled/waiting/paused; attention; stale", "stable-state-needs-separate-display-policy", "Without attention the renderer displays the raw state enum; with attention it uses text.attention and may wrap with text.markStale. Labels/details are sanitized/fitted but not translated. State storage must remain stable; display wording can be mapped separately."),
    ("flow-projection", FULL[0], "flowWorkSnapshot", 'label: sanitizeTerminalText(work.description)', "main-cli createFlowWorkSource -> controller -> dashboard renderer", "retryable/uncertain/unaccountable; disabled; scope mismatch", "catalog-reasons-plus-owned-description-framing", "Only retryable, uncertain and unaccountable work becomes Flow units. main-cli passes active catalog to reason labels; captureFlowStatusContext English host/stage fallbacks are not consumed by this projection. flow-runtime constructs unaccountable descriptions as lane <id> (<tag>) and task #<id>; the local lane/task prefixes are not arbitrary remote prose. IDs/tags remain exact."),
    ("read-errors", FULL[1], "WorkDashboardController.attach", 'next = { availability: "stale", complete: false, units: [] };', "source.read failure -> dashboard refresh", "stale read; unknown first read; retained old units; replaced attachment", "error-message-suppressed", "The read catch discards the thrown message, retains old units as stale or marks empty state unknown, and prevents late publication after detach. Dashboard source changed during the read is therefore not shown by this catch. Subscription/disposal/listener failures are also suppressed here, not English error toasts. Native layout is not executed."),
    ("receipt-seam", FULL[4], "UserInputAdapters.register lookup/subscribe", 'listener(receipt);', "registered adapter -> submit/lookup/subscription client", "snapshot/update; stale runtime; listener failure; grant refusal", "catalog-prose-forwarded-to-extension-owned-consumer", "The producer projects receipt reason.text using a lazy catalog, returning receipts or invoking listeners. It has no terminal receipt renderer. Pi loader/session/binding wrappers preserve the object while guarding lifetime; they do not convert reason.text into native UI. Grant details are replaced with a fixed authorization error; listener errors use owner.onError instead. This closes the inspected forwarding seam, not every external extension's presentation."),
    ("example-client", FULL[5], "AuthenticatedClientTransport; bindCurrent; submit; recover; start", 'setReceipt(receipt: UserInputReceipt): void;', "optional user-supplied authenticated bridge example", "submit/reconnect/receipt update; unsupported host; registration/rebind failure", "no-shipped-final-receipt-view-established", "The example requires a separately supplied authenticated transport and is not itself an extension entry. setReceipt/reportFailure are abstract interface methods. Submission/recovery failures go only to transport; registration/rebind/unsupported-host failures can additionally notify with local English External user input framing. Stable codes and receipt identities remain data. No authenticated client renderer is implemented by this module."),
]


def write_csv(name, header, rows):
    with (HERE / name).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=header, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def call_census():
    tracked = subprocess.run(["git", "ls-files", "--", "packages/cli/src", "packages/session-ui/src", "examples"], cwd=ROOT, check=True, capture_output=True, text=True).stdout.splitlines()
    calls = []
    for source in tracked:
        if not source.endswith((".ts", ".tsx", ".js", ".mjs")):
            continue
        for line, text in enumerate((ROOT / source).read_text(encoding="utf-8").splitlines(), 1):
            if re.search(r"\.registerUserInputAdapter\s*\(", text):
                calls.append({"source_file": source, "line": line, "matched_line": text.strip()})
    return calls


def build():
    files = [{"source_file": path, "disposition": "full-body-read-consumer-limits-explicit", "evidence": "Full body read in this pass; dashboard/local-copy, suppression or receipt/client seam findings recorded in surfaces.csv. Does not imply every importer/native consumer reviewed."} for path in FULL]
    files += [{"source_file": path, "disposition": "bounded-trace-only", "evidence": evidence} for path, evidence in TRACES.items()]
    surfaces, anchors = [], []
    for suffix, source, symbol, fragment, entry, state, locale, finding in FINDINGS:
        lines = (ROOT / source).read_text(encoding="utf-8").splitlines()
        matches = [(index, line) for index, line in enumerate(lines, 1) if fragment in line]
        assert len(matches) == 1, (source, fragment)
        line, text = matches[0]
        identifier = "display-consumers." + suffix
        surfaces.append(dict(zip(HEADER, [identifier, "Jouzu display consumers", source, symbol, entry, state, locale, finding, "reviewed-source-family-no-runtime", "", "Static producer/consumer inspection only. No live source polling, adapter, client, tool, terminal or network run. Arbitrary third-party clients remain outside finite shipped-view enumeration."])))
        anchors.append({"surface_id": identifier, "source_file": source, "line": line, "matched_line": text})
    receipt = {"full_read_files": len(FULL), "full_read_lines": sum(len((ROOT / source).read_text(encoding="utf-8").splitlines()) for source in FULL), "bounded_trace_files": len(TRACES), "families": len(surfaces), "source_sha256": {source: hashlib.sha256((ROOT / source).read_bytes()).hexdigest() for source in FULL}, "scoped_registration_calls": call_census(), "runtime_signoff": False, "all_external_clients_reviewed": False}
    return files, surfaces, anchors, receipt


def main():
    files, surfaces, anchors, receipt = build()
    write_csv("files.csv", ["source_file", "disposition", "evidence"], files)
    write_csv("surfaces.csv", HEADER, surfaces)
    write_csv("anchors.csv", ["surface_id", "source_file", "line", "matched_line"], anchors)
    (HERE / "receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in receipt.items() if key != "source_sha256"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
