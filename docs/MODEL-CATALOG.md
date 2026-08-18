# Jouzu Model Catalog

- **Status:** Draft design
- **Scope:** Model discovery, normalization, updates, policy filtering, user preferences, and client integration (Pi first)
- **Related:** [Usage Tracking and Cost Accounting](USAGE-TRACKING.md), [Recomposition and Controlled Evolution](COMPOSITION.md), [Harness Engineering and Jouzu](HARNESS-ENGINEERING.md), [DeepSeek Harness and Jouzu](DEEPSEEK-HARNESS.md), [Agent Control Plane](CONTROL-PLANE.md), [Delegation and Adversarial Review](DELEGATION-AND-REVIEW.md)

## Summary

Jouzu needs more than a list of provider model IDs. It needs a local, explainable view of:

- which models exist;
- where each model can be used;
- whether two providers serve the same underlying model;
- model capabilities and safe request settings;
- current rate cards and the inputs needed for cost estimates;
- jurisdiction, processing location, retention, and Zero Data Retention (ZDR) properties;
- account- and credential-specific availability; and
- user intent, including favorites and defaults that survive catalog changes.

The catalog will be assembled from multiple sources, normalized centrally where possible, distributed as signed snapshots, and combined locally with authenticated discovery, administrator policy, and user settings. A failed update must never destroy the last known-good catalog or silently weaken policy.

The primary selectable object is a provider **offering** of a canonical model. Offerings of the exact same model are grouped together. Merely similar models may be shown in the same family, but they are not interchangeable and are never used as silent fallbacks.

## Goals

1. Automatically discover available models from multiple public, provider, router, and local sources.
2. Normalize model capabilities, request settings, pricing, and provider-specific compatibility metadata.
3. Support field-level corrections and overrides without editing generated source data.
4. Preserve user favorites, defaults, and ordering as offerings are added, renamed, deprecated, or removed.
5. Filter and rank offerings by hard policy and user preferences, including jurisdiction, processing location, ZDR, retention, and cost.
6. Group multiple provider offerings of the same underlying model without confusing exact equivalence with similarity.
7. Work offline using an embedded or cached last known-good catalog.
8. Integrate with Pi first while preserving Pi provider/model IDs and local `models.json` escape hatches, without making the neutral catalog depend on Pi session or UI types.
9. Make every important decision explainable: source, freshness, override layer, exclusion reason, and fallback reason.
10. Define one versioned Jouzu interchange format that built-in provider data, Shisa.AI, codex-pool, private gateways, community compatibility packs, and additional runtime clients such as DeepSeek Harness can all use.

## Non-goals

- Selecting a “best” model solely from benchmarks.
- Treating model names as proof that two offerings are equivalent.
- Guaranteeing a provider's legal or privacy behavior without evidence and scope.
- Runtime token, cache, retry, subscription, quota, and invoice accounting; see [Usage Tracking and Cost Accounting](USAGE-TRACKING.md).
- Uploading private endpoint discoveries, credentials, user preferences, or organization policy to Jouzu services.
- Silently changing providers during an active request or retry.

## Design principles

### Separate models from offerings and routes

A model such as a dated Claude release is not the same thing as Anthropic's API offering of it, a Bedrock offering of it, or an OpenRouter route to it. Capabilities may come from the model developer, while context limits, price, retention, and processing location may differ by offering or route.

### Preserve unknown values

Policy-sensitive values are tri-state: `yes`, `no`, or `unknown`. Missing data must not be converted to a favorable default. For example, absent ZDR metadata means `unknown`, not `true`.

### Use field-specific authority

There is no universally most authoritative source. The model developer is normally authoritative for native capabilities; the serving provider is authoritative for its price and endpoint availability; an organization contract or administrator is authoritative for account-specific legal policy. Every normalized field retains provenance.

### Keep policy separate from preference

Organization policy defines what may be used. User preferences rank the allowed choices. A user override may change a label, favorite, request default, or locally asserted metadata, but it must not bypass a hard policy restriction.

### Fail safely and visibly

Catalog fetch failures retain cached data. Signature or schema failures reject the new snapshot atomically. Strict policy filters fail closed on unknown values. The UI explains stale data, rejected updates, exclusions, and fallback choices.

### Scope compatibility to the complete serving path

Request compatibility is not solely a property of a model family. It is the intersection of the model artifact and chat template, serving engine and version, server flags, provider or gateway translation, endpoint protocol, and client adapter. The same Qwen artifact may reject an OpenAI `developer` role on a raw SGLang route while appearing to accept it through a provider that rewrites it to `system`.

Compatibility observations therefore attach to the narrowest known offering, route, deployment, protocol, and adapter scope. Family-level metadata may provide a conservative default, but must not overwrite a tested route-specific result. In particular, a negative interoperability result must not be generalized to every model with a similar name, and a positive result on a translating gateway must not be attributed to the raw backend.

## Terminology and identity

### Canonical model

A specific model artifact or developer-defined release independent of where it is served.

Examples:

- a dated model release;
- a developer-defined stable alias that points to a release; or
- a local model artifact identified by a digest.

A canonical model has a stable Jouzu ID, developer, family, version or artifact identity, aliases, native capabilities, and lineage. IDs are never reused for a different artifact.

### Model family

A collection useful for navigation, such as all releases of a model line. Membership means related, not request-level interchangeability.

### Offering

A model exposed under a provider's model ID and API. The stable runtime identity remains the structured pair:

```text
(providerId, modelId)
```

Jouzu also assigns an internal `offeringId` so metadata can survive display-name changes and provider aliases. The structured pair must not be encoded by naively joining with `/`, because model IDs may themselves contain slashes.

### Route

The concrete processing route behind an offering: endpoint, region, upstream inference provider, deployment, or router constraint. A direct provider commonly has one route. A router may expose many routes for one offering, and some properties may not be known until request time.

Policy such as ZDR or location is evaluated on the route, not assumed from the canonical model.

### Exact equivalent

Two offerings are exact equivalents only when evidence shows they serve the same canonical model release or artifact with materially equivalent behavior. Quantizations, fine-tunes, distillations, model-size variants, and unverified aliases are not exact equivalents.

### Similar model

A related model that may be useful as an explicit alternative but is not equivalent. Similarity can be recorded by family, lineage, or a curated relation. It must not authorize automatic fallback.

## Data model

The distributable schema will contain at least the following records. The example is illustrative; the versioned JSON Schema will be authoritative.

