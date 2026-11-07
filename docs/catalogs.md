# Model catalogs

A model catalog is a list of models that a server publishes for Jouzu. Catalogs add models to the Models view without editing `models.json`.

## Built-in Shisa catalog

- Source ID `shisa-api`, read from `https://api.shisa.ai/v1/jouzu/model-catalog`.
- Jouzu checks credentials in this order: `SHISA_API_KEY`, a token saved for the catalog, then the `/login shisa` credential. See [Shisa AI account](shisa.md).
- The login credential stays in `agent/auth.json`. It is not copied into the catalog token store or sent to other catalogs.
- Disable it with `Space` in Settings / Catalogs; it cannot be edited or removed. The choice is stored in `catalog-overrides.json`; re-enabling restores the defaults.
- A custom source with the same endpoint and `env:SHISA_API_KEY` credential replaces the built-in one.
- `shisa-api` is reserved. `jouzu catalog status` reports a custom source that uses it with another endpoint.

## When catalogs refresh

- On startup, on `/reload`, and with `Ctrl+Shift+R` in the Models view.
- At startup, a source that already has a catalog refreshes in the background. A source with no catalog yet refreshes before the session starts, for up to 8 seconds, showing `Fetching model catalog…`. If it does not answer, startup continues with cached and local models.
- Sources without an available credential are skipped and report no error.

## How catalog models combine with `models.json`

Catalog models can override or extend the models you define in `models.json`. The result depends on the catalog type.

- Authenticated gateway catalog models take precedence over matching `models.json` entries, including routes, credentials, headers, and `modelOverrides`.
- A gateway catalog must declare `source.type: "authenticated_gateway"`, use bearer authentication, and have a source URL whose path ends with `/v1/jouzu/model-catalog`. It connects through the gateway with the source's token and needs no local provider entry.
- Other catalogs update metadata on providers you have configured, preserving their local routes, credentials, and headers.
- Models only in `models.json` keep their configuration. Disabling a catalog shows its overridden local entries again.
- A saved catalog model keeps its source. If the gateway credential is missing, Jouzu does not fall back to a local connection.
- Jouzu never rewrites `models.json`.

## Add a custom source

1. Open Settings / Catalogs with `/catalogs`, or press `Tab` in the Palette.
2. Press `A`.
3. Enter a label and URL. A host is enough for the URL; Jouzu finds the catalog endpoint.
4. Choose the Authentication mode with `←` / `→`.
5. Press `Enter` to save, or `Esc` to cancel.

- Move between fields with `↑` / `↓`.
- Plain HTTP works with a warning: it sends the token unencrypted. Use HTTPS unless the catalog runs on your machine.

| Authentication | Stored |
| --- | --- |
| None | Nothing |
| Environment variable | Only the variable name, in `catalogs.json` |
| Token entered in the form | Stored in `catalog-credentials.json` with private permissions; never displayed |

- An environment variable overrides a saved token.
- You can save a source before its variable is set. Jouzu warns, skips it, and refreshes once the variable or a token is available.
- Removing a source, or setting its authentication to none, deletes its saved token.
- Tokens go only in the source's authorization header. Jouzu never writes them to configuration, cache, or diagnostics.

## Manage sources

| Key | Action |
| --- | --- |
| `Enter` | Edit the source |
| `→` / `←` | Expand / collapse its cached models |
| `A` | Add a source |
| `Space` | Enable or disable |
| `R` | Refresh |
| `D` | Remove, after confirmation |

- Changes apply to the current session immediately.
- Removing a custom source deletes its saved token. Provider configuration, provider credentials, favorites, and recents stay.

## Files

All files sit next to `catalogs.json`:

| Platform | Location |
| --- | --- |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/jouzu/catalogs.json` |
| macOS | `~/Library/Application Support/Jouzu/catalogs.json` |
| Windows | `%APPDATA%\Jouzu\catalogs.json` |

| File | Contents |
| --- | --- |
| `catalogs.json` | Sources: label, URL, enabled state, authentication mode |
| `catalog-credentials.json` | Tokens entered in the form |
| `catalog-overrides.json` | Built-in source enabled state |
| `context-policy.json` | [Context ceiling](models.md#context-ceiling) |

## Command line

```bash
jouzu catalog status            # all enabled sources
jouzu catalog status office     # one source
jouzu catalog refresh
jouzu catalog refresh office
```

`catalog status` shows each source's `Last error` and reports `degraded` until a refresh succeeds. Recorded errors include:

- DNS resolution, connection, or timeout
- Proxy authentication, HTTP 401, 403, or 407
- Certificate verification
- Local catalog-data access

Refresh behavior:

- Uses ETag / `304`, and validates the full response before using it.
- Keeps each source's last valid catalog when a refresh fails.
- Never follows redirects, so a token cannot reach another origin.
- Caches privately per source and account.

## Held updates

Jouzu applies each valid catalog revision as the publisher delivers it, including revisions that add, remove, or rename most models. It holds one kind of revision for review: a complete catalog with no models that would replace a catalog that has models. An empty catalog usually means the catalog server is misconfigured.

When an interactive refresh holds a revision (startup, `/reload`, Models `Ctrl+Shift+R`, or Catalogs `R`), Jouzu opens a review that shows the model counts:

- **Accept** uses the new revision.
- **Reject** discards it and keeps the current catalog. If the server still serves it, the next refresh holds it again.
- **Esc** decides later. The source shows `update held` in `/catalogs`; select it and press `U` to reopen the review.

`jouzu catalog status` prints the exact commands for each held revision:

```bash
jouzu catalog accept REVISION --digest SHA256 --source SOURCE_ID
jouzu catalog reject REVISION --digest SHA256 --source SOURCE_ID
```

## Single-source environment variables

When `catalogs.json` does not exist, `JOUZU_MODEL_CATALOG_URL` and optional `JOUZU_MODEL_CATALOG_TOKEN` define one source.

## For catalog publishers

Validate a catalog file against the version 1 contract:

```bash
jouzu catalog validate ./catalog.json
jouzu catalog conformance ./remote-catalog.json --json
```

- `conformance` additionally requires the `sequence` field that remote refreshes use.
- The JSON Schema is installed at `dist/catalog/model-catalog-v1.schema.json`. Runtime validation also rejects duplicate JSON keys, broken references, credential fields, and invalid account scope.
- To add a new model, an offering must declare `text` in `modalities` and set `limits.contextWindow` and `limits.maxOutputTokens`. Without them it can only update an existing model. `catalog status` and `jz doctor` report these gaps.
- Declare `supportedThinkingLevels` for reasoning models. Without it, a model the catalog adds has thinking disabled, and an offering that overrides a model Pi already knows keeps Pi's levels. `catalog status` lists offerings that omit it.
- Offerings whose `capabilities` omit `reasoning` are left out of that list, because Jouzu treats them as non-reasoning.
- Unknown thinking levels, including an unknown `defaultThinkingLevel`, are ignored so the catalog still loads.
- `jz doctor` reads cached data only. Run `jz catalog refresh` before checking a server change.

### First-use default priority

Set optional `metadata.default` on a model offering to recommend it when the user has no saved model choice:

```json
"metadata": { "default": 100 }
```

The value must be a safe integer. Higher values take precedence; zero and negative integers are valid, and an omitted value is not a recommendation. Equal priorities use a stable catalog-qualified identity order. Invalid values are ignored.

Jouzu considers only available, authenticated models. Explicit model arguments, scoped models, resumed sessions, and saved project or user choices take precedence. A catalog refresh does not replace a model the user selected or already used. This priority does not change the alphabetical ordering or ratings in the Models view.

### Picker ratings

Set optional `metadata.strength`, `metadata.speed`, and `metadata.cost` on each model offering to supply the [Models view ratings](models.md#model-list):

```json
"metadata": { "strength": 4, "speed": 3, "cost": 2 }
```

Each rating must be an integer from 1 through 4. Higher values mean stronger, faster, or more expensive, respectively. Jouzu ignores missing or invalid ratings independently and leaves their cells blank. When no offering in the Models list has a rating, Jouzu hides that column. Other metadata fields do not affect these ratings.

### Token prices

The Models view reads optional `metadata.price` from the selected offering:

```json
"price": {
  "currency": "USD",
  "unit": "per_1m_tokens",
  "input": 1.65,
  "output": 4.96,
  "cacheRead": null,
  "cacheWrite": null
}
```

Rates must be finite, non-negative numbers. Zero is an explicit rate; `null`, missing, or invalid fields are unknown and omitted. Jouzu shows the price line only when at least one rate is known and the currency and unit match the values above. Nested `upstreamReference` prices are not used. These display-only prices do not change provider billing or session cost accounting.
