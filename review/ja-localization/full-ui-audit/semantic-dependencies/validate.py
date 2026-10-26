#!/usr/bin/env python3
"""Validate this source ledger's schemas, anchors and bounded scope, not UI runtime."""

from collections import Counter
import csv
import hashlib
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
SURFACE_HEADER = ["surface_id", "owner", "source_file", "source_symbol", "entry_point", "state", "locale_path", "source_finding", "evidence_level", "existing_test", "coverage_limit"]
FILE_HEADER = ["source_file", "disposition", "evidence"]


def validate(directory=HERE, root=ROOT):
    errors = []
    source_cache = {}
    existence_cache = {}

    def source_exists(path):
        if path not in existence_cache:
            existence_cache[path] = path.is_file()
        return existence_cache[path]

    def source_lines(path):
        if path not in source_cache:
            source_cache[path] = path.read_text(encoding="utf-8").splitlines()
        return source_cache[path]

    def rows(name, header):
        with (directory / name).open(encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if reader.fieldnames != header:
                errors.append(f"{name}: incorrect header")
                return []
            data = list(reader)
        for index, row in enumerate(data, 2):
            if None in row or any(value is None for value in row.values()):
                errors.append(f"{name}:{index}: malformed CSV")
                continue
            for field, value in row.items():
                if field != "existing_test" and not value.strip():
                    errors.append(f"{name}:{index}: empty {field}")
            source = row["source_file"]
            if Path(source).is_absolute() or ".." in Path(source).parts or not source_exists(root / source):
                errors.append(f"{name}:{index}: invalid source {source}")
        return data

    files = rows("files.csv", FILE_HEADER)
    surfaces = rows("surfaces.csv", SURFACE_HEADER)
    anchors = rows("source-anchors.csv", ["surface_id", "source_file", "source_symbol", "line", "matched_line"])
    routes = rows("routes.csv", ["route_id", "source_file", "source_symbol", "line", "matched_line", "conclusion"])
    residuals = rows("residuals.csv", ["source_file", "consumer", "boundary", "remaining_check"])
    resolutions = rows("residual-resolutions.csv", ["boundary_id", "original_record", "source_file", "status", "source_resolution", "surface_ids", "remaining_limit", "remaining_check"])
    limits = rows("continuation-limits.csv", ["limit_id", "boundary_ids", "kind", "source_file", "consumer", "remaining_limit", "remaining_check"])
    paths = {row["source_file"] for row in files}
    for name, data, key in [("files.csv", files, "source_file"), ("surfaces.csv", surfaces, "surface_id"), ("source-anchors.csv", anchors, "surface_id"), ("routes.csv", routes, "route_id")]:
        duplicates = [value for value, count in Counter(row[key] for row in data).items() if count > 1]
        if duplicates:
            errors.append(f"{name}: duplicate identifiers {duplicates}")
    with (HERE.parent / "dependencies/unresolved-candidates.csv").open(encoding="utf-8-sig", newline="") as handle:
        primary = {row["source_file"] for row in csv.DictReader(handle)}
    for source in sorted(primary - paths):
        errors.append(f"missing primary disposition: {source}")
    by_id = {row["surface_id"]: row for row in anchors}
    for row in surfaces:
        identifier = row["surface_id"]
        if not identifier.startswith("semantic-dependencies."):
            errors.append(f"invalid surface prefix: {identifier}")
        if row["source_file"] not in paths:
            errors.append(f"missing surface file disposition: {identifier}")
        item = by_id.get(identifier)
        if not item or any(item[field] != row[field] for field in ["source_file", "source_symbol"]):
            errors.append(f"missing/mismatched anchor: {identifier}")
        for test in re.findall(r"(?:packages|apps|scripts|packaging|python)/[^\s;,()]+\.(?:mjs|tsx|ts|py|ps1)\b", row["existing_test"]):
            if not source_exists(root / test):
                errors.append(f"missing test: {test}")
    if set(by_id) != {row["surface_id"] for row in surfaces}:
        errors.append("surface and anchor IDs differ")
    for row in anchors + routes:
        path = root / row["source_file"]
        if not source_exists(path):
            continue
        source_text = source_lines(path)
        try:
            number = int(row["line"])
            if number < 1 or number > len(source_text) or source_text[number - 1] != row["matched_line"]:
                errors.append(f"stale source line: {row['source_file']}:{number}")
        except ValueError:
            errors.append(f"invalid anchor line: {row['source_file']}")
            continue
        symbol = row["source_symbol"]
        if not symbol.endswith(f":L{number}"):
            errors.append(f"symbol line differs: {symbol}")
        text = row["matched_line"].strip()
        if symbol.startswith("implementation:function ") and not re.match(r"(?:export )?(?:default )?(?:async )?function \w+[<(]", text):
            errors.append(f"function anchor is not a declaration: {symbol}")
        if symbol.startswith("implementation:class ") and not re.match(r"(?:export )?class \w+", text):
            errors.append(f"class anchor is not a declaration: {symbol}")
        if symbol.startswith("implementation:method ") and not re.match(r"(?:(?:private|public|protected|static|async) )*\w+\(", text):
            errors.append(f"method anchor is not a declaration: {symbol}")
        if symbol.startswith("declaration:initializer ") and not re.match(r"(?:export )?(?:const|let|var) \w+\s*=", text):
            errors.append(f"initializer anchor is not a declaration: {symbol}")
    # Check cited path/line references as well as the primary source_file columns.
    for row in files + surfaces + residuals + resolutions + limits:
        for value in row.values():
            for path, line in re.findall(r"((?:packages|scripts)/[^\s;,()]+):L(\d+)\b", value):
                source = root / path
                if not source_exists(source):
                    errors.append(f"missing cited source: {path}")
                elif int(line) < 1 or int(line) > len(source_lines(source)):
                    errors.append(f"invalid cited line: {path}:L{line}")
    export_dir = root / "packages/cli/node_modules/@earendil-works/pi-coding-agent/dist/core/export-html"
    export_assets = {path.relative_to(root).as_posix() for path in export_dir.rglob("*") if path.is_file() and not path.name.endswith((".map", ".d.ts"))}
    if export_assets - paths:
        errors.append(f"missing export implementations/assets: {sorted(export_assets - paths)}")
    counts = json.loads((directory / "validation.json").read_text(encoding="utf-8"))
    actual = {
        "primary_candidate_files": len(primary),
        "primary_candidate_files_dispositioned": len(primary & paths),
        "primary_without_surface_family": sorted(primary - {row["source_file"] for row in surfaces}),
        "additional_file_dispositions": len(paths - primary),
        "file_dispositions": len(files),
        "surface_state_families": len(surfaces),
        "surface_source_files": len({row["source_file"] for row in surfaces}),
        "families_with_existing_test_pointer": sum(bool(row["existing_test"]) for row in surfaces),
        "immediate_export_implementation_assets": len(export_assets),
        "immediate_export_implementation_assets_dispositioned": len(export_assets & paths),
        "verified_route_anchors": len(routes),
        "verified_surface_anchors": len(anchors),
        "residual_source_consumer_records": len(residuals),
        "evidence_levels": dict(sorted(Counter(row["evidence_level"] for row in surfaces).items())),
        "file_dispositions_by_kind": dict(sorted(Counter(row["disposition"] for row in files).items())),
    }
    # Independently enforce immutable first-pass row content/order and byte prefix.
    receipt = json.loads((directory / "snapshot-preservation.json").read_text(encoding="utf-8"))["files"]
    for name, original in receipt.items():
        content = (directory / name).read_bytes()
        if name.endswith(".csv"):
            with (directory / name).open(encoding="utf-8-sig", newline="") as handle:
                records = list(csv.reader(handle))
            hashes = [hashlib.sha256(json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest() for row in records[1:1 + original["rows"]]]
            if records[0] != original["header"] or hashes != original["row_sha256"]:
                errors.append(f"original rows changed/reordered: {name}")
            if hashlib.sha256(content[:original["bytes"]]).hexdigest() != original["sha256"]:
                errors.append(f"original byte prefix changed: {name}")
        elif name == "check-results.json" and hashlib.sha256(content).hexdigest() != original["sha256"]:
            errors.append("historical check-results.json changed")
    continuation_prefix = "semantic-dependencies.continuation."
    continuation_surfaces = {row["surface_id"] for row in surfaces if row["surface_id"].startswith(continuation_prefix)}
    statuses = {"closed-at-selected-source", "open-runtime", "open-unbounded", "open-unbounded-and-runtime"}
    if len(resolutions) != len(residuals) or len(resolutions) != receipt["residuals.csv"]["rows"]:
        errors.append("one continuation resolution required for every original residual")
    expected_statuses = ["closed-at-selected-source"] * 8 + ["open-unbounded", "open-unbounded-and-runtime", "closed-at-selected-source", "open-runtime", "open-runtime"]
    for index, row in enumerate(resolutions, 1):
        if row["boundary_id"] != f"original-{index:02}" or row["original_record"] != str(index):
            errors.append(f"wrong original residual identity: {row['boundary_id']}")
        if index <= len(residuals) and row["source_file"] != residuals[index - 1]["source_file"]:
            errors.append(f"resolution source differs: {row['boundary_id']}")
        if row["status"] not in statuses or index > len(expected_statuses) or row["status"] != expected_statuses[index - 1]:
            errors.append(f"incorrect source/runtime resolution status: {row['boundary_id']}")
        if not set(row["surface_ids"].split("; ")) <= continuation_surfaces:
            errors.append(f"missing continuation evidence: {row['boundary_id']}")
    valid_boundaries = {row["boundary_id"] for row in resolutions}
    for row in limits:
        if not set(row["boundary_ids"].split("; ")) <= valid_boundaries:
            errors.append(f"unknown residual in limit: {row['limit_id']}")
    if len({row["limit_id"] for row in limits}) != len(limits):
        errors.append("duplicate continuation limit identifier")
    actual["continuation"] = {
        "original_residuals": len(resolutions),
        "source_closed_original_residuals": sum(row["status"] == "closed-at-selected-source" for row in resolutions),
        "open_original_residuals": sum(row["status"].startswith("open-") for row in resolutions),
        "original_residual_statuses": dict(sorted(Counter(row["status"] for row in resolutions).items())),
        "appended_file_dispositions": len(files) - receipt["files.csv"]["rows"],
        "appended_surface_families": len(continuation_surfaces),
        "appended_route_anchors": sum(row["route_id"].startswith("continuation.") for row in routes),
        "active_limit_records": len(limits),
        "baseline": {key: receipt[name]["rows"] for key, name in [("file_dispositions", "files.csv"), ("surface_state_families", "surfaces.csv"), ("verified_route_anchors", "routes.csv"), ("verified_surface_anchors", "source-anchors.csv")]},
    }
    for key, value in actual.items():
        if counts.get(key) != value:
            errors.append(f"stale computed count: {key}")
    return {**actual, "errors": errors, "semantic_completeness": "bounded-source-review-only", "runtime_signoff": "not-established"}


if __name__ == "__main__":
    result = validate()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(bool(result["errors"]))
