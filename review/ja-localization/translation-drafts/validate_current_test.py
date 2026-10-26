"""Checks for review-only reconciliation coverage and current draft integrity."""

import tempfile
import unittest
from pathlib import Path

from validate import GLOSSARY_HEADER, PARTITIONS, TRANSLATION_HEADER
from validate_current import HEADER, validate_current
from validate_test import write_csv


class CurrentValidatorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.directory = self.root / "review"
        self.directory.mkdir()
        (self.root / "source.ts").write_text("example\n", encoding="utf-8")
        self.rows = {}
        for index, partition in enumerate(PARTITIONS):
            original = {field: "" for field in TRANSLATION_HEADER}
            original.update(row_id=f"original-{index}", inventory_ids="J01")
            write_csv(self.directory / f"{partition}.csv", TRANSLATION_HEADER, [original])
            row = {field: "" for field in HEADER}
            row.update(
                row_id=original["row_id"], inventory_ids="J01", status="remaining_gap",
                current_source_file="source.ts", current_source_line="1", source_revision="fixture",
                current_english="Save ${value}", current_japanese="${value} を保存",
                evidence="Fixture caller renders English.", next_action="Localize the display wrapper.",
            )
            self.rows[partition] = [row]
        write_csv(self.directory / "current-glossary.csv", GLOSSARY_HEADER, [])
        self.flush()

    def flush(self):
        for partition, rows in self.rows.items():
            write_csv(self.directory / f"{partition}-reconciliation.csv", HEADER, rows)

    def result(self):
        self.flush()
        return validate_current(self.directory, self.root)

    def first(self):
        return self.rows[PARTITIONS[0]][0]

    def test_valid_reconciliation_covers_every_original(self):
        self.assertEqual(self.result()["errors"], [])
        self.assertEqual(self.result()["historical_rows"], len(PARTITIONS))

    def test_missing_original_is_rejected(self):
        self.rows[PARTITIONS[0]].clear()
        self.assertTrue(any("exactly one reconciliation" in error for error in self.result()["errors"]))

    def test_duplicate_original_is_rejected(self):
        self.rows[PARTITIONS[0]].append(dict(self.first()))
        self.assertTrue(any("Duplicate/empty reconciliation" in error for error in self.result()["errors"]))

    def test_new_surface_requires_explicit_marker(self):
        row = dict(self.first())
        row["row_id"] = "new-jouzu-0001"
        self.rows[PARTITIONS[0]].append(row)
        self.assertTrue(any("NEW inventory marker" in error for error in self.result()["errors"]))
        row["inventory_ids"] = "NEW"
        self.assertEqual(self.result()["errors"], [])
        self.assertEqual(self.result()["new_surface_rows"], 1)

    def test_source_anchor_is_checked_against_current_source(self):
        self.first()["current_source_line"] = "999"
        self.assertTrue(any("invalid current source line" in error for error in self.result()["errors"]))

    def test_retained_content_cannot_be_translated(self):
        self.first()["status"] = "retained_by_policy"
        self.assertTrue(any("retained content changed" in error for error in self.result()["errors"]))

    def test_current_draft_must_preserve_placeholders(self):
        self.first()["current_japanese"] = "保存"
        self.assertTrue(any("placeholders differ" in error for error in self.result()["errors"]))
        self.first()["evidence"] += " Documented plural normalization."
        self.assertEqual(self.result()["errors"], [])
        self.assertTrue(self.result()["warnings"])

    def test_status_and_glossary_reference_are_checked(self):
        self.first().update(status="done", glossary_terms="unknown")
        errors = self.result()["errors"]
        self.assertTrue(any("unknown reconciliation status" in error for error in errors))
        self.assertTrue(any("unknown current glossary term" in error for error in errors))

    def test_removed_source_does_not_need_a_live_file(self):
        self.first().update(status="removed", current_source_file="gone.ts", current_source_line="", current_english="", current_japanese="")
        self.assertEqual(self.result()["errors"], [])

    def test_git_dependency_needs_current_locked_revision_evidence(self):
        self.first().update(
            current_source_file="packages/cli/node_modules/pi-multiloop/extensions/pi-multiloop/index.ts",
            source_revision="old-installed-copy",
        )
        self.assertTrue(any("must identify locked" in error for error in self.result()["errors"]))
        self.first()["status"] = "needs_context"
        self.assertEqual(self.result()["errors"], [])

    def test_missing_evidence_or_action_is_rejected(self):
        self.first().update(evidence="", next_action="")
        errors = self.result()["errors"]
        self.assertTrue(any("missing evidence" in error for error in errors))
        self.assertTrue(any("missing next_action" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
