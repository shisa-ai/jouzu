#!/usr/bin/env python3
"""Check semantic-flow accounting and pointers, not source meaning or rendering."""
import csv
import hashlib
import importlib.util
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
BASE = HERE.parent


def rows(path):
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return reader.fieldnames, list(reader)


def main():
    # Loading the shared schema does not regenerate its census or original partitions.
    spec = importlib.util.spec_from_file_location("audit_validate", BASE / "validate.py")
    import sys
    sys.path.insert(0, str(BASE))
    shared = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(shared)
    errors = []
    _, original = rows(BASE / "terminal-owned/files.csv")
    primary = {row["source_file"] for row in original
               if row["source_file"].startswith("packages/cli/src/flow-control/")
               and any(part in row["disposition"] for part in ("excerpt", "partial"))}
    file_header, files = rows(HERE / "files.csv")
    surface_header, surfaces = rows(HERE / "surfaces.csv")
    trace_header, traces = rows(HERE / "traced-files.csv")
    _, residual = rows(HERE / "residual.csv")
    receipt = json.loads((HERE / "source-read-receipt.json").read_text(encoding="utf-8"))
    notes = json.loads((HERE / "full-read-findings.json").read_text(encoding="utf-8"))
    continuation = json.loads((HERE / "continuation-reads.json").read_text(encoding="utf-8"))
    additional = json.loads((HERE / "additional-source-read-receipt.json").read_text(encoding="utf-8"))
    additional_notes = json.loads((HERE / "additional-full-read-findings.json").read_text(encoding="utf-8"))
    assert len(primary) == 84
    assert file_header == trace_header == shared.FILE_HEADER
    assert surface_header == shared.SURFACE_HEADER
    assert len(files) == len(primary) == len({row["source_file"] for row in files})
    assert {row["source_file"] for row in files} == primary
    assert not primary.intersection(row["source_file"] for row in traces)
    assert len({row["source_file"] for row in traces}) == len(traces)
    assert {row["source_file"] for row in residual} == {
        row["source_file"] for row in files if row["disposition"] == "residual-full-body-unread"
    }
    assert len({row["surface_id"] for row in surfaces}) == len(surfaces)
    assert all(row["surface_id"].startswith("semantic-flow.") for row in surfaces)
    for group in (files, surfaces, traces):
        for row in group:
            assert None not in row and all(value is not None for value in row.values())
            assert (ROOT / row["source_file"]).is_file(), row["source_file"]
            for key, value in row.items():
                assert value.strip() or key == "existing_test", (row["source_file"], key)
    primary_receipts = {row["source_file"]: row for row in receipt["files"]}
    assert len(primary_receipts) == len(receipt["files"]) == len(primary)
    assert set(primary_receipts) == primary
    assert set(notes) <= {Path(source).name for source in primary}
    for row in files:
        note = notes.get(Path(row["source_file"]).name)
        assert primary_receipts[row["source_file"]]["full_body_read"] == bool(note)
        if note:
            assert row["disposition"] == "full-body-read-consumer-limits-explicit"
            assert row["evidence"] == note
    extra_paths = {f"packages/cli/src/flow-control/{name}" for name in
                   ("no-reply-tool.ts", "result-tools.ts", "wait-tools.ts")}
    assert not primary.intersection(extra_paths)
    assert set(additional_notes) == {Path(source).name for source in extra_paths}
    assert {row["source_file"] for row in additional["files"]} == extra_paths
    assert len(additional["files"]) == 3
    assert {row["source_file"] for row in traces
            if row["disposition"] == "full-body-read-additional-producer"} == extra_paths
    for row in additional["files"]:
        note = additional_notes[Path(row["source_file"]).name]
        assert row["full_body_read"] is True
        assert row["review_depth"] == note["review_depth"] == "full-body-read-immediate-consumers-traced"
        assert note["source_finding"].strip() and note["coverage_limit"].strip()
        assert note["immediate_consumers"] and all((ROOT / path).is_file() for path in note["immediate_consumers"])
    for row in receipt["files"] + additional["files"]:
        content = (ROOT / row["source_file"]).read_bytes()
        assert row["sha256"] == hashlib.sha256(content).hexdigest(), row["source_file"]
        assert row["lines"] == len(content.decode("utf-8").splitlines())
    assert receipt["primary_files"] == len(primary)
    assert receipt["primary_lines"] == sum(row["lines"] for row in receipt["files"])
    assert receipt["full_body_files"] == sum(row["full_body_read"] for row in receipt["files"])
    assert receipt["full_body_lines"] == sum(row["lines"] for row in receipt["files"] if row["full_body_read"])
    assert receipt["residual_files"] == len(residual)
    assert receipt["residual_lines"] == sum(int(row["lines"]) for row in residual)
    assert receipt["semantic_signoff"] is False and receipt["native_rendering_signoff"] is False
    assert receipt["primary_body_set_complete"] == (not residual)
    assert additional["primary_count_contribution"] == 0
    assert additional["additional_producer_files"] == len(additional["files"])
    assert additional["additional_producer_lines"] == sum(row["lines"] for row in additional["files"])
    assert additional["semantic_signoff"] is False and additional["native_rendering_signoff"] is False
    assert continuation["source_revision"] == receipt["source_revision"] == additional["source_revision"]
    assert continuation["inspection_checkout_revision"] == receipt["inspection_checkout_revision"] == additional["inspection_checkout_revision"]
    assert continuation["primary_body_set_complete"] is True
    assert continuation["consumer_completeness_signoff"] is False and continuation["native_rendering_signoff"] is False
    continued = {row["source_file"] for row in continuation["files"]}
    assert len(continued) == len(continuation["files"]) == 24
    assert continued <= primary
    baseline = continuation["starting_accounting"]
    assert baseline["primary_files"] == receipt["primary_files"]
    assert baseline["primary_lines"] == receipt["primary_lines"]
    assert baseline["residual_files"] == len(continued)
    assert baseline["residual_lines"] == sum(primary_receipts[path]["lines"] for path in continued)
    assert baseline["full_body_files"] + baseline["residual_files"] == receipt["primary_files"]
    assert baseline["full_body_lines"] + baseline["residual_lines"] == receipt["primary_lines"]
    assert continuation["initial_primary_hash_comparison"] == {"unchanged": len(primary), "changed": []}
    for row in continuation["files"]:
        next_line = 1
        for start, end in row["read_ranges"]:
            assert start == next_line and end >= start, row["source_file"]
            next_line = end + 1
        assert next_line - 1 == primary_receipts[row["source_file"]]["lines"]
        assert primary_receipts[row["source_file"]]["full_body_read"] is True
    pointers = set()
    for name in ("files.csv", "traced-files.csv", "surfaces.csv", "README.md", "full-read-findings.json",
                 "additional-full-read-findings.json", "continuation-reads.json"):
        text = (HERE / name).read_text(encoding="utf-8")
        for pointer in re.findall(r"(?:packages|examples|scripts|apps|packaging|python)/[^\s,;`\"()]+?\.(?:mjs|js|tsx|ts|py|ps1|ftl)\b", text):
            pointers.add(pointer)
            if not (ROOT / pointer).is_file():
                errors.append(f"{name}: missing pointer {pointer}")
    source = (ROOT / "packages/cli/src/flow-control/user-input-receipts.ts").read_text(encoding="utf-8")
    reason_enum = source.split("export type UserInputReceiptReasonCode =", 1)[1].split(";", 1)[0]
    states = source.split("export type UserInputReceiptState =", 1)[1].split(";", 1)[0]
    ja = (ROOT / "packages/cli/locales/ja/user-input.ftl").read_text(encoding="utf-8")
    result = {
        "errors": errors, "primary_files": len(primary), "primary_lines": receipt["primary_lines"],
        "full_body_files": receipt["full_body_files"], "full_body_lines": receipt["full_body_lines"],
        "residual_files": len(residual), "residual_lines": receipt["residual_lines"],
        "additional_scoped_files": len(traces) - len(extra_paths),
        "additional_producer_files": additional["additional_producer_files"],
        "additional_producer_lines": additional["additional_producer_lines"],
        "nonprimary_ledger_files": len(traces),
        "continuation_primary_files": len(continued),
        "continuation_primary_lines": baseline["residual_lines"],
        "primary_body_set_complete": receipt["primary_body_set_complete"],
        "surface_state_families": len(surfaces),
        "checked_pointer_paths": len(pointers),
        "receipt_states": len(re.findall(r'"[a-z-]+"', states)),
        "receipt_reason_codes": len(re.findall(r'"[a-z-]+"', reason_enum)),
        "ja_namespace_receipt_entries": len(re.findall(r"^jouzu-cli-flow-userInput-receipt-", ja, re.M)),
        "ja_namespace_grant_entries": len(re.findall(r"^jouzu-cli-flow-userInput-grants-", ja, re.M)),
        "claim_limit": "Structural checks cannot establish that source bodies were read, consumer completeness, Japanese quality, or native rendering.",
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
