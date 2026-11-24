# Configuration

Jouzu keeps its configuration, state, and cache apart from a stock [Pi coding agent](https://pi.dev/) installation. Default locations are listed in the README's [State and isolation](../README.md#state-and-isolation) table.

Move Jouzu's configuration, state, and application cache together with `--jouzu-home <path>` or `JOUZU_HOME`:

```bash
JOUZU_HOME="$PWD/.jouzu" jz doctor
```

The Windows launcher uses `%LOCALAPPDATA%\Shisa.ai\Jouzu\data` unless `JOUZU_HOME` overrides it.

## Terminal display

The interactive terminal defaults to full-screen mode. To use the terminal's normal scrollback, set `"tuiMode": "regular"` in `settings.json` under the [agent/config directory](../README.md#state-and-isolation). Set `"tuiMode": "fullscreen"` to select full-screen mode explicitly. Jouzu preserves an existing setting.

## Transcript scrollback

Run `/scrollback` in fullscreen mode while the agent and shell commands are idle to print the active conversation branch on the terminal's normal screen. Use terminal search and selection, or tmux copy mode (`Ctrl+B`, then `[` with tmux's default bindings). Exit copy mode, then press Enter or Escape to return to Jouzu. Ctrl+C also returns.

The export does not change the display setting, and the prompt draft stays intact. `Ctrl+O` keeps its tool-expansion action.

### What the export contains

The export is a plain-text snapshot of stored conversation entries, not a screenshot or a file export. Terminal control sequences are removed, and images appear as text placeholders. Only the active branch is included. Tool output already truncated when stored cannot be recovered by this command.

Terminal and tmux history limits can discard the oldest exported lines. Exported text remains in that history after returning to Jouzu, so treat it like other terminal output containing conversation or code.

The command requires an interactive fullscreen terminal and is unavailable with `TERM=dumb`.

## Copying inside tmux

Jouzu preserves native clipboard copying and also sends copied text to tmux's paste buffer. It asks tmux to forward the text to a terminal client attached to the current pane's session. This works with tmux's default `set-clipboard external`; you do not need to set `set-clipboard on`. Jouzu does not change your tmux configuration.

If tmux forwarding fails, Jouzu tries a tmux-wrapped terminal clipboard request (OSC 52) when the pane's effective `allow-passthrough` setting permits it. With `on`, the pane must be visible; `all` also permits hidden panes.

A successful tmux buffer write or terminal request cannot confirm that the desktop clipboard changed, so the UI reports a copy request. Terminal clipboard restrictions and nested multiplexers can still prevent forwarding; the tmux paste buffer and the desktop clipboard are separate destinations.

When multiple clients are attached to the pane's session, Jouzu selects the most recently active client. Client selection and forwarding are separate tmux commands: moving a pane or switching a client to another session during a copy can change where the request arrives.

## Language

[Language, locale and prompt instructions](language.md) is the complete guide to independent UI/response/artifact settings, Core/JA profiles, custom prompts, child inheritance, precedence and apply timing.

The UI locale, the response language, and the artifact policy are stored in `localization.json` in the Jouzu configuration directory, the parent of the `agent` directory listed in the README's [State and isolation](../README.md#state-and-isolation) table:

