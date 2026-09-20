# Report a Jouzu bug

Report Jouzu problems at [the GitHub issue form](https://github.com/shisa-ai/jouzu/issues/new), including session flow control, terminal behavior, and installation failures.

**GitHub issues are public.** Review the title and body before submitting. Remove credentials, private project information, and unnecessary conversation content from anything you share.

## Draft a report from a session

1. Run `/bug`, optionally followed by a short description, such as `/bug automatic work remains held after the job finishes`.
2. Describe what went wrong, what you expected, what happened instead, and how to reproduce it.
3. Review and edit the generated report body and issue title. Jouzu fills in the reported details and minimal environment facts: Jouzu/Pi runtime identity, operating system, architecture, and Node or Bun version. Drafting does not call a model or collect a transcript, settings, provider addresses, crash stacks, or tool results.
4. Review the final draft displayed in the session. The GitHub issue form link is always provided so you can copy the draft and submit it in your browser.

When Jouzu verifies an authenticated GitHub CLI (`gh`) account, it also offers **Submit as <username> using gh**. The confirmation names the account and the public `shisa-ai/jouzu` repository. **No, keep the draft** is selected by default. Jouzu creates an issue only after you select the submission option.

If `gh` is absent or an authenticated account cannot be verified, use the displayed issue form link. You do not need to install or sign in to `gh` to prepare a report. The report has no automatic attachments.

If submission fails or times out, check the [Jouzu issue list](https://github.com/shisa-ai/jouzu/issues) before trying again: GitHub may have created the issue even if Jouzu did not receive confirmation. The draft and issue form link remain available; Jouzu does not retry automatically.

## Include reproduction details

Add any details needed to reproduce the problem:

- The command or sequence of actions that triggers it.
- Expected and actual results, including the exact error after removing private information.
- Your terminal application and installation method.
- Whether it repeats in a new session, if you can check without losing work.

For a flow-control problem, include relevant `/flow` output after reviewing it. `/flow runtime` includes local package paths, so review those before copying it into a public issue. You can also get version information from `/about` or `jz --version` outside a session.

## Installation or startup failures

You can report a problem using the [GitHub issue form](https://github.com/shisa-ai/jouzu/issues/new) without launching Jouzu. Include the installation method, the version you attempted to install, your operating system, the failing step, and the reviewed error text.

For Windows installer failures, use the setup log path shown by the installer. Review relevant excerpts before sharing them; logs can include your username and local paths. See [Windows setup](windows.md) and the [Windows installer preview](../packaging/windows/README.md) for installation details.
