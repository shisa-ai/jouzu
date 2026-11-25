# Saved files

Prefer the tools in [History](history.md); read these files only to diagnose. Transcripts and events can contain secrets: read bounded excerpts and redact before sharing.

## Find the current session

1. In the agent's `bash` or `powershell` tool, `PI_SESSION_FILE` is the current conversation file and `PI_SESSION_ID` its ID. `PI_SESSION_FILE` is unset when the session is not saved (`--no-session`).
2. `jz doctor --json` lists `fields`; read the `value` of the entry whose `id` is `paths.stateDir` (state root) or `paths.sessionDir` (default session folder). They are not nested keys.
3. For a child run, `subagent` `op: "list"` returns its `sessionFile`.

`--session <path>` and `--session-dir` can put the conversation outside the default folder; doctor and `PI_CODING_AGENT_SESSION_DIR` still name the default. Inside a child run, `PI_CODING_AGENT_SESSION_DIR` is that child's conversation folder.

## State root

Relative to `paths.stateDir`:

| Path | Contents |
| --- | --- |
| `profile-choice.json`, `profile-state.json` | Profile selection and managed asset records |
| `profile-migration-receipt.json` | Last `jz profile-migration` apply |
| `backups/` | Copies saved before profile, localization, keybinding and migration changes |
| `model-picker.json` | Favorites, recents, defaults, thinking; an unreadable file is kept as `model-picker.corrupt-<time>.json` |
| `localization-session.json` | Session-keyed language overrides |
| `keybindings-state.json` | Keybinding defaults Jouzu applied |
| `pi-import.json` | Pi model and credential import decisions |
| `self-update.json` | Update checks and versions |
| `shisa-link.json` | Shisa sign-in link; holds tokens, never display |
| `shisa-onboarding.json` | First-launch Shisa offer |
| `camoufox-runtime/` | Browser used by rendered-web tools, installed on first use |
| `sessions/` | Parent conversations, `<UTC timestamp>_<session-id>.jsonl`; the default `paths.sessionDir` |
| `subagents/` | Child runs, one folder per parent session |
| `subagent-writers/` | Locks that keep writing children from sharing a workspace |
| `flow/` | Parent flow-control state |

Locks: `*.lock`, every `owner.sqlite`, and `subagent-writers/*.sqlite`, plus any `<name>-journal` file SQLite leaves beside one. Never delete one while Jouzu could be running; `jz doctor` checks the state-root locks. Titles are not filenames. Child history is never deleted automatically. Do not rewrite runtime state or restore the whole directory to undo one setting.

## Child runs

`subagents/<parent-digest>/` holds one parent session's runs and its lock `owner.sqlite`. Each `<run-id>/` holds:

- `run.json`: the run record, with `sessionFile`, `parentContextFile` and `previousRunId`.
- `events.jsonl`: execution output; read it with `op: "read"`.
- `parent-context.jsonl`: a parent snapshot, written at launch when parent lookup (`parentContext`, default on except for review-only roles) is on or context is `fork` or `splice`. The child gets the `parent_context` tool only when lookup is on. A resumed run keeps the original snapshot and setting.

The run that starts a child conversation also holds `<UTC timestamp>_<child-session-id>.jsonl`, the child's `flow/` and its own settings and caches. A resumed run continues that file; its folder has no conversation. `/btw` side conversations are saved as runs too, but `subagent` does not list, read or trace them.

## Flow folders

The parent's flow state is in `flow/` at the state root; a child's is in `flow/` beside its conversation. Each holds:

- `<branch-digest>/` per session branch: `schema.json`, the lock `owner.sqlite`, and the journal `sessions/flow/<UTC timestamp>_flow.jsonl`, whose records name `sessionId` and `branchId`.
- `session-registry-v1/<registry-digest>/` per session: its branch list, with `owner.sqlite` and the same journal path, no `schema.json`.

A session's folders appear when flow control first records something for it; a folder with only `owner.sqlite` recorded nothing. Use `/flow` for status.

## Folder names

Timestamps look like `2026-01-31T09-15-00-000Z`. A digest is the first 32 lowercase hex characters of SHA-256 over compact JSON text:

| Folder | JSON input |
| --- | --- |
| `subagents/<parent-digest>/` | `"<parent-session-id>"` |
| `flow/<branch-digest>/` | `["<session-id>","<branch-id>"]` |
| `flow/session-registry-v1/<registry-digest>/` | `["<session-id>","registry"]` |
| `subagent-writers/<digest>.sqlite` | `"<workspace real path>"` |

Prefer `sessionFile` from `op: "list"` to computing a digest. Before v0.1.15 the names used all 64 characters. Opening a session branch renames its 64-character flow folder when the short name is free; a folder that cannot move stays, and the branch starts with empty flow state. Child runs in a 64-character `subagents/` folder are not moved, and `subagent` cannot list, read or trace them: list `subagents/` and read their files directly.
