# Jouzu Recomposition and Controlled Evolution

- **Status:** Provisional design principles
- **Scope:** Agent profiles, capability composition, runtime inspection, experimentation, promotion, rollback, and evidence-based evolution on Pi
- **Related:** [Harness Engineering and Jouzu](HARNESS-ENGINEERING.md), [DeepSeek Harness and Jouzu](DEEPSEEK-HARNESS.md), [Model Catalog](MODEL-CATALOG.md), [Usage Tracking and Cost Accounting](USAGE-TRACKING.md), [Agent Control Plane](CONTROL-PLANE.md), [Delegation and Adversarial Review](DELEGATION-AND-REVIEW.md)

## Summary

Jouzu should adopt DeepSeek Harness's **recomposition philosophy**, not its Cordis runtime or its in-process model-written plugin mechanism.

The useful idea is that an agent is a resolved composition of named capabilities with explicit identity, provenance, dependencies, scope, and lifetime. A change should produce a new inspectable composition revision, not an accumulation of hidden mutations. Dynamic behavior is acceptable only when it is reversible, observable, and subordinate to policy.

“Self-evolving” should be used precisely. DeepSeek Harness Creator mode currently provides strong **self-inspection, temporary self-extension, and agent-assisted preset authoring**. It does not provide an autonomous evidence-and-promotion loop. Jouzu should call the former **recomposition**. It should reserve **evolution** for a controlled loop:

```text
observe -> propose -> validate -> evaluate -> approve -> canary -> promote or roll back
```

Jouzu's first implementation should be declarative and process-isolated:

- a versioned composition manifest selects reviewed Pi extensions, skills, prompts, tools, model policy, and workflow settings;
- Jouzu resolves it to an immutable composition snapshot for a session or composition epoch;
- the snapshot and its provenance are recorded before the affected model request;
- an agent may draft a candidate manifest or normal Pi extension in the workspace;
- validation and experiments run in a fresh restricted Pi process, not as model-written JavaScript inside the live parent process; and
- a person or organization policy promotes a tested candidate. No candidate can promote itself, relax its own policy, or silently replace a running session's capabilities.

## What DeepSeek Harness actually does

DeepSeek Harness has two related but distinct composition mechanisms.

### Cordis runtime composition

Cordis supplies the mechanical foundation:

- a plugin instance is a fiber with an explicit lifecycle;
- registrations are effects owned by that fiber and unwind when it unloads;
- `inject` declares required services;
- a consumer stays pending until dependencies exist, unloads if they disappear, and can reactivate when they return;
- child contexts and isolated service realms give contributions a scope; and
- configuration and hot module replacement change the plugin tree rather than patching a privileged agent core.

The Cordis paper calls these dimensions **temporal composability**—a component's effects can be completely reverted—and **spatial composability**—dependencies are declared and reactively maintained. This is the deepest idea Jouzu should borrow.

### Creator-mode recomposition

Creator mode then exposes a controlled authoring workflow to the model:

1. Inspect generated contracts intersected with the live runtime.
2. Define source as an immutable Package without executing it.
3. Activate one exact Package as a distinct Run.
4. Observe pending dependencies, approval state, load failures, and render diagnostics.
5. Stop effects while retaining versions, update to a new version, or run an older version to roll back.
6. Author a durable preset separately, beginning from a copy of a known composition.

Its current identities are especially useful:

| DeepSeek Harness identity | Meaning | Jouzu analogue |
| --- | --- | --- |
| Plugin | Stable logical extension instance | Composition/candidate identity |
| Package | Immutable source version | Content-addressed candidate revision |
| Run | One activation attempt | Validation, evaluation, or activation run |
| Preset generation | Composition mounted for sessions that joined it | Resolved composition snapshot/epoch |

The safety boundaries matter as much as the capability:

- dynamic definitions are process-local and are not restored after restart;
- experiments are not automatically promoted into installed plugins or presets;
- durable presets are files, separate from temporary runtime probes;
- shipped presets are copied, never edited in place;
- a full preset switch is restricted to a blank agent because tools and prompts are part of conversation semantics;
- Client packages have version-bound human approval paths;
- rejected approval is not retried automatically; and
- the documented `node:vm` isolation is explicitly **not** a security boundary. Creator mode is treated like shell access.

This is better described as **human-authorized agent recomposition** than autonomous self-improvement.

## Adopt, adapt, avoid

### Adopt

1. **Recomposition over mutation.** Build effective behavior from named units. A change creates a new revision or epoch with a diff and rollback target.
2. **Temporal ownership.** Every dynamic contribution owns a complete, awaited cleanup path. “Disable” means effects are gone, not merely hidden from the model.
3. **Dependency declarations.** A capability states what it needs and fails or remains unavailable explicitly when dependencies are absent.
4. **Reflection before generation.** An agent reads exact, current, generated contracts and provenance before authoring against them. It does not guess APIs from names.
5. **Separate definition from activation.** Parsing and recording a candidate must not execute it. Activation is a separate, observable transition.
6. **Stable identity, immutable versions, distinct attempts.** Never overwrite the only known-good candidate. Diagnostics and approvals bind to an exact version and run.
7. **Experiment/promotion separation.** Temporary probes do not become durable capabilities automatically.
8. **Composition is session semantics.** Tools, prompt sections, skills, model route, and request compatibility are reconstructable for the request that used them.
9. **Scope follows ownership.** Shared policy and data services live outside per-session capability profiles; session profiles contribute only what can safely vary per agent.
10. **Starting is not success.** Pending, awaiting approval, running, failed, stopped, and rolled back remain distinct user-visible states.

### Adapt for Pi

Pi already provides most of the first practical layer:

- extensions, Pi packages, skills, prompts, themes, resource filters, and tool allowlists;
- project trust before project extensions execute;
- resource and tool source metadata;
- dynamic tool registration and active-tool selection;
- `/reload`, with `session_shutdown` before the old extension runtime is invalidated;
- custom session entries for extension-owned durable metadata; and
- SDK, print, JSON, and RPC modes suitable for isolated validation runs.

Jouzu should compose these facilities rather than emulate Cordis internals. Where Pi lacks a Cordis-style guarantee, Jouzu should add a narrow convention or wrapper:

- a Jouzu extension lifecycle helper for owned disposers;
- a neutral composition manifest and resolver over Pi resources;
- a composition snapshot persisted through a Jouzu custom session entry;
- an effective-composition inspector using Pi resource diagnostics, `sourceInfo`, tool schemas, the model catalog, and Jouzu capability descriptors; and
- a child-process validator/evaluator for candidate configurations and extensions.

Jouzu should not pretend Pi has fine-grained live plugin dependency replacement. Pi reload replaces the extension runtime as a unit, and arbitrary resources opened by an extension still require explicit cleanup in `session_shutdown`. The Jouzu abstraction must state that boundary honestly.

### Avoid

- Do not adopt Cordis merely to reproduce its vocabulary.
- Do not evaluate model-written JavaScript in the live Jouzu/Pi process by default.
- Do not call a Node `vm`, an extension context façade, or project trust a sandbox.
- Do not let a profile alter the trust store, credentials, accounting, package-signature policy, or the sandbox/approval ceiling that governs that profile.
- Do not let an agent edit the shipped base composition in place.
- Do not auto-install or auto-promote code because one interactive run appeared successful.
- Do not silently hot-reload model-visible capabilities during a request.
- Do not overwrite candidate versions or discard failed-run evidence.
- Do not make every internal helper a plugin. Composition units should correspond to independently selectable, replaceable, or scoped capabilities.
- Do not market ordinary file editing or prompt rewriting as learning. Without durable evidence, evaluation, and governed promotion, it is authoring rather than evolution.

## Composition model

### Manifest, snapshot, epoch, and run

