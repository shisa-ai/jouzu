# Agents and runs

Open `/workflow`, or choose **Workflow** in the Palette. The **Agents** view lists definitions. Select one with `↑`/`↓` and press `Enter` to edit its model, instructions, and execution settings. Use the **View** row's `←`/`→` choice to switch to **Runs**.

Jouzu supplies editable `orchestrator`, `coder`, and `reviewer` presets. Their model selectors are `gpt-6-astra`, `glm-5.3-flash`, and `gpt-6-astra`. Choose models available through your configured providers before using these definitions. A bare model ID must match exactly one provider; the model picker saves an exact `provider/model` selection. Jouzu reports missing or ambiguous models without substituting another model. Workflow and subagent summaries show the provider or catalog's friendly model name. The picker also shows the provider and catalog source; saved selections retain exact identifiers. Expand role or run output to inspect those identifiers.

## Enable or disable subagents

The **Subagents** row controls child execution for this session. Select it and press `Enter`, `Space`, or `←`/`→` to switch **On** or **Off**. The choice survives reload and session resume; new sessions default to On. Other parent sessions are unaffected.

Command shortcuts are `/workflow on`, `/workflow off`, and `/workflow toggle`. Turning subagents off blocks launch, resume, and steering, cancels queued work, and stops running children. The Palette asks for confirmation when children are active; `/workflow off` and `/workflow toggle` apply the requested change directly. Files already written remain. Turning subagents back on does not restart stopped work.

Definitions, main-session roles, run history, output reading, Stop, and completion acknowledgements remain available while subagents are off. The main agent receives the enabled state in its system prompt and is instructed to work directly when disabled. A disabled assignment call reports the setting rather than starting a child. Only the user should re-enable subagents.

## Definitions

**Save** writes the definition. **Cancel** or `Esc` discards the form. Model selection and instruction editing change the draft; save the form to retain them. In the multiline editor, `Enter` inserts a newline and `Esc` returns the text to the form. Cancelling the enclosing form discards that text too. Applying, launching, or deleting a definition requires saving or cancelling pending edits first.

**Use in main session** changes the idle main agent's model and thinking setting, and adds the role's instructions to subsequent turns. The main session keeps its conversation and tools. **Launch agent** opens an assignment form and starts a separate child session after you submit it. Child tools and execution limits apply to child runs. Editing a definition affects future launches; existing runs retain their saved definition.

**Add agent** and **Duplicate as new agent** support arbitrary role names. Behavior follows the definition's fields, including **Review only**, rather than its name. Review-only definitions run as children and restrict built-in tools to `read`, `grep`, `find`, and `ls`. Bundled extension tools are also available; review-only is an assignment policy, not an OS security boundary.

Definitions are stored in `agents.json` in Jouzu's configuration directory (`jz doctor` shows the directories). With `JOUZU_HOME`, this is `$JOUZU_HOME/agents.json`. The file contains `schemaVersion: 1`, `maxConcurrent`, and a `roles` array. Each role has:

| Field | Meaning |
| --- | --- |
| `id`, `description` | Unique lowercase ID and a display description. |
| `model`, `thinking` | Exact model selector and Pi thinking setting. |
| `instructions` | Inline instructions, up to 32,000 characters. |
| `placement` | `main`, `child`, or `both`. |
| `judging` | Fresh review context with read-only built-in tools; requires `child`. |
| `tools` | Built-in child tool names: `read`, `grep`, `find`, `ls`, `write`, `edit`, `bash`, `powershell`. Bundled extension tools are loaded separately. |
| `timeoutSeconds`, `maxTurns` | Defaults: 7,200 seconds (2 hours) and 500 turns. Runtime accepts 10–2,147,483 seconds (about 24 days); turns accept whole numbers from 1 to 9,007,199,254,740,991. |

Saved definitions keep their configured limits. Edit and save them to use different limits; active runs and resumed follow-ups retain their original definition. The runtime ceiling avoids Node timer overflow; for example, 259,200 seconds allows a three-day run. A run stops at whichever limit it reaches first.

