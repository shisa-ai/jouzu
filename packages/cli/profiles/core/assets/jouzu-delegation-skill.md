---
name: jouzu-delegation
description: Write and review subagent assignments, steering messages, and resume handoffs. Use before delegating work or correcting a child run to define one objective, supply verified context, set acceptance checks and a stopping point, and diagnose failures without changing the user's model selection.
license: Apache-2.0
---

# Delegate bounded work

Use this guide when the subagent tool is available and the user permits delegation. Read it once per session and reuse it for launch, steering, and resume messages. Work directly when delegation adds no useful parallelism or independent review.

## Choose the assignment

Call `subagent` with `op: "roles"` to check live availability, configured models, tools, and limits. Use a role that permits child placement. Only the user changes role models or enables disabled subagents. Do not change agent configuration to work around those choices.

Give the child one independently checkable outcome. Split a prerequisite refactor from the feature that depends on it. Do not bundle roadmap stages, unrelated fixes, or an open-ended instruction to keep improving. If assignments depend on each other, finish and verify the prerequisite before assigning the next stage. Avoid concurrent edits to the same files.

A fresh child does not receive your conversation. Supply the facts it needs; do not tell it to recover unstated decisions from "the discussion above." Coder children load repository instructions; review-only children must be told which instructions to read. Children load bundled extensions and discovered skills; role definitions select their built-in tools. State which operations the assignment authorizes. The parent owns scheduling and additional agent launches. Children should report those requests to the parent rather than create schedules or launch agents through tools or shell commands.

## Write the handoff

Use these headings for a substantive assignment. A short follow-up may use plain sentences if the same information is unambiguous.

- **Objective:** One concrete result and why it is needed.
- **Context:** Working directory, relevant files, verified behavior, and exact errors. Separate observations from hypotheses. Identify the candidate commit or working-tree state for a review.
- **Constraints:** Allowed edits, behavior that must remain unchanged, and work explicitly out of scope. Include repository commit or approval requirements that affect this assignment.
- **Acceptance:** Named checks and expected results. Verify commands before prescribing them; if the right command is unknown, ask the child to identify it. Distinguish static inspection from tests or live execution.
- **Stop and report:** State where to stop. Request changed files, checks and outcomes, remaining blockers, and commit identity if committing is authorized. Report uncertainty rather than inventing success.

Write complete sentences with normal spaces. Keep exact paths, commands, identifiers, and error text intact. Explain specialized abbreviations the child needs. Do not compress instructions into joined words, unexplained labels, or fragments. Brevity must not remove causality, negation, or the stopping condition.

Before sending, read the assignment as someone who has not seen the parent conversation. Check that it says what to do, what not to do, how to verify it, and when to return. Include only context needed for that decision.

## Example assignment

The paths and command below are illustrative; replace them with verified repository details.

```text
Objective: Extract response decoding into a reusable helper without changing behavior.
Context: Work in the selected repository. The decoding code is in src/client.ts;
its tests are in test/client.test.ts. Read AGENTS.md before editing.
Constraints: Preserve the public API and error messages. Do not add streaming support
or modify retry behavior. Leave unrelated work untouched.
Acceptance: Run npm run test:client. Existing tests must pass; add coverage for any
behavior that is not already tested. Report any check you could not run.
Stop and report: Stop after the helper refactor and its tests. Report changed files,
check results, and remaining risks. Follow repository commit requirements.
```

For a review, replace the implementation objective with inspection of a named candidate. Supply requirements and check evidence without the implementer's reasoning. Request findings with path and line anchors, failure conditions, and coverage limits. Do not ask a read-only child to run tests or modify files.

## Correct a run

Read the child's output before diagnosing it. Distinguish a provider or authentication failure, a tool or environment failure, unclear instructions, and an implementation defect. An HTTP 503 establishes provider unavailability for that request; it does not establish task cancellation or inability to perform the assignment.

Send a specific correction rather than a larger restatement of the entire plan. State what remains authorized, what changed, and the next check. For example:

```text
The previous run stopped because the provider returned HTTP 503. The task is still
active. Inspect the saved changes before continuing the helper refactor. Do not
repeat completed edits. Run the focused tests, report the result, and stop before
adding streaming support. If the provider remains unavailable, report the blocker.
```

Use steering for a running child and resume for a terminal run whose saved conversation remains relevant. Resume keeps the saved model and workspace. Start a fresh child only when a separate context or assignment is needed, using the user's configured role. Do not substitute another model to work around errors.

Verify the returned changes and evidence before accepting the result or assigning dependent work. A completed child run is not proof that its acceptance checks passed. These instructions improve handoff clarity; they do not mechanically enforce scope or guarantee model performance.
