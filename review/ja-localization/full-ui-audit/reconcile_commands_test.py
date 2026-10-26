from pathlib import Path
import tempfile
import unittest

from reconcile_commands import COMMAND_STATES, reconcile, registrations


class CommandReconciliationTests(unittest.TestCase):
    def families(self):
        return {identifier for values in COMMAND_STATES.values() for identifier in values}

    def known(self):
        return [{"command": name} for name in COMMAND_STATES]

    def test_new_registration_cannot_be_silently_counted_as_covered(self):
        self.assertIn("unmapped literal owned command: new-command", reconcile(self.known() + [{"command": "new-command"}], self.families()))

    def test_omitted_status_family_is_detected_despite_presentation_file_membership(self):
        families = self.families() - {"status.unavailable-context"}
        self.assertIn("/status: missing state family status.unavailable-context", reconcile(self.known(), families))

    def test_missing_registered_route_is_detected(self):
        known = [row for row in self.known() if row["command"] != "status"]
        self.assertIn("mapped command registration missing: status", reconcile(known, self.families()))

    def test_source_discovery_uses_api_calls_not_catalog_keys(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "packages/cli/src/menu.ts"
            source.parent.mkdir(parents=True)
            source.write_text('pi.registerCommand("fresh", {});\nconst key = "translated-but-not-registered";\n', encoding="utf-8")
            self.assertEqual(registrations(root), [{"command": "fresh", "source_file": "packages/cli/src/menu.ts", "line": 1}])


if __name__ == "__main__":
    unittest.main()
