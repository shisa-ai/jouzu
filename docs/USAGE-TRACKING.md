# Jouzu Usage Tracking and Cost Accounting

**Status:** Draft design  
**Scope:** Runtime token usage, prompt caching, retries and resubmissions, model transitions, pricing, subscriptions, and quotas  
**Related:** [Model Catalog](MODEL-CATALOG.md), [Recomposition and Controlled Evolution](COMPOSITION.md), [Harness Engineering and Jouzu](HARNESS-ENGINEERING.md), [DeepSeek Harness and Jouzu](DEEPSEEK-HARNESS.md), [Agent Control Plane](CONTROL-PLANE.md), [Delegation and Adversarial Review](DELEGATION-AND-REVIEW.md)

## Summary

Jouzu should maintain a local, durable usage ledger that accounts for every observable provider request attempt—not only the final assistant message. The ledger separates:

- provider-reported token usage;
- prompt-cache reads, writes, misses, and expiry behavior;
- retries, resubmissions, compactions, and model transitions;
- estimated metered charges;
- provider-reported charges;
- API-equivalent value for subscription or free routes;
- fixed subscription spend and allocated subscription cost; and
- quota consumption, headroom, and reset windows.

These are different measurements and must not be collapsed into one ambiguous “cost” number.

A model switch is especially important. Even when the new offering serves the same canonical model, provider caches are normally scoped by provider, account, route, model, and cache key. Switching can cause the full context to be submitted and priced again, create a new cache entry, consume a different subscription quota, and abandon an otherwise reusable cache. Jouzu should warn before material switches, never silently switch by default, and attribute the next request's observed or estimated cache transition separately.

The model catalog owns current rate cards, plan definitions, and cache-capability metadata. This design owns runtime observations, calculations, historical snapshots, and user-facing accounting.

## Goals

1. Persist normalized token and cost facts for every observable request attempt.
2. Preserve provider-native usage fields and their semantics instead of guessing after aggregation.
3. Track cache reads, writes, misses, recaching, TTLs, namespaces, and likely invalidation causes.
4. Make model/provider switches visible before the switch and measurable after the next request.
5. Distinguish one logical operation from its physical attempts, including retries and resubmissions.
6. Support metered APIs, fixed subscriptions, prepaid credits, hybrid plans, free tiers, and local inference.
7. Integrate provider quota snapshots and infer capacity only when direct limits are unavailable.
8. Retain request-time pricing and calculation versions so historical totals do not drift.
9. Reuse Pi's existing usage information without double counting it.
10. Keep sensitive prompt content and credentials out of the accounting store.
11. Explain the origin, confidence, assumptions, and completeness of every derived value.

## Non-goals

- Claiming an exact invoice total without provider billing data.
- Treating subscription quota consumption as token-linear when the provider has not established that relationship.
- Treating a cache miss estimate as a provider-confirmed cache event.
- Storing raw prompts merely to calculate cache continuity.
- Silently retrying through another model or provider to optimize quota or cost.
- Replacing provider billing portals or organization finance systems.
- Using “ROI” for gross API-equivalent value divided by subscription cost. If shown, that ratio is a **value multiple**, not conventional net ROI.

## Design principles

### Account at the physical-attempt boundary

A user turn, agent turn, or compaction may cause multiple network attempts. Each attempt can consume tokens, quota, or money even when its response is discarded. The final assistant message is a useful summary but is not a complete accounting boundary.

### Preserve observations before deriving values

Raw provider counters, response IDs, rate-limit headers, status, timing, and parser semantics are stored before normalization. Calculations are versioned projections over those observations.

### Keep actual, estimated, and equivalent values distinct

The UI and APIs must label at least:

- provider-reported charge;
- estimated metered charge;
- API-equivalent value;
- fixed subscription spend;
- allocated subscription cost; and
- marginal cash cost.

Unknown is represented as unknown, not `$0`.

### Cache behavior is provider- and route-specific

A global five-minute cache assumption is insufficient. Cache eligibility, key scope, minimum prefix, retention, refresh behavior, write pricing, and reporting fields vary by provider and offering.

### Historical accounting is immutable by default

A request stores the price revision and formula used at the time. Updating the catalog affects future requests. Historical corrections require explicit adjustment or reconciliation records; they do not happen accidentally during a catalog refresh.

### Policy and accounting are separate

Usage and quota data can feed warnings, ranking, and optional hard limits. Telemetry uncertainty should not silently become enforcement. Any quota enforcement policy must define its own fail-open/fail-closed behavior.

## Accounting units and relationships

```text
session
  -> operation (user turn, tool LLM call, compaction, branch summary)
    -> logical request
      -> physical attempt 1
      -> physical attempt 2 (retry, resend, or recovery)
        -> usage observation(s)
        -> cost ledger entries
        -> cache observation
        -> quota snapshot(s)

model transition
  -> attached to first logical request after selection
  -> evaluated against the previous cache lineage
```

