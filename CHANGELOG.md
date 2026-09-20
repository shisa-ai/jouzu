# Changelog

## Unreleased

### Added

- Open Settings on a **Shisa AI** row above the catalog list. It reports the connected organization and the dashboard for the gateway that issued the sign-in, signs in through the same device flow as `/login shisa` without leaving the panel, and signs out after a confirmation. Signed out, the row carries the signup credits.
- Wait for an exact subagent run or a newly created schedule through copyable `agent_wait` receipts. Subagent waits observe terminal outcomes; schedule waits observe only the first trigger, not completion of the scheduled work. Both support deadline wake-ups without polling.
- Open `/about` for running and installed Jouzu builds, Pi version, and startup time. `/session` includes a compact runtime line; `/about` stays available while flow work is held without releasing the hold.

- Leave an end-of-run summary card after every measured run, goal, and loop run that finishes, stops, or is paused. It reports the outcome, the objective, the local start and finish times, wall-clock elapsed against active agent time, and the step, turn, tool-call, and token counters, and it names the command that resumes a run that has not finished. A measured run's card also reports the metric it reached against its baseline and how its last iteration was accepted. The card is a session entry: it stays in the transcript and does not enter model context. A host without entry rendering shows it as a notification.

### Changed

- Upgrade embedded Pi from 0.85.1 to 0.86.0. Preserve system instructions independently of cancelled user input, verify compacted summaries by message role, and use Pi's packaged native clipboard helpers. Default prompt-cache warming to `off`; explicit `streaming` and `idle` choices remain available in `/settings`.
- Prepare an editable Jouzu issue draft with `/bug`, without automatic transcript collection or attachments. Always show the GitHub issue form link; offer submission as the verified `gh` account only after review and explicit confirmation. See [Report a Jouzu bug](docs/bug-reporting.md).
- Tell agents to prefer completion notifications and bounded waits over sleeping, repeated status calls, or scheduled check-ins. Waits use the current invocation when `work` is omitted.
- Limit model-picker history to 512 projects and 16 MiB, evicting least recently dispatched histories while preserving explicit defaults, favorites, and reasoning preferences.
- Use the embedded TextGuard scanner exclusively. The optional Python comparison-scanner flags from v0.1.13 are removed; native scanning modes and approvals remain.
- State what a Shisa AI account provides in the first-launch offer: open coding models such as Qwen and GLM, $10 in credits for a new signup, and $25 more when a credit card is attached. Each line carries a `◆` marker, so a pipe, `NO_COLOR`, and `TERM=dumb` keep the same shape. The default answer stays `N`, and the prompt names `/login shisa` for connecting later.

- Show when each background task finished in the completion receipt. The expanded heading carries the span from the first start to the last finish, and each task row carries its duration and local finish time. A receipt written before this change still renders, without timing.
- Stopping or pausing a run no longer repeats the same sentence as a notification, because the summary card carries it.

### Fixed

- Preserve incomplete Shisa sign-in confirmation warnings, distinguish environment-key connections from saved account identities, and avoid presenting signup offers as balances. Settings sign-in refreshes catalogs and model availability in the same session. The account row scrolls with the catalog pane, and expanded catalogs take priority over extra source rows.
- Give prompt-cache refreshes separate request checks without consuming conversational input. Include successful child refresh usage in parent totals and copy the global warming mode into new and resumed child runs. See [Prompt-cache warming](docs/cache-warming.md) for settings and limits.
- Allow a task to wait on a background job started by its parent invocation without transferring job ownership or allowing sibling-task access.
- Resolve terminal execution evidence before checking live health policies, so completion between launch and wait registration does not invalidate a copied receipt. Rejected wait declarations explain recovery and leave no new subscription behind.
- Require registered launch receipts for subagent and schedule waits. Unreadable retained producer state keeps automatic work held while allowing session reopening and `/flow` inspection.
- Bound empty request-history records during continuous tool runs, including after compaction, rather than waiting for an idle turn. Preserve records needed by live input, projections, waits, and retries.
- Keep tool results intact when a cancelled run never reached their content check, and omit message-less sessions from the resume list.
- Disable SQLite journaling on held process-lock connections and verify that acquisition, contention, and release leave the lock database empty with no journal sidecars.

- Report subagent lock storage failures instead of queueing indefinitely. A failed lock release marks affected work failed and requires a restart; it no longer disappears during run finalization or shutdown.

- Hold the subagent session lock and each workspace-writer lock for as long as the owning process runs, instead of leaving a record file that a later process ages out and reclaims. A Jouzu process that exits for any reason, including a kill, releases its locks immediately, so a stopped process no longer blocks a session or leaves a workspace writer queued, while a suspended process keeps its lock. A lock file left behind by an earlier run no longer blocks a new owner, and the five-second recovery grace period is gone. A Jouzu process running a version from before this change does not share these locks, so close other Jouzu processes before upgrading and start them again afterward.

