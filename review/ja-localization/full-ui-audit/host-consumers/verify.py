#!/usr/bin/env python3
"""Validate static audit records only; no product imports, model calls or runtime tests."""
import ast
from collections import Counter
import csv
import hashlib
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
PI = "packages/cli/node_modules/@earendil-works/pi-coding-agent/"
CORE = "packages/cli/node_modules/@earendil-works/pi-agent-core/"
HEADERS = {
    "files.csv": ["source_file", "disposition", "evidence"],
    "surfaces.csv": ["surface_id", "owner", "source_file", "source_symbol", "entry_point", "state", "locale_path", "source_finding", "evidence_level", "existing_test", "coverage_limit"],
    "anchors.csv": ["anchor_id", "source_file", "line", "kind", "exact_text"],
    "boundaries.csv": ["boundary_id", "status", "surface_ids", "finding", "remaining"],
}
REQUIRED_BOUNDARIES = {
    "textguard-fresh", "textguard-restored", "flow-model-only", "nested-host", "parent-context", "tool-refusals", "extension-errors", "startup-models", "settings-key-callback", "arbitrary-parent-renderer", "native-layout", "downstream-model",
}
SELECTED_PATCH_FILES = ["dist/main.js", "dist/core/agent-session.js", "dist/core/sdk.js", "dist/core/session-manager.js", "dist/core/extensions/runner.js", "dist/modes/interactive/interactive-mode.js"]


def read_records(directory=HERE):
    tables, headers = {}, {}
    for name in HEADERS:
        with (directory / name).open(encoding="utf-8", newline="") as stream:
            reader = csv.DictReader(stream)
            headers[name] = reader.fieldnames
            tables[name] = list(reader)
    return headers, tables, json.loads((directory / "source-read-receipt.json").read_text(encoding="utf-8"))


