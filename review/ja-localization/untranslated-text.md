# English remaining in the Japanese interface

Static inventory for source commit `a5a33f775c32c0b6ad8f5675c20c2c0b9db1320d` (`jouzu-ja`), inspected on 2026-10-26. No localization fixes are included in this inventory.

This list covers untranslated **user-visible product text**, including nested menus and bundled dependencies. It groups related strings rather than claiming a count of individual untranslated sentences. It is not an exhaustive export of every English literal in the repository. Comments, tests, documentation, model instructions, user content, and raw external errors are separate boundaries, not missing interface translations.

## How to read the list

- **Hard-coded:** Display text bypasses the localization catalog.
- **English default:** Japanese translations exist, but a caller does not pass the selected catalog and the helper uses English.
- **Dependency English:** A bundled Pi or extension screen uses its own English text rather than the Jouzu catalog.
- **Raw value:** A status, setting, or saved-content value is printed verbatim. A translated display label can be considered separately from the stored value.
- **Retained by policy:** English deliberately preserved by the [glossary](../../docs/localization-glossary.md), not a missing translation under that policy.

Examples preserve English source wording. `{…}` and named braces stand for runtime data, not additional untranslated words. Locations refer to the inspected revision; line numbers will move after fixes.

### What the automated checks establish

- `node scripts/check-locales.mjs` passes: English and Japanese each contain **1,577 message IDs**, with no Japanese IDs missing.
- A parsed comparison finds **29 exact-equal English/Japanese entries**. These include product names, technical values, language self-names, and placeholder-only messages; equality is not a defect count.
- `node scripts/check-direct-strings.mjs --all` passes: **169 detected direct strings** are covered by **165 allowlist entries**. Its syntactic detection and exclusions do not find every reachable display string.

The menu findings below therefore cannot be reduced to missing catalog keys.

## 1. Jouzu menus and sub-menus

Paths in this section are relative to the repository root.

### Workflow

| ID | Screen / action | Remaining English | Source and classification |
| --- | --- | --- | --- |
| J01 | Workflow → definition or concurrency form; browse footer | `save`, `change`, `close`, `cancel` | `packages/cli/src/workflow.ts:927,936`. **Hard-coded** action labels. The keys themselves remain unchanged. |
| J02 | Workflow → confirmation, output, model search, run detail | `Confirm`, `Output`, `Search`, `Run` | `packages/cli/src/workflow.ts:972,1001,1013,1034`. **Hard-coded** body headings, separate from translated title suffixes. |
| J03 | Workflow → Launch workspace; run usage | `default`; `{count} tokens` | `packages/cli/src/workflow.ts:710,1064`. **Hard-coded** metadata/unit. |
| J04 | Workflow → agent list or definition → current model | `Same as this session` | `packages/cli/src/subagents/model-display.ts:19`, called at `packages/cli/src/workflow.ts:466,532`. **Hard-coded** helper result. The corresponding model-chooser option is already localized at `workflow.ts:669`. |
| J05 | Workflow → definition/concurrency → Save invalid values | `Validation: Concurrent agents must be 1–32.`; `Validation: role IDs must be unique lowercase names using letters, numbers, hyphens, or underscores.`; `Validation: invalid role tools or judging setting.`; `Validation: reviewing roles may use only read, grep, find, and ls.` | `packages/cli/src/subagents/roles.ts:246–252,276,286,291`. **Hard-coded** validation displayed through `packages/cli/src/workflow.ts:200–202`. |
| J06 | Same validation paths | `Role ID`, `Description`, `Model`, `Instructions`, `Timeout seconds`, `Maximum turns` within error messages | `packages/cli/src/subagents/roles.ts:273,296–305`. English field names enter otherwise localized templates or integer validation. |
| J07 | Workflow → load/save definitions under storage, size, lock, or revision failure | `Storage: agent configuration must be a regular file under 2 MB.`; `Validation: agent definitions must fit in 2 MB. Shorten the instructions or remove unused definitions.`; `Storage: another session is saving agents. Retry the save.`; `Storage: agent definitions changed in another session. Cancel and reopen the form.` | `packages/cli/src/subagents/roles.ts:328,337,342,346`. **Hard-coded** recovery instructions. |
| J08 | Workflow → Runs → Read output before output exists | `No output yet.` | `packages/cli/src/subagents/manager.ts:386` → `packages/cli/src/workflow.ts:979`. The tool-result renderer has a localized path, but Workflow reads the service text directly. |
| J09 | Workflow → run detail → Result; saved result events | `Previous execution could not be verified. Inspect the workspace before resuming.`; `Agent timed out. Work is incomplete.`; `Storage failed while recording this agent. Work is incomplete.`; `Agent exited before a complete result was recorded. Inspect its output before retrying.`; `Agent cancelled. Inspect its changes before continuing.`; parent-session closure notices | `packages/cli/src/subagents/manager.ts:334,580,621,642,695,745,756` → `packages/cli/src/workflow.ts:1068–1069`. Jouzu-generated English becomes saved result content. Do not translate existing model/provider output retroactively. |
| J10 | Same result display | `Agent limit reached. Work is incomplete.`; `Agent failed. Check the selected model and provider authentication, then retry.`; `Agent stopped without a complete answer`; `Provider error:`; `Partial response:`; language-limitation, cancelled-schedule, and review-candidate wrappers | `packages/cli/src/subagents/worker.ts:252–261,330`; `packages/cli/src/subagents/manager.ts:649–667`. Locally generated prose is English; embedded source errors and child answers are not UI translations. |

The fallback `select` at `packages/cli/src/workflow.ts:926` is also English, but a normal non-error menu path requiring that fallback was not established.

### Settings, Catalogs, and account actions