### Operation

A user-visible or internal activity that may invoke a model:

- normal agent turn;
- follow-up tool turn;
- compaction;
- branch summary;
- nested model call made by a tool;
- explicit one-shot completion; or
- background evaluation, if Jouzu later supports it.

### Logical request

One intended model response before transport/provider retry expansion. Context-overflow recovery after compaction is a new logical request linked to the failed one because its payload materially differs.

### Physical attempt

One provider dispatch. Provider SDK retries, gateway retries, and Jouzu retries are separate attempts whenever observable. An attempt can finish with success, provider error, transport error, timeout, cancellation, or unknown outcome.

### Usage observation

A raw or normalized measurement from a stream event, response body, response header, gateway, provider usage endpoint, invoice import, or estimate. Multiple observations may describe one attempt; reconciliation chooses the best value without deleting earlier evidence.

### Cache lineage

The sequence of requests believed to share a provider cache namespace and compatible prompt prefix. A lineage is scoped by all known cache-key inputs, not only the Jouzu session ID.

### Billing account and plan

The credential/account scope against which charges, credits, and quotas accrue. Provider identity alone is insufficient when a user has multiple API keys, cloud projects, subscriptions, or regions.

## Normalized token contract

Every attempt can carry the following normalized counters:

| Field | Meaning |
| --- | --- |
| `freshInputTokens` | Input tokens priced/treated as neither a cache read nor cache write |
| `cacheReadTokens` | Input tokens served from a provider prompt cache |
| `cacheWriteTokens` | Input tokens written to a cache when no TTL split is reported |
| `cacheWriteShortTokens` | Cache writes under the provider's short-retention tier |
| `cacheWriteLongTokens` | Cache writes under a longer or premium tier |
| `outputTokens` | All output tokens as reported by the provider |
| `reasoningTokens` | Diagnostic subset of output when the provider reports it |
| `totalProviderTokens` | Provider-reported total, when available |
| `estimatedTokens` | Locally estimated units, stored separately from reported counters |

`reasoningTokens` is normally a subset of `outputTokens`; it must not be added again unless a provider explicitly defines disjoint semantics.

There is no universal “billable token” count because cache reads and writes are billable at different rates and subscriptions may not bill tokens directly. Jouzu instead records priced units by category. A simplified fresh-input-plus-output metric may be exposed for comparison, but it is not labeled total billable tokens.

### Input semantics

Provider payloads commonly use one of two layouts:

- **Inclusive:** reported prompt/input tokens include cache-read and cache-write tokens. Normalize with:

  ```text
  fresh input = input - cache read - cache write
  ```

- **Additive:** fresh input, cache reads, and cache writes are disjoint. Normalize with:

  ```text
  fresh input = input
  ```

The observation stores `inputTokenSemantics` as `inclusive`, `additive`, or `unknown`, plus a parser/version identifier. Negative normalized values are clamped for display but retain a validation diagnostic and the raw source fields.

Pi already normalizes OpenAI-style inclusive prompt counts into `input`, `cacheRead`, and `cacheWrite`, while Anthropic-style providers report disjoint fields. Jouzu should consume those normalized values but retain enough source metadata to audit the conversion.

### Completeness and authority

Each observation declares:

```text
coverage: complete | partial | missing | estimated
source: provider_body | provider_stream | response_header | gateway |
        usage_endpoint | invoice | pi_message | local_estimate
confidence: authoritative | high | medium | low | unknown
```

Normal authority order is:

1. provider invoice or explicit transaction charge;
2. complete provider response usage;
3. complete gateway usage tied to the attempt;
4. partial stream/header usage;
5. Pi finalized message usage;
6. local estimate.

This order is field-specific. For example, a provider response can be authoritative for tokens while an organization contract is authoritative for price.

### Split and partial streams

Some APIs report input/cache counters at stream start and output counters at stream end. Jouzu accumulates them into one attempt while retaining both source observations. Aborted streams may have authoritative input/cache use but missing output use; they remain partial rather than being dropped.

## Pricing and cost ledger

### Rate-card input

The model catalog supplies effective-dated rate cards and plan definitions. A request calculation snapshots:

- catalog revision and pricing record ID;
- provider, offering, route, billing account, and plan;
- currency;
- rate categories and matched tier;
- effective dates;
- formula version;
- source/evidence identity; and
- any organization/account override.

A current catalog price is not sufficient to reconstruct old spend. The selected rate snapshot or an immutable reference to it must be retained with the ledger entry. When a router or provider reports an actual response model that differs from the requested model, Jouzu prices the resolved response offering/route when it can be mapped. It never silently substitutes a provider-default model price for an unknown model identity.

### Cost categories

