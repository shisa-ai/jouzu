# Profiles and history

Use `jz doctor` for roots; see [Configuration](configuration.md). File locations are in [Saved files](saved-files.md).

## Profiles

`core` installs shared skills/prompts without choosing provider or response language. `ja` inherits core and adds Japanese-response instructions. UI language is separate.

```bash
jz profile plan --profile core --json
jz profile apply --profile core
```

Use `ja` to select that profile. Plan is read-only; apply writes managed assets and saves selection. Launch `--jouzu-profile` or `JOUZU_PROFILE` also saves selection. An external apply does not rebuild a running prompt; verify discovery after reload/new launch.

Every launch reconciles managed assets. User edits cause conflicts (exit 3), not silent overwrites. Inspect and preserve changes before resolving. Unknown files and user `AGENTS.md` are not removed. Custom system prompts are not modified by default guidance.

Skills load from their listed locations on demand; users can invoke `/skill:jouzu-reference`. Editing a managed skill can block later reconciliation.

## History access

| Need | Tool or user command |
| --- | --- |
| This session's earlier decisions, including compacted entries | `vcc_recall` query/range/expand; this session only |
| Parent saved messages/tools/errors | `subagent` `op: "trace"`, omit run `id`; reads the saved conversation file |
| Child conversation | `subagent` `op: "trace"` with the run `id` |
| Child execution output and completion | `subagent` `op: "read"`; follow `nextOffset` |
| Parent snapshot, from inside a child | `parent_context`, if the launch enabled parent lookup; same filters and bounds as trace |
| Run IDs and saved paths | `subagent` `op: "list"`, 20 runs per call, follow `nextOffset`: `sessionFile`, `childSessionId`, `previousRunId` |
| Live session identity | User `/status` or `/session` |
| Reopen an earlier session | User `/resume` to browse or search; launch `jz --session <path or ID>` |
| Active branch in terminal history | User `/scrollback` while agent/shell work is idle |

Use only tools declared in this session. Recall does not search other sessions. Trace can include other branches; it excludes thinking/images and does not rewrite history. Filters: `kind`, literal case-insensitive `query`, exact `entryId` (each trace record carries one). Follow byte `nextOffset` with unchanged filters; calls scan at most 8 MiB, return at most 100 records (default 20), and bound the response to 46 KB.

`previousRunId` names the run a resume continued; `childSessionId` is the child conversation's session ID. Trace does not acknowledge child completion. Read all terminal output with `op: "read"`, or call `{"op":"acknowledge","batchId":"<delivered batch ID>"}` alone when no reply is needed.

`compact_context` requests compaction after the run settles; recall retrieves history but does not compact. `/scrollback` cannot recover output truncated before storage, and exported text stays in terminal history. Transcripts and events may contain secrets: inspect bounded excerpts and redact before sharing.
