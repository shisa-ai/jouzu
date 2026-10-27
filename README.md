# Jouzu

Jouzu is Shisa AI's terminal coding harness, built on [Pi coding agent](https://pi.dev/) 1.4.0.

- **Goals, loops, and scheduled work.** Track tasks, work toward a goal, run measured improvement loops, and schedule prompts.
- **Background jobs.** Run shell jobs while you keep working; completions arrive as batched summaries.
- **Child agents.** Give each agent its own model, tools, instructions, and workspace.
- **Web search and fetch.** Fetch pages directly or through a browser that installs on first use.
- **Local content scanning.** TextGuard checks skills and web results before they reach the model.
- **Compaction with searchable history.** Defaults to [VCC](https://github.com/lllyasviel/VCC) for instant, deterministic compaction with agent-searchable history.
- **Language choices.** English or Japanese (preview) interface, independent reply and artifact languages, and layout support for Japanese, Chinese, Korean, and emoji widths.
- **Voice dictation.** Speak into the prompt with Shisa realtime transcription.
- **Model picker.** Search providers and models, keep favorites, and save per-project defaults. Sign into [Shisa AI's API service](https://platform.shisa.ai/) for the latest open coding models.

Jouzu is **beta** software. Expect frequent updates and changes.

## Requirements

- Node.js 22.19 or newer and npm
- Git
- Bash (Git Bash on Windows)

See [Windows prerequisites](https://github.com/shisa-ai/jouzu/blob/main/docs/windows.md).

## Install

```bash
npm install -g jouzu
jz doctor
```

`jz` is an alias for `jouzu`. Try it without installing with `npx --yes jouzu`.

A signed Windows x64 launcher that bundles its requirements is available from [GitHub Releases](https://github.com/shisa-ai/jouzu/releases).

## Quick start

```bash
jz
```

The first launch asks for interface and response languages separately and offers to connect a Shisa AI account. See [offers and eligibility](https://platform.shisa.ai/jouzu).

| Command or key | Action |
| --- | --- |
| `/login shisa` | Connect a Shisa account (`/login` for other providers) |
| `/model` or `Ctrl+L` | Choose a model |
| `Ctrl+P` | Cycle favorite models |
| `/language` | Preview and save interface, response and artifact languages |
| `/fast on`, `/fast off` | Request priority or standard processing on supported models |
| `/workflow` | Configure agents and inspect child runs |
| `/goal`, `/multiloop` | Manage goals and loops |
| `/bg` | Manage background jobs |
| `/flow` | Show why automatic work stopped and how to resume it |
| `/voice` or `Ctrl+\` | Start or stop dictation |
| `/textguard` | Review flagged content |
| `/status` | Show session, model, and context usage |
| `/bug` | Draft a bug report |
| `/scrollback` | Export the conversation to terminal scrollback for search and selection |
| `Ctrl+/` or `/hotkeys` | Help and shortcuts |

## ACP hosts

Run `jouzu acp` to let an Agent Client Protocol host drive Jouzu sessions over standard input and output. It uses your Jouzu model settings, credentials, tools, and session storage. See [ACP setup and permissions](https://github.com/shisa-ai/jouzu/blob/main/docs/acp.md).

## Profiles

`core` is the default. `ja` adds Japanese responses while leaving code, commands, and paths unchanged.

```bash
jz profile apply --profile ja
jz profile apply --profile core
```

## State and isolation

Default roots for npm installations are:

| Platform | Agent/config | State and sessions | Cache |
| --- | --- | --- | --- |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/jouzu/agent` | `${XDG_STATE_HOME:-~/.local/state}/jouzu` | `${XDG_CACHE_HOME:-~/.cache}/jouzu` |
| macOS | `~/Library/Application Support/Jouzu/agent` | `~/Library/Application Support/Jouzu/state` | `~/Library/Caches/Jouzu` |
| Windows | `%APPDATA%\Jouzu\agent` | `%LOCALAPPDATA%\Jouzu\state` | `%LOCALAPPDATA%\Jouzu\cache` |

The Windows launcher stores everything under `%LOCALAPPDATA%\Shisa.ai\Jouzu`. Override all roots with `--jouzu-home <path>` or `JOUZU_HOME`.

On first setup, Jouzu offers to copy `models.json` and provider credentials from an existing Pi installation. Both prompts default to no.

## Model catalogs

Add model catalogs in Settings / Catalogs (`/catalogs`). Shisa AI's catalog is built in and activates when you sign in. Check sources with `jouzu catalog status`.

| Platform | Catalog configuration |
| --- | --- |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/jouzu/catalogs.json` |
| macOS | `~/Library/Application Support/Jouzu/catalogs.json` |
| Windows | `%APPDATA%\Jouzu\catalogs.json` |

## Keybindings

Default keybindings, rebindable in `keybindings.json`:

| Key | Action | Behavior |
| --- | --- | --- |
| `Ctrl+Enter` | `app.message.followUp` | Queue the editor text as a follow-up while the agent is working |
| `Ctrl+Up` | `app.message.dequeue` | Restore queued messages to the editor |
| `Ctrl+F` | `jouzu.model.toggleFavorite` | Toggle the selected model's favorite status |
| `Ctrl+Shift+R` | `jouzu.model.refresh` | Refresh model catalogs and providers |

Modified keys such as `Ctrl+Enter` need terminal support. See the [key collision map](https://github.com/shisa-ai/jouzu/blob/main/docs/key-collisions.md) for terminal and tmux setup.

## Updates

Global npm installations update automatically at launch. Change this with `jz self-update policy notify` or `jz self-update policy off`.

## Development

```bash
npm run dev:setup                     # install, check, build, and smoke-test
node packages/cli/dist/cli.js         # run this checkout
npm run dev:link                      # optional: point global jz/jouzu at this checkout
```

Building also requires Go (for [textguard-go](https://github.com/shisa-ai/textguard-go)).

## Documentation

| Page | Covers |
| --- | --- |
| [Models](https://github.com/shisa-ai/jouzu/blob/main/docs/models.md) | Models view, defaults, thinking levels, context ceiling |
| [Shisa AI account](https://github.com/shisa-ai/jouzu/blob/main/docs/shisa.md) | Sign-in, sign-out, credentials |
| [Model catalogs](https://github.com/shisa-ai/jouzu/blob/main/docs/catalogs.md) | Catalog sources, refresh, publishing a catalog |
| [Flow control](https://github.com/shisa-ai/jouzu/blob/main/docs/flow-control.md) | `/flow` commands, pausing and resuming automatic work |
| [Built-in tools](https://github.com/shisa-ai/jouzu/blob/main/docs/tools.md) | Tools, MCP servers, goals and loops, compaction |
| [Web tools](https://github.com/shisa-ai/jouzu/blob/main/docs/web.md) | Fetch and browser tools, limits, browser settings |
| [Agents and runs](https://github.com/shisa-ai/jouzu/blob/main/docs/subagents.md) | Child agents and roles |
| [TextGuard](https://github.com/shisa-ai/jouzu/blob/main/docs/textguard.md) | Content scanning and approvals |
| [Voice input](https://github.com/shisa-ai/jouzu/blob/main/docs/voice.md) | Dictation setup and commands |
| [Session interface](https://github.com/shisa-ai/jouzu/blob/main/docs/interface.md) | Dashboard, Session Line, Status Bar |
| [Session labels](https://github.com/shisa-ai/jouzu/blob/main/docs/session-labels.md) | Automatic session naming |
| [Language and locale](https://github.com/shisa-ai/jouzu/blob/main/docs/language.md) | UI, responses, artifacts, profiles and child inheritance |
| [Profiles](https://github.com/shisa-ai/jouzu/blob/main/docs/profiles.md) | `core` and `ja`, bundled skills, conflicts |
| [Keybindings](https://github.com/shisa-ai/jouzu/blob/main/docs/keybindings.md) | Default keys and terminal support |
| [Configuration](https://github.com/shisa-ai/jouzu/blob/main/docs/configuration.md) | Locations, Pi import, environment variables |
| [Updates](https://github.com/shisa-ai/jouzu/blob/main/docs/updates.md) | Automatic updates and policies |
| [Diagnostics](https://github.com/shisa-ai/jouzu/blob/main/docs/diagnostics.md) | `jz doctor`, runtime info, Pi passthrough |
| [Report a bug](https://github.com/shisa-ai/jouzu/blob/main/docs/bug-reporting.md) | `/bug` and startup failures |
| [Windows](https://github.com/shisa-ai/jouzu/blob/main/docs/windows.md) | Windows prerequisites |
| [Development](https://github.com/shisa-ai/jouzu/blob/main/docs/development.md) | Building from source |

The [documentation index](https://github.com/shisa-ai/jouzu/blob/main/docs/README.md) also lists release notes and contributor docs.

## License

Apache-2.0. See [LICENSE](https://github.com/shisa-ai/jouzu/blob/main/LICENSE).
