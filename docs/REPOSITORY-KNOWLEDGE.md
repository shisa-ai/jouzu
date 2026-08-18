# Repository Knowledge and Code Graphs

- **Status:** Research note and provisional experiment plan
- **Scope:** Automatic repository maps, structural code graphs, temporal project memory, retrieval, provenance, freshness, evaluation, and Jouzu integration
- **Related:** [Harness Engineering and Jouzu](HARNESS-ENGINEERING.md), [Recomposition and Controlled Evolution](COMPOSITION.md), [Usage Tracking and Cost Accounting](USAGE-TRACKING.md), [DeepSeek Harness and Jouzu](DEEPSEEK-HARNESS.md), [Agent Control Plane](CONTROL-PLANE.md), [Delegation and Adversarial Review](DELEGATION-AND-REVIEW.md)

## Decision

Jouzu should investigate repository graphs as an **optional context capability**, not make a graph database a canonical source of repository truth or a mandatory part of the Pi distribution.

The research separates two systems that are often both called a “knowledge graph”:

1. a **structural code projection**, derived mechanically from files, manifests, parsers, semantic indexes, build metadata, and optionally runtime traces; and
2. a **temporal project-memory graph**, containing sourced decisions, ownership, conventions, incidents, prior fixes, and other facts that are not recoverable reliably from syntax alone.

They have different owners, update mechanisms, confidence models, and failure modes. Jouzu should not force them into one undifferentiated graph.

```text
authoritative repository and external systems
        |                     |
        | deterministic       | reviewed claims and source refs
        v                     v
structural code projection    temporal project-memory projection
        \                     /
         \ bounded, revision-pinned retrieval
          v
       active trajectory
```

The initial experiment should start below either graph database:

- establish a grep/read baseline;
- test a small Aider-style repository map with task-ranked symbols under a token budget;
- test one permissively licensed external structural index through a read-only CLI/tool adapter; and
- retain a component only if fixed-worker reruns improve accepted outcomes or materially reduce human attention without weakening proof.

Graphiti and Potpie are useful references for temporal project memory. They are not substitutes for a semantic code index. GitNexus is a useful structural design reference and research tool, but its PolyForm Noncommercial license prevents embedding or commercial use in Jouzu without a separate license.

## Three knowledge planes

### 1. Authoritative source plane

The Git repository owns current code, manifests, tests, local architecture, and checked-in decisions. Issue trackers, deployment systems, observability stores, document systems, and organization policy retain their own current records and permissions.

A graph is not allowed to become “correct” by agreeing with its own stale copy. Every derived fact must be recoverable from a source revision or carry an explicit reviewed claim with provenance.

### 2. Structural projection plane

The structural projection answers questions such as:

- where a symbol is defined and referenced;
- which files import or depend on another file;
- callers, callees, inheritance, implementation, and route relationships;
- a likely change blast radius;
- architecture clusters and entry points; and
- which parts of the requested scope the index could not analyze.

It is rebuildable and revision-pinned. It should never be edited manually as a second model of the code.

### 3. Temporal project-memory plane

The memory projection answers questions syntax usually cannot:

- why an architecture or dependency was selected;
- which team owns a capability;
- which policy applies in a scope;
- which prior bug had a similar symptom and what fixed it;
- which attempted fix failed;
- what was true before a migration or incident; and
- where to retrieve the current authoritative record.

These facts need source references, evidence class, observation and validity time, supersession, and often review. They are not safe products of an AST pass.

## What automatic code graphs can and cannot know

A code graph can make repository structure addressable, but “the complete codebase graph” is not a meaningful unqualified claim.

### Syntax is not semantics

Tree-sitter reliably supplies syntax trees across many languages. It does not by itself prove dynamic dispatch, overload resolution, generated code, macro expansion, reflection, dependency injection, framework wiring, conditional compilation, runtime configuration, or behavior across service boundaries.

Projects bridge this gap in different ways:

- name- and import-based heuristics;
- language-specific resolution passes;
- LSP-derived type information;
- compiler or SCIP indexes;
- framework-specific extractors;
- build manifests and compilation databases; and
- runtime traces that validate selected edges.

Each edge should therefore carry derivation and confidence. A missing edge may be an index-coverage limit. An inferred edge may be a lower-confidence candidate. Neither should be presented as an exhaustive fact.

### Negative claims require coverage

“Nothing calls this function,” “this code is dead,” and “only these files are affected” are stronger claims than returning several callers. They require:

