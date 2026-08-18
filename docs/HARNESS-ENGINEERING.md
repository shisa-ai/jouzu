# Harness Engineering and Jouzu

- **Status:** Research note and provisional architecture decision
- **Scope:** Agent deployment, repository context, tool design, verification, feedback, evaluation, long-running work, and controlled harness improvement
- **Related:** [Recomposition and Controlled Evolution](COMPOSITION.md), [Repository Knowledge and Code Graphs](REPOSITORY-KNOWLEDGE.md), [Usage Tracking and Cost Accounting](USAGE-TRACKING.md), [Model Catalog](MODEL-CATALOG.md), [DeepSeek Harness and Jouzu](DEEPSEEK-HARNESS.md), [Agent Control Plane](CONTROL-PLANE.md), [Delegation and Adversarial Review](DELEGATION-AND-REVIEW.md)

## Decision

Jouzu should treat harness engineering as the discipline of deploying a selected **worker** into real work, not as another name for prompt engineering and not as a reason to replace Pi.

For one qualification or evaluation epoch:

```text
worker = model + coding-agent host + native action semantics
harness = context + target repository + tools + execution environment
          + authority + state + verification + feedback + delivery
```

The worker is held constant while Jouzu changes one harness surface. A material model, Pi, native-tool, compaction, or computer-use change starts a new **worker epoch** and reopens previous assumptions. This distinction prevents a stronger model, a different task mix, or a larger reasoning budget from being credited to a harness change.

Jouzu should adopt the following priorities:

1. make the effective worker and composition inspectable and versioned;
2. route small, current, authoritative context at the point where it matters;
3. make every capability discoverable, operable, bounded, and verifiable;
4. prove outcomes at the user or operational boundary, not only through internal checks;
5. turn repeated corrections into reviewed repository infrastructure;
6. evaluate one reversible intervention at a time with fresh trajectories; and
7. keep evaluator, policy, credentials, and promotion authority outside any self-improvement loop.

Jouzu should **not** build a general task orchestrator, mandatory knowledge graph, or autonomous harness mutator as an initial feature. The first useful product is an inspectable Pi composition with good repository routes, evidence capture, and an evaluation loop. Always-on work orchestration and self-improvement are later consumers of those foundations.

## Source interpretation

The research sources answer different questions and should not be treated as equivalent evidence.

### OpenAI's agent-first repository

OpenAI reports that a small team built an internally used product with Codex generating all repository code, approximately one million lines and 1,500 merged pull requests over five months. The useful evidence is not the line count. It is the environment the team had to build:

- a short `AGENTS.md` as a map into structured repository knowledge;
- checked-in architecture, product specifications, execution plans, and quality state;
- per-worktree application instances;
- browser, DOM, screenshot, log, metric, and trace access;
- mechanical architecture and taste invariants with corrective diagnostics;
- agent review and delivery loops; and
- recurring documentation and code gardening.

This is a valuable field report from one unusual greenfield repository, not a controlled comparison and not proof that every repository should ban human-written code or relax merge gates. Jouzu should adopt the mechanisms only where a local failure or outcome justifies them.

### Codex's loop and App Server

The Codex loop documentation makes several runtime facts explicit:

- tools, repository instructions, environment state, model instructions, and prior items all become model context;
- exact prompt prefixes matter for caching, so tool ordering and mid-session capability changes have real cost;
- context compaction changes the continuation state and must remain observable;
- an agent's primary output may be a filesystem or system effect rather than its final message; and
- rich agent integration needs durable `item`, `turn`, and `thread` lifecycles, bidirectional approvals, and typed streaming events.

Jouzu already receives most of this behavior from Pi and should not recreate the Codex App Server. It should preserve the principles in its neutral records: model-visible composition is reconstructable, tool-schema changes start an explicit epoch, physical attempts remain observable, and a client protocol should preserve native semantics rather than flatten them to a lowest common denominator.

### Symphony

OpenAI's [Symphony](https://github.com/openai/symphony) moves one layer above an interactive harness. It treats an issue tracker as the durable control plane for outcomes, gives each issue an isolated workspace, launches the coding-agent runtime as a child, and reconciles running work with current tracker state. Its repository-owned `WORKFLOW.md` supplies policy and runtime settings; the scheduler owns bounded concurrency, retries, stall detection, and restart recovery.

The important distinction is:

```text
issue or goal = durable outcome
workspace and session = execution attempts beneath that outcome
pull request = one possible artifact, not the unit of work
```

This is useful for Jouzu's later goal or maintenance layer. It does not belong in the initial Pi session core. Jouzu should borrow the separation of policy, coordination, execution, integration, and observability, but not copy Symphony's Elixir implementation or assume an issue state is proof of completion.

### Lilian Weng's self-improvement survey

Lilian Weng frames a harness as the runtime around a base model that controls workflow, tools, context, persistent artifacts, permissions, and evaluation. Her self-improvement survey connects several research lines:

- evolving structured context from successful and failed trajectories;
- searching over workflow or harness code;
- retaining diverse candidate populations rather than one overwritten state; and
- accepting candidates only after evaluation.

The strongest practical warning is that the editable surface, evaluator, held-out data, permission controls, and model configuration must not all be inside the optimization loop. Otherwise the candidate can improve its score by weakening the verifier, changing the worker, increasing the budget, or exploiting benchmark artifacts.

Research results on benchmarked harness evolution are evidence that a search space exists. They do not establish safe unattended promotion in a long-lived repository where maintainability, authority, and future cost are weakly measured.

### Field guides and awesome lists

Ryan Lopopolo's `harness-engineering` repository is a high-quality synthesis and routing corpus. Its strongest methodological contribution is to begin from a target-local unresolved decision and retrieve only the thesis that can change it. The awesome lists are useful discovery indexes, but their descriptions and project claims are not independent evidence. Jouzu should cite and inspect primary implementations or papers before adopting a listed component.

## The operating model

### 1. Hold the worker constant

A Jouzu **worker epoch** identifies at least:

- canonical model and concrete offering/route;
- Pi and `pi-ai` versions;
- native tool and action semantics;
- compaction, background-process, computer-use, and sandbox capabilities; and
- material model-specific request behavior such as developer-role and thinking format.

A composition snapshot identifies the selected harness resources inside that epoch. The two identities are related but not interchangeable:

- changing a skill or Jouzu extension creates a new composition snapshot or epoch;
- changing the model or Pi runtime starts a new worker epoch even if the manifest is unchanged; and
- an evaluation compares harness revisions only within one worker epoch unless the purpose is explicitly to requalify a new worker.

This fits the [model catalog](MODEL-CATALOG.md), [composition](COMPOSITION.md), and [usage ledger](USAGE-TRACKING.md): catalog revisions explain route compatibility, composition IDs explain model-visible resources, and worker-epoch IDs bound causal comparisons.

### 2. Give one trajectory ownership of the whole job

One primary trajectory should retain the requested outcome through investigation, implementation, proof, review, and safe closure. It may delegate parallel discovery or independent review, but it integrates those results and remains accountable for the final evidence.

This avoids role pipelines in which every handoff loses product intent. It does not imply one process forever: durable plans, tracker state, proof packets, and session records may carry one outcome across compaction, retries, or workers.

A sparse prompt is appropriate only when the repository makes the missing quality bar recoverable. Jouzu should not celebrate underspecified requests; it should use them to expose which local context, capability, proof, or authority boundary is missing.

### 3. Route context just in time

A large knowledge store and a small active working set are compatible. Jouzu should prefer:

- a short root map rather than a monolithic instruction file;
- architecture and domain decisions beside the code they govern;
- skills that advertise when an approach applies and load details after selection;
- runbooks for repeatable, consequential workflows;
- bounded tool output with a route to full evidence; and
- immutable source or projection revisions so context can be recovered after compaction.

Context should have an owner:

| Layer | Owns | Typical access |
| --- | --- | --- |
| Authoritative external system | Current issues, records, permissions, operations | Bounded query or connector |
| Shared organization corpus | Curated ontology, operating principles, source routes | Searchable projection or service |
| Target repository | Architecture, schemas, decisions, critical journeys, guardrails | Files, nested maps, checks |
| Active trajectory | Current goal, observations, plan, unresolved decisions, proof | Prompt, tools, session state |

Copying all changing external data into a repository creates a stale shadow authority. A graph or index may project it, but mutations still go through the system that owns the state.

### 4. Make capabilities legible and operable

A tool is not useful merely because it is registered. The complete capability loop is:

```text
discover -> select -> invoke -> interpret -> repair -> verify the real effect
```

