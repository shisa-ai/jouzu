---
name: jouzu-clear-writing
description: Draft, revise, or audit durable user-facing technical artifacts without changing facts. Use for documentation, README text, release notes, issues, prompts, tool descriptions, CLI help, diagnostics, or other prose intended to persist or leave the current chat.
license: Apache-2.0
---

# Clear Technical Writing

Write for the intended reader and the task they need to complete. Preserve facts, requirements, uncertainty, author intent, identifiers, commands, paths, citations, and quoted text.

## Priorities

Apply these in order:

1. Follow the user's request and the target project's language, terminology, format, and style rules.
2. Preserve factual and technical meaning, including scope, conditions, modality, and uncertainty.
3. Help the reader find, understand, and act on the information.
4. Apply the structure and editing rules below.

Do not enforce a style rule when it would make the text less accurate or harder for the intended reader to use.

## Choose the mode

- **Draft:** create the minimum text that supports the reader's task.
- **Revise:** improve supplied prose while retaining its material claims, structure requirements, and voice.
- **Audit:** report concrete findings and proposed changes without rewriting unless requested.

Infer the mode from the request. Do not announce it unless the distinction affects the result.

## Ground the content

Before writing technical documentation:

1. Read the relevant implementation, tests, schemas, command help, and existing documentation.
2. Separate implemented behavior from proposals, recommendations, and unknowns.
3. Identify the reader, what they already know, and the action or decision the text must support.
4. Mark content that must remain exact: code, commands, paths, API names, UI labels, numbers, dates, quotations, and externally sourced claims.
5. Verify examples and commands in proportion to the cost of an error. State what was not verified.

Do not infer product behavior from a plan when code or runtime evidence is available.

## Select the structure

Choose the smallest structure that fits the reader's need:

- **Overview:** what the product or concept is, who it is for, and its boundaries.
- **Tutorial:** a guided learning sequence with a working outcome.
- **Procedure or how-to:** prerequisites, ordered actions, expected result, and recovery.
- **Reference:** exact syntax, fields, defaults, constraints, and examples.
- **Explanation:** why behavior exists, how parts relate, and relevant trade-offs.
- **Troubleshooting:** symptom, likely cause, checks, fix, and verification.
- **Runbook, migration, or release note:** affected scope, preparation, ordered change, validation, rollback, and remaining limitations.

Lead with the answer, outcome, recommendation, or constraint the reader needs. Put prerequisites, warnings, and conditions before the actions they govern. Keep caveats next to the relevant claim or step.

## Write actions and explanations

- Name the actor when omission would hide responsibility. Do not force English voice patterns onto another language.
- Use the target language's normal direct-address convention. In English procedures, address the reader as "you" and start steps with an imperative verb.
- Put one action in each numbered step. Split a step when actions can fail independently or require separate verification.
- Keep one main topic in each paragraph. Use numbered lists for sequences and bullets for unordered sets.
- Use tables only for genuine multi-column comparison or structured data.
- Stop editing when the text supports the task and further changes would only impose a house voice.

Do not impose fixed sentence-length, tense, vocabulary, or spelling rules across all prose. Shorten or split a sentence when its structure is hard to parse, not to satisfy an arbitrary count.

## Use stable terminology

- Use one term for one concept. Do not rotate synonyms when they could imply different objects or actions.
- Do not invent acronyms or abbreviations. For an established acronym the reader may not know, write the full term on first use and use the acronym only when repetition makes it useful.
- Explain necessary jargon at first use or link to a precise definition. Replace jargon that adds no technical precision.
- Keep necessary domain terms, product names, API names, and terms of art. Do not replace them with vague plain-language substitutes.
- Make pronoun references unambiguous. Repeat the noun when "it", "this", or "they" could refer to more than one thing.
- Prefer concrete verbs over nominalized actions: describe what acts and what changes.

## Format technical content

- Keep code, commands, paths, URLs, identifiers, log text, UI labels, and quoted source language exact unless the task changes them.
- Format literals according to the target repository's conventions.
- Introduce examples with their purpose. Use placeholders that are visibly distinct from literal values and define them once.
- Use descriptive link text that makes sense without surrounding prose. Avoid directional references such as "above" or "on the left" when a heading or label is available.
- Do not rely on color, position, icons, or images as the only carrier of meaning.
- Use explicit dates, versions, counts, or bounded conditions instead of "currently", "recently", "new", or "soon".
- Preserve the language requested by the user. Follow that language's grammar, voice, capitalization, pronoun, and heading conventions; do not transfer English style rules mechanically. Avoid idioms and culture-specific metaphors when writing for a global audience.

## Remove filler and unsupported emphasis

- Delete introductions that only announce the document or say an explanation follows.
- Remove editorial adjectives, reassurance, dramatic framing, rhetorical questions, and imagined objections.
- Remove filler intensifiers and hedge stacks. If uncertainty matters, name the unknown, confidence, evidence gap, or condition.
- Replace vague quantities with counts, ranges, identifiers, or `unknown`.
- Cite attributed claims. Delete unsupported claims presented as consensus, quality, security, performance, cost, or best practice.
- Replace marketing language and abstractions that do not describe behavior with specific facts.
- Collapse repeated summaries, decorative conclusions, padded transitions, forced parallel triplets, and dramatic sentence fragments.
- Use headings to organize information, not to repeat the following paragraph. Follow the target project's heading style; without one, use concise headings appropriate to the language.
- Use a list only when its items are distinct. Do not split one claim into multiple bullets for rhythm.

## Boundaries

Do not rewrite quoted material, legal text, source text, code, commands, identifiers, logs, or error messages as a style exercise. When analyzing rhetoric, label the source's wording instead of adopting or rewriting it. Do not add claims, certainty, benefits, causes, frequency, or scope to improve cadence.

## Final pass

Check the result silently:

1. Is the answer or required action visible early?
2. Can the reader distinguish facts, inferences, recommendations, requirements, and uncertainty?
3. Does each paragraph support one reader need?
4. Are terminology, actors, conditions, prerequisites, risks, and exceptions unambiguous?
5. Are commands, labels, identifiers, links, examples, dates, and numbers exact and usable?
6. Did the revision preserve every material claim and qualifier?
7. Can any sentence be removed without losing meaning or usability? Remove it.

For a normal draft or revision, return the resulting text without a style lecture. For an audit, list findings by location, explain the reader impact, and propose the smallest correction. If the input already supports the reader's task, leave it unchanged.
