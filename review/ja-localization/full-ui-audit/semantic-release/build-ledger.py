#!/usr/bin/env python3
"""Record complete release-source reads and bounded startup/report consumers."""
import csv
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
HEADER = ["surface_id", "owner", "source_file", "source_symbol", "entry_point", "state", "locale_path", "source_finding", "evidence_level", "existing_test", "coverage_limit"]
PRIMARY = ["packages/cli/src/release-extensions.ts", "packages/cli/src/release-surface-record.ts"]
FAMILIES = [
    ("optional-notices", PRIMARY[0], "createReleaseExtensionDiagnostics; formatReleaseExtensionFailure", "startup session_start/agent_end", "optional package missing/load failure; runtime restart warning; UI versus console", "English-default-catalog-at-startup", "main-cli.ts:550 calls createReleaseExtensionDiagnostics with status and runtime only, omitting its third catalog argument. The factory captures defaultCatalog() for optional-extension wrapper/disabled-tools text and console warning prefixes. Runtime warning strings are forwarded directly and are not translated by the outer factory. Once-per-session warning suppression changes visibility, not language."),
    ("conflict-notices", PRIMARY[0], "withReleaseExtensionConflictPolicy; consolidateReleaseToolConflicts", "startup resource loading", "release-owned tool conflict; single/multiple; nonmatching source error", "English-default-catalog-at-startup", "main-cli.ts:782 calls withReleaseExtensionConflictPolicy with runtime, status and operation only, omitting fourth catalog argument. Matching conflicts are consolidated with that English default; paths/tool IDs stay exact. Nonmatching diagnostics are preserved, not localized by this function. Exact native placement is delegated to the loader consumer rather than asserted here."),
    ("owned-validation", PRIMARY[0], "readManifest; validatePackageRoot; resolveResource; resolveAdapter; markReleaseExtensionUnavailable", "inspectReleaseExtensions and required startup arguments", "manifest/package/resource/adapter failure; optional degradation versus required rejection", "catalog-wrapper-plus-local-and-source-English", "Fixed local English validates manifest, regular files, package identity, containment and adapter contracts. messageFromError additionally inserts local Caused by framing while preserving cause text. Optional failures become degradedExtension.error; required failures become status.errors and withReleaseExtensionArguments wraps them with its supplied active catalog. Raw filesystem/JSON/module-load errors remain distinct inherited diagnostics. readManifest throws before status exists; the main generic error handler preserves its message."),
    ("compatibility", PRIMARY[0], "probeReleaseRuntimeCompatibility; ensureReleaseRuntimeCompatibility; repairRuntimeDependencyRedirect", "startup compatibility probe/repair; doctor probe only", "missing/wrong/unsafe nested dependency; stale backup; replacement failure; restore", "owned-English-diagnostic-with-selected-wrapper", "Compatibility errors contain locally authored English and protected package/version/path identity; probe/ensure route them into markReleaseExtensionUnavailable. Startup then uses required/degraded paths above. Doctor catches inspection failure separately. Repair uses rename/rollback/remove behavior, but audit performed no module load, repair or filesystem mutation. Suppressed metadata parse errors in configured-resource filtering create no new local alert."),
    ("historical-record", PRIMARY[1], "RELEASE_SURFACES; releaseSurfacesNeedingRecheck; summarizeReleaseSurfaces", "record exports for diagnostics", "recorded pin matches/changes; known/unknown disposition", "structured-versioned-record-not-independent-UI-authority", "The complete module contains versioned ownership/disposition records, factories, a pin-recheck helper and aggregate counters, not per-string translations or a UI renderer. Its historical translated/upstream-owned tags do not prove current selected catalog wiring or Japanese coverage; for example the adapter label record cannot override the separately traced English default registration. IDs/status values/counts remain structured data. No complete downstream rendering claim follows from re-exporting these records."),
]


def output(name, header, rows):
    with (HERE / name).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=header, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def main():
    files = [{"source_file": path, "disposition": "full-body-read-bounded-consumers", "evidence": "Complete implementation read; schema/selection/diagnostic and structured-record findings recorded in surfaces.csv. Consumer limits remain explicit; not runtime or complete import-graph coverage."} for path in PRIMARY]
    files += [
        {"source_file": "packages/cli/src/main-cli.ts", "disposition": "bounded-trace-only", "evidence": "Read release doctor catch at 423-427, startup factories/arguments at 540-550, extension assembly/operation wrapping at 720-790 and full handleMainCliError at 808-end. Diagnostics and conflict-policy catalog arguments are omitted; required argument wrapper receives active bundle. Not full dispatcher review."},
        {"source_file": "packages/cli/src/runtime-diagnostics.ts", "disposition": "bounded-trace-only", "evidence": "Read report/warnings consumers at 112-end: warnings returns issues and catalog build-changed notice, which release diagnostics forwards unchanged. Constructor-default wiring is independently recorded in the original terminal-owned ledger; not a full reread here."},
    ]
    rows = []
    for suffix, source, symbol, entry, state, locale, finding in FAMILIES:
        rows.append(dict(zip(HEADER, ["semantic-release." + suffix, "Jouzu release resources", source, symbol, entry, state, locale, finding, "reviewed-source-family-no-runtime", "", "No startup/resource resolution, package/module load, repair, dependency install or UI execution; only complete producers and named consumer regions read."])))
    output("files.csv", ["source_file", "disposition", "evidence"], files)
    output("surfaces.csv", HEADER, rows)
    receipt = {"primary_files": len(PRIMARY), "primary_lines": sum(len((ROOT / path).read_text(encoding="utf-8").splitlines()) for path in PRIMARY), "source_sha256": {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in PRIMARY}, "bounded_consumers": len(files) - len(PRIMARY), "families": len(rows), "runtime_signoff": False}
    (HERE / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