| Category | Definition |
| --- | --- |
| `providerReportedCharge` | Charge explicitly returned by a provider, gateway, credit ledger, or invoice |
| `meteredCostEstimate` | Provider usage multiplied by the applicable metered rate card |
| `apiEquivalentValue` | What the same usage would cost under a declared comparison API/rate card |
| `subscriptionSpend` | Fixed recurring cash cost for the billing account and period |
| `subscriptionAllocatedCost` | Optional analytical allocation of fixed spend to requests/models/users |
| `marginalCashCost` | Estimated incremental cash caused by this request, including overage when known |
| `localComputeCostEstimate` | Optional energy/hardware/cloud allocation for locally operated inference |
| `creditConsumption` | Provider credits or plan units consumed, separate from currency unless conversion is explicit |

A single attempt may have several ledger entries. For a fixed subscription request, `marginalCashCost` can be zero or unknown while `apiEquivalentValue` is positive and quota consumption is material.

### Metered formula

The common token formula is:

```text
fresh input       * input rate
+ cache read      * cache-read rate
+ short cache write * short-write rate
+ long cache write  * long-write rate
+ output          * output rate
+ other priced units
```

Threshold tiers are evaluated exactly as the rate card specifies. A long-context tier may apply to the entire request rather than only tokens above the threshold. Reasoning is not separately charged when it is included in output.

When a required rate is missing, the corresponding estimate is incomplete. It must not be silently valued at zero. A comparison profile may explicitly say “use normal input rate for cache reads when the comparison API advertises no cache discount,” but that is an assumption recorded with the result.

### Immutability and corrections

Request-time cost entries are immutable. Corrections use one of:

- an append-only adjustment referencing the original entry;
- an explicit accounting-contract migration with a new formula version; or
- invoice reconciliation that records the delta between estimated and reported charge.

Rollups are rebuilt transactionally with any deliberate reconciliation. Catalog refreshes alone never reprice historical records.

## Subscription plans and quotas

### Billing modes

A plan has one of these primary modes:

- `metered_api` — pay for provider-reported units;
- `prepaid_credit` — draw down a currency or unit balance;
- `fixed_subscription` — recurring price with one or more opaque or explicit limits;
- `hybrid` — included quota plus metered overage;
- `free_tier` — no known cash charge but finite or rate-limited capacity;
- `local` — no provider bill, with optional internal compute cost; or
- `unknown`.

Plan records are credential/account-scoped and effective-dated. Billing mode is resolved from the actual authentication and route, not from provider name alone: API-key, OAuth subscription, gateway credits, and subscription “extra usage” can have different charging rules for the same model offering. Plan records include billing period, recurring amount, currency, included resources, overage terms, plan label, evidence, and whether the plan is active. Disabled or dead accounts do not contribute current recurring spend, while their historical requests remain in usage totals.

### Quota resource model

Quota is represented as typed resources rather than two hard-coded windows:

```yaml
resource: weighted_usage
scope:
  providerId: openai-codex
  accountRef: acct_local_hash
  modelGroup: null
window:
  kind: rolling
  durationSeconds: 604800
used:
  value: 42
  unit: percent
limit:
  value: 100
  unit: percent
remaining: 58
resetAt: 2026-08-10T12:00:00Z
observedAt: 2026-08-06T12:00:00Z
source: provider_usage_api
confidence: authoritative
```

Supported resource units should include:

- requests;
- input, output, or total tokens;
- provider-defined weighted tokens or compute units;
- percentage utilization;
- currency credits;
- model-specific allowance;
- concurrency; and
- provider-defined opaque units.

Multiple windows may apply simultaneously, such as five-hour, daily, weekly, and model-specific limits. A request can consume more than one resource.

### Observation and merging

Quota snapshots come from:

- dedicated provider usage endpoints;
- response rate-limit headers;
- response bodies or stream events;
- gateway/account APIs;
- administrator input; and
- inference from request deltas.

Partial updates replace only the windows or fields actually supplied. An omitted weekly window in a partial response must not erase the previous weekly observation. A complete authoritative snapshot may explicitly remove a window.

Each snapshot stores source, retrieval time, provider timestamp if available, freshness, account/plan scope, and whether a reset time is provider-reported or inferred.

### Opaque subscription capacity

When a provider reports only a rounded used percentage, Jouzu may infer capacity from observed intervals:

1. Accumulate per-model request usage while the reported percentage is unchanged.
2. When a positive percentage delta appears, attribute the accumulated usage to that interval.
3. Estimate units per full window from `accumulated units / percentage delta`.
4. Retain an interval distribution, not only a mean.
5. Report low/median/high estimates and confidence based on observed interval count and quota coverage.
6. Detect material percentage decreases as reset observations and compare them with advertised reset times.

This follows the useful approach already implemented in `shisa-ai/codex-pool`. The result is operational intelligence, not a provider guarantee. Different models may consume opaque quota at different rates, so Jouzu should also derive per-model value or token efficiency per observed quota point where data supports it.

