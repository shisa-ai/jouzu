# Jouzu

Jouzu is an agentic AI environment built on the [Pi coding agent](https://pi.dev/), with CJK-safe text and path handling. The `jouzu` and `jz` commands run an exact reviewed Pi runtime with isolated Jouzu state, a language-neutral Core fallback, an optional JA preview, and human-readable diagnostics.

Jouzu v0.1 is an npm developer preview. It expects an existing development environment.

## Requirements

- Node.js 22.19 or newer and npm
- Git
- Bash (`bash` on Linux/macOS; Git Bash on Windows)
- A provider supported by Pi, authenticated through `/login`, provider environment variables, or explicit `models.json`

Windows users should read [Windows prerequisites](docs/windows.md). Signed installers, portable archives, and bundled prerequisites are not part of v0.1.

## Install

```bash
npm install --global jouzu@0.1.4

jouzu --version
jz doctor
```

`jz` is an exact alias for `jouzu`. To try the CLI without a global installation:

```bash
npx --yes jouzu@0.1.4 --version
```

## Quick start

Start Jouzu:

```bash
jz
```

On the first interactive launch, Jouzu asks whether to enable the optional Japanese-support profile. Only an affirmative answer selects `ja`; declining or pressing Enter selects the provider-neutral `core` profile. Jouzu saves that choice for later launches. Non-interactive first runs use `core` and do not manufacture consent.

Before choosing, you can inspect either profile without writing:

```bash
jz profile plan --profile core
jz profile plan --profile ja
```

A normal launch reconciles the selected profile. It stops before Pi if a managed target conflicts with a user-owned or modified file.

Inside Pi:

- `/login` configures provider authentication in Jouzu's isolated agent root.
- `/model` or `Ctrl+L` opens the Jouzu Palette Models view without clearing the prompt draft.
- `Ctrl+P` and its reverse binding cycle through available favorites in the current model scope.
- `/status` reports provider-neutral session, workspace, model, thinking, context, scoped-model, profile, and runtime facts.
- `Ctrl+/` or `Ctrl+?` opens Jouzu help; `/hotkeys` lists all Pi shortcuts.

The Palette shows Models and Settings as top-level sections; `Tab` and `Shift+Tab` move between them in browse mode. The Models view searches exact provider/model identity and display names. `←` and `→` change the Recent, Favorite, or All view; the header reports active results and total selectable inventory. The first launch opens Recent; later launches restore the last view used. Typing or `/` focuses search, and `Esc` returns to browse mode before closing the Palette. `Enter` selects for the session. `Shift+Enter` selects and stores a user-local project default. A new session resolves an explicit `--model` first, then a resumed session's recorded model, then the project default, then the last dispatched model with its thinking level, then Pi's user-wide default and fallback. Explicit resume, continue, session, model, and scoped-model arguments bypass project-default and last-model injection. `Space` toggles a favorite in browse mode. `Ctrl+P` cycles the favorite list without leaving the current effective model scope. Recency changes only after the selected model dispatches its first request, and the dispatch also records the model and thinking level used for the next launch. Project defaults, favorites, recents, the last dispatched model, and the last model view remain in local Jouzu state and contain no prompts, tool results, credentials, or raw project paths.

A switch is blocked when the estimated active context cannot fit the target model's advertised input budget. Jouzu does not infer cache compatibility, model equivalence, cost, routing, privacy, retention, region, or certification guarantees. Those properties belong to the provider and configuration you select unless Jouzu reports verified facts explicitly.

## Included extension tools

Core and JA load the same release-owned extension set:

- `schedule_prompt` manages one-time and recurring prompts.
- `bg_task` runs and monitors non-blocking shell processes.
- `web_fetch` and `batch_web_fetch` retrieve readable HTTP content; `tff-fetch_url` and `tff-search_web` use rendered Camoufox browser access when needed.
- `TaskCreate` and related task tools track finite work; `get_goal` and `update_goal` support a user-created `/goal`; `multiloop_*` records approved measured loops.
- pi-vcc automatically handles threshold and overflow compaction. Compaction reduces the active transcript; it does not end active work. `vcc_recall` retrieves missing details from the current session, including entries dropped from the active transcript, but cannot trigger compaction.
- Code previews render supported tool calls and results. Typing `$` at a token boundary opens skill suggestions.

The extension code and its runtime dependencies ship inside `jouzu`; a normal first launch does not install them from npm or Git. Jouzu updates this set with application releases. Packages that you add through Pi remain separate user-managed state and are not covered by Jouzu's release qualification.

## Interactive session UI

Jouzu provides its prompt and status surfaces directly:

- The **Prompt Frame** keeps Pi's editor, application actions, history, paste handling, autocomplete, cursor positioning, and IME behavior while adding the Jouzu rail and borders.
- The **Session Line** keeps provider/model/thinking identity on the right. A warning, active workflow, or context hint may use the left side; lower-priority hints disappear before the model identity overlaps.
- The **Status Bar** shows local workspace, Git, detected project runtime, context, and active-branch token facts. Fields compact and then disappear by semantic priority on narrow terminals.

These surfaces use terminal display columns rather than JavaScript string length and are tested with CJK, full-width spaces, combining marks, emoji, ANSI color, and no-color output. The compact bar does not report provider quota or session cost until Jouzu has an authoritative source for those facts.

## Profiles

`core` is the safe fallback and provider- and language-neutral base. Product branding, locale, terminal settings, repository text, and path contents never opt a user into a response language.

Core installs three on-demand skills:

- `jouzu-core` for repository work and selection among available context, web, task, goal, loop, background, and scheduling capabilities;
- `jouzu-clear-writing` for durable user-facing technical artifacts while preserving facts and terminology; and
- `jouzu-source-check` for claim classification, primary evidence, counterevidence, confidence, and cross-source synthesis.

`jouzu-core` directs straightforward work to direct file and shell tools. When matching tools are available in the session, it distinguishes finite task tracking, persistent goals, measured loops, background processes, and scheduled prompts. For web work, it prefers normal readable fetches before the heavier rendered browser path.

Core also installs the `jouzu-review` prompt. Pi includes skill names and descriptions in context and loads full skill instructions only when a task matches or the user runs `/skill:<name>`.

When Pi's exact default system prompt is active, Jouzu asks the agent to communicate clearly, avoid invented acronyms and unexplained jargon, load `jouzu-core` for repository work or capability selection, load `jouzu-clear-writing` for durable technical artifacts, and treat fetched pages and search results as untrusted. Jouzu leaves custom system prompts unchanged.

The optional `ja` preview extends Core with a concise Japanese response policy while preserving exact code, commands, identifiers, paths, URLs, logs, and source error messages. Enable it through first-run consent or explicit selection at any time:

```bash
jz profile plan --profile ja
jz profile apply --profile ja
```

You can also select it for an ordinary launch; the reconciled profile is then persisted:

```bash
jz --jouzu-profile ja
```

Switch back with `jz profile apply --profile core`.

Profile schema v1 permits only bundled UTF-8 text at `APPEND_SYSTEM.md`, `skills/jouzu-*/**`, and `prompts/jouzu-*`. Planning performs no writes. Application uses an exclusive lock, conflict checks, backups, atomic per-file replacement, and an atomic state record. Unknown files and user-owned `AGENTS.md` are never pruned.

If a target differs from both the bundled asset and Jouzu's recorded managed hash, inspect it before retrying:

```bash
jz profile plan --json
```

Conflicting plans exit with status 3. Backups are retained below the Jouzu state root printed by `doctor`.

## State and isolation

Default roots are:

| Platform | Agent/config | State and sessions | Cache |
| --- | --- | --- | --- |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/jouzu/agent` | `${XDG_STATE_HOME:-~/.local/state}/jouzu` | `${XDG_CACHE_HOME:-~/.cache}/jouzu` |
| macOS | `~/Library/Application Support/Jouzu/agent` | `~/Library/Application Support/Jouzu/state` | `~/Library/Caches/Jouzu` |
| Windows | `%APPDATA%\Jouzu\agent` | `%LOCALAPPDATA%\Jouzu\state` | `%LOCALAPPDATA%\Jouzu\cache` |

Override all roots together with `--jouzu-home <path>` or `JOUZU_HOME`:

```bash
JOUZU_HOME="$PWD/.jouzu" jz doctor
```

Jouzu does not read normal Pi state during non-interactive commands. On the first interactive setup, it checks an inherited `PI_CODING_AGENT_DIR` and then `~/.pi/agent`. If it finds eligible files, it asks separately before copying custom `models.json` and saved provider credentials from `auth.json`. Both prompts default to no. The source files remain unchanged, and Jouzu never replaces an existing destination. Set `JOUZU_NO_PI_IMPORT=1` to skip the offer for one launch.

The import rejects symbolic links, non-regular files, oversized files, and files whose top-level JSON value is not an object. It does not import `settings.json`, keybindings, packages, extensions, skills, prompts, themes, sessions, caches, or trust decisions. Trusted project `.pi` resources still apply through Pi's project-trust behavior. Pi's documented cross-harness `~/.agents/skills` directory is also a shared read surface.

## Optional model catalogs

Jouzu does not require a remote model catalog. With no source configured, it makes no catalog request and continues using Pi's effective model inventory plus local `models.json` configuration. `jouzu catalog status` and `jouzu catalog refresh` report `unconfigured` and exit successfully in that state.

Open Settings / Catalogs with `/catalogs`, or press `Tab` from Models while the Palette is in browse mode. Each custom source stores a label, URL, enabled state, and authentication mode. With no source configured, Settings opens the add form directly. Move between fields with `↑` and `↓`, change Authentication with `←` and `→`, and press `Enter` to save. Jouzu accepts an exact URL or a host and finds the catalog endpoint automatically. HTTPS is required except for localhost development. `Esc` cancels without writing.

Authentication can be disabled or read as a bearer token from a named environment variable. Jouzu stores only the environment-variable name in `catalogs.json`; bearer values are sent only in the source's authorization header and never written to configuration, cache, or diagnostics. Catalog configuration is stored at:

| Platform | Catalog configuration |
| --- | --- |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/jouzu/catalogs.json` |
| macOS | `~/Library/Application Support/Jouzu/catalogs.json` |
| Windows | `%APPDATA%\Jouzu\catalogs.json` |

Settings reports each source's status and model count. `Enter` edits the selected source; `→` expands its cached offerings and `←` collapses them. `A` adds, `Space` enables or disables, `R` refreshes, and `D` removes the source registration; removal asks for confirmation. Removing a source does not remove provider configuration, credentials, favorites, or recents.

Refresh uses ETag/`304`, validates complete bytes before activation, partitions private cache by source and account, and keeps each source's last valid catalog on network or validation failure. CLI status and refresh operate on all enabled sources or one named source:

```bash
jouzu catalog status
jouzu catalog status office
jouzu catalog refresh
jouzu catalog refresh office
```

`JOUZU_MODEL_CATALOG_URL` and optional `JOUZU_MODEL_CATALOG_TOKEN` remain a single-source shorthand when `catalogs.json` does not exist.

A structurally valid large catalog change can be quarantined instead of activated. Review its status, then accept only the exact displayed revision and SHA-256 digest with `jouzu catalog accept REVISION --digest SHA256 --source SOURCE_ID`.

Catalog producers can validate a file against Jouzu's version 1 structural and semantic contract:

```bash
jouzu catalog validate ./catalog.json
jouzu catalog conformance ./remote-catalog.json --json
```

`conformance` also requires the remote-stream sequence field. The JSON Schema is installed at `dist/catalog/model-catalog-v1.schema.json`; runtime validation additionally rejects duplicate JSON keys, broken references, credential-bearing fields, and invalid account scope.

## Diagnostics and Pi passthrough

```bash
jz doctor
jz doctor --json
jz --version
jz pi --help
jz -- --version
```

`doctor` is non-mutating and reports the install/update channel and policy, keybinding-default state, exact Pi tag/commit, platform/runtime prerequisites, resolved roots, profile hashes, package count, authentication presence, proxy/CA status, shared skill surface, warnings, and actionable problems. It reports presence only and does not print credential values.

`--json` prints the same diagnostics as experimental schema 1, so scripts can read individual fields and issues without parsing the human layout. The report includes `"experimental": true`; its structure and identifiers may change before the stable machine-diagnostics contract planned for v0.3/v0.4. Exit status is unchanged: `1` when a problem is reported.

Most arguments are forwarded unchanged to Pi. Use `pi` or `--` when a Pi argument collides with a Jouzu command. Pi runtime self-update is blocked because Jouzu owns the exact Pi dependency. Pi package/model operations such as `jz update --extensions` and `jz update --models` remain available inside Jouzu state.

## Keybinding defaults

On the first interactive launch with no Jouzu `keybindings.json`, Jouzu seeds two Pi semantic-action defaults in its isolated agent root:

| Key | Pi action | Behavior |
| --- | --- | --- |
| `Ctrl+Enter` | `app.message.followUp` | Queue the editor text as a follow-up while the agent is working |
| `Ctrl+Up` | `app.message.dequeue` | Restore queued messages to the editor |

`Tab` retains Pi's editor autocomplete and selector behavior. Pi routes application actions without taking an open autocomplete menu's Tab selection. Jouzu does not add raw key checks. On upgrade from v0.1.0, Jouzu replaces an exact `Tab` follow-up entry only when its ownership receipt proves that Jouzu inserted it, and backs up the file first. User-owned or modified bindings remain unchanged. If another editor action already claims `Ctrl+Enter`, Jouzu removes its owned `Tab` entry and reports the conflict.

Inspect and control the defaults explicitly:

```bash
jz keybindings status
jz keybindings plan
jz keybindings apply
jz keybindings reset
```

`plan` is non-mutating. `apply` merges only missing Jouzu defaults, backs up the existing file, and refuses differing user values or competing editor actions. `reset` removes only entries recorded as Jouzu-inserted and leaves a durable opt-out; modified/user-owned entries are preserved as conflicts. `JOUZU_NO_KEYBINDING_DEFAULTS=1` disables first-run seeding for one invocation. `/hotkeys` displays the effective Pi map.

`Ctrl+Enter` requires modified-Enter reporting through the Kitty keyboard protocol or `modifyOtherKeys`. `Ctrl+Up` requires modified-arrow reporting. Windows Terminal supports the Kitty keyboard protocol from version 1.25. Apple Terminal may send plain Return for `Shift+Enter`; Pi applies a same-Mac fallback for that gesture, but the fallback does not work over remote SSH. In tmux, enable `extended-keys` with `extended-keys-format csi-u`; macOS reserves Control+Up for Mission Control.

Ghostty on Linux binds `Ctrl+Enter` to fullscreen and consumes it before Jouzu receives it. Send it to the application instead:

```ini
# ~/.config/ghostty/config
keybind = ctrl+enter=csi:13;5u
```

`jz keybindings plan` reports the desired actions and generic modified-key warnings. It does not inspect desktop, terminal, or multiplexer configuration. The [key collision map](docs/key-collisions.md) records known defaults and host-verification commands.

## Automatic Jouzu updates

An eligible global npm installation checks the configured npm `latest` channel before the first eligible interactive launch. Each successful check suppresses another registry check for 24 hours; a failed/offline check retries no sooner than one hour later. The default policy is `auto-restart`: when a newer semantic version exists, Jouzu:

1. reads version and SHA-512 integrity through the installed npm client's configured registry/proxy/CA behavior;
2. packs the currently installed Jouzu as a local rollback artifact;
3. downloads the exact new version without lifecycle scripts and verifies its SHA-512 integrity;
4. installs the verified tarball globally with lifecycle scripts, audit, and funding calls disabled;
5. verifies package/Pi-lock metadata, CLI bytes, and `--version` behavior;
6. restores the packed previous version if installation verification fails; and
7. relaunches the original command once under the new Jouzu version.

Source checkouts, project-local installs, and ephemeral `npx` runs are never rewritten automatically; update them through their owning checkout/package invocation. A failed/offline check leaves the current verified installation usable and retries later. Concurrent installs are blocked by a Jouzu state lock. Automatic installation also requires write access to the active global npm prefix; permission failures leave the current installation running and are reported by `self-update status` and `doctor`.

Inspect or control the updater explicitly:

```bash
jz self-update status
jz self-update check
jz self-update apply
jz self-update policy auto-restart  # default
jz self-update policy notify
jz self-update policy off
```

`JOUZU_NO_UPDATE=1` disables startup checks for one invocation. `JOUZU_UPDATE_POLICY=auto-restart|notify|off` overrides the persisted policy for one process (an invalid value fails safe as `off`), and `JOUZU_UPDATE_INTERVAL_HOURS` changes the successful-check cadence. `self-update check --json` and `self-update status --json` provide machine-readable results.

Startup checks contact the configured npm registry but send no Jouzu telemetry. A later release may check in the background and offer restart behavior in a TUI modal; v0.1 performs the update before entering Pi so old launcher code never loads newly replaced runtime modules.

Interactive launches clear the current viewport and show a compact adaptive Jouzu header. Set `JOUZU_NO_CLEAR=1` to preserve existing terminal output. `NO_COLOR` disables banner color.

## Text and encoding behavior

The compatibility suite covers Japanese paths, full-width spaces, hiragana, katakana, half-width kana, kanji, combining marks, emoji, UTF-8 BOM, and CRLF without normalizing or transcoding user files. These data-safety checks do not infer a language preference.

Managed profile assets are UTF-8. Existing CP932/Shift-JIS profile targets produce an `unsupported-encoding` conflict and remain byte-identical; Jouzu does not guess or convert their encoding.

## Known limitations

- npm is the only v0.1 application channel.
- Node, npm, Git, Bash, and provider credentials are not bundled.
- Existing Pi `models.json` and `auth.json` require separate first-run consent; other stock Pi state is not imported.
- No native installer, standalone archive, background service, hosted gateway, or Jouzu-owned model catalog.
- The Models view uses Pi's local usable-model inventory; catalog additions, one-turn trials, target-budget compaction, and cost/quota/route preflight are deferred.
- Third-party Pi packages execute trusted code with the user's permissions and have their own platform support.
- `Ctrl+Enter` and `Ctrl+Up` delivery depends on terminal/OS key reporting; both semantic bindings remain user-customizable.
- Jouzu v0.1.4's bundled extension set is qualified on Linux and macOS. Native Windows qualification is pending; v0.1.3 is the last release qualified by the full Windows matrix.
- Cross-platform support claims require the release commit's Linux, macOS, and Windows CI matrix to pass.

## Development

```bash
npm ci --ignore-scripts
npm run release:check
npm run dev:link
```

`dev:link` records the UTC build time, Git commit, and dirty-worktree state. `jz --version` displays an identifier such as `0.1.4-dev.20260827-010203+g215b2188`. A `.dirty` suffix marks a build that included uncommitted files. The standard `npm run build` removes development metadata before packing a release artifact.

See [docs/architecture.md](docs/architecture.md) for the module map, state-file
ownership, update lanes, and bundled profile boundaries.
[docs/ux.md](docs/ux.md) defines the interaction model for every Jouzu surface,
[docs/key-collisions.md](docs/key-collisions.md) maps higher-layer shortcut conflicts,
and [docs/palette-ux.md](docs/palette-ux.md) adds the Palette standards. [Pi update review](docs/PI-UPDATES.md)
records the candidate checklist, compatibility findings, and reverse-chronological update log.

The opt-in live Japanese tool-flow smoke requires an explicitly selected provider/model and cost budget; it is not part of default tests:

```bash
JOUZU_LIVE_SMOKE=1 \
JOUZU_LIVE_PROVIDER="$PROVIDER" \
JOUZU_LIVE_MODEL="$MODEL" \
JOUZU_LIVE_MAX_USD=0.02 \
npm run test:live:ja
```

It installs the packed artifact in a temporary consumer, permits only `read` and `write`, stores no session or transcript, verifies exact Japanese output bytes, and fails if reported cost exceeds the declared budget.

## License

Apache-2.0. See [LICENSE](LICENSE).