A Jouzu capability descriptor should expose a meaningful name, purpose, input and output shape, first useful call, authority class, failure contract, and verification path. Tool results should prefer:

- quiet success;
- bounded stable structure;
- exact target and violated invariant on failure;
- a safe repair action when known;
- a route to omitted detail;
- dry-run or preview for consequential effects; and
- a receipt or postcondition query.

The smallest familiar interface that closes the job is normally better than a large novel API. CLI, MCP, and Pi-tool adapters should be thin projections over one typed domain operation rather than separate implementations of policy.

### 5. Make the repository teach the worker

Code is both output from the current trajectory and prompt material for the next one. Jouzu should encourage repositories to make local nonfunctional requirements recoverable through:

- one semantic owner per recurring concept;
- canonical examples and regular structures;
- completed migrations rather than two competing eras;
- boundary parsing into trusted types;
- architecture and dependency direction checks;
- tests and diagnostics that explain how to repair an invariant; and
- explicit, local exceptions rather than global weakening.

Consistency is not an aesthetic end. It compresses context: an agent can transfer one learned local pattern to many files. Conversely, every stale document, abandoned migration, and bad nearby helper is a competing prompt.

Jouzu should not turn every preference into a lint. Qualitative or immature judgment belongs in examples and convergent review. Settled deterministic invariants can move upstream into types, APIs, architecture, and checks.

### 6. Separate capability from authority

Capability describes how to cause an effect. Authority identifies which identity may cause which effect, on which resource and environment, for how long, with what approval, receipt, revocation, and recovery path.

Jouzu should allow broad iteration in isolated, reversible workspaces while staging consequential effects:

```text
inspect -> prepare -> test -> canary -> approve -> cut over -> verify or roll back
```

Credentials should remain outside model-readable context where possible and be resolved by a broker or host-side tool at the action boundary. Read-only identities, repository allowlists, expiring grants, and explicit production approvals are stronger than natural-language warnings.

The worker can own the whole job while a person retains one bounded consequential decision.

### 7. Prove the outcome where it is experienced

A green check proves only its assertion. Before implementation, identify:

- who or what experiences the outcome;
- the relevant starting state and inputs;
- visible behavior and side effects;
- invariants that must remain true;
- evidence that distinguishes success from a plausible imitation; and
- known exclusions.

Examples:

| Claim | Required evidence |
| --- | --- |
| Browser behavior | Executed journey plus semantic and rendered state |
| Compatibility migration | Corpus or version-matrix parity and accepted differences |
| Deployment | The validated immutable artifact running with health checks |
| Security correction | Reproducer, bounded impact, correction, and regression proof |
| Business mutation | Approval, action receipt, and observed postcondition |
| Analytical conclusion | Reproducible transformation, sources, and supported conclusion |

The review packet should compress the trajectory into the intended outcome, material decisions, exact checks and journeys, claim-carrying artifacts, unproved behavior, and delivery artifact identity. A person should not have to replay an entire session to decide whether the result is acceptable.

### 8. Turn feedback into infrastructure

Prompts, tool traces, diffs, checks, reviews, incidents, user responses, and accepted or rejected artifacts are observable evidence. They are leads, not policy.

For recurring steering:

1. reconstruct the promised outcome and observed failure;
2. find the earliest boundary that could have prevented or exposed it;
3. search for sibling instances of the governing failure class;
4. distinguish an environment gap from stochastic variance, external failure, or a bad premise;
5. promote the stable lesson to the smallest durable owner; and
6. rerun a fresh comparable job.

The owner may be a route, runbook, skill, example, reviewer, type, API, test, lint, architecture boundary, or migration. Once a stronger upstream owner exists, redundant downstream checks should be removed.

Agent self-reports such as mistakes, learnings, and desires are telemetry for the harness builder. They should remain attached to their trajectory until corroborated; raw self-report must never publish itself as instruction or policy.

### 9. Run only settled work continuously

A continuous loop is appropriate when it can answer:

- what condition should remain true;
- what signal detects drift;
- what evidence proves restoration;
- what may proceed autonomously and where approval is required;
- what durable state prevents repeated rediscovery; and
- when the loop should retire.

Dependency updates, documentation freshness, known migrations, drift repair, and generated-data refresh can fit this model. Unresolved product invention and difficult interface choices remain foreground work. When the outcome is not settled, the loop should produce evidence or an escalation rather than invent policy silently.