| ID | Screen / action | Remaining English | Source and classification |
| --- | --- | --- | --- |
| J11 | Settings → Catalogs → Add/Edit → bearer authentication | `Enter the variable name, not the token. Set it before launching Jouzu, for example with export NAME=… in ~/.bashrc or ~/.zshrc. The environment value is never saved.` | `packages/cli/src/catalog-settings.ts:2075`. **Hard-coded** guidance; low-priority guidance rows may disappear on short terminals. |
| J12 | Same form → saved token | `Optional: enter a token to save it in Jouzu's private credential store. The variable takes precedence when set.`; `A token is saved for this source; leave this empty to keep it, or enter a new one to replace it.`; environment-variable precedence warning | `packages/cli/src/catalog-settings.ts:2104,2111,2118–2125`. **Hard-coded** guidance. |
| J13 | Catalog source list | `reserved-id conflict`; `{credentialName} not set`; `{active}/{total} active`; `Environment catalog` | `packages/cli/src/catalog-settings.ts:193,196,2552`; `packages/cli/src/catalog-sources.ts:390`. **Hard-coded** explanatory wording or generated source label, not merely a user-authored name. |
| J14 | Catalogs → enabled source → Refresh | `model catalog refresh is busy ({status})`; `Catalog authentication failed (HTTP 401). Sign in again or update this source's saved token or environment credential.`; `Catalog access was denied (HTTP 403). Check this account's catalog access with the service operator.` | `packages/cli/src/catalog-settings.ts:771` omits the catalog; `packages/cli/src/model-catalog-sync.ts:561` selects English. **English default**; messages in `packages/cli/locales/en/cli.ftl:375–380` have Japanese counterparts. |
| J15 | Catalog Add/Edit discovery or Refresh → network failure | `Catalog hostname could not be resolved. Check the endpoint, DNS, and VPN connection.`; `The catalog connection was refused. Check the endpoint and proxy address.`; general network/proxy/certificate recovery | `packages/cli/src/catalog-sources.ts:942`; `packages/cli/src/model-catalog-sync.ts:639`; default at `packages/cli/src/catalog-failure.ts:116–120`. **English default**, independent of J14. Message family: `packages/cli/locales/en/cli.ftl:397–413`. |
| J16 | Catalog Add/Edit → invalid token, URL, or saved credential store | `token must be non-empty, bounded, and control-free`; `catalog source URL must not contain a query or fragment`; `catalog source URL must use HTTP or HTTPS`; `catalog credentials require schemaVersion 1 and a tokens object`; `catalog credentials must be a bounded regular file` | Calls at `packages/cli/src/catalog-settings.ts:649,660,701,706` omit catalogs; helper defaults at `packages/cli/src/catalog-sources.ts:296–310,547–548,578–612`. **English default**. Direct URL normalization is conditional on discovery being skipped. |
| J17 | Settings opens with invalid context policy | `context policy must be an object`; `context policy has unknown keys: {keys}`; schema-version and context-token-range validation | `packages/cli/src/catalog-settings.ts:797–805` calls `loadContextPolicy` without the catalog accepted at `packages/cli/src/context-clamp.ts:75`. **English default** inside a Japanese warning. |
| J18 | Account → Sign out → result | `Signed out of Shisa.`; `Signed out locally. Disconnect this device in the Shisa dashboard to revoke its key.`; credential-removal recovery; `SHISA_API_KEY remains set…` explanation | `packages/cli/src/catalog-settings.ts:2446` omits the catalog accepted at `packages/cli/src/shisa-link/logout.ts:104–108`. **English default**. Confirmation is separately localized. |
| J19 | Account → Connect → saved credentials but failed/interrupted confirmation | `Shisa sign-in was saved, but confirmation failed. Sign in again to avoid losing access after the confirmation deadline.`; corresponding `confirmation was interrupted` sentence | Login options at `packages/cli/src/catalog-settings.ts:2383–2391` omit catalog; callback at `:2381` displays progress text; default/emission at `packages/cli/src/shisa-link/device-flow.ts:462,591–596`. **English default**. The subsequent completion warning is separately localized, so this may be transient. |
| J20 | Settings → About, or `/about` | `Running Jouzu {version}`; `Started {started}`; `Installed Jouzu {version}`; `unavailable`; `Installed build differs. Restart Jouzu to load it.` | `packages/cli/src/main-cli.ts:542–545` omits the catalog; `packages/cli/src/runtime-diagnostics.ts:48–53` defaults to English; displayed at `packages/cli/src/catalog-settings.ts:2860–2874`. **English default**. |
| J21 | Settings → Dashboard / Auto labels → change with invalid existing policy | `Dashboard policy must be an object.`; `Dashboard mode must be compact, expanded, or hidden.`; `Cannot save dashboard policy: …`; `Invalid label settings.`; `Label settings require schemaVersion 1 and an enabled boolean.`; `Cannot save label settings: …` | `packages/cli/src/dashboard-policy.ts:19–37`; `packages/cli/src/label-policy.ts:27–45`; caught at `packages/cli/src/catalog-settings.ts:1717–1723,1758–1764`. **Hard-coded** causes inside localized wrappers. |

### Models, Session Line, and work dashboard

| ID | Screen / action | Remaining English | Source and classification |
| --- | --- | --- | --- |
| J22 | Models → smaller-context model → compact-and-switch failure | `Compaction completed, but the active context still does not fit {provider}/{modelId}. Choose a larger-context model.`; `Compaction failed: {message}` | `packages/cli/src/model-picker.ts:189,196,199`; errors displayed at `:451–457`. **Hard-coded** sentence/prefix. Source-error suffix stays unchanged. |
| J23 | Slash-command completion/help | `/catalogs`: `Open Jouzu catalog settings`; `/about`: `Show Jouzu runtime and installed builds` | `packages/cli/src/model-picker.ts:1279,1291`. **Hard-coded** descriptions, unlike model-facing tool descriptions. |
| J24 | Session Line → missing shortcut | `unbound` | `packages/cli/src/main-cli.ts:589`. **Hard-coded** display fallback, matching the [manual observation](iyke-ja-ui-review.md). `Unbound` also exists as an internal key sentinel at `packages/cli/src/keybinding-hints.ts:42`; preserve comparison behavior separately from the displayed label. |
| J25 | Session Line → active agents/jobs | `1 subagent`, `{count} subagents`, `1 job`, `{count} jobs` | `packages/cli/src/session-activity.ts:28,30`. **Hard-coded** activity counts, passed by `packages/cli/src/main-cli.ts:665–688`. |
| J26 | Work dashboard → section counts | `{count} running`, `{count} open`, `{count} done`, `{count} failed` | `packages/session-ui/src/work-dashboard-renderer.ts:88–91`. **Hard-coded** count prose; section names are already localized. |

