# Connect an ACP host

Run `jouzu acp` to let an Agent Client Protocol (ACP) host drive Jouzu over standard input and output. The host launches the adapter; the adapter starts a separate `jouzu --mode rpc` process for each session. Model calls, tools, extensions, and session persistence run in Jouzu.

## Setup

Configure your model and provider credentials in Jouzu before connecting a host. Run `jouzu` interactively to sign in and choose a default model. The ACP adapter uses the same Jouzu configuration and credentials and does not run first-launch dialogs.

Configure the host to launch:

```json
{
  "command": "jouzu",
  "args": ["acp"]
}
```

Use an absolute executable path if the host does not inherit your shell's `PATH`. Jouzu options go before `acp`:

```sh
jouzu --jouzu-home /absolute/path/to/jouzu-home --jouzu-profile core acp
```

The host must send `initialize` before session requests and an absolute working directory in `session/new`. Standard output contains only ACP records; diagnostics go to standard error.

## Sessions and turns

- `session/new` starts a Jouzu session in the requested working directory.
- `session/prompt` accepts text, images, embedded text or image resources, and resource links. Resource links are passed to the model as references; they are not automatically downloaded. Image handling depends on the selected model.
- `session/update` streams assistant text, reasoning when supplied by the model, and tool calls and results.
- `session/cancel` cancels the active turn. Prompt completion waits for the runtime to settle, including automatic retries and follow-up work.
- `session/list` lists persisted Jouzu sessions. `session/load` takes a session ID, not a file path, and replays conversation history. Use the session's original working directory.
- `session/close` stops the session's child process. Closing the host connection stops all children owned by that connection.
- The `model` session configuration option lists available models. Use `session/set_config_option` to change it between turns.

Session IDs come from Jouzu's session store. You can retain an ID and load the session after restarting the adapter.

## Host interactions and permissions

Extension selection and confirmation dialogs are relayed through ACP permission requests. Text input and editor dialogs use form elicitation when the host advertises that capability. Without form elicitation, those dialogs are cancelled; hosts that support notices also receive an explanation. While one of these dialogs waits for the user, the prompt acknowledgment timeout is suspended; after the response, a fresh timeout budget applies.

**ACP is not a sandbox.** Tools run with the same operating-system access as the launched Jouzu process. A working directory does not restrict filesystem access. Relaying extension dialogs does not add approval checks to every tool call. Use trusted workspaces, extensions, and hosts, and launch Jouzu under an account with appropriate access.

The adapter uses local Jouzu tools rather than delegating filesystem or terminal operations to the host. It rejects nonempty host MCP server lists and additional workspace directories. ACP plan updates are not emitted.

## Qualification

Automated tests exercise the ACP SDK client, protocol edge cases, and the full CLI-to-RPC path with a local model fixture. These checks do not certify an editor's interface behavior. Zed-specific interaction testing and native Windows/macOS qualification are separate from the Linux protocol tests.
