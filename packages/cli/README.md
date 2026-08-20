# Jouzu

Jouzu is a Japanese-first distribution of the Pi coding agent harness.

The source development build launches the exact qualified Pi runtime through both `jouzu` and `jz`, with separate Jouzu configuration and session roots. The npm `0.0.1` release remains a package-name reservation until v0.1 release gates are complete.

```bash
jouzu --version
jouzu doctor
jouzu

# Exact alias
jz
```

Use `/login` to authenticate inside Jouzu's isolated agent root. Pi's provider/model flow and model picker remain available through `/model` or Ctrl+L. Interactive TTY launches use an adaptive Unicode Jouzu header with terminal-aware color fallbacks and clear the current viewport. Set `NO_COLOR=1` for plain Unicode or `JOUZU_NO_CLEAR=1` to retain the viewport.

Jouzu does not import stock Pi state. Override all Jouzu roots together with `--jouzu-home <path>` or `JOUZU_HOME`. Use `jouzu pi ...` or `jouzu -- ...` when a Pi argument collides with a reserved Jouzu command.

Pi runtime self-update is blocked because Jouzu owns the exact reviewed dependency. Package and model operations such as `jouzu update --extensions` and `jouzu update --models` remain available. `/jouzu` reports the active Jouzu/Pi/profile/model tuple.
