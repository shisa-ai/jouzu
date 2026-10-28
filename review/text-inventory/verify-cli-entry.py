#!/usr/bin/env python3
"""Verify CLI-entry audit data against the pinned repository source.

Run: python -B review/text-inventory/verify-cli-entry.py
Reads source/CSV with Python's standard library; no Jouzu execution, installs,
network, imports of product code, or test-suite execution. File hashes include
line endings. Full reviewed bodies and partial supporting scope are recorded in
cli-entry-scope.csv; this does not validate runtime layout or platform behavior.
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
         ("cli", "main-cli", "presentation", "runtime", "runtime-diagnostics")]
REFERENCE = re.compile(r"(packages/[A-Za-z0-9_@./-]+):(\d+)(?:-(\d+))?")
CALL = re.compile(r"catalog call: (packages/[^:;]+):(\d+); expression: (.*)$")
ALIAS = re.compile(r"\b(CatalogMessageId|CliMessageId|PRESENTATION_IDS|DIAGNOSTICS_MESSAGE_ID)\.(\w+)")
CACHE = {}


def lines(path):
    if path not in CACHE:
        CACHE[path] = (ROOT / path).read_text(encoding="utf-8").splitlines()
    return CACHE[path]


def line(path, number):
    values = lines(path)
    assert 1 <= number <= len(values), f"Bad anchor {path}:{number}"
    return values[number - 1]


def read_csv(name):
    with (HERE / name).open(encoding="utf-8", newline="") as stream:
        reader = csv.DictReader(stream)
        return reader.fieldnames, list(reader)


def map_ids(path):
    return dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$',
                           "\n".join(lines(path)), re.M))


def main():
    columns, rows = read_csv("cli-entry.csv")
    assert columns == COLUMNS
    assert len({r["item_id"] for r in rows}) == len(rows)
    _, scope = read_csv("cli-entry-scope.csv")
    assert {r["path"] for r in scope if r["status"] == "reviewed-source"} == set(FILES)
    pinned = 0
    for record in scope:
        if record["sha256"]:
            assert hashlib.sha256((ROOT / record["path"]).read_bytes()).hexdigest() == record["sha256"], record["path"]
            pinned += 1
    fixed = dynamic = catalog = references = 0
    calls = set()
    fixed_locations = set()
    for row in rows:
        assert all(row[k] for k in COLUMNS if k not in ("message_id", "english")), row["item_id"]
        path, number = row["english_location"].rsplit(":", 1)
        source = line(path, int(number))
        if row["message_id"]:
            catalog += 1
            # Every catalog pattern used by this finite partition is one-line FTL.
            assert source.strip() == row["message_id"].replace(".", "-") + " = " + row["english"], row["item_id"]
            match = CALL.search(row["evidence"])
            assert match, row["item_id"]
            file, anchor, expression = match.groups()
            assert expression in line(file, int(anchor)), row["item_id"]
            calls.add((file, int(anchor), expression, row["message_id"]))
        elif row["english"]:
            fixed += 1
            # Source literal payloads preserve TypeScript escapes rather than
            # rendering ANSI control bytes or evaluating template interpolation.
            assert row["english"] in source, row["item_id"]
            fixed_locations.add((path, int(number)))
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
    tables = {
        "CatalogMessageId": map_ids("packages/cli/src/cli-messages.ts"),
        "CliMessageId": map_ids("packages/cli/src/human-messages.ts"),
        "PRESENTATION_IDS": map_ids("packages/cli/src/presentation.ts"),
        "DIAGNOSTICS_MESSAGE_ID": map_ids("packages/cli/src/runtime-diagnostics.ts"),
    }
    # Independent finite source-reference scan: alias-table definitions do not
    # count as display uses. The proved-unreachable uses have explicit scope records.
    occurrences = 0
    unreachable = []
    for file in FILES:
        for number, source in enumerate(lines(file), 1):
            if file.endswith("presentation.ts") and number < 130:
                continue
            if file.endswith("runtime-diagnostics.ts") and number <= 34:
                continue
            if source.lstrip().startswith("//"):
                continue
            for table, key in ALIAS.findall(source):
                mid = tables[table][key]
                expression = table + "." + key
                occurrences += 1
                excluded = any(r["status"] == "unreachable-catalog-use" and
                               r["path"] == file + ":" + str(number) and r["coverage"] == mid for r in scope)
                if excluded:
                    unreachable.append((file, number, mid))
                else:
                    assert (file, number, expression, mid) in calls, (file, number, expression, mid)
            # Direct quoted stable IDs in the reviewed bodies also need a row.
            for mid in re.findall(r'"(jouzu\.cli\.[^"]+)"', source):
                assert (file, number, '"' + mid + '"', mid) in calls, (file, number, mid)
    assert set(unreachable) == {
        ("packages/cli/src/cli.ts", 88, "jouzu.cli.usage.selfUpdatePolicyValue"),
        ("packages/cli/src/main-cli.ts", 497, "jouzu.cli.profile.japaneseEnabled"),
        ("packages/cli/src/main-cli.ts", 201, "jouzu.cli.usage.catalogAcceptRevisionDigest"),
        ("packages/cli/src/main-cli.ts", 219, "jouzu.cli.usage.catalogFileRequired"),
    }
    assert "policy !== \"auto-restart\"" in line("packages/cli/src/args.ts", 199)
    assert "operation, json: false, policy" in line("packages/cli/src/args.ts", 203)
    assert "const parsed = parseJouzuArgs(args);" in line("packages/cli/src/cli.ts", 84)
    assert rows[0]["item_id"] == "CLI-ENTRY-002"
    assert not ({"CLI-ENTRY-001", "CLI-ENTRY-015", "CLI-ENTRY-016"} & {r["item_id"] for r in rows})
    assert "if (!revision || !digest ||" in line("packages/cli/src/args.ts", 159)
    assert "operation, json: false, revision, digest" in line("packages/cli/src/args.ts", 162)
    assert "if (!path ||" in line("packages/cli/src/args.ts", 166)
    assert 'json: extra.includes("--json"), path' in line("packages/cli/src/args.ts", 169)
    assert "const parsed = parseJouzuArgs(args);" in line("packages/cli/src/main-cli.ts", 106)
    required_guards = []
    for file in ("packages/cli/src/cli.ts", "packages/cli/src/main-cli.ts"):
        for number, source in enumerate(lines(file), 1):
            match = re.search(r"if \(!parsed\.(\w+)", source)
            if match:
                required_guards.append((file, number, match.group(1)))
    assert required_guards == [("packages/cli/src/cli.ts", 88, "policy"),
                               ("packages/cli/src/main-cli.ts", 200, "revision"),
                               ("packages/cli/src/main-cli.ts", 218, "path")]
    assert sum(r["status"] == "parser-postcondition-audit" for r in scope) == 8
    assert any(c[:3] == ("packages/cli/src/main-cli.ts", 632,
                         "SESSION_UI_MESSAGE_IDS.hintPaletteShortcuts") for c in calls)
    assert any(c[:3] == ("packages/cli/src/runtime-diagnostics.ts", 110,
                         "RUNTIME_RESTART_AVAILABLE_ID") for c in calls)
    # Conservative independent fixed-error and multiword-literal checks. These
    # supplement source-body review, not a claim of a universal TS string parser.
    exceptions = {(r["path"].rsplit(":", 1)[0], int(r["path"].rsplit(":", 1)[1]))
                  for r in scope if r["status"] in
                  ("excluded-supported-route-guard", "excluded-not-displayed-metadata", "excluded-type-schema")}
    errors = []
    multiword = 0
    for file in FILES:
        for number, source in enumerate(lines(file), 1):
            if file.endswith("presentation.ts") and 154 <= number <= 368:
                continue
            if source.lstrip().startswith(("//", "*", "/*")):
                continue
            if re.search(r'new Error\(["\'`]', source):
                errors.append((file, number))
                assert (file, number) in fixed_locations | exceptions, (file, number)
            for literal in re.findall(r'"((?:\\.|[^"\\])*)"', source):
                if re.search(r'[A-Za-z]', literal) and " " in literal.strip():
                    multiword += 1
                    assert (file, number) in fixed_locations | exceptions, (file, number, literal)
    assert errors == [("packages/cli/src/main-cli.ts", 107)]
    assert any(r["status"] == "excluded-model-facing-body" and
               r["path"] == "packages/cli/src/presentation.ts:154-368" for r in scope)
    assert any(r["status"] == "pending-producer-inventory" for r in scope)
    assert (len(rows), catalog, fixed, dynamic, pinned) == (225, 122, 35, 68, 33)
    print(json.dumps({"result": "PASS", "rows": len(rows),
                      "catalog_occurrences": catalog,
                      "unique_catalog_ids": len({r["message_id"] for r in rows if r["message_id"]}),
                      "direct_fixed_occurrences": fixed, "dynamic_or_imported_boundaries": dynamic,
                      "full_reviewed_source_bodies": len(FILES), "source_hash_records": pinned,
                      "distinct_pinned_files": len({r["path"] for r in scope if r["sha256"]}),
                      "path_line_references": references,
                      "reviewed_body_catalog_alias_occurrences": occurrences,
                      "unreachable_catalog_arms": len(unreachable),
                      "source_fixed_error_guards": len(errors), "multiword_literals_scanned": multiword,
                      "product_runtime_executed": False}, indent=2))


if __name__ == "__main__":
    main()
