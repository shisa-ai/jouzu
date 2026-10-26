import unittest

from classify_catalog import classify


class CatalogClassificationTests(unittest.TestCase):
    def test_new_unrecognized_prose_is_not_approved_as_technical(self):
        self.assertEqual(classify("new-message", "Try again later")[0], "unresolved-catalog-equality")

    def test_unknown_identifier_with_nonallowlisted_template_is_unresolved(self):
        self.assertEqual(classify("new-message", "{ $count } files failed")[0], "unresolved-catalog-equality")

    def test_only_explicitly_reviewed_templates_are_preservation_candidates(self):
        self.assertEqual(classify("known-template", "HTTP { $status }")[0], "retained-placeholder-or-technical-template")

    def test_receipt_classification_names_real_producer_and_visibility_limit(self):
        result = classify("jouzu-cli-flow-userInput-receipt-dispatchFailed", "Native dispatch failed")
        self.assertEqual(result[0], "confirmed-English-catalog-prose")
        self.assertIn("user-input-receipts.ts", result[1])
        self.assertIn("Trace final display consumers", result[2])


if __name__ == "__main__":
    unittest.main()
