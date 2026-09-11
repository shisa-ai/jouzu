# Changelog

## 0.1.9 - unreleased

### Added

- Session flow control is on by default. It gives one place to see and control the automatic turns a session produces. Background-task completions and goals and measured loops register with it, so a completion that arrives while the agent is working waits until the current turn and any queued messages finish instead of interrupting, and completions that are ready together are delivered in one turn. Waits have a deadline, and a running background task reports whether its process is still alive. Other automatic sources — child agents, scheduled prompts, and task-list advances — are held while a wait is live. Set `JOUZU_FLOW_CONTROL=0` to run a session without it.
- Inspect and repair held work with `/flow`. The command lists what is held, what is waiting, and which work can still take automatic turns, with the reason and any deadline for each. It writes to the terminal only and adds nothing to the model's context.
  - `/flow retry <request>` re-sends one request whose input was withheld.
  - `/flow cancel <token>` cancels a wait without stopping the job it was watching.
  - `/flow pause <work>` and `/flow resume <work>` hold and release the automatic turns of the named work, such as a running goal or measured loop.
  - `/flow stop <work>` retires the named work and ends its waits. A job it already started keeps running.
  - `/flow resolve <attempt> retry|discard` decides a turn that was interrupted before its outcome was recorded, when Jouzu cannot tell whether the provider answered it.
- Save a catalog bearer token in Settings / Catalogs without exporting an environment variable. The token is stored in `catalog-credentials.json` next to `catalogs.json` with private file permissions, keyed to its source, and never shown on screen; the environment variable still takes precedence. A bearer source whose variable is unset can be saved with a warning in the source list and detail, stored without contacting it, and refreshed once the variable is set or a token is saved. Removing a source, or switching it to no authentication, removes its saved token.

### Changed

- TextGuard review is one screen: a scrollable list of withheld items and reports, and a detail view with findings, locations, and the flagged content shown with control and invisible characters escaped. Only content-blocking findings interrupt the session; warnings and informational reports stay inspectable through `/textguard` and can be dismissed for the session. **Always allow this exact content** records an approval for those exact bytes that survives restarts and is rechecked when the content, scanner, or policy changes.
- Long-running automated sessions stay within bounded storage: finished results, settled attempts, and superseded history are retired under fixed limits, while the evidence needed to explain a hold is kept.
- Child agents receive the same model-specific behavior guidance as the parent session.

### Fixed

- Keep a background task's unread result summary after the task is cleared.
- Stop `/flow` from reporting input that was already delivered as held.
- Let an RPC session finish an accepted prompt when its input stream ends.

### Testing limits

- Session flow control is newly on by default. Its behavior under real workloads still needs dogfooding; the deterministic suite substitutes the provider, and the live smoke is opt-in.

## 0.1.8 - 2026-09-07

### Added

- Scan skills and web results locally with bundled TextGuard, enabled by default without a separate Python installation. Use `/textguard` to review withheld content and approve it for the current session. The review lists viewing the flagged content first, shows the exact body with its fingerprint, and explains each finding in plain language. `--jouzu-textguard-files` also checks ordinary file reads, including child-agent reads. Scanning does not establish that content is safe.
- Dictate into the prompt with `/voice`. See live transcription while recording, then use `/voice stop` to insert final text for editing. Missing speech is marked `[garbled]`; the prompt is never sent automatically. Requires `SHISA_API_KEY` with realtime speech access. Audio goes to Shisa; Jouzu writes no recording files.
- Build a source checkout with `npm run dev:setup`. Global linking through `npm run dev:link` and automatic rebuild hooks are opt-in.

### Changed

- Remember your reasoning-level override for each model. Without an override, use the catalog's default reasoning level, then the configured global default. Explicit startup settings and resumed-session settings retain precedence.
- Batch unread background-task and child-agent completions after active work and queued messages finish. Results the agent has already read do not trigger another completion response. The agent can acknowledge a delivered batch with **No reply needed** without generating another response.
- Show child runs with themed status, model, assignment, and outcome summaries instead of raw JSON. Expanded output includes usage and review details; completion does not mean the work was approved.
- Let child agents use a chosen working directory and read sibling repositories with their enabled tools. The working directory is not a filesystem sandbox. Review identity checks cover the selected checkout, not every repository mentioned in an assignment.
- Raise default child limits to 500 turns and two hours. Saved role settings and active runs keep their existing limits.
- Align Palette tabs, Workflow and Settings rows, selection highlights, and status colors. Allow plain-HTTP catalog sources with a warning that authentication tokens are sent unencrypted.

