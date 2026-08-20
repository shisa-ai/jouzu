# Jouzu

Jouzu is a Japanese-first distribution of the Pi coding agent. `jouzu` and `jz` run exact Pi `0.84.2` with isolated Jouzu state, built-in Core/JA profiles, and non-mutating diagnostics.

## Install and start

Requires Node.js 22.19+, npm, Git, and Bash. Windows requires Git Bash.

```bash
npm install --global jouzu@0.1.0

jz --version
jz doctor
jz profile plan
jz profile apply
jz
```

The fresh-install profile is `ja`. Use the provider-neutral Core profile with:

```bash
jz profile apply --profile core
```

Profile planning does not write. Application detects user-file conflicts, retains backups for managed updates/deletions, and never prunes unknown files. Existing unsupported CP932/Shift-JIS profile targets are left unchanged.

Use `/login` to authenticate within Jouzu's agent root. Pi's `/model` or `Ctrl+L` picker remains available. `/jouzu` reports the active Jouzu/Pi/profile/model tuple.

Jouzu does not import stock Pi state. Override all roots with `--jouzu-home <path>` or `JOUZU_HOME`. Trusted project `.pi` resources and Pi's cross-harness `~/.agents/skills` read surface still follow Pi behavior.

Use `jz pi ...` or `jz -- ...` for Pi command collisions. Pi runtime self-update is blocked; upgrade the `jouzu` npm package instead. Package/model updates inside Jouzu state remain available.

Interactive launches show an adaptive Jouzu header and clear the viewport. Set `JOUZU_NO_CLEAR=1` to retain it; set `NO_COLOR=1` to disable color.

npm is the only v0.1 channel. PyPI `jouzu==0.0.1` remains a non-functional reservation. Jouzu v0.1 does not bundle prerequisites, native installers, hosted models, routing, or provider privacy/retention guarantees.

See the [full documentation](https://github.com/shisa-ai/jouzu#readme) and [Windows prerequisites](https://github.com/shisa-ai/jouzu/blob/main/docs/windows.md).
