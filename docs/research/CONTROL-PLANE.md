https://chatgpt.com/c/6a75373f-a8a8-83ee-b360-fd9e0a049e40

> I’m currently managing multiple agents (mostly pi, some Claude code and codex) via individual byobus, these run on 5+ different machines which I connect to via ssh. I’m interested in designing a single terminal interface that tracks these and lets me switch (could be tmux/byobu, zellij or some new TUI layer to track their name, current activity/status, harness, model etc and easily switch to them from a single app

Yes. This is increasingly a recognizable tool category, and a few projects are already close enough to your exact workflow that I would **study/fork rather than start from zero**.

The architecture I think fits best is:

```text
                         ┌─────────────────────────────┐
                         │        global TUI           │
                         │                             │
                         │  STATUS  NAME      HOST     │
                         │  ● run   amdtop     halo-1  │
                         │  ◐ wait  shisa-web  dev-2   │
                         │  ✓ done  eval-fix   gpu-4   │
                         │  ! ask   kernel     halo-2  │
                         │                             │
                         │ harness/model/repo/branch   │
                         └──────────────┬──────────────┘
                                        │
                      SSH / local RPC / status events
              ┌─────────────────────────┼───────────────────────┐
              ▼                         ▼                       ▼
         machine A                 machine B               machine C
       tmux/byobu                 tmux/byobu                zellij
       ├─ pi                     ├─ codex                  ├─ pi
       ├─ claude                 ├─ pi                     └─ claude
       └─ shell                  └─ claude
```

The important design decision is that **the TUI should own metadata and discovery, but not the terminal session itself**.

### Existing projects worth looking at first

The closest match I found is **Tmux Workbench**, which was posted literally last week by someone with almost your exact problem: local + SSH machines, Codex/Claude/etc., indexing tmux sessions, repo paths, branches, dirty state, agent type, instruction files, notes/tags, and a single searchable `ws` interface that jumps into the appropriate workspace. ([Reddit][1])

The most mature-looking “agent mission control” is **Agent Deck**. It is a Go TUI built on tmux with session status, search/groups, notifications, worktrees, Claude/Codex/OpenCode/etc., and direct session switching. It can even run everything on an isolated tmux socket so it doesn't mess with your normal tmux config. ([GitHub][2])

The philosophical match I like most for your existing setup is **ccmux**. Its author explicitly rejected tools that want to “own” your workflow. Instead, a daemon discovers coding-agent processes in **existing tmux panes**, and a picker/sidebar shows them without requiring you to launch them through ccmux. That's extremely close to what I'd recommend. ([Reddit][3])

And **tmux-agent-sidebar** is worth stealing ideas from. It monitors Claude Code, Codex and OpenCode panes across every tmux session/window and exposes prompts, tool calls, response previews, background shells, wait reasons, git/worktree state and subagent trees. ([GitHub][4])

There is also a smaller **tmux-agent-status** project that demonstrates an important implementation trick: Claude can be tracked precisely via hooks, whereas Codex has historically needed a hybrid of process inspection plus its `notify` callback. ([Reddit][5])

## What I'd build

I would make a small Rust or Go project—call the architecture something like **agentmux**, irrespective of the eventual name—with three pieces:

```text
agentmux
├── agentmux                 # global TUI/client
├── agentmuxd                # tiny optional daemon on each host
└── adapters/
    ├── pi
    ├── claude
    ├── codex
    ├── tmux
    ├── zellij
    └── process
```

The daemon is optional because you can get an MVP entirely over SSH:

```bash
ssh halo-1 'agentmux probe --json'
ssh dev-2  'agentmux probe --json'
ssh gpu-4  'agentmux probe --json'
```

A probe might return:

```json
{
  "sessions": [
    {
      "id": "halo-1:tmux:amdtop:1.0",
      "host": "halo-1",
      "mux": "tmux",
      "session": "amdtop",
      "window": 1,
      "pane": 0,

      "agent": "pi",
      "model": "ornith-1.0-35b",
      "state": "running",

      "repo": "~/src/amdtop",
      "branch": "process-filtering",
      "worktree": null,

      "task": "Implement process filtering and sorting",
      "activity": "cargo test",
      "last_activity": "2026-08-07T10:37:22+09:00",

      "needs_input": false,
      "context_pct": 63,
      "pid": 218742
    }
  ]
}
```

Once the schema exists, the UI becomes almost trivial.

### I would make the primary view task-centric, not terminal-centric

Something like:

```text
 AGENTS ───────────────────────────────────────────────────────────────────────

 State   Agent             Host       Harness   Model          Repo        Age
 ─────────────────────────────────────────────────────────────────────────────
 ▶ RUN   amdtop-filter     halo-1     pi        Ornith 35B     amdtop       12s
 ? ASK   rocm-crash        halo-2     claude    Opus           hipEngine     3m
 ▶ RUN   api-refactor      devbox     codex     GPT-5.6        chanto       21s
 ✓ DONE  eval-parser       gpu-2      pi        KAT-Coder      multieval     8m
 ○ IDLE  website           devbox     pi        Qwen3.6        shisa-web    47m
 ! ERR   kernel-build      halo-3     shell     —              kernel        2m

 ─────────────────────────────────────────────────────────────────────────────
 amdtop-filter
 ~/src/amdtop · process-filtering +3/-1
 "Add process list filtering and sorting"
 Current: cargo test --workspace
 63% context · 1h18m · last output 12s ago

 [enter] attach  [p] preview  [n] rename  [/] search  [h] host  [k] kill
```

Then:

**Enter** = instant attach.

For a tmux target:

```bash
ssh -t halo-1 'tmux attach -t amdtop'
```

or preferably something that chooses the exact window/pane after attach.

When you detach, you're immediately back in the global dashboard.

That makes the interaction:

```text
dashboard
   ↓ enter
remote agent
   ↓ Ctrl-b d
dashboard
```

which is probably substantially nicer than nested local → SSH → byobu navigation.

## Don't infer state solely from terminal output

I think this is the key implementation detail.

There are three levels of observability, and you should combine all three:

```text
                   accuracy
                     ▲
 hooks/events        │   Claude Stop
                     │   Pi tool event
                     │   Codex notify
                     │
 terminal state      │   pane current command
                     │   PTY activity
                     │   process tree
                     │
 heuristics          │   prompt regex
                     │   output inactivity
                     │   spinner detection
                     └─────────────────────────► universality
```

Your state model should be normalized:

```rust
enum AgentState {
    Starting,
    Running,
    WaitingForTool,
    WaitingForPermission,
    WaitingForUser,
    Completed,
    Idle,
    Error,
    Disconnected,
    Unknown,
}
```

Claude is especially easy to instrument properly. Its hooks expose lifecycle events including `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SessionStart`, etc., with JSON input. ([Claude][6])

Claude's statusline interface also exposes structured model/workspace/context information as JSON, including model name and context-window utilization. ([Claude Community][7])

So rather than:

```text
"Oh, nothing printed for 20 seconds — maybe Claude is done."
```

you can receive:

```text
agentmux event \
  --session "$CLAUDE_SESSION_ID" \
  --state waiting_user
```

For Codex, use its structured notification/event support where available and process/PTY inspection for the remainder. For pi, since it's extensible, I would make pi the **gold-standard adapter** and expose everything you care about directly.

## Pi should probably expose an AgentMux protocol

Because pi is your primary harness, I'd give it an extension that sends something like:

```json
{
  "event": "tool.started",
  "agent_id": "8fd9...",
  "model": "ornith-35b",
  "task": "Fix gfx1151 metrics",
  "tool": "bash",
  "detail": "cargo test",
  "context_tokens": 81231
}
```

Then:

```json
{
  "event": "turn.completed",
  "agent_id": "8fd9...",
  "summary": "Implemented metrics and tests pass"
}
```

This gets much more useful than simply knowing that `pi` is running.

You can eventually display:

```text
▶ amdtop       editing src/process.rs
▶ inference    waiting: cargo test
? website      permission: rm dist/*
✓ hipengine    completed: 6 tests passing
▶ multieval    subagent 3/5 reviewing benchmark parser
```

At that point the dashboard becomes a **human scheduler for your agent fleet**, rather than merely a terminal switcher.

## Cross-host design

There are two approaches I'd support.

For version 1:

```text
global TUI
   │
   ├── ssh host1 agentmux probe
   ├── ssh host2 agentmux probe
   └── ssh host3 agentmux probe
```

Use SSH multiplexing:

```sshconfig
Host *
    ControlMaster auto
    ControlPersist 10m
    ControlPath ~/.ssh/cm-%C
```

Polling a tiny JSON command every 1–2 seconds across five machines becomes essentially free.

Later, use:

```text
              persistent SSH connection
                      │
global TUI ◄──────────┼────────► agentmuxd
                      │             │
                      │          unix socket
                      │        ┌────┼─────┐
                      │        pi claude codex
```

I'd strongly prefer this over TCP listeners on every machine. SSH already solves authentication, encryption, routing, jump hosts, and identity.

`agentmuxd` can stream newline-delimited events:

```json
{"op":"update","id":"foo","state":"running"}
{"op":"update","id":"bar","state":"waiting_user"}
{"op":"remove","id":"baz"}
```

No distributed-system machinery needed.

## Keep tmux as the substrate

I would **not switch to Zellij specifically to solve this problem**.

Zellij has a genuinely nice built-in session manager and a replaceable plugin-based session manager, so it could eventually provide a deeply integrated frontend. ([Zellij][8])

But tmux has a major property that's extremely useful here:

```bash
tmux list-panes -a \
  -F '#{session_name}|#{window_index}|#{pane_index}|#{pane_pid}|#{pane_current_command}|#{pane_current_path}'
```

Everything is externally inspectable and scriptable.

Your control layer can therefore be mux-neutral:

```rust
trait Multiplexer {
    fn sessions(&self) -> Vec<Session>;
    fn panes(&self) -> Vec<Pane>;
    fn capture(&self, pane: PaneId) -> String;
    fn attach(&self, target: Target);
    fn send_keys(&self, target: Target, text: &str);
}
```

with:

```text
TmuxAdapter
ZellijAdapter
ByobuAdapter → really TmuxAdapter/ScreenAdapter
```

You can migrate multiplexers independently later.

## One capability I'd add immediately: preview

Press `p` and show the last 30–50 lines without attaching:

```text
┌─ amdtop-filter ───────────────────────────────────────────────┐
│ $ cargo test                                                 │
│ Compiling amdtop v0.3.1                                      │
│ ...                                                          │
│ test process::tests::sort_gpu ... ok                          │
│ test process::tests::filter_pid ... ok                       │
│                                                              │
│ I've implemented filtering. One question before changing     │
│ the default ordering: should GPU utilization or CPU usage     │
│ win when both are present?                                   │
└──────────────────────────────────────────────────────────────┘
```

That's just:

```bash
tmux capture-pane -p -t ...
```

and it would eliminate a large fraction of attaching/detaching.

Later you could even allow:

```text
r → reply
```

from the dashboard and inject input with `tmux send-keys`.

## Metadata should live above tmux session names

I'd separate:

```text
physical session:
    halo-2:tmux:15:0.0

logical agent:
    rocm-ring-crash

task:
    Investigate gfx1151 queue corruption

project:
    hipEngine
```

This matters because processes die, sessions restart, models change, and you may fork the same task into several agents.

Something like SQLite locally is enough:

```text
agents
tasks
hosts
sessions
events
```

Then you gain history almost for free:

```text
rocm-ring-crash
├── pi / Ornith       ✓ proposed queue reset
├── Claude / Opus     ✓ traced kernel path
└── Codex / GPT-5.6   ▶ implementing reproducer
```

That starts intersecting nicely with the multi-pass/multi-agent workflows you've been exploring.

## A useful second-screen view

I'd actually make two modes:

**Fleet view**

```text
RUN  7    ASK  3    DONE  4    ERROR 1

? hipEngine / Claude
? shisa-web / Pi
? multieval / Codex
▶ amdtop / Pi
...
```

and **project view**

```text
hipEngine
├─ ▶ perf-gfx1151       Pi       Ornith
├─ ? queue-crash        Claude   Opus
├─ ✓ hip-kernels        Codex    GPT-5.6
└─ ▶ review             Pi       KAT-Coder

amdtop
├─ ▶ filtering          Pi       Ornith
└─ ✓ sensors            Codex    GPT-5.6
```

I'd probably spend 90% of my time in the latter.

## One surprisingly important feature: attention ordering

Don't sort alphabetically.

Default sort should be something like:

```text
1. waiting for user
2. permission required
3. error
4. just completed
5. running
6. idle
```

Then within states:

```text
time since state transition
```

The UI's job isn't principally to tell you what exists. It's to answer:

> **Which agent benefits most from my attention right now?**

That distinction will make it much better than a generic terminal session manager.

---

So my recommendation would be to take **ccmux's non-invasive discovery philosophy + Agent Deck's polished interaction model + tmux-agent-sidebar's rich metadata**, but explicitly design yours around **remote multi-host operation and a normalized harness event API**. Existing tools seem to cover pieces of this very well, but the multi-machine/global-agent-control-plane aspect still looks like the interesting gap. ([Reddit][3])

Given that pi is extensible, I'd make the first prototype **Rust TUI + tmux + SSH + pi extension**, get exact `RUNNING / WAITING / DONE` semantics working, and add Claude/Codex adapters second. You could get a very useful version without replacing a single existing byobu session.

[1]: https://www.reddit.com/r/codex/comments/1v5xf5o/my_ai_coding_agents_live_inside_tmux_but_i_needed/?utm_source=chatgpt.com "My AI coding agents live inside tmux, but I needed a better way to manage all of them"
[2]: https://github.com/asheshgoplani/agent-deck?utm_source=chatgpt.com "GitHub - asheshgoplani/agent-deck: Terminal session manager for AI coding agents. One TUI for Claude, Gemini, OpenCode, Codex, and more. · GitHub"
[3]: https://www.reddit.com/r/tmux/comments/1upqzua/ccmux_another_ai_agent_monitor_for_tmux_i_know_i/?utm_source=chatgpt.com "ccmux: another AI agent monitor for tmux, I know, I know, but hear me out"
[4]: https://github.com/hiroppy/tmux-agent-sidebar?utm_source=chatgpt.com "GitHub - hiroppy/tmux-agent-sidebar: A tmux sidebar that monitors AI coding agents across all windows and sessions in real-time · GitHub"
[5]: https://www.reddit.com/r/codex/comments/1rozuul/tmux_plugin_to_track_codex_cli_status_across/?utm_source=chatgpt.com "tmux plugin to track Codex CLI status across sessions (also supports Claude Code)"
[6]: https://claude.yourdocs.dev/docs/claude-code/hooks-guide?utm_source=chatgpt.com "Claude Code Hooks Guide — Claude"
[7]: https://claudecn.com/en/docs/claude-code/reference/statusline/?utm_source=chatgpt.com "Statusline – Claude 中文 - Claude AI 开发技术社区"
[8]: https://zellij.dev/documentation/session-manager-alias.html?utm_source=chatgpt.com "The session-manager alias - Zellij User Guide"

> Let’s first do a thorough review of the existing options and then which I can most easily adopt, what glue is left. Let’s also see which ones are most likely to take our upstream patches if we go w an existing on, as well as review the code quality, maturity, velocity, adoption, etc

> I saw someone using a herdr backend btw - a new vibe coded app corral https://x.com/davidondrej1/status/2085112917997830259?s=46&t=vRcB1f5pLCUh-S90n8o2jA

> Also looking at control planes more generally like https://github.com/professorpalmer/Puppetmaster

> People popping out of the woodwork w their own takes https://github.com/guillaumemeyer/tmon

> https://github.com/agentproto/ts

# Bottom line

I would **not build a new terminal UI from scratch yet**. There are now three credible paths:

1. **Fastest adoption with your existing fleet:** trial **skzv/ccmux**. It already has multi-host discovery, SSH/Mosh attachment, a per-host daemon, and—critically—enumerates every session on the host’s default tmux server rather than only sessions it launched. This is unusually close to your current “one agent per Byobu session” topology.

2. **Best upstreamable foundation:** use **epilande/ccmux** on each host and build a thin, separate fleet aggregator. It has the best non-invasive session discovery, exact Pi lifecycle integration, modular internals, strong tests, an MIT license, and demonstrated willingness to merge meaningful outside contributions. Its maintainer has explicitly kept multi-server aggregation out of the local daemon, though, so host federation should remain a separate client rather than a giant upstream PR.

3. **Best long-term replacement runtime:** standardize new work on **Herdr**, then put an external fleet control plane above it. Herdr is dramatically more mature and adopted than the other candidates and has the best runtime/API/plugin story, but adopting it means restarting your agents inside Herdr rather than simply indexing the Byobu sessions you already have. Its documented remote mode attaches to one Herdr server at a time; I found no built-in simultaneous five-host fleet view. It also no longer accepts unsolicited implementation PRs.

My current recommendation is therefore:

> **Trial skzv/ccmux immediately, but treat epilande/ccmux plus a separate fleet client as the safer upstream-first engineering path. Pilot Herdr on one machine as a possible future substrate.**

This is a repository and architecture audit, not yet a production soak test on your five machines.

---

# Comparative view

Snapshot as of **August 7, 2026**:

| Project              | Can observe existing sessions?                                                | Multi-host fleet                                                  | Pi support                                                                 | Maturity/adoption                                            | Upstream outlook                                           | Best use                                              |
| -------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------- |
| **skzv/ccmux**       | **Yes**, all sessions on default tmux server; session/active-pane granularity | **Built in:** Tailscale discovery, daemon probes, SSH/Mosh attach | Present, but status is mostly terminal heuristics                          | Alpha; ~23 stars, 2 forks; FSL-1.1-MIT                       | Unproven; no public PR history or contribution guide       | **Fastest direct trial**                              |
| **epilande/ccmux**   | **Yes**, pane-level discovery across existing tmux sessions                   | No federation; one selected tmux server per daemon                | Exact lifecycle hooks, but currently little model/activity metadata        | Very young; ~115 stars, 11 forks; MIT; extremely well tested | **Best evidence of receptivity** for focused patches       | **Best foundation for a separate fleet UI**           |
| **Herdr**            | Not arbitrary existing Byobu PTYs; sessions need to run under Herdr           | Remote attach exists, but one server at a time                    | Official Pi integration and lifecycle state                                | **~25.2k stars, 1.8k forks; Apache-2.0**                     | **No unsolicited PRs** without approved-contributor status | **Best replacement terminal runtime**                 |
| **tmon**             | **Yes**, intentionally non-owning tmux-pane discovery                         | None                                                              | No Pi connector yet                                                        | Under two weeks old; 0 stars; MIT                            | Welcoming policy, but no empirical PR record               | Smallest understandable overlay/fork                  |
| **Flowmux**          | Designed around Flowmux-created panes and persisted config                    | None                                                              | **Excellent:** model, context, session, response and lifecycle integration | ~25 stars; MIT; no public PR history                         | Unknown                                                    | Strong local session owner and **Pi adapter donor**   |
| **Agent of Empires** | Primarily AoE-created tmux sessions                                           | Browser access to one deployment, not a global host federation    | Broad first-class agent support including Pi/OMP                           | ~3k stars, 299 forks; MIT                                    | PRs explicitly welcomed; community-backed                  | Most productized local TUI/web session owner          |
| **AgentPulse**       | Existing Claude/Codex sessions through hooks                                  | **Remote event relay and host routing**                           | No Pi today                                                                | ~12 stars, 4 forks; MIT; very broad feature surface          | Likely approachable, but project is web-first              | Best existing cross-host **web** observability design |
| **Puppetmaster**     | No; manages jobs rather than arbitrary terminals                              | Worker/control-plane model, not terminal federation               | CLI/provider adapters, not live pane semantics                             | ~301 stars, 31 forks; MIT                                    | Unclear                                                    | Later durable scheduler/artifact layer                |
| **agentproto/ts**    | Owns sessions through its runtime                                             | Common daemon/API model; federation not the immediate focus       | Pi, Claude, Codex and other adapters                                       | 0.10 alpha; ~5 stars; Apache-2.0                             | Unproven                                                   | Ambitious common agent protocol/control plane         |

Sources for the snapshot and feature characterizations: skzv/ccmux, epilande/ccmux, Herdr, tmon, Flowmux, Agent of Empires, AgentPulse, Puppetmaster and agentproto.

---

# 1. skzv/ccmux: closest to your current topology

There are two unrelated projects named `ccmux`. This is the **Go, multi-machine one**, not epilande’s TypeScript project.

## What fits especially well

Its remote-host story is already substantially built:

* Tailscale peer discovery.
* Remote daemon health checks.
* A devices/hosts view.
* Remote project/session creation.
* SSH or Mosh attachment.
* An HTTP API, SSE events and WebSocket PTY access.
* Local and remote session management from one TUI.

More importantly, the tmux layer literally runs:

```go
tmux list-sessions ...
```

and returns every session on the default server. It does not maintain a private registry limited to sessions created by ccmux. Capture, classification and input are then directed at the session’s active pane.

That maps well to your description of **individual Byobus**, assuming each Byobu session is one agent. It is less ideal when one tmux session contains several agent panes, because the current abstraction is session-centric and operates on the active pane rather than indexing every pane individually.

Byobu defaults to the tmux backend when tmux is present, and ordinarily shares tmux’s default server. If a host uses GNU Screen or explicitly launches Byobu with another tmux socket via `-L`/`-S`, ccmux will not automatically see it through the current default-server call. ([Byobu][1])

## Pi quality

Pi is recognized, but its present state detector is thin. The built-in rule marks Pi as working when the terminal title contains a braille spinner or the bottom of the pane contains `Working...`. The adapter otherwise falls back to the same conservative quiet-pane heuristic used for non-native integrations.

That will not reliably give you:

* Current model.
* Context usage.
* Current tool or command.
* Exact agent-loop boundaries.
* Distinction among idle, completed, waiting for input and waiting for permission.
* Pi’s session name.

A Pi extension could fix most of that without touching terminal parsing.

## Code quality

Despite low adoption, its engineering hygiene is strong:

* Go formatting and vet checks.
* Race-enabled tests and coverage on Linux and macOS.
* Cross-compilation checks.
* Parser fuzzing.
* Integration tests using isolated tmux servers.
* A centralized tmux wrapper with careful exact-target handling, locale handling, stderr propagation and parsing tests.

The code I inspected is much better than “23-star vibe-coded prototype” would imply. The comments often explain concrete past failure modes and the tests cover those regressions.

The contrary signals are:

* Alpha status.
* Tiny real-world user base.
* No public PR history.
* No `CONTRIBUTING.md`.
* Very high feature velocity, therefore high churn risk.
* FSL-1.1-MIT rather than immediately permissive MIT. Internal use is permitted, but a competing commercial offering is restricted until the license converts after two years.

## Glue left

For your setup, this is potentially only a **small-to-medium** patch set:

1. A Pi extension that reports exact lifecycle state, model, session name, last prompt, current tool and context usage.
2. A normalized metadata structure for those fields.
3. `-L`/`-S` tmux socket support if any of your Byobus are not on the default server.
4. Pane-level indexing only if your “individual Byobus” actually contain several agent panes.
5. Possibly SSH jump-host and non-Tailscale host configuration, depending on how your five machines are connected.

This is the one I would install first because the trial itself answers the most important uncertainty: **does it already see and switch cleanly among your current Byobus?**

---

# 2. epilande/ccmux: best foundation and best upstream target

This is the **TypeScript/Bun/OpenTUI project**. Its philosophy is almost exactly right for you: discover and monitor agents running in existing tmux panes rather than forcing them to be launched through the manager.

## Why its local session model is better

It is pane-centric rather than merely session-centric. The daemon correlates:

* tmux pane and process-tree identity.
* Agent-native hook markers.
* Native transcript/session files.
* Terminal output patterns.
* Activity and stale-state timing.
* Git branch, prompts, waiting type, pending tools and subagents.

It exposes the result through a local daemon, REST endpoints and SSE updates, while the TUI can preview and switch into the real pane.

Its normalized status model is already stronger than most competitors:

```text
working
waiting:
  permission
  question
  plan_approval
idle
```

It also tracks the exact pending tool, status-transition time, attention generation, unread result state, recent prompts, subagents, worktrees, git branch and related PR/CI state.

## Pi support

The bundled Pi extension is not heuristic. It uses Pi events:

* `session_start`
* `before_agent_start`
* `agent_start`
* `agent_end`
* `session_shutdown`

It writes atomically updated markers containing process ID, session ID, cwd, transcript path, last prompt and working/idle state. The implementation serializes event writes to avoid lifecycle races and has dedicated tests.

However, the current marker and `Session` schema do **not** include model, provider, context usage, thinking level or current tool. So it gives a trustworthy lifecycle state but not yet the full dashboard row you described.

## Code quality

This was the most impressive repository relative to its age:

* Explicit `commands`, `daemon`, `lib`, `plugins`, `tui` and `types` boundaries.
* Detailed architecture and adapter documentation.
* CI and release workflows.
* `bun test`, TypeScript checking and unused-code checks.
* Contributor, security and PR templates.
* Tests colocated through the implementation.
* One recent change reports **4,227 tests across 159 files**.

The architecture is surprisingly disciplined for a project created on July 6, 2026. The maturity risks are its age, dependence on Bun, and dependence on OpenTUI 0.1.x.

## Upstream receptivity

This is the best candidate by demonstrated behavior:

* `CONTRIBUTING.md` explicitly welcomes PRs and asks that large changes be discussed first.
* An outside contributor’s substantial feature PR—20 files and roughly 600 additions—was reviewed and merged promptly.
* The repository has several contributors rather than being entirely single-author.

But there is a major scope boundary. PR #98 added explicit selection of one tmux socket and stated:

> “Deliberately out of scope: multi-server aggregation.”

The reason is substantive: the daemon’s marker directory and log watchers assume one tmux server.

Therefore, I would not propose “please merge a five-host distributed daemon” upstream. I would propose small schema and adapter improvements upstream and keep federation in a separate client.

## Glue left

The clean architecture is:

```text
                           fleet TUI
                               │
                ┌──────────────┼──────────────┐
                │              │              │
             SSH/API        SSH/API        SSH/API
                │              │              │
          ccmux daemon    ccmux daemon    ccmux daemon
                │              │              │
           host A tmux     host B tmux     host C tmux
```

An MVP does not need exposed network ports:

```bash
ssh host-a ccmux show --json
ssh host-b ccmux show --json
ssh host-c ccmux show --json
```

Use SSH ControlMaster multiplexing and poll each host. Attaching can call the remote ccmux switch command or an exact tmux target through `ssh -t`. A later version can maintain persistent SSE streams through SSH tunnels.

The remaining components are:

* Host registry and aliases.
* Host health and reconnect state.
* Composite identity such as `host + tmux socket + pane`.
* Merged sorting and filtering.
* Remote preview routing.
* Remote attach and optional input routing.
* Pi metadata enrichment.
* Optional protocol/capability negotiation between different ccmux versions.

Very rough code surface—not a schedule:

* Basic JSON polling and SSH attach: hundreds of lines.
* Robust persistent federation with SSE, reconnect and cross-version handling: low thousands of lines.
* Pi metadata extension and normalized optional fields: a few hundred lines plus fixtures/tests.

## Best upstream patch sequence

I would approach the maintainer with narrowly scoped changes:

1. Add optional agent metadata fields such as `model`, `provider`, `sessionName`, `contextUsage` and `activity`, including a `source` field.
2. Populate those fields from the Pi extension.
3. Add an API version/capabilities response so external clients can consume the daemon safely.
4. Possibly add a user-defined local `hostLabel`, without attempting remote connectivity.

The fleet aggregator remains a separate MIT project consuming the public daemon API. That respects the project’s existing scope and gives the patches a much better chance of acceptance.

---

# 3. Herdr: strongest runtime, but it changes the substrate

Herdr has evolved from “another tmux-like experiment” into the dominant project in this space. The current official repository has approximately **25,157 stars and 1,771 forks**, is Apache-2.0 licensed, and describes itself as “the runtime your coding agents live on.”

## What it gives you

* Persistent server-owned PTYs.
* Workspaces, tabs and panes.
* Agent-aware working, blocked and idle state.
* Direct terminal attach.
* Local and SSH remote clients.
* CLI automation.
* A versioned JSON socket API.
* Official integrations for Pi, Claude, Codex and numerous other agents.
* A large plugin ecosystem.  ([Herdr][2])

The socket schema is significantly richer than an ad hoc tmux probe. It models workspaces, terminals, panes, worktrees, agent sessions, statuses and events, and includes a protocol version.

That is exactly why multiple higher-level products are using it as their backend.

## Corral and the Herdr control-plane pattern

I could not locate a public Corral repository or license tied to the X post, and X would not return the post contents through the available interfaces. So I cannot honestly score Corral’s code quality, maturity or upstream posture.

However, **Shepherd** publicly documents the same architectural pattern:

```text
Herdr:
  owns the durable PTYs and interactive sessions

Shepherd:
  disposable web control plane
  scheduling, review gates, worktrees, CI, usage and UI
```

Shepherd explicitly says it can restart its control plane without interrupting agents because Herdr continues to own their terminals. ([Shepherd][3])

That strongly validates treating Herdr as a runtime protocol rather than trying to make Herdr itself contain every possible fleet-management feature.

## Where it does not fit today

Herdr cannot take ownership of an already-running PTY inside tmux or Byobu. You would restart the agents inside Herdr. It is therefore a migration rather than an overlay.

Its documented remote flow is:

```bash
herdr --remote workbox
```

which attaches one remote Herdr server. I found no current global view that simultaneously merges several remote Herdr servers into a single dashboard. The internal remote configuration also represents one remote connection, not a federation.

## Upstream posture

Herdr is the least attractive upstream target. Its policy is explicit:

* Unsolicited implementation PRs are closed automatically.
* Only maintainers and approved contributors may submit them.
* Architecture and product changes require prior discussion.
* The approved-contributor list is not an application program.

This does not prevent extensions. It means the sensible route is:

* Herdr plugin.
* External Herdr API client.
* Separate control plane.
* Discussion or bug report where appropriate, but no speculative implementation PR.

## Recommendation

Pilot Herdr on one machine or on newly started work. Do not immediately migrate all existing Byobus.

A host-federating Herdr client would be a strategically strong project:

```text
fleet client
  ├── herdr server: halo-1
  ├── herdr server: devbox
  ├── herdr server: gpu-2
  └── herdr server: laptop
```

It could subscribe to each server’s versioned event API and normalize host, workspace, agent, state and terminal ID. This is a cleaner long-term platform than scraping tmux, but it delivers less immediate value because of the migration requirement.

---

# 4. tmon: best tiny codebase, not yet a complete answer

`tmon` is deliberately modest:

* It discovers existing tmux panes.
* Shows working, blocked and idle state.
* Provides an interactive dashboard and tmux status integration.
* Supports fuzzy pane-content search.
* Exposes JSON.
* Has native, hook and heuristic connector modes.
* Deliberately does not start, stop or prompt agents.

The connector abstraction is small and contribution-friendly. Its contribution guide says anyone may open PRs, documents the connector interface and requires CI and review; CI covers Linux/macOS tests, vet, lint and shellcheck.

But as of August 7 it is under two weeks old, has no stars or forks, no Pi connector and no remote-host model.

It is attractive when the desired outcome is a tiny, comprehensible internal fork. For a public upstream-first project, epilande/ccmux currently has much stronger evidence of real collaboration and already solves more of the hard state-correlation problem.

The remaining work would be:

* Pi connector.
* Remote probe protocol.
* Host-aware identifiers.
* SSH attach.
* Remote previews.
* Host connectivity and error UI.

At that point you would have written much of the distributed layer yourself.

---

# 5. Flowmux: excellent agent adapters, but it wants to own sessions

Flowmux has one of the strongest local UI and adapter designs:

* Rust/Ratatui.
* Real tmux panes.
* Embedded Ghostty VT terminal rendering.
* Model name, context usage and latest response in dashboard cards.
* Exact hook-based Claude integration.
* Codex app-server/WebSocket integration.
* A generated Pi extension that reports session, model, context, response and lifecycle.
* Optional worktrees and project grouping.

Its `AgentAdapter` interface is close to the metadata contract you ultimately want:

```rust
get_status()
get_context()
get_first_prompt()
get_last_model_response()
get_model_name()
get_total_work_ms()
get_cached_session_id()
```

Its Pi implementation is particularly useful because it proves that richer Pi telemetry is practical. The repository’s CI runs tests and clippy on Linux and macOS and builds release artifacts.

The mismatch is architectural: Flowmux persists a list of agents it created inside a dedicated Flowmux tmux session. Importing arbitrary existing Byobu panes and adding a remote-host abstraction would cut through its configuration, runner, adapter and UI assumptions.

It also has a fairly heavy build chain because faithful terminal rendering pulls in a pinned Ghostty VT implementation and Zig.

I would **borrow from Flowmux**, especially its Pi adapter and normalized metadata ideas, rather than choose it as your fleet base.

---

# 6. Agent of Empires: strongest productized session owner

Agent of Empires is the most credible “install a finished app and let it own the workflow” alternative after Herdr:

* Rust TUI.
* Browser/PWA dashboard.
* Real tmux sessions.
* Pi, OMP, Claude, Codex and many other harnesses.
* Status detection.
* Worktrees and multi-repository workspaces.
* HTTP API.
* Structured ACP rendering.
* Diff and file-editing views.
* Container sandboxing.
* Push notifications and phone access.

It has roughly 3,000 stars and 299 forks, is MIT licensed and says issues and PRs are welcome. It also has community/Mozilla.ai involvement.

But AoE is still a session owner. Each agent is expected to live in an AoE-created tmux session with AoE metadata. Its web dashboard gives remote access to one AoE deployment, but that is not the same as aggregating independently running AoE instances on five hosts.

It becomes attractive when you are willing to change the operational convention from:

```text
ssh → byobu → launch agent manually
```

to:

```text
aoe add → AoE owns tmux session and metadata
```

That is a plausible migration path, but it is not the lowest-friction overlay for what you already have.

---

# 7. AgentPulse: closest existing cross-machine control plane, but web-first and Pi-less

AgentPulse deserves more attention than its star count suggests. Its explicit use case is a command center across multiple machines, and it supports:

* Observability-only mode for existing sessions.
* Local orchestration.
* A remote dashboard that receives relayed events.
* Host routing.
* Live session history.
* Templates and projects.
* Supervisors and retries.
* An inbox for approval/stuck/failure events.
* WebSocket updates and an MCP control surface.

This is structurally close to the control plane you are imagining.

The blockers are:

* It is a web app, not a terminal TUI.
* It currently supports Claude Code and Codex, not Pi.
* It is a very broad TypeScript/Bun application with a tiny user community relative to its feature surface.
* Adding a TUI would be a separate frontend project, not a small patch.

It is worth studying for relay, host routing, data model and inbox semantics. It is not currently the easiest thing for you to adopt.

---

# 8. Puppetmaster, agentproto and the “real control plane” layer

These solve a later problem than “where is the terminal that needs me?”

## Puppetmaster

Puppetmaster is a durable job supervisor:

* SQLite state.
* Worker leases.
* Retries and resume.
* Artifacts.
* Memory.
* Provider/model routing.
* Deterministic result stitching.
* A dashboard and CLI adapters.

Its packaging and CI are quite disciplined: Python 3.9+, zero core dependencies, optional integrations and Linux/macOS/Windows test matrices.

But its unit of abstraction is a **job**, not an arbitrary interactive terminal pane. It would be useful once the dashboard launches work and tracks task IDs, retries, artifacts and stitched results. It does not solve the immediate discovery/switching problem.

## agentproto/ts

`agentproto/ts` is more ambitious. It aims to put Pi, Claude, Codex and other agents behind a common:

* Session lifecycle.
* PTY and HTTP API.
* MCP tool surface.
* Permissions and policy gates.
* Usage APIs.
* Workflows and cron.
* Desktop/VS Code integrations.

Its monorepo, adapter harnesses, release automation and large CI suite show serious engineering investment.

But it is version 0.10 alpha with approximately five stars. Its specification and product surface are enormous relative to observed adoption. Adopting it means transferring session ownership into a new runtime, not indexing current Byobus.

I would treat it as a protocol and API-design reference, not the immediate foundation.

---

# Projects I would not prioritize for this particular problem

Several projects have much higher adoption than epilande/ccmux or skzv/ccmux, but they are solving local worktree/session orchestration rather than existing multi-host session federation:

* **Claude Squad:** approximately 8.2k stars, Go, AGPL; manages sessions it launches.
* **workmux:** approximately 2.1k stars, Rust, MIT; excellent git-worktree/tmux workflow, but local and worktree-centric.
* **agtx:** approximately 1.2k stars, Rust, Apache-2.0; more of a coding-agent blackboard/orchestrator.
* **Agent Deck:** approximately 669 stars, Go, MIT; polished local session owner, but remote federation would be a major addition.
* **Codeman:** approximately 570 stars, web-first mission control, local tmux ownership.
* **NTM:** approximately 416 stars, broad tmux orchestration and APIs, but not a non-invasive fleet index; its reported license is non-standard/unspecified in GitHub metadata.
* **tmux-agent-sidebar:** approximately 435 stars and a rich local Rust sidebar; valuable detection/UI code, but no multi-host layer.
* **tmux-agent-status:** approximately 256 stars, shell-based and intentionally narrow; useful implementation reference rather than base.

**Trustmux** is a useful adjunct because it is explicitly Byobu-native and exposes existing tmux/Byobu sessions to a phone over Tailscale, but it is a per-host PWA and has no agent-aware model/status layer. ([Trustmux][4])

---

# Upstream likelihood ranking

## 1. epilande/ccmux — highest confidence

**Focused adapter/schema/UI patches:** high.

**Core host federation:** low, because multi-server aggregation has already been declared out of scope.

Evidence is better than promises: it has a clear contribution guide and has merged a substantial outside feature PR.

## 2. Agent of Empires — moderate to high

It explicitly welcomes issues and PRs and has a real community. A new agent adapter or additive HTTP field is plausible. Cross-host federation would be a product-direction discussion rather than a routine PR.

## 3. tmon — high stated openness, low empirical confidence

The contributor policy is welcoming and the connector interface was designed for third-party additions. But the repository is too new to know how maintainers handle a nontrivial external change.

## 4. Flowmux — moderate but unproven

The README includes normal contribution instructions, and the adapter architecture is clean, but there are no public PRs yet. A focused Pi or adapter fix is likely more viable than remote federation.

## 5. skzv/ccmux — unknown

The code is good, but there is no public PR record or contribution guide. Before writing anything substantial, I would open a concise issue describing the real five-host use case and propose one focused change.

The FSL license is also a strategic consideration if the work could become a Shisa product rather than an internal tool.

## 6. Herdr — effectively unavailable without invitation

The project explicitly closes unsolicited PRs. Build a plugin or external client instead.

---

# The normalized metadata layer you will still need

No current option consistently exposes all of:

* Name.
* Host.
* Repository/worktree.
* Harness.
* Provider/model.
* State.
* Current tool/activity.
* Context usage.
* Attention reason.
* Last transition.
* Session/pane attach target.

The normalization should preserve not only the value but also **where it came from**:

```ts
interface AgentObservation {
  id: string;
  host: string;

  terminal: {
    backend: "tmux" | "herdr" | "zellij";
    server?: string;
    session?: string;
    window?: string;
    pane?: string;
  };

  harness: {
    id: "pi" | "claude" | "codex" | string;
    sessionId?: string;
    version?: string;
  };

  model?: {
    provider?: string;
    id: string;
    source: "hook" | "rpc" | "transcript" | "process" | "heuristic";
  };

  state: {
    value:
      | "starting"
      | "working"
      | "waiting_tool"
      | "waiting_permission"
      | "waiting_user"
      | "completed"
      | "idle"
      | "error"
      | "disconnected"
      | "unknown";
    since?: string;
    source: "hook" | "rpc" | "terminal" | "activity" | "heuristic";
    confidence: "exact" | "strong" | "weak";
  };

  activity?: {
    kind: "tool" | "command" | "thinking" | "responding";
    label: string;
  };

  project?: {
    cwd: string;
    repo?: string;
    branch?: string;
    worktree?: string;
  };
}
```

This prevents a terminal regex from being treated as equivalent to a Pi lifecycle callback or Codex app-server event.

The preferred signal order should be:

```text
native lifecycle / app-server / RPC
    >
agent transcript or structured log
    >
process tree and tmux metadata
    >
terminal title/body patterns
    >
inactivity heuristic
```

Both epilande/ccmux and Flowmux already embody much of this approach. skzv/ccmux currently needs a stronger native Pi layer.

---

# Concrete adoption plan

## Stage 1: compatibility check

On every host:

```bash
byobu-select-backend
tmux list-sessions \
  -F '#{session_name}|#{session_windows}|#{session_path}|#{session_attached}'
```

The important outcomes are:

* Backend is `tmux`, not GNU Screen.
* The ordinary `tmux list-sessions` sees the same Byobu sessions you use.
* Each agent is genuinely one tmux session or at least the active pane of one session.
* No hosts rely on a custom `tmux -L`/`-S` server without your realizing it.

## Stage 2: skzv/ccmux bakeoff

Install it on two representative machines:

* One with mostly Pi sessions.
* One with a mixture of Claude Code and Codex.
* Preferably one reachable directly and one through whatever SSH alias/jump arrangement you normally use.

Evaluate:

1. Does it discover every existing Byobu?
2. Does it identify the harness correctly?
3. How often does Pi show working when actually idle, or idle while working?
4. Does attach land in the right session?
5. Does detaching return cleanly to the fleet TUI?
6. Does an unreachable/sleeping host degrade gracefully?
7. Does Tailscale discovery match your actual host inventory?
8. Are preview, rename and notes useful without migrating sessions?
9. Does the session-level active-pane assumption matter?
10. Is the FSL license acceptable for the intended use?

If the answer is broadly yes, it is by far the smallest route to immediate utility.

## Stage 3: epilande/ccmux foundation test

Run the local daemon on the same two hosts and inspect its JSON/API output. The questions are:

* Is its status materially more accurate?
* Does pane-level discovery matter?
* Do its attention reasons and pending-tool data reduce context switching?
* Is the API stable and complete enough to aggregate without importing its TUI code?
* Does the Pi extension coexist cleanly with your existing Pi packages/extensions?

If so, the durable design becomes:

```text
epilande/ccmux per host
        +
small independent fleet TUI
```

## Stage 4: Herdr pilot

Start newly created agents inside Herdr on one machine. Evaluate it as a replacement runtime, not as an overlay:

* Terminal fidelity and keybindings.
* Pi lifecycle reliability.
* Remote attach.
* Session persistence across disconnect/restart.
* API completeness.
* Plugin quality.
* Whether you actually miss Byobu.

Do not migrate the whole fleet until the runtime pilot is clearly better.

---

# Final recommendation

For your exact current state:

### Adopt first

**skzv/ccmux**, because it already attempts the thing you asked for and can enumerate current default-server tmux sessions. Its missing work is primarily richer Pi metadata rather than host federation.

### Invest in if you want a public, upstream-friendly project

**epilande/ccmux plus an independent fleet aggregator.** Upstream the generic metadata and Pi improvements; keep remote aggregation outside the repository. This gives you an MIT path, good local semantics and substantially less maintenance risk than forking a rapidly changing monolith.

### Consider as the eventual terminal substrate

**Herdr**, but only after a pilot. Its runtime and API are the strongest, and the Corral/Shepherd pattern shows that an external control plane above durable Herdr PTYs is viable. The cost is migration and an upstream policy that requires extensions to remain out-of-tree.

### Do not use as the immediate base

Puppetmaster or agentproto. Their ideas become useful after the dashboard evolves into a scheduler, but neither is the shortest path to indexing and switching among the agents already living in your Byobus.

[1]: https://byobu.org/ "https://byobu.org/"
[2]: https://herdr.dev/ "https://herdr.dev/"
[3]: https://www.shepherd.run/ "https://www.shepherd.run/"
[4]: https://trustmux.dev/ "https://trustmux.dev/"

> Are the two ccmux projects completely different? Btw we’re building jouzu.dev a pi fork that is focused on making it Japanese friendly, integrating with our Shisa platform model catalogs w cospa testing. It’d be interesting to add a fully remote management (or tui) control plane infra on top, curious if that changes our thinking moving forward

Yes. They are **completely independent projects that happen to have picked the same obvious name**. There is no fork/ancestry relationship.

Pi

**epilande/ccmux** is TypeScript/Bun/OpenTUI, MIT, created July 2026. Its core idea is *observability over an existing tmux workflow*: discover arbitrary agent panes already running, infer/enrich their state, preview them, and jump to them. It explicitly says you don't change how you launch agents.

**skzv/ccmux** is Go/Bubble Tea, FSL-1.1-MIT, created May 2026. Its core idea is closer to *distributed tmux session management*: daemon on each machine, Tailscale discovery, remote creation, SSH/Mosh attachment, phone support, usage accounting, etc. Its README literally frames it as “a cross-device tmux session manager for AI coding agents.”

So confusingly:

|                 | epilande/ccmux                 | skzv/ccmux                             |
| --------------- | ------------------------------ | -------------------------------------- |
| Language        | TypeScript                     | Go                                     |
| License         | MIT                            | FSL → MIT                              |
| Primitive       | **pane / agent observation**   | **distributed session management**     |
| Existing tmux   | Excellent                      | Yes                                    |
| Agent telemetry | **Stronger architecture**      | More heuristic                         |
| Multi-machine   | Missing                        | **Core feature**                       |
| Pi integration  | **Native lifecycle extension** | Basic detection                        |
| Remote attach   | Not really                     | **SSH/Mosh/Tailscale**                 |
| Philosophy      | “observe what I already run”   | “manage my coding sessions everywhere” |

In some sense, **the ideal system for you is the offspring of the two**: epilande's agent-aware observation model + skzv's distributed host/session layer.

## Jouzu changes my recommendation quite a bit

If Jouzu were merely another coding agent you used, I'd continue recommending adopting one of these tools and adding Pi support.

But if **Jouzu is your Pi-derived distribution and you're already controlling the harness**, you own the one piece all these projects are struggling to reconstruct from the outside: **ground-truth agent state**.

Every generic manager eventually does some combination of:

```text
capture-pane
process inspection
terminal regexes
transcript tailing
hooks
mtime/activity heuristics
```

because Claude, Codex, Pi, etc. don't expose one universal lifecycle interface.

For Jouzu, none of that should be necessary.

You can expose something like:

```text
Jouzu Agent Runtime
──────────────────────────────────────────
identity
  session_id
  display_name
  project/repo/worktree

execution
  idle | thinking | tool | waiting | error
  current_tool
  current_task
  started_at

model
  provider
  model_id
  routing_profile
  thinking_level

usage
  input/output/cache tokens
  context_used/context_max
  cost
  Shisa cospa score

interaction
  prompt()
  interrupt()
  approve()
  deny()
  answer()
  change_model()

terminal
  PTY/session attachment
```

And because Jouzu is integrating with the Shisa model catalog, the control plane can expose information **none of these other TUIs can realistically know**: available models, measured quality, measured tok/s, price, current routing policy, remaining quota, and your cospa metric.

That is substantially more interesting.

### I'd now separate three layers

```text
                    JOUZU CONTROL PLANE
        ┌─────────────────────────────────────────┐
        │ Fleet                                  │
        │                                        │
        │ halo-1  backend-refactor  WORKING      │
        │         Qwen-X · 84 cospa · 47 tok/s   │
        │                                        │
        │ gpu-2   eval-fix          NEEDS INPUT  │
        │         Claude ...                      │
        │                                        │
        │ devbox  docs              IDLE          │
        └──────────────┬──────────────────────────┘
                       │
               common Jouzu protocol
              /        │         \
             /         │          \
      jouzud        jouzud        jouzud
      halo-1        gpu-2         devbox
         │             │             │
      agents         agents         agents
```

**Layer 1: Jouzu agent protocol.** This belongs in Jouzu itself. It should be transport-independent and provide structured events/state/control. A local Unix socket would be sufficient initially.

**Layer 2: `jouzud` host agent.** A tiny daemon indexes all Jouzu processes on a machine and exposes them remotely. This is where authentication, host identity, PTY attach, reconnect and eventually discovery belong.

**Layer 3: clients.** TUI, CLI, web/mobile, MCP, perhaps VS Code. Crucially, none of these owns the actual agent.

That last distinction matters. I'd avoid making the **TUI** the control plane. The TUI is just one control-plane client.

## And I'd make it heterogeneous from day one

Even though Jouzu gives you privileged native telemetry, I wouldn't make the fleet protocol Jouzu-only.

Use an adapter boundary:

```text
                  jouzud
                    │
          ┌─────────┼─────────┐
          │         │         │
        Jouzu     Claude     Codex
       native      adapter    adapter
          │         │         │
        exact      hooks/     app-server/
        events     transcript  JSONL
```

Then your own harness gets a first-class/native experience while Claude Code, Codex, stock Pi, OpenCode, etc. degrade gracefully.

That turns this from “a Jouzu feature” into a potentially useful **open agent fleet control plane**, with Jouzu being its reference/best-supported harness.

It also avoids an architectural trap: if someday 30% of someone's sessions are Jouzu and 70% are Claude Code, they shouldn't need two dashboards.

## This also changes how I'd look at the existing projects

I would stop asking primarily:

> Which one should Jouzu adopt?

and instead ask:

> **Which pieces should Jouzu interoperate with or upstream rather than reinvent?**

My revised ordering would be:

**epilande/ccmux becomes especially interesting as a client/UI.** Its internal model is already agent-centric, it has a native Pi extension, it observes arbitrary existing panes, and it has an MIT license. I could imagine an upstream `jouzu` adapter where ccmux gets exact state over the Jouzu socket instead of reading marker files. Then Jouzu users immediately get a good local TUI without you maintaining one.

**skzv/ccmux becomes an architecture/reference implementation.** Its distributed daemon, host discovery, SSH/Mosh attach and mobile-terminal behavior are exactly the boring distributed-systems plumbing you'd want to study. But FSL plus its more session-manager-centric architecture makes me less enthusiastic about making it a core Jouzu dependency.

**Herdr becomes a runtime backend option rather than the architecture.** You could support:

```text
Jouzu native PTY
Jouzu under tmux/byobu
Jouzu under Herdr
```

and report the terminal attachment target through the same protocol. Then you're not betting Jouzu on the terminal-multiplexer winner.

**agentproto becomes much more relevant as a standards question.** Their runtime already exposes `agent_start`, `agent_prompt`, `agent_output`, `agent_interrupt`, `agent_set_model`, `session_usage`, permissions, session hierarchy, etc., and they explicitly support Pi. Before inventing a Jouzu wire protocol, I would do a fairly serious mapping against their AIP-45/lifecycle model. The project itself is immature, but converging rather than creating yet another incompatible agent-management protocol would be valuable if its abstraction is sound.

## There's a particularly nice Shisa/Jouzu feature here

Your model catalog can turn the fleet UI into an **active optimization surface**, not merely monitoring.

Imagine selecting an agent and hitting `m`:

```text
Switch model

                         Quality   tok/s    ¥/M     Cospa
● Qwen-...                  82.1     71     ¥...     94
  Ornith-...                84.7     38     ¥...     81
  Claude ...                91.3     17     ¥...     63
  Codex ...                 93.0     12     ¥...     57

Current task: coding / medium complexity
Recommended: Qwen-...
```

Or fleet-wide:

```text
HOST       AGENT              MODEL        STATE       COST    CONTEXT
halo-a     amdtop-fix         Qwen-X       ● tool      ¥21     43%
halo-b     hrtf-research      Claude       ◉ thinking  ¥184    71%
server-3   shisa-eval         Ornith       ! waiting   ¥39     28%

3 active · 1 waiting · ¥244 today · ¥37/hr
```

Now your cospa work, routing/catalog work and agent control plane reinforce one another rather than being separate products.

And later the natural progression is:

```text
observe
   ↓
control
   ↓
route
   ↓
schedule
   ↓
orchestrate
```

At first Jouzu tells you *“these six agents are running.”*

Then *“switch this one to the cheaper model.”*

Then *“launch this task on halo-2 with model X.”*

Eventually:

> “Run these 12 issues across available machines using the best model under ¥5,000 total; escalate failed reviews to the frontier model.”

At that point you're moving into the territory Puppetmaster is exploring—but with the considerable advantage that **you own the harness, model catalog, evaluation data and routing layer** rather than trying to glue opaque CLIs together.

### What I would do now

I would **not fork either ccmux into Jouzu**.

I'd make **remote observability/control a first-class Jouzu protocol now**, while the fork is young enough that lifecycle events and session identity can be designed correctly. Keep it headless and transport-neutral.

Then:

1. Build the smallest `jouzud`: Unix socket locally + authenticated remote endpoint, structured event stream and PTY attachment information.
2. Write an **epilande/ccmux Jouzu adapter** as the first UI integration rather than immediately writing another TUI.
3. Map Jouzu's protocol carefully against **agentproto/AIP** before freezing it.
4. Borrow/test the remote-host UX ideas from skzv/ccmux.
5. Make the daemon's internal agent interface heterogeneous so Claude/Codex/stock Pi adapters can follow.
6. Only build a Jouzu-specific fleet TUI once actual usage tells you what ccmux cannot express—likely Shisa catalog/cospa/routing and eventually orchestration.

That gives you something useful very quickly without prematurely committing Jouzu to either tmux, Herdr, or a particular TUI framework. And if the control-plane abstraction proves useful independently, **`jouzud`/the fleet protocol may ultimately be a more important piece of Jouzu than the TUI itself.**