### Development

- Refresh installed dependency trees when pinned patch inputs change, and include release-metadata checks in the ordinary check gate.
- Test task-continuation timing through the installed adapter without a separate source checkout. CI uses a four-minute per-file test bound and finite suite deadlines.
- Keep the root and npm README copies synchronized and clarify the Python package's non-functional reservation status.

### Testing limits

- Pi 0.86.0 passed local Linux qualification. Parent refresh admission, cancellation, and child warming settings/accounting pass loopback tests. Native macOS/Windows and live-provider cache hits, retention, and savings require separate checks.

## 0.1.13 - 2026-09-19

### Added

- Turn flow control off and on for a session with `/flow off` and `/flow on`. While it is off, what you send runs as an ordinary turn, and jobs, tasks, and loops deliver their own notifications instead of flow control composing them. The session, its records, and every running job are kept, and producer tools keep their own delivery paths.
- Resume a recent conversation branch by returning to it. Its unfinished work comes back with it, including a wait on a background job, and a retained late result stays readable. Restart rebinds to the branch that owns the newest transcript entry; a rewind inside the active branch still starts a new branch with nothing inherited.

### Changed

- Stop the Camoufox browser after five minutes without a browser tool call and relaunch it on the next call, so a long session no longer keeps an idle Firefox resident. Set `JOUZU_CAMOUFOX_IDLE_STOP_MS` to a whole number of milliseconds from 1000 to 2147483647 to change the delay, or `0` to keep the browser loaded until the session ends; an invalid value keeps the browser tools from loading until it is fixed.

### Fixed

- Retire completed, cancelled, and archived flow work into indexed history. A long session no longer accumulates unbounded active records, retained evidence stays readable after retirement, and routine reads query exact records instead of scanning bounded windows.
- Keep retired result history outside the active manifest quota, keep retired wait history out of active state limits, and backfill result trigger indexes from archived attempts, so archived work stops pinning active reads.
- Retire explicitly reset native requests that never reached an outcome, retire a completed retry chain as one group, and keep cancellation checks in force after a request is retired.
- Preserve producer rounds across nonprefix retirement, and recheck retirement authorization before the ledger commits.
- Bound the branch registry by its byte budget instead of its record count, so many small branches cannot grow the registry past its limit.
- Give automated turns host work when no producer owns them, so their tools run instead of being refused.
- Recover an interrupted branch transition by rebinding to the branch that owns the leaf instead of holding the session, and fence controller revocation while queue maintenance runs.

### Installation

- A failed Windows installation now names the stage that failed, the launcher error, and the automatic setup log path, and each activation check allows 90 seconds instead of 30. The unsigned x64 installer preview includes this release's CLI changes.

### Testing limits

- Flow retention and indexing changes are covered by component tests with controlled fixtures; long-session behavior under live provider traffic is not measured.
- Native Windows installer acceptance covers Windows Server 2025 x64. Clean Windows 10/11 testing remains pending, and the installer is unsigned.

## 0.1.12 - 2026-09-17

### Added

- Control subagents per session with `/workflow on`, `/workflow off`, `/workflow toggle`, or the Workflow On/Off control. Disabling stops running and queued children without undoing their file changes; retained results remain readable.
- Include the `jouzu-delegation` skill in Core and JA, with assignment and follow-up examples. Give every parent model a short checklist for objectives, verified context, constraints, acceptance checks, and stopping points while subagents are enabled.
- Show goal, loop, and child-agent activity on the Session Line, with an animated marker while work runs and lifecycle counts. Keep workspace, Git, runtime, and context information in the Status Bar.

### Changed

- Reserve subagent model selection for the user. The agent-facing tool rejects model overrides; new launches use the configured role model and resumes keep their saved model and definition. Change role models through Workflow.
- Display friendly subagent model names and readable activity/output previews while retaining exact model identifiers and original paged output.
- Resolve a sole saved goal directly with `/goal resume`; route ambiguous targets to the agent and deliver explicit resumes through flow control.

### Fixed

- Fix archiving multiloops on Windows by creating only the archive parent directory before moving the run.
- Reconnect tasks and multiloops after conversation-tree navigation, preserving saved tasks while discarding abandoned scheduling state.
- Reconcile unread child completions after tree navigation. Require successful model-input receipts before complete terminal reads suppress a completion notification.
- Prepare missing tool results as explicit unknown outcomes before ordinary and automatic model requests and built-in summaries. Preserve saved transcripts and tool side effects; reject ambiguous or mismatched tool results.
- Refresh authenticated catalogs without an activated revision before initial model selection, with an eight-second budget. Keep cached catalog refreshes in the background and tolerate malformed catalog configuration during startup.

### Installation

