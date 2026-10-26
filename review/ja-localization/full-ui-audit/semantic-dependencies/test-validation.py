#!/usr/bin/env python3
"""Exercise ledger guards only; never import the product or a dependency runtime."""

import csv
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("dependency_ledger_validator", HERE / "validate.py")
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


class ContinuationValidationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix=".validation-fixture-", dir=HERE)
        self.directory = Path(self.temporary.name)
        for path in HERE.iterdir():
            if path.is_file() and path.suffix in {".csv", ".json"}:
                shutil.copyfile(path, self.directory / path.name)

    def tearDown(self):
        self.temporary.cleanup()

    def change_csv(self, name, index, field, value):
        path = self.directory / name
        with path.open(encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            header, rows = reader.fieldnames, list(reader)
        rows[index][field] = value
        with path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=header, lineterminator="\n")
            writer.writeheader()
            writer.writerows(rows)

    def errors(self):
        return validator.validate(self.directory)["errors"]

    def test_current_artifacts_pass(self):
        self.assertEqual([], self.errors())

    def test_original_residual_rewording_is_rejected(self):
        self.change_csv("residuals.csv", 0, "boundary", "incorrectly closed")
        self.assertTrue(any("original rows changed/reordered: residuals.csv" in error for error in self.errors()))

    def test_original_surface_rewording_is_rejected(self):
        self.change_csv("surfaces.csv", 0, "source_finding", "changed snapshot meaning")
        self.assertTrue(any("original rows changed/reordered: surfaces.csv" in error for error in self.errors()))

    def test_runtime_false_closure_is_rejected(self):
        self.change_csv("residual-resolutions.csv", 11, "status", "closed-at-selected-source")
        self.assertTrue(any("incorrect source/runtime resolution status: original-12" in error for error in self.errors()))

    def test_missing_continuation_evidence_is_rejected(self):
        self.change_csv("residual-resolutions.csv", 0, "surface_ids", "semantic-dependencies.continuation.missing")
        self.assertTrue(any("missing continuation evidence" in error for error in self.errors()))

    def test_stale_continuation_anchor_is_rejected(self):
        with (self.directory / "source-anchors.csv").open(encoding="utf-8", newline="") as handle:
            rows = list(csv.DictReader(handle))
        index = next(index for index, row in enumerate(rows) if ".continuation." in row["surface_id"])
        self.change_csv("source-anchors.csv", index, "matched_line", "not the inspected source")
        self.assertTrue(any("stale source line" in error for error in self.errors()))

    def test_historical_check_result_rewrite_is_rejected(self):
        path = self.directory / "check-results.json"
        result = json.loads(path.read_text(encoding="utf-8"))
        result["product_runtime_tests_run"] = True
        path.write_text(json.dumps(result) + "\n", encoding="utf-8")
        self.assertIn("historical check-results.json changed", self.errors())


if __name__ == "__main__":
    unittest.main()