## 2. Raw values and deliberately retained English

These belong on an inventory of visible non-Japanese text, but are not interchangeable with untranslated sentences.

| Surface | Values / content | Source / boundary |
| --- | --- | --- |
| Palette navigation and headings | `Models`, `Workflow`, `Settings`, `Catalogs`, `About`, `Dashboard`, `Session UI`, `Jouzu Help`, `Palette`, `Jouzu Palette` | **Retained by policy:** `docs/localization-glossary.md:31–34`. Tabs at `packages/cli/src/palette.ts:62–65`; Japanese catalog retains heading/view names. Full Japanese navigation requires a terminology-policy change, not just a catalog-key repair. |
| Workflow run states | `queued`, `starting`, `running`, `completed`, `failed`, `cancelled`, `interrupted` | **Raw values:** `packages/cli/src/workflow.ts:490,1034`. The subagent tool-result renderer separately localizes statuses at `packages/cli/src/subagents/render.ts:39–46,65–67`. |
| Workflow settings | `main`, `child`, `both`; thinking levels and context modes | `packages/cli/src/workflow.ts:540,561–563,1041–1056`. Technical setting values; thinking/mode values are protected by the glossary. |
| Catalog states/outcomes | `unconfigured`, `empty`, `active`, `stale`, `disabled`; `activated`, `quarantined` | `packages/cli/src/catalog-settings.ts:194,198,780`. **Raw values** inside rows or localized sentences. |
| Catalog quarantine diagnostics | `mass_removal`, `mass_addition` | `packages/cli/src/model-catalog-sync.ts:497–499` → `packages/cli/src/catalog-settings.ts:722–725`. Diagnostic identifiers. |
| Language settings provenance / artifact policy | `cli`, `env`, `config`, `session`, `builtin`; `comments=preserve documentation=project` and related pairs | `packages/cli/src/catalog-settings.ts:1472–1486`; `packages/cli/src/language-settings.ts:165–169`. **Raw configuration values.** |
| Dashboard row state | `failed`, `cancelled`, `waiting`, `paused` | `packages/session-ui/src/work-dashboard-renderer.ts:110`. **Raw display state**, distinct from J26's count prose. |
| Expanded subagent result | `input`, `output`, `cacheRead`, `cacheWrite`; review and event/control state tokens | `packages/cli/src/subagents/render.ts:129–132,146,234–240`. Data keys/states. |
| Default role definitions | English descriptions and instructions, including `Implement and test an assigned change` | `packages/cli/src/subagents/roles.ts:194–224`. Editable definition content. Do not translate existing saved definitions merely because the UI locale changes. |
| Language picker | `English`; each language's self-name | `packages/cli/src/language-choice.ts:64–66`. Intentional discoverability behavior. |
| Voice transcript | `[garbled]` | `packages/cli/src/voice/integration.ts:146–148`; protected by the Japanese catalog's voice-boundary comment. |
| Brands and technical values | Product/provider/model names, commands, paths, URLs, keys, locale tags, versions, hashes, diagnostic codes | Preserve exact technical values. Their presence is not evidence of untranslated explanatory prose. |

## 3. Bundled Pi screens

**Owner:** `@earendil-works/pi-coding-agent@1.4.0` unless otherwise stated. These are **dependency English**, outside Jouzu's catalog, but visible in a Japanese session.

Paths in this section use these installed roots:

- **Pi:** `packages/cli/node_modules/@earendil-works/pi-coding-agent/dist/`
- **Pi TUI:** `packages/cli/node_modules/@earendil-works/pi-tui/dist/`
- **Pi AI:** `packages/cli/node_modules/@earendil-works/pi-ai/dist/`

`components/` below abbreviates Pi's `modes/interactive/components/`; `interactive-mode.js` abbreviates Pi's `modes/interactive/interactive-mode.js`. Installed dependencies are not tracked repository files; use the pinned package versions when locating them in another checkout.

### `/settings` and nested menus

`/settings` reaches Pi's selector at `interactive-mode.js:2507–2510,4002–4051`. This is distinct from Jouzu's Palette Settings view.

| ID | Area | Remaining English | Source relative to Pi root |
| --- | --- | --- | --- |
| P01 | Context and messages | `Auto-compact`, `Steering mode`, `Follow-up mode`, `Hide thinking` and their descriptions | `components/settings-selector.js:271–286,320–326` |
| P02 | Providers and transport | `Transport`, `Session share destination`, `HTTP idle timeout`, `Cache warming` and descriptions | `components/settings-selector.js:292–319` |
| P03 | Rendering/startup | `Mermaid diagrams`, `Cache miss notices`, `Collapse changelog`, `Quiet startup`, `Install telemetry` | `components/settings-selector.js:327–361` |
| P04 | Trust/navigation | `Default project trust`, `Double-escape action`, `Tree filter mode` | `components/settings-selector.js:362–382` |
| P05 | Terminal layout | `TUI mode`, `Fullscreen exit output`, `Fullscreen scrollbar`, `Fullscreen copy on select`, `Fullscreen wheel scrolling` | `components/settings-selector.js:488–522` |
| P06 | Images | `Show images`, `Image width`, `Auto-resize images`, `Block images` | `components/settings-selector.js:540–572`. First two depend on terminal capabilities. |
| P07 | Editor/output | `Skill commands`, `Show hardware cursor`, `Editor padding`, `Output padding`, `Autocomplete max items`, `Clear on shrink`, `Terminal progress` | `components/settings-selector.js:574–634` |
| P08 | Warnings submenu | `Warnings`; `Anthropic extra usage`; `Warn when Anthropic subscription auth may use paid extra usage` | `components/settings-selector.js:38–39,383–384` |
| P09 | Per-model thinking submenu | `Default thinking level per model`; `none`; `{count} configured`; `Per-Model Thinking Level`; `Select a model to configure`; `No models available`; `Log in to a provider or configure an API key first` | `components/settings-selector.js:68–69,393–429` |
| P10 | Same → model choice | `Thinking Level for {model}`; `Select default thinking level for this model`; `(clear override)`; `Revert to global default ({level})` | `components/settings-selector.js:442–460` |
| P11 | Thinking descriptions | `No reasoning`; `Very brief reasoning (~1k tokens)`; `Light reasoning (~2k tokens)`; `Moderate reasoning (~8k tokens)`; `Deep reasoning (~16k tokens)`; `Extra-high reasoning (~32k tokens)`; `Maximum reasoning` | `components/settings-selector.js:12–18`. Descriptions are prose, separate from protected level identifiers. |
| P12 | Theme selection | `Theme`; `Select a theme, or choose automatic to follow terminal appearance.`; `Theme created from your terminal's colors`; `automatic`; `Use separate themes for light and dark terminal appearance` | `components/settings-selector.js:78,91–92,154,529–530` |
| P13 | Theme → automatic/light/dark | `Automatic Theme`; `Choose themes for terminal light and dark appearance.`; `Light/dark detection requires terminal support.`; `Light theme`; `Light Theme`; `Select the theme to use for light terminal appearance`; corresponding dark-theme strings | `components/settings-selector.js:171–194` |
| P14 | Theme actions | `Apply`; `Save and go back`; `save and go back`; `Change mode`; `Switch to one theme for light and dark`; `switch to single theme` | `components/settings-selector.js:201–211` |
| P15 | Shared submenu hints | `Type to filter · Enter to select · Esc to go back`; `Enter to select · Esc to go back`; `Step {current}/{total}` | `components/settings-submenu.js:51–54,124` |
| P16 | Shared settings-list hints/empty states | `No settings available`; `No matching settings`; `Type to search · Enter/Space to change · Esc to cancel`; `Enter/Space to change · Esc to cancel` | **Pi TUI** `components/settings-list.js:64,72,248–250`; also used by extension settings panels. |

