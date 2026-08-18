# DeepSeek Harness and Jouzu

- **Status:** Research note and provisional architecture decision
- **Source snapshot:** `deepseek-ai/deepseek-harness` commit `47f943859bef60e4160492346772ded9b24f765a`
- **Related:** [Recomposition and Controlled Evolution](COMPOSITION.md), [Harness Engineering and Jouzu](HARNESS-ENGINEERING.md), [Repository Knowledge and Code Graphs](REPOSITORY-KNOWLEDGE.md), [Model Catalog](MODEL-CATALOG.md), [Usage Tracking and Cost Accounting](USAGE-TRACKING.md), [Agent Control Plane](CONTROL-PLANE.md), [Delegation and Adversarial Review](DELEGATION-AND-REVIEW.md)

## Decision

DeepSeek Harness should **not replace Pi as Jouzu's primary runtime today**, and Jouzu should not merge or vendor its source tree. Jouzu is currently a Japanese-first distribution of Pi's terminal coding harness; DeepSeek Harness is a substantially larger, browser/headless Cordis platform in developer preview, with incompatible extension, session, configuration, and UI contracts.

It does belong in the Jouzu design in three narrower roles:

1. **Reference architecture:** adopt lessons from its capability seams, reconstructable append-only event log, profiles/bundles, single-attempt LLM boundary, and trace UI.
2. **Interoperability target:** preserve portable skills and investigate bounded ACP delegation without pretending the two runtimes share a session.
3. **Second consumer:** keep Jouzu's model catalog and usage ledger runtime-neutral enough to support a DeepSeek Harness adapter after the Pi implementation is working.

This is a sequencing decision, not a permanent rejection. If Jouzu's product goal changes from a Japanese-first terminal agent to a browser-first composable agent platform, DeepSeek Harness deserves a fresh foundation review rather than incremental imitation inside Pi.

## What DeepSeek Harness is