`maxConcurrent` defaults to 2 and accepts 1–8. Changes to this file's concurrency setting take effect when a parent session attaches. The queue holds up to 32 waiting tasks. Roles with write, edit, or shell tools run one at a time per workspace; within a parent session, readers also wait for its writer. Separate Jouzu parent sessions serialize child writers through a workspace lock. Main-session edits and external programs do not participate in that lock.

## Delegation from the main agent

The main model receives the `subagent` tool:

```json
{"op":"roles"}
{"op":"launch","role":"coder","task":"Implement the assigned parser change. Run its focused tests and report files, results, and remaining work."}
{"op":"launch","role":"reviewer","workspace":"../target-repo","task":"Review this repository and ../reference-repo. Read their instructions. Report each repository's HEAD, inspected changes, findings, and coverage separately."}
{"op":"list"}
{"op":"read","id":"<run-id>","offset":0}
{"op":"steer","id":"<run-id>","task":"Keep the existing public API."}
{"op":"stop","id":"<run-id>"}
{"op":"resume","id":"<run-id>","task":"Address the reported failure and rerun the check."}
```

Before delegating, the main agent calls `roles` to check live availability and current definitions. It returns `{ "enabled": true, "roles": [...] }`, or `enabled: false` with a reason and the configured roles. Definitions can change during a session; choose a role with `child` or `both` placement. Launch checks the current definition and enable setting again. Only you can change a role's model through Workflow. The tool rejects model overrides, and the agent is instructed not to edit agent configuration to select another model. New launches use the role's configured model; resume keeps the exact model and definition saved with that run. A role configured as `same` uses the main session's model at launch.

Launch returns immediately with a run ID. Unread terminal summaries arrive in a batch after active work and queued messages finish, including successful completion, limit exhaustion, timeout, cancellation, and crashes. Each batch includes status counts and a bounded sample; omitted results remain available through `list` and `read`. A notification reports completion, not acceptance of the work.

`list` returns up to 20 runs; pass its `nextOffset` to continue. `read` pages event output and returns a UTF-8-safe byte `nextOffset`, plus terminal status and a short outcome when the run has ended. When flow control verifies that all terminal-output pages reached the model in successful requests, that result does not cause another completion turn. Running reads, incomplete page coverage, UI reads, and results removed by a content policy do not dismiss a pending notification. If final-input receipts are unavailable, the completion notification is retained. Run summaries include the saved child session path for reading complete messages when event previews are truncated.

The terminal preview for `read` shows tool counts for that page and a short assistant message or result. Expand it for readable events and the next byte offset. Records split across pages are omitted from the preview; the agent still receives the original page content and pagination fields.

For a batch that needs no user-facing reply, the agent can call `subagent` with `op: "acknowledge"` and the delivered `batchId` as its only tool call. The visible result says **No reply needed** and ends that notification response without an extra model request. The ID must belong to a batch received in the current run. This action does not hide assistant text or discard queued user work.

Pending notification records survive reload. Delivery is confirmed from conversation history; it does not prove the agent inspected every underlying result. If notification delivery fails or its content is changed by a policy, Jouzu warns and retains those results without retrying them automatically. Later completions can still notify. Inspect retained results with `list` and `read`; reload when idle to retry.

A steering receipt records acceptance into the controller and then whether the child queued or rejected the message; queuing does not prove model consumption.

Set `workspace` on launch to choose the child's working directory and the repository used for candidate identity. Paths may be absolute, relative to the parent directory, or start with `~`. It defaults to the parent's working directory. Empty or whitespace-only `workspace` values use that default. Discovery and run-management operations ignore this launch field. Resume accepts an omitted, empty, or matching workspace; changing its directory requires a new launch. This directory does not restrict file access.

