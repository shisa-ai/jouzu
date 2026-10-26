#!/usr/bin/env python3
"""Validate current-main reconciliation files, not Japanese quality or UI behavior."""

import argparse
import csv
import json
import re
from collections import Counter
from pathlib import Path

from validate import DIRECTORY, GLOSSARY_HEADER, PARTITIONS, ROOT, TRANSLATION_HEADER, placeholders, read_csv, split_list

HEADER = [
    "row_id", "inventory_ids", "status", "current_source_file", "current_source_line",
    "source_revision", "current_english", "current_japanese", "message_id",
    "glossary_terms", "evidence", "next_action",
]
STATUSES = {"remaining_gap", "resolved", "source_changed", "retained_by_policy", "removed", "needs_context"}
PINNED_GIT_SOURCES = {
    "@lhl/pi-tasks": "ec7eb8625a98b15926fba7377f22614c12b524d7",
    "pi-multiloop": "4b79f551c901f85c73141025c42e1df0b818009b",
}


def validate_current(directory=DIRECTORY, root=ROOT):
    errors, warnings = [], []
    glossary = read_csv(directory / "current-glossary.csv", GLOSSARY_HEADER, errors)
    terms = {}
    for row in glossary:
        term = row["term_id"]
        if not term or term in terms:
            errors.append(f"Duplicate/empty current glossary term: {term}")
        terms[term] = row
        for field in GLOSSARY_HEADER:
            if field != "avoid" and not row[field]:
                errors.append(f"Glossary {term}: missing {field}")
    all_rows, originals, by_partition = [], {}, {}
    source_lines = {}
    for partition in PARTITIONS:
        old = read_csv(directory / f"{partition}.csv", TRANSLATION_HEADER, errors)
        original_ids = {row["row_id"]: row for row in old}
        originals.update(original_ids)
        rows = read_csv(directory / f"{partition}-reconciliation.csv", HEADER, errors)
        by_partition[partition] = dict(Counter(row["status"] for row in rows))
        seen = Counter(row["row_id"] for row in rows)
        for row_id in original_ids:
            if seen[row_id] != 1:
                errors.append(f"{partition}: original {row_id} must have exactly one reconciliation")
        for row in rows:
            row_id = row["row_id"]
            original = original_ids.get(row_id)
            if original is None:
                if not row_id.startswith("new-") or row["inventory_ids"] != "NEW":
                    errors.append(f"{row_id}: new rows require new- ID and NEW inventory marker")
            elif row["inventory_ids"] != original["inventory_ids"]:
                errors.append(f"{row_id}: historical inventory links changed")
        all_rows.extend(rows)
    seen = set()
    for row in all_rows:
        row_id, status = row["row_id"], row["status"]
        if not row_id or row_id in seen:
            errors.append(f"Duplicate/empty reconciliation row: {row_id}")
        seen.add(row_id)
        if status not in STATUSES:
            errors.append(f"{row_id}: unknown reconciliation status {status}")
        for field in ["inventory_ids", "source_revision", "evidence", "next_action"]:
            if not row[field]:
                errors.append(f"{row_id}: missing {field}")
        if status not in {"removed", "needs_context"}:
            for field in ["current_source_file", "current_source_line", "current_english", "current_japanese"]:
                if not row[field]:
                    errors.append(f"{row_id}: missing {field}")
        source = row["current_source_file"]
        if source:
            path = root / source
            if Path(source).is_absolute() or ".." in Path(source).parts:
                errors.append(f"{row_id}: source path must be repository-relative")
            elif "/node_modules/" in source:
                # Installed dependencies may predate the merged lock. Remote pinned
                # source evidence is reviewed separately; never attest installed bytes.
                for package, revision in PINNED_GIT_SOURCES.items():
                    if f"/node_modules/{package}/" in source and status != "needs_context":
                        if revision not in row["source_revision"] + row["evidence"]:
                            errors.append(f"{row_id}: current dependency review must identify locked {package} commit")
                if not re.search(r"[1-9]\d*", row["current_source_line"]):
                    errors.append(f"{row_id}: dependency source needs a line anchor")
                if not path.is_file() and "https://raw.githubusercontent.com/" not in row["evidence"]:
                    warnings.append(f"{row_id}: dependency source unavailable locally; inspect pinned source")
            elif status != "removed":
                if not path.is_file():
                    errors.append(f"{row_id}: current source file does not exist: {source}")
                else:
                    if source not in source_lines:
                        source_lines[source] = len(path.read_text(encoding="utf-8-sig").splitlines())
                    line = re.match(r"\d+", row["current_source_line"])
                    if not line or not 1 <= int(line[0]) <= source_lines[source]:
                        errors.append(f"{row_id}: invalid current source line")
        if status == "retained_by_policy" and row["current_english"] != row["current_japanese"]:
            errors.append(f"{row_id}: retained content changed")
        en, ja = row["current_english"], row["current_japanese"]
        if status in {"remaining_gap", "source_changed"} and placeholders(en) != placeholders(ja):
            if re.search(r"normaliz|plural|interpolat|Fluent|placeholder|argument", row["evidence"], re.I):
                warnings.append(f"{row_id}: review documented current template normalization")
            else:
                errors.append(f"{row_id}: current draft placeholders differ without explanation")
        for term_id in split_list(row["glossary_terms"]):
            if term_id not in terms:
                errors.append(f"{row_id}: unknown current glossary term {term_id}")
                continue
            term = terms[term_id]
            text = ja.replace(term["preferred_ja"], "")
            if status in {"remaining_gap", "source_changed"}:
                for avoid in split_list(term["avoid"]):
                    if avoid in text:
                        warnings.append(f"{row_id}: review avoided current glossary form {avoid}")
    return {
        "historical_rows": len(originals),
        "reconciliation_rows": len(all_rows),
        "new_surface_rows": sum(row["row_id"].startswith("new-") for row in all_rows),
        "statuses": dict(Counter(row["status"] for row in all_rows)),
        "statuses_by_partition": by_partition,
        "current_glossary_terms": len(terms),
        "errors": errors,
        "warnings": warnings,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=DIRECTORY)
    args = parser.parse_args()
    try:
        result = validate_current(args.directory.resolve())
    except (csv.Error, OSError, UnicodeError, ValueError) as error:
        result = {"errors": [str(error)], "warnings": []}
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return 1 if result["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
