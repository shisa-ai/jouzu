# Agents and runs

Open `/workflow`, or choose **Workflow** in the Palette. The **Agents** view lists definitions. Select one with `↑`/`↓` and press `Enter` to edit its model, instructions, and execution settings. Use the **View** row's `←`/`→` choice to switch to **Runs**.

Jouzu supplies editable `orchestrator`, `coder`, and `reviewer` presets. Their model selectors are `gpt-6-astra`, `glm-5.3-flash`, and `gpt-6-astra`. Choose models available through your configured providers before using these definitions. A bare model ID must match exactly one provider; the model picker saves an exact `provider/model` selection. Jouzu reports missing or ambiguous models without substituting another model.

## Definitions

**Save** writes the definition. **Cancel** or `Esc` discards the form. Model selection and instruction editing change the draft; save the form to retain them. In the multiline editor, `Enter` inserts a newline and `Esc` returns the text to the form. Cancelling the enclosing form discards that text too. Applying, launching, or deleting a definition requires saving or cancelling pending edits first.

**Use in main session** changes the idle main agent's model and thinking setting, and adds the role's instructions to subsequent turns. The main session keeps its conversation and tools. **Launch agent** opens an assignment form and starts a separate child session after you submit it. Child tools and execution limits apply to child runs. Editing a definition affects future launches; existing runs retain their saved definition.

**Add agent** and **Duplicate as new agent** support arbitrary role names. Behavior follows the definition's fields, including **Review only**, rather than its name. Review-only definitions run as children. Their repository tools are `read`, `grep`, `find`, and `ls`; they also receive the shared child capabilities described below.

Definitions are stored in `agents.json` in Jouzu's configuration directory (`jz doctor` shows the directories). With `JOUZU_HOME`, this is `$JOUZU_HOME/agents.json`. The file contains `schemaVersion: 1`, `maxConcurrent`, and a `roles` array. Each role has:

| Field | Meaning |
| --- | --- |
| `id`, `description` | Unique lowercase ID and a display description. |
| `model`, `thinking` | Exact model selector and Pi thinking setting. |
| `instructions` | Inline instructions, up to 32,000 characters. |
| `placement` | `main`, `child`, or `both`. |
| `judging` | Read-only repository tools and fresh conversation context by default; requires `child`. |
| `tools` | Built-in child tools: `read`, `grep`, `find`, `ls`, `write`, `edit`, `bash`, `powershell`. Shared child capabilities are added automatically. |
| `timeoutSeconds`, `maxTurns` | Child runtime limit (10–7200 seconds) and turn limit (1–500). |

`maxConcurrent` defaults to 2 and accepts 1–8. Changes to this file's concurrency setting take effect when a parent session attaches. The queue holds up to 32 waiting tasks. Roles with write, edit, or shell tools run one at a time per workspace; within a parent session, readers also wait for its writer. Separate Jouzu parent sessions serialize child writers through a workspace lock. Main-session edits and external programs do not participate in that lock. The lock covers the selected workspace, not every path a child can access. Assign separate worktrees for independent edits and avoid overlapping assignments.

## Delegation from the main agent

The main model receives the `subagent` tool:

```json
{"op":"roles"}
{"op":"launch","role":"coder","workspace":"../feature-worktree","task":"Implement the assigned parser change. Run its focused tests and report files, results, and remaining work."}
{"op":"list"}
{"op":"read","id":"<run-id>","offset":0}
{"op":"trace","id":"<run-id>","kind":"tools"}
{"op":"trace","id":"<run-id>","query":"test failure"}
{"op":"steer","id":"<run-id>","task":"Keep the existing public API."}
{"op":"stop","id":"<run-id>"}
{"op":"resume","id":"<run-id>","task":"Address the reported failure and rerun the check."}
```

Launch returns immediately with a run ID. Completion summaries arrive as attributed follow-ups; nearby completions are combined. Pending messages retain priority. Stopping a child does not start a new main-agent turn. `list` returns up to 20 runs; pass its `nextOffset` to continue. `read` pages event output and returns a UTF-8-safe byte `nextOffset`. Run summaries include the resolved workspace, current tool, context-sharing policy, and saved child session path. Once the child is ready, they also list its active tools and skills. Use `list` for intermediate status; completion is notified automatically, but each intermediate status change does not start a parent turn. A steering receipt records acceptance into the controller and then whether the child queued or rejected the message; queuing does not prove model consumption.

**Runs** provides output reading, messaging, Stop, and Resume. Stop requests tool cancellation, then forces process cleanup after a grace period. Files already written remain. Resume starts another run using the original role revision, exact provider/model, workspace, and saved child conversation. Use a new launch for a fresh context or changed definition.

## Workspace and context

`workspace` on `launch` accepts an absolute path, a path relative to the parent working directory, or a home-relative path such as `~/project`. The directory must exist and be accessible before authentication or model startup. It becomes the child's working directory and the basis for repository instruction loading and writer coordination. It is not a filesystem sandbox: file tools can read reference material outside it, and enabled edit or shell tools retain normal filesystem access. A restart is not needed to assign another folder. Resume keeps the original workspace; workspace and context options are rejected on resume.

The launch `context` option controls inherited conversation material:

