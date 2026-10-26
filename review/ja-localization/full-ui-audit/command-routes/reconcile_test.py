"""Static reconciliation and in-memory source-mutation regressions.

These tests import only audit Python, never product/runtime JavaScript. Mutated
source and ledger rows stay in memory; no product files, homes or settings change.
"""
import copy
import json
import unittest

import reconcile as audit


class ReconciliationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.baseline = audit.reconcile()
        cls.routes, _, _, cls.mapping, cls.sources, cls.errors = cls.baseline

    def changed(self, path, transform):
        overrides = dict(self.sources.reads)
        overrides[path] = transform(self.sources.text(path))
        return audit.reconcile(audit.Sources(overrides=overrides))

    def test_selected_graph_and_artifacts_match(self):
        self.assertEqual(self.errors, [])
        for name, content in audit.artifacts(self.baseline).items():
            self.assertEqual((audit.HERE / name).read_text(encoding="utf-8"), content, name)

    def test_new_owned_literal_registration_is_unmapped(self):
        result = self.changed("packages/cli/src/fast-mode.ts", lambda s: s.replace('pi.registerCommand("fast",', 'pi.registerCommand("audit-added", { handler: async () => {} });\npi.registerCommand("fast",', 1))
        self.assertIn("unmapped discovered route: owned:/audit-added", result[-1])

    def test_new_optional_call_registration_is_unmapped(self):
        result = self.changed("packages/cli/src/model-picker.ts", lambda s: s.replace('pi.registerCommand?.("catalogs",', 'pi.registerCommand?.("audit-optional", { handler: async () => {} });\npi.registerCommand?.("catalogs",', 1))
        self.assertIn("unmapped discovered route: owned:/audit-optional", result[-1])

    def test_new_release_registration_is_unmapped(self):
        path = "packages/cli/node_modules/pi-schedule-prompt/src/index.ts"
        result = self.changed(path, lambda s: s.replace('pi.registerCommand("schedule-prompt",', 'pi.registerCommand("audit-release", { handler: async () => {} });\npi.registerCommand("schedule-prompt",', 1))
        self.assertIn("unmapped discovered route: release-extension:/audit-release", result[-1])

    def test_new_declared_and_dispatched_builtin_is_unmapped(self):
        overrides = dict(self.sources.reads)
        path = audit.PI + "core/slash-commands.js"
        overrides[path] = overrides[path].replace("export const BUILTIN_SLASH_COMMANDS = [", 'export const BUILTIN_SLASH_COMMANDS = [\n{name: "audit-builtin", description: "fixture"},', 1)
        path = audit.PI + "modes/interactive/interactive-mode.js"
        overrides[path] = overrides[path].replace('// Handle commands', 'if (text === "/audit-builtin") { return; }\n// Handle commands', 1)
        result = audit.reconcile(audit.Sources(overrides=overrides))
        self.assertIn("unmapped discovered route: builtin:/audit-builtin", result[-1])

    def test_new_hidden_dispatch_is_unmapped(self):
        path = audit.PI + "modes/interactive/interactive-mode.js"
        result = self.changed(path, lambda s: s.replace('// Handle commands', 'if (text === "/audit-hidden") { return; }\n// Handle commands', 1))
        self.assertIn("unmapped discovered route: hidden-dispatch:/audit-hidden", result[-1])

    def test_new_template_literal_alias_is_unmapped(self):
        path = "packages/cli/node_modules/@vanillagreen/pi-background-tasks/extensions/registrations.ts"
        result = self.changed(path, lambda s: s.replace('pi.registerCommand(`${BG_COMMAND}:list`,', 'pi.registerCommand(`${BG_COMMAND}:peek`, { handler: async () => {} });\npi.registerCommand(`${BG_COMMAND}:list`,', 1))
        self.assertIn("unmapped discovered route: release-extension:/bg:peek", result[-1])

    def test_nonliteral_registration_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "unresolved registration expression: runtimeCommandName"):
            self.changed("packages/cli/src/fast-mode.ts", lambda s: s.replace('pi.registerCommand("fast",', 'pi.registerCommand(runtimeCommandName,', 1))

    def test_removed_existing_state_family_is_rejected(self):
        ledger = "dependencies/surfaces.csv"
        rows = [row for row in audit.read_csv(audit.AUDIT / ledger) if row["surface_id"] != "dep-0041"]
        errors = audit.validate(self.routes, self.mapping, audit.Sources(), {ledger: rows})
        self.assertIn("builtin:/model: missing family dependencies/surfaces.csv#dep-0041", errors)

    def test_removed_new_state_family_is_rejected(self):
        ledger = "command-routes/surfaces.csv"
        rows = [row for row in audit.read_csv(audit.AUDIT / ledger) if row["surface_id"] != "command-routes.quit"]
        errors = audit.validate(self.routes, self.mapping, audit.Sources(), {ledger: rows})
        self.assertIn("builtin:/quit: missing family command-routes/surfaces.csv#command-routes.quit", errors)

    def test_description_only_mapping_is_not_nested_state_coverage(self):
        mapping = copy.deepcopy(self.mapping)
        mapping["builtin:/settings"]["state_families"] = ["dependencies/surfaces.csv#dep-0439"]
        errors = audit.validate(self.routes, mapping, audit.Sources())
        self.assertIn("builtin:/settings: description/extraction cannot establish nested states: dependencies/surfaces.csv#dep-0439", errors)

    def test_removed_manifest_selection_is_not_silently_accepted(self):
        def remove_schedule(text):
            value = json.loads(text)
            value["packages"] = [p for p in value["packages"] if p["name"] != "pi-schedule-prompt"]
            return json.dumps(value)
        result = self.changed(audit.MANIFEST, remove_schedule)
        self.assertIn("mapped route no longer selected: release-extension:/schedule-prompt", result[-1])

    def test_new_skill_name_and_dollar_alias_are_unmapped(self):
        path = "packages/cli/profiles/core/assets/jouzu-reference-skill.md"
        result = self.changed(path, lambda s: s.replace("name: jouzu-reference", "name: audit-skill", 1))
        self.assertIn("unmapped discovered route: skill:/skill:audit-skill", result[-1])
        self.assertIn("unmapped discovered route: skill-alias:$audit-skill", result[-1])

    def test_pin_version_drift_is_rejected(self):
        path = "packages/cli/node_modules/@earendil-works/pi-coding-agent/package.json"
        def change_version(text):
            value = json.loads(text)
            value["version"] = "0.0.0"
            return json.dumps(value)
        with self.assertRaisesRegex(ValueError, "selected Pi version differs from pin"):
            self.changed(path, change_version)

    def test_no_language_command_is_inferred_from_family_label(self):
        self.assertFalse(any(r["route"] == "/language" for r in self.routes))
        self.assertIn("owned:/catalogs", self.mapping)

    def test_scoped_interception_maps_guidance_not_models_list(self):
        refs = self.mapping["interception:/scoped-models"]["state_families"]
        self.assertIn("command-routes/surfaces.csv#command-routes.scoped-guidance", refs)
        self.assertNotIn("terminal-owned/surfaces.csv#models.list", refs)

    def test_builtin_continuation_anchors_are_declarations(self):
        for route_id, value in self.mapping.items():
            if route_id.startswith("builtin:"):
                self.assertTrue(value["anchors"][0]["needle"].endswith(" {"), route_id)

    def test_normalization_rule_families_exist(self):
        ledger = "command-routes/surfaces.csv"
        rows = [row for row in audit.read_csv(audit.AUDIT / ledger) if row["surface_id"] != "command-routes.entry-normalization"]
        errors = audit.validate(self.routes, self.mapping, audit.Sources(), {ledger: rows})
        self.assertTrue(any("leading-fullwidth: missing family" in e for e in errors))


if __name__ == "__main__":
    unittest.main()
