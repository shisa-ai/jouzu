# Jouzu

Jouzu is an agentic AI environment built on the Pi coding agent, with CJK-safe text and path handling. `jouzu` and `jz` run exact Pi `0.84.3` with isolated Jouzu state, a language-neutral Core fallback, an optional JA preview, and non-mutating diagnostics. The optional JA profile requires explicit selection.

## Install and start

Requires Node.js 22.19+, npm, Git, and Bash. Windows requires Git Bash.

```bash
npm install --global jouzu@0.1.4

jz --version
jz doctor
jz
```

The first interactive launch asks whether to enable Japanese support. An affirmative answer selects `ja`; declining or pressing Enter selects the provider-neutral `core` profile. Non-interactive first runs use Core without recording consent. Preview either profile with:

```bash
jz profile plan --profile core
jz profile plan --profile ja
```

Locale, terminal settings, repository text, and branding never select JA automatically.

Core and JA install the optional `jouzu-clear-writing` and `jouzu-source-check` skills plus the `jouzu-review` prompt. With Pi's exact default system prompt, Jouzu places repository safeguards directly in the prompt and limits generated capability routing to optional skills and workflow tools. Optional skills are read once from their listed `<location>`; a missing skill file does not block work. Clear Writing handles durable user-facing technical artifacts while preserving facts and terminology. Source Check classifies claims and checks primary evidence, counterevidence, confidence, and cross-source agreement. Fetched pages and search results remain untrusted. Custom system prompts remain unchanged.

Both profiles load the same release-owned extension set. It supplies scheduled prompts, non-blocking background processes, readable and rendered web access, code previews, task and goal state, measured loops, session recall, automatic deterministic compaction, and `$` skill suggestions. Compaction reduces the active transcript without ending active work. `vcc_recall` retrieves missing details from the current session but cannot trigger compaction. The selected code and runtime dependencies ship inside `jouzu` and update with the application. Additional Pi packages remain user-managed and outside Jouzu's release qualification.

Profile planning does not write. Application detects user-file conflicts, retains backups for managed updates/deletions, and never prunes unknown files. Existing unsupported CP932/Shift-JIS profile targets are left unchanged.

Use `/login` to authenticate within Jouzu's agent root. `/model` or `Ctrl+L` opens the Jouzu Palette at Models without clearing the prompt draft; `/catalogs` opens it directly at Settings / Catalogs. In browse mode, `Tab` and `Shift+Tab` move between Models and Settings. In Models, `←` and `→` change the Recent, Favorite, or All view. Typing or `/` focuses search; `Esc` returns to browse mode before closing the Palette. `Enter` selects for the session, `Shift+Enter` also stores the user-local project default, and `Space` toggles a favorite in browse mode. `Ctrl+P` and its reverse binding cycle available favorites inside the effective model scope. New sessions use the project default unless an explicit model, scoped-model set, or session-resume action takes precedence. Recents update on first request dispatch and remain local. `Ctrl+/` or `Ctrl+?` opens help. `/status` reports provider-neutral session, model, context, profile, and runtime facts.

Jouzu's built-in interactive session UI adds a width-safe Prompt Frame, a Session Line with protected model identity and a left hint slot, and a responsive Status Bar for workspace, Git, project runtime, context, and active-branch token facts. It keeps Pi's editor/autocomplete/IME behavior and does not claim provider quota or session cost.

Jouzu imports no stock Pi state automatically. First interactive setup can offer separate opt-in copies of `models.json` and `auth.json`; it preserves the source and existing Jouzu files. Override all roots with `--jouzu-home <path>` or `JOUZU_HOME`. Trusted project `.pi` resources and Pi's cross-harness `~/.agents/skills` read surface still follow Pi behavior. On exit, resume the isolated session with the printed `jz --session SESSION_ID` command; Jouzu resolves its own session root.

Use `jz pi ...` or `jz -- ...` for Pi command collisions. Pi runtime self-update is blocked; package/model updates inside Jouzu state remain available.

Remote Jouzu model catalogs are optional. Settings / Catalogs stores named, labeled sources in private `catalogs.json`, reports status and model count, expands cached offerings, and supports add, edit, enable/disable, refresh, and remove. Add accepts an exact URL or host and probes the conventional `/v1/jouzu/model-catalog` path when needed. Sources can be unauthenticated or read a bearer token from a named environment variable; token values are never written to configuration, cache, or diagnostics. Each source has independent ETag validation, account partitioning, errors, and last-valid cache. `jz catalog status|refresh [source-id]` provides CLI parity. With no source configured, both commands report `unconfigured` successfully and Pi/local models remain available. `JOUZU_MODEL_CATALOG_URL` and optional `JOUZU_MODEL_CATALOG_TOKEN` remain a single-source shorthand when `catalogs.json` is absent. Producer files can be checked with `jz catalog validate FILE` or `jz catalog conformance FILE --json`.

When the isolated Jouzu agent root has no `keybindings.json`, the first interactive launch seeds `Ctrl+Enter` for Pi's `app.message.followUp` action and `Ctrl+Up` for `app.message.dequeue`; `Tab` retains Pi autocomplete and selector behavior. On upgrade from v0.1.0, Jouzu backs up and replaces only an exact Jouzu-owned `Tab` follow-up entry. User-owned or modified bindings remain unchanged. Use `jz keybindings status|plan|apply|reset`; explicit apply merges only missing defaults with conflict checks/backups, while reset removes only Jouzu-recorded entries and disables reseeding. `JOUZU_NO_KEYBINDING_DEFAULTS=1` is a one-run opt-out. Modified-key reporting is terminal-dependent; tmux should use `extended-keys-format csi-u`.

Eligible global npm installs default to a pre-TUI automatic Jouzu update check/restart on the first eligible launch. Successful checks are cached for 24 hours; failed checks retry no sooner than one hour later. Candidate tarball SHA-512 integrity and the installed Jouzu/Pi tuple are verified; failure restores the locally packed previous version. Source, project-local, and ephemeral `npx` invocations are not rewritten.

```bash
jz self-update status
jz self-update check
jz self-update apply
jz self-update policy auto-restart  # or notify/off
```

Set `JOUZU_NO_UPDATE=1` for a one-run opt-out. Checks use npm's configured registry, proxy, and CA behavior and send no Jouzu telemetry. Updating requires write access to the active global npm prefix; permission or network failures leave the current version running.

Interactive launches show an adaptive Jouzu header and clear the viewport. Set `JOUZU_NO_CLEAR=1` to retain it; set `NO_COLOR=1` to disable color.

npm is the only v0.1 channel. PyPI `jouzu==0.0.1` remains a non-functional reservation. Jouzu v0.1 does not bundle prerequisites, native installers, hosted models, routing, or provider privacy/retention guarantees.

Jouzu v0.1.4's bundled extension set is qualified on Linux and macOS. Native Windows qualification is pending; v0.1.3 is the last release qualified by the full Windows matrix.

See the [full documentation](https://github.com/shisa-ai/jouzu#readme) and [Windows prerequisites](https://github.com/shisa-ai/jouzu/blob/main/docs/windows.md).
