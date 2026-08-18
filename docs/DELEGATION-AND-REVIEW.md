# Jouzu Delegation and Adversarial Review

- **Status:** Draft design
- **Scope:** Subagent delegation, context handoff and introspection, adversarial review, plan review, delegate trust and authority, nested accounting, and review evaluation
- **Related:** [Harness Engineering and Jouzu](HARNESS-ENGINEERING.md), [Recomposition and Controlled Evolution](COMPOSITION.md), [Usage Tracking and Cost Accounting](USAGE-TRACKING.md), [Model Catalog](MODEL-CATALOG.md), [Repository Knowledge and Code Graphs](REPOSITORY-KNOWLEDGE.md), [Agent Control Plane](CONTROL-PLANE.md)

## Summary

Pi intentionally ships no built-in subagents and no plan mode, and says so: those workflows are left to extensions and packages. It does ship a complete reference subagent extension — one child `pi` process per delegate, isolated context, per-delegate model and tool selection, single/parallel/chain modes, streaming, per-delegate usage, and abort propagation. The mechanism is proven; the product decisions are unmade and belong to Jouzu.

This document specifies delegation as a Jouzu capability and adversarial review as its primary justification.

The central design question is not "can we run a reviewer subagent" — the example already does — but **what the reviewer is allowed to see**. Independence and informedness trade against each other, and both extremes fail. A reviewer with no context reviews the diff instead of the promise, so it misses "this does not do what was asked" and over-reports style. A reviewer given the author's full trajectory inherits the author's framing and confirms it. Jouzu resolves this with a graded handoff whose default is the **review packet** already specified in [Harness Engineering and Jouzu](HARNESS-ENGINEERING.md): the claim and the artifacts, without the reasoning that produced them.

The second load-bearing rule is that a reviewer's verdict is evidence, not authority. An objection either becomes a reproducible check — which then gates on its own merits — or it remains an annotation for a human. Nothing gates on an agent's opinion.

## Decision

Jouzu should build delegation as a first-class capability whose **purpose is independent verification**, not throughput.

Parallel workers that split a task are a modest and well-understood win. Independent adversarial review is the capability that a harness owner can build and a general session manager cannot, because it requires control over context handoff, model selection, evidence retention, and accounting — all four of which Jouzu already owns through the catalog, ledger, and composition designs.

Concretely, Jouzu should:

1. productize the reference subagent mechanism with delegate definitions as composition artifacts;
2. define the graded context handoff and make the review packet the default;
3. make delegate trajectories durable, because a review that cannot be replayed cannot be corroborated;
4. require reviewer findings to be convertible into checks;
5. close the nested-usage accounting gap that a review fan-out makes acute; and
6. treat model and provider diversity as a review property, sourced from the catalog.

Jouzu should **not** build a role pipeline. [Harness Engineering and Jouzu](HARNESS-ENGINEERING.md) already fixes the topology: one primary trajectory retains the outcome and may delegate parallel discovery or independent review, but it integrates those results and remains accountable for the final evidence. Delegation adds reviewers to a trajectory; it does not hand the job to a chain of specialists.

This document covers in-session delegation on one host. Fleet-level adversarial work — several harnesses attacking one task across machines — is deferred to a later phase of [Agent Control Plane](CONTROL-PLANE.md), and adversarial review as the evaluator inside the composition promotion loop is deferred to Stage 3 of [Recomposition and Controlled Evolution](COMPOSITION.md).

## Goals

1. Delegate bounded work to child agents with isolated context, selected model, and a restricted tool set.
2. Support adversarial review of code, evidence, and plans by delegates that do not share the author's framing.
3. Make the degree of context independence an explicit, per-delegate, auditable choice rather than an accident of implementation.
4. Convert reviewer findings into durable checks wherever the finding is mechanically expressible.
5. Keep the primary trajectory accountable for integration and final evidence.
6. Retain delegate trajectories as evidence, attributable to the delegate revision that produced them.
7. Attribute tokens, cost, cache behavior, and latency per delegate rather than to one aggregate bucket.
8. Constrain delegate authority to a subset of the parent's, and never let a repository define a reviewer that reviews it.
9. Make review quality measurable — seeded-defect recall, false-positive rate, and cost per caught defect — so review is subject to the same evidence standard as any other harness intervention.
10. Select reviewer models for diversity and cost-performance using catalog data.

