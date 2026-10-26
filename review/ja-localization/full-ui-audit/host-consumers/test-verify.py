#!/usr/bin/env python3
"""Guard the static validator with in-memory corruptions, never product fixtures."""
import copy
import unittest
from verify import read_records, validate


class AuditGuards(unittest.TestCase):
    def setUp(self):
        self.headers, self.tables, self.receipt = copy.deepcopy(read_records())

    def errors(self):
        return validate(self.headers, self.tables, self.receipt)["errors"]

    def test_snapshot(self):
        self.assertEqual(self.errors(), [])

    def test_common_schema(self):
        self.headers["surfaces.csv"].pop()
        self.assertIn("schema: surfaces.csv", self.errors())

    def test_stale_anchor(self):
        self.tables["anchors.csv"][0]["exact_text"] += " changed"
        self.assertTrue(any(e.startswith("stale anchor:") for e in self.errors()))

    def test_source_hash(self):
        self.receipt["files"][0]["sha256"] = "0" * 64
        self.assertTrue(any(e.startswith("stale source hash:") for e in self.errors()))

    def test_false_full_body(self):
        record = next(r for r in self.receipt["files"] if r["depth"] == "full-body")
        record["ranges"] = [[2, record["line_count"]]]
        self.assertTrue(any(e.startswith("false full-body depth:") for e in self.errors()))

    def test_missing_boundary(self):
        self.tables["boundaries.csv"].pop()
        self.assertIn("missing/duplicate/expanded finite boundary set", self.errors())

    def test_false_native_closure(self):
        next(r for r in self.tables["boundaries.csv"] if r["boundary_id"] == "native-layout")["status"] = "closed-selected-source"
        self.assertIn("false closure: native-layout", self.errors())

    def test_false_runtime_approval(self):
        self.receipt["runtime_signoff"] = True
        self.assertIn("unsupported signoff", self.errors())

    def test_route_must_be_anchored(self):
        self.tables["surfaces.csv"][0]["entry_point"] += "; missing.js:L1"
        self.assertTrue(any(e.startswith("unanchored route:") for e in self.errors()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