### Fixed

- Deliver child completion and queued-cancellation notifications across parent turns, and retain unread completion records across reloads.
- Preserve line breaks in child output and separate run details from their actions in Workflow.
- Bound skill discovery reads, directory iteration, and inventory size before parsing, so an oversized or hostile skill directory cannot consume unbounded work; discovery fails closed with an explicit diagnostic.
- Keep Catalogs selections, transport warnings, forms, and messages within the visible overlay on short terminals; page long failure text and expanded model lists contiguously.
- Build declared Git dependencies and prepare native TextGuard checks during source setup.

### Testing limits

- Voice microphone permissions, device behavior, and transcription quality still need live testing. Over SSH, capture uses the microphone on the machine running Jouzu.

## 0.1.7 - 2026-09-05

### Added

- Configure agent roles, models, and instructions in `/workflow`. Launch child agents, read their output, send follow-ups, stop them, and resume saved runs. Read-only reviewers report whether the workspace changed during review.
- Add catalog models to configured providers and apply names, capabilities, and token limits to active sessions without rewriting `models.json`.
- Add optional TextGuard scanning for skills and web results. It requires a separate TextGuard 1.0.0 installation and is off by default.

### Changed

- Upgrade Pi from 0.84.4 to 0.85.1 and use Pi WebAIO for readable web fetches.
- Install the Camoufox client and browser on first rendered fetch or search, rather than bundling the client in every npm install. `jz doctor` reports its installation state.
- Reduce packaged dependency files and index catalog lookups to reduce installation and model-picker work.
- Preserve useful document structure and sound wording in the Clear Writing skill.

### Fixed

- Include cross-platform clipboard bindings, select the web transport for the installed platform, and use SQLite prebuilt binaries instead of requiring a C++ compiler.
- Keep updates, help, and diagnostics available when interactive runtime imports fail.
- Preserve Jouzu terminal titles and explicit thinking settings; suppress automatic upstream release-note banners.
- Fix catalog cancellation, timeouts, response limits, activation, cache retention, and per-source error handling.
- Use public absolute documentation links in the npm README.

### Release checks

- Require Linux, macOS, and Windows qualification, including a published v0.1.6 upgrade to the candidate, restart, and rollback.
- Publish the exact tested npm tarball and attach the same package, checksums, and manifest to GitHub Releases. Verify registry signatures, provenance, and package bytes before reporting completion.

## 0.1.6 - 2026-09-03

- Publish the complete repository README on npm instead of the condensed package copy, and require byte-identical root, package, and packed README content before release.
- Keep the v0.1.5 runtime and exact Pi 0.84.4 dependency unchanged. Qualify this documentation release on Linux and macOS with Node 22 and 24; Windows release qualification is paused while package size and updater rollback time are reduced.

## 0.1.5 - 2026-09-03

