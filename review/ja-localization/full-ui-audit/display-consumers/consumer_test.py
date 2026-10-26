#!/usr/bin/env python3
"""Check saved source evidence; this imports no product runtime."""
import csv
import importlib.util
import json
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("display_ledger", HERE / "build-ledger.py")
ledger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ledger)


class DisplayConsumerTests(unittest.TestCase):
    def test_saved_artifacts_match_authored_source_anchors(self):
        files, surfaces, anchors, receipt = ledger.build()
        for name, expected in [("files.csv", files), ("surfaces.csv", surfaces), ("anchors.csv", anchors)]:
            with (HERE / name).open(encoding="utf-8", newline="") as handle:
                actual = list(csv.DictReader(handle))
            self.assertEqual([{key: str(value) for key, value in row.items()} for row in expected], actual)
        self.assertEqual(receipt, json.loads((HERE / "receipt.json").read_text(encoding="utf-8")))

    def test_display_claims_keep_receipt_and_runtime_limits_explicit(self):
        _, surfaces, _, receipt = ledger.build()
        self.assertFalse(receipt["runtime_signoff"])
        self.assertFalse(receipt["all_external_clients_reviewed"])
        rows = {row["surface_id"]: row for row in surfaces}
        self.assertIn("read catch discards", rows["display-consumers.read-errors"]["source_finding"])
        self.assertIn("no terminal receipt renderer", rows["display-consumers.receipt-seam"]["source_finding"])
        self.assertIn("running/open/done/failed", rows["display-consumers.dashboard-counts"]["source_finding"])


if __name__ == "__main__":
    unittest.main()
