#!/usr/bin/env python3
"""Save the noninteractive CLI route ledger; test names are leads, not coverage."""

import csv
from pathlib import Path
import re
import sys

DIRECTORY = Path(__file__).resolve().parent
sys.path.insert(0, str(DIRECTORY.parent))
from census import ROOT
from validate import SURFACE_HEADER

# Routes are derived from ParsedCommand and the actual bootstrap/main dispatchers.
ROUTES = [
    ("help", "args.ts", "formatHelp", "jz --help", "human help; protected command syntax", "catalog-backed descriptions; syntax remains unchanged", "cli.test.mjs"),
    ("version", "main-cli.ts", "runMainCli", "jz --version", "runtime available or unavailable; exact pinned-version display", "catalog wrapper with protected version identifiers", "cli.test.mjs"),
    ("bootstrap-errors", "cli.ts", "handleBootstrapError", "invalid startup or updater failure", "usage/update/generic errors; lightweight bootstrap import failure", "selected catalog wraps source errors; source text is preserved", "cli-bootstrap.test.mjs"),
    ("bootstrap-fallback", "cli.ts", "englishContext", "unreadable locale/settings before bootstrap", "even resolving the display context fails", "intentional English recovery context; not Japanese rendering", "cli-bootstrap.test.mjs"),
    ("runtime-errors", "main-cli.ts", "handleMainCliError", "failed main command", "Pi import/runtime/catalog/profile/state/keybinding errors", "catalog wrappers and descriptor recovery; raw source errors preserved", "cli.test.mjs"),
    ("doctor-human", "doctor.ts", "createDoctorReport", "jz doctor", "healthy/unhealthy; missing tools/credentials/catalog/profile/updates", "catalog-backed report; codes, paths and source diagnostics preserved", "doctor.test.mjs"),
    ("doctor-json", "main-cli.ts", "runMainCli", "jz doctor --json", "machine-readable diagnostics", "JSON identities and source data are not UI translation targets", "doctor.test.mjs"),
    ("catalog-status", "catalog-command.ts", "formatCatalogStatus", "jz catalog status [source]", "absent/configured/active/stale/quarantined/failed sources", "selected catalog passed through renderer options; source labels preserved", "catalog-command.test.mjs"),
    ("catalog-status-json", "main-cli.ts", "runMainCli", "jz catalog status --json", "machine-readable catalog metadata", "machine keys and diagnostic identifiers preserved", "catalog-command.test.mjs"),
    ("catalog-refresh", "main-cli.ts", "runMainCli", "jz catalog refresh [source]", "single/all source; activated/rejected/partial/failed", "selected catalog reaches sync result and status renderer", "model-catalog-sync.test.mjs"),
    ("catalog-accept", "main-cli.ts", "runMainCli", "jz catalog accept revision --digest digest", "valid/invalid quarantine; missing revision/digest; source mismatch", "localized result wrapper; revisions/digests remain unchanged", "catalog-command.test.mjs"),
    ("catalog-file", "catalog-command.ts", "catalogValidationMessage", "jz catalog validate file", "missing file/invalid JSON/invalid schema/valid document", "missing/JSON failures carry messageRef; schema diagnostics may be English inside localized wrapper", "catalog-command.test.mjs"),
    ("catalog-conformance", "catalog-command.ts", "validateCatalogFile", "jz catalog conformance file", "structural and remote-conformance success/failure", "underlying schema diagnostics need preservation-policy review separately from wrapper", "catalog-command.test.mjs"),
    ("catalog-network-errors", "catalog-failure.ts", "describeCatalogFailure", "catalog refresh failure", "DNS/connection/timeouts/certificate/permission/cache/filesystem errors", "mapped error explanations use passed catalog; raw nested details are not exposed here", "catalog-failure.test.mjs"),
    ("keybindings-plan", "main-cli.ts", "runMainCli", "jz keybindings status|plan", "converged/planned/conflicting configuration; JSON alternative", "selected catalog passed to plan and formatter; key IDs preserved", "keybindings.test.mjs"),
    ("keybindings-apply", "main-cli.ts", "runMainCli", "jz keybindings apply", "changed/no-op/conflict/backup/write failure", "catalog-backed plan and completion notices", "keybindings.test.mjs"),
    ("keybindings-reset", "main-cli.ts", "runMainCli", "jz keybindings reset", "changed/already-disabled/conflict/backup/write failure", "catalog-backed plan and completion notices", "keybindings.test.mjs"),
    ("profile-plan", "main-cli.ts", "runMainCli", "jz profile plan [--profile core|ja]", "profile source choice; managed/modified/missing files; JSON", "selected catalog passed to profile plan formatter", "profile-manager.test.mjs"),
    ("profile-apply", "main-cli.ts", "runMainCli", "jz profile apply [--profile core|ja]", "changed/no-op/conflict/backup/state-write failure", "selected catalog reaches manager and completion wrapper", "profile-manager.test.mjs"),
    ("migration-plan", "profile-migration-command.ts", "runProfileMigrationCommand", "jz profile-migration plan", "preview/temporary choice/eligible/no-op/conflict; JSON", "catalog passed from main dispatch; technical target paths preserved", "profile-migration-command.test.mjs"),
    ("migration-apply", "profile-migration-command.ts", "runProfileMigrationCommand", "jz profile-migration apply [--yes]", "confirmation required/default no/cancel/confirm/applied/already applied/conflict/receipt failure", "catalog-backed preview and confirmation; no writes without explicit confirmation", "profile-migration-command.test.mjs"),
    ("migration-rollback", "profile-migration-command.ts", "runProfileMigrationCommand", "jz profile-migration rollback", "absent/invalid receipt; changed/no-op/conflict/unreadable backup", "catalog-backed rollback notices; receipt/target identity preserved", "profile-migration-command.test.mjs"),
    ("update-status", "cli.ts", "runBootstrap", "jz self-update status", "installed/pending/disabled/failed receipt; JSON alternative", "selected catalog reaches formatUpdateStatus", "updater.test.mjs"),
    ("update-check", "cli.ts", "runBootstrap", "jz self-update check", "current/available/network or policy failure; JSON", "catalog-backed current/available messages and update error wrapper", "updater.test.mjs"),
    ("update-apply", "cli.ts", "runBootstrap", "jz self-update apply", "changed/no-op/validation/install/restart failure", "catalog-backed progress and completion; exact version/source errors preserved", "updater.test.mjs"),
    ("update-policy", "cli.ts", "runBootstrap", "jz self-update policy auto-restart|notify|off", "valid/invalid choice; saved policy; write failure", "localized policy display with machine policy values preserved", "updater.test.mjs"),
    ("startup-update", "cli.ts", "runBootstrap", "interactive startup", "no notice/available/restart/policy blocked/update error", "catalog-backed progress and restart notices", "updater.test.mjs"),
    ("pinned-pi-update", "main-cli.ts", "runMainCli", "jz pi update --self", "embedded runtime self-update refusal", "localized UsageError descriptor rather than upstream updater execution", "cli.test.mjs"),
    ("catalog-recovery", "locale-catalog.ts", "resolveCatalog", "missing/corrupt/unsupported catalog", "missing file/hash mismatch/parse failure/unsupported locale", "English recovery fallback intentionally works without a readable Japanese catalog", "locale-catalog.test.mjs"),
    ("locale-setting-errors", "ui-locale.ts", "resolveUiLocale", "CLI/env/saved/OS locale inputs", "invalid/future/auto/unsupported locale; precedence", "source/machine tags preserved; notices use resolved catalog when available", "ui-locale.test.mjs"),
    ("python-preview", "__main__.py", "main", "python -m jouzu", "no args/help/invalid arguments/version/doctor JSON", "separate Python reservation entry has English-only argparse/help text and no UI locale selection", "test_cli.py"),
]


