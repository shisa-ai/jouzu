"""Source-only regression checks for the finite review's structural guards."""

import copy
import hashlib
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import verify


class ImportConsumerChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.traces = json.loads((verify.HERE / "traces.json").read_text(encoding="utf-8"))
        cls.expected = [trace["source_file"] for trace in cls.traces]

    def test_exact_25_scope_accepts_snapshot(self):
        verify.check_scope(self.traces, self.expected)

    def test_missing_candidate_is_rejected(self):
        with self.assertRaisesRegex(AssertionError, "scope/order"):
            verify.check_scope(self.traces[:-1], self.expected)

    def test_added_candidate_is_rejected(self):
        with self.assertRaisesRegex(AssertionError, "scope/order"):
            verify.check_scope(self.traces + [self.traces[0]], self.expected)

    def test_reordered_candidates_are_rejected(self):
        with self.assertRaisesRegex(AssertionError, "scope/order"):
            verify.check_scope(list(reversed(self.traces)), self.expected)

    def test_out_of_bounds_pointer_is_rejected(self):
        with self.assertRaisesRegex(AssertionError, "pointer range"):
            verify.check_range(self.expected[0], 1, 10**9)

    def test_absolute_pointer_is_rejected(self):
        with self.assertRaisesRegex(AssertionError, "Unsafe path"):
            verify.check_range("/outside.ts", 1, 1)

    def test_missing_helper_binding_is_rejected(self):
        trace = copy.deepcopy(self.traces[0])
        trace["imports"][0]["symbols"].pop(next(iter(trace["imports"][0]["symbols"])))
        with self.assertRaisesRegex(AssertionError, "import/use map differs"):
            verify.check_imports(trace, self.traces[0]["imports"])

    def test_unread_helper_use_is_rejected(self):
        trace = copy.deepcopy(self.traces[0])
        trace["read_ranges"] = [[1, 1]]
        with self.assertRaisesRegex(AssertionError, "Uncovered helper use"):
            verify.check_imports(trace, self.traces[0]["imports"])

    def test_stale_source_hash_is_rejected_without_writes(self):
        with patch.object(Path, "read_bytes", return_value=b"changed\n"):
            with self.assertRaisesRegex(AssertionError, "Stale source hash"):
                verify.check_snapshot("mock.ts", {"sha256": hashlib.sha256(b"original\n").hexdigest(), "lines": 1})

    def test_missing_finding_reference_is_rejected(self):
        with self.assertRaisesRegex(AssertionError, "Missing local finding"):
            verify.check_reference("import-consumers.missing", set())

    def test_complete_structural_review(self):
        self.assertEqual(verify.verify()["status"], "pass")


if __name__ == "__main__":
    unittest.main()
