# Diagnostics

```bash
jz doctor
jz doctor --json
jz --version
```

`jz doctor` changes nothing. It reports:

- Install and update channel, update policy, and keybinding defaults
- Pi version and commit
- Platform and runtime prerequisites
- Configuration, state, and cache locations
- Profile hashes and package count
- Whether credentials exist (never their values), proxy and CA status
- Shared skill directories
- Catalog sources and catalog gaps
- Warnings and problems with suggested fixes

It exits `1` when it reports a problem.

`--json` prints the same report for scripts. The format is experimental and marked `"experimental": true`; fields may change.

## In a session

| Command | Shows |
| --- | --- |
| `/status` | Session, workspace, model, thinking level, context, profile, runtime |
| `/about` | Running and installed Jouzu builds, Pi version, startup time. If the running and installed builds differ, restart Jouzu. |
| `/flow runtime` | Startup package paths and hashes |
| `/bug` | Draft a bug report. See [Report a Jouzu bug](bug-reporting.md). |

## Passing arguments to Pi

Jouzu forwards most arguments to Pi unchanged. When a Pi argument has the same name as a Jouzu command, use `pi` or `--`:

```bash
jz pi --help
jz -- --version
```

- Pi's own self-update is blocked because Jouzu pins its Pi version.
- `jz update --extensions` and `jz update --models` work and use Jouzu's state.

## RPC mode

`jz pi --mode rpc` runs Pi's JSONL protocol on standard input and output. Each accepted command receives exactly one response, and a line that is valid JSON but not a command object reports one `parse` failure.

When standard input closes, Jouzu resolves unanswered dialogs with their defaults and gives accepted commands up to five seconds to answer. A command still unanswered after that reports one failure. Cleanup then gets up to five seconds of its own; if it cannot finish, Jouzu reports one `shutdown` failure and exits with status 1. Responses and diagnostics already written are flushed first.

A shutdown failure from an extension request or a signal reports the same way: one `shutdown` failure, one flush, status 1. A second ordinary shutdown request waits for the one in progress instead of exiting early, so queued output is not lost and a failing status is not replaced by success. A shutdown requested after input has ended also waits for the command drain, so every accepted command still reports before the process exits. `SIGTERM` and `SIGHUP` keep their own exit status and exit at once when a shutdown is already in progress. Keep standard input open for commands that can take longer than five seconds.
