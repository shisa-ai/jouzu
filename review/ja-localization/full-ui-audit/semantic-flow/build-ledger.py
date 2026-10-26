#!/usr/bin/env python3
"""Generate the bounded semantic-flow source ledger; no product execution."""
import csv
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
BASE = HERE.parent
FILE_HEADER = ["source_file", "disposition", "evidence"]
SURFACE_HEADER = [
    "surface_id", "owner", "source_file", "source_symbol", "entry_point", "state",
    "locale_path", "source_finding", "evidence_level", "existing_test", "coverage_limit",
]
ADDITIONAL_PRODUCERS = {"no-reply-tool.ts", "result-tools.ts", "wait-tools.ts"}


def write_csv(name, header, rows):
    with (HERE / name).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=header)
        writer.writeheader()
        writer.writerows(rows)


def main():
    with (BASE / "terminal-owned/files.csv").open(encoding="utf-8-sig", newline="") as handle:
        primary = [row for row in csv.DictReader(handle)
                   if row["source_file"].startswith("packages/cli/src/flow-control/")
                   and any(part in row["disposition"] for part in ("excerpt", "partial"))]
    assert len(primary) == 84
    notes = json.loads((HERE / "full-read-findings.json").read_text(encoding="utf-8"))
    assert set(notes) <= {Path(row["source_file"]).name for row in primary}
    files, residual, inventory = [], [], []
    for row in primary:
        source = row["source_file"]
        content = (ROOT / source).read_bytes()
        lines = len(content.decode("utf-8").splitlines())
        note = notes.get(Path(source).name)
        files.append({
            "source_file": source,
            "disposition": "full-body-read-consumer-limits-explicit" if note else "residual-full-body-unread",
            "evidence": note if note else (
                f"Full body not read: {lines} lines. No new semantic disposition is asserted. "
                f"Prior terminal-owned disposition: {row['disposition']}. "
                "Required closure: read the entire implementation, identify its text/error producers and inspect immediate consumers. "
                "See residual.csv for exact bounded remainder; scoped call-site evidence, if any, is not full-file review."
            ),
        })
        inventory.append({
            "source_file": source, "lines": lines, "sha256": hashlib.sha256(content).hexdigest(),
            "full_body_read": bool(note), "prior_disposition": row["disposition"],
        })
        if not note:
            residual.append({"source_file": source, "lines": lines,
                             "required_work": "Read full body and trace immediate text/error consumers; no full-file semantic claim."})
    write_csv("files.csv", FILE_HEADER, files)
    write_csv("residual.csv", ["source_file", "lines", "required_work"], residual)
    continuation = json.loads((HERE / "continuation-reads.json").read_text(encoding="utf-8"))
    (HERE / "source-read-receipt.json").write_text(json.dumps({
        "source_revision": continuation["source_revision"],
        "inspection_checkout_revision": continuation["inspection_checkout_revision"],
        "universe": "terminal-owned/files.csv: flow-control prefix and disposition contains excerpt or partial",
        "primary_files": len(inventory), "primary_lines": sum(row["lines"] for row in inventory),
        "full_body_files": sum(row["full_body_read"] for row in inventory),
        "full_body_lines": sum(row["lines"] for row in inventory if row["full_body_read"]),
        "residual_files": len(residual), "residual_lines": sum(row["lines"] for row in residual),
        "primary_body_set_complete": not residual,
        "semantic_signoff": False, "native_rendering_signoff": False, "files": inventory,
    }, indent=2) + "\n", encoding="utf-8")
    additional_notes = json.loads((HERE / "additional-full-read-findings.json").read_text(encoding="utf-8"))
    assert set(additional_notes) == ADDITIONAL_PRODUCERS
    additional = []
    for name in sorted(ADDITIONAL_PRODUCERS):
        source = f"packages/cli/src/flow-control/{name}"
        assert source not in {row["source_file"] for row in primary}
        content = (ROOT / source).read_bytes()
        additional.append({
            "source_file": source, "lines": len(content.decode("utf-8").splitlines()),
            "sha256": hashlib.sha256(content).hexdigest(), "full_body_read": True,
            "review_depth": additional_notes[name]["review_depth"],
        })
    (HERE / "additional-source-read-receipt.json").write_text(json.dumps({
        "source_revision": continuation["source_revision"],
        "inspection_checkout_revision": continuation["inspection_checkout_revision"],
        "universe": "Explicit finite addition: no-reply-tool.ts, result-tools.ts, wait-tools.ts; outside fixed84 predicate",
        "additional_producer_files": len(additional),
        "additional_producer_lines": sum(row["lines"] for row in additional),
        "primary_count_contribution": 0,
        "semantic_signoff": False, "native_rendering_signoff": False, "files": additional,
    }, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
