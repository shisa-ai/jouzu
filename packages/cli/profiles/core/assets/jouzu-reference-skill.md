---
name: jouzu-reference
description: Look up Jouzu settings, language, models/catalogs, profiles, session and trace locations, controls, and troubleshooting. Use for product questions or authorized configuration changes.
license: Apache-2.0
---

# Jouzu reference

Read only the topic needed. Resolve links relative to this skill's listed location; these files ship with Jouzu and work offline.

| Topic | Reference |
| --- | --- |
| Configuration paths, settings, language recovery | [Configuration](references/configuration.md) |
| Models, thinking, catalogs, accounts | [Models](references/models.md) |
| Profiles; reading session and child history with tools | [History](references/history.md) |
| Where sessions, child runs, flow state and other saved files are | [Saved files](references/saved-files.md) |
| Commands, tools, extensions, updates, troubleshooting | [Controls](references/controls.md) |

Start with `jz doctor --json` for resolved paths and configuration. If the installation uses `--jouzu-home` or `JOUZU_HOME`, pass the same value to every `jz` command. `/about` distinguishes running from installed builds; a shell executable can differ from the running session.

Use declared tools as the authority for callable actions. Slash commands are user actions, not shell commands or tools. Prefer the owning control; an authorized file edit must preserve unrelated values and report saved versus active state. Do not rewrite live session records. Only the user changes role models or enables disabled subagents. Do not restart, sign in, install, change trust or expose credentials implicitly.

If these files disagree with the running version, report the mismatch. Read bounded excerpts and redact before sharing; transcripts and settings can contain secrets. Longer public documentation: <https://github.com/shisa-ai/jouzu/tree/main/docs> (may describe a different version).
