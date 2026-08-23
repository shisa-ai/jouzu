# Jouzu

Jouzu is an agentic AI environment built on the Pi coding agent, with CJK-safe text and path handling. `jouzu` and `jz` run exact Pi `0.84.2` with isolated Jouzu state, a language-neutral Core fallback, an optional JA preview, and non-mutating diagnostics. Japanese support is optional and first-class.

## Install and start

Requires Node.js 22.19+, npm, Git, and Bash. Windows requires Git Bash.

```bash
npm install --global jouzu@0.1.1

jz --version
jz doctor
jz
```

The first interactive launch asks whether to enable Japanese support. An affirmative answer selects `ja`; declining or pressing Enter selects the provider-neutral `core` profile. Non-interactive first runs safely use Core without recording consent. Preview either profile with:

```bash
jz profile plan --profile core
jz profile plan --profile ja
```

Locale, terminal settings, repository text, and branding never select JA automatically.

Profile planning does not write. Application detects user-file conflicts, retains backups for managed updates/deletions, and never prunes unknown files. Existing unsupported CP932/Shift-JIS profile targets are left unchanged.

Use `/login` to authenticate within Jouzu's agent root. `/model` or `Ctrl+L` opens the Jouzu Palette Models view without clearing the prompt draft. Search exact provider/model identity or display names; `Enter` selects for the session, `Alt+Enter` also saves the global default, and `Ctrl+F`/`Alt+F` toggle global/project favorites. Recents update on first request dispatch and remain local. `/status` reports provider-neutral session, model, context, profile, and runtime facts.

Jouzu does not import stock Pi state. Override all roots with `--jouzu-home <path>` or `JOUZU_HOME`. Trusted project `.pi` resources and Pi's cross-harness `~/.agents/skills` read surface still follow Pi behavior. On exit, resume the isolated session with the printed `jz --session SESSION_ID` command; Jouzu resolves its own session root.

Use `jz pi ...` or `jz -- ...` for Pi command collisions. Pi runtime self-update is blocked; package/model updates inside Jouzu state remain available.

When the isolated Jouzu agent root has no `keybindings.json`, the first interactive launch seeds `Ctrl+Enter` for Pi's `app.message.followUp` action and `Ctrl+Up` for `app.message.dequeue`; `Tab` retains Pi autocomplete and selector behavior. On upgrade from v0.1.0, Jouzu backs up and replaces only an exact Jouzu-owned `Tab` follow-up entry. User-owned or modified bindings remain unchanged. Use `jz keybindings status|plan|apply|reset`; explicit apply merges only missing defaults with conflict checks/backups, while reset removes only Jouzu-recorded entries and disables reseeding. `JOUZU_NO_KEYBINDING_DEFAULTS=1` is a one-run opt-out. Modified-key reporting is terminal-dependent; tmux should use `extended-keys-format csi-u`.

Real global npm installs default to a pre-TUI automatic Jouzu update check/restart on the first eligible launch. Successful checks are cached for 24 hours; failed checks retry no sooner than one hour later. Candidate tarball SHA-512 integrity and the installed Jouzu/Pi tuple are verified; failure restores the locally packed previous version. Source, project-local, and ephemeral `npx` invocations are not rewritten.

```bash
jz self-update status
jz self-update check
jz self-update apply
jz self-update policy auto-restart  # or notify/off
```

Set `JOUZU_NO_UPDATE=1` for a one-run opt-out. Checks use npm's configured registry, proxy, and CA behavior and send no Jouzu telemetry. Updating requires write access to the active global npm prefix; permission or network failures leave the current version running.

Interactive launches show an adaptive Jouzu header and clear the viewport. Set `JOUZU_NO_CLEAR=1` to retain it; set `NO_COLOR=1` to disable color.

npm is the only v0.1 channel. PyPI `jouzu==0.0.1` remains a non-functional reservation. Jouzu v0.1 does not bundle prerequisites, native installers, hosted models, routing, or provider privacy/retention guarantees.

See the [full documentation](https://github.com/shisa-ai/jouzu#readme) and [Windows prerequisites](https://github.com/shisa-ai/jouzu/blob/main/docs/windows.md).
