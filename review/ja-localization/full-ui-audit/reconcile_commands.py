#!/usr/bin/env python3
"""Reconcile literal Jouzu-owned registerCommand calls with reviewed state families.

This bounded source check does not enumerate dynamic registrations, resource-derived
commands, Session UI interception routes, dependency commands, or runtime states.
"""
import csv
from pathlib import Path
import re

DIRECTORY = Path(__file__).resolve().parent
ROOT = DIRECTORY.parents[2]
COMMAND_STATES = {
    "fast": ["fast.command"],
    "status": ["status.command-description", "status.available-context", "status.unavailable-context", "status.literal-fallbacks", "status.protected-identities", "status.multiline-layout"],
    "flow": ["flow.command-description", "flow.status-report", "flow.status-details", "flow.toggle", "flow.pause-resume", "flow.retry-cancel-resolve", "flow.clear", "flow.reset-confirm"],
    "scrollback": ["scrollback.entry-header", "scrollback.busy-guards", "scrollback.message-kinds", "scrollback.special-entries", "scrollback.export-cancel-error", "scrollback.narrow"],
    "labels": ["labels.command-status", "labels.persistence-error"],
    "textguard": ["textguard.command", "textguard.off-empty", "textguard.queue", "textguard.unavailable", "textguard.approval-confirm"],
    "subagents": ["subagents.command-controls", "subagents.native-widget"],
    "workflow": ["workflow.browse"],
    "voice": ["voice.command", "voice.devices"],
}


def registrations(root=ROOT):
    rows = []
    pattern = re.compile(r'\.registerCommand\(\s*["\']([^"\']+)["\']\s*,')
    for source in sorted((root / "packages/cli/src").rglob("*.ts")):
        data = source.read_text(encoding="utf-8")
        for match in pattern.finditer(data):
            rows.append({"command": match[1], "source_file": source.relative_to(root).as_posix(), "line": data.count("\n", 0, match.start()) + 1})
    return rows


def reconcile(found, families):
    errors = []
    names = {row["command"] for row in found}
    for name in sorted(names - COMMAND_STATES.keys()):
        errors.append(f"unmapped literal owned command: {name}")
    for name in sorted(COMMAND_STATES.keys() - names):
        errors.append(f"mapped command registration missing: {name}")
    for name, identifiers in COMMAND_STATES.items():
        for identifier in identifiers:
            if identifier not in families:
                errors.append(f"/{name}: missing state family {identifier}")
    return errors


def main():
    with (DIRECTORY / "terminal-owned/surfaces.csv").open(encoding="utf-8-sig", newline="") as handle:
        families = {row["surface_id"] for row in csv.DictReader(handle)}
    found = registrations()
    errors = reconcile(found, families)
    if errors:
        raise SystemExit("\n".join(errors))
    with (DIRECTORY / "owned-command-coverage.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["command", "source_file", "line", "state_family_ids", "evidence_level", "coverage_limit"], lineterminator="\n")
        writer.writeheader()
        for row in sorted(found, key=lambda item: (item["command"], item["source_file"])):
            writer.writerow({**row, "state_family_ids": ";".join(COMMAND_STATES[row["command"]]), "evidence_level": "literal-registration-to-source-family-reconciled", "coverage_limit": "Mapped families are source evidence, not exhaustive branches or actual startup/native rendering. Dynamic, dependency, builtin, resource-derived and interception routes remain separate scope."})
    print(f"Reconciled {len(found)} literal owned registrations with named source families; no runtime signoff.")


if __name__ == "__main__":
    main()
