# Jouzu Agent Control Plane

- **Status:** Draft design
- **Scope:** Cross-host agent observation, normalized state, remote control operations, terminal attachment, host daemon, transport, and harness adapters
- **Related:** [Model Catalog](MODEL-CATALOG.md), [Usage Tracking and Cost Accounting](USAGE-TRACKING.md), [Recomposition and Controlled Evolution](COMPOSITION.md), [Harness Engineering and Jouzu](HARNESS-ENGINEERING.md), [DeepSeek Harness and Jouzu](DEEPSEEK-HARNESS.md), [research note](research/CONTROL-PLANE.md), [Delegation and Adversarial Review](DELEGATION-AND-REVIEW.md)

## Summary

An operator running many agents across many machines has one recurring question: **which agent benefits most from my attention right now?** Every existing tool in this space answers it by reconstructing agent state from the outside — screen scraping, process trees, transcript tailing, inactivity timers — because Claude Code, Codex, and stock Pi do not expose one lifecycle contract.

Jouzu does not have that problem. Jouzu is the harness. It can report exact lifecycle state, model, context usage, pending decisions, and cost from inside the agent loop, and it can accept commands back through the same seam.

This document specifies that seam as three separable planes:

- an **observation plane** that publishes normalized, provenance-tagged agent state;
- a **control plane** that accepts authenticated, attributed, audited commands; and
- an **attachment plane** that hands a human a real terminal without proxying it.

and three components:

- a **session reporter** — a Jouzu extension inside each agent session, the only component with ground truth;
- **`jouzud`** — one small per-host daemon that indexes runtimes and terminates the remote protocol; and
- **clients** — CLI, TUI, MCP, or web, none of which own an agent.

The design's load-bearing constraints are that observed state is an observation with an expiry rather than a fact, that a remote command is an authority-bearing act that must be attributed and recorded in the session itself, and that the control plane never becomes a terminal multiplexer. Federation is client-initiated over SSH so that no worker host holds credentials for any other host.

## Decision

Jouzu should build the **protocol and the host daemon**, not a terminal UI, as its first control-plane deliverable.

The scarce asset is exact agent state and safe remote actuation. Terminal session managers are abundant, actively developed, and mutually incompatible; several already have good local UX and would consume a trustworthy state feed if one existed. Jouzu should therefore:

1. define one versioned observation and control contract;
2. implement it natively in the Jouzu session reporter;
3. ship `jouzud` with a local Unix socket and an SSH-invoked stdio transport;
4. ship a minimal `jouzu fleet` CLI as the reference client and the integration test surface;
5. offer a Jouzu adapter to an existing local TUI rather than writing one immediately; and
6. build a Jouzu fleet TUI only when real use demonstrates something the adapter cannot express — most likely catalog, cost, quota, and cospa surfaces.

Jouzu should **not** build a scheduler, work queue, or autonomous dispatcher as part of this work. That ordering is the same one [Harness Engineering and Jouzu](HARNESS-ENGINEERING.md) applies to orchestration generally: observation and inspectability first, actuation second, routing and scheduling only after the first two are trustworthy.

Jouzu should not fork any surveyed project. The [research note](research/CONTROL-PLANE.md) compares the current field; its adoption figures and repository characterizations are conversational research and should be re-verified before any dependency decision. Its architectural conclusion — that the multi-host, harness-native layer is the actual gap — survives review.

## Goals

1. Answer "which agent needs me, and why" across every host in a fleet, ranked by attention rather than by name.
2. Report exact Jouzu/Pi lifecycle state, model, thinking level, context usage, current activity, and pending decisions from inside the agent, not from the screen.
3. Preserve the provenance, confidence, and freshness of every reported field, and degrade to `unknown` rather than to a plausible guess.
4. Give a human a real terminal on the target agent in one keystroke, without the control plane owning, proxying, or re-rendering that terminal.
5. Support remote reply, steer, abort, rename, model change, compaction, and decision resolution as explicit, attributed, audited operations.
6. Work identically for one local host and for many remote hosts, over ordinary SSH, with no new listening ports and no central server.
7. Support heterogeneous fleets: Jouzu sessions are first class, stock Pi, Claude Code, Codex, and unknown processes degrade gracefully and are labeled as degraded.
8. Survive process death, daemon restart, session fork, session resume, host reboot, and network partition without losing the identity of a unit of work.
9. Surface fleet-wide cost, quota, and model information from the catalog and usage ledger so the dashboard is an optimization surface, not only a monitor.
10. Keep prompts, outputs, and credentials on the host that produced them unless a human explicitly requests otherwise.

## Non-goals

