#!/usr/bin/env python3
"""Check audit structure and undispositioned source files, not UI completeness."""

import argparse
from collections import Counter
import csv
import json
from pathlib import Path
import re

from census import ROOT, census

DIRECTORY = Path(__file__).resolve().parent
SURFACE_HEADER = [
    "surface_id", "owner", "source_file", "source_symbol", "entry_point", "state",
    "locale_path", "source_finding", "evidence_level", "existing_test", "coverage_limit",
]
FILE_HEADER = ["source_file", "disposition", "evidence"]


def validate(directory=DIRECTORY, root=ROOT):
    errors = []
    surfaces = []
    dispositions = {}
    review_depth_counts = Counter()
    for filename, header in [("surfaces.csv", SURFACE_HEADER), ("files.csv", FILE_HEADER)]:
        for path in sorted(directory.glob(f"*/{filename}")):
            with path.open(encoding="utf-8-sig", newline="") as handle:
                reader = csv.DictReader(handle)
                if reader.fieldnames != header:
                    errors.append(f"{path.relative_to(directory)}: unexpected CSV header")
                    continue
                for line, row in enumerate(reader, 2):
                    if None in row or any(value is None for value in row.values()):
                        errors.append(f"{path.relative_to(directory)}:{line}: malformed row")
                        continue
                    source = row["source_file"]
                    if Path(source).is_absolute() or ".." in Path(source).parts or not (root / source).is_file():
                        errors.append(f"{path.relative_to(directory)}:{line}: invalid source file {source}")
                    if filename == "files.csv":
                        review_depth_counts[row["disposition"]] += 1
                        if not row["disposition"].strip() or not row["evidence"].strip():
                            errors.append(f"{path.relative_to(directory)}:{line}: missing disposition/evidence")
                        if row["disposition"].lower() in {"delegated", "pending", "uninspected"}:
                            continue
                        dispositions.setdefault(source, []).append(row)
                    else:
                        for field in SURFACE_HEADER:
                            if field != "existing_test" and not row[field].strip():
                                errors.append(f"{path.relative_to(directory)}:{line}: missing {field}")
                        for test in re.findall(r"(?:packages|apps|scripts|packaging|python)/[^\s;,()]+\.(?:mjs|tsx|ts|py|ps1)\b", row["existing_test"]):
                            if not (root / test).is_file():
                                errors.append(f"{path.relative_to(directory)}:{line}: missing test pointer {test}")
                        surfaces.append(row)
    identifiers = Counter(row["surface_id"] for row in surfaces)
    for identifier, count in identifiers.items():
        if not identifier or count != 1:
            errors.append(f"duplicate/empty surface_id: {identifier}")
    current = census(root)
    sources = {row["source_file"] for row in current["files"]}
    missing = sorted(sources - dispositions.keys())
    saved_path = directory / "source-census.json"
    if saved_path.exists():
        saved = json.loads(saved_path.read_text(encoding="utf-8"))
        saved_sources = {row["source_file"]: row["sha256"] for row in saved["files"]}
        current_sources = {row["source_file"]: row["sha256"] for row in current["files"]}
        if saved_sources != current_sources:
            errors.append("source census is stale; regenerate and review changed scope/bytes")
    else:
        errors.append("missing source-census.json")
    return {
        "candidate_source_files": len(sources),
        "dispositioned_candidate_files": len(sources & dispositions.keys()),
        "surface_state_rows": len(surfaces),
        "evidence_levels": dict(sorted(Counter(row["evidence_level"] for row in surfaces).items())),
        "undispositioned_sources": missing,
        "errors": errors,
        "source_disposition_counts": dict(sorted(review_depth_counts.items())),
        "semantic_review_signoff": "not-established-by-this-validator",
        "runtime_signoff": "not-established-by-this-validator",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-incomplete", action="store_true", help="report undispositioned files without success claims")
    args = parser.parse_args()
    result = validate()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(1 if result["errors"] or (result["undispositioned_sources"] and not args.allow_incomplete) else 0)


if __name__ == "__main__":
    main()