| Platform | `localization.json` |
| --- | --- |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/jouzu/localization.json` |
| macOS | `~/Library/Application Support/Jouzu/localization.json` |
| Windows | `%APPDATA%\Jouzu\localization.json` |

```json
{
  "schemaVersion": 2,
  "localization": {
    "uiLocale": "ja",
    "responseLanguage": "auto",
    "artifactPolicy": {
      "comments": "preserve",
      "documentation": "project",
      "commits": "project",
      "reviews": "project"
    }
  }
}
```

- `uiLocale` accepts `auto`, `en`, `ja`, `zh-Hans`, or `zh-Hant`. The interface offers only English and Japanese; a Chinese locale request falls back to English. `auto` resolves from the locale environment variables and falls back to English when no offered catalog matches.
- `responseLanguage` sets the language of the agent's user-facing explanations: `auto`, `en`, `ja`, `zh-Hans`, or `zh-Hant`. `auto` adds no fixed conversational-language instruction; the separate artifact policy still applies.
- `artifactPolicy` sets the language for each artifact kind. Each field takes `preserve`, `project`, `en`, `ja`, `zh-Hans`, or `zh-Hant`. `preserve` keeps existing text; `project` follows the project's existing language.

The UI locale, response language, and artifact policy are separate settings. Changing `uiLocale` does not change `responseLanguage` or `artifactPolicy`, and no language setting selects a model, provider, or region.

Use `/language` or Settings **Language** to preview changes, then press Enter to review and Enter again to save the requested UI, response and artifact preferences. Confirmed display choices override CLI/environment inputs and refresh supported screens; reopen or restart screens that retain their opening language. Response and artifact changes apply to the current agent on its next turn. Direct file edits apply to a new session. See the [save and timing rules](language.md#save-language-preferences).

### Startup resolution

See [UI precedence](language.md#ui-locale) and [response/artifact resolution](language.md#response-language-and-artifacts). `jz doctor` reports resolved startup values and their sources; it does not inspect another running session's live overrides.

Version 1 settings remain readable. The CLI does not trust repository `.jouzu/localization.json` files as automatic artifact-policy sources; use the user configuration above.

## Importing from Pi

On the first interactive setup, Jouzu looks for Pi files in `PI_CODING_AGENT_DIR`, then `~/.pi/agent`.

| Offered for import | Not imported |
| --- | --- |
| Custom `models.json` | `settings.json`, keybindings |
| Saved provider credentials from `auth.json` | Packages, extensions, skills, prompts, themes |
| | Sessions, caches, trust decisions |

- Jouzu asks separately for each file. Both prompts default to no.
- Source files are not changed, and an existing Jouzu file is never replaced.
- Rejected: symbolic links, non-regular files, oversized files, and files whose top-level JSON value is not an object.
- Non-interactive commands never read Pi state.
- `JOUZU_NO_PI_IMPORT=1` skips the offer for one launch.

Jouzu still uses these Pi resources:

- Trusted project `.pi` resources, through Pi's project-trust rules.
- `~/.agents/skills`, Pi's shared cross-tool skills directory.

## Provider retries

Jouzu retries transient provider failures before it reports the error. The default agent-turn policy allows 50 retries with a jittered ramp: 1s, 2s, 4s, 15s, 30s, 60s, 2m, 4m, then 8m for every later attempt. Each delay is multiplied by a random factor between 0.75 and 1.25, so concurrent sessions do not retry in lockstep. The 8-minute cap is the longest wait between attempts.

A retry is scheduled only for errors that look transient: HTTP 429, 500, 502, 503, 504, 520, 524, overloaded or capacity messages, rate limits, timeouts, and network failures. Authentication, billing, plan access, and exhausted allowance failures are reported immediately. If a later attempt returns a different non-retryable error, that error is reported instead of retrying again. Press Esc while a retry is waiting to cancel it.

Compaction, branch summaries, and bug-report summaries use a shorter policy: at most 3 retries with a 60-second cap. A summary that cannot reach the provider reports the error instead of holding the session for the agent-turn budget.

Set these keys in `settings.json` under the [agent/config directory](../README.md#state-and-isolation) to change the policy:

| Key | Default | Meaning |
| --- | --- | --- |
| `retry.maxRetries` | `50` | Retries after the first request. `0` disables agent-turn retries. |
| `retry.baseDelayMs` | `1000` | Base delay in milliseconds; the ramp multipliers are 1, 2, 4, 15, 30, 60, 120, 240, and 480. |
| `retry.maxAgentDelayMs` | `480000` | Longest delay in milliseconds before jitter. |

Retries inside a single provider request are separate and off by default. Setting `retry.provider.maxRetries` enables them; they honor `Retry-After` up to `retry.provider.maxRetryDelayMs` (default 60 seconds). Leave that setting unset unless you need transport-level retries.

## Startup compile cache

Jouzu uses Node's on-disk compile cache on Linux, macOS, and Windows. It reuses compiled JavaScript on later launches; the first launch populates the cache. Node selects a `node-compile-cache` directory under the operating system's temporary directory unless `NODE_COMPILE_CACHE` specifies another location. This Node-managed cache is separate from `JOUZU_HOME` and contains compiled code, not conversation history.

Set `NODE_DISABLE_COMPILE_CACHE=1` to turn it off, including when collecting precise JavaScript test coverage. If the cache directory is unavailable, Jouzu continues without caching. Node separates cache entries by runtime version and code content; you can remove the cache when Jouzu is stopped, and later launches recreate it.

## Environment variables

| Variable | Effect |
| --- | --- |
| `JOUZU_HOME` | Root for Jouzu configuration, state, and application cache; excludes Node's compile cache |
| `NODE_COMPILE_CACHE` | Directory for Node's startup compile cache |
| `NODE_DISABLE_COMPILE_CACHE=1` | Disable Node's startup compile cache |
| `JOUZU_PROFILE` | Profile for this launch: `core` or `ja`. The selection is saved. See [Profiles](profiles.md). |
| `JOUZU_UI_LOCALE` | Startup UI locale when no preference is saved; a CLI option takes precedence in that case. See [Language](#language). |
| `SHISA_API_KEY` | Shisa API key; overrides the saved login. See [Shisa AI account](shisa.md). |
| `JOUZU_MODEL_CATALOG_URL`, `JOUZU_MODEL_CATALOG_TOKEN` | Single catalog source when `catalogs.json` does not exist. See [Model catalogs](catalogs.md). |
| `JOUZU_FLOW_CONTROL=0` | Disable flow control. See [Flow control](flow-control.md). |
| `JOUZU_CAMOUFOX_IDLE_STOP_MS` | Browser idle shutdown delay. See [Web tools](web.md). |
| `JOUZU_CAMOUFOX_LIBRARY_PATH` | NSS library directory for the browser. See [Web tools](web.md). |
| `JOUZU_NO_UPDATE=1` | Skip the update check for one launch. See [Updates](updates.md). |
| `JOUZU_UPDATE_POLICY` | `auto-restart`, `notify`, or `off` for this process |
| `JOUZU_UPDATE_INTERVAL_HOURS` | Hours between successful update checks |
| `JOUZU_NO_KEYBINDING_DEFAULTS=1` | Skip first-run keybinding defaults. See [Keybindings](keybindings.md). |
| `JOUZU_NO_PI_IMPORT=1` | Skip the Pi import offer |
| `JOUZU_NO_CLEAR=1` | Keep terminal output at startup |
| `NO_COLOR` | Turn off header color |
| `PI_CLIPBOARD_TMUX=0` | Disable Jouzu's tmux clipboard forwarding and use Pi's ordinary clipboard paths |
| `PI_CODING_AGENT_DIR` | Pi directory checked for import |