Descriptions adjacent to the main labels are English too, for example `Automatically compact context when it gets too large` (`settings-selector.js:272`), `Color theme for the interface` (`:530`), and `Use the terminal cursor instead of Pi's drawn cursor` (`:584`).

### Authentication and session navigation

| ID | Navigation | Remaining English | Source relative to Pi root unless specified |
| --- | --- | --- | --- |
| P17 | `/login` → method/provider | `Sign in with an account`; `Sign in with an API key`; `Sign in with {provider}`; `Select authentication method:`; `Select authentication method for {provider}:`; no-method/provider states | `interactive-mode.js:4875–4942` |
| P18 | Provider selector | `Select provider to configure:`; `Select provider to logout:`; `API key`; `account`; `subscription`; `not configured`; `configured`; `No providers available`; `No providers logged in. Use /login first.`; `No matching providers` | `components/oauth-selector.js:6–25,61,126–131` |
| P19 | Login dialog / authentication URL | `Login to {provider}`; `Enter code: {code}`; `e.g., {example}`; `to cancel`; `to submit`; `to close`; `Cmd+click to open` / `Ctrl+click to open`; `to copy`; `Copied URL to clipboard`; `Waiting for authentication...` | `components/login-dialog.js:34,102,113,127–131,160,170`; `components/auth-url.js:20–30`; `interactive-mode.js:5226–5231` |
| P20 | Login/logout result or failure | `No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.`; `Logged out of {provider}`; stored-key removal explanation; `Could not read stored credentials:`; `Logout failed:`; `Failed to save API key for {provider}:`; `Failed to login to {provider}:`; `Logged in to {provider}`; `Saved API key for {provider}`; `Credentials saved to {path}`; `Refreshing model catalog…` | `interactive-mode.js:4975–5014,5070–5085,5160,5277`. Raw credential/source-error details are excluded. |
| P21 | `/login` → Anthropic account | `Select Anthropic login method:`; `Browser login (default)`; `Copy code login (headless)`; browser/code instructions and `Exchanging authorization code for tokens...` | **Pi AI** `auth/oauth/anthropic.js:148,191,200,238–241` |
| P22 | `/login` → Amazon Bedrock API authentication | `Select Amazon Bedrock authentication method:`; `Bearer token`; `AWS profile`; `Existing AWS credential chain`; `Enter Amazon Bedrock bearer token`; `Enter AWS profile name`; `Configure AWS credentials, then press Enter to continue` | **Pi AI** `providers/amazon-bedrock.js:15–49` |
| P23 | `/login` → Google Vertex AI | `Select Google Vertex AI authentication method:`; `Google Cloud API key`; `Application Default Credentials`; `Service account credentials file`; key/project/location/file-path prompts | **Pi AI** `providers/google-vertex.js:16–48` |
| P24 | Other conditional provider flows | Cloudflare API key/account/Gateway prompts; `Select OpenAI Codex login method:` and browser/device choices; Radius browser/device choices; `GitHub Enterprise URL/domain (blank for github.com)` | **Pi AI** `providers/cloudflare-auth.js:39–61`; `auth/oauth/openai-codex.js:327–330`; `auth/oauth/radius.js:222–227`; `auth/oauth/github-copilot.js:339`. Requires that provider to be advertised and selected. |
| P25 | `/resume` | `Resume Session (Current Folder)`; `Resume Session (All)`; `Sort:`; `Threaded`; `Recent`; `Fuzzy`; `Name:`; `All`; `Named`; `Loading`; hints `scope`, `sort`, `named`, `delete`, `path`, `rename`; regex/exact-search hint | `components/session-selector.js:109–154` |
| P26 | Session delete/rename/empty/error | `Delete session?`; `confirm`; `cancel`; `Cannot delete the currently active session`; `Session moved to trash`; `Session deleted`; `Failed to delete:`; `No sessions found`; current-folder/named variants; `Rename Session`; save/cancel hint; `Failed to load sessions:` | `components/session-selector.js:134,338,359–371,717–723,748–752,854` |
| P27 | `/tree` → navigation/label | `Session Tree`; `No entries found`; `Type to search:`; `move`, `page`, `branch`, `copy`, `label`, `label time`, `cycle`; `Label (empty to remove):`; `save`; `cancel` | `components/tree-selector.js:540,1029–1087,1147–1149,1202` |
| P28 | Tree → branch summary/navigation | `Summarize branch?`; `No summary`; `Summarize`; `Summarize with custom prompt`; `Custom summarization instructions`; `Already at this point`; `Branch summarization cancelled`; `Navigation cancelled`; `Navigated to selected point`; `Selected entry has no text to copy` | `interactive-mode.js:4613,4624–4638,4675–4690,4711` |
| P29 | Built-in slash-command completion/help | `Open settings menu`; `Select model (opens selector UI)`; `Navigate session tree (switch branches)`; `Set thinking level`; `Configure provider authentication`; `Remove provider authentication`; session, export/import/share, trust, shortcut, compaction, reload, and other command descriptions | `core/slash-commands.js:3–26`. The descriptions are English even when a command's destination is a localized Jouzu view. |