Jouzu should keep four identities separate.

#### Composition manifest

A human-readable declaration of desired resources and settings. It references reviewed executable artifacts; it is not itself executable code.

An eventual manifest may select:

- Pi package sources and resource filters;
- extension, skill, and prompt identities;
- an active tool allowlist;
- persona or instruction layers;
- model-selection policy and a default offering;
- workflow or compaction settings; and
- requested permissions that the governing policy may narrow but never widen from the manifest alone.

The exact schema is deferred. The important constraint is that the core manifest uses bounded declarative fields and pinned references, not JavaScript expressions or arbitrary transformation hooks.

#### Composition snapshot

The fully resolved, immutable result of applying trusted layers and policy. A snapshot should contain or reference:

- a content-derived snapshot ID;
- manifest IDs, revisions, layer order, trust class, and source paths;
- Jouzu and pinned Pi versions;
- package source, version/commit, integrity, and selected resource paths;
- hashes for loaded extension, skill, prompt, theme, and context resources;
- active tool names, schemas, and `sourceInfo`;
- effective model policy, selected offering/route, and model-catalog revision;
- effective policy decisions and requested values that were denied or narrowed;
- effective prompt/tool fingerprints without storing credentials or unnecessary prompt content; and
- validation status and diagnostics.

A source path alone is not reproducibility. If a local file changes, its digest exposes drift. Byte-for-byte replay additionally requires a retained artifact or immutable package reference; Jouzu must not promise replay it cannot perform.

#### Composition epoch

The interval in a session during which model-visible composition is stable. The initial snapshot starts epoch one. A later explicit model-visible change starts another epoch before the next provider request.

Before the first provider dispatch, selection may change freely. Afterwards:

- whole-profile changes, extension additions/removals, and tool-schema changes should default to a new or forked session;
- a deliberately designed mode transition, such as a tool allowlist plus instructions, may remain in one session only when it is explicit, occurs at a turn boundary, records a new epoch, and preserves a coherent history; and
- a reload must finish old-runtime shutdown, resolve a new snapshot, and record the transition before any request uses it.

Presentation-only changes that cannot affect model input or execution policy need not start a model-visible epoch, but their ownership and cleanup still matter.

#### Activation/evaluation run

One attempt to validate, smoke-test, evaluate, or activate an exact snapshot or candidate. Attempts retain start/end state, diagnostics, environment, policy, and result. Retrying creates another run; it does not rewrite the failed one.

### Layering and authority

A useful default order is:

1. signed Jouzu base;
2. Jouzu edition defaults, such as Japanese terminal;
3. organization policy and managed resources;
4. user profile;
5. trusted project profile; and
6. explicit one-run selection.

This is not blanket “last value wins.” Hard policy intersects the resolved result after every layer and cannot be weakened by lower-authority input. Credentials remain references resolved by the execution environment, not values copied into composition artifacts. Every effective field should explain which layer supplied it and which policy accepted, narrowed, or denied it.

### Policy plane and session plane

Jouzu should adapt DeepSeek Harness's host-versus-agent distinction into an authority rule.

**Policy/shared plane:** trust decisions, credentials, model catalog trust, package integrity, organization policy, sandbox and approval ceilings, usage ledger, session persistence, and promotion authority.

**Session plane:** active tools, skills, prompt/persona sections, workflow/mode behavior, and model selection within policy.

A session composition may consume policy-plane services. It cannot replace or relax them. If a capability must inspect many sessions, guard credentials, enforce policy, or preserve durable accounting, its owner is not a per-session profile.

## Lifecycle invariant for Jouzu extensions

Pi automatically drops the old extension runner's handlers, commands, and registered tools on runtime replacement. It cannot automatically discover every timer, watcher, subprocess, socket, or third-party callback created by extension code.

Jouzu extensions that participate in recomposition should therefore use an owned effect scope with these semantics:

1. Acquire a resource only inside the active extension/session scope.
2. Register its disposer immediately.
3. Dispose in reverse acquisition order; sequence dependent asynchronous cleanup explicitly.
4. Await quiescence during `session_shutdown` for `reload`, `new`, `resume`, `fork`, and `quit`.
5. Make disposal idempotent.
6. Reject registrations after disposal begins.
7. Keep module-scope side effects out of reloadable extension code.
8. Test reload and failed-start paths for leaked listeners, processes, files, sockets, and timers.

A future `createJouzuExtension()` helper can encode this convention without requiring changes to Pi's extension API. A capability that cannot meet this invariant is restart-only and must say so; it is not eligible for live recomposition.

## Inspect-first authoring

Jouzu should provide a read-only effective-composition report before it provides any authoring automation. The report should answer:

- What extensions, skills, prompts, themes, tools, and model routes are active?
- Which source and layer supplied each one?
- Which versions and content hashes are in use?
- Which requested resources were filtered or denied, and why?
- Which tool schemas and prompt sections will affect the next request?
- Which resources are reloadable, restart-only, stale, or missing?
- Which policy boundary owns each capability?

The report should be generated from the same declarations and runtime metadata used to load the capability, then intersected with live state. Hand-maintained parallel API documentation is advisory, not authority.

A normal Jouzu session may expose this through user-facing diagnostics. A model-facing inspector belongs only in an explicit Creator/developer profile, should expose bounded schemas rather than arbitrary object graphs, and must redact credentials, secret environment values, private account labels, and unrelated session data.

## Candidate workflow

The first Creator-like Jouzu workflow should author ordinary artifacts rather than live code:

1. **Inspect** the current snapshot and exact supported extension interfaces.
2. **Draft** a new composition manifest, skill, prompt, or normal Pi extension in a workspace candidate directory.
3. **Validate** syntax, schema, dependency pins, duplicate tool names, requested policy, package integrity, and expected resource origins.
4. **Diff** the candidate against the current snapshot, including tools, schemas, prompt fingerprints, model route, privileges, network/process access, and expected cache invalidation.
5. **Test** it in a fresh Pi process with a temporary Jouzu home, explicit `--no-*` resource selection, bounded time, and no credentials or network unless the test explicitly requires and receives them.
6. **Evaluate** it on declared fixtures or tasks, recording result, usage, cost, latency, and safety checks against the exact candidate hash.
7. **Approve** promotion through the user or organization policy. Rejection is terminal for that approval request.
8. **Activate** only for a new session or explicit new composition epoch.
9. **Canary and roll back** by selecting immutable revisions; never reconstruct rollback from mutable current files.

The child process is the experiment boundary. A candidate must not be able to mutate the parent runtime, approval state, ledger authority, or installed base merely because it can run code inside its own test process. OS/container isolation can be added where stronger confinement is required; a subprocess alone is lifecycle isolation, not a complete security sandbox.

## Evolution loop

Recomposition becomes evolution only when Jouzu can compare revisions against durable evidence.

### Inputs

- explicit user feedback and acceptance;
- repository test/typecheck/lint outcomes;
- task completion or verifier results;
- tool errors, retries, cancellation, and repair loops;
- safety/policy violations and denied actions;
- latency and reliability; and
- usage, cache behavior, quota, and cost from the neutral ledger.

### Correlation

Every operation, logical request, and provider attempt should carry `compositionSnapshotId` and `compositionEpochId`. Evaluation records also reference the candidate revision, exact verifier version, and `workerEpochId`. This lets Jouzu compare behavior without inferring the active tool/prompt set from filenames that may have changed later or crediting a model/runtime upgrade to a harness intervention.

The worker epoch identifies the selected model, concrete offering/route, Pi and `pi-ai` versions, and material native action semantics. The composition snapshot identifies model-visible resources within that worker epoch. The snapshot references the model-catalog revision that resolved its route and compatibility settings. The usage ledger remains the source for observed runtime cost; composition and worker records do not duplicate token charges. See [Harness Engineering and Jouzu](HARNESS-ENGINEERING.md) for the evaluation boundary.