## Non-goals

- Throughput-oriented fan-out as the primary purpose. Parallel discovery is supported; it is not the justification.
- Role pipelines in which planning, implementation, and review are owned by different accountable agents.
- Autonomous merge, promotion, or policy change on a reviewer's verdict.
- Multi-agent debate, voting, or consensus as a truth procedure. Agreement between models is not evidence.
- Cross-host or cross-harness adversarial work in the first release; see [Agent Control Plane](CONTROL-PLANE.md).
- Harness self-improvement loops; see [Recomposition and Controlled Evolution](COMPOSITION.md).
- Treating a delegate subprocess as a security sandbox.

## Design principles

### Delegation exists to buy independence, not hands

The reason to spend a second model call on work already done is that the second call does not share the first's context, framing, or blind spots. Every design choice that erodes independence — injecting the parent's reasoning, reusing the parent's model, accepting the parent's summary as evidence — spends the capability's value. When independence is not needed, a tool call is cheaper than a delegate.

### Independence and informedness are both partial

A reviewer needs to know what was promised in order to check whether it was delivered, and must not know how the author convinced themselves in order to avoid being convinced the same way. These pull in opposite directions and the correct position is neither endpoint. The review packet exists precisely at that boundary.

### A verdict is evidence, not authority

[Harness Engineering and Jouzu](HARNESS-ENGINEERING.md) states that agent self-reports remain attached to their trajectory until corroborated and that raw self-report must never publish itself as instruction or policy, and its Avoid column names reviewer agents publishing policy directly. A review is a self-report by a different model. It is promoted to a gate only by becoming something mechanically checkable.

### Framing is a variable, not a personality

"Be adversarial" in a system prompt is weak. What actually changes reviewer behavior is the task shape: asked to find the strongest reason the claim is false, given a specific claim and specific evidence, and required to cite what it read. Prompt tone is the least reliable lever available and should not be the design.

### Sameness is the danger in review

[Model Catalog](MODEL-CATALOG.md) treats similarity as dangerous, because a similar model must never be a silent fallback. Review inverts this: a reviewer on the author's model shares its training distribution, its failure modes, and its agreement bias. For review, non-equivalence is the feature and exact equivalence is the defect.

### Delegate definitions are untrusted input

A delegate definition is a prompt that selects tools and a model. When it is read from the repository under review, it is repository-controlled content configuring the thing that judges that repository. This is a capture vector, and it is handled by trust rules, not by review of the prompt text.

### Evidence must outlive the delegate

The reference implementation runs delegates with session persistence disabled, so a delegate's trajectory disappears when its process exits. That is acceptable for a scout and unacceptable for a reviewer whose verdict influenced a merge.

## What Pi provides

The reference extension at `examples/extensions/subagent/` establishes the mechanism. A delegate is invoked as:

```text
pi --mode json -p --no-session
   [--model <model>]
   [--tools <comma-separated allowlist>]
   --append-system-prompt <file>
   "Task: <task text>"
```

Delegate definitions are markdown files with YAML frontmatter carrying `name`, `description`, optional `tools`, and optional `model`, discovered from `~/.pi/agent/agents/*.md` at user level and `.pi/agents/*.md` at project level. Project definitions are excluded by default; enabling them is an explicit scope choice, project definitions override user definitions of the same name when both are loaded, and interactive runs confirm before executing a project-level delegate. The extension supports single, parallel, and chained invocation, with caps of eight tasks and four concurrent, and a 50 KB per-task limit on model-visible output.

Three properties of this mechanism matter for everything below.

**The tool allowlist is enforced; tool semantics are not.** `--tools read,grep,find,ls,bash` genuinely restricts which tools exist in the child. It does not make `bash` read-only. The sample reviewer definition acknowledges this in its own prompt — it instructs the model to keep bash usage strictly read-only and states that permissions are not perfectly enforceable. A reviewer holding `bash` can modify the code it is reviewing, and prompt text is the only thing preventing it.

**The child is a process boundary, not a security boundary.** This is the same conclusion [Recomposition and Controlled Evolution](COMPOSITION.md) reaches for candidate test processes: a subprocess provides lifecycle isolation. Confinement requires the operating system.

