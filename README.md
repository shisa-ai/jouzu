# Jouzu

Jouzu is a Japanese-first distribution of the [Pi coding agent](https://pi.dev/).

The repository development build now provides real `jouzu` and `jz` launchers for an exact, qualified Pi runtime. The published `0.0.1` package remains a reservation until the complete v0.1 developer-preview gates pass.

Current development behavior:

- launches exact Pi `0.84.2` through its public top-level API;
- keeps Jouzu configuration, packages, credentials, and sessions separate from stock Pi;
- preserves Pi arguments, provider support, and `/model` or Ctrl+L model selection;
- gives interactive TTY launches an adaptive Unicode Jouzu header with truecolor, indexed-color, basic-color, `NO_COLOR`, and narrow-terminal fallbacks while leaving print/JSON/RPC output untouched;
- reports the Jouzu/Pi tuple and isolation paths through `jouzu --version`, `/jouzu`, and `jouzu doctor`; and
- blocks Pi self-update while allowing extension and model updates inside Jouzu state.

Core/JA profile reconciliation, the resolved maintainer dogfood stack, CJK release fixtures, and external release proof are still under development. A Jouzu-owned catalog picker is planned after the basic v0.1 launcher.

## Run the development launcher

Requires Node `>=22.19.0`, npm, Git, and Bash. From a source checkout:

```bash
npm ci --ignore-scripts
npm run dev:link

jz --version
jz doctor
jz
```

`npm run dev:link` creates global development links for both `jouzu` and `jz`. Remove them with:

```bash
npm unlink --global jouzu
```

For a disposable isolated root:

```bash
JOUZU_HOME="$PWD/.jouzu-dev" jz doctor
JOUZU_HOME="$PWD/.jouzu-dev" jz
```

By default Jouzu uses platform-native roots. `doctor` prints their exact locations without creating them. Jouzu does not import an existing Pi installation; authenticate separately with `/login` or use provider environment variables.

Use `jz pi --help` for Pi's full CLI and `jz --help` for Jouzu options. Pi's existing model picker is available with `/model` or Ctrl+L. Interactive launches clear the current terminal viewport by default; set `JOUZU_NO_CLEAR=1` when you want to retain it.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