- Document the Windows installer's `/LOG` flag for diagnosing failed activation. The unsigned x64 installer preview includes this release's CLI changes.

### Testing limits

- Automated tests verify delegation guidance delivery, not model compliance or improved task performance. Flow and catalog regression tests use controlled fixtures; live-provider recovery across branches remains unverified.
- Native Windows installer acceptance covers Windows Server 2025 x64. Clean Windows 10/11 testing remains pending.

## 0.1.11 - 2026-09-16

### Added

- Check GitHub Releases daily from the Windows working-folder screen and show a download link for newer stable x64 installers.

- List running and paused goals with `/goal`, and pause, stop, or resume one with `/goal pause`, `/goal stop`, or `/goal resume`, optionally followed by a `lane/run-tag`. Without a target, the command selects the attached goal or the only matching goal; `/multiloop` shows all runs.
- Show the selected working folder in the Windows launcher before it opens a terminal, with an option to remember it for later launches. If the saved folder is unavailable, the launcher asks for another folder instead of opening a different one. The launchers and installer use a transparent JZ icon. See [Windows installer preview](packaging/windows/README.md).
- Report catalog access failures with the cause and the action to take: DNS resolution, connection, timeout, proxy authentication, HTTP 401, 403, or 407, certificate verification, or local catalog-data access. The first refresh failure is retained until a refresh succeeds, and `catalog status` reports it as `Last error` with the overall status degraded.

### Changed

- Explain held flow work in `/flow`: the submitted source, the stage that failed, the owning task and its dependencies, and the original failure cause after a reset.
- Render `batch_web_fetch` as one row per requested URL with its queued, fetching, done, or error status, elapsed time, and extracted size, instead of one summary line.

### Fixed

- Shorten Windows installer activation by checking startup files and the CLI instead of hashing the entire payload. Show an animated progress bar and the active step after extraction. Keep full diagnostic verification available through `JouzuConsole.exe --verify`, with file-count progress.

- Continue automatic work across mid-run compaction, including compaction that keeps no original transcript tail. Recovery verifies the compaction boundary and earlier delivery instead of replaying input, and settles the terminal response from history when the active summary covers it.
- Keep the continuation instruction in model context so a requested compaction continuation is admitted instead of rejected.
- Keep `/flow` inspection and reset usable while work is held: report released holds, retain the original admission error and request receipts across a reset, and defer competing idle dispatches.
- Return task tool authority to the invoking work after a task completes automatically, and allow task inspection without granting authority to the completed task.
- Authenticate catalog models with the saved Shisa login, so `/login shisa` alone supplies the account's models without an environment key or a separate catalog token.

### Testing limits

- Flow recovery and compaction changes are covered by assembled-session and unit tests. No live provider session has been resumed against the rebuilt implementation.
- Native Windows Server 2025 tests cover launcher behavior, update discovery, activation checks, and progress visibility. Clean Windows 10/11 testing, visual scaling, desktop proxy authentication, and live model access remain unverified.
- Catalog login and failure diagnostics are covered by tests with environment keys unset and by a loopback HTTP fixture; no live gateway or paid model request was made.

## 0.1.10 - 2026-09-15

### Added

- Add an unsigned Windows installer preview with per-user installation, bundled Node.js/npm, Git Bash, Windows Terminal, ripgrep, and fd. Desktop and Start menu shortcuts open a project-folder picker and Jouzu setup. Installation verifies the payload before activation, supports rollback, and preserves user data outside the installation directory on uninstall. See [Windows installer preview](packaging/windows/README.md).
- Inspect the loaded flow runtime with `/flow runtime`, including build and extension identity, and warn when a rebuild requires restarting the session.

### Changed

- Start resumed interactive sessions with automatic turns paused. Your next message or `/flow resume` releases the pause; inspecting `/flow` leaves it paused.
- Render flow wakes as readable wait and result summaries, with the full envelope available on expansion. Present structured wait and result content to the model without nested JSON serialization while preserving receipts and source bytes.
- Explain how task continuations, background completion notifications, and dependency waits work together in agent guidance. Encourage waiting for completion instead of repeated polling.

### Fixed

- Stop the full background process tree on Windows so child processes do not survive task cancellation or session shutdown. Ignore late completion notifications after their flow controller closes.
- Return rendered page bodies and the full search result list to the model. Mark truncated pages, empty searches, and searches that reach the requested result limit.
- Attach browser screenshots to tool results, default screenshot requests to JPEG, and report images over 1 MiB with size-reduction instructions.
- Recover flow admission after compaction, interrupted requests, and sustained use exhaust retained history. Preserve pending user input and results through cancellation and recovery, and keep `/flow reset` usable for recoverable retained state.
- Reopen oversized flow journals by checkpointing retained state without loading the entire journal into one string.
- Bind task continuations and wait-decision turns to their owning work so authorized background and wait tools remain usable. Respect task holds and reject stale continuations.
- Recheck quiet background processes through producer snapshots. Keep health decisions on the affected wait so later waits and completion results remain usable; repair older execution health records on reattachment.
- Preserve top-level reasoning-token usage reported by compatible providers.