| Value | Behavior |
| --- | --- |
| `fresh` (default) | Start with the assignment, role, skills, and repository guidance, without injecting parent conversation. |
| `fork` | Include parent conversation as a reference block, with recent entries first when the size limit requires selection. This is not a clone of pending tool calls or extension state. |
| `splice` | Include selected parent message or compaction entries. Supply 1–100 `entryIds` from the active parent branch. |

Use `{"op":"trace"}` without a run ID to inspect the parent's saved transcript and find entry IDs. Reference injection is limited to 64,000 characters and 8,000 characters per entry, with truncation reported. Thinking blocks, image data, and extension state are not inherited. Tool-call arguments are historical evidence, not pending child actions.

`parentContext` enables the child's read-only `parent_context` tool. It defaults to `true` for working roles and `false` for review-only roles. The tool searches a snapshot of the active parent branch captured at launch, not later coordinator messages. This lets a fresh child look up project requirements or decisions without adding the entire transcript to every request. Set `parentContext: false` for a conversation-independent assignment. Snapshots are limited to 32 MB; if a snapshot is too large, use fresh context with lookup disabled and provide a focused summary in the assignment. Resume retains the original snapshot; send new information with `steer` or the resume assignment.

```json
{"op":"launch","role":"coder","context":"fork","task":"Implement the agreed interface and verify it."}
{"op":"launch","role":"coder","context":"splice","entryIds":["<requirement-entry-id>"],"task":"Implement this requirement."}
{"op":"launch","role":"reviewer","context":"fresh","parentContext":false,"task":"Review the candidate against the supplied requirements and check evidence."}
```

Workspace and context selection are available through the `subagent` tool. The Workflow launch form uses the parent's working directory and the default context policy.

## Trace queries

`trace` reads the saved Pi transcript without rewriting it. Supply `id` for a child or omit it for the parent. `kind` filters `all`, `messages`, `tools`, `errors`, or `compaction`; `query` performs case-insensitive literal text search, and `entryId` selects one entry. Tool records include arguments and results linked by tool-call ID. Thinking blocks and image data are omitted.

`limit` accepts 1–100 records and defaults to 20. `offset` is a JSONL byte cursor; use the returned `nextOffset`, not a record count. Each query scans at most 8 MB and bounds its returned records to roughly 48 KB. Large records have a marked preview; read the saved session file for complete content. An incomplete final line is reported with a retry cursor, and malformed complete lines produce an error. `read` remains the byte-paged event-preview reader.

## Review evidence

A review-only child receives repository instructions, bundled skills, recall, web tools, and a child-local task list. Its default conversation is fresh and parent lookup is disabled. A launch can explicitly share selected or inherited context; the run summary records this choice. Include requirements, scope, and check evidence in the assignment. The reviewer cannot execute repository tests with its read-only repository tool set.

Jouzu records a Git working-tree identity at launch and compares it at completion. This covers HEAD, tracked changes, and untracked files within bounded snapshot limits. Changes produce a **changed** review marker. Non-root workspaces, submodules, unavailable Git data, and snapshots exceeding limits produce **unverified** coverage. Ignored files are outside this identity. An unchanged identity establishes only that the captured inputs match.

A completed run means the child returned a final response and exited successfully. It does not mean the assignment passed acceptance checks or the review approved release. Findings and test claims remain evidence for the main agent to verify. Review output requests severity, location, failure conditions, evidence, and incomplete coverage; Jouzu does not parse it into an approval verdict.

## Execution and retained history

Children run through Jouzu's pinned Pi SDK in separate Node processes. They use the selected model and resolved API key/token or headers through a private IPC channel. Authentication requiring extension code or additional credential environment variables is rejected before launch. Long-lived runs do not refresh authentication tokens. Model-reported usage is accumulated per run; missing cost information stays unknown.

All children load repository `AGENTS.md` guidance and skills from Jouzu's selected bundled profile, the user's agent directory, and standard project skill locations. They receive these shared tools in addition to their role's built-in tools:

- `vcc_recall` and `compact_context`, with automatic compaction and history scoped to the child's own session.
- `web_fetch`, `batch_web_fetch`, `tff-fetch_url`, and `tff-search_web`, using the bundled web implementations and their normal network protections. Browser support is installed lazily when used; an unavailable optional browser adapter does not prevent other work.
- `TaskCreate`, `TaskCreateMany`, `TaskList`, `TaskGet`, and `TaskUpdate`, backed by a child-local task file that survives resume. Project task storage and automatic task execution settings do not redirect this list or start extra work.
- `parent_context` when launch enables parent lookup.

Children do not load ambient extension code or the multiloop skill. Delegation, scheduling, background-task, and autonomous-loop tools are not exposed. The role's built-in tools and the shared child tools are enforced at execution time. This is an execution policy, not an OS sandbox: shell tools run with the user's permissions. Use children for trusted local work and keep changes within the assignment.

Run records, events, parent-context snapshots, child task files, and Pi child sessions remain under Jouzu's state directory in `subagents/`. They include parent/session links, definition digests, model identity, control receipts, usage, and completion state. Credentials passed to the worker are excluded from these records, though task and tool output can contain sensitive content. There is no automatic retention deletion. Parent shutdown stops owned children; reopening a parent marks unverifiable active records interrupted and leaves them for inspection and explicit resume.
