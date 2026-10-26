"""Guard backlog accounting without importing product modules."""
import copy
import csv
import io
import json
from pathlib import Path
import tempfile
import unittest

import build_backlog as audit


class BacklogTests(unittest.TestCase):
    def row(self, **changes):
        row = dict(row_id="r1", current_source_file="src/a.ts", current_source_line="1",
                   current_english="Ready", current_japanese="準備完了", message_id="",
                   status="remaining_gap", evidence="source context", next_action="translate")
        return {**row, **changes}

    def test_identical_source_wording_merges_but_keeps_occurrences(self):
        groups = audit.group_existing([self.row(), self.row(row_id="r2", current_source_line="2")])
        self.assertEqual(len(groups), 1)
        self.assertEqual([r["row_id"] for r in groups[0]["occurrences"]], ["r1", "r2"])

    def test_same_text_in_other_source_is_not_merged(self):
        self.assertEqual(len(audit.group_existing([self.row(), self.row(row_id="r2", current_source_file="src/b.ts")])), 2)

    def test_catalog_reuse_can_merge_across_sources(self):
        self.assertEqual(len(audit.group_existing([self.row(message_id="ready"), self.row(row_id="r2", message_id="ready", current_source_file="src/b.ts")])), 1)

    def test_different_japanese_is_not_silently_selected(self):
        self.assertEqual(len(audit.group_existing([self.row(), self.row(row_id="r2", current_japanese="待機中")])), 2)

    def test_resolved_or_context_rows_are_not_new_translation_work(self):
        self.assertEqual(audit.group_existing([self.row(status="resolved"), self.row(row_id="r2", status="needs_context")]), [])

    def test_duplicate_row_id_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            audit.index_rows([self.row(), self.row()])

    def test_missing_or_duplicate_area_cannot_pass(self):
        with self.assertRaisesRegex(ValueError, "area"):
            audit.check_area_membership([{"area": "A"}], ["A", "B"])
        with self.assertRaisesRegex(ValueError, "area"):
            audit.check_area_membership([{"area": "A"}, {"area": "A"}], ["A"])

    def test_reviewed_display_normalization_preserves_condition_and_escape(self):
        proposal = json.loads((audit.HERE / "dependencies.json").read_text(encoding="utf-8"))["proposals"]
        original = next(row for row in proposal if row["row_id"] == "dependencies-0057")
        audit.check_proposal(original, audit.ROOT, set(audit.finding_areas()))
        changed = copy.deepcopy(original)
        changed["japanese"] = changed["japanese"].replace("escapeHtml", "String")
        with self.assertRaisesRegex(ValueError, "normalization"):
            audit.check_proposal(changed, audit.ROOT, set(audit.finding_areas()))

    def test_exact_catalog_reuse_is_checked(self):
        proposal = dict(row_id="reuse", kind="reuse_existing_ja", message_id="ready", english="Ready", japanese="準備完了")
        catalogs = dict(en={"ready": "Ready"}, ja={"ready": "準備完了"})
        audit.check_catalog_reuse(proposal, catalogs)
        proposal["japanese"] = "待機中"
        with self.assertRaisesRegex(ValueError, "Catalog reuse"):
            audit.check_catalog_reuse(proposal, catalogs)

    def test_complete_saved_backlog_is_reproducible_and_preserves_all_gap_refs(self):
        outputs = audit.build()
        for name, text in outputs.items():
            self.assertEqual((audit.HERE / name).read_bytes(), text.encode("utf-8"), name)
        reader = csv.DictReader(io.StringIO(outputs["translations.csv"]))
        references = [reference for row in reader for reference in row["row_refs"].split("|")]
        expected = [row["row_id"] for row in audit.read_rows() if row["status"] == "remaining_gap"]
        for reference in expected:
            self.assertEqual(references.count(reference), 1, reference)

    def test_source_anchor_and_placeholder_guards(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "source.ts").write_text('const text = `${count} running`;\n', encoding="utf-8")
            proposal = dict(row_id="new-1", areas=["A"], source_file="source.ts", source_line=1,
                            source_anchor='const text = `${count} running`;', english="${count} running",
                            japanese="${count} 件実行中", kind="translate", message_id="",
                            placeholders=["${count}"], notes="Display count, not stored state.")
            audit.check_proposal(proposal, root, {"A"})
            changed = copy.deepcopy(proposal)
            changed["source_anchor"] = "stale"
            with self.assertRaisesRegex(ValueError, "anchor"):
                audit.check_proposal(changed, root, {"A"})
            changed = copy.deepcopy(proposal)
            changed["japanese"] = "実行中"
            with self.assertRaisesRegex(ValueError, "placeholder"):
                audit.check_proposal(changed, root, {"A"})
            changed = copy.deepcopy(proposal)
            changed["source_file"] = "../source.ts"
            with self.assertRaisesRegex(ValueError, "Unsafe"):
                audit.check_proposal(changed, root, {"A"})


if __name__ == "__main__":
    unittest.main()