Tool results and completion messages show a themed summary of role, model, status, assignment, short run ID, workspace, and available outcome. Expand tool output for the full ID, token/cost details, and candidate identity metadata. Zero token counts are omitted; unknown cost is labelled unknown. Terminal elapsed time includes queue time. Status labels carry the same meaning with color disabled. A completed status records process completion, not acceptance.

**Runs** provides output reading, messaging, Stop, and Resume. Stop requests tool cancellation, then forces process cleanup after a grace period. Files already written remain. Resume starts another run using the original role revision, exact provider/model, workspace, and saved child conversation. Use a new launch for a fresh context or changed definition.

## Subagent dashboard

The **Subagents** pane appears above the prompt when the session has child runs. It shows active, queued, and finished counts, followed by active runs first. Run rows show status, role/model, current tool, and workspace. The pane updates on run events and limits its height to leave room for the prompt.

- `/subagents` opens **Workflow → Runs**, with output, message, Stop, and Resume controls.
- `/subagents hide` hides the pane without stopping work.
- `/subagents show` restores the pane. Visibility resets when the session starts or reloads.

The Runs detail view includes the workspace. Incoming run updates preserve the selected run. In non-interactive mode, `/subagents` reports run summaries as JSON.

## Parent context

Launch accepts `context: "fresh"` (default), `"fork"`, or `"splice"`:

- **Fresh** starts with the assignment, without injecting parent conversation.
- **Fork** adds the active parent branch as bounded reference text.
- **Splice** adds selected message or compaction entries from the active parent branch. Supply 1–100 `entryIds` found through the parent trace. IDs from other branches are rejected.

`parentContext` controls the child's read-only `parent_context` lookup tool. It defaults to true for ordinary roles and false for review-only roles. A fresh child can therefore look up parent history without having it injected into its starting conversation. For independent review, keep fresh context and parent lookup off; explicitly sharing parent history can bias the review.

```json
{"op":"launch","role":"coder","task":"Implement the agreed parser change.","context":"splice","entryIds":["<entry-id>"],"parentContext":true}
```

The snapshot captures the active parent branch before provider authentication and stays fixed through resume. It excludes thinking blocks, images, system messages, tool declarations, and extension state. Historical tool calls are reference text, not executable pending calls. Inherited text is limited to about 64,000 characters, with 8,000 per entry; lookup uses trace paging. Snapshots larger than 32 MB are rejected: turn lookup off and use fresh context or a focused splice.

Resume keeps the original snapshot and lookup policy; launch a new child to change them. Workspace and context settings appear in run details. Context sharing selects what is supplied to the child; it is not a filesystem sandbox.

## Session traces

Use `subagent` with `op: "trace"` to inspect saved conversation entries. Supply a run `id` for a child, or omit it for the parent session:

```json
{"op":"trace","id":"<run-id>","kind":"tools","limit":20}
{"op":"trace","query":"parser decision"}
{"op":"trace","entryId":"<entry-id>"}
```

`kind` accepts `all`, `messages`, `tools`, `errors`, or `compaction`. `query` is a case-insensitive literal search. Results include entry IDs, text, tool-call arguments and linked results, and compaction summaries; thinking blocks and images are excluded. The trace reads the saved file without migrating or rewriting it and can include entries from other branches of that session.

Each call scans at most 8 MiB and returns at most 100 records with a response bounded to 48 KB. Large records contain a UTF-8-safe preview. Continue with `nextOffset`, a JSONL byte cursor, using the same filters. A partial last line returns a retry cursor; malformed complete lines report an error. A single entry larger than the scan budget may require direct file inspection. Trace remains available when subagents are disabled and does not acknowledge completion notifications; use `read` or the delivered batch's acknowledgement instead.

## Assignment guidance

Core and JA include the `jouzu-delegation` skill for writing launch assignments, steering messages, and resume handoffs. The default prompt routes the parent to it when both the skill and `subagent` tool are available. You can also load it with `/skill:jouzu-delegation`.