Jouzu's explicit Shisa actions do not replace every generic Pi authentication selector. Browser service pages are outside this static inventory.

### Conditional Pi model picker

Normal `/model` entry is intercepted by Jouzu's catalog-backed picker (`packages/session-ui/src/prompt-frame.ts:141–144,163–171`; `packages/cli/src/main-cli.ts:683–684`). Pi's installed picker is a fallback path, not evidence that the normal Models screen is wholly English.

Pi's `components/model-selector.js:34,67,90,138–162,200–205,266,289,294` contains `Refreshing model catalogs…`, `Only showing models from configured providers. Use /login to add providers.`, select/default/cancel hints, refresh timeout/failure notices, `Scope:`, `all`, `scoped`, `default`, `No matching models`, and `Model Name: {name}`. Fallback execution was not reproduced.

## 4. Bundled extension menus and transcript displays

All paths in this section are relative to `packages/cli/node_modules/<package>/`. These are **dependency English**. The selected entry files are recorded in `packages/cli/release-extensions.json`; Jouzu loads them through `packages/cli/src/release-extensions.ts:241–278,628–643`.

### `pi-code-previews@0.1.36`

| ID | Screen / display | Remaining English | Package-relative source |
| --- | --- | --- | --- |
| E01 | `/code-preview-settings` → categories | `Appearance`; `Output previews`; `Enabled tools`; `Warnings & safety`; `Advanced`; `file & defaults`; category descriptions | `src/settings/ui/index.ts:48–94` |
| E02 | Output previews → groups | `Read previews`; `Write previews`; `Edit diff previews`; `Search/list previews`; `Bash previews` | `src/settings/ui/index.ts:164–193` |
| E03 | Appearance / diff settings | `Syntax theme`; `Tool call background`; `Tool call timing`; `Read line numbers`; `Syntax highlighting`; `Find/ls path icons`; `Diff background`; `Word-level diff emphasis`; `Edit diff preview`; `Edit diff preview lines` | `src/settings/ui/registry.ts:72–93,122–128,164–195` |
| E04 | Preview settings | `Read preview lines`; `Read content preview`; `Write code preview`; `Write preview lines`; `Grep preview lines`; `Grep result preview`; `Find result preview`; `Ls result preview`; `Find/ls preview lines`; `Bash result preview` | `src/settings/ui/registry.ts:99–174` |
| E05 | Safety / advanced | `Bash visual warnings`; `Secret value warnings`; `Settings file`; `Restore defaults`; `keep current`; `reset now` | `src/settings/ui/registry.ts:177–223` |
| E06 | Theme / enabled-tools submenus | `Select a Shiki theme for code previews.`; `Enter to select · Esc to go back`; `Preview tools`; `Toggle tool previews individually. Changes take effect after /reload.`; `{tool} preview`; `currently active`; `takes effect after /reload`; tool-ownership conflict explanation | `src/settings/ui/submenus.ts:94–96,123–134,162–167` |
| E07 | Save/reset/health | `Code preview settings reset to defaults`; `Failed to save code preview settings:`; `Shiki initialized:`; `Syntax highlighting:`; `Tool call background:`; `Tool call timing:`; `Configured tools:`; `Settings file:` | `src/commands/panels/settings.ts:36–39`; `src/settings/persistence.ts:21`; `src/commands/health.ts:24–48` |
| E08 | Shared tool timing/expansion | `Elapsed`; `Took`; `expand`; `Showing {shown} of {total} {label}`; `{count} lines hidden` | `src/preview/tool-timing.ts:84`; `src/preview/format.ts:111,132–142` |
| E09 | Read renderer | `Read failed`; `Empty file`; `Syntax highlighting skipped for large file`; `Output truncated by read` | `src/tool-renderers/read.ts:47,91–96` |
| E10 | Write renderer | `Write failed`; `✓ Write applied`; `diff skipped for large content`; `diff skipped for complex rewrite`; `Rendering write diff…`; `✓ Write applied · no changes`; `previous content unavailable`; `✓ New file`; `Empty content` | `src/tool-renderers/write.ts:107–220` |
| E11 | Edit renderer | `Editing…`; `Edit failed`; `✓ Edit applied`; `Rendering proposed edit diff…`; `Rendering edit diff…`; `Proposed edit {n}/{total}`; `proposed edit` | `src/tool-renderers/edit.ts:99–126,171,252–257` |
| E12 | Search/list/bash renderers | `Grep failed`; `No matches found`; `Find failed`; `No files found`; `List failed`; `Empty directory`; `No output`; `Output truncated by bash`; `Full output:`; `Preview {count} warning:` | `src/tool-renderers/grep.ts:51–62`; `find.ts:28–30`; `ls.ts:26–28`; `bash.ts:49,84–90` |

These renderer features are enabled by default (`src/settings/defaults.ts:18–40`), subject to another extension owning a tool (`src/tool-renderers/registration.ts:37–68`). File contents, shell output, and underlying errors are not translation defects.

### Other bundled extensions