```yaml
format: jouzu.model-catalog
schemaVersion: "1.0"
kind: snapshot
catalogId: ai.jouzu.public
revision: 2026-08-03T12:00:00Z+42
generatedAt: 2026-08-03T12:00:00Z
expiresAt: 2026-08-10T12:00:00Z

canonicalModels:
  - id: anthropic/claude-sonnet-4.5@20250929
    developerId: anthropic
    familyId: anthropic/claude-sonnet
    version: "20250929"
    aliases:
      - anthropic/claude-sonnet-4.5
    capabilities:
      input: [text, image]
      reasoning: true
      contextWindow: 200000
      maxOutputTokens: 64000
    lifecycle:
      status: active

providers:
  - id: example-provider
    name: Example Provider
    legalEntityJurisdictions: [US]

routes:
  - id: example-provider/us-east
    providerId: example-provider
    processingLocations: [US-VA]
    dataResidencyJurisdictions: [US]
    privacy:
      zdr: true
      trainingUse: false
      maxRetentionHours: 0
    evidence:
      - sourceId: example-provider-policy
        observedAt: 2026-08-03T10:00:00Z

modelOfferings:
  - id: offering_01J...
    providerId: example-provider
    modelId: claude-sonnet-4-5-20250929
    canonicalModelId: anthropic/claude-sonnet-4.5@20250929
    equivalence: exact
    routeIds: [example-provider/us-east]
    api: anthropic-messages
    lifecycle:
      status: active
      firstSeenAt: 2026-01-10T00:00:00Z
      lastSeenAt: 2026-08-03T10:00:00Z
    limits:
      contextWindow: 200000
      maxOutputTokens: 64000
    reasoning:
      supported: true
      levels:
        off: disabled
        low: low
        medium: medium
        high: high
    pricing:
      currency: USD
      unit: per_million_tokens
      input: 3
      output: 15
      cacheRead: 0.3
      cacheWrite: 3.75
      effectiveFrom: 2026-07-01T00:00:00Z
      sourceId: example-provider-pricing
```

### Required record classes

- **Source:** adapter identity, trust class, URL or API identity, fetch status, and freshness.
- **Observation:** immutable raw or minimally parsed source result, with retrieval time and content hash.
- **Canonical model:** developer-level identity, lineage, aliases, and native capabilities.
- **Provider:** legal entity, API family, authentication modes, and provider-wide metadata.
- **Route:** endpoint- or deployment-specific location, privacy, availability, and routing constraints.
- **Offering:** provider/model ID mapped to a canonical model and one or more routes.
- **Request compatibility profile:** route/protocol/deployment-scoped instruction-role, reasoning-control, request-field, and translation behavior, including validation evidence.
- **Pricing schedule:** effective-dated rates, units, tiers, currency, and applicability conditions.
- **Evidence:** field-level provenance, observation time, confidence, and optional expiry.
- **Lifecycle/tombstone:** status transitions, replacement hints, and historical identity.

### Capabilities and request settings

The schema must represent both model-native capabilities and effective offering behavior:

- text, image, audio, and other input/output modalities as support is added;
- tool use, structured output, strict schemas, prompt caching, and other API capabilities;
- context window and maximum output tokens;
- reasoning support, on/off behavior, native effort tiers, budgets, and Jouzu/Pi level mappings;
- accepted and preferred instruction roles, including whether `developer` is native, rewritten, or rejected;
- provider API type, endpoint protocol, compatibility flags, and translation behavior;
- sampling defaults and provider-specific request parameters; and
- known restrictions by route, deployment, plan, API, or client adapter.

Effective settings are computed from the canonical model, offering constraints, route/deployment constraints, curated corrections, and allowed local overrides. An offering may expose less than the canonical model supports.

A boolean such as `supportsDeveloperRole` is useful as a client projection but is too lossy as the source representation. The normalized profile should distinguish `native`, `rewrite_to_system`, `reject`, and `unknown`, and should record the preferred instruction role. Likewise, `reasoning: true` does not say whether the wire control is OpenAI `reasoning_effort`, Qwen `enable_thinking`, `chat_template_kwargs.enable_thinking`, a token budget, a DeepSeek-specific shape, or no control at all.

An illustrative route-scoped profile is:

```yaml
requestCompatibility:
  scope:
    protocol: openai-chat-completions
    servingEngine: sglang
    deploymentId: local/qwen38-27b-nvfp4-mtp
  instructionRoles:
    accepted: [system, user, assistant, tool]
    preferred: system
    developer: reject
  reasoning:
    supported: true
    enableControl:
      location: top_level
      field: enable_thinking
      type: boolean
      disabledValue: false
      enabledValue: true
    effortControl:
      supported: false
  validation:
    status: passed
    observedAt: 2026-08-16T02:41:00Z
    sourceId: local-interoperability-probe
    requestProfileHash: sha256:...
```

This example is an observation about one deployment, not a claim about every Qwen model or every SGLang configuration. Compatibility evidence should include enough of the model artifact, server version/configuration, protocol, and request shape to know when it has gone stale. Active probes may incur cost or cause model output, so Jouzu runs them only from an explicit bounded probe suite, never as an unannounced catalog refresh side effect.

Client-specific fields are derived from this normalized profile. For the example above, a Pi `openai-completions` projection would use:

```json
{
  "compat": {
    "supportsDeveloperRole": false,
    "supportsReasoningEffort": false,
    "thinkingFormat": "qwen"
  }
}
```

Those Pi field names are a projection, not the canonical schema. Other clients may need different encodings or may rely on a gateway to normalize a generic request.

### Gateway catalogs and compatibility projection

A gateway exposes two separate contracts that the catalog must not conflate:

1. the **ingress contract** clients may safely send to the gateway; and
2. the **upstream contract** the gateway emits after model- and route-specific normalization.

If a gateway rewrites `developer` to `system` or converts generic effort into native Qwen controls, its client-facing offering can advertise that normalized ingress behavior while retaining the raw backend restrictions on the route. If it merely passes a field through, the ingress contract cannot claim broader support than the backend.

For `codex-pool`, the current local catalog already has `compat.supports_developer_role`, and its generated Pi configuration projects that value. However, the current catalog profile does not independently declare the client-facing thinking format or whether Pi should emit `reasoning_effort`: the Pi generator hardcodes `supportsReasoningEffort: true` for data-driven reasoning profiles and leaves `thinkingFormat` empty. Its rich `GET /api/pool/models` response also omits request-compatibility metadata. Consequently, a manual `~/.pi/agent/models.json` Qwen fix is not durable and will be lost on regeneration.

