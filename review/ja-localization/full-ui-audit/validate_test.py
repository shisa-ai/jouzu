import csv
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import validate


class AuditValidationTests(unittest.TestCase):
    def fixture(self, root):
        candidate = {"files": [{"source_file": "menu.ts", "sha256": "candidate-hash"}]}
        (root / "menu.ts").write_text("export const menu = {};", encoding="utf-8")
        (root / "source-census.json").write_text(json.dumps(candidate), encoding="utf-8")
        return candidate

    def test_historical_or_empty_rows_do_not_establish_current_source_coverage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = self.fixture(root)
            with patch.object(validate, "census", return_value=candidate):
                result = validate.validate(root, root)
            self.assertEqual(result["undispositioned_sources"], ["menu.ts"])
            self.assertEqual(result["runtime_signoff"], "not-established-by-this-validator")

    def test_dispositions_need_evidence_and_never_attest_runtime_signoff(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = self.fixture(root)
            partition = root / "partition"
            partition.mkdir()
            with (partition / "files.csv").open("w", encoding="utf-8", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(validate.FILE_HEADER)
                writer.writerow(["menu.ts", "ui-producer", "entry-point inspection"])
            with patch.object(validate, "census", return_value=candidate):
                result = validate.validate(root, root)
            self.assertEqual(result["undispositioned_sources"], [])
            self.assertEqual(result["errors"], [])
            self.assertEqual(result["runtime_signoff"], "not-established-by-this-validator")
            self.assertEqual(result["semantic_review_signoff"], "not-established-by-this-validator")
            self.assertEqual(result["source_disposition_counts"], {"ui-producer": 1})

    def test_pending_dispositions_do_not_satisfy_source_coverage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = self.fixture(root)
            partition = root / "partition"
            partition.mkdir()
            with (partition / "files.csv").open("w", encoding="utf-8", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(validate.FILE_HEADER)
                writer.writerow(["menu.ts", "delegated", "another reviewer will inspect"])
            with patch.object(validate, "census", return_value=candidate):
                result = validate.validate(root, root)
            self.assertEqual(result["undispositioned_sources"], ["menu.ts"])

    def test_duplicate_surface_identity_and_missing_source_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = self.fixture(root)
            partition = root / "partition"
            partition.mkdir()
            row = {field: "evidence" for field in validate.SURFACE_HEADER}
            row.update(surface_id="duplicate", source_file="absent.ts")
            with (partition / "surfaces.csv").open("w", encoding="utf-8", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=validate.SURFACE_HEADER)
                writer.writeheader()
                writer.writerows([row, row])
            with patch.object(validate, "census", return_value=candidate):
                result = validate.validate(root, root)
            self.assertTrue(any("invalid source file" in error for error in result["errors"]))
            self.assertTrue(any("duplicate/empty" in error for error in result["errors"]))

    def test_changed_source_bytes_make_the_saved_census_stale(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = self.fixture(root)
            candidate["files"][0]["sha256"] = "new-hash"
            with patch.object(validate, "census", return_value=candidate):
                result = validate.validate(root, root)
            self.assertTrue(any("stale" in error for error in result["errors"]))


if __name__ == "__main__":
    unittest.main()