- Add a built-in `shisa-api` catalog source: when `SHISA_API_KEY` holds a bearer token, Jouzu reads the account's model catalog from the deployed Shisa endpoint with no source configuration, refreshes each enabled source with an available credential in the background at interactive startup, and keeps serving cached catalogs. The token is sent only as the source's authorization header, is never written to configuration, cache, or diagnostics, and authenticated refresh never follows redirects. Without the key and without a configured source, Jouzu makes no catalog request. A manual registration with the same endpoint and credential reference keeps its label, enabled state, and cache; the built-in source can be disabled in Settings / Catalogs without storing a credential.
- Manage multiple catalog sources in Settings / Catalogs (`/catalogs`): add, edit, enable/disable, refresh, and remove named sources with per-source ETag validation, account-partitioned cache, mass-change quarantine, and last-known-good retention. `jouzu catalog status|refresh [source-id]` and `jouzu catalog accept REVISION --digest SHA256 --source SOURCE_ID` provide CLI parity; `JOUZU_MODEL_CATALOG_URL` and `JOUZU_MODEL_CATALOG_TOKEN` remain a single-source shorthand when `catalogs.json` is absent.
- Move the goal surface into `pi-multiloop` 0.4.0 and drop the separate `@lhl/pi-goal` package. `/goal`, `get_goal`, and `update_goal` work as before and now come from the same package as `/multiloop`, so a goal is listable and resumable alongside measured runs. Existing goals from 0.1.4 remain readable. The bundle falls from ten release-owned extensions and two package skills to nine and one. A separately installed `@lhl/pi-goal` copy now conflicts with the release-owned goal tools; the load error identifies the copy and points to `jz config` to disable or remove it.
- `/goal <objective>` starts immediately: it derives its own lane, mode, and scope instead of asking setup questions. `/multiloop` reaches a measured launch on one approval rather than a clarification round.
- Report elapsed time, turns, tool calls, and token totals per run in `/goal` and `/multiloop status`. These counters are no longer written into the model's context, where a running total read as a context-window gauge and could cut work short.
- Let the agent ask for context compaction with `compact_context`. The request runs after the current turn ends, uses the bundled pi-vcc compactor, and leaves earlier messages searchable through `vcc_recall`.
- Restore the last dispatched model and its thinking level in a new session, after an explicit `--model`, a resumed session's recorded model, and the project default. Recency updates only after the selected model dispatches its first request.
- Compare model-switch context fit against a 4,096-token safety margin instead of the model's maximum output cap, and offer confirmed compaction before switching to a model whose context is too small.
- Show Models and Settings as top-level Palette sections with `Tab`/`Shift+Tab` moving between them. In Models, `←` and `→` change the Recent, Favorite, or All view, typing or `/` focuses search, a non-empty query ranks the full model inventory from every view, and `Esc` returns to browsing with the query intact before another `Esc` closes the Palette.
- Toggle a Models favorite with `Ctrl+F`, replacing the `Shift+Enter` and `Ctrl+Shift+S` accelerators. `Ctrl+F` reaches the application as a plain control byte, so favoriting no longer depends on the terminal reporting a modified Enter: a terminal that sent an unrecognized `Shift+Enter` did nothing, and one configured to send a bare newline selected a model instead of favoriting it. Inside the Models search field `Ctrl+F` takes precedence over cursor-right, where `→` remains available. Rebind through `jouzu.model.toggleFavorite` in `keybindings.json`.
- Start without Smart Fetch or Camoufox tools when their native bindings cannot load: Jouzu displays a warning and `jz doctor` lists the disabled tools, reports the underlying error, and exits with status 1. The selected native bindings support glibc 2.28 or newer.
- Qualify the bundled extension set on Linux, macOS, and Windows with Node 22 and 24.

## 0.1.4 - 2026-08-27

- Bundle ten release-owned Pi extensions for scheduling, background processes, readable and rendered web access, code previews, tasks, goals, measured loops, context recall, and skill discovery, plus the `pi-goal` and `multiloop` package skills. Matching user-configured copies are suppressed without changing user settings; unrelated Pi packages remain user-managed.
- Add the optional model catalog and `jouzu catalog status|refresh|accept|validate|conformance` commands, with strict duplicate-key and credential rejection, bounded streaming refresh, account-partitioned private cache, ETag validation, mass-change quarantine, and last-known-good retention.
- Add separate opt-in first-run imports for stock Pi `models.json` and `auth.json`; both default to no, preserve source and destination files, and record a local receipt.
- Restore the last Models filter used when the picker opens again.
- Keep queued model switches responsive during active calls, advance repeated `Ctrl+P` presses through queued favorites, and avoid floating Palette overlays on terminals that render inline images above text.
- Preserve JSON `__proto__` as an own property during catalog validation, report picker-state and cached-catalog warnings independently, cap response bodies while streaming, and make model-picker tests independent of the developer's terminal.
- Default isolated Jouzu settings to quiet startup while preserving explicit settings and `--verbose` resource output.
- Route pi-vcc configuration to Jouzu's isolated agent root.
- Add on-demand Clear Writing and database-free Source Check skills to the Core and JA profiles.
- Expand Clear Writing to cover drafting, revision, audit, documentation structure, terminology, and accessibility; point Pi's default system prompt to it while preserving custom prompts.
- Group Core capability selection for session recall, web research, finite tasks, goals, measured loops, background processes, and scheduled prompts; add an untrusted-web rule and routing evaluation corpus.
- Keep current-state skills and documentation focused on active capabilities; reserve prior-component references for versioned release and migration records.
- Qualify the bundled extension set on Linux and macOS. Native Windows qualification remains pending; v0.1.3 is the last release qualified by the full Windows matrix.