Symphony is one implementation pattern for this layer. Jouzu should first establish repository-owned runbooks, isolated workers, durable state, authority, and proof before adding a scheduler.

## Evaluation method

Harness work should begin from a representative job, not a component wish list.

### Job contract

Record before changing the harness:

```text
Target repository and revision
Relevant external state
Worker epoch
Composition snapshot
Representative job and task class
Accepted outcome
Claim-matched proof
Authority envelope
Budget and stop conditions
Suspected earliest failed handoff
```

### Bounded intervention loop

1. Run or reconstruct a baseline trajectory.
2. Locate the earliest missing handoff: context, capability, domain ownership, authority, proof, feedback/delivery, or a possible worker limitation.
3. State one falsifiable intervention hypothesis at the owning boundary.
4. Make the smallest reversible change.
5. Run repository-native checks and the real user/operational journey.
6. Rerun from a fresh equivalent state with the same worker epoch and authority.
7. Retain, revise, or remove the intervention.
8. If added value remains unclear, run an ablation without it.

One before/after pair guides local engineering but does not establish a general treatment effect. Comparative claims need repeated fresh sessions, stable environment parity, randomized condition order where practical, held-out tasks, and condition-blind review for qualitative outcomes.

### Keep dimensions separate

Jouzu should not collapse harness quality into token count or one composite score. Record:

| Dimension | Question |
| --- | --- |
| Outcome | Did a user, operator, or dependent system receive the accepted result? |
| Proof | Did the worker produce evidence that establishes the claim? |
| Human attention | How much steering, relay, review, QA, coordination, and recovery was required? |
| Flow | Which of feedback latency, worker duration, synchronous attention, or time-to-acceptance constrained completion? |
| Rework | What was retried, discarded, reverted, or learned? |
| Risk | What could fail, and were authority and recovery appropriate? |
| Lifetime | What dependencies, policy, migration, or maintenance obligations were added? |
| Compute | What tokens, charges, CPU/GPU, CI, storage, and cache effects were consumed? |
| Compounding | Did comparable later jobs improve within the worker epoch? |

The usage ledger supplies compute and attempt facts. It must not be mistaken for the outcome grader.

## Controlled harness improvement

The [composition design](COMPOSITION.md) already separates immutable candidates, evaluation attempts, promotion, and rollback. Harness-engineering research strengthens that boundary.

A self-improvement experiment must keep these surfaces read-only to the candidate:

- evaluator and held-out cases;
- worker identity and model configuration;
- budget and accounting semantics;
- trust, credentials, sandbox ceiling, and approval policy;
- accepted-work archive and current known-good pointer; and
- promotion authority.

The candidate receives only declared editable surfaces, for example one skill, context route, tool description, middleware rule, or composition manifest. Each proposal should include:

- the trajectory evidence and failure class;
- inferred earliest cause;
- exact files or fields changed;
- predicted improvement;
- possible regressions;
- validation plan; and
- carrying-cost and retirement expectation.

Validation should combine a held-in case for the targeted failure, held-out regression cases, policy and safety checks, and user-boundary proof. Successful candidates become promotion proposals, never direct mutations of the active base. Rejected candidates remain evidence so the system does not repeat an identical failed search.

Maintaining several candidate branches can preserve diversity in research. Jouzu does not need evolutionary population search in its initial product; immutable candidate history and explicit rollback provide the important safety property without the complexity.

## Adopt, adapt, avoid

| Adopt | Adapt for Jouzu and Pi | Avoid |
| --- | --- | --- |
| Worker epochs for causal evaluation | Bind model/catalog route, Pi version, native semantics, and composition IDs | Comparing model upgrades as harness gains |
| Root map plus progressive disclosure | Generate or validate routes into target-owned docs; keep the active set small | A universal thousand-line instruction file |
| Repository as system of record for local engineering contracts | Keep volatile operational truth in its external owner and store routes locally | Copying private changing systems into a stale repository corpus |
| Complete capability loop | Pi tools/CLI first, with bounded output, repair hints, postconditions, and source metadata | Registering many tools and assuming discovery equals utility |
| Architecture and quality invariants | Add only for observed failure classes; use actionable diagnostics | Centralizing every stylistic choice or preserving redundant validators |
| User-boundary proof | Use browser, logs, traces, corpus parity, canaries, and receipts as the claim requires | Treating a build, plan, or line count as delivery proof |
| Feedback distillation | Corroborate trajectory evidence, propose a diff, review, publish, and rerun | Letting self-reports or reviewer agents publish policy directly |
| Goal/outcome control planes | Add a later scheduler over Pi child processes and repository-owned workflows | Coupling task state, session state, and PR state into one identity |
| Harness evolution under external evaluation | Use bounded candidates, held-out regressions, explicit promotion, and rollback | Letting the candidate edit its evaluator, permissions, worker, or budget |
| Subtraction on worker upgrades | Requalify and retire scaffolding the new worker no longer needs | Accumulating permanent middleware for obsolete model weaknesses |

