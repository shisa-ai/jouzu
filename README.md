# Jouzu

Jouzu is a Japanese-first distribution of the [Pi coding agent](https://pi.dev/). The `jouzu` and `jz` commands run an exact reviewed Pi runtime with isolated Jouzu state, safe built-in Core/JA profiles, and human-readable diagnostics.

Jouzu v0.1 is an npm developer preview. It expects an existing development environment; it is not a native installer or hosted model service.

## Requirements

- Node.js 22.19 or newer and npm
- Git
- Bash (`bash` on Linux/macOS; Git Bash on Windows)
- A provider supported by Pi, authenticated through `/login`, provider environment variables, or explicit `models.json`

Windows users should read [Windows prerequisites](docs/windows.md). Signed installers, portable archives, and bundled prerequisites are not part of v0.1.

## Install

```bash
npm install --global jouzu@0.1.0

jouzu --version
jz doctor
```

`jz` is an exact alias for `jouzu`. To try the CLI without a global installation:

```bash
npx --yes jouzu@0.1.0 --version
```

PyPI `jouzu==0.0.1` remains a non-functional package-name reservation and is not a v0.1 installation channel.

## Quick start

Inspect and apply the default Japanese profile before launching:

```bash
jz profile plan
jz profile apply
jz
```

A normal launch also performs the same safe reconciliation automatically. It stops before Pi if a managed target conflicts with a user-owned or modified file.

Inside Pi:

- `/login` configures provider authentication in Jouzu's isolated agent root.
- `/model` or `Ctrl+L` selects from available provider/models.
- `/jouzu` reports the active Jouzu, Pi, profile, and model tuple.

Jouzu does not include model service, billing, routing, privacy, retention, region, or certification guarantees. Those properties belong to the provider and configuration you select.

## Profiles

The fresh-install default is `ja`, which combines provider-neutral Core assets with a concise Japanese-first response policy. It preserves exact code, commands, identifiers, paths, URLs, logs, and source error messages instead of translating or normalizing them.

Select the provider-neutral Core profile when Japanese defaults are not wanted:

```bash
jz profile plan --profile core
jz profile apply --profile core
```

You can also select a profile for an ordinary launch:

```bash
jz --jouzu-profile core
```

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

`doctor` is non-mutating and reports the install channel, exact Pi tag/commit, platform/runtime prerequisites, resolved roots, profile hashes, package count, authentication presence, proxy/CA status, shared skill surface, warnings, and actionable problems. It reports presence only and does not print credential values.

Most arguments are forwarded unchanged to Pi. Use `pi` or `--` when a Pi argument collides with a Jouzu command. Pi runtime self-update is blocked because Jouzu owns the exact Pi dependency; upgrade Jouzu instead. Pi package/model operations such as `jz update --extensions` and `jz update --models` remain available inside Jouzu state.

Interactive launches clear the current viewport and show a compact adaptive Jouzu header. Set `JOUZU_NO_CLEAR=1` to preserve existing terminal output. `NO_COLOR` disables banner color.

## Text and encoding behavior

The compatibility suite covers Japanese paths, full-width spaces, hiragana, katakana, half-width kana, kanji, combining marks, emoji, UTF-8 BOM, and CRLF without normalizing or transcoding user files.

Managed profile assets are UTF-8. Existing CP932/Shift-JIS profile targets produce an `unsupported-encoding` conflict and remain byte-identical; Jouzu does not guess or convert their encoding.

## Known limitations

- npm is the only v0.1 application channel.
- Node, npm, Git, Bash, and provider credentials are not bundled.
- No automatic import from an existing Pi installation.
- No native installer, standalone archive, background service, hosted gateway, or Jouzu-owned model catalog.
- Third-party Pi packages execute trusted code with the user's permissions and have their own platform support.
- Cross-platform support claims require the release commit's Linux, macOS, and Windows CI matrix to pass.

## Development

```bash
npm ci --ignore-scripts
npm run release:check
npm run dev:link
```

The opt-in live Japanese tool-flow smoke requires an explicitly selected provider/model and cost budget; it is not part of default tests:

```bash
JOUZU_LIVE_SMOKE=1 \
JOUZU_LIVE_PROVIDER=<provider> \
JOUZU_LIVE_MODEL=<model> \
JOUZU_LIVE_MAX_USD=0.02 \
npm run test:live:ja
```

It installs the packed artifact in a temporary consumer, permits only `read` and `write`, stores no session or transcript, verifies exact Japanese output bytes, and fails if reported cost exceeds the declared budget.

## License

Apache-2.0. See [LICENSE](LICENSE).
