---
name: jouzu-clear-writing
description: Revise user-facing technical prose for clarity and brevity without changing facts. Use when drafting or editing documentation, README text, release notes, issues, prompts, CLI help, diagnostics, or a long user-facing response.
license: Apache-2.0
---

# Clear Technical Writing

Write for the intended reader. Preserve facts, requirements, identifiers, commands, paths, citations, and quoted text.

## Workflow

1. Identify the reader and the action or decision the text must support.
2. Mark content that must remain exact: code, commands, paths, API names, numbers, dates, quotations, and externally sourced claims.
3. Remove sentences that state no fact, decision, reason, instruction, or limitation.
4. Replace vague or promotional wording with measurable facts.
5. Re-read the result for unsupported claims, changed meaning, and unexplained terminology.

## Editing rules

- Start with the information the reader needs. Delete introductions that describe the document or announce that an explanation follows.
- State facts directly. Remove editorial adjectives, reassurance, dramatic framing, rhetorical questions, and imagined objections.
- Remove filler intensifiers and hedges. If uncertainty matters, name the unknown, confidence, evidence gap, or condition.
- Replace vague quantities with counts, ranges, identifiers, or `unknown`.
- Replace time-relative words such as “currently” and “recently” with a version, date, or bounded condition.
- Cite attributed claims. Delete unsupported claims presented as consensus or best practice.
- Prefer concrete verbs and nouns. Avoid marketing language and abstractions that do not describe behavior.
- Collapse repeated summaries, decorative conclusions, padded transitions, parallel triplets, and dramatic sentence fragments.
- Use headings to organize facts, not to repeat the following paragraph. Prefer noun phrases or direct imperatives.
- Use a list only when its items are distinct. Do not split one claim into multiple bullets for rhythm.
- Explain specialized terms that the intended reader may not know. Do not replace precise technical terms with vague synonyms.
- Keep code, commands, paths, URLs, identifiers, log text, and quoted source language byte-accurate unless the task explicitly changes them.
- Preserve the language requested by the user and the conventions of the target repository.

## Boundaries

Do not apply style edits to quoted material or source text. When analyzing rhetoric, label the source's wording instead of rewriting it. Do not improve cadence by adding claims, certainty, benefits, or scope that the evidence does not support.

## Final pass

Confirm that each sentence carries at least one of these: a fact, number, path, command, decision, reason, instruction, limitation, or open question. Confirm that the revision retains every material fact and does not hide uncertainty.