def build():
    rows = []
    for identifier, file, symbol, entry, state, finding, test in ROUTES:
        source = "python/jouzu/src/jouzu/__main__.py" if file == "__main__.py" else f"packages/cli/src/{file}"
        test_path = f"python/jouzu/tests/{test}" if test == "test_cli.py" else f"packages/cli/test/{test}"
        rows.append(dict(zip(SURFACE_HEADER, [
            f"cli-{identifier}", "Jouzu", source, symbol, entry, state,
            "resolved CLI CatalogBundle or documented fallback", finding, "source-inspected",
            test_path if (ROOT / test_path).is_file() else "",
            "Source route evidence; runtime observations are recorded separately and do not cover every branch.",
        ])))
    # Enumerate every parser refusal site independently of catalog key coverage.
    source = "packages/cli/src/args.ts"
    lines = (ROOT / source).read_text(encoding="utf-8").splitlines()
    for line, text in enumerate(lines, 1):
        if "new UsageError(" not in text:
            continue
        fragment = "\n".join(lines[line - 1:line + 12])
        message = re.search(r"(?:CliMessageId|CatalogMessageId)\.([A-Za-z0-9_]+)", fragment)
        identifier = message[1] if message else "descriptor-needs-context"
        rows.append(dict(zip(SURFACE_HEADER, [
            f"cli-parser-{line}", "Jouzu", source, f"UsageError at line {line}", "CLI argument parsing",
            identifier, "UsageError descriptor -> usageErrorMessage(error, selected catalog)",
            "Selected-catalog descriptor recovery is wired; exact invalid-input guard is at the anchored source site.",
            "source-inspected", "packages/cli/test/args.test.mjs",
            "Not every invalid-input permutation was invoked; raw JavaScript-call string errors remain a separate preservation boundary.",
        ])))
    with (DIRECTORY / "surfaces.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=SURFACE_HEADER)
        writer.writeheader()
        writer.writerows(rows)
    print(f"Saved {len(rows)} CLI route/parser state rows.")


if __name__ == "__main__":
    build()