- the exact repository and index revision;
- supported language and build configuration;
- indexed and skipped file populations;
- parse and semantic-resolution failures;
- generated and external-code policy;
- query pagination and truncation state; and
- an explicit statement of unresolved limits.

A structural tool should expose a coverage report with every exhaustive or negative claim. The worker should read the cited source and run target-native checks before acting on the claim.

### Graph retrieval does not replace proof

A call path can guide localization. It does not prove that a patch works. The final proof still comes from tests, builds, browser journeys, runtime observations, compatibility corpora, or other evidence at the affected boundary.

## Project survey

The inspected projects divide naturally into lightweight maps, structural graph engines, and temporal/context graphs.

### Lightweight repository maps and research systems

#### Aider repository map

[Aider's repository map](https://aider.chat/docs/repomap.html) is the strongest minimal baseline. It extracts important definitions and signatures, builds a file dependency graph, ranks nodes for the current chat, and emits only the highest-value map content that fits a token budget. It does not require a graph database or ask the model to explore raw edges repeatedly.

Useful lessons:

- graph construction and model-facing presentation are separate problems;
- global structure can be useful in a very small active slice;
- task-aware ranking matters more than dumping all symbols; and
- a compact map can improve navigation while source files remain authoritative.

Its always-in-context presentation is not automatically correct for Pi. Jouzu should compare a small injected map with a just-in-time query tool because repeated injection affects prompt caching and attention.

#### RepoGraph

[RepoGraph](https://arxiv.org/abs/2410.14684) builds a repository-level graph and adds graph retrieval to SWE-agent and procedural repair systems. Its released implementation stores line-level tags and a NetworkX graph. The paper reports improvements across several SWE-bench integrations and CrossCodeEval.

It supplies evidence that repository structure can improve software-engineering systems, but it is a research plugin rather than a production incremental index, authorization model, or durable project-memory system.

#### LocAgent

[LocAgent](https://arxiv.org/abs/2503.09089) represents files, classes, functions, imports, invocations, and inheritance as a directed heterogeneous graph and exposes graph navigation for code localization. The paper reports stronger localization and downstream issue-resolution results, including with Qwen Coder.

The result supports a bounded claim: graph-guided navigation can improve code localization. It does not establish that every editing trajectory needs a graph or that localization metrics alone capture a maintainable accepted patch.

#### SCIP

[SCIP](https://github.com/scip-code/scip) is a language-neutral protocol for semantic code indexes, not an agent product. Language-specific indexers and tools such as rust-analyzer emit definitions, references, and implementation relationships into a common protobuf format.

SCIP is an important substrate because it separates a stable consumer format from language-accurate indexers. Its tradeoff is operational: each language needs an indexer and often a valid build or compilation environment. Jouzu should prefer SCIP/LSP evidence over syntax heuristics where available, while retaining a graceful lower-confidence Tree-sitter fallback.

### Structural graph engines

#### GitNexus

Inspected snapshot: [`fe3d7e5`](https://github.com/abhigyanpatwari/GitNexus/tree/fe3d7e56be5a557e051f12684dfbdce9d5a31920).

GitNexus is a local TypeScript/LadybugDB code-intelligence system. It combines Tree-sitter parsing, language-specific scope resolution, routes and tool extraction, inheritance and dependency-injection passes, community detection, precomputed execution processes, hybrid search, impact analysis, and an optional program-dependence/taint layer. It exposes bounded higher-level MCP tools such as context, impact, trace, changed-code detection, route maps, and structural checks rather than requiring the model to compose every raw graph query.

Strengths as a reference:

- precompute useful relational answers instead of exposing only raw Cypher;
- return epistemic boundaries when receiver resolution is incomplete;
- expose index staleness and repository selection;
- support token budgets on model-facing responses;
- provide read-only and repository-allowlist modes; and
- separate per-repository indexes from cross-repository contract bridges.

Concerns:

- the license is **PolyForm Noncommercial 1.0.0**, not an open-source commercial license;
- its default `analyze` flow can also install skills, hooks, and context-file blocks, so an evaluation must use index-only or explicit skip modes and an isolated home;
- the feature and language surface is moving quickly and needs version-pinned qualification; and
- high-level process, impact, and PDG claims still depend on language and framework coverage.

**Jouzu decision:** reference and optional noncommercial research trial only. Do not vendor, redistribute, or build a Jouzu commercial feature on it without a separate license review and agreement.

#### Codebase-Memory MCP

Inspected snapshot: [`49d928b`](https://github.com/DeusData/codebase-memory-mcp/tree/49d928be67322184fe25c8d15acd6f0e80b7e648).

Codebase-Memory MCP is an MIT-licensed local native structural index using Tree-sitter, language-specific semantic-resolution code, SQLite-backed storage, call and impact queries, architecture summaries, coverage checks, and a shared background watcher. It deliberately leaves natural-language reasoning to the calling agent.

Its associated [preprint](https://arxiv.org/abs/2603.27277) reports 83% answer quality versus 92% for file exploration, with ten times fewer tokens and 2.1 times fewer tool calls across 31 repositories. That is more informative than a pure token-reduction claim: the graph trades some answer quality for efficiency in the reported aggregate while matching or exceeding the explorer on selected graph-native questions.

Qualification concerns:

- the March 2026 paper describes 66 parsed languages, while the August 2026 README advertises 158; the repository is evolving faster than the paper and must be evaluated at an exact binary/source revision;
- the checked-in language benchmark often measures whether a query returns usable results rather than precision/recall against independently established call edges;
- README token-reduction examples and the paper use different tasks and should not be merged into one claim;
- installers modify coding-agent configuration and durable instructions; and
- native parsers and a standing daemon add supply-chain and lifecycle surface.

**Jouzu decision:** the strongest permissively licensed candidate for a read-only external trial, provided it is built or downloaded with verified provenance, run with an isolated cache/config, restricted to one repository, and judged against source-grounded tasks rather than its own index.

#### CodeGraphContext

Inspected snapshot: [`810ea8a`](https://github.com/CodeGraphContext/CodeGraphContext/tree/810ea8a9f04fddb2b298b61d752a5e619e19245a).

CodeGraphContext is an MIT-licensed Python CLI and MCP server. It uses Tree-sitter across a broad language set, optional SCIP indexers for more precise languages, embedded or remote graph databases, live file watching, caller/callee and inheritance queries, dead-code and complexity analysis, bundles, and visualization.

Strengths:

- permissive license;
- explicit Tree-sitter-versus-SCIP distinction;
- embedded backends and a CLI path that can be tested without a standing service;
- incremental watching; and
- direct structural query surface.

Concerns:

- the package classifies itself as alpha;
- the architecture snapshot documents several advanced per-language query toolkits as unimplemented;
- multiple graph backends and parser dependencies create a large compatibility matrix;
- Kuzu is archived and dependency pins show active backend churn; and
- broad language support does not establish semantic edge accuracy for each language.

**Jouzu decision:** a useful second permissive candidate, especially for testing SCIP-backed precision. Do not select it from feature count; compare it with Codebase-Memory and the lightweight map on the same Jouzu jobs.

### Temporal and project-context graphs

#### Graphiti

Inspected snapshot: [`a3596b8`](https://github.com/getzep/graphiti/tree/a3596b8bc1bdf95dc690368c2dfa0a38e8e8e07c).

[Graphiti](https://github.com/getzep/graphiti) is the likely “Graphiti/Grafiti” project. It is an Apache-2.0 temporal context-graph engine for agent memory. It ingests structured and unstructured **episodes**, uses an LLM to extract and deduplicate entities and facts, keeps source provenance, tracks validity windows and superseded facts, and supports hybrid semantic, keyword, and graph retrieval.

It addresses changing organizational and conversational truth rather than static code semantics. Its strengths are temporal validity, source lineage, incremental ingestion, and explicit custom ontology. Its costs are substantial: a graph backend, embeddings, an LLM with reliable structured output, ingestion latency/cost, ontology and deduplication behavior, and a separate surrounding service for users, permissions, and production operations.

Graphiti's paper evaluates agent-memory retrieval, not code-call-graph accuracy. Feeding source code to its LLM extraction path would be a costly and less precise substitute for a semantic code index.

**Jouzu decision:** reference for the future temporal memory plane. Do not use it to generate the structural repository graph. Prototype it only after Jouzu has a concrete recurring-memory failure, a reviewed ontology and provenance policy, and a benchmark that cheaper Markdown/search cannot satisfy.

#### Potpie

Inspected snapshot: [`a341978`](https://github.com/potpie-ai/potpie/tree/a341978880b9d4c1b403831931279ccedf6184ae).

Potpie is an Apache-2.0 CLI-first “context graph” for project memory. Its current graph model stores compact claims and source references about repositories, services, code assets, features, ownership, activities, preferences, policies, bugs, fixes, and decisions. The canonical claim store is separated from rebuildable semantic, inspection, and analytics projections. Its agent-facing write path uses proposal, validation, commit, and read-back verification rather than unrestricted direct graph edits.

This is philosophically close to Jouzu's controlled composition work:

- the harness, not an embedded Potpie model, owns reasoning by default;
- source payloads remain outside the graph;
- low-authority observations are distinguished from authoritative facts;
- ambiguous changes can remain inbox proposals;
- local embedded operation is supported; and
- context can be injected mechanically at selected lifecycle points.

The inspected architecture is also candid about current limits: repository scanners were removed and local baseline ingestion is harness-led; managed routing and external ledger clients remain unimplemented; several backend capabilities are partial; and server-side LLM reconciliation is off by default.

**Jouzu decision:** strong reference and possible external interoperation target for the temporal project-memory plane. It does not remove the need for a structural code index, and Jouzu should not fork it or copy its ontology before local requirements establish the entities and claims Jouzu actually needs.

## Comparative view

| System | Primary plane | Extraction | Incremental/freshness | Model-facing surface | License/fit |
| --- | --- | --- | --- | --- | --- |
| Aider repo map | Structural summary | Tree-sitter tags + dependency ranking | Recomputed/cache-backed | Token-budgeted map | Simple baseline |
| RepoGraph | Structural research | Static repository parsing | Primarily batch/cached | Graph search action | Research evidence |
| LocAgent | Structural localization | Heterogeneous code graph | Benchmark-oriented | Multi-hop graph tools | Research evidence |
| SCIP | Semantic index protocol | Compiler/LSP-grade indexers | Indexer-dependent | Consumer-defined | Substrate, not product |
| GitNexus | Structural intelligence | Tree-sitter + deep language/framework passes | Git staleness + reanalysis | High-level MCP/CLI + raw Cypher | Noncommercial; reference only |
| Codebase-Memory MCP | Structural intelligence | Tree-sitter + native semantic passes | Watcher + generation/coverage | Read-only MCP/CLI tools | MIT; primary trial candidate |
| CodeGraphContext | Structural intelligence | Tree-sitter, optional SCIP | Watcher + graph backends | MCP/CLI/Cypher | MIT alpha; second candidate |
| Graphiti | Temporal agent memory | LLM extraction from episodes | Incremental bitemporal facts | Hybrid graph search/MCP/API | Apache; memory plane only |
| Potpie | Temporal project memory | Harness-authored/reconciled claims | Source refs, temporal claims, nudges | CLI skills and graph workbench | Apache; memory-plane reference |

## Recommended Jouzu contract

Jouzu should define a small runtime-neutral **repository context provider** contract before selecting an engine. The contract should not expose one vendor's graph schema as the product API.

### Provider identity and readiness

An effective provider report should include:

- provider and implementation version;
- index schema version;
- repository identity and allowed root;
- source Git commit plus dirty-worktree fingerprint or explicit dirty status;
- index generation ID and build timestamp;
- selected languages, build profiles, and parser/indexer versions;
- indexed, skipped, failed, generated, vendored, and external file counts;
- supported query capabilities and confidence tiers;
- watcher state and staleness reason; and
- whether any query can mutate the graph, repository, agent configuration, or external state.

A provider that cannot establish current revision and coverage may still support positive discovery. It must not support exhaustive negative or blast-radius claims as if they were complete.

### Minimal read surface

Start with a small set of model-legible operations:

| Operation | Purpose |
| --- | --- |
| `repository_map(task, budget)` | Return task-ranked files, symbols, signatures, and architecture anchors |
| `search_symbols(query, filters)` | Locate definitions and candidate symbols |
| `symbol_context(symbol)` | Return definition, references, related types, and source spans |
| `trace(from, to or direction, depth)` | Return bounded paths with derivation and confidence |
| `impact(changed_spans, direction, depth)` | Return candidate affected symbols and explicit coverage limits |
| `coverage(paths or query)` | Explain which requested population was or was not analyzed |
| `status()` | Report source revision, generation, staleness, and capabilities |

Raw Cypher can remain an expert/debug surface. It should not be the only route an agent has to common questions.

### Result envelope

Every result should include enough context to assess the claim:

```yaml
provider: code-context-provider-id
providerVersion: exact-version
repositoryRevision: git-commit-or-dirty-fingerprint
indexGeneration: immutable-generation-id
query:
  operation: impact
  normalizedArguments: {}
results:
  - symbolId: stable-provider-id
    path: packages/example/src/file.ts
    span: { startLine: 10, endLine: 42 }
    relation: calls
    derivation: scip | lsp | tree-sitter | heuristic | manifest | runtime-trace
    confidence: exact | high | candidate | unknown
coverage:
  completeForClaim: false
  indexedFiles: 120
  skippedFiles: 4
  parseFailures: 1
  limitations: []
truncated: false
nextEvidence:
  - read cited source spans
  - run target-native tests
```

The envelope is context, not authority. Source content and graph labels can contain prompt injection or misleading comments and must remain untrusted input.

### Structural node and edge provenance

Jouzu does not need to standardize every engine's internal graph. It does need stable interchange concepts:

- repository and source revision;
- file path and source span;
- symbol kind and qualified identity;
- relationship type and direction;
- extraction method and tool version;
- confidence or exactness class;
- optional runtime/build profile; and
- generation and coverage status.

When SCIP supplies a stable symbol identity, preserve it. When only syntax is available, identity should include repository revision, language, path, kind, qualified name, and span rather than assuming names are globally unique.

## Temporal memory contract

If Jouzu later adds project memory, it should use a separate claim lifecycle.

A minimal claim needs:

- stable claim and subject identities;
- scoped predicate and object;
- source references rather than copied payloads where possible;
- evidence/authority class;
- observed, valid-from, valid-to, and superseded timestamps as applicable;
- producing worker/composition and proposal identity;
- state such as proposed, accepted, superseded, rejected, or expired;
- reviewer or policy decision; and
- a route to refresh against the authoritative owner.

Agent observations default to low authority. A candidate channel must be excluded from normal retrieval until review or deterministic validation publishes it. The writer, publisher, and reading worker should have distinct authority where the consequence warrants it.

A memory claim may reference a structural symbol and index generation, but it should not copy the entire call graph into temporal memory. Structural edges are rebuilt from source; project decisions are reviewed and maintained through their own lifecycle.

## Evaluation plan

### Questions

The pilot should answer:

1. Does a repository map or structural graph improve code localization on real Jouzu tasks?
2. Does it reduce grep/read loops and active tokens without lowering accepted-result quality?
3. Does impact context prevent missed sibling changes or instead encourage false confidence?
4. Can the worker detect and recover from a stale, incomplete, or contradictory index?
5. Does the capability save enough human attention to cover indexing, maintenance, context, and security cost?

### Conditions

Hold constant:

- worker epoch and reasoning budget;
- target revision and dirty state;
- task prompt, authority, and time budget;
- available non-graph tools; and
- evaluator and accepted outcome.

Compare at least:

1. **Baseline:** Pi file search, grep, read, and target-native language/build tools.
2. **Map:** a task-ranked Aider-style symbol/file map under a fixed context budget.
3. **Graph candidate:** one read-only permissive provider, initially Codebase-Memory MCP or CodeGraphContext.

A graph condition must record whether the agent discovered, invoked, and relied on it. Offering a tool that was never used is not evidence of benefit.

### Task classes

Use source-grounded jobs rather than synthetic graph trivia:

- locate the files needed for a historical Jouzu change;
- identify a deliberately planted cross-package impact;
- complete a real bug fix with hidden regression tests;
- explain an architecture path and cite exact source;
- detect a stale-index scenario after a source edit; and
- make one negative claim where a skipped file invalidates graph completeness.

Include both graph-friendly and graph-irrelevant tasks. Otherwise the evaluation only proves the selected task needed a graph.

### Measures

Record separately:

- accepted patch or answer;
- localization recall and precision against source-grounded expected files;
- worker-produced proof quality;
- human steering and review time;
- wall time and index build/update time;
- model tokens, tool calls, and context bytes;
- false-positive and false-negative graph edges that affected decisions;
- stale or incomplete-index recovery;
- carrying cost and security surface; and
- results after an ablation without the graph.

Published project benchmarks can set hypotheses. They are not substitutes for this Jouzu trial.

## Experiment safety

Repository indexers are code-processing systems with meaningful authority and supply-chain surface.

For evaluation:

- pin an exact source or verified binary revision;
- use an isolated home, cache, and agent configuration;
- do not run `curl | shell` installers;
- disable automatic edits to `AGENTS.md`, skills, hooks, and global MCP configuration;
- restrict indexing and queries to one canonical repository root;
- expose read-only operations only;
- do not execute package scripts, builds, or compiler plugins unless the SCIP/build condition explicitly requires and authorizes them;
- treat native parser grammars and graph backends as untrusted dependencies;
- keep private code and graph results inside the same model/provider policy boundary as direct source reads;
- preserve full query output outside context when returning a bounded summary; and
- remove the service, cache, credentials, and configuration after the trial.

Cross-repository graphs require the intersection of access policies, not the union. A worker permitted to read one repository must not infer private symbols or service contracts from another repository through graph edges or error messages.

## Staged recommendation

### Stage 0 — improve repository routes first

- Create a short root map for Jouzu's architecture and checks.
- Keep source and design documents current and cross-linked.
- Measure actual grep/read failures before adding a graph.

### Stage 1 — map without a graph database

- Build or integrate a Tree-sitter symbol/tag extractor for Jouzu's TypeScript and Python packages.
- Add manifest/import edges and task-aware ranking.
- Return a bounded map on demand with source paths and a repository revision.
- Compare injection with tool-based retrieval for context and cache effects.

### Stage 2 — external structural provider trial

- Run Codebase-Memory MCP and CodeGraphContext as isolated read-only CLI providers.
- Prefer SCIP-backed output where the target environment can produce it.
- Normalize results into the small provider envelope instead of exposing each vendor's entire schema.
- Evaluate fresh runs under one worker epoch and retain at most one provider provisionally.

### Stage 3 — confidence and runtime evidence

- Add explicit coverage, confidence, and derivation to every accepted structural result.
- Optionally reconcile selected call/route edges with runtime traces.
- Require direct source and target-native proof before consequential edits or negative claims.

### Stage 4 — temporal memory only if a recurring need is proven

- Identify repeated decisions, bug histories, or ownership facts that source search fails to retrieve.
- Start with versioned Markdown or small structured claim files and source refs.
- Compare that baseline with an external Potpie or Graphiti spike.
- Add proposal, review, supersession, expiry, and authoritative refresh before automatic ingestion.

## Reconsideration gates

A structural graph may become a default Jouzu capability only when:

- repeated fixed-worker evaluations improve accepted outcomes or human attention;
- supported languages and semantic/build profiles cover Jouzu's actual repositories;
- index revision, coverage, confidence, and truncation are visible to the model;
- stale-index behavior fails safely;
- the result can be verified against source and native checks;
- installation does not mutate unrelated global agent state;
- license and supply-chain review permit distribution; and
- the component's latency, context, and maintenance cost remain lower than its measured value.

A temporal memory graph may become a Jouzu-owned service only when:

- a cheaper repository or Markdown projection has failed on representative work;
- sources, ontology, truth classes, retention, and deletion owners are explicit;
- candidate facts cannot publish themselves;
- contradictory and superseded facts remain explainable;
- retrieval is evaluated in fresh sessions and tied to task outcomes; and
- the service can be retired or rebuilt without becoming the only copy of authoritative truth.

## Primary sources

- [Aider repository map](https://aider.chat/docs/repomap.html)
- [RepoGraph paper](https://arxiv.org/abs/2410.14684) and [implementation](https://github.com/ozyyshr/RepoGraph)
- [LocAgent paper](https://arxiv.org/abs/2503.09089) and [implementation](https://github.com/gersteinlab/LocAgent)
- [SCIP Code Intelligence Protocol](https://github.com/scip-code/scip)
- [`GitNexus` snapshot](https://github.com/abhigyanpatwari/GitNexus/tree/fe3d7e56be5a557e051f12684dfbdce9d5a31920)
- [`codebase-memory-mcp` snapshot](https://github.com/DeusData/codebase-memory-mcp/tree/49d928be67322184fe25c8d15acd6f0e80b7e648) and [preprint](https://arxiv.org/abs/2603.27277)
- [`CodeGraphContext` snapshot](https://github.com/CodeGraphContext/CodeGraphContext/tree/810ea8a9f04fddb2b298b61d752a5e619e19245a)
- [`Graphiti` snapshot](https://github.com/getzep/graphiti/tree/a3596b8bc1bdf95dc690368c2dfa0a38e8e8e07c) and [Zep/Graphiti paper](https://arxiv.org/abs/2501.13956)
- [`Potpie` snapshot](https://github.com/potpie-ai/potpie/tree/a341978880b9d4c1b403831931279ccedf6184ae)
