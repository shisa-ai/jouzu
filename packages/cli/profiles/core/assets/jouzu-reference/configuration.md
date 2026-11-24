# Configuration

`jz doctor --json` is read-only: it reports resolved paths, language sources, profile and credential presence, using cached catalogs. Exit 1 means a reported problem; its JSON schema is experimental.

## Roots and files

`--jouzu-home <path>` overrides `JOUZU_HOME`. Either makes that path the configuration root, with `agent/`, `state/`, `cache/` beneath it. Otherwise:

| Platform | Configuration | State | Cache |
| --- | --- | --- | --- |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/jouzu` | `${XDG_STATE_HOME:-~/.local/state}/jouzu` | `${XDG_CACHE_HOME:-~/.cache}/jouzu` |
| macOS | `~/Library/Application Support/Jouzu` | Configuration + `/state` | `~/Library/Caches/Jouzu` |
| Windows CLI | `%APPDATA%\Jouzu` | `%LOCALAPPDATA%\Jouzu\state` | `%LOCALAPPDATA%\Jouzu\cache` |

The Windows launcher defaults to `%LOCALAPPDATA%\Shisa.ai\Jouzu\data` as its home unless overridden. Prefer doctor over assuming platform defaults.

Relative to the configuration root:

| Path | Contents |
| --- | --- |
| `localization.json` | Saved language preferences |
| `agent/settings.json` | User runtime settings |
| `agent/keybindings.json` | Keybindings; `/reload` after edits |
| `agent/models.json` | Custom providers/models |
| `agent/auth.json` | Provider credentials; use `/login` and `/logout` |
| `catalogs.json`, `catalog-overrides.json` | Custom sources and built-in source enabled state |
| `catalog-credentials.json` | Saved catalog tokens; never display |
| `context-policy.json` | Context ceiling |
| `agents.json` | Workflow definitions, concurrency and writer policy |
| `agent/mcp.json` | User MCP servers; `/reload` after edits |
| `agent/skills/`, `agent/prompts/`, `agent/extensions/`, `agent/themes/` | Resources |

Trusted project `.pi` resources and shared `~/.agents/skills` are separate. Do not substitute stock Pi roots. First-run Pi import offers only `models.json` and `auth.json`, separately with confirmation, without replacing existing files.

## Language

Saved shape (example, not a replacement for an existing file):

```json
{
  "schemaVersion": 2,
  "localization": {
    "uiLocale": "en",
    "responseLanguage": "auto",
    "artifactPolicy": {
      "comments": "preserve",
      "documentation": "project",
      "commits": "project",
      "reviews": "project"
    }
  }
}
```

- Offered interface languages: `en`, `ja`. Response language: `auto`, `en`, `ja`, `zh-Hans`, `zh-Hant`. `auto` adds no fixed conversation-language instruction.
- Each artifact field accepts `preserve`, `project`, or an explicit response-language tag. `preserve` keeps existing text; `project` follows project language. The example shows built-in artifact defaults.
- Startup UI precedence: saved preference, `--jouzu-ui-locale`, `JOUZU_UI_LOCALE`, locale environment, English fallback. Saved `auto` follows the first nonempty `LC_ALL`, `LC_MESSAGES`, `LANG` without consulting launch overrides; these do not set response language. A doctor process reports startup resolution, not another session's live state.
- Repository `.jouzu/localization.json` is not trusted artifact policy. The `ja` profile independently requests Japanese responses; use `core` to rely on language settings alone.

### Recover English

In Settings: `/language` → **Display language** → **English**. Arrow keys preview without saving. Enter opens confirmation; Enter again saves the choice. It overrides CLI/environment inputs and refreshes supported screens. Reopen or restart screens that retain their opening language.

Every confirmed change persists the requested UI, response and artifact preferences. Response/artifact changes also apply on the next turn, not an active reply. Other running sessions keep their active choices. Reset clears this session's overrides and saves UI `auto`, preserving saved response/artifact defaults.

For an authorized file fallback, read `localization.json`, change only `localization.uiLocale` to `en`, preserve other fields, validate JSON, and report restart required. Never replace a malformed file with the example. Persistent response/artifact edits also take effect at a new session. “Answer in English” does not authorize UI, artifact, profile or model changes.

See the public [language guide](https://github.com/shisa-ai/jouzu/blob/main/docs/language.md) for the complete identity/profile/locale model; this reference remains usable offline. Children snapshot the caller's active response language and applicable per-field artifact policy; UI locale does not select child language.

## Other settings

- `/settings`: runtime settings, theme and cache warming. Global `cacheWarming` defaults to `off`; `streaming`/`idle` can incur charges.
- `agent/settings.json` `tuiMode`: `fullscreen` (default) or `regular`; treat file edits as next-launch changes.
- Settings / Catalogs: context ceiling and Dashboard (`compact`, `expanded`, `hidden`), saved and applied live.
- `JOUZU_NO_CLEAR=1` preserves startup terminal output; `NO_COLOR` disables header color.
