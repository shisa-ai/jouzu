#!/usr/bin/env python3
"""Verify the finite doctor/report text inventory without running product code.

Run: python -B review/text-inventory/verify-doctor.py
Python standard library only; checks pinned source bytes, exact catalog patterns,
source expressions, field-label mappings, per-lock cases and finite source
coverage. It does not execute doctor probes, install packages or validate native
terminal layout. Source hashes include line endings.
"""
import csv
import hashlib
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BODY = "packages/cli/src/doctor.ts"
RENDERER = "packages/cli/src/command-report.ts"
COLUMNS = ["item_id", "message_id", "english", "english_location", "display_location",
           "trigger", "consumer_evidence", "translation_boundary", "evidence"]
REFERENCE = re.compile(r"(packages/[A-Za-z0-9_@./-]+):(\d+)(?:-(\d+))?")
CALL = re.compile(r"catalog call: (packages/[^:;]+):(\d+); expression: (.*)$")
CACHE = {}
LOCKS = ["lock.profile", "lock.piImport", "lock.keybindings", "lock.modelPicker",
         "lock.update", "lock.camoufoxRuntime"]


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


def main():
    columns, rows = read_csv("doctor.csv")
    assert columns == COLUMNS
    assert len({r["item_id"] for r in rows}) == len(rows)
    _, scope = read_csv("doctor-scope.csv")
    assert {r["path"] for r in scope if r["status"] == "reviewed-source"} == {BODY, RENDERER}
    pinned = set()
    for record in scope:
        if record["sha256"]:
            assert hashlib.sha256((ROOT / record["path"]).read_bytes()).hexdigest() == record["sha256"], record["path"]
            pinned.add(record["path"])
    catalog = fixed = computed = references = 0
    calls = set()
    labels = {}
    for row in rows:
        assert all(row[k] for k in COLUMNS if k not in ("message_id", "english")), row["item_id"]
        path, number = row["english_location"].rsplit(":", 1)
        source = line(path, int(number))
        if row["message_id"]:
            catalog += 1
            # All patterns used in this finite partition are one-line FTL.
            assert source.strip() == row["message_id"].replace(".", "-") + " = " + row["english"], row["item_id"]
            match = CALL.search(row["evidence"])
            assert match, row["item_id"]
            file, anchor, expression = match.groups()
            assert expression in line(file, int(anchor)), row["item_id"]
            calls.add((file, int(anchor), expression, row["message_id"]))
            field = re.search(r"field_id: ([^;]+);", row["evidence"])
            if field:
                assert field.group(1) not in labels
                labels[field.group(1)] = row["message_id"]
        elif row["english"]:
            fixed += 1
            assert row["english"] in source, row["item_id"]
        else:
            computed += 1
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
    shared = "\n".join(lines("packages/cli/src/cli-messages.ts"))
    alias = dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$', shared, re.M))
    label_body = shared.split("export const DOCTOR_FIELD_LABEL_IDS:", 1)[1].split("\n});", 1)[0]
    label_map = {(quoted or bare): mid for quoted, bare, mid in
                 re.findall(r'^\s*(?:"([^"]+)"|(\w+)): "(jouzu\.cli\.[^"]+)",$', label_body, re.M)}
    assert labels == label_map, "Missing/extra/mismatched field label mapping"
    # Independent source scan checks each explicit label helper call and the
    # generic lock label producer, rather than relying on generation traversal.
    label_calls = 0
    aliases = 0
    for number, source in enumerate(lines(BODY), 1):
        for field in re.findall(r'doctorFieldLabel\("([^"]+)"\)', source):
            label_calls += 1
            assert (BODY, number, 'doctorFieldLabel("' + field + '")', label_map[field]) in calls
        for key in re.findall(r'CatalogMessageId\.(\w+)', source):
            aliases += 1
            mid = alias[key]
            if number == 994:
                assert key == "doctorValueNone"
                assert any(r["status"] == "excluded-conforming-type-guard" and
                           r["path"] == BODY + ":994" and r["coverage"] == mid for r in scope)
            else:
                assert (BODY, number, "CatalogMessageId." + key, mid) in calls, (number, key)
    for lock in LOCKS:
        assert (BODY, 1091, "doctorFieldLabel(id)", label_map[lock]) in calls
        for key, status in [("doctorValueLockFree", "free"), ("doctorValueLockHeldLive", "held-live"),
                            ("doctorValueLockHeldDead", "held-dead"), ("doctorValueLockOwnerUnknown", "owner-unknown"),
                            ("doctorValueLockUnreadable", "unreadable"), ("doctorValueLockInvalid", "invalid")]:
            matching = [r for r in rows if r["message_id"] == alias[key] and
                        r["trigger"] == "inspectStateLock for " + lock + " returns " + status]
            assert len(matching) == 1, (lock, status)
        for status in ("unreadable", "held-dead", "owner-unknown", "invalid"):
            key = "doctorProblemLockUnreadable" if status == "unreadable" else "doctorProblemLockStale"
            matching = [r for r in rows if r["message_id"] == alias[key] and
                        r["trigger"] == "inspectStateLock for " + lock + " returns " + status]
            assert len(matching) == 1, (lock, status)
    assert any(c[:3] == (BODY, 316, "UPSTREAM_CONSTRAINT_MESSAGE_ID") for c in calls)
    assert any(c[:3] == (BODY, 319, '"jouzu.cli.doctor.surfaceRecheck"') for c in calls)
    # Current producer guards/exclusions and caught error transports are pinned.
    assert "effective: ArtifactPolicy" in "\n".join(lines("packages/cli/src/language-settings.ts"))
    assert "formatArtifactPolicy(context.artifactPolicy.effective)" in line(BODY, 994)
    assert any(r["status"] == "excluded-current-caller-default" and
               r["path"] == RENDERER + ":607" and r["coverage"] == "${singular}s" for r in scope)
    assert "count === 1 ? singular : plural" in line(RENDERER, 608)
    # All current production callers provide two catalog label arguments;
    # count commas only at the outer call depth to avoid nested helper calls.
    plural_calls = []
    for file in (BODY, "packages/cli/src/catalog-command.ts"):
        for number, source in enumerate(lines(file), 1):
            if "pluralize(" not in source:
                continue
            start = source.index("pluralize(") + len("pluralize")
            depth = commas = 0
            for char in source[start:]:
                if char == "(": depth += 1
                elif char == ")":
                    depth -= 1
                    if depth == 0: break
                elif char == "," and depth == 1: commas += 1
            assert commas == 2, (file, number, source)
            plural_calls.append((file, number))
    assert plural_calls == [(BODY, 332), (BODY, 336),
                            ("packages/cli/src/catalog-command.ts", 63),
                            ("packages/cli/src/catalog-command.ts", 67)]
    assert not any(re.search(r"\bthrow\s+new\b", s) for f in (BODY, RENDERER) for s in lines(f))
    assert [(n, s.strip()) for n, s in enumerate(lines(BODY), 1) if "catch" in s] == [
        (356, "} catch {"), (382, "} catch (error) {"), (670, "} catch (error) {")]
    assert "error.code === \"ENOENT\"" in line(BODY, 383)
    assert any(r["english_location"] == BODY + ":673" and not r["english"] for r in rows)
    assert any(r["english_location"] == BODY + ":1167" and not r["english"] for r in rows)
    assert "text: formatDoctorReport(report" in line(BODY, 1167)
    assert "JSON.stringify(result.report" in line("packages/cli/src/main-cli.ts", 487)
    assert (len(rows), catalog, fixed, computed, len(labels), label_calls, len(pinned)) == (548, 287, 149, 112, 77, 71, 20)
    print(json.dumps({"result": "PASS", "rows": len(rows), "catalog_occurrences": catalog,
                      "unique_catalog_ids": len({r["message_id"] for r in rows if r["message_id"]}),
                      "fixed_or_machine_occurrences": fixed, "computed_payload_boundaries": computed,
                      "field_label_ids": len(labels), "explicit_field_label_calls": label_calls,
                      "concrete_lock_contexts": len(LOCKS), "lock_state_cases": 36, "lock_problem_cases": 24,
                      "source_catalog_alias_occurrences": aliases, "pinned_files": len(pinned),
                      "path_line_references": references, "product_runtime_executed": False}, indent=2))


if __name__ == "__main__":
    main()
