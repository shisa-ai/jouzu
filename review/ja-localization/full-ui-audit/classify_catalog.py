#!/usr/bin/env python3
"""Classify exact-source catalog equality without treating it as UI coverage."""
import csv
from pathlib import Path

DIRECTORY = Path(__file__).resolve().parent
HEADER = ["fluent_id", "disposition", "evidence", "remaining_check"]


def classify(identifier, text):
    if "-flow-userInput-receipt-" in identifier:
        return "confirmed-English-catalog-prose", "packages/cli/locales/ja/user-input.ftl keeps English receipt sentences; projectUserInputReceipt in packages/cli/src/flow-control/user-input-receipts.ts resolves reason.text separately from stable reason.code.", "Trace final display consumers before counting a terminal leak; see terminal-owned/surfaces.csv receipt families and packages/cli/src/flow-control/user-input-adapters.ts getReceipt."
    if "-flow-userInput-grants-" in identifier:
        return "reachability-needs-context", "Grant validation reason is English; prior reconciliation found the production adapter discards decision.reason.", "Trace all callers before counting as visible English; test presence alone is not reachability."
    if identifier in {"jouzu-cli-help-overlay-title", "jouzu-cli-workflow-title", "jouzu-cli-settings-view-about"}:
        return "retained-product-noun", "docs/localization-glossary.md explicitly preserves Jouzu Help, Workflow and About as Palette product nouns.", "Check layout/context without translating the protected noun."
    if "-language-self-" in identifier:
        return "retained-language-self-name", "Language choices use self-names independent of the currently selected interface language.", "Check offered/unsupported choice state and surrounding localized explanation."
    if identifier in {"jouzu-cli-doctor-field-node", "jouzu-cli-doctor-field-git", "jouzu-cli-doctor-field-bash", "jouzu-cli-doctor-field-npm", "jouzu-cli-settings-label-account"}:
        return "retained-product-or-tool-name", "Tool/service names are protected identifiers under docs/localization-glossary.md.", "Check surrounding diagnostic or account text separately."
    if text in {
        "HTTP { $status }", "{ $model } — { $gap }", "{ $plan }",
        "{ $from } → { $to }", "· { $view }{ $stage }", "jouzu { $version }",
        "pi { $version }", "Pi { $version }", "Jouzu - { $workspace }",
        "Jouzu - { $session } - { $workspace }", "{ $provider }/{ $model }",
        "({ $current }/{ $total })", "{ $label }…",
    }:
        return "retained-placeholder-or-technical-template", "Explicitly reviewed pattern has only protected values, product/version identifiers, punctuation, or numeric/progress formatting; equality is not prose-translation evidence.", "Verify interpolated caller values and selected-catalog wrappers separately."
    return "unresolved-catalog-equality", "No contextual classification exists for this exact candidate; equality alone cannot approve preservation or establish visible English.", "Inspect the pattern, caller values, ownership and display consumer before assigning a semantic disposition."


def main():
    with (DIRECTORY / "catalog-identical.csv").open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    with (DIRECTORY / "catalog-classifications.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(HEADER)
        for row in rows:
            writer.writerow([row["fluent_id"], *classify(row["fluent_id"], row["english_source"])])
    print(f"Classified {len(rows)} identical-source catalog candidates.")


if __name__ == "__main__":
    main()