**Delegate trajectories are ephemeral.** `--no-session` means no session file, so there is nothing to replay, audit, or corroborate afterwards.

Jouzu inherits the mechanism and must change the second and third of these.

## Delegation model

### Delegate definition

A Jouzu delegate is a composition artifact, not a loose prompt file. It carries at minimum:

```yaml
delegate:
  id: reviewer.security
  revision: sha256:...          # content-addressed
  description: "Falsifies security claims in a review packet"
  role: reviewer                # scout | planner | worker | reviewer | falsifier
  handoff: packet               # sealed | packet | projected | introspective
  worker:
    modelSelector: ...          # resolved through the catalog, not a raw model ID
    diversityRule: not-equivalent-to-parent
  tools: [read, grep, find, ls]
  authority:
    write: false
    network: false
    maxDurationMs: ...
    maxCostBasis: ...
  output: findings-v1           # declared, validated output contract
  source: user | organization   # never project, for reviewer roles by default
```

Content addressing matters because a review is only meaningful if you can say which reviewer produced it. Recording `reviewer.security` without a revision makes a six-month-old verdict uninterpretable, and makes it impossible to tell whether a change in review outcomes came from the code or from an edited prompt. This is the same identity discipline [Recomposition and Controlled Evolution](COMPOSITION.md) applies to candidates, and delegate revisions should participate in the same validation, diffing, and promotion workflow.

`modelSelector` resolves through the [Model Catalog](MODEL-CATALOG.md) rather than pinning a provider model ID, so that policy filtering, availability, and cost-performance ranking apply to reviewers exactly as they do to the primary worker.

### Topology

One trajectory owns the outcome. Delegates return results to it; they do not hand off to each other. Chained invocation is permitted as a convenience for mechanically sequenced steps, but a chain must not span the accountability boundary: a chain that ends in "worker implements what reviewer said" has moved the outcome out of the primary trajectory and is exactly the role pipeline the operating model rejects.

Concretely:

| Shape | Permitted | Reason |
| --- | --- | --- |
| Parallel scouts returning compressed findings | Yes | Discovery, integrated by the parent |
| Parallel independent reviewers of one packet | Yes | The core case |
| Reviewer whose findings the parent triages and acts on | Yes | Parent retains accountability |
| Reviewer → worker chain applying findings automatically | No | Verdict becomes authority |
| Planner → worker chain executing a plan verbatim | No | Outcome ownership leaves the trajectory |
| Delegate spawning its own delegates | No, initially | Unbounded cost and unattributable evidence |

Nested delegation is deferred rather than forbidden on principle. It requires depth limits, budget propagation, and accounting that the first implementation will not have.

## Context handoff

### The four axes

Independence is not one setting. It decomposes:

| Axis | Independent end | Informed end |
| --- | --- | --- |
| **Context** | Fresh process, no parent transcript | Parent trajectory injected |
| **Evidence** | Re-derives from source | Accepts the parent's summary |
| **Worker** | Different model, provider, and route | Same worker as the author |
| **Framing** | Asked to falsify a stated claim | Asked to approve work |

The axes are separable and should be set separately. The most valuable configuration for review is independent on context and worker, informed on the claim, and falsifying on framing — and that combination is unavailable if handoff is a single boolean.

### Handoff levels

```text
L0  sealed         task text only; no claim, no artifacts
L1  packet         review packet: claim, artifacts, checks, exclusions   ← default for review
L2  projected      packet plus a bounded projection of the parent's context
L3  introspective  packet plus parent system prompt, composition, and context inspection
```

**L0 sealed** suits discovery. A scout does not need to know what anyone believes. It is the wrong level for review because a reviewer without a claim reviews the artifact rather than the promise, which systematically produces style findings and misses requirement failures.

**L1 packet** is the default for review and the reason this design works. [Harness Engineering and Jouzu](HARNESS-ENGINEERING.md) already specifies the review packet as the compression of a trajectory into intended outcome, material decisions, exact checks and journeys, claim-carrying artifacts, unproved behavior, and delivery artifact identity. That is precisely the reviewer's input: everything needed to judge whether the promise was kept, and nothing about how the author persuaded themselves it was.