The smallest codex-pool repair is to add validated source fields for client thinking format and effort support, project them into generated Pi models, and test the exact generated JSON. If Pi is changed to emit Qwen `enable_thinking`, the pool request normalizer must also consume or pass through that field correctly; changing only `models.json` can make `--thinking high` appear to work because a backend default is enabled while still breaking `--thinking off` or collapsing all effort levels. The longer-term shape should separate ingress and upstream controls, use typed boolean/string/budget values, and expose the effective ingress compatibility in the authenticated rich catalog. Standard OpenAI `GET /v1/models` remains intentionally too small for this metadata.

Provider-level defaults are appropriate only when every offering behind that provider adapter shares the behavior. Otherwise compatibility belongs on the model offering or narrower route/deployment, with the most specific validated profile winning. A provider-wide `supportsDeveloperRole: false` is a safe emergency override for a homogeneous local pool, but should not become a universal Qwen assertion.

## Jouzu catalog interchange format

Jouzu defines a transport-independent JSON format so the same validator and reconciliation path can consume:

- built-in compatibility for major providers such as OpenAI, Anthropic, and Google;
- Shisa.AI and codex-pool authenticated catalogs;
- local and private gateway discovery;
- compatibility metadata imported from the pinned Pi release; and
- optional community-maintained compatibility packs.

The format is the contract. It may be embedded in Jouzu, loaded from a file, distributed as a signed artifact, or returned by an HTTP endpoint. YAML is used only for readable examples and authoring tools; canonical artifacts and wire responses are JSON.

### Envelope and document kinds

Every document has this envelope:

```json
{
  "$schema": "https://jouzu.ai/schemas/model-catalog/v1.0.json",
  "format": "jouzu.model-catalog",
  "schemaVersion": "1.0",
  "kind": "snapshot",
  "catalogId": "ai.shisa.codex-pool",
  "revision": "2026-08-16T03:00:00Z-42",
  "generatedAt": "2026-08-16T03:00:00Z",
  "expiresAt": "2026-08-16T03:05:00Z",
  "source": {
    "id": "codex-pool:office",
    "type": "authenticated_gateway"
  },
  "scope": {
    "complete": true,
    "accountScoped": true,
    "includes": ["providers", "routes", "canonicalModels", "modelOfferings", "compatibilityProfiles"]
  },
  "dependencies": [],
  "providers": [],
  "routes": [],
  "canonicalModels": [],
  "modelOfferings": [],
  "compatibilityProfiles": [],
  "matchRules": [],
  "evidence": [],
  "extensions": {}
}
```

Version 1 defines two document kinds:

- `snapshot` — an inventory for a declared source and scope. It can include models, offerings, routes, availability, pricing, and compatibility.
- `compatibility-pack` — reusable compatibility profiles and constrained match rules. It normally does not claim current account availability.

Version 1 does not define incremental mutation operations. A producer returns a complete snapshot for the declared scope or sets `scope.complete: false`. Omission from a partial snapshot is never evidence of removal. Even a complete snapshot remains subject to the lifecycle grace and mass-deletion safeguards described below.

The required envelope fields are `format`, `schemaVersion`, `kind`, `catalogId`, `revision`, `generatedAt`, `source`, and `scope`. `$schema`, `expiresAt`, and `dependencies` are optional; the first two are recommended for published and remotely fetched artifacts. A dependency pins `catalogId` plus an immutable revision and content hash. Record arrays may be omitted when their class is absent from `scope.includes`; an included class is represented by an array, including an empty array when the complete result has no records.

`catalogId` is a stable URI or reverse-DNS-style identifier controlled by the publisher. `revision` is opaque but must change whenever effective content changes. `source.type` describes origin but does not grant its own trust; trust is assigned by the receiving Jouzu installation. A document must not contain credentials, authorization headers, private prompts, or raw account labels.

### Core compatibility records

A compatibility profile is declarative data, never executable code or a request template. It can describe:

- `appliesTo`: `ingress`, `upstream`, or `end_to_end`;
- protocol and adapter identity;
- accepted and preferred message roles and role-rewrite behavior;
- tool-call, structured-output, streaming, and usage-reporting support;
- reasoning enablement, effort, and budget controls with typed values;
- supported reasoning levels and deterministic fallbacks;
- token-limit field names and safe sampling defaults;
- required or forbidden request fields; and
- validation evidence and deployment constraints.

For example, a gateway offering that expects Qwen-native input can include:

```json
{
  "compatibilityProfiles": [
    {
      "id": "ai.shisa.codex-pool/local-qwen-ingress-v1",
      "appliesTo": "ingress",
      "protocol": "openai-chat-completions",
      "instructionRoles": {
        "accepted": ["system", "user", "assistant", "tool"],
        "preferred": "system",
        "developer": "reject"
      },
      "reasoning": {
        "supported": "yes",
        "enableControl": {
          "location": "body",
          "path": ["enable_thinking"],
          "valueType": "boolean",
          "disabledValue": false,
          "enabledValue": true
        },
        "effortControl": {
          "supported": "no"
        }
      },
      "validation": {
        "status": "passed",
        "evidenceIds": ["probe/qwen38/pi-high/2026-08-16"]
      }
    }
  ],
  "modelOfferings": [
    {
      "id": "ai.shisa.codex-pool/local/Qwen3.8-27B",
      "providerId": "ai.shisa.codex-pool/local",
      "modelId": "Qwen3.8-27B",
      "routeIds": ["ai.shisa.codex-pool/local/sglang-8000"],
      "compatibilityProfileIds": ["ai.shisa.codex-pool/local-qwen-ingress-v1"],
      "availability": {
        "status": "available",
        "observedAt": "2026-08-16T03:00:00Z"
      }
    }
  ]
}
```

Core control paths are arrays of validated field names, not JSONPath expressions. The v1 schema permits only registered semantic controls, value types, locations, roles, and bounded field paths. It does not permit scripts, arbitrary transformations, regular expressions, environment interpolation, or code-bearing hooks. New wire formats are added through a schema/registry revision; an unknown control remains unsupported rather than being guessed.

Profiles may contain optional client projections:

```json
{
  "projections": {
    "pi": {
      "testedWith": "0.83.0",
      "api": "openai-completions",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "thinkingFormat": "qwen"
      }
    }
  }
}
```

The neutral profile is preferred and Jouzu normally derives the Pi projection itself. A Pi projection is useful during migration or for a Pi feature that has no neutral core representation. It is adapter-scoped evidence, excludes `baseUrl` and credentials, declares the tested Pi version, and is checked for contradictions with the neutral profile. A safety-relevant contradiction rejects or quarantines the projection rather than silently choosing the more permissive value.

### Compatibility-pack matching

A `compatibility-pack` applies profiles through explicit assignments or bounded match rules. A rule may match:

- exact `providerId`, `modelId`, `canonicalModelId`, or route/deployment ID;
- a declared model family;
- protocol or serving engine/version; and
- a restricted anchored model-ID glob when exact IDs cannot cover a provider's rolling aliases.

Conditions across fields are ANDed; values within one field are ORed. Version 1 globs support only literal segments and `*`, have strict length/complexity limits, and are never used to establish canonical identity or exact equivalence. Arbitrary regular expressions are not supported. Direct offering assignments outrank match rules, exact rules outrank family/glob rules, and unresolved ties are reported as conflicts.

A rule must declare what it is allowed to set. For example, a community pack that supplies Qwen request compatibility cannot also assert ZDR, legal jurisdiction, price, or exact model equivalence unless the local trust policy separately grants those field classes. Compatibility packs cannot create credentials, enable providers, or make an unavailable model routable.

An illustrative pack rule is:

```json
{
  "format": "jouzu.model-catalog",
  "schemaVersion": "1.0",
  "kind": "compatibility-pack",
  "catalogId": "community.example.qwen-sglang",
  "revision": "1.2.0",
  "generatedAt": "2026-08-16T00:00:00Z",
  "source": {
    "id": "community.example.qwen-sglang",
    "type": "community"
  },
  "scope": {
    "complete": false,
    "accountScoped": false,
    "includes": ["compatibilityProfiles", "matchRules"]
  },
  "compatibilityProfiles": [
    {"id": "community.example.qwen-sglang/qwen-native-v1", "appliesTo": "upstream", "protocol": "openai-chat-completions"}
  ],
  "matchRules": [
    {
      "id": "community.example.qwen-sglang/qwen3",
      "match": {
        "providerIds": ["local-sglang"],
        "modelIdGlobs": ["Qwen3*"],
        "protocols": ["openai-chat-completions"],
        "servingEngines": ["sglang"]
      },
      "apply": {
        "compatibilityProfileIds": ["community.example.qwen-sglang/qwen-native-v1"]
      },
      "fieldClasses": ["request_compatibility"]
    }
  ]
}
```

All referenced profile and evidence IDs must resolve within the same document or through an explicit dependency declared by immutable catalog ID and revision/content hash. Ambient cross-pack references are rejected, preventing load order from silently changing a pack's meaning.

### Built-in, provider, Pi, and community sources

Jouzu ships source-controlled **built-in compatibility packs** for the major direct providers and APIs it officially supports. “Hardcoded” means these reviewed packs are compiled into the release and covered by fixtures and request-shape tests—not that compatibility conditionals are scattered through runtime code. The packs use the same schema, matcher, provenance, and merge engine as external data.

Built-in packs include:

- exact and carefully bounded rolling model matches for major provider endpoints;
- protocol, role, reasoning, tool, streaming, token-limit, and usage-field behavior;
- the Jouzu-to-Pi projection where needed;
- the provider documentation or interoperability tests supporting each value; and
- the provider/API and Pi versions against which the profile was validated.

Shisa-authored models receive both an authoritative profile from a Shisa.AI or codex-pool endpoint and a Jouzu built-in fallback pack. The endpoint supplies current route/deployment and account availability; the built-in pack keeps known models usable offline or against an older gateway that only implements `/v1/models`. A fresh endpoint profile does not erase a signed emergency safety correction.

Pi's built-in and remote model metadata is imported through a pinned Pi adapter and labeled with the exact Pi version from `upstream/pi.lock.json`. Pi remains an important compatibility baseline, especially for providers it already supports, but Pi adapter fields are not automatically treated as provider-authoritative pricing, privacy, jurisdiction, or raw-backend behavior.

Community publishers use `kind: compatibility-pack` and a publisher-controlled `catalogId`. Packs may be loaded from a local file, package, or signed feed. By default they are opt-in and lower authority than authenticated route metadata and Jouzu's reviewed built-ins. An administrator may pin, promote, restrict, or deny a publisher or individual field class. Unsigned packs remain local assertions; a valid signature proves publisher identity and artifact integrity, not correctness.

Experimental metadata belongs under reverse-DNS-namespaced `extensions`, for example:

```json
{
  "extensions": {
    "ai.shisa.codex-pool": {
      "supportingAccounts": 2,
      "availableAccounts": 1
    }
  }
}
```

Consumers ignore unknown extensions for behavior and policy. A core capability cannot depend exclusively on an unknown extension.

### Resolution and fallback order

Compatibility resolution is field-specific, but the default technical order is:

1. explicit scoped administrator safety/technical overrides and signed Jouzu emergency corrections;
2. a fresh authenticated profile directly assigned to the exact route/deployment;
3. an exact reviewed Jouzu built-in provider or Shisa fallback profile;
4. an explicitly trusted community profile with an exact match;
5. pinned Pi metadata applicable to the same client adapter and provider/model identity;
6. lower-specificity family or bounded-glob rules; and
7. a conservative protocol-only synthesized profile.

Specificity, declared scope, trust, freshness, and evidence are all considered. A `reject` or known unsupported result is not overridden by a lower-authority generic `supported` assertion. Compatibility inherited from a canonical model describes native potential; it does not prove a particular provider route exposes that behavior.

When only a standard `/v1/models` ID is available, Jouzu synthesizes the minimum profile necessary to show and explicitly select the offering. It does not invent reasoning support, developer-role support, tools, images, pricing, retention, ZDR, or exact equivalence. Text request support may be inherited from the authenticated API protocol; unknown limits remain unknown in the rich sidecar. If Pi requires numeric limits, the projection uses named conservative adapter defaults, labels them `synthetic`, and preserves the unknown source value so filters and estimates do not mistake the fallback for provider fact.

This gives four graceful paths:

- **major provider:** reviewed built-in pack plus authenticated availability;
- **Shisa-created model:** Shisa/codex-pool profile, with a built-in Jouzu fallback;
- **Pi-supported model:** pinned Pi compatibility imported into the Jouzu schema;
- **new community or unknown model:** trusted compatibility pack when installed, otherwise conservative protocol fallback plus local override/probe support.

### HTTP serving profile

The recommended provider/gateway endpoint is:

```http
GET /v1/jouzu/model-catalog
Accept: application/vnd.jouzu.model-catalog+json; version=1.0
```

A successful response uses:

```http
Content-Type: application/vnd.jouzu.model-catalog+json; version=1.0
ETag: "<revision-or-content-hash>"
Vary: Authorization
```

The endpoint uses the same authentication scope as model discovery and returns only models visible to that credential. It supports `If-None-Match`; declares whether its scope is complete; and sets private/account-appropriate cache headers. It never returns provider credentials. The format may also be served at an implementation-specific URL, but Shisa.AI and codex-pool should implement the recommended path so Jouzu needs no product-specific parser.

