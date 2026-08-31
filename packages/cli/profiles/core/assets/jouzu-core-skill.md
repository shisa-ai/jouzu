---
name: jouzu-core
description: Plan and execute repository work with safe inspection, small coherent edits, deterministic validation, and a concise handoff. Use for coding tasks that investigate or modify a repository.
license: Apache-2.0
---

# Jouzu Core Workflow

Use only tools and skills listed in the current session. Follow repository instructions and preserve user-owned work.

## Work directly by default

1. Inspect repository instructions, relevant files, tests, and live state before editing.
2. Separate observed behavior from assumptions, proposals, and unknowns.
3. Make the smallest coherent change that satisfies the request.
4. Use direct file and shell tools for straightforward work. Do not add task tracking merely to make the work appear more thorough.
5. Keep unrelated changes, staged files, branches, worktrees, and generated state untouched.

## Preserve session continuity

1. Jouzu's bundled pi-vcc handles automatic threshold and overflow compaction. Treat compaction as a reduction of the active transcript, not as context exhaustion or a reason to stop active work.
2. Workflow token totals and elapsed-time counters measure cumulative work. They do not report active context occupancy. Do not use them as evidence that the model is out of context.
3. If an earlier decision, command, file change, or requirement is missing, use the session-recall capability listed in the current routing table before reconstructing it.
4. Session recall searches only the current session and cannot trigger compaction. Manual compaction remains a user action. The active model context remains finite, so keep tool output bounded and retrieve older details as needed.

## Validate the result

1. Run the narrowest deterministic check that exercises the changed behavior.
2. Expand to the repository's required gate when the change affects packaging, dependencies, shared behavior, or a release boundary.
3. Read failures and fix their cause. Do not weaken checks or report success while required tests fail.
4. Distinguish local evidence from cross-platform, network, provider, or production evidence.

## Hand off verified work

Summarize changed files, checks run, and remaining limitations. State what was not tested. Never infer provider, region, privacy, retention, routing, certification, performance, or compatibility properties that were not explicitly verified.
