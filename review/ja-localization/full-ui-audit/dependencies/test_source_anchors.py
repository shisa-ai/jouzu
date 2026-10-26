#!/usr/bin/env python3
"""Source-only regression checks; never imports or executes the dependency runtime."""
from pathlib import Path
import csv
import re
import unittest

from source_anchors import resolve_source_anchor


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
MODE = ROOT / "packages/cli/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js"


class SourceAnchorTests(unittest.TestCase):
    def test_method_body_wins_over_earlier_callback_call(self):
        source = "wire(() => this.handleExportCommand(text));\nclass InteractiveMode {\n    async handleExportCommand(text) {\n        return text;\n    }\n}\n"
        found = resolve_source_anchor(source, "InteractiveMode.handleExportCommand")
        self.assertEqual((found["anchor_kind"], found["line"]), ("implementation:method", 3))
        self.assertEqual((found["earlier_reference_kind"], found["earlier_reference_line"]), ("caller-reference", 1))
        self.assertEqual(found["matched_source"], "async handleExportCommand(text) {")

    def test_function_body_wins_over_import_or_call(self):
        source = "invoke(reportBug);\nexport async function reportBug(ctx) {\n    return ctx;\n}\n"
        found = resolve_source_anchor(source, "reportBug")
        self.assertEqual((found["anchor_kind"], found["line"]), ("implementation:function", 2))
        self.assertEqual(found["earlier_reference_kind"], "textual-reference")

    def test_class_and_initializer_declarations_have_distinct_labels(self):
        source = "use(Panel, renderer);\nexport class Panel {\n}\nexport const renderer = { render() {} };\n"
        self.assertEqual(resolve_source_anchor(source, "Panel")["anchor_kind"], "implementation:class")
        self.assertEqual(resolve_source_anchor(source, "renderer")["anchor_kind"], "declaration:initializer")

    def test_unverified_first_occurrence_is_only_a_textual_reference(self):
        source = "wire(() => this.missing());\n"
        found = resolve_source_anchor(source, "missing")
        self.assertEqual(found["anchor_kind"], "textual-reference")
        self.assertIn("not an implementation claim", found["anchor_limit"])

    def test_ambiguous_methods_do_not_choose_a_body(self):
        source = "class A {\n    render() {}\n}\nclass B {\n    render() {}\n}\n"
        self.assertEqual(resolve_source_anchor(source, "render")["anchor_kind"], "textual-reference")

    def test_explicit_expression_stays_a_callsite_not_enclosing_method(self):
        source = "class Panel {\n    notify() {\n        this.showStatus('ready');\n    }\n}\n"
        found = resolve_source_anchor(source, "Panel.notify", anchor="this.showStatus('ready');", line_no=3)
        self.assertEqual((found["anchor_kind"], found["line"]), ("source-expression", 3))
        self.assertEqual(found["earlier_reference_kind"], "")
        found = resolve_source_anchor(source, "Panel.notify", anchor="ready")
        self.assertEqual(found["anchor_kind"], "textual-reference")

    def test_live_affected_methods_match_declarations_not_calls(self):
        source = MODE.read_text(encoding="utf-8")
        expected = {"handleExportCommand": 5446, "handleCopyCommand": 5557, "showLoginAuthTypeSelector": 4913}
        for name, line in expected.items():
            with self.subTest(name=name):
                found = resolve_source_anchor(source, "InteractiveMode." + name)
                self.assertEqual((found["anchor_kind"], found["line"]), ("implementation:method", line))
                self.assertRegex(found["matched_source"], rf"^(?:async )?{name}\([^\n]*\) \{{$")
                self.assertEqual(found["earlier_reference_kind"], "caller-reference")
                self.assertLess(found["earlier_reference_line"], found["line"])

    def test_generated_reviewed_interactive_methods_use_body_anchors(self):
        with (HERE / "surfaces.csv").open(newline="", encoding="utf-8") as stream:
            rows = list(csv.DictReader(stream))
        with (HERE / "source-anchors.csv").open(newline="", encoding="utf-8") as stream:
            anchors = {row["surface_id"]: row for row in csv.DictReader(stream)}
        selected = [row for row in rows if row["source_symbol"].startswith("InteractiveMode.") and row["evidence_level"].startswith("reviewed-")]
        self.assertTrue(selected)
        for row in selected:
            with self.subTest(surface_id=row["surface_id"]):
                anchor = anchors[row["surface_id"]]
                name = anchor["source_symbol"].rsplit(".", 1)[-1]
                self.assertEqual(anchor["anchor_kind"], "implementation:method")
                self.assertRegex(anchor["matched_source"], rf"^(?:async )?{re.escape(name)}\([^\n]*\) \{{$")
                self.assertIn("[implementation:method]", row["source_symbol"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
