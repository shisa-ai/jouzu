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
npm install --global jouzu@0.1.1

jouzu --version
jz doctor
```

`jz` is an exact alias for `jouzu`. To try the CLI without a global installation:

```bash
npx --yes jouzu@0.1.1 --version
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

A normal launch safely reconciles the selected profile. It stops before Pi if a managed target conflicts with a user-owned or modified file.

Inside Pi:

- `/login` configures provider authentication in Jouzu's isolated agent root.
- `/model` or `Ctrl+L` opens the Jouzu Palette Models view without clearing the prompt draft.
- `/status` reports provider-neutral session, workspace, model, thinking, context, scoped-model, profile, and runtime facts.
- `Ctrl+/` or `Ctrl+?` opens Jouzu help; `/hotkeys` lists all Pi shortcuts.

The Models view searches exact provider/model identity and display names. `Tab` and `Shift+Tab` cycle through Recent, Favorite, and All filters; the header reports active results and total selectable inventory. `Enter` selects for the session. `Shift+Enter` selects and stores a user-local project default. A new session resolves an explicit `--model` first, then a resumed session's recorded model, then the project default, then Pi's user-wide default and fallback. Explicit resume, continue, session, model, and scoped-model arguments bypass project-default injection. `Ctrl+F` toggles a global favorite and `Alt+F` toggles a project favorite. Favorites affect discovery but never select a model automatically. Recency changes only after the selected model dispatches its first request. Defaults, favorites, and recents remain in local Jouzu state and contain no prompts, tool results, credentials, or raw project paths.

A switch is blocked when the estimated active context cannot fit the target model's advertised input budget. Jouzu does not infer cache compatibility, model equivalence, cost, routing, privacy, retention, region, or certification guarantees. Those properties belong to the provider and configuration you select unless Jouzu reports verified facts explicitly.

## Interactive session UI

Jouzu provides its prompt and status surfaces directly:

- The **Prompt Frame** keeps Pi's editor, application actions, history, paste handling, autocomplete, cursor positioning, and IME behavior while adding the Jouzu rail and borders.
- The **Session Line** keeps provider/model/thinking identity on the right. A warning, active workflow, or context hint may use the left side; lower-priority hints disappear before the model identity overlaps.
- The **Status Bar** shows local workspace, Git, detected project runtime, context, and active-branch token facts. Fields compact and then disappear by semantic priority on narrow terminals.

These surfaces use terminal display columns rather than JavaScript string length and are tested with CJK, full-width spaces, combining marks, emoji, ANSI color, and no-color output. The compact bar does not report provider quota or session cost until Jouzu has an authoritative source for those facts.

## Profiles

`core` is the safe fallback and provider- and language-neutral base. Product branding, locale, terminal settings, repository text, and path contents never opt a user into a response language.

The optional `ja` preview extends Core with a concise Japanese response policy while preserving exact code, commands, identifiers, paths, URLs, logs, and source error messages. Enable it through first-run consent or explicit selection at any time:

```bash
jz profile plan --profile ja
jz profile apply --profile ja
```

You can also select it for an ordinary launch; the reconciled profile is then persisted:

```bash
jz --jouzu-profile ja
```

Switch back safely with `jz profile apply --profile core`.

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

Jouzu does not import normal Pi settings, credentials, packages, or sessions. It preserves Pi's project trust behavior, so trusted project `.pi` resources still apply. Pi's documented cross-harness `~/.agents/skills` directory is also a shared read surface. Jouzu is isolated from global Pi state, not from explicitly trusted project resources or provider credentials in the current environment.

## Diagnostics and Pi passthrough

```bash
jz doctor
jz --version
jz pi --help
jz -- --version
```

`doctor` is non-mutating and reports the install/update channel and policy, keybinding-default state, exact Pi tag/commit, platform/runtime prerequisites, resolved roots, profile hashes, package count, authentication presence, proxy/CA status, shared skill surface, warnings, and actionable problems. It reports presence only and does not print credential values.

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

`Ctrl+Enter` requires modified-Enter reporting through the Kitty keyboard protocol or `modifyOtherKeys`. `Ctrl+Up` requires modified-arrow reporting. In tmux, enable `extended-keys` with `extended-keys-format csi-u`; macOS may reserve Control+Up for Mission Control. `jz keybindings plan` reports these portability notes so users can keep or explicitly customize the semantic actions.

## Automatic Jouzu updates

A real global npm installation checks the configured npm `latest` channel before the first eligible interactive launch. Each successful check suppresses another registry check for 24 hours; a failed/offline check retries no sooner than one hour later. The default policy is `auto-restart`: when a newer semantic version exists, Jouzu:

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
- No automatic import from an existing Pi installation.
- No native installer, standalone archive, background service, hosted gateway, or Jouzu-owned model catalog.
- The Models view uses Pi's local usable-model inventory; catalog additions, one-turn trials, target-budget compaction, and cost/quota/route preflight are deferred.
- Third-party Pi packages execute trusted code with the user's permissions and have their own platform support.
- `Ctrl+Enter` and `Ctrl+Up` delivery depends on terminal/OS key reporting; both semantic bindings remain user-customizable.
- Cross-platform support claims require the release commit's Linux, macOS, and Windows CI matrix to pass.

## Development

```bash
npm ci --ignore-scripts
npm run release:check
npm run dev:link
```

`dev:link` records the UTC build time, Git commit, and dirty-worktree state. `jz --version` displays an identifier such as `0.1.1-dev.20260823-140409+gb3e714f2`. A `.dirty` suffix marks a build that included uncommitted files. The standard `npm run build` removes development metadata before packing a release artifact.

See [docs/architecture.md](docs/architecture.md) for the module map, state-file
ownership, update lanes, and bundled profile boundaries. [Pi update review](docs/PI-UPDATES.md)
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