While subagents are enabled, every parent model receives a short checklist: write complete sentences with normal spacing; provide one objective, verified context and file paths, constraints, acceptance checks, and an explicit stopping point and report. Follow-ups should state what changed and what remains authorized. The skill adds examples, review-specific requirements, and guidance for distinguishing provider, tool, instruction, and implementation failures. It does not enforce assignment quality or establish that one model performs better than another.

## Review evidence

A review-only child receives the assignment, role instructions, bundled extension tools, and discovered skills. Parent conversation is excluded by default, and project instructions are not loaded automatically. Include requirements, scope, and check evidence in the assignment. The reviewer can read repository instructions as source material. State whether running checks is authorized; the review-only setting does not prevent bundled extension tools from executing commands.

Jouzu records a Git working-tree identity at launch and compares it at completion. This covers HEAD, tracked changes, and untracked files in the selected workspace within bounded snapshot limits. It does not cover sibling repositories merely because the reviewer reads them. For multi-repository work, state each target and baseline in the assignment and require separate coverage evidence. Changes produce a **changed** review marker. Non-root workspaces, submodules, unavailable Git data, and snapshots exceeding limits produce **unverified** coverage. Ignored files are outside this identity. An unchanged identity establishes only that the captured inputs match.

A completed run means the child returned a final response and exited successfully. It does not mean the assignment passed acceptance checks or the review approved release. Findings and test claims remain evidence for the main agent to verify. Review output requests severity, location, failure conditions, evidence, and incomplete coverage; Jouzu does not parse it into an approval verdict.

## Execution and retained history

Children run through Jouzu's pinned Pi SDK in separate Node processes. They use the selected model and resolved API key/token or headers through a private IPC channel. Authentication requiring extension code or additional credential environment variables is rejected before launch. Long-lived runs do not refresh authentication tokens. Model-reported usage is accumulated per run, including successful cache-warming requests; missing cost information stays unknown. New launches and resumes copy the global warming mode, while running children retain their launch setting. See [Prompt-cache warming](cache-warming.md) for modes, costs, and limits.

Children load Jouzu's bundled extensions and active profile guidance, plus bundled, user, and workspace skills. Ordinary roles also load repository `AGENTS.md` instructions. Model guidance and TextGuard apply to child sessions. Recall searches the child's own saved conversation; `parent_context` provides the separately configured parent lookup.

Task lists, loops, and flow-control records use child-owned storage. Child startup does not reopen the project's task automation. Resume retains the child's task list. A worker joins requested task continuations, background executions, and requested compaction before reporting its final result, within the role's turn and time limits. An unfinished task list alone does not keep a child running.

The parent owns scheduling and additional agent launches. Child roles receive neither the scheduler extension nor the `subagent` launcher. Children should return scheduling and delegation requests to the parent, including when the request would otherwise use a shell command. On resume, saved child-local schedules are disabled before automation state is restored. The terminal result and Runs details report how many were cancelled; ask the parent to recreate any needed future work. Malformed, oversized, or non-regular schedule state is preserved under a `.invalid-` name and reported as a warning so resume can proceed. Unsafe state directories and filesystem failures still stop launch.

Enabled file tools can access sibling directories and other paths permitted by the operating system. Role tool selection controls built-in tools; bundled extension tools are also available, including background commands and automation. The working directory is not a filesystem sandbox, and commands run with the user's OS permissions. Workspace locks use the role's built-in tool selection and selected directory; they do not cover arbitrary extension commands or cross-directory writes. Use child roles only for trusted local work.

Run records, events, and Pi child sessions remain under Jouzu's state directory in `subagents/`. They include parent/session links, definition digests, model identity, control receipts, usage, and completion state. Credentials passed to the worker are excluded from these records, though task and tool output can contain sensitive content. There is no automatic retention deletion. Parent shutdown stops owned children; reopening a parent marks unverifiable active records interrupted, reports them to the main agent, and leaves them for inspection and explicit resume.
