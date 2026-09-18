# Jouzu

Jouzu is Shisa AI's terminal coding agent, built on [Pi coding agent](https://pi.dev/). It combines coding tools, background jobs, and child agents in one session:

- **Goals, loops, and scheduled work.** Track multi-step tasks, work toward a goal, run measured improvement loops, and schedule prompts.
- **Background work without repeated interruptions.** Run shell jobs while you keep working, inspect logs, and receive batched unread completion summaries.
- **Child agents with defined roles.** Assign a model, tools, instructions, and workspace; inspect results, send follow-ups, stop runs, and resume their conversations.
- **Web search and readable pages.** Fetch pages directly or use browser-backed search and rendering. The Camoufox browser runtime installs on first use.
- **Local content scanning.** TextGuard checks skills and web results before they reach the model. Flagged web results arrive labelled as untrusted data; flagged skills wait for your approval. Scanning is not a guarantee of safety.
- **Searchable session history.** Recall earlier decisions and code after context compaction without keeping the whole conversation in the model's active context.
- **Japanese and mixed-width text support.** Terminal layouts account for Japanese, Chinese, Korean, and emoji display widths. The optional Japanese profile adds language-focused instructions and skills.
- **Voice dictation.** Speak into an editable prompt with live previews and finalized transcription through Shisa. Requires realtime speech access; never auto-sends.
- **Models that remember your choices.** Search providers and models in the Palette, keep favorites, and save project defaults and per-model reasoning preferences. [Shisa AI's API service](https://platform.shisa.ai/) supplies an account-aware model catalog when configured.

Jouzu v0.1.x is **alpha** software. Expect frequent updates and changes.

## Requirements

For npm installations:

- Node.js 22.19 or newer and npm
- Git
- Bash (`bash` on Linux/macOS; Git Bash on Windows)

For Windows setup, see [Windows prerequisites](https://github.com/shisa-ai/jouzu/blob/main/docs/windows.md).

`web_fetch` and `batch_web_fetch` work from the default installation. The rendered-browser tools install their exact Camoufox runtime from npm on the first `tff-fetch_url` or `tff-search_web` call, then download the Camoufox browser if needed. These downloads require network access and writable Jouzu state. `jz doctor` reports whether the optional runtime is absent, ready, or invalid.

Rendered fetches return up to 50,000 characters to the model and mark truncation. Search results mark empty responses as inconclusive and results at the requested limit as possibly incomplete. Browser screenshots default to JPEG and attach only when at most 1 MiB.

The Camoufox browser stays loaded once a browser tool call starts it. When no `tff-fetch_url` or `tff-search_web` call has run for five minutes, Jouzu stops the browser to release its memory, and the next call relaunches it, which takes a few seconds. Set `JOUZU_CAMOUFOX_IDLE_STOP_MS` to a whole number of milliseconds from 1000 to 2147483647 to change the delay, or to `0` to keep the browser loaded until the session ends. An invalid value stops the browser tools from loading for that session; the startup warning reports the cause. Stopping releases the browser process; the runtime modules already loaded in the session stay in memory.

On older enterprise Linux distributions, install the GTK/X11/audio libraries required by Firefox. If the system NSS is older than Camoufox requires, set `JOUZU_CAMOUFOX_LIBRARY_PATH` to a compatible NSS library directory; Jouzu applies it only to the browser child.

## Install

```bash
npm install -g jouzu

jouzu --version
jz doctor
```

`jz` is an exact alias for `jouzu`. To try the CLI without a global installation:

```bash
npx --yes jouzu --version
```

[GitHub Releases](https://github.com/shisa-ai/jouzu/releases) include the same tested npm tarball, checksums, and package manifest from v0.1.7 onward. The Windows installer is a separate download.

Download the unsigned Windows x64 installer from the [v0.1.13 release page](https://github.com/shisa-ai/jouzu/releases/tag/v0.1.13). It bundles Node.js/npm, Git Bash, Windows Terminal, and native tools, with desktop and Start menu shortcuts. The launcher shows the working folder before it opens a terminal and can remember it for later launches; if the saved folder is unavailable, it asks for another folder instead of opening a different one. Windows may show an unknown-publisher warning. The preview has been tested on Windows Server 2025; clean Windows 10/11 testing remains pending. See [Windows installer preview](https://github.com/shisa-ai/jouzu/blob/main/packaging/windows/README.md) for setup and testing details.

## Quick start

Start Jouzu:

```bash
jz
```

On the first interactive launch, Jouzu asks whether to enable the optional Japanese-support profile. Only an affirmative answer selects `ja`; declining or pressing Enter selects the provider-neutral `core` profile. Jouzu saves that choice for later launches. Non-interactive first runs use `core`.

Before choosing, you can inspect either profile without writing:

```bash
jz profile plan --profile core
jz profile plan --profile ja
```

A normal launch reconciles the selected profile. It stops before launching if a managed target conflicts with a user-owned or modified file.

Jouzu also offers to connect a Shisa AI account once when no Shisa credential is configured. Choose `y` to sign up or sign in through your browser; signup credits are available for eligible accounts. Press Enter or answer `n` to skip. You can connect later with `/login shisa`.

Inside Jouzu:

- `/login shisa` connects your Shisa account. Use `/login` to select another provider.
- `/logout shisa` attempts to revoke the key issued by Shisa sign-in and removes its saved credentials. Selecting Shisa in `/logout` does the same.
- `/workflow` opens agent definitions and child runs. Configure separate planner, coder, and reviewer models, or add your own roles. See [Agents and runs](https://github.com/shisa-ai/jouzu/blob/main/docs/subagents.md).
- `/model` or `Ctrl+L` opens the Jouzu Palette Models view without clearing the prompt draft.
- `Ctrl+P` and its reverse binding cycle through available favorites in the current model scope.
- `/status` shows the session, workspace, model, thinking level, context usage, profile, and runtime.
- `/flow` shows held automatic work and commands to resume or repair it.
- `Ctrl+/` or `Ctrl+?` opens Jouzu help; `/hotkeys` lists all Jouzu shortcuts.

The Palette shows Models, Workflow, and Settings as top-level sections; `Tab` and `Shift+Tab` move between them. The Models view searches exact provider/model identity and display names. `←` and `→` change the Recent, Favorite, or All view; the header reports active results and total selectable inventory. The first launch opens Recent; later launches restore the last view used. Typing or `/` focuses search; the title shows `· Search` while search holds focus, and `Esc` returns to browsing with the query intact before another `Esc` closes the Palette.

`Enter` selects the model and stores it as the user-local project default. A new session resolves an explicit `--model` first, then a resumed session's recorded model, then the project default, then the last dispatched model, then Jouzu's user-wide default and fallback. Restoring a project default or last dispatched model also restores that model's saved thinking (reasoning) level unless you pass `--thinking`. Explicit resume, continue, session, model, and scoped-model arguments bypass project-default and last-model injection.

`Ctrl+F` toggles a favorite while browsing and while searching; rebind it through the `jouzu.model.toggleFavorite` action in `keybindings.json`. `Ctrl+Shift+R` refreshes model catalogs and providers without leaving Models, then updates the list; rebind it through the `jouzu.model.refresh` action. `Ctrl+P` cycles the favorite list without leaving the current effective model scope.

Catalog offerings may declare `supportedThinkingLevels`: Jouzu shows only those levels and clamps unsupported selections to the next supported level, or the highest supported level when none is higher. `off` is selectable only when listed. Levels Jouzu does not recognize are ignored, so a catalog that declares a newer level still loads; an unrecognized `defaultThinkingLevel` is ignored. Omission keeps the provider adapter's available levels.

Each model remembers your explicit thinking-level override when you switch back to it. Without an override, Jouzu uses the catalog offering's `defaultThinkingLevel`, then Pi's configured default. Dispatch history does not override these defaults. Explicit startup thinking arguments, resumed-session levels, and scoped-model thinking pins retain precedence. Changing the thinking level saves the preference immediately, even before another request.

Recency changes only after the selected model dispatches its first request, which records its thinking level in global and project recents. Clearing recents keeps explicit thinking preferences. Project defaults, favorites, recents, thinking preferences, the last dispatched model, and the last model view remain in local Jouzu state and contain no prompts, tool results, credentials, or raw project paths.

A direct switch is blocked only when the estimated active context plus a 4,096-token safety margin exceeds the target model's context window. Selecting a `context-small` model opens a confirmation: press `Enter` again to compact the full active transcript into a brief and switch after Jouzu rechecks the context, or press `Esc` to cancel. Bundled pi-vcc handles this compaction under the default profile settings. Jouzu does not infer cache compatibility, model equivalence, cost, routing, privacy, retention, region, or certification guarantees. Those properties belong to the provider and configuration you select unless Jouzu reports verified facts explicitly.

## Automatic work and flow control

Jouzu coordinates background jobs, goals, loops, and task lists by default. Background results arrive in batches after the current response and queued messages. Tasks can wait for your input or for another job before continuing. You can ask Jouzu to show, reorder, pause, or continue tasks.

Run `/flow` to see why automatic work has stopped and which commands can resume it. `/flow pause` pauses automatic replies; `/flow resume` allows them again. Interrupting a reply also pauses automatic work until your next message or `/flow resume`. Pausing does not stop background jobs.

`/flow off` takes flow control out of the circuit for this session: what you send runs as an ordinary turn, and jobs, tasks, and loops deliver their own notifications instead of flow composing them. `/flow on` puts flow control back. Both keep the session, its records, and every running job. `/flow reset` does both in order.

If a turn stays stuck, run `/flow clear` while Jouzu is idle. This releases the stuck turn without stopping jobs or deleting their records. If Jouzu cannot tell whether a model request completed, use `/flow resolve <attempt> retry|discard` with the identifier shown by `/flow`. Retrying may repeat a request the model already answered.

Returning to where you last left a recent conversation branch resumes its unfinished work, including tasks waiting for background jobs. Rewinding to an earlier point starts a new branch without resuming that work. It does not undo file changes. Reopening a session continues from its last saved position, which may differ from the branch you last viewed.

If a conversation branch lacks a tool result, Jouzu tells the model the outcome is unknown. It does not rerun the tool, copy a result from another branch, or change the saved conversation. If Jouzu cannot safely match tool calls to their results, it stops the request.

Use `/flow runtime` to compare the running and installed versions when troubleshooting. If they differ, restart Jouzu to load the installed version.

Set `JOUZU_FLOW_CONTROL=0` before starting Jouzu to disable flow control for that process. See [v0.1.9 release notes](https://github.com/shisa-ai/jouzu/blob/main/docs/releases/v0.1.9.md) for the command list and [Testing](https://github.com/shisa-ai/jouzu/blob/main/docs/testing.md) for validation limits.

## Included extension tools

Core and JA load the same release-owned extension set:

- `schedule_prompt` manages one-time and recurring prompts.
- `bg_task` runs and monitors non-blocking shell processes.
- `web_fetch` and `batch_web_fetch` retrieve readable HTTP content; `tff-fetch_url` and `tff-search_web` use rendered Camoufox browser access when needed.
- `TaskCreate` and related task tools track finite work; `get_goal` and `update_goal` support a user-created `/goal`; `multiloop_*` records approved measured loops.
- `/goal` lists running and paused goals with command hints. Use `/goal pause`, `/goal stop`, or `/goal resume`, optionally followed by a `lane/run-tag`; without a target, pause and stop select the attached goal or the only matching goal. Resume selects the only saved goal directly; when there are multiple goals or the target is unclear, the agent uses the conversation and saved goals to find the intended one. Resume prompts the agent immediately when idle or queues the request while it is busy. `/multiloop` shows all runs. The Session Line shows running, paused, stopped, and completed counts for goals and loops used in the session.
- pi-vcc automatically handles threshold and overflow compaction. Compaction reduces the active transcript; it does not end active work. `vcc_recall` retrieves missing details from the current session, including entries dropped from the active transcript, but cannot trigger compaction.
- Code previews render supported tool calls and results. Typing `$` at a token boundary opens skill suggestions.

Release-owned extensions and their default runtime dependencies ship inside `jouzu`; a normal launch does not install them from npm or Git. The Camoufox client is the exception: Jouzu ships its exact package manifest and lockfile, installs them under Jouzu state on the first rendered-browser call, and does not add them to the package settings. Jouzu updates that lockfile with application releases. Packages that you add through Jouzu remain separate user-managed state and are not covered by Jouzu's release qualification.

## Interactive session UI

Jouzu provides its prompt and status surfaces directly:

- The **Prompt Frame** keeps Pi's editor, application actions, history, paste handling, autocomplete, cursor positioning, and IME behavior while adding the Jouzu rail and borders.
- The **Session Line** keeps provider/model/thinking identity on the right. The left side reports goals, loops, and child agents with an animated marker while work runs and a static marker for paused, stopped, or completed counts. That activity replaces the shortcut hint while it is present and the hint returns when nothing is running. Activity text truncates to fit, and either one disappears before the model identity overlaps.
- The **Status Bar** shows local workspace, Git, detected project runtime, context, and active-branch token facts. Fields compact and then disappear by semantic priority on narrow terminals.

These surfaces use terminal display columns rather than JavaScript string length and are tested with CJK, full-width spaces, combining marks, emoji, ANSI color, and no-color output. The compact bar does not report provider quota or session cost until Jouzu has an authoritative source for those facts.

## Shisa sign-in and sign-out

Run `/login shisa`, open the displayed verification URL, and complete approval in your browser. Jouzu saves a dedicated API key and device link with private file permissions. The saved key supplies inference, the Shisa model catalog, and voice; each service still requires access on your Shisa account.

An explicit `SHISA_API_KEY` takes precedence over the saved login. The Shisa catalog also accepts a separately saved catalog token before falling back to the login. If Jouzu saves the key but cannot confirm delivery to Shisa, it asks you to sign in again.

`/logout shisa` attempts server revocation before removing the local Shisa credential and device link. If the server cannot confirm revocation, Jouzu signs out locally and asks you to disconnect the device in the Shisa dashboard. A local storage failure is reported separately. A saved link without its issuing gateway also requires dashboard disconnect. Other providers retain their credentials.

Sign-out stops voice recording and removes Shisa catalog models from the picker. `SHISA_API_KEY` is left unchanged but is not used by Jouzu's Shisa login, catalog, or voice integration for the rest of this process. Run `/login shisa` to reconnect, or unset the variable before restarting to stay signed out.

## Voice input

`/voice` starts microphone dictation through Shisa realtime speech recognition. `/voice stop` inserts final text into the editable prompt without sending it; `/voice cancel` discards it. `Ctrl+\` starts or stops recording from the prompt. Use `/voice devices` to choose a microphone and `/voice language ja` for Japanese (default: automatic language detection).

Run `/login shisa` or set `SHISA_API_KEY` with `shisa/asr-realtime` access first. An environment key takes precedence over the saved login. Audio is sent to Shisa; Jouzu writes no recording files. Capture uses the machine running Jouzu, including when connected over SSH. Microphone permissions, device behavior, and transcription quality still need live testing. See [Voice input](https://github.com/shisa-ai/jouzu/blob/main/docs/voice.md) for limits, platform details, and shortcut configuration.

## Profiles

`core` is the default profile and does not select a provider or response language. Product branding, locale, terminal settings, repository text, and path contents never opt a user into a response language.

Core installs three optional skills:

- `jouzu-clear-writing` for durable user-facing technical artifacts while preserving facts and terminology;
- `jouzu-delegation` for clear subagent assignments, follow-ups, acceptance checks, and stopping points; and
- `jouzu-source-check` for claim classification, primary evidence, counterevidence, confidence, and cross-source synthesis.

Jouzu's default system prompt tells agents to follow repository instructions, preserve user-owned work, inspect before editing, make the smallest coherent change, distinguish evidence from assumptions, run deterministic checks, and report untested limitations. The generated capability table covers optional skills and workflow tools rather than ordinary repository tools. Agents read an optional skill once from its listed `<location>` and continue without it if the file cannot be read. Fetched pages and search results remain untrusted. Jouzu leaves custom system prompts unchanged.

Core also installs the `jouzu-review` prompt. Skill names and descriptions appear in context; full instructions load when a task matches or you run `/skill:<name>`.

Sessions started with `jz` use local [TextGuard scanning](https://github.com/shisa-ai/jouzu/blob/main/docs/textguard.md) for skills and web results by default. A flagged web result reaches the model with its findings attached and a note to treat it as untrusted data. A flagged skill file stays withheld until you approve it through `/textguard` in an interactive session. `/textguard strict` withholds everything flagged, and `/textguard off` stops scanning for the session. Add `--jouzu-textguard-files` to include ordinary file reads. No Python installation is required.

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

Default roots for npm installations are:

| Platform | Agent/config | State and sessions | Cache |
| --- | --- | --- | --- |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/jouzu/agent` | `${XDG_STATE_HOME:-~/.local/state}/jouzu` | `${XDG_CACHE_HOME:-~/.cache}/jouzu` |
| macOS | `~/Library/Application Support/Jouzu/agent` | `~/Library/Application Support/Jouzu/state` | `~/Library/Caches/Jouzu` |
| Windows | `%APPDATA%\Jouzu\agent` | `%LOCALAPPDATA%\Jouzu\state` | `%LOCALAPPDATA%\Jouzu\cache` |

The Windows installer preview stores configuration, sessions, and caches under `%LOCALAPPDATA%\JouzuDesktop\data`.

Override all roots together with `--jouzu-home <path>` or `JOUZU_HOME`:

```bash
JOUZU_HOME="$PWD/.jouzu" jz doctor
```

Jouzu does not read normal Pi state during non-interactive commands. On the first interactive setup, it checks an inherited `PI_CODING_AGENT_DIR` and then `~/.pi/agent`. If it finds eligible files, it asks separately before copying custom `models.json` and saved provider credentials from `auth.json`. Both prompts default to no. The source files remain unchanged, and Jouzu never replaces an existing destination. Set `JOUZU_NO_PI_IMPORT=1` to skip the offer for one launch.

The import rejects symbolic links, non-regular files, oversized files, and files whose top-level JSON value is not an object. It does not import `settings.json`, keybindings, packages, extensions, skills, prompts, themes, sessions, caches, or trust decisions. Trusted project `.pi` resources still apply through Pi's project-trust behavior. Pi's documented cross-harness `~/.agents/skills` directory is also a shared read surface.

## Optional model catalogs

Model catalogs refresh on startup, `/reload`, and `Ctrl+Shift+R` in the Models view. Authenticated gateway catalogs at `/v1/jouzu/model-catalog` supply models through that gateway using the catalog source’s bearer token. Catalog offerings take precedence over matching local `models.json` entries, including local routes, credentials, headers, and `modelOverrides`. New gateway providers need no local provider entry. Local-only models keep their configuration; disabling a catalog makes local entries visible again. Saved catalog models keep their source; missing gateway credentials do not cause a switch to a local connection. Other catalogs update metadata on configured providers. These operations do not rewrite `models.json`.

Jouzu includes a built-in `shisa-api` source. That source reads the account's model catalog from `https://api.shisa.ai/v1/jouzu/model-catalog` using `SHISA_API_KEY`, a token saved for the catalog, or the credential saved by `/login shisa`, in that order. Settings / Catalogs identifies when the Shisa login is in use. The login credential stays in `agent/auth.json`; it is not copied into the catalog token store and is not shared with other catalog endpoints. On interactive startup Jouzu refreshes each enabled source whose credential is available. A source that already has an activated catalog refreshes in the background while cached models keep serving. A source with nothing activated yet, whether it has never refreshed or its last attempt failed, refreshes before the model picker opens with an 8-second budget and a `Fetching model catalog…` message, so the first model selection can use it; if it does not answer in time, startup continues with cached and local configuration. Sources with a missing credential are not contacted and report no error. The token authenticates catalog and inference requests to the configured gateway origin and is never written to configuration, cache, or diagnostics.

The built-in source can be disabled in Settings / Catalogs. The choice is stored in `catalog-overrides.json` next to `catalogs.json` without any credential, and re-enabling restores the built-in defaults. A manually registered source with the same endpoint and `env:SHISA_API_KEY` credential takes the place of the built-in source, keeping its label, enabled state, and cached catalog. Source id `shisa-api` is reserved; `jouzu catalog status` reports a custom entry that claims it with another endpoint.

Open Settings / Catalogs with `/catalogs`, or use `Tab` to reach Settings while the Palette is in browse mode. Each custom source stores a label, URL, enabled state, and authentication mode. `A` opens the add form. Move between fields with `↑` and `↓`, change Authentication with `←` and `→`, and press `Enter` to save. Jouzu accepts an exact URL or a host and finds the catalog endpoint automatically. Plain HTTP URLs are accepted with a warning: HTTP sends the source's bearer token in plain text, so use HTTPS unless the catalog runs on this machine. `Esc` cancels without writing.

Authentication can be disabled or read as a bearer token from a named environment variable. Jouzu stores only the environment-variable name in `catalogs.json`; bearer values are sent only in the source's authorization header and never written to configuration, cache, or diagnostics. Instead of exporting a variable, a token can be entered directly in the add/edit form; it is saved in `catalog-credentials.json` next to `catalogs.json` with private file permissions, keyed to that source, and never rendered on screen. The environment variable takes precedence over the saved token, so exporting one overrides it. Saving a bearer source whose variable is not yet set is allowed: Jouzu warns in the source list and detail, saves the source without contacting it, and refreshes it once the variable is set or a token is saved. Removing a source, or switching its authentication to none, removes its saved token. Without an available credential, the Shisa catalog is not contacted; local model configuration remains available.

Catalog configuration is stored at:

| Platform | Catalog configuration |
| --- | --- |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/jouzu/catalogs.json` |
| macOS | `~/Library/Application Support/Jouzu/catalogs.json` |
| Windows | `%APPDATA%\Jouzu\catalogs.json` |

Settings reports each source's status and model count. `Enter` edits the selected source; `→` expands its cached offerings and `←` collapses them. `A` adds, `Space` enables or disables, `R` refreshes, and `D` removes the source registration; removal asks for confirmation. Model changes from these actions apply to the current session immediately. `/reload` refreshes local provider models and enabled catalogs whose credentials are available before reapplying the active catalog data. The built-in `shisa-api` row supports only `Space`; its endpoint and credential reference are managed by Jouzu. Removing a custom source deletes its saved catalog token and keeps provider configuration, provider credentials, favorites, and recents.

A global context ceiling sits above the source list. `↑` from the first source row focuses it, and `←` and `→` step through 128K, 192K, 256K, 384K, 512K, 768K, 1M, or off. The ceiling is stored in `context-policy.json` next to `catalogs.json`. Compaction, the footer percentage, and the model picker's fit check use the smaller of the model's declared window and the ceiling, so a 1M-token model under a 384K ceiling compacts as if its window were 384K. Catalog `limits.contextWindow` values compose through the same minimum, and an explicit `models.json` `modelOverrides.contextWindow` still outranks the ceiling. Turning the ceiling off restores the declared windows in the same session.

Refresh uses ETag/`304`, validates complete bytes before activation, partitions private cache by source and account, and keeps each source's last valid catalog on network or validation failure. A failed refresh records one bounded cause and the action to take: DNS resolution, connection, timeout, proxy authentication, HTTP 401, 403, or 407, certificate verification, or local catalog-data access. `catalog status` shows the recorded `Last error` and reports the overall status as degraded until a refresh succeeds. Recorded text excludes the bearer token and nested request details. CLI status and refresh operate on all enabled sources or one named source:

```bash
jouzu catalog status
jouzu catalog status office
jouzu catalog refresh
jouzu catalog refresh office
```

`catalog status` reports offerings missing input types or token limits needed to register a new model. Such offerings can update a matching existing model but cannot add one. `jz doctor` reports these gaps without contacting the catalog server; run `jz catalog refresh` before checking a server update.

`catalog status` also lists offerings that declare no `supportedThinkingLevels`. An offering that overrides a model Pi already knows keeps that model's levels, and a model the catalog adds is registered with thinking disabled, so a catalog that supports reasoning should declare levels explicitly. Offerings whose `capabilities` list omits `reasoning` are excluded, because the client marks those models as non-reasoning. `jz doctor` reports the count and points here for the list.

`JOUZU_MODEL_CATALOG_URL` and optional `JOUZU_MODEL_CATALOG_TOKEN` remain a single-source shorthand when `catalogs.json` does not exist. Refresh requests never follow redirects, so a bearer token cannot be forwarded to another origin.

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

`doctor` is non-mutating and reports the install/update channel and policy, keybinding-default state, exact Pi tag/commit, platform/runtime prerequisites, resolved roots, profile hashes, package count, authentication presence, proxy/CA status, shared skill directories, catalog registration and thinking-level gaps, warnings, and actionable problems. It reports presence only and does not print credential values.

`--json` prints the same diagnostics as experimental schema 1, so scripts can read individual fields and issues without parsing the human layout. The report includes `"experimental": true`; its structure and identifiers may change. Exit status is unchanged: `1` when a problem is reported.

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

Jouzu also owns a semantic favorite action with code defaults, rebindable through the same `keybindings.json`:

| Key | Jouzu action | Behavior |
| --- | --- | --- |
| `Ctrl+F` | `jouzu.model.toggleFavorite` | Toggle the selected model's favorite status; also works while the search field holds focus, where it takes precedence over cursor-right |
| `Ctrl+Shift+R` | `jouzu.model.refresh` | Refresh model catalogs and providers, then update the Models list; also works while the search field holds focus |

`Ctrl+F` encodes as a plain control byte, so it works without an enhanced keyboard protocol. Inside the Models search field it replaces Pi's emacs-style cursor-right; `→` remains available there. `Ctrl+Shift+R` needs the Kitty keyboard protocol or `modifyOtherKeys`; without one it collapses to `Ctrl+R`, and the Catalogs `R` refresh remains the unmodified route.

`Ctrl+Enter` requires modified-Enter reporting through the Kitty keyboard protocol or `modifyOtherKeys`. `Ctrl+Up` requires modified-arrow reporting. Windows Terminal supports the Kitty keyboard protocol from version 1.25. In tmux, enable `extended-keys` with `extended-keys-format csi-u`; macOS reserves Control+Up for Mission Control.

Ghostty on Linux binds `Ctrl+Enter` to fullscreen and consumes it before Jouzu receives it. Send it to the application instead:

```ini
# ~/.config/ghostty/config
keybind = ctrl+enter=csi:13;5u
```

`jz keybindings plan` reports the desired actions and generic modified-key warnings. It does not inspect desktop, terminal, or multiplexer configuration. The [key collision map](https://github.com/shisa-ai/jouzu/blob/main/docs/key-collisions.md) records known defaults and host-verification commands.

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

The Windows installer preview checks GitHub Releases from its working-folder screen once per 24 hours and offers a **Download update** link when a newer stable x64 installer is available. Run the downloaded installer to upgrade. Desktop launches disable automatic npm updates.

For npm installations, startup checks contact the configured npm registry but send no Jouzu telemetry. Updates finish before the interactive session starts.

Interactive launches clear the current viewport and show a compact adaptive Jouzu header. Set `JOUZU_NO_CLEAR=1` to preserve existing terminal output. `NO_COLOR` disables banner color.

## Text and encoding behavior

The compatibility suite covers Japanese paths, full-width spaces, hiragana, katakana, half-width kana, kanji, combining marks, emoji, UTF-8 BOM, and CRLF without normalizing or transcoding user files. These data-safety checks do not infer a language preference.

Managed profile assets are UTF-8. Existing CP932/Shift-JIS profile targets produce an `unsupported-encoding` conflict and remain byte-identical; Jouzu does not guess or convert their encoding.

## Known limitations

- npm installation requires separately installed Node.js/npm, Git, and Bash. The unsigned Windows installer preview bundles these dependencies.
- The installer preview has native test coverage on Windows Server 2025 x64; clean Windows 10/11 qualification remains pending.
- Shisa AI access requires sign-in or an API key.
- Existing Pi `models.json` and `auth.json` require separate first-run consent; other stock Pi state is not imported.
- Catalogs need input types and context/output limits to add models. Authenticated gateway catalogs supply the provider connection; other catalogs require a configured provider with a matching API.
- Third-party Pi packages execute trusted code with the user's permissions and have their own platform support.
- `Ctrl+Enter` and `Ctrl+Up` delivery depends on terminal/OS key reporting; both semantic bindings remain user-customizable.
- npm release checks cover Linux, macOS, and Windows, including native dependencies, installs, browser first use, and updater rollback. Installer qualification is separate.

## Development

From a source checkout, with Bash, Git, npm, Node.js >=22.19.0, and Go available on `PATH`. The build selects the exact Go toolchain recorded in `upstream/textguard/source.lock.json` and downloads it if needed:

```bash
npm run dev:setup                     # install locked dependencies, check, build, and smoke-test
node packages/cli/dist/cli.js         # run this local copy without changing global commands
npm run dev:link                      # optional: replace global jz/jouzu links with this checkout
```

The helper installs dependencies with lifecycle scripts disabled and repeats installation when manifests, lockfiles, or pinned patch inputs change. Concurrent builds in one clone serialize on a lock in the Git directory, so two of them cannot replace each other's dependency trees, and the release-bundle install repeats only when its manifest, lockfile, bundle scripts, or pinned patch inputs change. Builds record UTC build time, Git commit, and dirty-worktree state. `--version` displays an identifier such as `0.1.7-dev.20260905-010203+g215b2188`; `.dirty` marks uncommitted files. The offline startup check uses isolated temporary state with a 60-second deadline on Windows and 15 seconds elsewhere. No provider key is required.

On Windows, close Jouzu sessions and test processes using this checkout before rebuilding: Windows locks loaded native modules, which prevents npm from replacing them. Archive extraction uses Windows' built-in `tar.exe`. The full `npm test` suite also requires `uv` and Python >=3.10.

`dev:setup` does not change command links or install Git hooks. If global commands already point to this checkout, rebuilding updates the code they run. To opt in to automatic rebuilds after Git operations:

```bash
./dev-build.sh install-hooks
./dev-build.sh uninstall-hooks        # remove only this helper's hooks
```

Hooks build without linking, preserve unmanaged hooks, and report build failures without failing Git. They apply only to the checkout that installed them. Set `JOUZU_REPO` to select another local checkout; the helper never clones or publishes.

The helper and its hermetic `npm run test:dev-build` suite are tested on Linux; the suite additionally requires Python 3. For Windows without Bash, use `npm ci --ignore-scripts`, `npm run build:dev`, and `node packages/cli/dist/cli.js`; global linking remains an explicit `npm link --workspace packages/cli --ignore-scripts` step. Native Windows and macOS helper qualification remains separate.

Run `npm run release:check` for the full release gate. The standard `npm run build` removes development metadata before packing a release artifact.

See [docs/architecture.md](https://github.com/shisa-ai/jouzu/blob/main/docs/architecture.md) for the module map, state-file
ownership, update lanes, and bundled profile boundaries.
[docs/ux.md](https://github.com/shisa-ai/jouzu/blob/main/docs/ux.md) defines the interaction model for every Jouzu surface,
[docs/key-collisions.md](https://github.com/shisa-ai/jouzu/blob/main/docs/key-collisions.md) maps higher-layer shortcut conflicts,
and [docs/palette-ux.md](https://github.com/shisa-ai/jouzu/blob/main/docs/palette-ux.md) adds the Palette standards. [Pi update review](https://github.com/shisa-ai/jouzu/blob/main/docs/PI-UPDATES.md)
records the candidate checklist, compatibility findings, and reverse-chronological update log.

[docs/testing.md](https://github.com/shisa-ai/jouzu/blob/main/docs/testing.md) lists the deterministic suites, session flow control tests, and the opt-in live provider smokes.

## License

Apache-2.0. See [LICENSE](https://github.com/shisa-ai/jouzu/blob/main/LICENSE).
