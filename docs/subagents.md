# Agents and runs

Open `/workflow`, or choose **Workflow** in the Palette. The **Agents** view lists definitions. Select one with `↑`/`↓` and press `Enter` to edit its model, instructions, and execution settings. Use the **View** row's `←`/`→` choice to switch to **Runs**.

Jouzu supplies editable `orchestrator`, `coder`, and `reviewer` presets. Their model selectors are `gpt-6-astra`, `glm-5.3-flash`, and `gpt-6-astra`. Choose models available through your configured providers before using these definitions. A bare model ID must match exactly one provider; the model picker saves an exact `provider/model` selection. Jouzu reports missing or ambiguous models without substituting another model.

## Definitions

**Save** writes the definition. **Cancel** or `Esc` discards the form. Model selection and instruction editing change the draft; save the form to retain them. In the multiline editor, `Enter` inserts a newline and `Esc` returns the text to the form. Cancelling the enclosing form discards that text too. Applying, launching, or deleting a definition requires saving or cancelling pending edits first.

**Use in main session** changes the idle main agent's model and thinking setting, and adds the role's instructions to subsequent turns. The main session keeps its conversation and tools. **Launch agent** opens an assignment form and starts a separate child session after you submit it. Child tools and execution limits apply to child runs. Editing a definition affects future launches; existing runs retain their saved definition.

**Add agent** and **Duplicate as new agent** support arbitrary role names. Behavior follows the definition's fields, including **Review only**, rather than its name. Review-only definitions run as children and allow only `read`, `grep`, `find`, and `ls`.

Definitions are stored in `agents.json` in Jouzu's configuration directory (`jz doctor` shows the directories). With `JOUZU_HOME`, this is `$JOUZU_HOME/agents.json`. The file contains `schemaVersion: 1`, `maxConcurrent`, and a `roles` array. Each role has:

| Field | Meaning |
| --- | --- |
| `id`, `description` | Unique lowercase ID and a display description. |
| `model`, `thinking` | Exact model selector and Pi thinking setting. |
| `instructions` | Inline instructions, up to 32,000 characters. |
| `placement` | `main`, `child`, or `both`. |
| `judging` | Fresh review context with read-only tools; requires `child`. |
| `tools` | Child tool names: `read`, `grep`, `find`, `ls`, `write`, `edit`, `bash`, `powershell`. |
| `timeoutSeconds`, `maxTurns` | Child runtime limit (10–7200 seconds) and turn limit (1–500). |

`maxConcurrent` defaults to 2 and accepts 1–8. Changes to this file's concurrency setting take effect when a parent session attaches. The queue holds up to 32 waiting tasks. Roles with write, edit, or shell tools run one at a time per workspace; within a parent session, readers also wait for its writer. Separate Jouzu parent sessions serialize child writers through a workspace lock. Main-session edits and external programs do not participate in that lock.

## Delegation from the main agent

The main model receives the `subagent` tool:

```json
{"op":"roles"}
{"op":"launch","role":"coder","task":"Implement the assigned parser change. Run its focused tests and report files, results, and remaining work."}
{"op":"list"}
{"op":"read","id":"<run-id>","offset":0}
{"op":"steer","id":"<run-id>","task":"Keep the existing public API."}
{"op":"stop","id":"<run-id>"}
{"op":"resume","id":"<run-id>","task":"Address the reported failure and rerun the check."}
```

Launch returns immediately with a run ID. Completion summaries arrive as attributed follow-ups; nearby completions are combined. Pending messages retain priority. Stopping a child does not start a new main-agent turn. `list` returns up to 20 runs; pass its `nextOffset` to continue. `read` pages event output and returns a UTF-8-safe byte `nextOffset`. Run summaries include the saved child session path for reading complete messages when event previews are truncated. A steering receipt records acceptance into the controller and then whether the child queued or rejected the message; queuing does not prove model consumption.

**Runs** provides output reading, messaging, Stop, and Resume. Stop requests tool cancellation, then forces process cleanup after a grace period. Files already written remain. Resume starts another run using the original role revision, exact provider/model, workspace, and saved child conversation. Use a new launch for a fresh context or changed definition.

## Review evidence

A review-only child receives the assignment, role instructions, and its own tools. It does not receive the parent's transcript, extensions, skills, or automatically loaded project instructions. Include requirements, scope, and check evidence in the assignment. The reviewer can read repository instructions as source material; it cannot execute repository tests with its read-only tool set.

Jouzu records a Git working-tree identity at launch and compares it at completion. This covers HEAD, tracked changes, and untracked files within bounded snapshot limits. Changes produce a **changed** review marker. Non-root workspaces, submodules, unavailable Git data, and snapshots exceeding limits produce **unverified** coverage. Ignored files are outside this identity. An unchanged identity establishes only that the captured inputs match.

A completed run means the child returned a final response and exited successfully. It does not mean the assignment passed acceptance checks or the review approved release. Findings and test claims remain evidence for the main agent to verify. Review output requests severity, location, failure conditions, evidence, and incomplete coverage; Jouzu does not parse it into an approval verdict.

## Execution and retained history

Children run through Jouzu's pinned Pi SDK in separate Node processes. They use the selected model and resolved API key/token or headers through a private IPC channel. Authentication requiring extension code or additional credential environment variables is rejected before launch. Long-lived runs do not refresh authentication tokens. Model-reported usage is accumulated per run; missing cost information stays unknown.

Coder children load repository `AGENTS.md` instructions. Children do not load ambient extensions or skills and cannot delegate through the `subagent` tool. File tools reject explicit paths outside the assigned workspace. Shell tools execute with the user's OS permissions and can access files or the network; this process separation is not an OS sandbox. Use child roles only for trusted local work.

Run records, events, and Pi child sessions remain under Jouzu's state directory in `subagents/`. They include parent/session links, definition digests, model identity, control receipts, usage, and completion state. Credentials passed to the worker are excluded from these records, though task and tool output can contain sensitive content. There is no automatic retention deletion. Parent shutdown stops owned children; reopening a parent marks unverifiable active records interrupted and leaves them for inspection and explicit resume.
