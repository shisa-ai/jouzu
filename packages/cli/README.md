# Jouzu

Jouzu is an agentic AI environment built on the Pi coding agent. `jouzu` and `jz` run exact Pi `0.84.2` with isolated Jouzu state, built-in Core/JA profiles, and non-mutating diagnostics. Japanese support is optional and first-class.

## Install and start

Requires Node.js 22.19+, npm, Git, and Bash. Windows requires Git Bash.

```bash
npm install --global jouzu@0.1.0

jz --version
jz doctor
jz
```

The first interactive launch asks whether to enable Japanese support. An affirmative answer selects `ja`; declining or pressing Enter selects the provider-neutral `core` profile. Non-interactive first runs safely use Core without recording consent. Preview either profile with:

```bash
jz profile plan --profile core
jz profile plan --profile ja
```

Profile planning does not write. Application detects user-file conflicts, retains backups for managed updates/deletions, and never prunes unknown files. Existing unsupported CP932/Shift-JIS profile targets are left unchanged.

Use `/login` to authenticate within Jouzu's agent root. Pi's `/model` or `Ctrl+L` picker remains available. `/jouzu` reports the active Jouzu/Pi/profile/model tuple.

Jouzu does not import stock Pi state. Override all roots with `--jouzu-home <path>` or `JOUZU_HOME`. Trusted project `.pi` resources and Pi's cross-harness `~/.agents/skills` read surface still follow Pi behavior.

Use `jz pi ...` or `jz -- ...` for Pi command collisions. Pi runtime self-update is blocked; upgrade the `jouzu` npm package instead. Package/model updates inside Jouzu state remain available.

Interactive launches show an adaptive Jouzu header and clear the viewport. Set `JOUZU_NO_CLEAR=1` to retain it; set `NO_COLOR=1` to disable color.

npm is the only v0.1 channel. PyPI `jouzu==0.0.1` remains a non-functional reservation. Jouzu v0.1 does not bundle prerequisites, native installers, hosted models, routing, or provider privacy/retention guarantees.

See the [full documentation](https://github.com/shisa-ai/jouzu#readme) and [Windows prerequisites](https://github.com/shisa-ai/jouzu/blob/main/docs/windows.md).
