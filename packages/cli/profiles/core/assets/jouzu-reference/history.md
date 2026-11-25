# Profiles and history

Use `jz doctor` for roots; see [Configuration](configuration.md).

## Profiles

`core` installs shared skills/prompts without choosing provider or response language. `ja` inherits core and adds Japanese-response instructions. UI language is separate.

```bash
jz profile plan --profile core --json
jz profile apply --profile core
```

Use `ja` to select that profile. Plan is read-only; apply writes managed assets and saves selection. Launch `--jouzu-profile` or `JOUZU_PROFILE` also saves selection. An external apply does not rebuild a running prompt; verify discovery after reload/new launch.

Every launch reconciles managed assets. User edits cause conflicts (exit 3), not silent overwrites. Inspect and preserve changes before resolving. Unknown files and user `AGENTS.md` are not removed. Custom system prompts are not modified by default guidance.

Skills load from their listed locations on demand; users can invoke `/skill:jouzu-reference`. Editing a managed skill can block later reconciliation.

## State map

Relative to the state root, `paths.stateDir` in `jz doctor --json`:

| Path | Contents |
| --- | --- |
| `profile-choice.json`, `profile-state.json` | Profile selection and managed asset records |
| `backups/` | Profile application backups |
| `model-picker.json` | Favorites, recents, defaults and thinking choices |
| `localization-session.json` | Session-keyed language overrides |
| `keybindings-state.json` | Keybinding defaults Jouzu applied |
| `pi-import.json` | Pi model and credential import decisions |
| `self-update.json` | Update checks and versions |
| `shisa-link.json`, `shisa-onboarding.json` | Shisa sign-in link (holds tokens; never display) and first-launch offer |
| `camoufox-runtime/` | Rendered-browser runtime, installed on first use |
| `sessions/` | Parent conversations, unless launched with `--session-dir` |
| `subagents/` | Child runs, one folder per parent session |
| `subagent-writers/` | Child workspace-writer locks |
| `flow/` | Parent flow-control state |

Use session/run metadata for the exact file, or a bounded listing of the reported root. Titles are not filenames. Child history has no automatic deletion. Do not rewrite runtime state or restore the whole directory to undo one setting. `*.lock`, `owner.sqlite` and `subagent-writers/*.sqlite` are locks; never delete one while a Jouzu process could hold it.

### Trace locations

| What | Location |
| --- | --- |
| Parent conversation | `sessions/<UTC timestamp>_<session-id>.jsonl` |
| A parent's child runs | `subagents/<parent-digest>/<run-id>/` |
| Run record, execution output | `run.json`, `events.jsonl` in the run folder |
| Child conversation | `<UTC timestamp>_<child-session-id>.jsonl` in the folder of the run that started it; resumed runs continue that file. Path: `sessionFile` in `run.json` |
| Parent snapshot for `parent_context` | `parent-context.jsonl` in the run folder, with `parentContext` on or `fork`/`splice` context |
| Child flow state | `flow/` beside the child conversation |
| Parent flow state | `flow/` at the state root |

Timestamps look like `2026-01-31T09-15-00-000Z`. In the agent's `bash` and `powershell` tools, `PI_SESSION_FILE` and `PI_SESSION_ID` give the current session's file and ID. `PI_CODING_AGENT_SESSION_DIR` and doctor's `paths.sessionDir` give the default session folder; `--session-dir` changes neither.

A `flow/` folder holds `<branch-digest>/` per session branch (`schema.json`, `owner.sqlite`, and journal `sessions/flow/<UTC timestamp>_flow.jsonl`, whose records name `sessionId` and `branchId`) and `session-registry-v1/<registry-digest>/` per session (its branches, with the same lock and journal layout). Nothing is written until flow control records something. Use `/flow` for status; read these files only to diagnose.

Digests are the first 32 lowercase hex characters of SHA-256 over JSON text: `"<parent-session-id>"`, `["<session-id>","<branch-id>"]`, or `["<session-id>","registry"]`. Folders written before v0.1.15 use all 64. Reopening a branch renames its flow folder, but `subagent` does not list runs in a 64-character folder.

## History access

| Need | Tool or user command |
| --- | --- |
| Current-session decisions, including compacted entries | `vcc_recall` query/range/expand |
| Parent saved messages/tools/errors | `subagent` `op: "trace"`, omit run `id` |
| Child conversation | `subagent` `op: "trace"` with returned run `id` |
| Child execution output and completion | `subagent` `op: "read"`; follow `nextOffset` |
| Parent snapshot, from inside a child | `parent_context`, same filters and bounds as trace |
| Run IDs and saved paths | `subagent` `op: "list"`: `sessionFile`, `childSessionId`, `previousRunId` |
| Live session identity | User `/status` or `/session` |
| Active branch in terminal history | User `/scrollback` while agent/shell work is idle |

Use only exposed tools. Recall is not cross-session search. Trace can include other branches; it excludes thinking/images and does not rewrite history. Filters: `kind`, literal case-insensitive `query`, exact `entryId`. Follow byte `nextOffset` with unchanged filters; calls scan at most 8 MiB, return at most 100 records (default 20), and bound the response to 46 KB. Trace does not acknowledge child completion; read all terminal output with `op: "read"`, or acknowledge the delivered `batchId`.

`compact_context` requests compaction after the run settles; recall retrieves history but does not compact. `/scrollback` cannot recover output truncated before storage, and exported text stays in terminal history. Transcripts and events may contain secrets: inspect bounded excerpts and redact before sharing.
