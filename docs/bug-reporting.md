# Report a Jouzu bug

Report Jouzu problems at [shisa-ai/jouzu/issues](https://github.com/shisa-ai/jouzu/issues), including session flow control, terminal behavior, and installation failures.

**GitHub issues and attachments are public.** Review every file before sharing it. Diagnostic archives can contain private paths, provider addresses, settings, error messages, and crash details even when you exclude the transcript. Automatic credential redaction does not guarantee that an archive is safe to publish.

## Export diagnostics from a session

1. Run `/bug`, optionally followed by a short description, such as `/bug automatic work remains held after the job finishes`.
2. Describe what went wrong. Leave transcript inclusion set to **No** unless the conversation is needed to reproduce the problem. A transcript includes prompts, model replies, tool calls, and tool results, which can contain file contents and command output.
3. Confirm the local export. Jouzu writes a `jouzu-bug-report-*.zip` archive in the current directory and displays its path. The command does not upload files, post an issue, or make a model request.
4. Extract the archive and inspect its files. Remove credentials, private project information, and unnecessary conversation content from anything you intend to share. If you edit extracted files, share those reviewed files or a newly created archive, not the original ZIP.
5. Open a Jouzu issue and describe the problem. Attach only the diagnostics needed to reproduce it; an archive is optional.

The archive contains `report.json` with the Jouzu runtime identity, Pi version, operating system, model/provider configuration, extension information, and settings. `diagnostics.json` contains recorded provider errors and crash details. `session.jsonl` is included only when you choose to include the transcript.

Cancel before confirming export to leave without creating a report. If export fails, use the displayed error to check the destination directory and retry, or file an issue without an archive.

## Include reproduction steps

Provide:

- The command or sequence of actions that triggers the problem.
- What you expected and what happened instead, including the exact error after removing private information.
- Jouzu and Pi versions from `/about`, or `jz --version` when working outside a session.
- Your operating system and terminal application.
- Whether the problem repeats in a new session, if you can check without losing work.

For a flow-control problem, include relevant `/flow` output after reviewing it. `/flow runtime` includes local package paths, so review those before copying it into a public issue.

## Installation or startup failures

You can report a problem without launching Jouzu or exporting an archive. Include the installation method, the version you attempted to install, your operating system, the failing step, and the reviewed error text.

For Windows installer failures, use the setup log path shown by the installer. Review the log before sharing it; it can include your username and local paths. See [Windows setup](windows.md) and the [Windows installer preview](../packaging/windows/README.md) for installation details.