`GET /v1/models` remains the universal minimal fallback. It is not extended with non-standard top-level compatibility fields. Existing rich endpoints such as codex-pool `GET /api/pool/models` may remain for product-specific consumers, but should be generated from the same internal records or offer the Jouzu media type to prevent metadata drift.

The gateway publishes its effective **ingress** contract. If it also exposes raw upstream profiles, they use separate IDs and `appliesTo: upstream`; clients never substitute the upstream profile for the ingress profile. Account counts, queue state, and other product-specific diagnostics belong in namespaced extensions.

### Shisa.AI and codex-pool producer requirements

Shisa.AI and codex-pool are conforming producers when they:

1. generate the Jouzu response from the same internal model records used for routing and generated client configuration;
2. return stable provider, offering, route, profile, and evidence IDs rather than display-name-derived identities;
3. describe the client-visible gateway ingress contract and assign its profile directly to each applicable offering;
4. separate any local SGLang/vLLM/raw-provider upstream restrictions into `appliesTo: upstream` profiles;
5. scope availability to the authenticated account and accurately declare `scope.complete`;
6. leave canonical identity, price, location, retention, or compatibility `unknown` when not established rather than copying a favorable default;
7. emit no credentials and place pool-specific account counts or diagnostics only in `extensions`; and
8. pass Jouzu's canonical schema, semantic, and generated Pi request-shape fixtures in CI.

A direct Shisa.AI endpoint normally publishes `providerId: ai.shisa` offerings and direct routes. Codex-pool publishes its gateway ingress offerings and may reference Shisa.AI or local deployments as upstream routes without exposing account labels or upstream credentials. The two can expose the same canonical model while retaining distinct offering IDs, prices, policies, availability, and compatibility profiles.

During migration, codex-pool may derive a neutral profile from its existing `LocalModelCompat` plus generated Pi metadata. The migration is complete only when the neutral profile, `/v1/jouzu/model-catalog`, `/api/pool/models`, request normalizer, and generated `models.json` all originate from one source record and conformance tests prevent them from drifting.

### Versioning and conformance

- Consumers reject an unknown major `schemaVersion`.
- Minor revisions may add optional fields and registered enum values; an unknown safety-relevant value evaluates to `unknown` or unsupported.
- Producers validate against the published JSON Schema and semantic rules before serving or signing.
- Conformance fixtures cover a major provider, Shisa/codex-pool, Pi import, a community pack, an unknown model, and conflicting profiles.
- A conforming endpoint must round-trip stable IDs, scope completeness, compatibility assignments, evidence references, and unknown namespaced extensions without converting unknown values to favorable defaults.

The first implementation should publish the JSON Schema, a human-readable field reference, canonical fixtures, and a small conformance command before Shisa.AI or codex-pool independently implements the endpoint.

## Source and update architecture

There are two discovery lanes.

### Distribution-time discovery

Jouzu-operated automation ingests public sources into a reviewed, normalized catalog:

- Pi's built-in and remote provider catalog;
- official model and provider APIs;
- official pricing and capability feeds;
- router catalogs;
- provider documentation through typed, source-specific adapters;
- curated Jouzu corrections and equivalence assertions;
- reviewed built-in major-provider and Shisa fallback compatibility packs;
- explicitly enabled community compatibility packs; and
- optional benchmark or certification sources, kept distinct from factual capabilities.

The pipeline is:

```text
fetch -> retain observation -> normalize -> reconcile -> validate
      -> review/quarantine risky diffs -> sign -> publish immutable snapshot
```

Each adapter has its own refresh interval, timeout, retry policy, parser tests, and freshness rules. Scraped prose is evidence, not automatically authoritative structured data. A source parser failure does not translate into model removal.

### Runtime discovery

The Jouzu client may discover data that cannot or should not be centralized:

- models visible only after provider authentication;
- account, subscription, region, or project-specific availability;
- enterprise contract pricing and retention terms;
- cloud deployments;
- local Ollama, llama.cpp, vLLM, SGLang, or similar servers;
- private gateways; and
- explicit interoperability probes for route-scoped roles, tools, reasoning controls, and usage fields.

Runtime discoveries remain local by default. They are merged as account-scoped observations and may override public availability or route metadata only within their declared scope.

### Source adapter contract

An adapter should return a complete or explicitly incremental observation containing:

- source and scope identity;
- fetched and source-generated timestamps;
- whether the result is complete;
- source validators such as ETag or revision;
- raw IDs and aliases;
- parsed model, offering, route, capability, and pricing facts;
- field-level evidence; and
- warnings instead of invented defaults.

A source that already returns `jouzu.model-catalog` is still schema-, semantic-, scope-, and trust-validated, but it does not need a product-specific metadata parser. Its records become observations before reconciliation so endpoint claims retain the same provenance and conflict handling as every other source.

Authenticated adapters receive only the credentials required for that provider. Credentials are never written to observations or catalog files.

## Reconciliation and overrides

### Layering

The effective local view is composed from these layers:

1. Embedded Pi/Jouzu baseline for first run and offline recovery.
2. Last verified signed Jouzu snapshot.
3. Fresh authenticated or local runtime discovery.
4. Jouzu curated corrections and certifications included in the signed snapshot.
5. Organization policy and account-specific assertions.
6. Trusted project configuration.
7. User presentation, ranking, favorites, and request-setting overrides.
8. Explicit session or CLI choices.

This list is not a blanket “last value wins” rule. Merge authority is field-specific:

| Field class | Normal authority |
| --- | --- |
| Native model capability and lineage | Model developer, then curated correction |
| Provider model ID and availability | Serving provider or authenticated discovery |
| Public price | Serving provider's effective-dated rate card |
| Contract price | Organization/account override |
| Processing location and retention | Route/provider contract or verified policy evidence |
| API compatibility and safe request mapping | Narrowest tested deployment/route/protocol profile, then curated correction, then explicit local technical override |
| Hard allow/deny policy | Organization/project policy |
| Favorites, labels, and ranking | User |

A lower-trust source cannot erase a higher-trust fact merely because it was fetched later. Conflicts are retained and surfaced as `conflicted` or `unknown` until resolved.

### Patch semantics

- An absent patch field means “no opinion.”
- Explicit removal uses a schema-defined tombstone operation, not `null` by convention.
- Policy-sensitive `unknown` is a real value.
- Objects merge by field where the schema permits it.
- Lists declare whether they replace, append, or remove keyed members.
- Every effective value can report the winning layer and evidence.
- Invalid overrides are rejected independently and do not invalidate the base catalog.