DeepSeek Harness (`dsh`) is an official MIT-licensed DeepSeek project. Its stated equation is “Agent = Model + Harness,” and its central design rule is “everything is a plugin.” It uses the [Cordis](https://github.com/cordiverse/cordis) framework for dependency-aware plugin lifecycles, services, events, configuration, and reversible effects.

The inspected source declares `0.1.0-rc.5`; npm's `latest` tag was `0.1.0-rc.6` at research time. The project explicitly calls itself a **developer preview** and warns that compatibility-breaking changes will occur. It has no tagged GitHub releases. This is active pre-stable software, not a compatibility baseline Jouzu can safely fork once and forget.

Its shipped product surfaces are:

- a browser application (`dsh web`);
- a one-shot headless profile;
- an automation-only ACP server in the source tree; and
- composable agent presets/modes over a shared plugin base.

It does not currently ship a Pi-equivalent terminal TUI. The CLI documentation uses a hypothetical `tui` profile only as an example of something another package could install.

The source is a large platform: the inspected tree has more than 200 package manifests and roughly 109,000 TypeScript/TSX lines under `packages/` and `apps/`. That scale buys substantial capability, but it also makes a downstream source fork a materially different maintenance commitment from Jouzu's current Pi distribution plan.

## Architectural comparison

| Dimension | Jouzu on Pi | DeepSeek Harness | Consequence |
| --- | --- | --- | --- |
| Primary surface | Terminal-first interactive TUI | Browser and headless profiles | DSH is not a drop-in replacement for Jouzu's initial UX. |
| Core posture | Small harness extended by Pi extensions, skills, packages, and TUI components | Cordis plugin tree in which services, loops, storage, tools, and UI are plugins | DSH has stronger composition seams but a much larger conceptual and package surface. |
| Extension unit | Pi `ExtensionFactory`, events, tools, commands, UI, and Pi packages | Cordis plugins, services, events, fibers, bundles, profiles, and patch layers | Plugins are not binary- or source-compatible; an adapter or rewrite is required. |
| LLM foundation | `@earendil-works/pi-ai` through Pi | Provider-neutral `ctx.llm`; its multi-provider adapter also uses `@earendil-works/pi-ai` | `pi-ai` is the most valuable shared implementation boundary. |
| Sessions | Pi JSONL tree with branching entries | Typed append-only `SessionEvent` log; model history is a projection | Jouzu ledger schemas can be shared, but ingestion adapters must remain runtime-specific. |
| Traceability | Pi events and persisted messages, with some request/attempt gaps | Request headers, raw chunks, turn/step/tool events, retries, replay, fork, and Trajectory UI derive from one log | DSH is a strong design reference for the usage ledger and request reconstruction. |
| Composition | Settings, extensions, packages, profiles Jouzu adds | Ordered bundle layers plus profile/home/CLI patch overlays | The bundle/profile idea is useful for Jouzu editions, but Cordis YAML is not a portable Jouzu config format. |
| Localization | Japanese-first is a product requirement | Browser locale IDs and typed dictionaries are closed over `zh` and `en` | Japanese support currently requires upstream/core changes and broad dictionary work, not one out-of-tree plugin. |
| Maturity | Jouzu pins Pi `0.83.0`; Pi is the declared base | Developer-preview RC with breaking changes promised | DSH should be pinned only for experiments until it publishes a stability policy. |

## What Jouzu should learn from DSH

### “Self-evolving” is controlled recomposition, not autonomous learning

The strongest lesson is more precise than the label “self-evolving.” DSH combines two mechanisms:

1. **Cordis spatiotemporal composition:** a plugin declares dependencies, owns effects that unwind on unload, and can be replaced without patching a privileged agent core.
2. **Creator-mode authoring:** the model inspects exact live contracts, defines an immutable dynamic Package without executing it, activates one exact version as a distinct Run, observes diagnostics, stops or rolls back it, and separately authors a durable preset for future sessions.

This is a strong **self-inspection and recomposition** system. It is not yet an evidence-based self-improvement system: dynamic Packages live only in process memory, promotion is deliberately separate and never automatic, and DSH does not close a quality/cost evaluation loop that selects and deploys a better composition. Jouzu should preserve that distinction. “Evolution” should mean a governed loop of `observe -> propose -> validate -> evaluate -> approve -> canary -> promote/rollback`, not merely that the model wrote code or edited a prompt.

Several details keep DSH's mechanism disciplined:

- stable Plugin identity, immutable Package versions, and separate activation Run identities;
- define and syntax-check before any execution;
- exact generated interface inspection instead of guessed service methods;
- explicit pending, approval, running, failed, stopped, and rollback states;
- fiber-owned cleanup that reaches quiescence before an unload completes;
- process-local experiments with no automatic persistence or promotion;
- version-bound Client approval and no automatic retry after rejection;
- copied user presets rather than edits to the shipped known-good presets; and
- blank-session-only full preset switching, because tools and prompts are part of the conversation's semantics.

The result is best understood as **human-authorized agent recomposition**. Its documented `node:vm` boundary remains trusted code execution equivalent to shell access, not sandboxed learning.

Jouzu should adopt the invariants while adapting the mechanics to Pi:

| Adopt | Adapt for Pi | Avoid |
| --- | --- | --- |
| Recomposition over hidden mutation | Resolve Pi packages, extensions, skills, prompts, tools, and model policy from a declarative Jouzu manifest | Embedding Cordis or copying its YAML loader |
| Reversible effects and awaited shutdown | Add an effect-scope helper over Pi's `session_shutdown`; Pi already replaces registered handlers/tools on reload, but extension-owned timers, processes, watchers, and callbacks need cleanup | Claiming Pi currently provides per-plugin reactive dependency replacement |
| Inspect before authoring | Build an effective-composition report from Pi resource diagnostics, tool `sourceInfo` and schemas, the Jouzu catalog, and explicit capability descriptors | Hand-maintained API tables or arbitrary live-object dumps |
| Stable identity, immutable revisions, distinct runs | Content-address composition candidates and record each validation/evaluation/activation attempt | Overwriting the previous known-good candidate or its failure evidence |
| Separate experiment from promotion | Run candidate extensions/configuration in a fresh restricted Pi process, then promote a reviewed file/package revision | Evaluating model-written JavaScript in the primary Jouzu TUI process by default |
| Composition is durable session semantics | Record a resolved composition snapshot/epoch before the request that uses it and link usage attempts to it | Silent model-visible hot reload or unlogged capability switching |
| Scope and authority follow ownership | Keep trust, credentials, package integrity, sandbox/approval ceilings, catalog trust, and accounting outside session-editable profiles | Letting an agent-authored profile relax the policy governing itself |

The recommended maturity order is deliberately conservative:

1. **Inspectable static composition** — snapshot what Pi actually loaded, with origin, version, hash, policy decision, tool schemas, and model-catalog revision.
2. **Declarative profiles** — resolve versioned layered manifests and select them at startup; structural changes after first use default to a new or forked session.
3. **Isolated candidate authoring** — let a Creator profile write normal artifacts, validate them, show a capability/authority diff, and smoke-test them in a child Pi process.
4. **Evidence-based evolution** — correlate composition IDs with tests, user feedback, safety checks, latency, retries, cache behavior, and cost; require an explicit promotion rule and rollback target.
5. **Narrow live experiments only if justified** — prefer a separate worker and constrained RPC boundary even then.

The detailed Jouzu design and implementation implications are in [Recomposition and Controlled Evolution](COMPOSITION.md). This is a philosophical adoption: Jouzu can become self-describing, agent-authorable, testable, and rollbackable without becoming an in-process arbitrary-code host.

### Capability seams rather than scattered conditionals

DSH distinguishes a Service Definition, Service Provider, and Consumer. Filesystem, subprocess, sandbox, shell, persistence, subagent, LLM, storage, and web capabilities can be replaced through these seams. Jouzu does not need Cordis to adopt the design lesson: policy and provider-specific behavior should enter through explicit interfaces and events rather than checks scattered across the Pi fork.

The catalog and usage work already follows this direction:

- one neutral catalog with client projections;
- route-specific compatibility rather than model-name conditionals;
- one ledger with runtime-specific ingestion adapters; and
- policy kept separate from transport execution.

### Model-visible means reconstructable

DSH's session log is the source of truth for everything the model sees. A `request/header` event records provider, model, reasoning effort, sampling values, system prompt, and tool schemas. Derived history plus the latest header reconstructs a request. Raw assistant chunks remain in the log for replay while assembled messages form model history.

Jouzu should carry this invariant into any Pi integration it owns: a model/provider switch, injected context, tool-schema change, compaction, and retry must be explainable from durable records. Accounting-only IDs and private metadata may remain outside model context, but must still have stable links to the request they describe.

### One adapter call, one visible attempt

DSH requires an LLM adapter call to represent one provider attempt. Its `llm-pi-ai` adapter disables SDK retries, and `dsh-llm-retry` performs retries at durable agent boundaries with `llm/retry` and `llm/retry-started` events. Failed attempts retain raw usage chunks even when no assistant message is committed.

This is close to Jouzu's physical-attempt accounting requirement and is cleaner than inferring hidden SDK retries after the fact. Jouzu should keep the same rule where it controls dispatch: disable hidden retries, expose attempt lifecycle, and make retries durable without adding failed partial output to model history.

### Profiles and bundles

DSH profiles stack ordered bundles and then apply user and command-line overlays. The useful Jouzu lesson is to distinguish:

- product defaults;
- an edition/profile, such as Japanese terminal, headless CI, or a future browser experiment;
- organization policy;
- user settings; and
- one-run overrides.

Jouzu should not adopt Cordis patch semantics as its universal configuration format. It should adopt the explicit layering and explain which layer supplied each effective value.

### Trajectory as a projection

DSH's Trajectory UI is a projection over the same event stream used for replay and persistence. Jouzu's future usage and provenance views should follow that approach: render immutable facts and derived rollups rather than maintain a second, drifting interaction transcript.

## Model catalog fit

DeepSeek Harness validates part of Jouzu's current catalog direction, but it does not replace it.

Its `@deepseek-ai/dsh-llm-pi-ai` adapter already:

- consumes Pi's `pi-ai` provider/model catalog;
- supports installed and hand-declared provider routes;
- exposes per-route and per-model `thinkingFormat` and `supportsReasoningEffort` overrides for OpenAI Chat Completions;
- exposes per-model reasoning effort maps, context, output defaults, and modalities;
- resolves settings and credentials for every request; and
- offers manual OpenAI-compatible `GET /models` interrogation.

That is direct evidence for Jouzu's Qwen compatibility design: reasoning format and effort support are route/model compatibility facts, not global model-family booleans. DSH also refuses unsupported explicit effort levels before network I/O and keeps an in-flight request on the adapter registration under which it was prepared.

Its model surface remains narrower than Jouzu's requirements:

- no signed catalog or last-known-good update contract beyond settings behavior;
- no canonical-model/offering/route identity graph;
- no jurisdiction, processing location, retention, ZDR, plan, quota, or evidence records;
- no pricing consumer in the DSH LLM seam;
- no user-facing model equivalence or policy filtering;
- no configurable `supportsDeveloperRole` override in `llm-pi-ai`; and
- no automatic catalog refresh—endpoint interrogation produces candidates that a user may adopt into settings.

Therefore:

1. `jouzu.model-catalog` remains the canonical neutral format.
2. Pi remains the first projection and execution client.
3. A future DSH projection maps only the fields DSH can faithfully consume: provider/model identity, endpoint/protocol, context, output default, modalities, reasoning efforts, and supported compatibility switches.
4. Rich route, policy, price, provenance, and lifecycle data remains in the Jouzu sidecar and must be enforced by a Jouzu policy plugin/UI rather than discarded.
5. A DSH integration should be a catalog-backed LLM adapter or a new upstream catalog seam. It should not silently rewrite the user's `llm-pi-ai` settings document behind their back.
6. If the Jouzu adapter registers routes also owned by `dsh-llm-pi-ai`, the profile must disable or narrow the stock adapter explicitly; DSH rejects duplicate route ownership.

DeepSeek Harness should be added as a projection fixture only after the neutral catalog schema and Pi projection are stable enough to reveal whether the schema is genuinely client-neutral.

## Usage-ledger fit

DSH is a promising second ingestion source because its canonical log already contains:

- turn and step boundaries;
- effective `request/header` and route context;
- raw stream chunks, including usage reported by failed attempts;
- assembled assistant messages and successful usage;
- tool calls and results;
- compaction events and auxiliary-call usage;
- structured turn failures; and
- durable retry scheduling and start records.

Its normalized `TokenUsage` is explicitly disjoint: uncached input, cache reads, cache writes, output, and optional reasoning detail. Reasoning is a subset of output. These semantics align closely with Jouzu's normalized token contract.

Important gaps remain:

- DSH does not retain every provider-native raw usage field or parser semantic needed for later audit.
- The core usage type has no short/long cache-write tiers, provider-reported charge, billing account, price revision, quota delta, or cache lineage.
- HTTP headers/status and response IDs are adapter-dependent and not a complete ledger contract.
- A model selection is durable only when a later request header consumes it; Jouzu also needs the selection intent and pre-switch warning.
- Retry records describe harness retries, not unobservable retries inside an upstream gateway.
- ACP intentionally omits usage from its wire surface.

A future DSH ledger plugin should subscribe to the canonical `session/event` feed and ingest the persisted log idempotently. It should **not** use outbound session telemetry as its accounting source: DSH telemetry exports only the first assistant chunk of a step, permits gaps, and is explicitly best-effort. The canonical log is the accounting source; telemetry is an optional export sink.

## Interoperability boundary

### Portable skills

DSH scans project and user `.agents/skills` roots and supports directory `SKILL.md` bundles. Jouzu should keep its own skills compatible with the common Agent Skills shape where possible. Runtime-specific invocation policy or path precedence may differ, but instruction bodies and bundled resources can remain portable.

This is the cheapest useful integration: shared skills do not require shared plugin APIs or shared sessions.

### ACP

DSH includes both an automation-only ACP server and an ACP subagent provider. ACP is the most plausible process boundary between Jouzu/Pi and DSH, but the current server is intentionally narrow:

- fresh sessions only—no list, resume, delete, or fork;
- text and baseline resource links only;
- one workspace and no advertised MCP/editor/terminal capability;
- committed assistant text only—no reasoning, tools, plans, titles, or usage; and
- connection-owned session lifetime.

Pi currently offers its own SDK/RPC/JSON modes rather than DSH's ACP contract. Interoperation therefore needs either a Jouzu ACP mode or an explicit Pi-RPC-to-ACP bridge.

The first ACP experiment should be narrow, local, and honest: delegate one fresh task, treat the child as a separate session and cache/billing lineage, return only its final text, and preserve cancellation. ACP should not be used to imply seamless resume or shared accounting until the protocol surface actually carries those facts.

### Plugins are not portable

A Pi extension cannot be loaded as a Cordis plugin, and a Cordis bundle cannot be installed as a Pi package. Tool schemas and business logic can sometimes share a library, but lifecycle, context, UI, settings, permissions, and persistence adapters must be written for each runtime.

## Security and privacy guardrails

Several DSH features need an explicit Jouzu posture rather than inherited defaults:

1. **Creator/dynamic packages:** the host runner states that its Node `vm` isolates globals but is not a security boundary and should be treated like bash access. Jouzu must not enable model-written runtime plugins by default.
2. **Sandbox scope:** DSH's sandbox modes govern filesystem effects; network and process visibility are outside that vocabulary, and enforcement may be partial on some platforms. Jouzu must not label this a complete security boundary.
3. **Telemetry:** the shipped base mounts an OpenTelemetry backend disabled by default. Full mode can export raw captured session records with no built-in redaction rule. Any Jouzu DSH profile should remove or replace that row, or require an explicit, disclosed opt-in with a reviewed destination and redaction policy.
4. **DeepSeek transport identity:** the native DeepSeek adapter sends a stable anonymous user ID and, for session calls, a session ID to its resolved base URL, including a configured gateway. Jouzu must decide this under its own privacy policy rather than inherit it accidentally.
5. **Credentials and arbitrary plugins:** ordinary installed Cordis plugins are trusted host code, just as Pi extensions are. Package signatures and catalog signatures do not sandbox plugin execution.

## Options considered

### Replace Pi with DeepSeek Harness now

**Rejected.** It would discard Jouzu's terminal-first Pi compatibility, require a large Japanese localization fork, and anchor Jouzu to an unstable RC API. It also does not eliminate the need for Jouzu's richer model catalog and accounting work.

### Ship both Pi and DSH behind one `jouzu` command now

**Rejected for the initial product.** Two runtimes would create two extension ecosystems, session formats, settings stores, permission models, model selectors, and bug surfaces. A wrapper command would hide that split rather than solve it.

### Fork DSH and add Japanese

**Rejected for now.** DSH's locale set is hardcoded as `zh | en`, typed dictionary registration requires every shipped locale, and much UI copy remains package-owned. Japanese-first support is broad source work. The preferred route is an upstream-extensible locale registry followed by an out-of-tree Japanese language package or an upstream Japanese locale.

### Treat DSH as a reference and optional target

**Accepted.** This captures its strongest ideas, preserves Jouzu's current product identity, and creates concrete cross-runtime tests without committing to a second core.

## Recommended roadmap

### Now

1. Keep Pi as Jouzu's primary runtime and finish the neutral catalog schema, Pi projection, and initial Pi usage ingestion.
2. Define the first composition snapshot identity early enough for the usage ledger to attach it to operations and requests.
3. Prototype read-only effective-composition inspection before any model-facing authoring or live extension mechanism.
4. Record DSH as a reviewed research target, not as another pinned production upstream.
5. Reuse portable `.agents/skills` content where behavior is compatible.
6. Borrow the invariants “model-visible means logged,” “one visible adapter call equals one attempt,” and “a dynamic effect must be fully reversible.”

### After the neutral schemas exist

1. Add a DSH catalog projection fixture pinned to an exact DSH and `pi-ai` version.
2. Add a DSH session-log ingestion fixture covering success, failed usage, retry, compaction, tool calls, and a model transition.
3. Verify that the catalog and ledger core packages contain no Pi session or UI types; keep Pi and DSH in adapter packages.
4. Propose upstream DSH seams only where a plugin cannot preserve Jouzu policy—for example richer catalog metadata or extensible locale IDs.

### Optional experiments

Run three bounded spikes, in this order:

1. **Projection spike:** compile one Jouzu Qwen offering into both Pi model JSON and a DSH route/model profile; assert developer-role and thinking on/off request shapes end to end.
2. **Ledger spike:** ingest a saved DSH log into the same normalized Jouzu ledger used for a Pi fixture, without remote telemetry.
3. **ACP spike:** delegate one fresh local task across a Jouzu/DSH process boundary with cancellation and explicit independent-usage labeling.

Do not start with a branded DSH Web edition. The shared catalog, ledger, and interoperability boundaries should prove themselves first.

## Reconsideration gates

Revisit DSH as a Jouzu runtime foundation only when all of these are true:

- DSH publishes a usable stability and migration policy beyond developer preview;
- Japanese can be added without maintaining a broad source fork, or Jouzu accepts that fork cost explicitly;
- the product wants a browser-first plugin platform strongly enough to trade away Pi/TUI compatibility;
- Jouzu policy, catalog provenance, telemetry, and privacy can be preserved through supported extension points;
- session migration or product-level separation is explicit rather than hidden by one command name; and
- a prototype passes equivalent request-shape, safety, accounting, cancellation, and offline tests.

## Primary sources

- [DeepSeek Harness announcement and design overview](https://www.deepseek.com/harness/en/)
- [Official repository README](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/README.md)
- [Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md)
- [CLI profiles and product surfaces](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/README.md)
- [Self-referential Cordis toolset](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/extensions/tool-cordis/README.md)
- [Per-preset agent composition](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/preset/agent-presets/README.md)
- [Cordis spatiotemporal composability preprint](https://github.com/cordiverse/paper)
- [Provider-neutral LLM seam](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm/README.md)
- [`pi-ai` multi-provider adapter](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm-pi-ai/README.md)
- [Session event model](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/session.md)
- [LLM streaming and token usage](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/llm-streaming.md)
- [Durable retry plugin](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm-retry/README.md)
- [ACP server](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/acp/acp/README.md)
- [Filesystem skill provider](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/skill/skill-filesystem/README.md)
- [Locale implementation](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/client/locale/src/locale-settings.ts)
- [Dynamic package trust stance](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/extensions/cordis-host-runner/README.md)
- [Process sandbox scope](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/sandbox.md)
- [MIT license](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/LICENSE)
- [Published npm package](https://www.npmjs.com/package/@deepseek-ai/dsh)
