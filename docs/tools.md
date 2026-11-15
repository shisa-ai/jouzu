# Built-in tools

The `core` and `ja` profiles load the same tools.

| Tool | Purpose |
| --- | --- |
| `schedule_prompt` | One-time and recurring prompts |
| `bg_task` | Run and monitor shell processes without blocking |
| `web_fetch`, `batch_web_fetch` | Fetch readable HTTP content. See [Web tools](web.md). |
| `tff-fetch_url`, `tff-search_web` | Browser-rendered fetch and search. See [Web tools](web.md). |
| `TaskCreate` and related task tools | Track finite work |
| `get_goal`, `update_goal` | Work toward a goal you set with `/goal` |
| `multiloop_*` | Record approved measured-improvement loops |
| `subagent` | Run child agents. See [Agents and runs](subagents.md). |
| `vcc_recall` | Search earlier session history, including compacted entries |
| `compact_context` | Request compaction after the current run settles |

Also included:

- Code previews for supported tool calls and results. Syntax colors follow Pi's light or dark theme when a session starts. To choose a fixed Shiki theme, set `CODE_PREVIEW_THEME` (for example `CODE_PREVIEW_THEME=github-light`) or pick one in `/code-preview-settings`.
- Skill suggestions when you type `$` at the start of a word.

## MCP servers

Jouzu connects to Model Context Protocol (MCP) servers to use their tools and resources. Put user-level servers in `mcp.json` inside your [agent/config directory](../README.md#state-and-isolation), or project servers in `.pi/mcp.json`.

Project configuration is read only after you trust the project. Keep credentials and personal servers in the user-level file.

For example, configure a streamable HTTP server:

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "description": "Search the team's documentation"
    }
  }
}
```

Replace the URL with your server and set `DOCS_TOKEN` in the environment.

Local servers use `command`, `args`, and optional `env` instead of `url` and `headers`. They run with your user permissions, so review their configuration before connecting.

Use `/mcp` to inspect connections, sign in, reconnect, or enable and disable servers. Run `/reload` after editing the configuration outside the session.

MCP tool results and resources pass through [TextGuard](textguard.md) by default. The default (`/textguard on`) mode annotates flagged visible content and omits structured metadata; strict mode withholds flagged results until approval.

By default, server tools are **deferred**: the assistant uses `tool_search` to find them, then calls the matched tools directly.

Set `exposure` to `direct` to declare a server's tools immediately, or `hidden` to make them unreachable. `toolExposure` overrides this per tool. Jouzu also maps saved `codemode` exposure to `deferred` without rewriting your configuration.

## Goals and loops

| Command | Effect |
| --- | --- |
| `/goal` | List running and paused goals with command hints |
| `/goal pause [lane/run-tag]` | Pause a goal |
| `/goal stop [lane/run-tag]` | Stop a goal |
| `/goal resume [lane/run-tag]` | Resume a goal |
| `/multiloop` | Show all loops |

- Without a target, pause and stop act on the attached goal, or the only matching one.
- Resume picks the only saved goal directly. With more than one goal, the agent uses the conversation and saved goals to find the one you mean.
- Resume prompts the agent immediately when idle, or queues the request while it works.
- The Session Line shows running, paused, stopped, and completed counts for goals and loops in the session.

## Compaction

[pi-vcc](https://github.com/sting8k/pi-vcc), based on [VCC](https://github.com/lllyasviel/VCC), compacts the conversation without a model call when it nears or exceeds the context window.

- Compaction shortens the active transcript. Running work continues.
- Summaries retain a recall range for indexed user requests and later corrections. The assistant is instructed to read those requests before continuing, following pagination and expanding truncated entries. This reference survives repeated compaction even when goal bullets or transcript excerpts omit details. Requests without a recall index are not assigned one; a recall reference cannot guarantee that the assistant follows the instruction.
- `vcc_recall` retrieves details from the current session, including entries removed from the active transcript. It cannot start compaction.
- `compact_context` lets the assistant request compaction explicitly. Compaction waits until the current run settles and queued messages have been handled. After successful compaction, the agent continues; a failure reports the problem without automatically continuing.

## Bundled and added packages

- Bundled tools and their dependencies ship inside the `jouzu` package. A normal launch installs nothing from npm or Git.
- Exception: the browser client installs on first use. See [Web tools](web.md#browser-runtime).
- Packages you add yourself are separate, user-managed state. Jouzu release testing does not cover them, and they run with your user permissions.