User technical overrides may locally assert a missing value, but the UI marks the value as locally asserted. They cannot turn a policy denial into an allowed route.

## Pricing and cache profiles

The catalog supplies effective-dated facts used by the runtime accounting system. It does not own per-request usage history, cache lineages, subscription allocation, quota burn, or invoice reconciliation; those belong to [Usage Tracking and Cost Accounting](USAGE-TRACKING.md).

Pricing is attached to the scope at which it varies: offering, route, account, or plan. Catalog records support:

- input, output, cache-read, and short/long cache-write token rates;
- request-wide threshold and long-context tiers;
- per-request, image, audio, storage, tool, and other units;
- batch, priority, credit, and overage pricing;
- currency, minimum charges, and rounding rules;
- public, contract, and locally asserted rates with provenance; and
- `effectiveFrom`, optional `effectiveUntil`, and observation freshness.

The catalog also describes known cache behavior for an offering or route:

- support as `yes`, `no`, or `unknown`;
- automatic versus explicit cache controls;
- minimum cacheable prefix and granularity, when known;
- available retention modes and advertised TTLs;
- whether reads or writes are known to refresh expiry;
- cache namespace scope and session-affinity requirements;
- provider usage fields and write-tier semantics; and
- evidence and freshness.

These are capability/profile facts, not proof that a particular request hit a cache. Runtime observations and model-switch cache impact are calculated in the usage ledger.

Cost filters may target raw rates or invoke a named usage scenario from the usage tracker, for example maximum input/output rate, estimated cost per request, or estimated monthly spend. Unknown required rates produce an incomplete estimate, never a zero-cost estimate. Strict cost policy excludes insufficient data; a user preference may instead retain it with an “unknown cost” warning.

## Policy filtering

### Policy dimensions

At minimum, Jouzu supports:

- legal entity jurisdiction;
- service availability in the user's jurisdiction;
- processing location;
- data residency jurisdiction;
- cross-border transfer restrictions;
- ZDR status;
- maximum retention duration;
- training or secondary-use policy;
- direct provider versus router;
- provider and upstream-provider allow/deny lists;
- local-only or cloud-only operation;
- cost limits;
- required modalities and capabilities;
- minimum evidence freshness or certification level; and
- organization-specific approval.

“Jurisdiction” is not one field. Provider incorporation, contracting entity, endpoint availability, processing location, and data residency are recorded and filtered separately.

### Evaluation

Policy evaluation produces an explainable result for each offering/route:

```text
allowed | denied | unknown
```

It also emits reason codes such as:

- `processing_location_not_allowed`;
- `zdr_unknown`;
- `retention_exceeds_limit`;
- `price_unknown`;
- `provider_not_authenticated`;
- `offering_deprecated`; or
- `required_capability_missing`.

Hard policy treats `unknown` as denied unless the policy explicitly allows unknown values. User filters may be lenient and show unknown values separately.

Router policy must be enforced at request time as well as during catalog filtering. For example, a router offering is not considered ZDR merely because at least one upstream route is ZDR. Jouzu must either constrain the request to compliant routes using supported routing parameters or exclude it. Account- or contract-dependent claims are evaluated using the active credential scope.

### Filtering and ranking order

1. Validate catalog and lifecycle state.
2. Apply organization and project hard policy.
3. Apply account/auth availability.
4. Apply required task capabilities.
5. Apply user filters.
6. Group exact equivalents by canonical model.
7. Rank groups and offerings using user preferences, cost scenarios, location, and optional performance data.

The UI must be able to explain both “why hidden?” and “why selected?”

## Grouping and routing

The model picker should normally present a canonical model group with provider offerings nested beneath it:

```text
Claude Sonnet 4.5
  - Anthropic direct
  - Amazon Bedrock / ap-northeast-1
  - OpenRouter / ZDR-constrained route
```

Exact grouping requires a canonical model mapping backed by evidence. Automated name similarity may propose a mapping for review, but cannot publish an `exact` relationship by itself.

Within an exact group, Jouzu can rank offerings by:

- hard policy compliance;
- configured authentication and account availability;
- user's preferred providers;
- processing location and latency preference;
- ZDR and retention preference;
- estimated cost for the active scenario;
- reliability or measured performance; and
- catalog freshness.

A canonical selection means “use this exact model through an allowed offering.” A provider-specific selection remains pinned to that offering. Similar-family alternatives are displayed separately and require explicit user consent.

Automatic cross-provider routing is disabled by default because it can change cache reuse, cost, legal terms, data path, quota, rate limits, and behavior. Jouzu should normally propose the route and ask. If a user explicitly enables automatic routing, it remains limited to policy-compliant exact equivalents unless the user separately enables similar-model fallback. Every switch is recorded and evaluated by [Usage Tracking and Cost Accounting](USAGE-TRACKING.md).

## User settings and lifecycle changes

### Stable user intent

Favorites and defaults are stored outside generated catalog files. They use stable structured references and may target:

- a canonical model, with optional preferred offerings;
- a specific provider offering;
- a model family for discovery/notification only; or
- a named selection policy such as “cheapest ZDR exact route.”

A user record is never deleted merely because its current target is absent. Resolution returns one of:

- `resolved` — the requested target is selectable;
- `degraded` — an explicit, policy-compliant fallback is proposed or selected;
- `unavailable` — the target remains known but cannot currently be used;
- `blocked` — current policy forbids it; or
- `unresolved` — the identity is no longer known.

### Additions

New offerings appear without changing the user's default. If they exactly match a favorite canonical model, they may be shown as a new route. New similar models may trigger an optional discovery notice but are not added to favorites automatically.

A deployment change can invalidate request compatibility even when the advertised model ID is unchanged. A new model digest, chat template, serving-engine version, reasoning parser, tool parser, or gateway translation version marks affected probe evidence stale and reverts uncertain fields to conservative behavior until revalidated. It does not silently inherit every success from the retired deployment.

### Renames and aliases

Provider aliases and model aliases resolve to stable IDs. The catalog records alias history and replacement hints. IDs are never reused for unrelated models. User settings may be migrated to the stable ID while preserving the original reference for audit and rollback.

### Deprecation and removal

Lifecycle states are:

```text
preview -> active -> deprecated -> unavailable -> retired
```

`blocked` is a local policy result rather than a global lifecycle state.

- `deprecated` remains selectable with a warning and replacement information.
- `unavailable` means not currently selectable for the relevant source/account and may be temporary.
- `retired` is retained as a tombstone for preference resolution and history.
- A transient source omission does not immediately retire an offering.