The packet must include its **exclusions** — what the author did not prove. A reviewer that has to rediscover the boundary of the claim spends its budget there instead of on the claim.

**L2 projected** hands over a bounded, redacted projection of the parent's context: files read, commands run, tool failures, and unresolved decisions, without the assistant's reasoning or narrative. It is appropriate when the reviewer must judge process rather than product — for example, whether a negative claim was adequately investigated. It carries real anchoring risk and is opt-in per delegate.

**L3 introspective** exposes the parent's effective system prompt, composition snapshot, active tools, and context usage. Pi supports this: an extension can reach session entries, the built context, the system prompt and its structured options, and current context usage. But [Recomposition and Controlled Evolution](COMPOSITION.md) already governs model-facing introspection — it belongs only in an explicit Creator/developer profile, must expose bounded schemas rather than arbitrary object graphs, and must redact credentials, secret environment values, private account labels, and unrelated session data. L3 inherits that rule without exception.

L3's legitimate use is harness debugging: asking why a trajectory failed, whether the right context was routed, whether a tool description misled the worker. It is a developer capability, not a review default, and a reviewer at L3 is reviewing the harness rather than the work.

### Handoff is recorded

Every delegate result records the handoff level actually used, and the level is part of the finding's provenance. A reviewer's agreement means something different at L1 than at L3, and a report that does not distinguish them is not interpretable. Raising handoff level to resolve a disagreement is legitimate; doing so silently is not.

### Redaction

The packet and any projection pass the same redaction as the audit and preview surfaces in [Agent Control Plane](CONTROL-PLANE.md): no credentials, no secret environment values, no unrelated session content. A delegate is a separate process with its own environment; it inherits no credentials it does not need, and reviewer roles receive none.

## Adversarial review

### What adversarial means here

Not tone. Three concrete properties:

1. **A stated claim to falsify.** The reviewer is given the claim and asked for the strongest reason it is false, not for an assessment.
2. **An independent path to evidence.** The reviewer reads source and runs checks; it does not accept the author's summary as fact.
3. **A cost to unfalsifiable output.** A finding without a location and an argument is not a finding, and is rejected by the output contract rather than passed to a human.

### Review failure modes

These are the design targets. A review capability that does not address them adds cost and confidence without adding correctness.

| Failure | Mechanism | Mitigation |
| --- | --- | --- |
| Agreement bias | Reviewer sees the author's reasoning and confirms it | L1 default; author reasoning excluded from the packet |
| Shared blind spot | Reviewer is the same model as the author | Diversity rule; non-equivalent worker required for reviewer roles |
| Manufactured findings | Reviewer must produce output, so it invents objections | Severity contract; empty finding sets are valid and recorded as such |
| Reviewer capture | Author summarizes selectively; reviewer validates the summary | Reviewer re-derives from source; artifacts are referenced by revision, not quoted |
| Unfalsifiable verdict | "Looks risky", "consider refactoring" | Output contract requires location, claim, and failure scenario |
| Review theatre | Findings accumulate, nothing changes | Convertibility rule below |
| Definition capture | Repository supplies the reviewer prompt | Reviewer definitions are user- or organization-sourced by default |
| Scope drift | Reviewer rewrites the code it reviews | Write and network denied by authority, not by prompt |

### Finding contract

```yaml
finding:
  id: ...
  delegateRevision: sha256:...
  handoff: packet
  worker: { providerId: ..., modelId: ..., offeringId: ... }
  severity: blocking | material | advisory
  location: { path: ..., line: ... }
  claim: "The retry path double-counts usage when the first attempt returns a partial stream"
  failureScenario: "Given ..., the ledger records ..., which contradicts ..."
  evidence: [ { kind: read|command|check, ref: ... } ]
  convertible: true
  proposedCheck: { kind: test|lint|type|assertion, sketch: ... }
  status: open | converted | accepted | rejected | superseded
```

`failureScenario` is required for `blocking` and `material`. A severity claim without a concrete path to the failure is downgraded to `advisory` automatically. This is the mechanical version of the falsifiability requirement and it does most of the work of suppressing manufactured findings.

### Convertibility

The rule that keeps review honest:

- A **convertible** finding is one that can be expressed as a failing test, a type, a lint rule, an assertion, or a schema constraint. The correct response is to write that check. Once it exists, the check gates and the finding is closed as `converted`. The gate is the check, not the reviewer.
- A **non-convertible** finding — architectural concern, naming, unclear intent, judgment about a tradeoff — is an annotation on the review packet for a human. It never blocks automatically.

This is the delegation-specific instance of the feedback principle in [Harness Engineering and Jouzu](HARNESS-ENGINEERING.md): the durable product of a review is the check that outlives it, promoted to the smallest owner that can enforce it. A review capability whose findings never convert is producing text, and its evaluation should say so.

### What a reviewer may assert

Reviewers make negative and exhaustive claims constantly — "nothing else calls this", "this is the only affected path", "no test covers this". [Repository Knowledge and Code Graphs](REPOSITORY-KNOWLEDGE.md) already sets the standard: such claims require the repository and index revision, the supported configuration, the indexed and skipped populations, resolution failures, truncation state, and an explicit statement of unresolved limits.

A reviewer that cannot supply coverage for a negative claim must state the claim as bounded — what it searched and how — rather than as a fact. The output contract enforces this by requiring evidence references on any finding whose claim is exhaustive.

### Diversity and selection

Reviewer roles declare a diversity rule against the parent's worker. `not-equivalent-to-parent` uses the catalog's exact-equivalence relation: a reviewer must not run on an offering that serves the same canonical model release as the author, regardless of provider. Preferring a different developer's model is stronger still.