### Burn and exhaustion forecasts

For each active window, Jouzu can show:

- observed utilization and headroom;
- time until reset;
- recent burn rate;
- projected utilization at reset;
- projected exhaustion time;
- source freshness and confidence; and
- which models or operations contributed.

Forecasts use simple, inspectable formulas until enough history justifies more complex models. Unknown or stale telemetry is shown explicitly.

### Allocating fixed subscription spend

Fixed spend is counted once per active account and billing period. It is not duplicated across model rows. Optional analytical allocations may distribute it by:

- observed quota consumption;
- API-equivalent value;
- request count;
- user-configured weights; or
- no allocation.

The chosen allocation method and period are displayed. `subscriptionAllocatedCost` is not called an actual per-request charge.

A useful subscription summary is:

```text
Current period subscription spend: $20
Observed quota use: 42% (weekly, provider-reported)
API-equivalent value: $58
Gross value multiple: 2.9x
Marginal/overage cost: unknown
```

It must not imply that the provider owes the user $38, that quota is token-linear, or that the ratio is net ROI.

## Prompt-cache accounting

### Catalog metadata versus runtime state

The model catalog describes known cache behavior for an offering/route:

- cache support: `yes`, `no`, or `unknown`;
- automatic versus explicit cache controls;
- minimum cacheable prefix and granularity, if known;
- supported retention modes and advertised TTLs;
- whether a successful read or write refreshes expiry;
- namespace scope, such as account/model/region/route/cache key;
- session-affinity requirements;
- read and write usage fields;
- short/long write pricing; and
- evidence and freshness.

The usage tracker records what happened for a concrete attempt. It must not treat an advertised TTL as proof that a specific entry existed or survived.

### Cache namespace

A cache lineage key can include:

```text
provider + billing account + route + API + canonical model/offering
+ provider cache key/session affinity + retention mode
+ provider-specific cache policy revision
```

Unknown namespace components make reuse `unknown`, not compatible. Caches are assumed not to be shared across providers unless verified evidence says otherwise. Exact-equivalent model offerings do not imply shared caches.

### Prompt fingerprints

To compare prefixes without storing prompt text, Jouzu computes local keyed hashes over canonicalized request sections:

- system prompt;
- tool definitions and order;
- stable conversation prefix;
- active tool set and deferred-tool state;
- images or attachments by content digest where permitted; and
- relevant provider serialization settings.

The key remains local, fingerprints are versioned, and raw payloads are not persisted. Token counts or section sizes are stored alongside fingerprints. Changes in provider serialization can invalidate comparison, so the canonicalization version is part of the lineage.

### Observed cache outcome

For each attempt, record:

```text
cacheReadTokens
cacheWriteTokens by tier
freshInputTokens
cacheHitRatio
retention requested
namespace/cache-key identity (hashed)
prefix fingerprint and comparable prefix size
provider-reported cache fields
```

Provider-reported categories are authoritative. When a provider does not report cache use, outcome remains unknown even if Jouzu predicted a hit.

### Misses, reprocessing, and recaching

Jouzu distinguishes:

- **observed cache read:** provider-reported hit tokens;
- **observed cache write:** provider-reported cache creation tokens;
- **inferred reprocessed prefix:** a previously comparable prefix not reported as a read;
- **estimated cache-loss cost:** counterfactual difference between observed pricing and an eligible cache-read scenario;
- **recaching:** observed write tokens, or an explicitly labeled inference when writes are not reported; and
- **unavoidable prompt change:** compaction, branch change, tool-schema change, system-prompt change, or other changed prefix.

A generic estimate for a comparable prefix is:

```text
reprocessed prefix = max(0, comparable prior prefix tokens - observed cache reads)
```

The estimate is only shown when fingerprints establish a comparable prefix. It carries a confidence level and provider-specific price assumptions. It must not claim that every fresh token was caused by a cache miss.

### Cache timers

Jouzu tracks:

- time since the last attempt in the lineage;
- requested retention mode;
- advertised TTL range;
- last observed write/read;
- whether activity is known to refresh expiry; and
- expected expiry range when derivable.

Pi currently uses a fixed five-minute threshold in its cache-miss notice, based on Anthropic's default TTL. Jouzu should replace this with the effective offering/route cache profile. When TTL or refresh semantics are unknown, it reports “possible expiry” rather than asserting expiry.

## Model transitions

### Why transitions are separate events

A model selection event itself consumes no tokens. Its impact appears on the next request, which may:

- submit the complete context under a different namespace;
- lose cache-read eligibility;
- write the same context into a new cache;
- use a different tokenizer or context serialization;
- move usage to another billing account or subscription quota; and
- change the applicable rate card.

Jouzu records a `model_transition` and links it to the first subsequent request attempt.

