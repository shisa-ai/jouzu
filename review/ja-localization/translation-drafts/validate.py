#!/usr/bin/env python3
"""Check review CSV structure, inventory coverage, and draft glossary references.

This is a source-review aid, not a Japanese language or runtime UI verifier.
Run from any directory: python review/ja-localization/translation-drafts/validate.py
"""

import argparse
import csv
import json
import re
from collections import Counter
from pathlib import Path

DIRECTORY = Path(__file__).resolve().parent
ROOT = DIRECTORY.parents[2]
TRANSLATION_HEADER = [
    "row_id", "inventory_ids", "owner", "source_file", "source_line",
    "source_kind", "message_id", "english_source", "japanese_draft",
    "existing_ja", "display_context", "behavior_note", "placeholders",
    "protected_values", "glossary_terms", "disposition", "review_status",
]
GLOSSARY_HEADER = [
    "term_id", "english", "preferred_ja", "semantic_scope", "avoid", "evidence", "status",
]
COVERAGE_HEADER = ["inventory_id", "status", "row_ids", "notes"]
PARTITIONS = ["jouzu-ui", "pi-and-previews", "extensions-cli-launcher"]
DISPOSITIONS = {
    "translate", "reuse_existing_ja", "display_only", "retain_protected",
    "preserve_content", "needs_context",
}
KINDS = {"literal", "template", "catalog_pattern", "display_value", "boundary"}


def read_csv(path, header, errors):
    if not path.is_file():
        errors.append(f"Missing CSV: {path.name}")
        return []
    with path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream, strict=True)
        if reader.fieldnames != header:
            errors.append(f"{path.name}: header differs from the documented schema")
        rows = list(reader)
    valid = []
    for number, row in enumerate(rows, 2):
        if None in row or any(value is None for value in row.values()):
            errors.append(f"{path.name}:{number}: malformed column count")
        else:
            valid.append(row)
    return valid


def split_list(value):
    return [part.strip() for part in value.split("|") if part.strip()]


def placeholders(text):
    """Extract Fluent variables and balanced JavaScript template expressions.

    Nested expressions remain opaque tokens. This does not parse JavaScript or
    Fluent syntax; a human must review grammatical-template normalizations.
    """
    found = Counter(re.findall(r"(?<!\$)\{\s*\$[A-Za-z][\w]*\s*\}", text))
    start = 0
    while True:
        start = text.find("${", start)
        if start < 0:
            break
        depth, position = 1, start + 2
        quote = None
        escaped = False
        while position < len(text) and depth:
            char = text[position]
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif quote:
                if char == quote:
                    quote = None
            elif char in "\"'`":
                quote = char
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
            position += 1
        if depth:
            found["<unclosed-template-expression>"] += 1
            break
        found[text[start:position]] += 1
        start = position
    return found