def validate(headers, tables, receipt, root=ROOT):
    errors = []
    def check(condition, message):
        if not condition:
            errors.append(message)
    for name, header in HEADERS.items():
        check(headers.get(name) == header, f"schema: {name}")
        for n, row in enumerate(tables.get(name, []), 2):
            check(set(row) == set(header) and all(isinstance(v, str) for v in row.values()), f"malformed: {name}:{n}")
            for field in header:
                if field != "existing_test":
                    check(bool(row.get(field, "").strip()), f"empty: {name}:{n}:{field}")
    # Independently compare the schema with the shared validator's literal, without importing it.
    shared = ast.parse((root / "review/ja-localization/full-ui-audit/validate.py").read_text(encoding="utf-8"))
    shared_headers = {node.targets[0].id: ast.literal_eval(node.value) for node in shared.body if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and node.targets[0].id in {"FILE_HEADER", "SURFACE_HEADER"}}
    check(HEADERS["surfaces.csv"] == shared_headers["SURFACE_HEADER"], "common eleven-column schema")
    check(HEADERS["files.csv"] == shared_headers["FILE_HEADER"], "common file schema")
    check(receipt.get("semantic_whole_package_signoff") is False and receipt.get("runtime_signoff") is False, "unsupported signoff")
    records = receipt.get("files", [])
    by_path = {r["source_file"]: r for r in records}
    paths = [r["source_file"] for r in tables["files.csv"]]
    check(len(paths) == len(set(paths)) == len(records) == len(by_path), "duplicate/missing file record")
    check(set(paths) == set(by_path), "receipt/file membership")
    source_lines = {}
    for path, record in by_path.items():
        p = Path(path)
        check(not p.is_absolute() and ".." not in p.parts, f"unsafe source path: {path}")
        check((root / p).is_file(), f"missing source: {path}")
        if not (root / p).is_file():
            continue
        data = (root / p).read_bytes()
        lines = data.decode("utf-8").splitlines()
        source_lines[path] = lines
        check(hashlib.sha256(data).hexdigest() == record["sha256"], f"stale source hash: {path}")
        check(len(lines) == record["line_count"], f"stale line count: {path}")
        ranges = record["ranges"]
        check(bool(ranges) and all(1 <= a <= b <= len(lines) for a, b in ranges), f"invalid read ranges: {path}")
        check(record["depth"] in {"full-body", "bounded-regions"}, f"unknown depth: {path}")
        if record["depth"] == "full-body":
            check(ranges == [[1, len(lines)]], f"false full-body depth: {path}")
    for row in tables["files.csv"]:
        record = by_path.get(row["source_file"])
        if record:
            expected = "full-body-read" if record["depth"] == "full-body" else "bounded-region-trace"
            check(row["disposition"] == expected, f"depth/disposition mismatch: {row['source_file']}")
    anchors = tables["anchors.csv"]
    check(len(anchors) == len({r["anchor_id"] for r in anchors}), "duplicate anchor")
    pointers = set()
    for row in anchors:
        path, n = row["source_file"], int(row["line"])
        lines = source_lines.get(path, [])
        check(1 <= n <= len(lines) and lines[n - 1] == row["exact_text"], f"stale anchor: {row['anchor_id']}")
        check(any(a <= n <= b for a, b in by_path.get(path, {}).get("ranges", [])), f"anchor outside inspected ranges: {row['anchor_id']}")
        check(row["kind"] in {"declaration", "expression"}, f"unknown anchor kind: {row['anchor_id']}")
        if row["kind"] == "declaration":
            check(not re.match(r"(?:this\.|return\b|await\b|//)", row["exact_text"].lstrip()), f"call/comment substituted for declaration: {row['anchor_id']}")
        pointers.add(f"{path}:L{n}")
    surfaces = tables["surfaces.csv"]
    ids = {r["surface_id"] for r in surfaces}
    check(len(ids) == len(surfaces), "duplicate surface ID")
    tests = set()
    for row in surfaces:
        check(row["surface_id"].startswith("host-consumers."), "surface namespace")
        check(row["source_file"] in by_path, f"unrecorded surface source: {row['surface_id']}")
        check(row["evidence_level"] == "source-only-host-trace", f"runtime/unknown evidence level: {row['surface_id']}")
        refs = row["entry_point"].split("; ")
        check(len(refs) >= 2 and all(ref in pointers for ref in refs), f"unanchored route: {row['surface_id']}")
        for test in filter(None, row["existing_test"].split("; ")):
            tests.add(test)
            check((root / test).is_file(), f"missing test pointer: {test}")
    boundaries = tables["boundaries.csv"]
    check({r["boundary_id"] for r in boundaries} == REQUIRED_BOUNDARIES and len(boundaries) == len(REQUIRED_BOUNDARIES), "missing/duplicate/expanded finite boundary set")
    valid_status = {"closed-selected-source", "open-source-consumer", "open-unbounded-producer", "open-native", "open-out-of-scope"}
    for row in boundaries:
        check(row["status"] in valid_status, f"unsupported closure: {row['boundary_id']}")
        check(set(row["surface_ids"].split("; ")) <= ids, f"unlinked boundary: {row['boundary_id']}")
        if row["boundary_id"] in {"settings-key-callback", "arbitrary-parent-renderer", "native-layout", "downstream-model"}:
            check(row["status"].startswith("open-"), f"false closure: {row['boundary_id']}")
    # Verify the actual selected installed output against the checked-in patch authority.
    lock_path = "upstream/pi-content-policy/patch.lock.json"
    lock_data = (root / lock_path).read_bytes()
    lock = json.loads(lock_data)
    pin = json.loads((root / "upstream/pi.lock.json").read_bytes())
    deviations = [r for r in pin["deviations"] if r["path"] == lock_path]
    check(len(deviations) == 1 and deviations[0]["sha256"] == hashlib.sha256(lock_data).hexdigest(), "pin/patch identity")
    for rel in SELECTED_PATCH_FILES:
        check(hashlib.sha256((root / PI / rel).read_bytes()).hexdigest() == lock["files"][rel]["after"], f"selected patch mismatch: {rel}")
    for prefix in [PI, CORE]:
        pkg = json.loads((root / prefix / "package.json").read_bytes())
        check(pkg["version"] == "1.4.0" and pkg["exports"]["."]["import"] == "./dist/index.js", f"selected export identity: {prefix}")
    # Check only the two selected bare-import ancestry chains, without Node resolution/imports.
    for importer, package, expected in [
        ("packages/cli/src/main-cli.ts", "@earendil-works/pi-coding-agent", PI),
        (PI + "dist/core/sdk.js", "@earendil-works/pi-agent-core", CORE),
    ]:
        candidates = [parent / "node_modules" / package / "package.json" for parent in (root / importer).parents if parent == root or root in parent.parents]
        selected = next((candidate.parent for candidate in candidates if candidate.is_file()), None)
        check(selected == root / expected, f"selected import ancestry: {importer}")
    counts = {
        "files": len(records),
        "depths": dict(sorted(Counter(r["depth"] for r in records).items())),
        "full_body_source_lines": sum(r["line_count"] for r in records if r["depth"] == "full-body"),
        "inspected_source_lines": sum(len({n for a, b in r["ranges"] for n in range(a, b + 1)}) for r in records),
        "anchors": len(anchors),
        "surface_families": len(surfaces),
        "distinct_test_pointers_not_executed": len(tests),
        "boundaries": dict(sorted(Counter(r["status"] for r in boundaries).items())),
        "selected_patched_files_verified": len(SELECTED_PATCH_FILES),
    }
    readme = (HERE / "README.md").read_text(encoding="utf-8")
    for label, value in {
        "Source/file records": counts["files"],
        "Full-body records": counts["depths"].get("full-body", 0),
        "Full-body source lines": counts["full_body_source_lines"],
        "Bounded-region records": counts["depths"].get("bounded-regions", 0),
        "Inspected source lines": counts["inspected_source_lines"],
        "Exact declaration/expression anchors": counts["anchors"],
        "Meaningful surface/state families": counts["surface_families"],
        "Distinct existing product-test pointers": counts["distinct_test_pointers_not_executed"],
        "Selected installed patch outputs matched": counts["selected_patched_files_verified"],
    }.items():
        check(f"| {label} | {value:,} |" in readme, f"README count: {label}")
    return {"counts": counts, "errors": errors, "whole_package_semantic_signoff": False, "runtime_signoff": False}


def main():
    result = validate(*read_records())
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return bool(result["errors"])


if __name__ == "__main__":
    raise SystemExit(main())
