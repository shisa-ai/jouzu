# Models and catalogs

## Model selection

User `/model` or `Ctrl+L` opens Models. Type to search; Enter selects and saves the **project default**. `Ctrl+F` toggles favorite, `Ctrl+Shift+R` refreshes catalogs/providers. Outside the Palette, `Ctrl+P` cycles scoped favorites. `/status` shows the active model; a settings file alone does not.

Startup preference: explicit `--model`, resumed model, project default, last model that sent a request, user default/fallback. Session/model/scoped-model arguments can bypass project/last-used restoration. Preserve exact provider/model and catalog source; matching model names do not establish equivalent routing, privacy or cost.

Thinking is remembered per model; catalog defaults precede Pi defaults. Startup arguments, resume and scoped pins can override saved choices. Catalog-supported levels constrain selection.

`/fast` reports the session choice; `/fast on|off` selects priority/standard processing for eligible GPT Responses/Codex connections. It is separate from thinking, can cost more, survives resume, and starts off in new sessions. Change while idle; do not enable incidentally.

A switch needs context plus a 4,096-token margin to fit. Models can offer compaction and recheck; Esc cancels. Settings / Catalogs offers a global context ceiling (128K–1M or off). Local `models.json` `modelOverrides.contextWindow` overrides it; authenticated gateway models remain capped by it.

## Catalogs

Shell inspection/refresh:

```bash
jz catalog status
jz catalog status SOURCE_ID
jz catalog refresh SOURCE_ID
```

Use an actual ID from status; omit it to refresh all sources. Refresh contacts the server and updates cache. Doctor reads cached data. An external refresh does not prove a running registry reloaded; use in-session refresh or `/reload`.

Startup, `/reload`, and Models `Ctrl+Shift+R` refresh catalogs. Missing credentials skip a source. Failures retain last-valid data and show degraded status. Jouzu activates revisions as delivered, except that a complete catalog with no models replacing a non-empty one is held. The terminal opens an Accept/Reject review; Esc defers it to `/catalogs` (`U` reviews). CLI: `jz catalog accept|reject REVISION --digest SHA256 --source SOURCE_ID`, with exact values from `jz catalog status`.

Gateway catalogs override matching local routes, credentials, headers and overrides. Other catalogs update metadata while preserving local connection settings. `models.json` is never rewritten. Disabling a catalog reveals overridden local entries. Missing gateway credentials do not authorize fallback to a different provider.

## Sources and accounts

User `/catalogs`: `A` adds, Enter edits, Space enables/disables, `R` refreshes, `U` reviews a held update, `D` removes after confirmation. Changes apply live. Removing a source deletes its token, not provider credentials, favorites or recents. Use HTTPS; HTTP exposes tokens.

Files in the configuration root: `catalogs.json`, `catalog-credentials.json`, `catalog-overrides.json`, `context-policy.json`. Environment authentication stores the variable name; its value overrides saved tokens. Do not print credential files.

Built-in `shisa-api`: `https://api.shisa.ai/v1/jouzu/model-catalog`. Credential order: `SHISA_API_KEY`, saved catalog token, `/login shisa` credential in `agent/auth.json`. The built-in source can be disabled, not edited/removed. `/login shisa` and `/logout shisa` are user commands; Settings also has an account row.

`JOUZU_MODEL_CATALOG_URL` and optional `JOUZU_MODEL_CATALOG_TOKEN` supply a source only when `catalogs.json` is absent.

For missing models, check the exact source, enabled state, credential presence, held revision, last error and scoped model arguments before refreshing. Catalog-added models need text modality and context/output limits; missing thinking declarations can disable reasoning choices. Report missing/ambiguous IDs rather than substituting a model.