| ID | Owner / navigation | Remaining English | Package-relative source |
| --- | --- | --- | --- |
| E13 | `pi-schedule-prompt@0.4.1` → `/schedule-prompt` root/settings | `Scheduled Prompts`; `Jobs`; `Settings`; `Widget visibility: shown/hidden`; `Bind new jobs to session: yes/no`; `Back`; session-only persistence warnings | `src/index.ts:154,198–225` |
| E14 | Same → Jobs | `Jobs`; `a add`; `q quit`; `select`; `toggle`; `scope`; `remove`; `cleanup`; empty-state instructions; `Other sessions (read-only):`; removal confirmations; `Type:`, `Next:`, `Last:`, `Runs:`, `Selected:`, `Prompt:` | `src/ui/jobs-view.ts:160–211` |
| E15 | Same → Add | `Job Name`; `Enter a name for this scheduled prompt`; `Job Type`; `Cron (recurring)`; `Once (one-shot)`; `Interval (periodic)`; `Schedule`; `Prompt`; `Enter the prompt to execute`; `Scope`; session/shared-scope explanations; `Confirm`; save/duplicate/created notices | `src/ui/add-flow.ts:22–106` |
| E16 | Same → tool display/widget | `Adding cron job:`; `Removing cron job:`; `Updating cron job:`; `Listing all cron jobs`; `Error:`; `Cron Jobs:`; `Scheduled Prompts`; `{count} jobs`; `in …`; `… ago` | `src/tool.ts:341–410`; `src/ui/cron-widget.ts:41,127`. Widget visibility depends on settings/jobs. |
| E17 | `@lhl/pi-tasks@0.6.1` → `/tasks` | `Tasks`; `View all tasks ({count})`; `Create task`; `Start auto mode`; `Stop auto mode (currently {mode})`; `Clear completed ({count})`; `Clear all ({count})`; `Settings`; `No tasks`; `← Back`; `▸ Start (in_progress)`; `✓ Complete`; `✗ Delete`; `Task subject`; `Task description` | `src/index.ts:1400–1523` |
| E18 | Same → auto-mode notices | `Task #{id} still in progress:`; `✓ Mark complete`; `▸ Continue (re-queue this task)`; `✗ Stop auto mode`; `Auto mode stopped.`; `Marked task #{id} complete.`; `Auto mode finished — all tasks complete.`; `Auto-advance mode disabled.` | `src/index.ts:319–345,385,1366` |
| E19 | Same → Settings | `⚙  Task Settings`; `Task storage`; `Auto-advance mode`; `Show task widget`; `Collapse completed tasks`; `Max visible tasks in widget`; `Auto-clear completed tasks`; descriptions including `Show the task panel above the editor. Hiding it does not pause tasks or change auto-advance.` | `src/ui/settings-menu.ts:35–83,137` |
| E20 | `@vanillagreen/pi-background-tasks@2.0.0` → `/bg` | `Background Tasks`; running/finished counts; `No background tasks yet. Use /bg run <command> or the bg_task tool.`; `Tasks`; `Watch {id}`; `Status`; `Started`; `Expiry`; `Command`; `Cwd`; `Log`; `Wakeups`; `Output`; select/overflow instructions; pane/stop/clear/follow/page/expand/collapse hints | `extensions/dashboard.ts:170–217,291` |
| E21 | Same → command/error/delivery | `No background task matched that id or pid.`; `Started … in the background.`; `Removed … finished background task(s).`; `Unknown /bg action. Try …`; state-persistence and completion-delivery recovery notices | `extensions/registrations.ts:232–257`; `extensions/background-tasks.ts:207,460` |
| E22 | Same → transcript | `Background task output`; `Background task … finished`; `Recent output`; `(no output yet)`; `Full background log:`; starting/tailing/stopping/clearing/checking labels; `Background results · No reply needed`; `Background task started`; `Background tasks cleared` | `extensions/render.ts:266–375` |
| E23 | `pi-multiloop@0.4.1` → list/status/archive | `No loops registered.`; `Active / resumable`; `Paused`; `Completed / stopped`; `Archived`; `pi-multiloop status`; `Attached running loops:`; `Detached resumable loops:`; `Inactive/history:`; no-state and archive/error notices | `extensions/pi-multiloop/index.ts:614–681,1849–1898` |
| E24 | Same → `/goal` and replace-active submenu | `No goal is active. Start one with /goal <objective>.`; `Goal started:`; `Resumed goal`; `Kept the current goal.`; `A goal is already active.`; `Proposed objective:`; pause/stop-current-and-start-new choices; `Keep the current goal` | `extensions/pi-multiloop/index.ts:1959,2142–2199` |
| E25 | Same → summary cards/help | `Goal complete`; `Run complete`; goal/run stopped/paused; `Resume with`; `elapsed`; `active`; `turns`; `tool calls`; `tokens`; `iterations`; `Two ways to start:`; `Modes:`; `Commands:`; command descriptions | `extensions/pi-multiloop/summary.ts:95–153`; `index.ts:2394–2428`. Setup branches send model prompts, not a separate implemented menu wizard. |
| E26 | `@sting8k/pi-vcc@0.10.2` → compaction/recall | `Compacted with pi-vcc`; `Nothing to compact`; recent-tail explanation; `Compaction failed:`; kept/summarized notices; `No session file available.`; invalid history/page/range explanations; `{count} total matches` | `src/commands/pi-vcc.ts:17,27–36`; `src/hooks/before-compact.ts:135–164`; `src/commands/vcc-recall.ts:20`; `src/core/recall-run.ts:192,250,261,317–326` |
| E27 | `pi-webaio@1.0.5` → fetch transcript | `Fetching {url} with the static fingerprinted transport...`; `Fetch failed`; `Fetched {url} ({count} chars, truncated)`; `queued`; `fetching`; `failed`; `done`; `{count} chars`; batch headings/failure counts; `Extraction diagnostics (Defuddle):`; `additional diagnostics omitted.`; expand-for-diagnostics/retained-details hints | `dist/src/jouzu-extension.js:239,370–437,650–665,697`. The selected entry registers web tools, not an interactive settings menu. |
| E28 | Command completion descriptions | `Configure code preview settings`; `Manage scheduled prompts interactively`; `Background shell task dashboard and controls.` | `pi-code-previews/src/commands/settings.ts:6`; `pi-schedule-prompt/src/index.ts:150`; `@vanillagreen/pi-background-tasks/extensions/registrations.ts:196` |

**Visibility qualifications:** Jouzu claims the task and background widgets for its own dashboard (`packages/cli/src/main-cli.ts:618,630`). English in those extensions' standalone widget implementations is not proof it appears by default. Their commands, nested menus, and transcript renderers are separate paths. `pi-skill-dollar@0.2.1` forwards skill descriptions into completion rather than adding its own fixed English menu.

## 5. Other Jouzu CLI and flow-control text

