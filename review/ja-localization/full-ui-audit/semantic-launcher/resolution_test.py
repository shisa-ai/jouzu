import csv
from pathlib import Path
import unittest

DIRECTORY = Path(__file__).resolve().parent
ROOT = DIRECTORY.parents[3]


class LauncherResolutionTests(unittest.TestCase):
    def rows(self, name):
        with (DIRECTORY / name).open(encoding="utf-8", newline="") as handle:
            return list(csv.DictReader(handle))

    def test_all_original_candidates_have_exactly_one_resolution_and_existing_family(self):
        with (DIRECTORY.parent / "launcher-installer/surfaces.csv").open(encoding="utf-8-sig", newline="") as handle:
            expected = {row["surface_id"] for row in csv.DictReader(handle) if row["evidence_level"] == "source-candidate"}
        resolutions = self.rows("candidate-resolutions.csv")
        self.assertEqual({row["candidate_id"] for row in resolutions}, expected)
        self.assertEqual(len(resolutions), len(expected))
        families = {row["surface_id"] for row in self.rows("surfaces.csv")}
        self.assertTrue(all(row["family_id"] in families for row in resolutions))
        for row in resolutions:
            lines = (ROOT / row["source_file"]).read_text(encoding="utf-8").splitlines()
            self.assertTrue(1 <= int(row["line"]) <= len(lines))

    def test_replacement_and_nonvisible_paths_do_not_become_confirmed_ui_errors(self):
        by_id = {row["candidate_id"]: row for row in self.rows("candidate-resolutions.csv")}
        expected = {
            "native-error-logs-179-0": "dismissal-errors-not-routed-to-visible-alert",
            "native-error-main-451-0": "pre-window-startup-or-panic-not-current-UI-alert",
            "update-internal-authenticate-recipe-16-0": "replaced-before-launcher-render",
            "update-internal-activate-update-76-0": "rollback-export-no-reviewed-production-UI-caller",
            "update-internal-verify-runtime-15-0": "invariant-guard-not-normal-executed-UI-state",
        }
        for identifier, disposition in expected.items():
            self.assertEqual(by_id[identifier]["disposition"], disposition)

    def test_semantic_file_set_matches_resolved_candidate_producers(self):
        files = self.rows("files.csv")
        paths = {row["source_file"] for row in files}
        self.assertEqual(len(files), len(paths))
        self.assertEqual(paths, {row["source_file"] for row in self.rows("candidate-resolutions.csv")})
        self.assertTrue(all(row["evidence"].strip() for row in files))


if __name__ == "__main__":
    unittest.main()