## Staged Jouzu work

### Stage 0 — define and observe the worker

- Add `workerEpochId` to evaluation and trajectory correlation.
- Record model/offering/route, Pi and `pi-ai` versions, and native capabilities.
- Complete effective-composition inspection and request/attempt accounting.
- Preserve stable tool schema and prompt fingerprints without storing secrets.

### Stage 1 — repository readiness

- Provide a short repository-map template or diagnostic, not a large universal manual.
- Identify architecture, domain owners, critical journeys, normal checks, and authority boundaries.
- Make slow/noisy checks return bounded semantic diagnostics while preserving full logs and exit status.
- Add one end-to-end proof path for each claimed Jouzu product journey.

### Stage 2 — one measured harness intervention

- Choose a repeated Jouzu job and capture a baseline.
- Test one context route, tool improvement, or verifier under a fixed worker epoch.
- Correlate outcome, proof, human attention, latency, attempts, cache behavior, and cost.
- Keep or remove the intervention based on fresh reruns, not intuition alone.

### Stage 3 — feedback proposals

- Collect bounded trajectory evidence and classify repeated failure classes.
- Let an agent draft repository changes or composition candidates in an isolated workspace.
- Require evidence, expected effect, regression risks, and a retirement condition.
- Validate and approve through the controlled composition workflow.

### Stage 4 — optional continuous work

- Add goals or scheduled maintenance only for settled, measurable conditions.
- Use isolated workspaces, bounded concurrency, reconciliation, retry state, and explicit blocked/approval states.
- Treat the issue tracker or goal store as the outcome control plane and Pi sessions as attempts.
- Preserve decision-ready proof packets and a clear stop/retirement condition.

## Reconsideration gates

Jouzu should consider a built-in Symphony-like service only when:

- representative work already closes reliably in one interactive Pi trajectory;
- repository-owned workflows and proof are sufficient without human relay;
- isolated child processes and credentials have an explicit authority model;
- operation/session/attempt/composition/worker identities are durable;
- blocked input and approvals can survive restart safely;
- the target can distinguish accepted outcome from agent self-declared completion; and
- measured reduction in human attention justifies another long-running service.

Jouzu should consider automatic harness promotion only when:

- editable and protected surfaces are mechanically separated;
- held-in and held-out evaluations are versioned and difficult to game;
- candidate results include user-boundary proof and safety checks;
- the worker and budget cannot change inside the comparison;
- promotion is an external policy decision with immutable rollback; and
- later comparable outcomes show that the improvement compounds.

## Primary sources

- [OpenAI: Harness engineering](https://openai.com/index/harness-engineering/)
- [OpenAI: Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)
- [OpenAI: Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/)
- [OpenAI: Symphony article](https://openai.com/index/open-source-codex-orchestration-symphony/)
- [`openai/symphony` specification snapshot](https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/SPEC.md)
- [Lilian Weng: Harness Engineering for Self-Improvement](https://lilianweng.github.io/posts/2026-07-04-harness/)
- [Agentic Context Engineering](https://arxiv.org/abs/2510.04618)
- [Automated Design of Agentic Systems](https://arxiv.org/abs/2408.08435)
- [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954)
- [`lopopolo/harness-engineering` field-guide snapshot](https://github.com/lopopolo/harness-engineering/tree/226c8d35fb6ea3ed55467753dba6dea2b5fd5778)
- [`walkinglabs/awesome-harness-engineering` discovery index](https://github.com/walkinglabs/awesome-harness-engineering/tree/f84f1701974cf1ad67dd774b025b33e613275cee)
- [`ai-boost/awesome-harness-engineering` discovery index](https://github.com/ai-boost/awesome-harness-engineering/tree/216d2f14c48f373ef274654169049a2204d69ef2)