### Transition record

```yaml
transitionId: tr_01J...
sessionId: local-session-id
from:
  providerId: anthropic
  modelId: claude-sonnet-4-5
  offeringId: offering_a
to:
  providerId: amazon-bedrock
  modelId: apac.anthropic.claude-sonnet-4-5-v1:0
  offeringId: offering_b
relation: exact_equivalent
reason: user_selection
selectedAt: 2026-08-03T12:00:00Z
cacheCompatibility: incompatible
warning:
  shown: true
  estimatedResubmittedTokens: [38000, 42000]
  estimatedIncrementalCostUsd: [0.10, 0.30]
resolution: accepted
```

Reasons include explicit user selection, session restore, catalog fallback, policy change, auth loss, provider error, context-window recovery, and programmatic selection.

### Pre-switch warning

Before a material switch, Jouzu should show:

- old and new provider/model/route;
- whether the offerings are exact equivalents or merely similar;
- current comparable context estimate;
- cache compatibility: compatible, incompatible, or unknown;
- likely resubmitted/recached token range;
- estimated metered cost range under the new offering;
- affected subscription/quota scope; and
- whether the switch is temporary, session-default, or persistent.

Warning policy can be `always`, `material`, or `never`, with `material` as the proposed default. Materiality can use token and estimated-cost thresholds. Unknown quota impact remains unknown.

Pi's current `model_select` extension event fires after selection and cannot block it. A true pre-switch warning therefore requires either a Jouzu-owned picker/resolver or a new cancellable `model_before_select` hook upstream.

### Post-switch accounting

After the next request, Jouzu updates the transition with:

- actual prompt/fresh/cache read/cache write/output counters;
- observed cache-hit ratio;
- observed or inferred reprocessed prefix;
- cache-write/recaching cost;
- quota delta, when available;
- actual response model and route, if the provider reports them; and
- comparison with the pre-switch estimate.

These values remain a separate transition view while the underlying tokens and costs are counted exactly once in the request ledger.

### Automatic switching

Catalog availability, cost ranking, or quota pressure may produce a proposed alternative. They do not authorize switching.

Proposed default behavior:

- no silent model/provider switch;
- ask before exact-equivalent cross-provider fallback;
- never use a similar-model fallback without separate explicit consent;
- never switch during an in-flight request;
- report any programmatic or restore-time fallback; and
- include cache, cost, jurisdiction, and quota consequences in the decision.

## Retries, resubmissions, and recovery

### Attempt reasons

Every attempt is classified as one of:

- `initial`;
- `transport_retry`;
- `provider_retry`;
- `rate_limit_retry`;
- `server_error_retry`;
- `user_resubmit`;
- `overflow_recovery_after_compaction`;
- `auth_refresh_retry`;
- `router_retry`;
- `model_fallback`; or
- `unknown_retry`.

A changed payload, model, route, or cache namespace starts a new logical request even when it serves the same user operation.

### What to retain

Each attempt records:

- Jouzu logical request and attempt IDs;
- parent attempt and reason;
- provider/model/offering/route/account;
- composition snapshot and epoch IDs;
- worker epoch ID for fixed-worker comparisons;
- request configuration hash and prompt fingerprint;
- start/end timestamps and latency;
- HTTP status or transport error class;
- provider request/response IDs;
- terminal state;
- usage observations and completeness;
- cache lineage/outcome;
- cost entries; and
- quota snapshots or deltas.

A failed or timed-out attempt may have consumed resources even if usage is absent. Its accounting status is `unknown`, not zero.

### Correlation and idempotency

Jouzu supplies a stable logical request ID and unique attempt ID through headers where providers permit custom metadata. It stores provider response IDs such as Pi's `responseId` and observed response-model IDs. These IDs support deduplication and invoice/gateway reconciliation but do not guarantee provider-side billing idempotency.

Ledger writes use source-specific idempotency keys so rescanning a Pi session or replaying a hook cannot double count an observation.

### Hidden provider retries

SDK-level retries can make multiple physical attempts while exposing only the final response. They can also reuse the same extension headers and skip per-attempt hooks. Until Pi/provider adapters expose an attempt lifecycle, Jouzu should default provider/SDK retries to `0` and rely on visible agent-level retry behavior where practical.

If hidden retries remain enabled, the request is marked `attemptCoverage: incomplete`. Jouzu must not claim that the one visible attempt is the only billed attempt.

### Resubmission and recaching

Repeated prompt fingerprints within a short interval are linked as resubmissions. The tracker distinguishes:

- same payload retried in the same cache lineage;
- same logical work after compaction;
- user-initiated duplicate submission;
- cross-provider/model fallback; and
- provider/router internal retry when observable.

Any new cache writes and reprocessed prefix are attributed to the attempt that reported them. A “retry overhead” view is derived without adding duplicate token charges to totals.

