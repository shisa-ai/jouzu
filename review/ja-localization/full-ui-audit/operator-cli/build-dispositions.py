#!/usr/bin/env python3
"""Record operator CLI, catalog, schema, and tooling source dispositions."""

import csv
import json
from pathlib import Path
import sys

DIRECTORY = Path(__file__).resolve().parent
sys.path.insert(0, str(DIRECTORY.parent))
from census import ROOT
from validate import FILE_HEADER

MODULES = {
    "args.ts": "ParsedCommand, parser refusal descriptors and formatHelp; surface rows in this partition.",
    "cli.ts": "Lightweight bootstrap, updater routes and localized error wrapping; surface rows in this partition.",
    "main-cli.ts": "Noninteractive command dispatcher and catalog injection; interactive factory construction is cross-checked by terminal-owned partition.",
    "doctor.ts": "createDoctorReport assembles human and machine diagnostics; identifiers/source errors remain protected and report templates are catalog-backed.",
    "catalog-command.ts": "formatCatalogStatus and catalogValidationMessage; descriptor-backed errors can be localized while schema/source errors remain a separate boundary.",
    "catalog-failure.ts": "Recognized network/filesystem codes map to catalog IDs; source codes remain exact.",
    "catalog-sources.ts": "Catalog source configuration/validation and descriptor-backed failures feed CLI and settings; rendering callers must supply catalog.",
    "catalog-settings.ts": "Catalog settings implementation is primarily covered by terminal-owned partition; source is a shared CLI configuration input.",
    "model-catalog.ts": "Schema/conformance validators produce English source diagnostics and machine identity; wrapper-versus-source preservation needs explicit review.",
    "model-catalog-sync.ts": "Catalog refresh/accept state machine; selected catalog is passed by main command dispatcher; external requests not exercised here.",
    "cli-messages.ts": "Catalog message IDs, descriptor helpers and English defaultCatalog fallback; presence is not runtime wiring evidence.",
    "human-messages.ts": "Protected-value and pre-runtime message descriptors; preserve source/command identity separately from translated framing.",
    "command-report.ts": "Report field/section/status rendering and protected values; actual report scenario remains the caller's responsibility.",
    "locale-catalog.ts": "Catalog loading/integrity and resolveCatalog English recovery fallback; metadata is not whole-interface approval.",
    "locale-status.ts": "Catalog support metadata and machine state IDs; no inference that complete means all UI surfaces were exercised.",
    "pre-runtime.ts": "Resolved catalog/display context shared by bootstrap and main CLI.",
    "ui-locale.ts": "CLI/environment/saved/OS preference resolution and invalid/future settings states; flags alone do not establish a rendered language.",
    "runtime-diagnostics.ts": "Runtime diagnostic framing and source-error preservation; interactive display callers are cross-checked separately.",
    "runtime-output.ts": "Output routing/wrapping rather than an independent screen; retain raw model/tool output boundaries.",
    "profile-manager.ts": "Managed profile plan/apply report and conflict/backup failure paths feed main CLI selected-catalog formatter.",
    "profile-migration.ts": "Migration plan/apply/rollback state and report templates; temporary-versus-saved choice must remain explicit.",
    "profile-migration-command.ts": "Catalog-backed plan/confirmation/apply/rollback command views; no real user state was modified.",
    "updater.ts": "Updater status/progress/policy/error descriptors; network/install/restart branches require controlled fixtures, not real operations.",
    "keybindings.ts": "Keybinding plan/apply/reset state and catalog-backed report helpers; gestures/IDs are protected data.",
    "pi-import.ts": "Import offer/error and conflict boundaries; interactive offer is also a terminal-owned surface.",
}


def build():
    rows = []
    for file, evidence in MODULES.items():
        rows.append([f"packages/cli/src/{file}", "ui-report-or-locale-wiring", evidence])
    candidates = json.loads((DIRECTORY.parent / "source-census.json").read_text(encoding="utf-8"))["files"]
    for candidate in candidates:
        source = candidate["source_file"]
        if source.startswith("scripts/"):
            transform = "transform" in source or Path(source).name.startswith("apply-")
            rows.append([source, "build-transform-runtime-input" if transform else "operator-tooling-outside-offered-ui",
                "Build transforms can inject shipped runtime text; inspect their installed outputs in dependencies partition, not just their console diagnostics."
                if transform else "Root build/test/release/audit tooling is not a selectable Japanese product interface or shipped CLI source entry; operator diagnostics are a separate language boundary, not proof of Japanese UI rendering."])
        elif source.startswith("packages/cli/locales/"):
            rows.append([source, "catalog-source-or-metadata", "Catalog corpus is enumerated independently by catalog-candidates.mjs with hashes; exact-source equality is a context lead, not visibility or Japanese quality evidence."])
        elif source.startswith("packages/cli/catalog/"):
            rows.append([source, "schema-or-source-data", "Catalog schema/conformance data is consumed by model-catalog validators; diagnostics versus machine/source preservation are recorded in CLI route rows."])
        elif source.startswith("packages/cli/camoufox-runtime/"):
            rows.append([source, "runtime-dependency-metadata", "Camoufox runtime dependency metadata, not a screen or localizable diagnostic; adapter-facing text is owned by its implementation."])
        elif source in {"package.json", "packages/cli/package.json", "packages/cli/release-extensions.json", "upstream/pi.lock.json"}:
            rows.append([source, "entrypoint-and-pin-authority", "Defines command/build/runtime ownership or exact pins; names/versions/registry identifiers remain protected; does not attest rendered UI."])
        elif source == "python/jouzu/src/jouzu/__main__.py":
            rows.append([source, "separate-cli-English-no-locale", "Separate reservation CLI has English argparse/help/banner text and machine doctor JSON; no Japanese locale selection is implemented."])
        elif source == "python/jouzu/src/jouzu/__init__.py":
            rows.append([source, "package-metadata", "Version metadata for the separate Python reservation CLI; no interactive UI renderer."])
    rows.append(["packaging/launcher/network-acceptance.mjs", "acceptance-harness-not-offered-UI", "Local HTTP fixture starts catalog refresh/status and a fake model response to check transport/auth. Its own assertions/progress are test-harness diagnostics; rendered product CLI paths are covered by operator-cli source routes, not claimed runtime Japanese coverage from this harness."])
    with (DIRECTORY / "files.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(FILE_HEADER)
        writer.writerows(rows)
    print(f"Saved {len(rows)} operator source dispositions.")


if __name__ == "__main__":
    build()
