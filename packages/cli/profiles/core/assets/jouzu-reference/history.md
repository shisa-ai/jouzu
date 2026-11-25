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

Relative to the resolved state root:

| Path | Contents |
| --- | --- |
| `profile-choice.json`, `profile-state.json` | Profile selection and managed asset records |
| `backups/` | Profile application backups |
| `model-picker.json` | Favorites, recents, defaults and thinking choices |
| `localization-session.json` | Session-keyed language overrides |
| `sessions/` | Default parent conversation JSONL files; launch overrides can change location |
| `subagents/` | Child records, event output and conversation files, grouped by parent identity/run ID |
| `flow/` | Parent flow state, keyed by session and branch digest |

Use session/run metadata for the exact file, or a bounded listing of the reported root. Titles are not filenames. Child history has no automatic deletion. Do not rewrite runtime state or restore the whole directory to undo one setting.

### Trace locations

Resolve the state root with `jz doctor --json`; paths below are relative to it.

| What | Location |
| --- | --- |
| Parent session | `sessions/<UTC timestamp>_<session-uuid>.jsonl` |
| Child run directory | `subagents/<parent-session-digest>/<run-id>/` |
| Child conversation | The run directory's `<UTC timestamp>_<session-uuid>.jsonl` |
| Child execution output | The run directory's `events.jsonl` |
| Child flow state | The run directory's `flow/<session-branch-digest>/` |
| Parent flow state | `flow/<session-branch-digest>/` |

`PI_SESSION_FILE` is the exact current session file; `PI_CODING_AGENT_SESSION_DIR` is the session root. Launch overrides can move the directory. A flow directory contains `schema.json`, `owner.sqlite`, and `sessions/flow/<UTC timestamp>_flow.jsonl`. Digest components are 32 lowercase hexadecimal characters; resolve them from session/run metadata instead of guessing. `run.json` identifies a child run.

## History access

| Need | Tool or user command |
| --- | --- |
| Current-session decisions, including compacted entries | `vcc_recall` query/range/expand |
| Parent saved messages/tools/errors | `subagent` `op: "trace"`, omit run `id` |
| Child conversation | `subagent` `op: "trace"` with returned run `id` |
| Child execution output and completion | `subagent` `op: "read"`; follow `nextOffset` |
| Run IDs and saved paths | `subagent` `op: "list"` and run details |
| Live session identity | User `/status` or `/session` |
| Active branch in terminal history | User `/scrollback` while agent/shell work is idle |

Use only exposed tools. Recall is not cross-session search. Trace can include other branches; it excludes thinking/images and does not rewrite history. Filters: `kind`, literal case-insensitive `query`, exact `entryId`. Follow byte `nextOffset` with unchanged filters; calls scan at most 8 MiB, return at most 100 records (default 20), and bound the response to 46 KB. Trace does not acknowledge child completion; read terminal output separately.

`compact_context` requests compaction after the run settles; recall retrieves history but does not compact. `/scrollback` cannot recover output truncated before storage, and exported text stays in terminal history. Transcripts and events may contain secrets: inspect bounded excerpts and redact before sharing.
