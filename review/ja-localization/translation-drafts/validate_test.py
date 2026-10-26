"""Deterministic checks for the translation-review CSV validator."""

import csv
import re
import tempfile
import unittest
from pathlib import Path

from validate import (
    COVERAGE_HEADER,
    GLOSSARY_HEADER,
    PARTITIONS,
    ROOT,
    TRANSLATION_HEADER,
    placeholders,
    validate,
)


def write_csv(path, header, rows):
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=header)
        writer.writeheader()
        writer.writerows(rows)


class ValidatorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        inventory = (ROOT / "review/ja-localization/untranslated-text.md").read_text(encoding="utf-8")
        self.inventory_ids = re.findall(r"^\| ([JPCEL]\d+) \|", inventory, re.M)
        self.rows = []
        self.coverage = []
        for number, inventory_id in enumerate(self.inventory_ids):
            row_id = f"test-{number}"
            row = {name: "" for name in TRANSLATION_HEADER}
            row.update(
                row_id=row_id, inventory_ids=inventory_id, owner="test-only fixture",
                source_file="README.md", source_line="1", source_kind="template",
                english_source="Save ${value}", japanese_draft="${value} を保存",
                display_context="Fixture view", behavior_note="Fixture save action",
                placeholders="${value}", disposition="translate",
                review_status="draft-code-context-checked",
            )
            self.rows.append(row)
            self.coverage.append({
                "inventory_id": inventory_id, "status": "covered",
                "row_ids": row_id, "notes": "Fixture coverage",
            })
        self.flush()

    def flush(self):
        write_csv(self.directory / "glossary.csv", GLOSSARY_HEADER, [])
        for index, partition in enumerate(PARTITIONS):
            write_csv(self.directory / f"{partition}.csv", TRANSLATION_HEADER, self.rows if index == 0 else [])
            write_csv(self.directory / f"{partition}-coverage.csv", COVERAGE_HEADER, self.coverage if index == 0 else [])

    def errors(self):
        self.flush()
        return validate(self.directory)["errors"]

    def test_valid_csvs_round_trip_with_complete_coverage(self):
        self.assertEqual(self.errors(), [])
        self.assertEqual(validate(self.directory)["translation_rows"], len(self.inventory_ids))

    def test_preferred_glossary_form_does_not_trigger_its_avoided_substring(self):
        self.rows[0].update(japanese_draft="プロバイダー ${value}", glossary_terms="provider")
        self.flush()
        term = dict(zip(GLOSSARY_HEADER, [
            "provider", "provider", "プロバイダー", "Generic service noun",
            "プロバイダ", "docs/localization-glossary.md", "proposed",
        ]))
        write_csv(self.directory / "glossary.csv", GLOSSARY_HEADER, [term])
        self.assertEqual(validate(self.directory)["warnings"], [])
        self.rows[0]["japanese_draft"] = "プロバイダー / プロバイダ ${value}"
        write_csv(self.directory / f"{PARTITIONS[0]}.csv", TRANSLATION_HEADER, self.rows)
        self.assertEqual(len(validate(self.directory)["warnings"]), 1)

    def test_named_boundary_coverage_can_appear_in_multiple_partitions(self):
        for number in range(2):
            row = dict(self.rows[number])
            row.update(row_id=f"boundary-{number}", inventory_ids="BOUNDARY")
            self.rows.append(row)
            self.coverage.append({
                "inventory_id": "BOUNDARY", "status": "covered",
                "row_ids": row["row_id"], "notes": "Separate boundary scope",
            })
        self.assertEqual(self.errors(), [])

    def test_fallback_section_has_named_coverage(self):
        row = dict(self.rows[0])
        row.update(row_id="fallback-1", inventory_ids="P-MODEL-FALLBACK")
        self.rows.append(row)
        self.coverage.append({
            "inventory_id": "P-MODEL-FALLBACK", "status": "covered",
            "row_ids": row["row_id"], "notes": "Conditional fallback only",
        })
        self.assertEqual(self.errors(), [])

    def test_malformed_column_count_reports_error_without_crashing(self):
        self.flush()
        path = self.directory / f"{PARTITIONS[0]}.csv"
        with path.open("a", encoding="utf-8") as stream:
            stream.write("too,few,columns\n")
        self.assertTrue(any("malformed column count" in error for error in validate(self.directory)["errors"]))

    def test_missing_placeholder_is_rejected(self):
        self.rows[0]["japanese_draft"] = "保存"
        self.assertTrue(any("placeholder tokens differ" in error for error in self.errors()))

    def test_javascript_and_fluent_tokens_are_counted(self):
        text = '${source?.map(x => ({value: x})).join("}")} / { $count } / { $count }'
        actual = placeholders(text)
        self.assertEqual(actual['${source?.map(x => ({value: x})).join("}")}'], 1)
        self.assertEqual(actual["{ $count }"], 2)

    def test_protected_token_must_exist_in_both_languages(self):
        self.rows[0]["protected_values"] = "/flow clear"
        self.assertTrue(any("protected token not preserved" in error for error in self.errors()))

    def test_unknown_glossary_reference_is_rejected(self):
        self.rows[0]["glossary_terms"] = "missing-term"
        self.assertTrue(any("unknown glossary term" in error for error in self.errors()))

    def test_reused_japanese_cannot_be_silently_rewritten(self):
        self.rows[0].update(disposition="reuse_existing_ja", message_id="fixture-id", existing_ja="別の文言")
        self.assertTrue(any("reused Japanese was changed" in error for error in self.errors()))

    def test_source_anchor_must_exist(self):
        self.rows[0]["source_line"] = "99999999"
        self.assertTrue(any("invalid first source line" in error for error in self.errors()))

    def test_coverage_must_link_a_row_with_the_same_inventory_id(self):
        self.coverage[0]["row_ids"] = self.rows[1]["row_id"]
        self.assertTrue(any("does not name this inventory ID" in error for error in self.errors()))

    def test_duplicate_row_ids_are_rejected(self):
        self.rows[1]["row_id"] = self.rows[0]["row_id"]
        self.assertTrue(any("Duplicate/empty translation row ID" in error for error in self.errors()))

    def test_missing_coverage_is_rejected(self):
        self.coverage.pop()
        self.assertTrue(any("Missing inventory coverage" in error for error in self.errors()))

    def test_documented_normalization_requires_manual_review(self):
        self.rows[0].update(japanese_draft="保存", behavior_note="Documented normalization for review")
        self.flush()
        result = validate(self.directory)
        self.assertEqual(result["errors"], [])
        self.assertTrue(any("normalization" in warning for warning in result["warnings"]))

    def test_preserved_content_cannot_change(self):
        self.rows[0]["disposition"] = "preserve_content"
        self.assertTrue(any("preserved content differs" in error for error in self.errors()))


if __name__ == "__main__":
    unittest.main()
