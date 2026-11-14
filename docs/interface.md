# Session interface

The area around the prompt shows your model, conversation usage, and ongoing
work.

| Surface | Shows |
| --- | --- |
| Prompt Frame | Pi's editor with Jouzu borders and a `❯` prompt |
| Work dashboard | Running, waiting, and finished work, above the prompt |
| Session Line | Goal, loop, and agent activity on the left; provider, model, and thinking level on the right |
| Status Bar | Workspace, Git, project runtime, context, and branch token counts |

## Prompt Frame

The prompt keeps Pi's editor behavior: editing actions, history, paste,
autocomplete, cursor movement, and input method editor (IME) composition.

## Work dashboard

- Child agents, tasks, background jobs, and flow-control alerts appear here. Loops keep their own panels.
- Work is grouped into sections. Each section's divider shows its counts and the command for opening its details.
- Each row shows a state marker, kind, elapsed time, and detail.
- A finished child agent whose result the model has not read gets an attention row for up to 30 seconds, subject to available space. The unread-result count persists until the model reads the result.

### Show or hide the dashboard

In Settings / Catalogs, set **Dashboard** to compact, expanded, or hidden. The
choice is saved across sessions.

| Display | Maximum height |
| --- | --- |
| Compact | 12 lines |
| Expanded | 24 lines |
| Hidden | No dashboard |

Both visible modes also fit within one third of the terminal height and the
space above the prompt.

To hide the dashboard for this session only, use `/subagents hide`.
`/subagents show` restores the saved setting, which may itself be hidden.

Use `/bg` or `Alt+Shift+H` to open the background-job manager.
`/bg watch <task>` opens it on one job.

## Session Line

- The left side shows an animated marker while work runs, a static marker with paused, stopped, or completed counts, and a count of results the model has not read.
- Activity replaces the shortcut hint. The hint returns when no activity summary or attention indicator remains; paused and completed loop summaries can still occupy the line.
- Activity text shortens to fit, and disappears before it would overlap the model name.

## Status Bar

- Fields shorten, then drop by priority on narrow terminals.
- Provider quota and session cost are not shown.

## Startup header

- Interactive launches clear the screen and show the Jouzu header.
- `JOUZU_NO_CLEAR=1` keeps existing terminal output.
- `NO_COLOR` turns off header color.

## Text width

All surfaces measure terminal display columns, not string length. Tests cover Chinese, Japanese, and Korean (CJK) text, full-width spaces, combining marks, emoji, ANSI color, and no-color output.

## Related commands

| Command | Shows |
| --- | --- |
| `/status` | Session, workspace, model, context, usage and cost, running work, and items that need attention; see [the status command](ux.md#session-status-command) |
| `/about` | Running and installed Jouzu builds, Pi version, startup time |
| `/session` | Session details, ending with a runtime line |
| `/labels` | Automatic session naming. See [Session labels](session-labels.md). |