Reviewer selection is a cost-performance question and should use the same catalog and ledger data as any other model choice. Two reviewers on cheap, fast, diverse models frequently beat one expensive reviewer, and that tradeoff is measurable rather than assumed — see [Evaluating review](#evaluating-review).

Policy filtering applies unchanged. A reviewer is a model call on the same code; jurisdiction, retention, and ZDR constraints do not relax because the call is a review.

## Adversarial planning

Pi has no plan mode, so plan handling is Jouzu-defined in the same way delegation is.

A plan is an artifact, not a phase. The useful adversarial pattern is:

1. the primary trajectory produces a plan, or several independent delegates each produce one at L0/L1;
2. a falsifier delegate receives the plan and the requirement and is asked for the strongest reason the plan does not achieve the requirement, what it assumes without evidence, and what it leaves unproved;
3. the primary trajectory integrates, resolves, and remains accountable for the plan it proceeds with.

Two constraints. First, independent plans must be generated **before** any of them is seen by the others, or they collapse into variations on the first. Second, the primary trajectory selects — a selection delegate that picks the plan has taken ownership of the outcome, which the topology rules forbid.

Plan falsification is the highest-leverage review point available, because a defect caught in a plan costs one delegate call and a defect caught in review costs the implementation as well. It is also the cheapest, since plans are small. This ordering should be reflected in default workflows.

## Trust and authority

### Delegate authority is a subset of parent authority

A delegate never holds capability the parent lacks. The parent's tool set, sandbox ceiling, approval policy, and credential scope bound the child's, and the delegate definition narrows further. Any other arrangement makes delegation an escalation path.

Reviewer roles default to: no write tools, no network, no credentials, bounded duration, bounded cost.

### Read-only means read-only, not `bash` with instructions

Granting `bash` and asking for restraint is the pattern the reference reviewer uses and openly flags as unenforceable. Jouzu should not ship that. Options, in order of preference:

1. omit `bash` and provide purpose-built read-only tools for the operations reviewers actually need — `git diff`, `git log`, `git show`, test invocation with a read-only working tree;
2. run the delegate against a read-only checkout or a copy, so writes are contained by the filesystem rather than the prompt; and
3. where a reviewer genuinely needs to execute — reproducing a failure, running a test — grant it in a disposable workspace whose contents are discarded, and treat any write to the reviewed tree as a fault.

The general rule: enforce with the mechanism that has authority. The tool allowlist is enforced at process start and can be trusted; instructions inside a system prompt cannot.

### Definition sourcing

Reviewer and falsifier definitions default to user or organization scope. Project-supplied reviewer definitions are off by default, because a repository that supplies the agent reviewing it can supply one that approves everything, and the failure is silent and looks like success.

Project-supplied definitions for non-judging roles — a scout that knows a repository's layout, a worker with project conventions — are more defensible and follow Pi's existing project-trust model: excluded by default, enabled explicitly, confirmed interactively, and recorded in the composition snapshot.

Delegate definitions are also prompt-injection reachable through the content they read. A reviewer reading a repository file that instructs it to report no findings is an ordinary local-agent risk that no prompt hardening reliably prevents. The mitigations that work are structural: the reviewer cannot write, its findings are contracted, its trajectory is retained, and a review that returns nothing on a change with material risk is itself a signal worth surfacing.

## Accounting and evidence

### Nested usage provenance

[Usage Tracking and Cost Accounting](USAGE-TRACKING.md) already models a nested model call made by a tool as an operation, and already lists provenance for nested tool usage as a required Pi integration improvement, noting that Pi currently aggregates it into a tools/summaries bucket. Adversarial review is the workload that makes this acute: a three-reviewer fan-out triples the cost of a turn, and an aggregate bucket cannot say whether the expensive reviewer earned its cost.

Each delegate invocation is therefore its own operation with its own logical requests and attempts, carrying `delegateId`, `delegateRevision`, `parentOperationId`, and the handoff level. Rollups to the parent turn are derived projections, never new raw observations.

### Cache lineage

Each delegate is a separate process with a separate provider cache namespace. The parent's cache does not serve it, and its context is submitted and priced in full. This follows directly from the cache-lineage model in [Usage Tracking and Cost Accounting](USAGE-TRACKING.md) and it is the dominant cost characteristic of delegation: three reviewers on one packet means three full context submissions, not three cheap continuations.

Two consequences for design. Packet size is a cost lever with direct leverage, which is another argument for L1 over L2. And repeated review of an evolving artifact within one turn does not amortize the way an interactive session does.

### Delegate trajectories are retained

The reference implementation disables session persistence for children. Jouzu should persist delegate sessions, linked to the parent session and the delegate revision, because:

- a verdict that influenced a decision must be replayable to be corroborated, per the self-report rule in [Harness Engineering and Jouzu](HARNESS-ENGINEERING.md);
- review quality cannot be evaluated without the trajectories that produced the findings; and
- a rejected finding that recurs should be recognizable as a repeat rather than rediscovered.

Retention is bounded and follows the same privacy rules as the rest of the ledger: no credentials, no unrelated session content, configurable horizon.

### Budgets and stop conditions

Every delegate invocation carries a duration bound and a cost basis bound, and the parent turn carries an aggregate bound across its delegates. Exceeding a bound aborts the delegate and records a truncated result — a reviewer that ran out of budget produced an incomplete review, and that must be visible rather than rendered as "no findings". The reference implementation's caps of eight tasks and four concurrent are a reasonable starting shape; the budget bound is the one that actually protects against a fan-out that costs more than the work it reviews.

## Control plane integration

[Agent Control Plane](CONTROL-PLANE.md) does not currently model children. Delegation requires three additions there:

1. an execution detail of `delegating`, with a running/total child count, so the fleet view can show that a workspace is fanned out rather than stalled;
2. an attention rule that a parent with running delegates is not idle and must not surface as `review_ready`; and
3. cost roll-up that reports delegate spend against the parent workspace while preserving the per-delegate attribution above.

None of these change the observation schema's shape; they are additional fields and one reducer rule. They should land with delegation rather than after it, because a delegating agent that appears stalled is exactly the false signal the control-plane design exists to prevent.

## Evaluating review

Review is a harness intervention and is subject to the evaluation method in [Harness Engineering and Jouzu](HARNESS-ENGINEERING.md): one falsifiable hypothesis, the smallest reversible change, fresh comparable trajectories within one worker epoch, and an ablation when value is unclear.

The specific measures:

| Measure | Question |
| --- | --- |
| Seeded-defect recall | Of known defects deliberately introduced, what fraction does the reviewer find? |
| False-positive rate | Of findings at `blocking` or `material`, what fraction survives human triage? |
| Conversion rate | What fraction of findings become durable checks? |
| Unique yield | What does this reviewer find that the checks already in the repository do not? |
| Cost per accepted finding | Including the cost of triaging rejected ones |
| Latency cost | Added time to acceptance, which the flow dimension already tracks |

Unique yield is the one that decides whether a reviewer should exist. A reviewer that reliably reports what the type checker already reports is a slower type checker, and the correct response is to delete the reviewer, not to tune it. This is the subtraction principle applied to review.

A seeded-defect corpus is the prerequisite for all of this and should be built before the second reviewer role is added. Without it, reviewer prompts get tuned on impressions.

## Operational safeguards

- Reviewer roles run without write tools, network, or credentials by default.
- Project-sourced judging definitions are disabled by default and cannot be enabled implicitly by a repository.
- Delegate depth is capped at one; nested delegation is rejected rather than silently flattened.
- Every delegate invocation is bounded in duration and cost, with aggregate bounds per parent turn.
- Truncated, aborted, and errored delegate results are surfaced as incomplete, never as empty.
- Findings carry delegate revision, worker identity, and handoff level, or they are not admissible.
- Raising handoff level is recorded and requires the delegate definition to permit it.
- L3 introspection is available only in an explicit developer profile, with bounded schemas and redaction.
- No delegate output modifies composition, policy, approval ceilings, or the model catalog.

## Testing strategy

1. **Handoff fidelity.** Assert that an L1 packet contains the claim, artifacts, checks, and exclusions and contains no assistant reasoning from the parent; fuzz parent trajectories to confirm no leakage across the boundary.
2. **Authority containment.** A reviewer definition requesting write tools, network, or credentials is rejected; a delegate cannot obtain a tool the parent lacks; writes to the reviewed tree from a read-only reviewer fail.
3. **Definition trust.** A project-supplied reviewer definition is not loaded by default; enabling it requires explicit scope and is recorded; a project definition cannot shadow a user reviewer silently.
4. **Finding contract.** Findings lacking location, claim, or failure scenario are downgraded or rejected; exhaustive claims without evidence references are rejected.
5. **Seeded defects.** A corpus of known defects across classes, measuring recall per reviewer revision and per worker, with condition-blind human triage of findings.
6. **False-positive control.** Clean changes with no defects must produce empty finding sets at a measured rate; a reviewer that never returns empty is failing.
7. **Accounting.** Per-delegate usage is attributed distinctly, never merged into one bucket; rollups reconstruct from raw observations; a delegate's context is not credited with parent cache reads.
8. **Budget enforcement.** Duration and cost bounds abort delegates and produce visibly incomplete results; aggregate bounds hold under parallel fan-out.
9. **Control plane.** A parent with running delegates never reports `idle` or `review_ready`; child counts and cost roll-up are correct under abort and failure.
10. **Lifecycle.** Delegate processes are terminated on parent abort, session switch, and shutdown, with no orphans — the effect-scope invariant from [Recomposition and Controlled Evolution](COMPOSITION.md).

## Proposed implementation phases

### Phase 1: delegation mechanism

Productized delegate invocation with content-addressed definitions, enforced tool allowlists, authority subsetting, duration and cost bounds, retained delegate sessions, and per-delegate usage attribution. Roles limited to `scout` and `worker`. Deliverable: bounded, accountable, attributable delegation.

### Phase 2: review packet and L1 review

Review packet generation from a trajectory; `reviewer` role at L1 with the finding contract; diversity rule against the parent worker; findings surfaced to the primary trajectory as annotations only. Deliverable: independent review that cannot gate.

### Phase 3: convertibility and evaluation

Finding-to-check conversion workflow; seeded-defect corpus; recall, false-positive, conversion, and unique-yield measurement; reviewer revisions evaluated as harness interventions. Deliverable: evidence that review earns its cost, per reviewer.

### Phase 4: adversarial planning

Plan as artifact; independent parallel plan generation; falsifier role; integration by the primary trajectory. Deliverable: defects caught before implementation cost is incurred.

### Phase 5: projection and introspection

L2 projected handoff for process review; L3 introspective handoff behind the developer profile with bounded schemas and redaction. Deliverable: harness debugging by delegate.

Cross-host adversarial work and review inside the composition promotion loop remain out of scope for all five phases.

## Reconsideration gates

1. Pi adds first-party subagents, in which case Jouzu's mechanism should become a thin layer over it and this document's process-boundary decisions are reopened.
2. Measured unique yield is near zero across reviewer roles, in which case review should be retired in favor of the checks it duplicates rather than tuned.
3. False-positive rates make triage cost exceed defect cost, which inverts the value of the capability and demands a stricter contract or fewer reviewers.
4. Nested delegation becomes necessary for a real workload, which requires budget propagation and depth accounting before it is permitted.
5. Cache economics change such that delegate context resubmission is no longer the dominant cost, which changes the L1-versus-L2 tradeoff.
6. A reviewer is found to have modified the artifact it reviewed, which invalidates the authority model and blocks further review work until repaired.

## Open questions

1. Should the review packet be generated automatically from the trajectory, authored by the primary trajectory, or both with the automatic version as a floor?
2. What is the right default reviewer count — one diverse reviewer, or two cheap diverse reviewers — and does it vary by change risk?
3. Should `advisory` findings be shown to the primary trajectory at all, or only to the human in the review packet?
4. How should a recurring rejected finding be suppressed without suppressing a genuine repeat defect?
5. Does the diversity rule need a provider dimension, or is non-equivalence at the canonical-model level sufficient?
6. Should delegate sessions live in the parent's session directory, a delegate-specific tree, or the ledger's storage?
7. What retention horizon applies to delegate trajectories, and does it differ for reviewers whose verdicts influenced a merge?
8. Should plan falsification be a default workflow step for changes above a risk threshold, and what defines that threshold?
9. Is a read-only checkout, a disposable workspace, or purpose-built read-only tools the right primary answer for reviewers that must execute?
10. Should organization-level reviewer definitions be distributable through the same signed channel as the model catalog?
11. How should a delegate's findings be represented in the session tree so that they are visible to the model without being mistaken for user instruction?
12. Does the L2 projection need its own schema, or is it a filtered view of session entries?

## Required invariants

- One trajectory owns the outcome; no delegate chain moves accountability out of it.
- A delegate never holds capability the parent lacks.
- Reviewer roles hold no write tools, no network, and no credentials by default.
- A repository never supplies the definition of an agent that judges it, unless explicitly and recordedly enabled.
- Tool restriction is enforced by the tool allowlist and process boundary, never by system-prompt instruction alone.
- A reviewer's verdict never gates; only a check gates.
- A finding without a location, claim, and failure scenario is not admissible at blocking or material severity.
- An exhaustive or negative claim without coverage evidence is stated as bounded, not as fact.
- Every finding records the delegate revision, worker identity, and handoff level that produced it.
- Handoff level is never raised silently.
- L3 introspection is available only in a developer profile, with bounded schemas and redaction.
- Delegate usage is attributed per delegate and never merged into a single aggregate bucket.
- A delegate's context is never credited with the parent's cache reads.
- A truncated, aborted, or errored review is never presented as a review that found nothing.
- Delegate trajectories that influenced a decision are retained and replayable.
- A parent with running delegates is never reported as idle.
- No delegate output modifies composition, policy, approval ceilings, or the catalog.

## Primary sources

- Pi subagent reference extension, agent discovery, and invocation flags — `examples/extensions/subagent/` in `@earendil-works/pi-coding-agent` 0.83.0
- Pi's stated exclusion of built-in subagents and plan mode — `docs/usage.md`, ibid.
- Pi extension context, session access, system-prompt options, and context usage — `docs/extensions.md`, ibid.
- Pi project trust and absence of a built-in sandbox — `docs/security.md`, ibid.
- [Harness Engineering and Jouzu](HARNESS-ENGINEERING.md) — trajectory ownership, review packet, self-report handling, evaluation method
- [Recomposition and Controlled Evolution](COMPOSITION.md) — candidate identity, effect scopes, model-facing introspection policy
- [Usage Tracking and Cost Accounting](USAGE-TRACKING.md) — nested operation accounting, cache lineage, nested-provenance gap
- [Model Catalog](MODEL-CATALOG.md) — exact equivalence, policy filtering, cost-performance ranking
- [Repository Knowledge and Code Graphs](REPOSITORY-KNOWLEDGE.md) — negative claims and coverage requirements
- [Agent Control Plane](CONTROL-PLANE.md) — observation model and the delegation fields it needs