## Storage model

The first implementation should use a local SQLite database with WAL mode and an append-oriented schema. Suggested tables are:

- `operations` — user turns, agent turns, compactions, summaries, and nested calls;
- `logical_requests` — intended completions and parent/recovery links;
- `request_attempts` — physical dispatches and terminal status;
- `usage_observations` — raw and normalized counters with source and semantics;
- `cost_entries` — typed immutable cost/value/adjustment entries;
- `model_transitions` — selection changes and predicted/observed impact;
- `cache_observations` — lineage, fingerprints, timers, hits, misses, and writes;
- `billing_accounts` — local pseudonymous account/plan identity;
- `plan_periods` — recurring spend and effective plan metadata;
- `quota_snapshots` — typed windows and freshness;
- `pricing_snapshots` — request-time rate-card materialization;
- `composition_snapshots` and `composition_epochs` — immutable effective-capability identity and session transitions;
- `worker_epochs` — model, offering/route, Pi/`pi-ai`, and native-action identity for qualification and harness evaluation; and
- `daily_rollups` — rebuildable reporting aggregates.

The detailed raw schema remains private to the local installation. Public exports are redacted and aggregated unless the user explicitly requests request-level data.

### Identity and branching

Pi session entry IDs are stable ingestion keys. Accounting totals include all actual requests in a session file, including requests on abandoned branches, because those requests were still made and charged. Active-branch context usage is a separate view.

Compaction and branch-summary usage is recorded as its own operation and not merged into the next normal turn. Nested tool model usage is similarly separate when provenance is available.

### Retention

Retention is configurable by data class:

- request/usage/cost facts: long enough for billing reconciliation and user reporting;
- quota snapshots: enough for window/capacity inference;
- prompt fingerprints: shorter retention if desired, because they are only needed for cache lineage;
- daily rollups: longer than raw attempt data; and
- provider headers: allowlisted fields only, with short retention unless needed for reconciliation.

Deleting a session transcript does not implicitly delete accounting records unless the user selects a privacy mode that couples them.

## Pi integration

### Existing Pi behavior to reuse

Pi 0.83 already provides:

- normalized `Usage` fields for input, output, cache read, cache write, optional cache-write TTL detail, reasoning, and cost;
- provider-side token cost calculation, including request-wide input tiers and Anthropic long cache writes;
- assistant `responseId`, optional `responseModel`, provider/model IDs, timestamp, and stop reason;
- persisted `model_change` and `thinking_level_change` session entries;
- a `model_select` event;
- pre-payload and post-response-header extension hooks;
- per-message usage persistence, including error/aborted messages when available;
- usage from compaction, branch summaries, and nested model calls reported by tools;
- all-session token/cost totals and per-model breakdowns; and
- cache-waste estimation that recognizes model changes and excludes compaction boundaries.

Pi's cost projection should remain available for its footer and session compatibility. Jouzu's ledger adds provenance, attempts, immutable pricing snapshots, subscription/quota dimensions, and richer cache semantics.

### Extension prototype

A Jouzu extension can initially collect:

- `model_select` for completed transitions;
- `context` and `before_provider_request` for locally hashed prompt/payload fingerprints;
- `before_provider_headers` for Jouzu correlation IDs;
- `after_provider_response` for status, allowlisted request IDs, and quota headers;
- `message_end` for finalized normalized usage and cost;
- `session_compact` and session entries for compaction usage;
- tool-result usage for nested calls; and
- session IDs/entry IDs for idempotent ingestion.

The extension writes to a sidecar ledger, not raw prompt logs. It can replace Pi's displayed calculated cost only when necessary for compatibility, but the durable ledger is authoritative for Jouzu reporting.

### Required Pi integration improvements

A complete implementation needs upstream hooks or a Jouzu runtime integration for:

1. `model_before_select` — cancellable, with previous/next model and source.
2. `provider_request_start` — stable logical request ID, operation ID, model, account scope, and payload fingerprint hook.
3. `provider_attempt_start` / `provider_attempt_end` — one event per SDK/network attempt with attempt reason and status.
4. `provider_request_end` — terminal usage, response IDs, actual response model, and completeness.
5. Retry lifecycle exposure to extensions, including provider-level and agent-level retry correlation.
6. Explicit usage parser semantics and raw category metadata.
7. Cache retention/write-tier metadata beyond a single aggregate where providers report it.
8. Provenance for nested tool usage, which Pi currently aggregates into a tools/summaries bucket. Subagent delegation makes this acute rather than cosmetic: a review fan-out multiplies the cost of a turn, each child is a separate process with its own cache lineage and full context submission, and an aggregate bucket cannot say which delegate earned its cost. Delegate invocations are distinct operations carrying `delegateId`, `delegateRevision`, and `parentOperationId`; see [Delegation and Adversarial Review](DELEGATION-AND-REVIEW.md).
9. Account/credential pseudonymous identity without exposing secrets.
10. A safe way to attach accounting and composition snapshot/epoch IDs to session entries without changing model context.

