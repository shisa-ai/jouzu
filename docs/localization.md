# Localization and residual English

Jouzu offers English and a Japanese preview for its own interface. This does not
mean that every screen in a session is translated or that Japanese is qualified
on every operating system, terminal, input method, or screen reader.

The source tree also contains Simplified Chinese (`zh-Hans`) and Traditional
Chinese (`zh-Hant`) draft catalogs. They are not offered as interface languages.
A request for either uses the English catalog. Response-language preferences
are separate and accept all four language tags; they instruct the model and do
not establish the quality of its output.

## Choose a language

When no preference is saved, select a startup language with:

```bash
jz --jouzu-ui-locale ja
jz --jouzu-ui-locale en
```

`JOUZU_UI_LOCALE` is the environment-variable alternative. A preference confirmed
in Settings overrides both launch inputs; saved `auto` follows the OS locale.
[Language, locale and prompt instructions](language.md) explains identity, profiles,
UI/response/artifact preferences, persistence and child inheritance in one place.
See [Configuration](configuration.md#language) for the saved `localization.json`
shape. The UI locale, response language, and artifact
policy are separate settings; changing the UI locale does not translate source
code, commands, identifiers, or existing artifacts.

The first-run prompt offers `English` and `日本語`, then asks for a response
language separately. Chinese self-names appear as unavailable interface choices.
The [Settings Language controls](palette-ux.md#settings) preview choices without
writing them. Confirmation saves the choice and refreshes supported screens.

## Translation boundaries

| Surface | Boundary |
| --- | --- |
| Jouzu catalog-backed labels and messages | Render from the English or Japanese catalog. Missing messages use English fallback. |
| Jouzu browser adapter | Tool labels use the Jouzu catalog; `tff-fetch_url` and `tff-search_web` remain unchanged. |
| Pi built-in settings, theme, thinking, trust, login, resume, tree and fork selectors | Jouzu translates their owned labels while preserving user text and restoring native state after rendering. Very narrow layouts can retain truncated native labels. |
| Third-party extensions | Own their content; Jouzu does not translate arbitrary extension labels or output. |
| Shisa account dashboard and sign-in | Open service-owned browser pages. Their language is controlled by the service. |
| Commands, tool names, model IDs, paths, URLs, and diagnostic identifiers | Stay unchanged; see the [catalog glossary](localization-glossary.md). |
| Model responses, tool output, and source errors | Are not UI translations. The response-language setting guides model explanations; quoted source text remains intact. |

Fixed effort levels and the collapsed-thinking placeholder follow the interface
language. Settings translate fixed display choices such as on/off, disabled,
and configure without changing saved values. Provider-defined effort values,
model names, theme names, transport identifiers, generated reasoning, and source
errors retain their original text.

Billing is handled by the Shisa service. Jouzu links to the account dashboard
and sign-in page; it has no CLI billing screen. See [Shisa AI account](shisa.md).

## Catalog support states

`jz doctor` reports catalog metadata, not a whole-product readiness judgment.
The state names are machine identifiers and remain in English.

| State | Meaning |
| --- | --- |
| `complete` | The catalog is offered, its metadata marks it reviewed, its recorded source digest matches, and no source message is missing. |
| `partial` | The catalog is offered but misses a message carried by the English source. |
| `stale` | The recorded source digest differs from the English source digest. |
| `fallback` | The requested catalog was not used; this run uses English instead. |
| `unsupported` | The catalog is not offered, lacks the required metadata, or cannot be used. |

`packages/cli/locales/catalog-status.json` supplies the recorded source version,
source digest, and review flag. These fields describe catalog bookkeeping; even
`complete` does not certify translation quality, upstream coverage, or native
terminal behavior. The Chinese drafts are not offered regardless of their
message counts.

## Check your installation

```bash
jz doctor
jz doctor --json
```

The JSON report contains a `fields` array. Each entry has an `id`, `section`,
`label`, and `value`; a dotted ID is not a nested JSON property.

| Field ID | Meaning |
| --- | --- |
| `localization.requested` | The resolved UI preference, including `auto`. |
| `localization.effective` | The locale selected by settings and environment resolution, before catalog fallback. |
| `localization.source` | The source that supplied that locale. |
| `localization.fallback` | A settings or locale-resolution fallback reason, when present. |
| `localization.catalogVersion` | The loaded catalog's version. |
| `localization.catalogDigest` | The loaded catalog's digest. |
| `localization.catalogFallback` | A catalog-loading fallback reason, when present. |
| `localization.catalogState` | The loaded catalog's support state, or `fallback`. |
| `localization.supportStates` | The per-catalog support states. |

The requested locale and the loaded catalog can differ. For example, a Chinese
locale request can retain its tag in `localization.effective` while
`localization.catalogState` is `fallback` and the digest belongs to English.

The report also summarizes a recorded set of display surfaces under
`upstream.*` field IDs. Those counts describe the record, not a percentage of
translated strings or proof that every surface was checked against the installed
Pi version. Version changes require the checks in
[Pi update review](PI-UPDATES.md#localization-re-inspection).

`jz doctor` reads local data without a network check. For rendering and manual
terminal procedures, see [CJK verification](localization-cjk-verification.md).