- Becoming a terminal multiplexer, a PTY server, or a replacement for tmux, byobu, zellij, or an equivalent runtime.
- Requiring agents to be launched through Jouzu in order to be visible.
- A hosted service, a central broker, or any fleet-wide component that must be running for local work to continue.
- Task scheduling, work queues, budget-driven dispatch, or automatic cross-host placement in the first releases.
- Guaranteeing agent state for harnesses that expose none; heuristic adapters are explicitly labeled and are never presented as exact.
- Defending against a compromised agent on the same host under the same user account; see [Trust model](#trust-model).
- Reimplementing usage, cost, quota, or catalog logic. This design consumes [Usage Tracking and Cost Accounting](USAGE-TRACKING.md) and [Model Catalog](MODEL-CATALOG.md); it does not duplicate them.
- Aggregating prompts or transcripts into a durable central store.

## Design principles

### Observe and command; never own the terminal

The control plane knows where a terminal is and how to reach it. It does not host it. An agent whose multiplexer, host, or terminal runtime changes must remain the same agent to the control plane, with only its attachment descriptor replaced. This is what makes the design survivable across the tmux/zellij/PTY-runtime question instead of betting on it.

### Ground truth comes from the harness, not the screen

The preferred signal is an event emitted by the code that made the state change. Everything else is reconstruction. Reconstruction is supported, but it is a lower tier and is labeled as such at every layer, including the UI.

### A state is an observation with an expiry

"Working" is not a fact about the world; it is a claim that was true at a point in time, from a source, with a confidence, and with a horizon beyond which it should not be believed. Every state carries `observedAt`, `source`, `confidence`, and `staleAfter`. When the horizon passes without renewal, the state becomes `unknown`. It never decays into `idle`, `done`, or `error`, because silence is not evidence for any of those.

### Execution state and attention are orthogonal

What an agent is doing and what it needs from a human are different questions. An agent can be working and also need a decision; an agent can be idle and need nothing, or idle and holding an unread question. Collapsing these into one enum is why generic dashboards sort badly. Jouzu models them separately and sorts on attention.

### Control is an authority-bearing act

A remote message injected into a live agent can cause tool execution, file writes, shell commands, and spend. It is therefore authenticated to a principal, recorded durably in the session it affected, shown in the local UI, rate-limited, and constrained by a per-workspace control policy. Remote control is off by default and enabled per host.

### Identity is layered and outlives processes

A unit of work, a session file, a process incarnation, and a pane are four different things with four different lifetimes. Conflating them means an agent disappears from the dashboard when it is forked, resumed, or restarted, which is exactly when the operator most wants continuity.

### Heterogeneity from the first release

If a fleet is thirty percent Jouzu and seventy percent something else, the operator must not need two dashboards. The adapter boundary exists in the first implementation even if only two adapters ship, because retrofitting a native-only protocol to foreign harnesses is what forces the schema mistakes.

### Reuse SSH; do not invent a network security model

SSH already solves authentication, encryption, host identity, jump hosts, and routing, and every host in scope already runs it. A new authenticated TCP listener on five developer machines is a new attack surface that buys latency, not capability. Direct transports remain possible later behind an explicit opt-in.

## Architecture

### Planes

```text
  observation plane          control plane            attachment plane
  ─────────────────          ─────────────            ────────────────
  normalized state           authenticated            terminal target
  + provenance               commands                 descriptor
  + freshness                + attribution            (resolved at
  + attention                + audit entry             attach time)
        │                          │                        │
        └──────────┬───────────────┘                        │
                   │                                        │
              jouzud (per host)                             │
                   │                                        │
        ┌──────────┴───────────┐                            │
   session reporter      foreign adapter                    │
   (Jouzu extension)     (hooks/transcript/process)         │
                                                            │
   client ─────────────────────────────────────────────────►┘
                                          ssh -t + mux attach
```

The attachment plane deliberately bypasses `jouzud` at use time. The daemon supplies the descriptor; the client makes the connection. Nothing streams a PTY through the control protocol.

### Components

```text
                        fleet client (CLI / TUI / MCP / web)
                                      │
                     client-initiated SSH, one channel per host
                ┌─────────────────────┼─────────────────────┐
                │                     │                     │
             jouzud                jouzud                jouzud
             halo-1                gpu-2                 devbox
                │                     │                     │
        ┌───────┴────────┐            │              ┌──────┴──────┐
   reporter  reporter  adapter     reporter       reporter     adapter
   (jouzu)   (jouzu)   (codex)     (jouzu)        (jouzu)      (claude)
      │         │                     │                │
   tmux pane  tmux pane           herdr pane       plain PTY
```

**Session reporter.** A Jouzu extension loaded into every Jouzu session. It is the only component that observes state rather than inferring it, and the only component that can execute session-scoped commands. It holds no fleet credentials and knows nothing about other hosts.

**`jouzud`.** One per host, per user. It indexes local runtimes, merges observations, applies staleness rules, resolves attachment descriptors, routes commands to reporters, and terminates the remote protocol. It is intentionally small: no scheduling, no model logic, no cost math beyond forwarding what the usage ledger already computed.

**Clients.** Anything that speaks the protocol. Clients fan out to hosts, merge, sort, and render. They may hold SSH configuration and control credentials; daemons may not.

### Where this sits in the Jouzu authority model

[Recomposition and Controlled Evolution](COMPOSITION.md) separates a policy/shared plane from a session plane, and states the test directly: a capability that must inspect many sessions, guard credentials, enforce policy, or preserve durable accounting does not belong to a per-session profile.

The control plane meets every clause of that test. It is therefore a **policy-plane service**:

- it is not composable per session, and a session profile cannot enable, disable, or widen it;
- a session-plane composition may *be observed by* it and may *receive* commands from it, but cannot grant itself new control authority;
- its authority ceiling is set by host configuration and organization policy, above the user profile layer; and
- its audit records are durable and are not owned by the session that produced them.

The session reporter is the one piece that lives inside the session plane. It is deliberately a thin publisher and executor with no policy of its own, so that a hostile or misconfigured session composition cannot escalate through it.

The reporter must also honor the extension lifecycle invariant in [Recomposition and Controlled Evolution](COMPOSITION.md): its socket, watchers, timers, and marker files are acquired in an owned effect scope, disposed in reverse order, idempotent on disposal, and quiesced during `session_shutdown` for `reload`, `new`, `resume`, `fork`, and `quit`. A reporter that leaks a socket across `/new` produces exactly the phantom-agent bug this design exists to avoid.

## Identity model

### Four identities

| Identity | Lifetime | Stability | Example meaning |
| --- | --- | --- | --- |
| `workspaceId` | The unit of work | Durable across forks, resumes, restarts, and host moves | "fix gfx1151 queue corruption" |
| `sessionId` | One Pi session file | New on `/new`, `/fork`, `/clone`; preserved on `/tree` and `/resume` | one JSONL session tree |
| `runtimeId` | One process incarnation | New on every process start | this `pi` process |
| `attachment` | One terminal location | Re-resolved at every attach | `halo-1` → tmux socket → session → window → pane |

The dashboard's primary row is a **workspace**. Everything else is a property of the workspace's current runtime and may change without the row changing.

### Runtime identity

A PID alone is not an identity, because PIDs are recycled and daemons restart. A runtime is identified by the tuple:

```text
(hostId, bootId, pid, processStartTime)
```

`hostId` is a stable per-host UUID generated on first `jouzud` start and persisted; it is not the hostname, which changes. `bootId` distinguishes incarnations of the host itself. `processStartTime` disambiguates PID reuse within one boot. A daemon that finds a marker file whose tuple no longer matches a live process treats that runtime as gone, never as idle.

### Session lineage and workspace continuity

Pi's `session_start` event carries `reason` (`startup`, `reload`, `new`, `resume`, `fork`) and, for `new`, `resume`, and `fork`, a `previousSessionFile`. The reporter uses this to maintain lineage:

- `reload` — same workspace, same session, new reporter instance.
- `resume` — same workspace if the resumed session already carries a workspace binding; otherwise the workspace is adopted from the session.
- `fork` and `clone` — **new** workspace by default, with a recorded `forkedFrom` edge. A fork is normally a divergent line of work and should be a separate dashboard row; suppressing it hides exactly the parallel exploration the operator wanted to see.
- `new` — new workspace.
- `/tree` navigation — same workspace and same session. Branch position is a property, not an identity.

The workspace binding is persisted **inside the session** via an appended entry (Pi's `pi.appendEntry` with a Jouzu custom type), not only in daemon state. This is what makes a workspace survive a daemon restart, a host reboot, or a session file being resumed on a different machine, and it makes the binding inspectable with the same tooling as the rest of the session.

A workspace also carries user-facing metadata that no harness owns: display name, project, task description, tags, and priority. These are set by the operator and stored in daemon-local state keyed by `workspaceId`, so renaming a tmux session or a Pi session never loses them.

### Attachment descriptor

An attachment is a resolution recipe, never a cached coordinate:

```yaml
attachment:
  hostId: 6f1c...            # stable host identity
  hostAlias: halo-1          # SSH-resolvable name, client-side config wins
  kind: tmux                 # tmux | screen | zellij | pty | none | unknown
  server: default            # tmux -L / -S socket, when not default
  target:
    session: amdtop
    window: "1"
    pane: "0"
  resolvedAt: 2026-08-17T10:37:22+09:00
  confidence: exact
```

byobu is not a distinct kind. byobu selects a tmux or GNU Screen backend, and a tmux-backed byobu ordinarily shares tmux's default server, so it is discovered as `tmux`. Hosts whose sessions run on a non-default socket must record `server`; a discovery layer that only calls the default server will silently miss them.

`target` is re-resolved before every attach. Pane indices are unstable under window movement, so a stale descriptor is a wrong-window bug, not a missing-window bug — the worse failure. When re-resolution fails, the client attaches to the nearest surviving ancestor (window, then session) and says so, rather than attaching to whatever now occupies the recorded coordinates.

## Observation model

### Observation record

```ts
interface AgentObservation {
  workspaceId: string;
  sessionId?: string;
  runtimeId: RuntimeId;

  host: { id: string; alias?: string; };
  attachment?: Attachment;

  harness: {
    id: "jouzu" | "pi" | "claude-code" | "codex" | string;
    version?: string;
    tier: SignalTier;              // best tier this adapter can achieve
  };

  execution: {
    state: ExecutionState;
    detail?: ExecutionDetail;      // thinking | streaming | tool | compacting | retrying | delegating
    activity?: { kind: string; label: string };
    delegates?: { running: number; total: number };
    since: string;                 // transition time, not observation time
    observedAt: string;
    staleAfter: string;
    source: SignalTier;
    confidence: "exact" | "strong" | "weak";
  };

  attention?: {
    reason: AttentionReason;
    since: string;
    decisionId?: string;           // resolvable pending decision, if any
    summary?: string;              // redacted, bounded
  };

  model?: {
    offeringId?: string;           // Model Catalog identity
    providerId: string;
    modelId: string;
    thinkingLevel?: string;
    source: SignalTier;
  };

  context?: { tokens: number; max?: number; source: SignalTier };

  usage?: {                        // forwarded from the usage ledger, never recomputed
    sessionCost?: MoneyOrUnknown;
    valueBasis: "reported" | "estimated" | "equivalent" | "unknown";
    quotaHeadroom?: QuotaSummary;
  };

  project?: { cwd: string; repo?: string; branch?: string; worktree?: string; dirty?: boolean };

  labels?: { name?: string; task?: string; tags?: string[] };
}
```

Every optional field is genuinely optional. An adapter that cannot determine the model omits `model` rather than reporting a guessed one; the client renders an explicit unknown. This is the same tri-state discipline the [Model Catalog](MODEL-CATALOG.md) applies to policy metadata, applied to runtime facts.

Cost and quota fields are **forwarded projections** owned by [Usage Tracking and Cost Accounting](USAGE-TRACKING.md), carrying that document's `valueBasis` labeling. The control plane never sums, estimates, or relabels them, and a fleet total is a sum of like-labeled values only — a fleet view must not add an estimated metered charge to a subscription-equivalent value and print one number.

### Signal tiers

```text
tier 1  native      harness event emitted by the code that changed the state
tier 2  hook        harness-provided callback (Claude Code hooks, Codex notify)
tier 3  structured  transcript, session file, or structured log, tailed
tier 4  process     process tree, mux metadata, pane current command
tier 5  terminal    title and screen-content patterns
tier 6  inactivity  no output for N seconds
```

Merge rule: **a lower tier never overwrites a fresher-or-equal higher tier.** A tier-5 spinner match does not overrule a tier-1 `agent_settled`. Where a lower tier contradicts a live higher tier, the disagreement is recorded and surfaced in diagnostics rather than resolved silently, because a persistent contradiction usually means a stuck reporter.

Tier 6 may never, on its own, produce any state other than `unknown`. Inactivity is the single largest source of wrong "done" indications in every screen-scraping tool, and it is not evidence.

### Execution state

```text
starting   process is up, session not yet ready
working    an agent run is active
blocked    an agent run is suspended awaiting a decision
idle       settled; nothing will continue automatically
exited     proven gone (clean shutdown or dead runtime tuple)
unknown    no fresh observation
```

`error` is deliberately not an execution state. An error is an attention reason attached to `idle` or `exited`; making it a state forces a choice between "failed" and "failed and then retried successfully," and Pi retries automatically.

### Attention

```text
decision_required   a pending decision is open and resolvable
question            the agent asked the operator something and settled
error               the run ended in a failure the operator has not seen
review_ready        settled with output the operator has not attended
none
```

Default fleet ordering is by attention class, then by time in that class, oldest first: `decision_required`, `error`, `question`, `review_ready`, then working agents by activity recency, then idle, then unknown. Alphabetical ordering is never the default. `unknown` sorts low but is never hidden, because a silently vanished agent is itself a thing the operator needs to see.

`review_ready` requires read state. The daemon tracks `lastAttendedAt` per workspace, updated on attach or on an explicit mark-read command, and it is per user rather than per client so that clearing an item on a phone clears it on a laptop.

### Delegation

A workspace that has fanned out to subagents reports `working` with detail `delegating` and a running/total child count, per [Delegation and Adversarial Review](DELEGATION-AND-REVIEW.md). Two rules follow.

A parent with running delegates is never `idle` and never carries `review_ready`. A delegating parent is quiet on its own account — no assistant output, no tool calls of its own — which is precisely the shape that inactivity heuristics misread as finished. This is the same class of error as treating `agent_end` as completion, and it is why child counts belong in the observation rather than in a client's rendering.

Delegate cost rolls up to the parent workspace for fleet display while retaining per-delegate attribution in the ledger. The roll-up is a derived projection and obeys the labeling rules in [Cost, quota, and cospa](#catalog-usage-and-cospa-integration): a fleet total still sums only like-labeled values, and a delegate whose usage is unattributed contributes `unknown`, not zero.

### Deriving state from Pi events

The reporter maps Pi's extension events directly:

| Pi signal | Execution | Notes |
| --- | --- | --- |
| `session_start` | `starting` → `idle` | Establishes workspace binding and lineage |
| `before_agent_start` | `working` | Earliest reliable start; precedes `agent_start` |
| `agent_start` | `working` | |
| `turn_start`, `message_update` | `working` (`streaming`/`thinking`) | Activity label refresh |
| `tool_execution_start` / `_end` | `working` (`tool`) | Activity is the tool and a bounded label |
| Jouzu delegate invocation open | `working` (`delegating`) | Carries running/total child count |
| Jouzu decision gate opened | `blocked` | Sets `attention: decision_required` |
| `session_before_compact`, `session_compact` | `working` (`compacting`) | |
| `agent_end` with `willRetry` | `working` (`retrying`) | |
| `agent_end` without retry | unchanged | **Not** a completion signal |
| `agent_settled` | `idle` | The only correct "will not continue" signal |
| `model_select`, `thinking_level_select` | unchanged | Updates `model` |
| `session_info_changed` | unchanged | Updates `labels.name` |
| `session_shutdown` | `exited` | Clean exit; distinguishable from death |

The `agent_end` versus `agent_settled` distinction is the single most important correctness detail in this document. `agent_end` fires when one low-level agent run completes, but Pi may still auto-retry, auto-compact and retry, or continue with queued follow-up messages. A dashboard that treats `agent_end` as completion will repeatedly tell an operator that an agent is done while it is still burning tokens, which is worse than not reporting at all. Pi documents `agent_settled` as the signal for status integrations; Jouzu uses it and nothing else for `idle`.

Context usage comes from `ctx.getContextUsage()`, model and thinking level from `ctx.model` / `ctx.thinkingLevel`, idleness cross-checks from `ctx.isIdle()`, and session identity from `ctx.sessionManager`. None of these require an upstream Pi change.

### Heartbeat and staleness

The reporter emits a heartbeat on a bounded interval in addition to event-driven updates, carrying the current state and a renewed `staleAfter`. Long tool executions are the reason: a five-minute test run produces one `tool_execution_start` and then nothing, and without a heartbeat the state expires mid-run.

Staleness is graded:

1. within `staleAfter` — believed;
2. past `staleAfter`, runtime tuple still live — `unknown`, flagged as stalled, previous state retained for display as history;
3. runtime tuple dead without `session_shutdown` — `exited`, flagged as an unclean exit; and
4. host unreachable — every workspace on that host becomes `unknown` with a host-level reason, and none of them becomes `exited`. A network partition must never be rendered as a fleet of dead agents.

## Control model

### Operation classes

| Operation | Scope | Mechanism | Availability |
| --- | --- | --- | --- |
| `snapshot`, `subscribe` | host | daemon | always |
| `reply` (enqueue user message) | session | `pi.sendUserMessage` | Jouzu native |
| `steer` (interrupt with message) | session | queue/steering semantics | Jouzu native, mode-dependent |
| `abort` | session | `ctx.abort()` | Jouzu native |
| `resolve_decision` | session | Jouzu decision gate | Jouzu gates only |
| `set_model` | session | `pi.setModel` | Jouzu native, warning-gated |
| `set_thinking_level` | session | `pi.setThinkingLevel` | Jouzu native |
| `compact` | session | `ctx.compact()` | Jouzu native |
| `rename` | session | `pi.setSessionName` | Jouzu native |
| `mark_read` | host | daemon state | always |
| `stop` (graceful) | session | `ctx.shutdown()` | Jouzu native |
| `spawn` | host | daemon launches into a mux | host, later phase |
| `kill` | host | signal to runtime | host, last resort |
| `attach` | client | descriptor + `ssh -t` | always |
| answer a foreign harness's dialog | — | none | requires attach |

Three properties of this table matter.

First, **session-scoped operations run through the reporter, not through keystroke injection.** Sending synthetic keys into a pane is how existing tools implement remote reply; it is unsafe against a TUI that is redrawing, ambiguous under bracketed paste and extended-key handling, and unattributable. Jouzu has an in-process path and should use it.

Second, **`spawn` belongs to the daemon, not the reporter.** Creating an agent is a host operation: it needs a working directory, a multiplexer, an environment, and credentials, none of which any existing session should be able to confer.

Third, **some things genuinely require a human at a terminal**, and the design says so rather than faking them. A foreign harness's native approval dialog cannot be answered remotely. The correct client behavior is to offer attachment, not to simulate a keypress.

### Decision gates

Pi has no built-in permission gates. Approval flows are implemented by extensions, typically as `tool_call` plus `ctx.ui.confirm`. This is fortunate: because Jouzu owns its approval gate, Jouzu can make it remotely resolvable by construction instead of asking upstream for a hook.

The constraint is that the gate must not be a bare `ctx.ui.confirm` call. It must be a **pending decision object** that either the local UI or the control plane can resolve:

```yaml
decision:
  id: dc_01J...
  workspaceId: ws_...
  kind: tool_permission        # tool_permission | plan_approval | question | choice
  prompt: "Run: rm -rf dist/"
  options: [allow, allow_always, deny]
  default: deny
  timeout: 600s
  raisedAt: ...
  raisedBy: { tool: bash, callId: ... }
```

Resolution is single-assignment and idempotent: the first resolution wins, later resolutions for the same `decisionId` return the recorded outcome rather than re-applying. This is what makes a flaky network safe — a client that retries a resolve after a dropped connection cannot approve twice.

Timeouts resolve to `default`, which is the restrictive option. A dropped control channel must never widen authority.

Pi's RPC mode already implements exactly this shape for extension dialogs: `extension_ui_request` with an ID and an optional timeout, `extension_ui_response` with the matching ID, and agent-side auto-resolution on expiry. The Jouzu gate should mirror that contract deliberately, so that the TUI path, the RPC path, and the control-plane path present one decision model rather than three.

### Authority and attribution

Every control operation carries a principal and produces a durable record. Concretely:

1. The operation is authenticated at the transport boundary (SSH identity) and, when a host enables finer granularity, to a named control principal.
2. Before it takes effect, the reporter appends a Jouzu entry to the session recording the operation, principal, client, and time. Remote actuation is therefore visible in the same session tree as everything else, replayable, and exportable.
3. The local TUI is notified. There is no silent remote drive of an attended session.
4. The operation is rate-limited and size-limited per principal per workspace.
5. A per-workspace control policy applies: `observe-only` (default), `reply` (messages and decisions), or `full` (adds model, compaction, lifecycle).

Remote-originated text is user-role content, quoted and bounded. It is never merged into a system prompt, never used to modify composition, and never granted authority beyond the session's existing ceiling. A remote `reply` cannot change the approval policy that governs the tools that reply might invoke; that separation is what keeps a single compromised control credential from converting an observation channel into arbitrary code execution with widened permissions.

### Correlation and idempotency

Every command carries a client-generated `commandId`. The daemon records outcomes for a bounded window and replays them on repeat. Commands are not queued indefinitely: a command that cannot be delivered to a live reporter within its deadline fails explicitly rather than arriving after the agent has moved on. A `reply` delivered ten minutes late to an agent that has since settled and been redirected is a correctness problem, not a convenience.

## Host daemon

### Responsibilities

`jouzud` indexes local runtimes; merges observations across adapters with the tier rules; applies staleness; maintains workspace metadata, lineage, and read state; resolves attachment descriptors; routes and audits commands; and terminates the remote protocol. Later, it spawns runtimes.

It does not: render UI, hold credentials for other hosts, compute cost, decide model policy, or make scheduling decisions.

### Discovery

Registration first, scanning second.

**Registration.** A Jouzu reporter connects to the daemon's Unix socket at session start and streams observations. It simultaneously writes an atomic marker file under the Jouzu state directory containing its runtime tuple, session file, cwd, and last known state. The marker is what lets a daemon started *after* the agents rebuild the fleet immediately, and what lets a daemon restart without a gap. Markers are written atomically and are self-invalidating through the runtime tuple.

**Scanning.** A discovery adapter enumerates multiplexer panes and process trees to find agents that did not register — foreign harnesses, stock Pi, and Jouzu sessions whose reporter failed. Scanned entries are always lower-tier and are labeled as such. Scanning is pane-level, not session-level: one tmux session may hold several agents, and a session-level abstraction that reports only the active pane will systematically lose the others.

Multiplexer enumeration must cover non-default sockets. A discovery layer that only queries the default tmux server is correct for most setups and silently wrong for the rest.

### Durability

Across a daemon restart, the following survive: workspace identity and metadata (persisted, and mirrored into session entries), lineage edges, read state, and the audit log. The following do not and are rebuilt: live execution state, activity labels, and attachment resolution. Rebuilt state starts as `unknown` and is replaced by the first heartbeat, rather than being restored from the last known value — restoring stale state on restart is how a dashboard confidently displays a month-old "working."

Prompts and outputs are never part of durable daemon state. Preview content lives in a bounded in-memory ring buffer and is lost on restart by design.

### Local socket

The socket lives in the user's runtime directory with `0700` ownership. This prevents access by other users on a shared host. It does not, and cannot, prevent access by other processes belonging to the same user, including agents; see [Trust model](#trust-model).

## Transport and federation

### SSH-first

The remote protocol is the same JSONL protocol as the local socket, carried over a process invoked through SSH:

```bash
ssh halo-1 jouzu control serve --stdio
```

This yields authentication, encryption, host key verification, jump hosts, and existing per-host configuration for free, with no new listening ports. Clients should use connection multiplexing so that fan-out across many hosts costs one handshake each:

```sshconfig
Host *
    ControlMaster auto
    ControlPersist 10m
    ControlPath ~/.ssh/cm-%C
```

A direct authenticated listener may be added later for environments where SSH is not available, behind explicit configuration. It is not the default and is not required by any first-phase feature.

### Federation is client-initiated

Clients connect outward to hosts. Hosts never connect to each other and never connect to clients. This is a security property, not a stylistic one: a worker host holds no credentials for any other host, so compromising a build machine yields no lateral path to the rest of the fleet. Every mesh or push-based design gives that property up.

The consequence is that fleet state exists only in clients. There is no fleet-wide source of truth to keep consistent, no leader election, and no split brain — the strongest simplification available in this design.

### Stream semantics

A connection opens with a capability handshake carrying protocol version, daemon version, adapter tiers available, and enabled control policy. The client then receives one full snapshot followed by deltas:

```json
{"op":"snapshot","generation":7,"seq":0,"workspaces":[...]}
{"op":"update","generation":7,"seq":1,"workspaceId":"ws_...","execution":{...}}
{"op":"remove","generation":7,"seq":2,"workspaceId":"ws_..."}
```

`generation` increments when the daemon restarts or loses continuity. On reconnect a client presents its last `(generation, seq)`; the daemon either resumes with deltas or, if it cannot, issues a new generation and a fresh snapshot. Clients discard prior state on a generation change. This is the entire consistency model, and it is sufficient because no client's state is authoritative for anything.

Version skew is expected across a fleet that updates one host at a time. Unknown fields are preserved and ignored; unknown operations are ignored with a diagnostic; a daemon older than a client's minimum supported version is shown as a degraded host rather than dropped.

### Attach

Attachment is a client action using the descriptor:

```bash
ssh -t halo-1 -- tmux -L default attach -t amdtop \; select-window -t 1 \; select-pane -t 0
```

Detach returns to the client. The client re-resolves before issuing the command and reports a mismatch rather than attaching blindly.

### Preview

Preview answers "can I resolve this without attaching," and it should be structured rather than visual wherever possible. For a Jouzu session the reporter can return the last assistant text, the open decision, and the current tool from session entries — accurate, redactable, and terminal-independent. Screen capture is the fallback for foreign harnesses.

Preview is opt-in per workspace, bounded in size, redacted by the same rules as the audit log, and never persisted centrally. Preview is the point at which prompts and model output would otherwise leak into a fleet-wide store, which is why it is the most restrictive surface in this design rather than the most convenient one.

## Harness adapters

### Adapter contract

An adapter declares the tier it can achieve, the fields it can populate, and the operations it can execute, and it never claims more than it delivers:

```ts
interface HarnessAdapter {
  id: string;
  capabilities(): { tier: SignalTier; fields: FieldSet; operations: OperationSet };
  discover(): Promise<RuntimeCandidate[]>;
  observe(runtime: RuntimeId): AsyncIterable<PartialObservation>;
  execute(runtime: RuntimeId, op: ControlOperation): Promise<ControlOutcome>;
}
```

Capability declarations drive the UI. An operation the adapter cannot perform is shown as unavailable with a reason, never as a control that silently does nothing.

### Adapter roster

**Jouzu (tier 1).** The reference adapter and the reason this design is worth building. Full lifecycle, model, context, decisions, activity, usage, and every session-scoped operation.

**Stock Pi (tier 1, if extension loading is permitted; otherwise tier 3).** The Jouzu reporter is an ordinary Pi extension and can be loaded into a stock Pi session as a user-level extension. Where that is not acceptable, Pi session JSONL files under the agent sessions directory are tailable and give a real tier-3 signal — the last entry types and timestamps give state transitions without any screen reading.

**Claude Code (tier 2).** Hooks provide lifecycle events, and the statusline interface exposes model and context information. No control operations beyond attach.

**Codex (tier 2/3).** Notification callbacks plus structured logs where available; otherwise process and transcript inspection.

**Generic (tier 4–6).** Process tree and multiplexer metadata identify that *something* is running; terminal patterns and inactivity are recorded but constrained as described in [Signal tiers](#signal-tiers).

**DeepSeek Harness (tier 3, later).** Its canonical append-only session log is a plausible observation source, with the same caveat [DeepSeek Harness and Jouzu](DEEPSEEK-HARNESS.md) applies to accounting: its outbound telemetry path is best-effort and must not be used as the state source.

## Catalog, usage, and cospa integration

This is the capability no general-purpose session manager can replicate, because it requires the catalog and the ledger that Jouzu already owns.

**Fleet economics.** Each observation forwards the usage ledger's labeled values. A fleet view can show per-workspace and aggregate spend, burn rate, and quota headroom — with the labeling discipline from [Usage Tracking and Cost Accounting](USAGE-TRACKING.md) preserved end to end. Unknown remains unknown; a subscription-equivalent value is never displayed as spend; totals sum only like-labeled values.

**Model switching with real consequences shown.** A model switch from the dashboard is the same operation as a local switch and inherits its warnings. Provider caches are normally scoped by provider, account, route, model, and cache key, so switching can resubmit and re-price the entire context and abandon a reusable cache. The control plane must present that estimate before the switch, and it must never batch-apply a switch across many workspaces without surfacing the aggregate cost of doing so. "Move the whole fleet to the cheap model" is precisely the action that document says must not be silent.

**Cospa surfaces.** With the [Model Catalog](MODEL-CATALOG.md) supplying offerings, capabilities, rate cards, and policy, and the ledger supplying measured behavior, the fleet client can rank candidate offerings by cost-performance for the work actually being done, subject to policy filtering. Two constraints carry over unchanged: policy is a hard filter that preference cannot cross, and a similar model is never a silent substitute for the current one.

**Routing and scheduling are later.** The progression is observe, control, route, schedule, orchestrate. Each step should be justified by evidence from the previous one. Nothing in this document commits Jouzu to the last two.

## Clients

The reference client is `jouzu fleet`: a CLI with `ls`, `show`, `watch`, `attach`, `reply`, `resolve`, and `--json` on everything. It is small, scriptable, and doubles as the protocol's integration test surface.

A TUI is deferred. The immediate move is to offer a Jouzu adapter to an existing local agent TUI so that Jouzu sessions gain exact state in a tool people already run, and to watch what operators reach for that such a tool cannot express. Two client behaviors are non-negotiable whenever a TUI does appear: attention ordering as specified above, and honest rendering of signal tier and staleness, so that a tier-6 guess never looks like a tier-1 fact.

Notification is a client concern. The daemon publishes attention transitions; deciding that `decision_required` should ring a phone is policy that belongs where the human is.

## Adopt, adapt, avoid

**Adopt.** Non-invasive discovery — agents are visible without being launched through Jouzu. Pane-level rather than session-level indexing. Attention-first ordering. Preview before attach. Marker-file registration for daemon-restart durability. SSH multiplexing for cheap fan-out. Structured capability handshakes between versions.

**Adapt.** Existing normalized status models are a reasonable starting vocabulary but collapse execution and attention; Jouzu separates them. Existing metadata models record values without recording where they came from; Jouzu requires provenance, confidence, and expiry on every field. Existing remote-input paths use keystroke injection; Jouzu routes through the harness and records the act in the session.

**Avoid.** Owning the terminal runtime. Central servers and push-based federation. Treating inactivity as completion. Treating `agent_end` as completion. Session-level abstractions that report only the active pane. Aggregating transcripts centrally. Forking a fast-moving upstream to add federation it has declared out of scope.

## Trust model

The honest statement, consistent with Pi's own security posture and with the guardrails in [DeepSeek Harness and Jouzu](DEEPSEEK-HARNESS.md):

**The control plane is not a security boundary against a compromised agent on the same host under the same user account.** Pi has no built-in sandbox; its built-in tools run with the permissions of the user, and so does the control socket. An agent that can run shell commands as that user can reach the local daemon socket regardless of file permissions. Anyone relying on isolation must obtain it from the operating system — container, VM, or micro-VM — exactly as Pi's containerization guidance describes.

What the design does provide:

1. **No lateral movement.** Client-initiated federation means a worker host stores no credential for any other host. Compromising one machine does not yield the fleet.
2. **Least authority by default.** Remote control is disabled until enabled per host; the default workspace policy is `observe-only`; decision timeouts resolve restrictively.
3. **Non-repudiation.** Every control operation is recorded in the affected session with principal and time, and mirrored to a host audit log.
4. **No silent action.** Remote actuation notifies the local UI.
5. **Containment of content.** Prompts and outputs stay on the originating host unless a human requests a preview; nothing is persisted centrally.
6. **No authority escalation through content.** Remote text is user-role content and cannot alter composition, policy, or approval ceilings.

Prompt injection through repository content remains expected local-agent risk that no control plane can prevent. What the control plane can do is ensure that an injected instruction cannot reach other machines, and that if an agent does something surprising, the record shows whether a human asked for it.

## Failure behavior

- Host unreachable: workspaces become `unknown` with a host-level reason; never `exited`; prior state retained as history.
- Daemon restart: new `generation`, fresh snapshot, live state rebuilt from heartbeats rather than restored.
- Reporter crash with a live process: the runtime is discovered by the scanning adapter at a lower tier and flagged as degraded, not dropped.
- Agent killed without shutdown: `exited`, flagged unclean, retained for a bounded period so the operator sees that it died.
- Control channel lost mid-command: the command either completed or did not; the client resolves it by replaying the same `commandId`.
- Decision timeout: resolves to the restrictive default and is recorded as a timeout, not as a human decision.
- Protocol version too old: host shown as degraded with its supported capabilities, not hidden.
- Clock skew between hosts: durations are computed from the reporting host's own monotonic deltas where possible; wall-clock timestamps carry the source host's offset so a skewed host does not appear to have been working for negative time.

## Testing strategy

1. **State machine conformance.** A recorded corpus of Pi event sequences — including retry, auto-compaction, queued follow-ups, fork, resume, `/tree` navigation, and abrupt kill — replayed against the reducer, asserting that `agent_end` never yields `idle` and that no path yields `idle` or `exited` from silence.
2. **Tier merge.** Property tests that a lower-tier observation never overwrites a fresher higher-tier one, across arbitrary interleavings.
3. **Identity durability.** Fork, resume, reload, daemon restart, host reboot, and PID reuse, asserting workspace continuity and correct lineage edges.
4. **Multiplexer integration.** Isolated tmux servers, non-default sockets, pane movement between windows, and byobu-backed sessions; attach must land on the correct pane or fail loudly.
5. **Federation.** Simulated latency, partition, mid-snapshot disconnect, generation change, and version skew; assert no phantom `exited` and correct resync.
6. **Control safety.** Idempotent decision resolution under retry and concurrent resolvers; timeout resolves restrictively; rate limits enforced; every executed operation produces a session entry and an audit record.
7. **Redaction.** Fuzzed session content asserting that credentials, secret environment values, and unrequested prompt text never appear in observations, previews, or audit records.
8. **Adapter honesty.** Every adapter's declared capabilities matched against its actual behavior; a declared-but-unimplemented operation is a test failure.

## Proposed implementation phases

### Phase 1: observation contract and local daemon

Versioned observation schema; Jouzu session reporter with the full Pi event mapping, heartbeats, and marker files; `jouzud` with local socket, staleness rules, and workspace identity; `jouzu fleet ls/show --json`. Local host only, read-only. Deliverable: exact local agent state with provenance.

### Phase 2: federation and attachment

SSH stdio transport, capability handshake, snapshot/delta stream with generations, host registry and health, attachment descriptor resolution, `jouzu fleet attach`, structured preview. Deliverable: one command answers "which agent needs me" across the fleet.

### Phase 3: control operations

Command envelope with principal, attribution, idempotency, and audit; decision gates as resolvable objects with restrictive timeouts; `reply`, `abort`, `resolve`, `rename`, `mark_read`; per-workspace control policy defaulting to `observe-only`. Deliverable: resolve most interruptions without attaching.

### Phase 4: catalog and usage integration

Forwarded labeled cost and quota; fleet economics view; `set_model` and `set_thinking_level` with cache-invalidation warnings and no silent batch application; cospa ranking from catalog and ledger data. Deliverable: the dashboard becomes an optimization surface.

### Phase 5: heterogeneous fleet and host operations

Claude Code and Codex adapters; generic process and multiplexer discovery; `spawn` and `kill` as host operations; a published protocol specification and an adapter offered to an existing local TUI. Deliverable: one dashboard for a mixed fleet.

Scheduling, budget-driven dispatch, and cross-host placement are explicitly out of scope for all five phases.

## Reconsideration gates

Revisit this design if any of the following becomes true:

1. Pi gains a first-party multi-session control surface that supersedes the reporter, in which case the reporter becomes a thin shim rather than the ground-truth source.
2. A credible common agent-management protocol reaches real adoption, in which case Jouzu should map onto it rather than maintain a parallel wire format; a mapping review against ACP-style contracts should precede freezing version 1.
3. Operators consistently want the fleet client to *start* work rather than triage it, which promotes scheduling from out-of-scope to a designed feature with its own document.
4. Structured preview proves insufficient in practice and screen capture becomes the primary preview path, which changes the privacy analysis materially.
5. SSH fan-out proves inadequate at the fleet sizes actually in use, which justifies reopening the direct-listener decision.
6. A control-plane operation is found to have widened an agent's effective authority, which invalidates the separation in [Authority and attribution](#authority-and-attribution) and blocks further control work until repaired.

## Open questions

1. Should `/fork` default to a new workspace, as specified here, or inherit the parent workspace with a branch marker?
2. What heartbeat interval and `staleAfter` horizon balance staleness against overhead during long tool executions?
3. Should the workspace binding live in the session file only, in daemon state only, or in both as specified?
4. Which control principal model is right: SSH identity alone, or named principals with per-workspace grants?
5. Should stock Pi support be delivered by loading the Jouzu reporter as a user extension, or by tailing session JSONL only?
6. What preview size limit and redaction rule set should be the default?
7. Should the fleet client hold SSH configuration itself, or delegate entirely to the user's `ssh_config`?
8. How should a workspace that legitimately migrates hosts — a repository moved to another machine — be represented?
9. Does the protocol need explicit capability negotiation for adapter tiers, or is a version number sufficient?
10. Which existing local TUI is the right first adapter target, and does its maintainer want the integration upstream or as a plugin?
11. Should `spawn` ever place work on a host automatically, or must every placement be explicit until scheduling is designed?
12. How should team or shared-host deployments prevent one user's workspaces from appearing in another user's fleet view?

## Required invariants

- Silence never produces `idle`, `done`, `error`, or `exited`; it produces `unknown`.
- `agent_end` is never treated as completion; only `agent_settled` yields `idle`.
- A workspace with running delegates is never `idle` and never carries `review_ready`.
- A lower-tier signal never overwrites a fresher-or-equal higher-tier signal.
- Every reported field carries its source tier, and the UI never renders a heuristic as exact.
- A host becoming unreachable never marks its agents dead.
- Daemon restart never restores stale execution state as current.
- A workspace survives session fork, resume, reload, process restart, and daemon restart.
- Attachment coordinates are re-resolved before use and never trusted from cache.
- Every control operation is authenticated, attributed, recorded in the affected session, and visible in the local UI.
- Decision resolution is single-assignment and idempotent; a lost channel never widens authority.
- A decision timeout resolves to the restrictive default and is recorded as a timeout.
- Remote-originated content is user-role content and can never alter composition, policy, or approval ceilings.
- A worker host never holds credentials for another host.
- Prompts, outputs, and credentials never enter durable daemon state or leave their originating host unrequested.
- Cost and quota values keep their ledger labeling end to end; unlike-labeled values are never summed.
- A model switch initiated from the fleet shows the same cache and cost consequences as a local switch, and is never applied silently in bulk.
- An adapter never advertises a capability it does not implement.

## Primary sources

- Pi extensions API, event lifecycle, and `ExtensionContext` — `docs/extensions.md` in `@earendil-works/pi-coding-agent` 0.83.0
- Pi RPC mode, command set, event stream, and extension UI sub-protocol — `docs/rpc.md`, ibid.
- Pi session storage, lineage, and tree semantics — `docs/sessions.md` and `docs/session-format.md`, ibid.
- Pi security posture, project trust, and absence of a built-in sandbox — `docs/security.md` and `docs/containerization.md`, ibid.
- [Field survey of existing agent session managers and control planes](research/CONTROL-PLANE.md) — conversational research; figures unverified
- [Model Catalog](MODEL-CATALOG.md), [Usage Tracking and Cost Accounting](USAGE-TRACKING.md), [Recomposition and Controlled Evolution](COMPOSITION.md), [Harness Engineering and Jouzu](HARNESS-ENGINEERING.md), [DeepSeek Harness and Jouzu](DEEPSEEK-HARNESS.md)
