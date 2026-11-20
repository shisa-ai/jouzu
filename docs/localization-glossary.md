# Four-locale glossary for the Jouzu CLI catalog

The `en`, `ja`, `zh-Hans`, and `zh-Hant` catalogs share the protected values
listed here. Keep these values in their original form in every locale. The
Chinese glossaries also list vocabulary and wording rules.

## Catalogs

Only `en` and `ja` are offered as interface languages. The Chinese catalogs are
drafts for contributor use, not additional supported interfaces.

| Locale | Catalog | Vocabulary |
| --- | --- | --- |
| `en` | `packages/cli/locales/en` | English source |
| `ja` | `packages/cli/locales/ja` | `cli.ftl` header |
| `zh-Hans` | `packages/cli/locales/zh-Hans` | [Simplified Chinese glossary](localization-zh-hans-glossary.md) |
| `zh-Hant` | `packages/cli/locales/zh-Hant` | [Traditional Chinese glossary](localization-zh-hant-glossary.md) |

`packages/cli/locales/catalog-status.json` supplies metadata for the diagnostic
support state; see [Localization](localization.md). A catalog's presence does
not establish language quality or terminal qualification.

## Protected values

These stay as written in every locale. A translator never renders them in
another script.

- **Commands and options:** `jz`, `jouzu`, `pi`, `jouzu --help`,
  `jouzu pi --help`, `jz --session`, `jz doctor`, `jz doctor --json`, `jz catalog status`,
  `jz keybindings plan`, `jz keybindings apply`, `jz profile plan`,
  `jz profile apply`, `jz update --extensions`, `--json`, `--jouzu-home`,
  `--jouzu-profile`, `--jouzu-ui-locale`, `--profile`, `--yes`.
- **Slash commands:** `/login shisa`, `/logout shisa`, `/reload`, `/textguard`,
  `/voice`, `/flow`, `/images`, `/subagents`, `/workflow`, `/labels`, `/model`,
  `/catalogs`.
- **Policy and mode values:** `auto`, `auto-restart`, `notify`, `off`, `none`,
  `guarded`, `strict`, `bearer` and `Bearer`.
- **Product names:** `Jouzu`, `Pi`, `Shisa`, `TextGuard`, `Camoufox`.
- **Palette product nouns:** `Jouzu Palette`, `Palette`, `Settings`,
  `Models`, `About`, `Dashboard`, `Workflow`, `Session UI`, `Jouzu Help`.
- **Profile ids:** `core`, `ja`.
- **Locale tags:** `en`, `ja`, `zh-Hans`, `zh-Hant`.
- **Settings keys and file names:** `schemaVersion`, `uiLocale`,
  `responseLanguage`, `artifactPolicy`, `maxContextTokens`, `settings.json`,
  `keybindings.json`, `localization.json`, `localization.lock`,
  `catalog.lock.json`, `catalog-status.json`, `models.json`, `auth.json`,
  `agents.json`.
- **Environment variables:** `JOUZU_NO_CLEAR`, `JOUZU_UI_LOCALE`,
  `SHISA_API_KEY`, `NO_COLOR`, `TERM`, `LC_ALL`, `LC_MESSAGES`, `LANG`.
- **Tool names and identifiers:** `tff-fetch_url`, `tff-search_web`, and every
  model, provider, source, and offering ID.
- **Key names:** `Ctrl+L`, `Ctrl+C`, `Tab`, `Shift+Tab`, `Enter`, `Control+Up`,
  `ctrl+enter`, `Kitty`, `modifyOtherKeys`.
- **Thinking levels**, **paths**, **URLs**, **HTTP status codes**, **exit
  codes**, **digests**, and **version strings**.

A `Palette` product noun in the list above stays English in ordinary translated
prose. The `Settings / Catalogs` route uses the visible Japanese labels
`設定 / カタログ`; keep `/catalogs` and catalog identifiers exact. A term such as
`catalog`, `session`, or `workflow` is vocabulary, not a product noun, and is
translated.

## Japanese terminology

- **Subagent and child agent:** Japanese uses `サブエージェント` for both
  `subagent` and `child` / `child agent` (`サブエージェントの実行`,
  `書き込み可能なサブエージェント`), so the `/subagents` and Workflow text names
  one kind of agent. Do not reintroduce `子エージェント`; `子セッション` (child
  session) is a separate term.
- **Catalogs view:** Japanese renders the Palette's Catalogs view as
  `カタログ`. Route prose uses the visible `設定 / カタログ` path; keep
  `/catalogs` and catalog identifiers exact.

## Message semantics and composition

- **TextGuard reports:** Findings that did not block content are reports, not
  an approval or a safety assessment. Pending decisions appear separately.
- **Sign-in confirmation deadline:** This is a time limit, not a browser window
  or dialog. Japanese uses `確認期限`.
- **Command alias:** `jz` behaves identically to `jouzu`; name both commands.
- **Help prose:** Each message covers a complete topic. Do not split sentences
  by display width. The renderer wraps prose and keeps command arguments intact,
  including `jz --session`, `/textguard strict`, and `jouzu pi --help`.
- **Model counts:** Pass a number, not an English phrase such as `5 models`.
  The catalog owns the plural form and the model noun.
- **Save warnings:** Each note is a complete sentence with its own punctuation.
  The composition message controls spacing between sentences and adds no final
  punctuation. English uses a space; Japanese and Chinese join sentences directly.

## Catalog notation

A command or identifier in the Simplified Chinese draft may use ASCII double
quotes (`"jouzu --help"`); Japanese and Traditional Chinese use ASCII backticks.
A Traditional Chinese label may end with `:`, while Simplified Chinese uses
`：`. These punctuation differences do not change the protected value inside.

After editing a catalog, run `node scripts/catalog-digest.mjs` to inspect its
digest and `node scripts/check-locales.mjs` to check catalog consistency.