### Testing limits

- Completed live flow probes found no new session lockups or input/result-loss defects after the repairs; some scenarios remain unverified. Cross-turn management of another work's wait remains restricted; users can cancel a wait with `/flow cancel <token>`.
- The Windows installer is an unsigned preview distributed through GitHub Releases. Native build and acceptance testing covers Windows Server 2025 x64. Clean Windows 10/11 testing remains pending; code signing is planned for v0.2.0.

## 0.1.9 - 2026-09-13

### Added

- Offer Shisa account signup or sign-in during interactive first-launch setup, with signup-credit eligibility explained. The choice is saved; skipping leaves `/login shisa` available later. Configured Shisa credentials suppress the offer.
- Sign in to Shisa with `/login shisa`. Jouzu saves a dedicated API key for inference, the Shisa model catalog, and voice. `/logout shisa` and Shisa in `/logout` attempt server revocation, then remove the local credentials and device link. Unconfirmed revocation includes dashboard disconnect instructions.
- Coordinate automatic turns with session flow control, enabled by default. Completions wait for active work and queued messages, then arrive in batches. Waits have deadlines and can check background-process health. Use `/flow` to inspect held work, pause or resume automation, retry withheld requests, and resolve interrupted turns. Set `JOUZU_FLOW_CONTROL=0` to disable it for a session.
- Save catalog bearer tokens in Settings / Catalogs with private file permissions. Environment variables take precedence. Sources with missing credentials can be saved and configured later; removing a source or disabling its authentication removes its saved token.
- Set **Maximum context** in Settings / Catalogs to lower model context windows. Compaction, context usage, and model-switch checks use the ceiling. An explicit local `modelOverrides.contextWindow` takes precedence; turning the ceiling off restores declared windows.
- Diagnose incomplete catalogs with `jz doctor` and `jz catalog status`: report missing fields needed to add models and undeclared thinking levels that limit reasoning controls.

### Changed

- Advance task lists through their remaining work by default unless interrupted. Reorder tasks with `TaskReorder`; `TaskList` shows the run order and next task.
- Deliver flagged web results with TextGuard findings and instructions to treat the content as untrusted data. Flagged skills still require approval. `/textguard strict` withholds all flagged input; `/textguard off` disables scanning for the session. Child agents inherit the parent's mode.
- Review TextGuard decisions in a scrollable list with finding locations and escaped content. `/textguard reports` shows informational and warning reports. **Always allow this exact content** saves approval across restarts; changed content, scanner, or policy requires another decision. Interrupted checks can also be approved when the full content was captured.
- Pause automatic turns after an interrupt; your next message or `/flow resume` releases the pause. `/flow reset` repairs a stuck session when idle without stopping background jobs or deleting its execution records.
- Limit retained flow-control history while preserving the records needed to explain held work.
- Use declared catalog thinking levels and defaults while preserving explicit per-model preferences. Ignore unknown level names so newer catalogs still load.
- Accept the saved Shisa login for voice, including its speech endpoint. `SHISA_API_KEY` takes precedence. Logout cancels recording and suppresses Shisa access in that process until sign-in, leaving environment variables unchanged.
- Show diagnostics and configuration plans with consistent headings, aligned values, and problems listed first. Status remains readable without color.
- Give child agents the parent's model-specific guidance and allow a per-run `model` override, including `same` for the parent's model.

### Fixed

- Save Shisa credentials and link state before acknowledging delivery. Failed storage leaves delivery unconfirmed; failed acknowledgement retries ask you to sign in again.
- Preserve the prompt editor and flow control when replacing a session, and keep queued user messages pending after an interrupted turn.
- Retain unread background-task summaries after clearing a task, and stop reporting delivered input as held.
- Keep flow recovery available after interrupted or partially recorded requests, and release goal work after local commands finish.
- Serialize Camoufox fetch and search calls so concurrent calls cannot close each other's pages.
- Show a failed child run's provider error. Require a full `provider/model` when a model name matches multiple providers.
- Let an RPC session finish an accepted prompt after end-of-input, and preserve machine-readable Pi output byte for byte.

### Development

- Serialize source builds, reuse an unchanged extension bundle, check Go before building, and use Windows' built-in `tar.exe` for archive extraction.

### Testing limits

- Flow-control tests substitute providers; live-workload qualification remains separate. Shisa login/revocation and voice still need live-service, microphone, and platform-permission checks. See [Testing](https://github.com/shisa-ai/jouzu/blob/main/docs/testing.md).

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
