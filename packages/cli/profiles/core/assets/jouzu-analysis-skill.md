---
name: jouzu-analysis
description: Write, revise, or review analysis documents that turn evidence into findings or recommendations. Use for technical comparisons, benchmark reports, evaluations, incident analyses, design tradeoffs, or decision memos.
license: Apache-2.0
---

# Write effective analysis

Answer the reader's question, explain what changes the answer, and make the evidence easy to inspect. The reader should not have to reconstruct the conclusion from a scorecard or worklog.

Use `jouzu-source-check` when material source claims need verification, `jouzu-clear-writing` for structure and wording, and `jouzu-anti-slop` for a filler-removal pass. This skill covers what the evidence means and what the reader should do with it.

## Frame the question

- Identify the reader, the question they need answered, and what is already settled. Separate hard requirements from preferences. Define success in terms of the outcome the reader needs, including how it is verified.
- For a decision, compare viable alternatives and the relevant baseline (often the status quo). Explain when an option already in use is the right choice instead of rearguing whether to keep it. State which criteria matter most and why; do not hide the weighting behind a composite score.
- Lead with the answer or recommendation and the decisive reason. Put the main tradeoff next. If the evidence cannot distinguish the options, say so and identify the check that would help. Do not invent a recommendation for an analysis that only asks what happened.

## Compare outcomes before metrics

- Define what counts as complete, partial, failed, or unverified. Distinguish a plausible result, independent verification, and delivery. If review or a retry changed the outcome, say what it changed and check that the correction reached the artifact readers will rely on.
- Compare performance and cost for equivalent verified outcomes under comparable conditions. Report failures, timeouts, and exclusions separately, with counts and denominators. Label selected successful examples as such. Show variability when an average hides a difference that matters to the reader. If conditions differ, explain the consequence or withhold the ranking.
- Measure what the reader values. Throughput on a synthetic workload does not establish time to finish representative work. Keep attempt time separate from end-to-end wall time, and direct cost separate from total cost including retries or review. Label estimates, proxies, and missing accounting; never substitute them for measured values. Use only the distinctions that matter to the question.

## Turn results into findings

- For each material finding, give the observed result, its practical implication, and a link or exact locator to the evidence. Explain the success, failure, or reversal that changes the answer rather than narrating every row. State when each alternative is preferable and what it gives up, if the evidence supports a distinct use for it.
- Separate observations, inferences, and recommendations. Check units, denominators, and derived numbers against the underlying records. Show the quantities behind an apparent contradiction. A plausible mechanism or correlation does not establish a cause.
- Keep the qualification beside the claim it limits. Bound findings to the tested scope, conditions, and sample. Surface the strongest counterexample or limitation, and say what new evidence or change in priorities would alter the answer.

## Layer the document

| Layer | Include |
| --- | --- |
| Opening | Answer, decisive reason, main tradeoff or uncertainty, and enough scope and method to interpret them. If readers need a freshness marker, use one dated status line. If results are separate, put a prominent full-results link near the opening. |
| Main analysis | Findings organized by decision criterion or question, not by run order. Use focused tables for comparable outcomes and numbers; explain what drives the choice in prose. |
| Linked evidence | Full scorecards, methods, fixtures, metric definitions, calculations, sources, and review records needed to inspect or reproduce the findings. |
| Worklog | Execution chronology, retries, recovery notes, and receipts that do not change the interpretation. |

Each layer should add information. Keep details in the main analysis when they change the decision, explain the outcome, or prevent a likely misreading. A link is not a substitute for a material caveat.

## Example

**Before:** “Importer A is faster and should be the default.”

**After (hypothetical):** “Keep importer B for this nightly workload. All 10 inputs passed validation with B; 8 of 10 passed with A. A had higher throughput on the eight inputs both completed. Reconsider A if it passes the full fixture set and reduces end-to-end runtime.” In the actual report, link the validation and timing records next to the comparison.

## Final check

- Can the reader identify the answer, why it holds, and what would change it without opening an appendix?
- Do the comparisons use equivalent outcomes, and are failures and missing evidence visible?
- Can the reader trace the decisive claims to evidence that supports their exact scope, units, and denominators?
- Does each detail help the reader decide, understand an outcome, or avoid a wrong inference? Move the rest to supporting records or remove it.