The attempt hooks must fire around every retry. Pi's existing `before_provider_headers` runs once and retries may reuse headers, so it cannot by itself prove attempt count.

### Double-count prevention

Jouzu chooses one canonical ingestion path per observation:

- live attempt hook when available;
- otherwise finalized Pi message usage keyed by session entry ID;
- session reindex only for observations not already present.

Derived rollups never become new raw usage observations. Compaction and nested-tool usage have distinct operation keys.

## DeepSeek Harness integration

DeepSeek Harness is a promising second ingestion adapter, not a replacement ledger. Its canonical append-only session log records effective request headers, route context, turn/step boundaries, raw stream chunks, assistant usage, tool activity, compaction, structured failures, and durable retry scheduling/start events. Its LLM contract requires one adapter call per provider attempt; the `pi-ai` adapter disables SDK retries so harness retries occur at visible durable boundaries. Failed attempts can retain usage chunks even when no assistant message commits.

These facts cover more of Jouzu's physical-attempt model than Pi's current public extension hooks, but they are still incomplete. DSH does not retain every provider-native raw usage field, parser semantic, response header, billing identity, price revision, cache-write tier, quota delta, or cache lineage that Jouzu requires. Model selection intent also is not durable until a later request header consumes it.

A DSH ledger plugin should ingest the canonical `session/event` feed and persisted log idempotently. It must not use outbound session telemetry as the accounting source: that path exports only the first assistant chunk per step, permits gaps and duplicates, and is best-effort. The runtime-specific adapter maps DSH turns, steps, retries, and usage chunks into the same neutral operations, logical requests, attempts, and observations used by Pi ingestion. See [DeepSeek Harness and Jouzu](DEEPSEEK-HARNESS.md).

## User experience

### Footer and session summary

The default compact view should show:

- current context size;
- session input/output/cache read/cache write;
- current cache-hit ratio;
- metered estimated cost or `unknown`;
- active subscription quota headroom when available; and
- a stale/partial indicator.

An expanded view separates:

- actual/provider-reported charge;
- metered estimate;
- API-equivalent value;
- subscription spend and period;
- allocated cost method;
- cache-loss/recaching estimates;
- retries/unknown attempts; and
- quota windows and reset times.

### Commands

Provisional commands:

```text
jouzu usage session
jouzu usage request <id>
jouzu usage explain <id>
jouzu usage export
jouzu cost session|day|month
jouzu quota status
jouzu cache status
jouzu cache explain <transition-or-request-id>
```

### Warnings

Warnings are actionable and deduplicated. Examples:

- “Switching providers will probably start a new cache lineage; approximately 40k context tokens may be processed again.”
- “The selected subscription is at 82% of its weekly quota, resetting in 19h.”
- “This provider returned no usage data; cost for the failed attempt is unknown.”
- “Three provider attempts may have occurred inside SDK retry logic; attempt-level accounting is incomplete.”
- “Pricing is stale or incomplete; estimated cost excludes cache-write price.”

## Privacy and security

- No API keys, OAuth tokens, authorization headers, raw prompts, or raw tool results in the ledger.
- Billing account IDs are local pseudonyms or keyed hashes.
- Prompt fingerprints use a local secret and cannot be compared across installations by default.
- Response headers are allowlisted; cookies and arbitrary metadata are not persisted.
- Provider request/response IDs may be sensitive and can be hashed or omitted by privacy mode.
- Runtime usage, private endpoint metadata, subscriptions, and quotas stay local unless the user explicitly configures synchronization.
- Exports state whether IDs are raw, hashed, or removed.
- SQLite files use restrictive permissions and support user-controlled retention/deletion.

## Failure behavior

- Telemetry write failure does not fail an otherwise valid model request; it queues a bounded retry and surfaces degraded accounting.
- Storage corruption preserves the Pi session and starts no destructive repair automatically.
- Missing pricing yields unknown cost while retaining token usage.
- Missing usage yields an unknown-attempt record while retaining status/timing.
- Failed quota polling keeps the last snapshot with increasing staleness.
- Partial quota updates preserve omitted windows.
- Calculation failure cannot mutate the raw observation.
- Hard quota enforcement, if enabled elsewhere, uses an atomically published evaluated snapshot and an explicit stale-data policy.

## Lessons to carry forward from `shisa-ai/codex-pool`

Jouzu should reuse these proven concepts:

- persist inclusive versus additive input-token semantics;
- normalize again at the accounting sink so transport parsers cannot diverge;
- do not double-charge reasoning nested in output;
- store request-time price, billable categories, and formula version;
- use provider/account-specific price overrides over generic third-party data;
- reconcile raw rows and rebuild rollups in one transaction;
- preserve omitted quota windows in partial updates;
- separate API-equivalent value from subscription spend;
- exclude inactive subscriptions from current recurring spend without deleting history;
- infer opaque quota from complete percentage intervals, with ranges and confidence; and
- hash account identity in shared analytics.

Jouzu should improve on or avoid these current limitations:

- unknown prices must not contribute an unlabeled `$0`;
- pricing source/revision should be explicit per request;
- generic “billable tokens” should not hide separately priced cache units;
- physical retry attempts and cache lineages need first-class identities; and
- subscription allocation and API-equivalent value must remain visibly distinct from actual spend.

## Testing strategy

- Inclusive/additive/unknown input semantics fixtures.
- Reasoning-subset and provider-specific output semantics tests.
- Split stream, aborted stream, missing usage, and partial usage tests.
- Short/long cache-write tier and request-wide price-tier tests.
- Immutable price snapshot and explicit reconciliation tests.
- Metered, subscription, prepaid, hybrid, free, and local billing tests.
- Partial quota-window merge and stale snapshot tests.
- Rounded quota interval, reset, capacity range, and confidence tests.
- Prompt-fingerprint canonicalization and privacy tests.
- Cache hit, partial hit, TTL expiry, tool-schema change, compaction, and branch-change tests.
- Same-model cross-provider and same-provider route-switch tests.
- Pre-switch estimate versus post-switch observed attribution tests.
- Agent retry, SDK retry, overflow recovery, user resubmit, and fallback tests.
- Crash/restart, duplicate session ingestion, and idempotency tests.
- Transactional rollup rebuild and adjustment-ledger tests.
- Pi session, compaction, nested tool, and model-change compatibility tests.

## Proposed implementation phases

### Phase 1: normalized session ledger

- Define operation, request, attempt, usage, cost, and transition schemas.
- Ingest existing Pi session message, compaction, tool, and model-change records idempotently.
- Snapshot catalog pricing and calculate labeled metered estimates.
- Add session/model token and cost reports.

### Phase 2: live Pi extension instrumentation

- Add correlation IDs, payload fingerprints, response-header capture, finalized usage ingestion, and transition records.
- Add cache-hit and model-switch post-request reports.
- Default provider SDK retries to zero where attempt visibility is required.

### Phase 3: cache-aware selection

- Add provider/route cache profiles to the model catalog.
- Add cancellable pre-switch warnings through a Jouzu picker or upstream Pi hook.
- Add cache lineages, expiry ranges, reprocessed-prefix estimates, and recaching cost.

### Phase 4: plans and quotas

- Add billing accounts, plan periods, recurring spend, quota adapters, partial-window merging, and reset tracking.
- Port the codex-pool quota interval/capacity inference with explicit confidence.
- Add burn forecasts and optional quota-aware warnings.

### Phase 5: full attempt accounting

- Add or upstream provider-attempt lifecycle hooks in Pi.
- Track visible transport/provider retries, unknown hidden-retry coverage, and retry overhead.
- Add invoice/gateway reconciliation and append-only adjustments.

## Open questions

1. Should the usage ledger live in Jouzu's config directory, Pi's agent directory, or a separately configurable data directory?
2. What raw-attempt and prompt-fingerprint retention defaults are appropriate?
3. Which providers expose reliable usage/quota APIs or response headers in the first release?
4. Should provider SDK retries be globally disabled by Jouzu or only for providers with ambiguous billing?
5. What token/cost threshold should make a model-switch warning material?
6. Should exact same-provider aliases ever be considered cache-compatible without observed evidence?
7. Which subscription allocation method, if any, should be the default?
8. How should team/shared subscriptions avoid exposing one user's usage to another?
9. Do we need encrypted local storage for provider response IDs and account/plan metadata?
10. Which Pi hooks should be implemented in Jouzu first and which should be proposed upstream?
11. How should cloud invoices or gateway exports reconcile with local attempts when provider IDs are missing?
12. Should quota-based automatic blocking be a separate policy design document?

## Required invariants

- A request's raw usage observation is never overwritten by a later estimate.
- Reasoning tokens are not double-counted when included in output.
- Cache reads and writes remain separate priced units.
- Missing pricing or usage is never silently converted to zero.
- An unknown response model is never priced through a silent provider-default model fallback.
- Historical totals do not change on ordinary catalog refresh.
- Fixed subscription spend is counted once per active account and period.
- API-equivalent value is never labeled actual subscription spend.
- A model switch is never hidden, and it never double-counts the next request's tokens.
- Similar-model fallback is never automatic without explicit consent.
- Failed, aborted, and retried attempts remain visible even when their usage is unknown.
- Partial quota responses never erase unrelated windows.
- Raw prompts and credentials never enter the usage ledger.
- Derived rollups can always be rebuilt from retained immutable facts.