Unless an authoritative source explicitly announces withdrawal, removal requires multiple successful observations over a minimum grace period. Source failure, authentication failure, parser failure, or partial response never counts as confirmed absence. Large deletion diffs are quarantined for review.

Tombstones retain the previous identity, last known metadata, last-seen time, reason, and replacement candidates. The identity registry itself is permanent even if detailed tombstone metadata is eventually compacted.

### Active sessions and fallback

A catalog refresh does not interrupt an in-flight request or silently switch an active session. If the selected offering becomes unavailable:

1. Keep the user's stored preference unchanged.
2. Mark the active selection stale or blocked.
3. On the next resolution boundary, propose an allowed exact-equivalent offering.
4. Switch only according to the user's explicit fallback mode; `ask` is the proposed default.
5. Otherwise leave the session without a resolved model.
6. Show the provider, model, reason, cache consequence, cost/quota estimate, and any accepted fallback.

A provider `model_not_found` response may trigger the same resolution flow, but must not silently retry through another provider. Similar-model fallback is always separately opt-in and prominently reported. The usage tracker records the transition and attributes any subsequent resubmission, cache loss, recaching, and quota movement without double counting request tokens.

Jouzu should replace Pi's current arbitrary “first available model” last resort with a policy-aware, deterministic resolution order.

## Local configuration shape

The final settings schema is separate from the catalog schema. An illustrative user configuration is:

```yaml
catalog:
  compatibility:
    useBuiltins: true
    usePinnedPiBaseline: true
    packs:
      - source: ~/.config/jouzu/catalog-packs/qwen-sglang.json
        catalogId: community.example.qwen-sglang
        trust: local
        allowedFieldClasses: [request_compatibility]
  updates:
    enabled: true
    intervalHours: 4
    channel: stable
  filters:
    requireZdr: true
    processingLocations:
      allow: [JP, EU]
    unknownPolicy: deny
    maxEstimatedRequestCost:
      scenario: coding-default
      currency: USD
      amount: 0.25
  ranking:
    preferredProviders: [anthropic, amazon-bedrock]
    preferLocal: false
    costScenario: coding-default
  fallback:
    exactEquivalent: ask
    similarModel: never
  favorites:
    - kind: canonicalModel
      id: anthropic/claude-sonnet-4.5@20250929
      preferredOfferings:
        - providerId: anthropic
          modelId: claude-sonnet-4-5-20250929
  overrides:
    offerings:
      - match:
          providerId: local-vllm
          modelId: my-model
        set:
          label: Workstation model
          contextWindow: 65536
```

Organization policy is stored separately from user preferences and has higher authority. Project policy may tighten organization policy but must not relax it unless an explicit administrator-controlled mechanism permits that.

Named profiles such as Core, JA, Local, and Certified should be versioned bundles of filters, rankings, and defaults over the same catalog—not independent copies of model data.

## Distribution, trust, and offline behavior

### Published artifacts

Jouzu publishes immutable, content-addressed catalog snapshots plus a small manifest containing:

- schema version;
- catalog revision and content hash;
- generation and expiry times;
- minimum compatible Jouzu version;
- source summary;
- signing key ID; and
- signature.

Large catalogs may be sharded by provider, but one signed manifest binds all shard hashes. Publication is atomic: clients either see the old complete revision or the new complete revision.

### Verification

Clients must:

1. Fetch with bounded timeouts and response-size limits.
2. Validate the manifest signature against an embedded trusted key.
3. Validate content hashes and schema before activation.
4. Reject expired, incompatible, malformed, or rollback snapshots according to policy.
5. Write to a temporary location and atomically activate the full revision.
6. Retain the embedded and previous last known-good revisions.

TLS is required but does not replace artifact signatures. Signing keys require an explicit rotation and revocation mechanism. Catalog data is untrusted input even when signed: parsers and renderers still enforce size, type, and URL constraints.

### Refresh behavior

- Load the embedded snapshot immediately.
- Prefer a newer verified cached snapshot.
- Refresh in the background with ETag or revision validators and jitter.
- Do not block normal startup on catalog network access.
- Offer explicit `status`, `refresh`, `diff`, and `explain` operations.
- Honor Pi/Jouzu offline mode by performing no network access.
- Retain cached data on timeout, network error, source error, or rejected snapshot.
- Clearly report catalog age and stale policy evidence.

## Pi integration

Pi 0.83 already provides useful foundations:

- static built-in provider catalogs;
- a persisted, provider-scoped dynamic model store;
- background refresh with ETag/Last-Modified and a four-hour freshness window for Pi's remote catalog;
- last-known catalog use on refresh failure;
- provider extension hooks for dynamic `refreshModels` behavior;
- `models.json`, built-in model overrides, and provider/model runtime identity;
- context window, max tokens, pricing, reasoning maps, and compatibility fields; and
- restoration and fallback using `(provider, modelId)`.

Jouzu should compose with this runtime rather than maintain an unrelated request stack.

### Proposed boundary

1. A Jouzu catalog service loads and verifies `jouzu.model-catalog` snapshots, built-in packs, Pi-derived observations, community packs, and local overlays.
2. It resolves policy-visible offerings and projects them into Pi `Model` records.
3. A Jouzu Pi integration registers or refreshes provider models using Pi's provider APIs.
4. The richer Jouzu metadata remains in a sidecar keyed by stable offering identity for grouping, filters, provenance, lifecycle, rate cards, and cache profiles.
5. Pi continues to execute requests and calculate immediate token-cost estimates using the effective projected rates.
6. Jouzu's usage ledger snapshots those rates and adds attempt, cache, transition, subscription, quota, and reconciliation accounting.
7. Existing Pi `models.json` and `modelOverrides` remain technical escape hatches, but their entries are still subject to Jouzu hard policy.

The Pi `Model` type cannot carry all required route, legal, provenance, lifecycle, and preference metadata, so flattening the Jouzu schema directly into Pi's model list would lose essential information.

Pi's current arbitrary fallback behavior is insufficient for Jouzu. Initial model resolution and session restoration need a Jouzu policy-aware resolver that preserves user intent and reports any fallback.

If Jouzu uses a Pi-compatible remote catalog endpoint, signed verification must happen in Jouzu before activation unless equivalent signature verification exists upstream. ETag caching alone is not a trust boundary.

## DeepSeek Harness integration

Pi remains the first execution client. DeepSeek Harness is a useful second projection target because its `dsh-llm-pi-ai` adapter uses the same `@earendil-works/pi-ai` model layer and already exposes route/model reasoning-format, reasoning-effort, capacity, and modality overrides. This independently validates keeping those facts in route-scoped neutral compatibility profiles rather than Pi-only conditionals.