| ID | Surface / trigger | Remaining English | Repository source and classification |
| --- | --- | --- | --- |
| C01 | `/flow runtime`, About, startup build warnings | `Runtime: Jouzu …`; `Package paths and SHA-256 hashes captured at startup:`; running/installed-build and patch-change warnings | `packages/cli/src/main-cli.ts:542–545,706`; `packages/cli/src/runtime-diagnostics.ts:52`; `packages/cli/locales/en/cli.ftl:1770–1781`. **English default**, sharing the cause of J20. |
| C02 | Missing/conflicting release extension | `Optional extension … is unavailable`; `Disabled tools:`; `Jouzu warning:`; tool-conflict disable guidance | `packages/cli/src/main-cli.ts:546,761`; defaults/display at `packages/cli/src/release-extensions.ts:435,450–456,472`. **English default**; messages already have Japanese entries. |
| C03 | Updated CLI fails to restart | `updated Jouzu could not restart: …` | `packages/cli/src/cli.ts:144` omits catalog for `relaunchUpdatedJouzu`; default at `packages/cli/src/updater.ts:916`. **English default**; Japanese counterpart exists. |
| C04 | Self-update state/download validation | `self-update state must be a regular file`; `self-update state has missing or unknown fields`; `self-update state fields are invalid`; `npm returned invalid update metadata`; `downloaded update is not a regular file`; `npm metadata changed during update download` | `packages/cli/src/updater.ts:274,290,307,417–426,461,750`. **Hard-coded** Jouzu causes inside outer error/doctor reports. Raw npm/JSON-parser errors are separate. |
| C05 | `/flow` malformed usage or off state | `/flow shows what session flow control is holding.`; command explanations; `Flow control is off for this session: nothing is intercepted, queued, or scheduled.`; delivery-path/re-enable explanation | `packages/cli/src/flow-control/flow-status-extension.ts:34–58,158,217–224`. **Hard-coded**, sent through `ctx.ui.notify`. |
| C06 | Held input or provider pause | `Flow control is holding your message:`; `Flow control is holding automated work:`; `Flow control paused after … Automated work resumes on your next message. Run /flow for details.` | `packages/cli/src/flow-control/flow-status-extension.ts:41–43,90–123`. **Hard-coded** announcements. |
| C07 | `/flow on/off/clear/retry/cancel/resume` and invalid targets | `Flow control is already on for this session.`; retained-sends/waits-ended counts; `Flow clear completed. No active reservation was found; continue with a new message.`; `Authorized a retry of …`; `Cancelled wait … Its job keeps running …`; `Resumed automated turns. They run from the next idle boundary.` | `packages/cli/src/flow-control/flow-status-extension.ts:186–204,329,350–381,396–406,421–437`. **Hard-coded** operational replies beside some catalog-backed replies. |
| C08 | Flow recovery diagnostics | `Input status unavailable`; `Job waits unavailable`; `Work status unavailable`; `saved deliveries have unresolved history`; `Waiting on unavailable job sources:`; `A provider request has no recorded outcome. Inspect /flow details before resetting; do not assume it was never sent.` | `packages/cli/src/flow-control/flow-status-extension.ts:241–288,452` → `flow-status-report.ts:123–129`. **Hard-coded** recovery descriptions/wrapper. |
| C09 | Fragments inside localized flow report | `You`; `a turn was interrupted`; `the session was reopened`; `held from /flow`; `a provider request failed`; detached-task start instructions | `packages/cli/src/flow-control/flow-status-context.ts:164`; `flow-pause.ts:10–15`; `flow-runtime.ts:128–131`. Some strings also serve persisted matching contracts; localize display without changing those contracts. |
| C10 | Visible flow notification summaries | `{count} dependencies satisfied`; `{count} results`; `+{count} more results`; `{count} results with warnings`; `notification only — no reply owed` | `packages/cli/src/flow-control/flow-message-renderer.ts:32,59,74–90`; registered at `flow-status-extension.ts:127`. **Hard-coded human presentation**, not the underlying model-facing payload. |
| C11 | Catalog cannot be read | `Jouzu could not read its interface catalog, so it is showing English; reinstall or repair Jouzu, then run "jouzu doctor".` | `packages/cli/src/locale-catalog.ts:58–59`. **Deliberate catalog-independent English recovery**, not a missing-key defect. |

## 6. Desktop launcher and installer

Normal launcher labels and Jouzu's main NSIS dialogs have Japanese dictionaries. The gaps below are mostly failures and recovery instructions returned by helpers outside those dictionaries. These are static reachability findings, not native Windows execution evidence.

