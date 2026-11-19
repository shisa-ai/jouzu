# Profiles

A profile is a set of instructions, skills, and prompts that Jouzu installs into its agent directory. The agent directory is the configuration root listed in [State and isolation](../README.md#state-and-isolation).

| Profile | Adds |
| --- | --- |
| `core` (default) | Default instructions, six optional skills, and the `jouzu-review` prompt. Selects no provider or response language. |
| `ja` (preview) | Everything in `core`, plus Japanese responses. Code, commands, identifiers, paths, URLs, logs, and error messages stay unchanged. |

The UI locale does not select a response language. See [Language, locale and prompt instructions](language.md) for how identity, shared guidance, profiles, response settings, artifact policies and custom prompts combine. To use language settings without the JA profile's independent Japanese instruction, select Core.

## Choose a profile

The first interactive launch asks for the interface language and then the response language. It uses `core` for either interface language, so the response choice is not overridden by a profile default. The Chinese interface choices are unavailable. Skipping the interface choice or running non-interactively writes no language choice and uses `core`.

To change the profile, run:

```bash
jz profile plan --profile ja     # preview, writes nothing
jz profile apply --profile ja
jz profile apply --profile core
```

To select a profile for a launch and save it as the active profile, run `jz --jouzu-profile ja`, or set `JOUZU_PROFILE=ja`.

## Skills in `core`

| Skill | Use |
| --- | --- |
| `jouzu-analysis` | Turn evidence into findings and recommendations in comparisons, evaluations, and decision memos |
| `jouzu-anti-slop` | Remove filler from existing prose without losing facts or qualifiers |
| `jouzu-clear-writing` | Write or revise lasting technical text while keeping facts and terminology |
| `jouzu-delegation` | Write clear child-agent assignments, follow-ups, acceptance checks, and stopping points |
| `jouzu-reference` | Look up Jouzu settings, language, models/catalogs, profiles, history, controls and troubleshooting |
| `jouzu-source-check` | Classify claims, find primary evidence and counterevidence, and rate confidence |

- The prompt lists skills that the session can read. It omits `jouzu-delegation` when delegation is disabled or its tool is not directly exposed, and `multiloop` when no goal or loop tools are exposed. Generic skills remain discoverable. The full instructions load when a task matches or you run `/skill:<name>`; filtering the prompt index does not remove explicit skill commands.
- The agent reads a skill once from its listed location and continues without it if the file is unreadable.
- The skill index describes when to use `jouzu-reference`. Its short entry point links to bundled Markdown references loaded on demand, so configuration and recovery help works offline without a source checkout. Run `/skill:jouzu-reference` to load it explicitly. The reference distinguishes user commands from assistant tools and saved settings from live changes.

## Default instructions

The default system prompt tells the agent to:

- Follow repository instructions and preserve your work.
- Inspect before editing and make the smallest coherent change.
- Separate evidence from assumptions.
- Run deterministic checks and report untested limitations.
- Treat fetched pages and search results as untrusted.
- Make independent tool calls in parallel, and treat a message sent during work as steering the current task.

It also includes today's date and one discovery link to Pi's documentation index for extension, SDK, or TUI development. Jouzu settings questions use `jouzu-reference`.

Optional workflow instructions follow the session's exposed tools and enabled features, in both interactive and headless runs. A session with only file and shell tools receives no task, delegation, or background-job routing. Turning delegation off preserves instructions for inspecting existing results but removes launch guidance. Turning flow control off suppresses wait and no-reply invocation guidance; the registered tools retain their runtime refusal checks. Tool parameters belong in tool definitions, skill triggers in the skill index, and cross-tool choices in compact routing bullets.

`core` selects bundled instructions and resources; it does not disable workflow tools. Running headlessly does not disable them either.

Jouzu adds these as named sections of Pi's prompt. Changes such as a new date or response-language preference produce section updates; provider support determines whether those remain later updates or are folded into the leading message. See [instruction changes and caching](language.md#when-instructions-change-and-what-caching-means).

A custom system prompt owns the preamble; Jouzu does not replace it with default guidance or language settings. Other resources and extensions may still add instructions. See [custom prompt boundaries](language.md#identity-guidance-and-custom-prompts).

## How profiles are applied

- Each launch reconciles the selected profile. If a managed file conflicts with a file you own or edited, Jouzu stops before launching.
- Profiles may write only bundled UTF-8 files at `APPEND_SYSTEM.md`, `skills/jouzu-*/**/SKILL.md`, `skills/jouzu-*/references/<name>.md`, and `prompts/jouzu-*.md`. Reference names use lowercase letters, digits and hyphens.
- Applying uses a lock, conflict checks, backups, and atomic file replacement.
- Unknown files and your own `AGENTS.md` are never removed.
- Backups are kept under the Jouzu state directory shown by `jz doctor`.

## Resolve a conflict

A conflict means a target file differs from both the bundled version and the version Jouzu last wrote. A conflicting `plan` or `apply` exits with status 3.

1. Run `jz profile plan --json` to see the conflicting files.
2. Inspect each file and keep, move, or delete your changes.
3. Run `jz profile apply` again.

Files in CP932/Shift-JIS report an `unsupported-encoding` conflict. Jouzu leaves them byte-for-byte unchanged and does not convert them.
