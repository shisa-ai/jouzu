import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import census


class CensusTests(unittest.TestCase):
    def test_candidates_do_not_depend_on_language_or_catalog_signals(self):
        paths = [
            "packages/cli/src/no-strings.ts",
            "packages/cli/src/new-menu.ts",
            "apps/launcher/index.html",
            "apps/launcher/src/view.test.tsx",
            "scripts/windows-ci-paths.test.ps1",
            "packages/cli/test/fixtures/menu.mjs",
        ]
        result = subprocess.CompletedProcess([], 0, stdout="\0".join(paths).encode() + b"\0")
        with patch.object(census.subprocess, "run", return_value=result):
            self.assertEqual(census.tracked_candidates(), sorted(paths[:3]))

    def test_census_records_bytes_and_syntax_leads_without_asserting_visibility(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = "// no catalog lookup\npi.registerCommand('new', {});\n"
            (root / "menu.ts").write_text(source, encoding="utf-8")
            with patch.object(census, "tracked_candidates", return_value=["menu.ts"]), patch.object(
                census.subprocess, "check_output", return_value="a" * 40 + "\n"
            ):
                result = census.census(root)
            row = result["files"][0]
            self.assertEqual(row["sha256"], hashlib.sha256((root / "menu.ts").read_bytes()).hexdigest())
            self.assertEqual(row["signals"], [{"kind": "command-registration", "line": 2}])
            self.assertNotIn("localized", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