## 0.1.3 - 2026-08-26

- Route `/model` and `Ctrl+L` through the Jouzu Models view when slash autocomplete is visible and when Pi copies its stock handlers directly into the Prompt Frame.
- Refresh Pi's effective model inventory when the Models view opens; retain cached models with an in-view warning when refresh fails or times out.
- Use one global favorites list: `Ctrl+F` toggles membership, while `Ctrl+P` and its reverse binding cycle available favorites that fit the active context and effective model scope.
- Remove project favorites, `Alt+F`, and `/scoped-models` from Jouzu's interactive surface. Explicit and configured Pi model scopes continue to constrain the usable inventory.

## 0.1.2 - 2026-08-25

- Add the Jouzu Palette Models view on `/model` and `Ctrl+L`, with Recent/Favorite/All filters, result counts, exact provider/model search, current and previous choices, global favorites, project/global recents, session-only selection, user-local project defaults, documented startup precedence, context-fit blocking, and floating/replacement presentations.
- Add `Ctrl+/` and `Ctrl+?` Jouzu help shortcuts and show the model/help shortcuts in the Session Line.
- Preserve open editor autocomplete behavior before application-level key handling.
- Add the built-in Jouzu Prompt Frame, Session Line, and responsive Status Bar with provider-neutral local facts and CJK/ANSI-safe width degradation.
- Match the retained Session UI color baseline through Jouzu-owned semantic style roles, with a bright Jouzu-cyan Prompt Frame rail that can be replaced by a future global theme.
- Add a public Pi candidate checklist and reverse-chronological update log, including fail-closed v0.84.3 provenance and host-seam findings.
- Preserve project-default activation, failed-selection persistence boundaries, and replacement-editor cursor/paste state; sanitize model labels and render Jouzu RGB roles through the terminal's truecolor, 256-color, 16-color, or no-color mode.
- Identify linked development builds by UTC build time, source commit, and dirty-worktree state without changing the published package version.
- Add experimental `jouzu doctor --json` schema 1 with machine-readable fields and issues; its structure and identifiers may change before v0.3/v0.4.
- Style the Palette through the same Jouzu semantic color roles as the Session UI, so one terminal color policy covers every Jouzu-owned surface.

## 0.1.1 - 2026-08-23

- Change the queued follow-up shortcut from `Tab` to `Ctrl+Enter`, leaving `Tab` available for Pi editor autocomplete.
- Back up and migrate only the exact v0.1.0 `Tab` binding recorded as Jouzu-owned; preserve user-owned and modified bindings.

## 0.1.0 - 2026-08-20

- Launch exact, qualified Pi 0.84.2 through the `jouzu` and `jz` commands while preserving Pi CLI modes and blocking independent Pi runtime self-update drift.
- Automatically update eligible global npm installations before interactive startup by default, with exact-version SHA-512 verification, local rollback, installed-runtime validation, restart-loop protection, explicit status/check/apply/policy commands, and safe source/local/npx fallback.
- Isolate Jouzu configuration, authentication, packages, profiles, and sessions from stock Pi global state on Linux, macOS, and Windows, with `jz --session SESSION_ID` exit guidance that resolves Jouzu's session root.
- Add non-mutating diagnostics, an adaptive Unicode startup presentation, and a provider-neutral `/status` session summary.
- Seed Pi-compatible Jouzu keybinding defaults once (`Tab` follow-up and `Ctrl+Up` dequeue), with semantic-action planning, explicit conflict-safe apply/reset, backups, ownership receipts, user override preservation, and terminal portability diagnostics.
- Bundle a language-neutral Core fallback and optional JA preview with explicit first-run consent, deterministic manifests, dry-run plans, conflict detection, backups, atomic application, safe profile switching, and automatic pre-launch reconciliation.
- Add deterministic Japanese/CJK, encoding, path, terminal, packed-install, and exact Pi compatibility gates.
- Establish npm as the only functional v0.1 channel; PyPI remains the non-functional 0.0.1 reservation.

## 0.0.1 - 2026-08-03

- Reserve the initial Jouzu package names with minimal preview stubs.