DeepSeek Harness does not supply Jouzu's canonical catalog. Its current LLM seam lacks canonical offering/route identity, signed updates, policy evidence, pricing consumers, jurisdiction, retention, ZDR, plan, and quota metadata. It also has no configurable `supportsDeveloperRole` override in its `pi-ai` adapter. A DSH projection therefore maps only the subset it can represent faithfully while the rich Jouzu sidecar remains authoritative for policy and explanation.

The preferred future integration is a Jouzu catalog-backed DSH LLM adapter or an upstream catalog seam, plus a Jouzu policy/UI plugin. It must not rewrite the user's `llm-pi-ai` settings behind their back. A profile must explicitly disable or narrow stock adapter routes that the Jouzu adapter owns, because DSH rejects duplicate provider-route registration. See [DeepSeek Harness and Jouzu](DEEPSEEK-HARNESS.md) for the product boundary and adoption gates.

## Operational safeguards

The catalog compiler and client should enforce:

- deterministic output for identical observations and overlays;
- schema and semantic validation;
- duplicate and reused identity detection;
- impossible limit and negative-price checks;
- equivalence mappings that require evidence;
- effective-date and pricing-tier consistency;
- source freshness budgets;
- mass-addition, mass-removal, and mass-price-change quarantine thresholds;
- signed revision rollback protection;
- atomic cache writes and recovery from interrupted writes; and
- redaction checks preventing credentials or private headers from entering artifacts.

Useful user-facing diagnostics include:

```text
jouzu catalog status
jouzu catalog refresh
jouzu catalog diff
jouzu catalog explain <provider> <model>
jouzu catalog estimate <provider> <model> --scenario coding-default
jouzu catalog validate-pack <file>
jouzu catalog conformance <endpoint-or-file>
```

Command names are provisional.

## Testing strategy

- Adapter fixture and parser tests for every source.
- Golden tests for deterministic normalization and reconciliation.
- Field-authority and override precedence tests.
- Exact-equivalence versus similarity tests.
- Tri-state policy and fail-closed tests.
- Rate-tier, cache-profile, currency, provenance, and unknown-rate tests.
- Addition, rename, disappearance, deprecation, retirement, and tombstone tests.
- Favorite/default migration and unresolved-reference tests.
- Auth/account-scoped availability tests.
- Router request-time policy enforcement tests.
- Offline, timeout, partial source, stale cache, and last-known-good tests.
- Signature, rollback, malformed schema, oversized response, and interrupted-write tests.
- Built-in-provider, Shisa/codex-pool endpoint, pinned-Pi import, and community-pack conformance fixtures.
- Match specificity, field-class permission, publisher trust, conflict, and conservative unknown-model fallback tests.
- Pi projection and provider/model identity compatibility tests.
- Generated-client tests for `developer` versus `system`, thinking on/off, native effort tiers, token budgets, and unsupported-level hiding.
- End-to-end route probes that assert the actual outbound request shape, not only a successful response.
- Regression tests ensuring manual compatibility fixes are represented in source data and survive catalog regeneration.

## Proposed implementation phases

### Phase 1: interchange schema, built-in packs, and static compiler

- Publish the `jouzu.model-catalog` v1 JSON Schema and field/enum registry for snapshots, compatibility packs, profiles, match rules, canonical models, offerings, routes, pricing, evidence, and patches.
- Add canonical conformance fixtures for a major provider, Shisa/codex-pool, pinned Pi metadata, a community pack, conflicts, and an unknown-model fallback.
- Encode the first major-provider and Shisa-created-model compatibility as reviewed built-in packs using the same schema.
- Implement deterministic validation, safe matching, reconciliation, conservative synthesis, and Pi projection.
- Provide a conformance command usable by Jouzu, Shisa.AI, codex-pool, and community pack authors.

### Phase 2: signed updates

- Add manifest signing, verification, content-addressed snapshots, atomic cache activation, and offline fallback.
- Add status, refresh, and diff diagnostics.

### Phase 3: source adapters and provider endpoint

- Add the generic `/v1/jouzu/model-catalog` adapter plus Pi upstream, one direct provider, one router, and one local runtime adapter.
- Implement the same authenticated endpoint in Shisa.AI and codex-pool from their shared internal catalog records.
- Store immutable observations and field-level provenance.
- Add deletion grace periods and risky-diff quarantine.

### Phase 4: preferences and lifecycle

- Add stable favorites/defaults, aliases, tombstones, deterministic resolution, and explicit exact fallback.
- Integrate policy-aware startup and session restoration with Pi.

### Phase 5: policy, grouping, and accounting integration

- Add jurisdiction/location/ZDR/retention filters and explainability.
- Add canonical grouping and route ranking.
- Integrate named cost scenarios, cache-aware switch warnings, and estimate ranges from the usage tracker.
- Add Core, JA, Local, and Certified profiles as policy/ranking bundles.

## Open questions

1. Which public and authenticated sources are required for the first release?
2. Will Jouzu host and sign the catalog, or will releases ship catalog artifacts through another channel?
3. What taxonomy should represent legal jurisdiction, cloud region, and data residency without implying false precision?
4. Which evidence level is required before two offerings may be marked exact equivalents?
5. Should exact-equivalent fallback default to `ask` or `never`?
6. How long should detailed retired-offering tombstones remain locally and in distributed snapshots?
7. How should enterprise contract metadata be entered and protected?
8. Which public plan, rate-card, and cache-profile fields are required for initial usage-accounting integration?
9. Which policy fields are user preferences versus administrator-only controls?
10. Do we need remote revocation for a catalog revision that contains a dangerous compatibility or policy error?
11. Which compatibility checks may run automatically, and which require explicit opt-in because they consume quota, incur cost, or send model inputs?
12. How long should migration-only Pi projections be accepted before a neutral compatibility profile becomes mandatory for conforming provider endpoints?

## Required invariants

- A transient update failure cannot erase the current usable catalog.
- Generated catalog updates cannot edit or delete user preferences.
- Unknown policy-sensitive metadata is never treated as compliant by default.
- Exact equivalence is never inferred from names alone.
- Similar models are never silent fallbacks.
- Cross-provider fallback never bypasses policy or hides a provider/cost/data-path change.
- Every effective policy-sensitive fact is traceable to evidence or an explicit local assertion.
- Route-specific compatibility is never generalized into an unqualified model-family guarantee.
- Generated client settings never emit a role or reasoning control known to be rejected on the selected request path.
- Catalog activation is verified, atomic, and reversible to a last known-good revision.
