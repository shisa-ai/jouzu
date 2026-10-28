#!/usr/bin/env python3
"""Check the finite startup-language text partition without executing Jouzu.

Run from any directory: python -B review/text-inventory/verify-startup-language.py
Uses Python standard library and the checked-in source files only. Hashes pin
original audited bytes including line endings. Full reviewed bodies and partial
supporting/caller scope are recorded in startup-language-scope.csv.
"""
import csv
import hashlib
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
COLUMNS = ["item_id", "message_id", "english", "english_location", "display_location",
           "trigger", "consumer_evidence", "translation_boundary", "evidence"]
FILES = ["packages/cli/src/" + name + ".ts" for name in
         ("language-choice", "ui-locale", "locale-catalog", "language-settings")]
REFERENCE = re.compile(r"((?:packages/)[A-Za-z0-9_@./-]+):(\d+)(?:-(\d+))?")
CALL = re.compile(r"catalog call: (packages/[^:;]+):(\d+); expression: (.*)$")
ERROR = re.compile(r"(?:new \w*Error|\bsuper)\(")
CACHE = {}


def lines(path):
    if path not in CACHE:
        CACHE[path] = (ROOT / path).read_text(encoding="utf-8").splitlines()
    return CACHE[path]


def line(path, number):
    values = lines(path)
    assert 1 <= number <= len(values), f"Bad anchor: {path}:{number}"
    return values[number - 1]


def read_csv(name):
    with (HERE / name).open(encoding="utf-8", newline="") as stream:
        reader = csv.DictReader(stream)
        return reader.fieldnames, list(reader)


def main():
    columns, rows = read_csv("startup-language.csv")
    assert columns == COLUMNS
    assert len({r["item_id"] for r in rows}) == len(rows)
    _, scope = read_csv("startup-language-scope.csv")
    assert {r["path"] for r in scope if r["status"] == "reviewed-source"} == set(FILES)
    pinned = 0
    for record in scope:
        if record["sha256"]:
            assert hashlib.sha256((ROOT / record["path"]).read_bytes()).hexdigest() == record["sha256"], record["path"]
            pinned += 1
    fixed = dynamic = catalog = machine = references = 0
    calls = set()
    fixed_locations = set()
    for row in rows:
        assert all(row[k] for k in COLUMNS if k not in ("message_id", "english")), row["item_id"]
        path, number = row["english_location"].rsplit(":", 1)
        source = line(path, int(number))
        if row["message_id"]:
            catalog += 1
            # All patterns used in this finite partition are single-line FTL values.
            assert source.strip() == row["message_id"].replace(".", "-") + " = " + row["english"], row["item_id"]
            match = CALL.search(row["evidence"])
            assert match, row["item_id"]
            file, anchor, expression = match.groups()
            assert expression in line(file, int(anchor)), row["item_id"]
            calls.add((file, int(anchor)))
        elif row["english"]:
            fixed += 1
            assert row["english"].replace("\n", "\\n") in source, row["item_id"]
            fixed_locations.add((path, int(number)))
            if row["translation_boundary"].startswith("Protected machine"):
                machine += 1
        else:
            dynamic += 1
            expression = row["evidence"].partition("expression: ")[2]
            assert expression and expression in source, row["item_id"]
        for value in row.values():
            for match in REFERENCE.finditer(value):
                file, start, end = match.groups()
                line(file, int(start))
                if end:
                    assert int(start) <= int(end)
                    line(file, int(end))
                references += 1
    excluded = set()
    for record in scope:
        if record["status"] == "excluded-caught-internal-text":
            path, number = record["path"].rsplit(":", 1)
            assert record["coverage"] in line(path, int(number)), record["scope_id"]
            excluded.add((path, int(number)))
    # Independent lexical coverage audit of fixed Error constructors. Multiline
    # CatalogLoadError arguments are checked at their actual literal line.
    errors = set()
    for file in FILES:
        values = lines(file)
        for index, source in enumerate(values, 1):
            match = ERROR.search(source)
            if not match:
                continue
            rest = source[match.end():]
            if re.search(r'["\'`]', rest):
                errors.add((file, index))
            elif "new CatalogLoadError(" in source:
                for offset in range(1, 5):
                    if re.search(r'["\'`]', values[index + offset - 1]):
                        errors.add((file, index + offset))
                        break
    assert errors <= fixed_locations | excluded, "Uncovered fixed errors: " + str(errors - fixed_locations - excluded)
    # All catalogText call occurrences in reviewed bodies must have an anchored
    # row, including multiline ID arguments. The self-name dynamic lookup is
    # expanded through its four catalog IDs and two distinct display stages.
    catalog_calls = 0
    for file in FILES:
        for number, source in enumerate(lines(file), 1):
            if "catalogText(" not in source:
                continue
            catalog_calls += 1
            if file.endswith("language-choice.ts") and "SELF_NAME_IDS[tag]" in source:
                assert sum(r["message_id"].startswith("jouzu.cli.language.self.") for r in rows) == 8
            else:
                assert any((file, anchor) in calls for anchor in range(number, number + 5)), (file, number)
    for anchor in (534, 539, 542):
        assert ("packages/cli/src/locale-catalog.ts", anchor) in calls
    assert (len(rows), catalog, fixed, machine, dynamic, len(excluded), pinned) == (143, 62, 63, 38, 18, 21, 15)
    assert any(r["status"] == "pending-helper-inventory" for r in scope)
    print(json.dumps({"result": "PASS", "rows": len(rows), "catalog_occurrences": catalog,
                      "unique_catalog_ids": len({r["message_id"] for r in rows if r["message_id"]}),
                      "direct_fixed_occurrences": fixed - machine,
                      "protected_machine_values": machine, "dynamic_boundaries": dynamic,
                      "excluded_internal_text_occurrences": len(excluded), "pinned_files": pinned,
                      "source_fixed_error_occurrences": len(errors), "source_catalogText_calls": catalog_calls,
                      "path_line_references": references, "product_runtime_executed": False}, indent=2))


if __name__ == "__main__":
    main()