| ID | Surface / trigger | Remaining English | Repository source |
| --- | --- | --- | --- |
| L01 | Launcher configuration read/change failure | `Could not read Jouzu configuration. No settings were changed.`; provider-key/profile/custom-connection/removal/default-model/sign-in/sign-out failure instructions | `packaging/launcher/control.mjs:115–124` → `apps/launcher/src-tauri/src/control.rs:98–101` → `apps/launcher/src/App.tsx:134,145,248,329–330`. **Hard-coded** sanitized failure text. |
| L02 | Incompatible configuration response | `Configuration service response is incompatible. Restart the development launcher and retry.` | `apps/launcher/src/control-state.ts:15`; normal frontend parser. **Hard-coded**, despite the development wording. |
| L03 | Configuration service busy/start/cancel/timeout | `Another configuration operation is running`; `Cannot start configuration service`; `Configuration operation cancelled or timed out; refresh status before retrying` | `apps/launcher/src-tauri/src/control.rs:28,58,86`. **Hard-coded**. |
| L04 | Folder launch/add or missing runtime | `This folder is unavailable. Choose another folder.`; `Git Bash is missing. Repair the Jouzu installation.`; `Jouzu application files are missing. Please repair the installation.`; `The terminal could not be opened.`; `Only existing folders can be added` | `apps/launcher/src-tauri/src/runtime.rs:38,50,54`; `main.rs:140,152,259–264`. **Hard-coded**. |
| L05 | Environment override read/save/validation | `Invalid environment entry`; `This variable is managed by the launcher`; `Duplicate variable name`; `Cannot read environment settings`; `Cannot save environment settings` | `apps/launcher/src-tauri/src/environment.rs:23,29,32,120,138`. **Hard-coded**; variable identifiers stay unchanged. |
| L06 | Component / application repair | `Cannot restore the terminal command`; `Git Bash installation failed`; `An update is active or interrupted. Restart the launcher and retry after the update process exits.`; `Bundled Jouzu failed its startup check. Repair the installation.` | `apps/launcher/src-tauri/src/command_path.rs:51,64`; `git_environment.rs:46`; `recovery.rs:7,22`; `update_lock.rs:15`. **Hard-coded**, sometimes replaced by helper output. |
| L07 | Launcher update failure/runtime requirement | `Jouzu update failed. Check the update source, permissions and available disk space; the active version was not intentionally removed.`; Node/pnpm-runtime/full-installer recovery | `packaging/launcher/update-service.mjs:53`; `runtime-requirements.mjs:8` → `apps/launcher/src/update-preview.tsx:109`. **Hard-coded** conditional fallback. |
| L08 | Dialog accessibility | `Close` | `apps/launcher/src/components/ui/dialog.tsx:74`. **Hard-coded screen-reader label**; default close control used by update/console-repair dialogs. Main Settings supplies its own localized close control. |
| L09 | Standalone console exits with failure | `Jouzu exited with code … Press Enter to close.` | `apps/launcher/src-tauri/src/bin/console.rs:190`. **Hard-coded**; not the shell-entry path. |
| L10 | Installer component preparation failure | `Diagnostics could not be saved.`; preparation-failed/exit-code/diagnostic-report summary | `packaging/launcher/prepare-component.ps1:64,68` → `installer-hooks.nsh:9,84–89`. English helper output inside a translated warning. |
| L11 | Installer replaces locked launcher files | `Cannot replace … Close running Jouzu sessions and retry.` | `packaging/launcher/replace-locked-launcher-files.ps1:21` → `installer-hooks.nsh:22`. **Hard-coded** message box content. |
| L12 | Setup/uninstall ownership or process-stop failure | `Cannot establish ownership of existing files. Choose an empty folder or repair the installation.`; `Close active Jouzu sessions before updating.`; `Jouzu processes did not stop within the retry limit. Close them and retry setup.` | `packaging/launcher/stop-managed-processes.ps1:15,27,43` → `installer-hooks.nsh:43`. English detail inside a translated close-failure dialog. |
| L13 | Git Bash / Windows Terminal component failures | `Git Bash is unavailable. Install it from the launcher.`; `The bundled Git Bash package is missing. Repair the installation.`; package-verification/preparation/archive and Terminal availability messages | `packaging/launcher/git-environment.ps1:109–140`; `terminal-environment.ps1:62–81`; helper output/fallback handling at `apps/launcher/src-tauri/src/launcher_script.rs:28–39`. Jouzu-authored English, excluding native PowerShell/network errors. |

## 7. Other non-Japanese repository text and coverage limits

### Separate content boundaries

- **Startup and further upstream screens:** The [Japanese review guide](../../JA-REVIEW.md#5-limits-and-priority-checks) also records Pi-owned first-launch `fd` / `ripgrep` download text and the no-model warning. Those observations were not re-run here. Other Pi screens not enumerated in the tables require a separate live/source pass; this inventory is not a claim that they are translated.
- **Public documentation and release notes:** README files, guides, and changelog prose are mostly English and are not enumerated sentence by sentence here. The launcher displays supplied update notes unchanged (`apps/launcher/src/update-preview.tsx:69–75,107`; `packaging/launcher/jouzu-notes.mjs:9–23`). This is visible English content, not a catalog-label defect.
- **Model instructions and tool metadata:** System prompts, bundled skill prose, tool/parameter descriptions, and model-facing result payloads contain English. They are separate from interactive command descriptions. Examples: `packages/cli/src/presentation.ts:133–141`, `packages/cli/src/language-contract.ts:122–126,206–208`, and the tool descriptions in installed Pi/extensions.
- **Separate Python entry point:** `python/jouzu/src/jouzu/__main__.py:13–22` contains English startup/help prose, including `show preview package diagnostics`, without a Jouzu locale lookup. It is a separate package entry point, not the npm terminal runtime.
- **Generated and external content:** Model responses/reasoning, historical sessions, user-authored role definitions, tool/file/shell output, provider errors, and service-owned browser pages are not guaranteed to be Japanese. UI locale selection does not translate them.

### Already-localized paths not to misclassify

- Most Jouzu Models search/selection/empty-state labels, flags, and footer actions use the catalog.
- Workflow's normal action rows, confirmation sentences, empty lists, and the model-chooser's “same session” option are catalog-backed; the specific bypasses are listed above.
- Settings credential state arguments such as `set`, `saved`, `stored`, and `unset` select Japanese branches rather than leaking those English words. Auto-label/account/language confirmations also have catalog-backed paths.
- CLI `UsageError` descriptors are re-rendered with the active catalog; an English source string alone does not prove English CLI output. Doctor re-localizes its report fields and diagnoses.
- The context-free renderer in `packages/cli/src/flow-control/flow-status.ts` is not the inspected live `/flow` report route, which supplies localization context.

### Evidence limits

The audit inspected source call paths in Jouzu menus, CLI/runtime/flow reports, launcher/installer helpers, and the selected installed Pi and extension entries. It did not exercise every screen, native installer, provider flow, accessibility tool, platform, failure path, or terminal size. It did not flatten every low-level exception, optional/unloaded dependency entry, build/development utility, or documentation sentence. Conditional and unverified fallback routes are marked above.

The existing `packages/cli/src/release-surface-record.ts:18–22,173–175` records Pi `1.0.0`, VCC `0.7.2`, and skill-dollar `0.2.0`, while this checkout uses Pi `1.4.0`, VCC `0.10.2`, and skill-dollar `0.2.1`. Do not treat that older ownership record as current version inspection evidence. The earlier catalog export remains a catalog inventory, not a whole-interface translation percentage.

For live follow-up, inspect the normal nested screens first (Workflow forms, Catalogs bearer guidance, Pi `/settings`, code-preview settings, `/tasks`, `/schedule-prompt`, and `/bg`), then validate conditional failure/recovery text in an isolated environment. Sign-in and destructive operations require their own explicit test precautions.