### Promotion rule

A candidate is promoted only under a declared rule, for example:

```text
required checks pass
AND no policy/safety regression
AND target quality improves or remains within tolerance
AND cost/latency stay within explicit bounds
AND required human approval is present
```

“Worked once” is not a promotion policy. Unknown results remain unknown. Failed candidates and rejected approvals remain available for diagnosis but cannot silently become defaults. Automated proposal and evaluation are compatible with this design; unattended privilege expansion and production promotion are not.

## Staged maturity

### Stage 0 — inspectable static composition

- Resolve current Pi resources and tools into a snapshot.
- Show source, layer, version, hash, and policy decisions.
- Persist the snapshot identity in the session and usage ledger.

This is valuable even without any agent-authored changes.

### Stage 1 — declarative profiles

- Add versioned manifests and deterministic layer resolution.
- Select profiles at Jouzu startup.
- Default structural profile changes after first use to a new/forked session.
- Add snapshot diff and rollback to a previous immutable manifest.

### Stage 2 — candidate authoring and isolated validation

- Add a Creator skill/profile that writes candidates in the workspace.
- Validate and run smoke tests in a fresh restricted Pi process.
- Require a human-readable capability/policy diff before promotion.

### Stage 3 — evidence-based evolution

- Link evaluations and user feedback to composition IDs.
- Compare quality, safety, latency, cache, and cost under versioned verifiers.
- Support explicit canaries and governed promotion/rollback.

### Stage 4 — narrowly bounded live experiments, only if justified

Consider finer-grained live mounting only after the lifecycle helper, inspection catalog, approval model, audit trail, and isolation story are proven. Even then, prefer a separate worker process and a narrow RPC/tool boundary over evaluating code in the primary TUI process.

Jouzu does not need Stage 4 to claim meaningful controlled evolution; Stages 0–3 are the higher-value product.

## Initial implementation implications

1. Add `compositionSnapshotId`, `compositionEpochId`, and `workerEpochId` to the neutral usage-operation/request context before ledger schema stabilization.
2. Prototype a Jouzu extension that records a `jouzu.composition.v1` custom session entry and exposes an effective-composition command.
3. Use Pi's existing package filters and active-tool APIs for the first declarative profile; do not patch Pi's extension loader first.
4. Define the extension effect-scope helper and leak-focused reload tests before promising live profile updates.
5. Keep composition manifests runtime-neutral at the identity/provenance layer, with a Pi projection first. Do not encode Cordis YAML or Pi object instances into the neutral format.
6. Build candidate validation as a CLI/subprocess workflow before a model-facing write tool.
7. Treat model-written extensions and user presets as ordinary trusted code requiring source review, even when generated in a restricted test environment.

## Reconsideration gates

Reconsider in-process dynamic extension evaluation only if all of these are true:

- a concrete use case cannot be served by declarative composition or a child process;
- effects are mechanically owned and teardown is proven to quiescence;
- exact live interfaces are inspectable and versioned;
- approval binds to immutable code and an authority diff;
- session and request records reconstruct every model-visible change;
- failure and rollback preserve the previous known-good state; and
- the UI describes the feature as trusted code execution rather than a sandbox.

Until then, Jouzu should be **self-describing, agent-authorable, testable, and rollbackable**, but not self-modifying in its primary process.

## Primary sources

- [DeepSeek Harness overview](https://www.deepseek.com/harness/en/)
- [DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md)
- [Self-referential Cordis toolset decision](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md)
- [Dynamic Cordis tool package](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/extensions/tool-cordis/README.md)
- [Agent preset composition](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/preset/agent-presets/README.md)
- [Editing Cordis compositions skill](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/config/agent-presets/cordis/skills/editing-cordis-compositions/SKILL.md)
- [Cordis spatiotemporal composability preprint](https://github.com/cordiverse/paper)
- [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