def validate(directory=DIRECTORY):
    errors, warnings = [], []
    glossary = read_csv(directory / "glossary.csv", GLOSSARY_HEADER, errors)
    terms = {}
    for row in glossary:
        term = row.get("term_id", "")
        if not term or term in terms:
            errors.append(f"Duplicate/empty glossary term: {term}")
        terms[term] = row
        for field in GLOSSARY_HEADER:
            if field != "avoid" and not row.get(field):
                errors.append(f"Glossary {term}: missing {field}")
    inventory_path = ROOT / "review/ja-localization/untranslated-text.md"
    numbered_ids = set(re.findall(r"^\| ([JPCEL]\d+) \|", inventory_path.read_text(encoding="utf-8"), re.M))
    # Named sections have no numbered finding ID but have their own draft rows.
    optional_ids = {"BOUNDARY", "P-MODEL-FALLBACK"}
    expected = numbered_ids | optional_ids
    all_rows, coverage = [], []
    partition_counts = {}
    for partition in PARTITIONS:
        rows = read_csv(directory / f"{partition}.csv", TRANSLATION_HEADER, errors)
        partition_counts[partition] = len(rows)
        all_rows.extend(rows)
        coverage.extend(read_csv(directory / f"{partition}-coverage.csv", COVERAGE_HEADER, errors))
    row_ids = {}
    line_counts = {}
    reused, untranslated_boundaries = 0, 0
    for row in all_rows:
        row_id = row.get("row_id", "")
        if not row_id or row_id in row_ids:
            errors.append(f"Duplicate/empty translation row ID: {row_id}")
        row_ids[row_id] = row
        for field in [
            "inventory_ids", "owner", "source_file", "source_line", "source_kind",
            "english_source", "japanese_draft", "display_context", "behavior_note",
            "disposition", "review_status",
        ]:
            if not row.get(field):
                errors.append(f"{row_id}: missing {field}")
        if row.get("source_kind") not in KINDS:
            errors.append(f"{row_id}: unknown source_kind")
        disposition = row.get("disposition")
        if disposition not in DISPOSITIONS:
            errors.append(f"{row_id}: unknown disposition")
        for inventory_id in split_list(row.get("inventory_ids", "")):
            if inventory_id != "BOUNDARY" and inventory_id not in expected:
                errors.append(f"{row_id}: unknown inventory ID {inventory_id}")
        path = ROOT / row.get("source_file", "")
        if not path.is_file():
            errors.append(f"{row_id}: source file not found: {row.get('source_file')}")
        else:
            if path not in line_counts:
                line_counts[path] = len(path.read_text(encoding="utf-8-sig").splitlines())
            # Multiple anchors/ranges may be documented, but the first must exist.
            line = re.match(r"\d+", row.get("source_line", ""))
            if not line or not 1 <= int(line[0]) <= line_counts[path]:
                errors.append(f"{row_id}: invalid first source line")
        en, ja = row.get("english_source", ""), row.get("japanese_draft", "")
        if disposition == "reuse_existing_ja":
            reused += 1
            if not row.get("message_id") or not row.get("existing_ja"):
                errors.append(f"{row_id}: catalog reuse requires message_id and existing_ja")
            if row.get("existing_ja") != ja:
                errors.append(f"{row_id}: reused Japanese was changed")
        if disposition in {"retain_protected", "preserve_content"}:
            untranslated_boundaries += 1
            if en != ja:
                errors.append(f"{row_id}: preserved content differs")
        if placeholders(en) != placeholders(ja):
            # A plural-expression rewrite may intentionally use semantic arguments;
            # it must be explained and still requires manual review.
            if re.search(r"normaliz", row.get("behavior_note", ""), re.I):
                warnings.append(f"{row_id}: manually review documented placeholder normalization")
            else:
                errors.append(f"{row_id}: source/draft placeholder tokens differ")
        for token in split_list(row.get("protected_values", "")):
            if token not in en or token not in ja:
                errors.append(f"{row_id}: protected token not preserved: {token}")
        for term_id in split_list(row.get("glossary_terms", "")):
            term = terms.get(term_id)
            if term is None:
                errors.append(f"{row_id}: unknown glossary term {term_id}")
                continue
            # A preferred form can contain its avoided spelling (e.g. a long vowel).
            remaining_ja = ja.replace(term.get("preferred_ja", ""), "")
            for avoid in split_list(term.get("avoid", "")):
                if avoid in remaining_ja and disposition not in {"reuse_existing_ja", "preserve_content", "retain_protected"}:
                    warnings.append(f"{row_id}: review avoided glossary form {avoid}")
    covered = set()
    for row in coverage:
        inventory_id = row.get("inventory_id", "")
        if inventory_id not in expected:
            errors.append(f"Unknown coverage inventory ID: {inventory_id}")
        if inventory_id in covered and inventory_id not in optional_ids:
            errors.append(f"Duplicate coverage inventory ID: {inventory_id}")
        covered.add(inventory_id)
        if row.get("status") not in {"covered", "retained_by_policy", "needs_context"}:
            errors.append(f"{inventory_id}: unknown coverage status")
        linked = split_list(row.get("row_ids", ""))
        if row.get("status") == "covered" and not linked:
            errors.append(f"{inventory_id}: covered without translation rows")
        if row.get("status") != "covered" and not row.get("notes"):
            errors.append(f"{inventory_id}: coverage exception requires notes")
        for row_id in linked:
            if row_id not in row_ids:
                errors.append(f"{inventory_id}: missing coverage row {row_id}")
            elif inventory_id not in split_list(row_ids[row_id].get("inventory_ids", "")):
                errors.append(f"{inventory_id}: linked row {row_id} does not name this inventory ID")
    for missing in sorted(numbered_ids - covered):
        errors.append(f"Missing inventory coverage: {missing}")
    return {
        "translation_rows": len(all_rows), "rows_by_partition": partition_counts,
        "inventory_families": len(numbered_ids), "coverage_entries": len(coverage),
        "glossary_terms": len(terms), "reused_catalog_rows": reused,
        "preserved_boundary_rows": untranslated_boundaries,
        "errors": errors, "warnings": warnings,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=DIRECTORY)
    args = parser.parse_args()
    try:
        result = validate(args.directory.resolve())
    except (csv.Error, OSError, UnicodeError) as error:
        result = {"errors": [str(error)], "warnings": []}
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return 1 if result["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
