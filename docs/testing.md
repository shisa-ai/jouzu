# Jouzu testing

Jouzu's tests split into deterministic suites, patched-Pi conformance checks, and opt-in live provider smokes that spend real credit.

## Prerequisites

Install locked dependencies, type-check, build, and run the offline startup check once:

```bash
npm run dev:setup
```

Tests that import compiled output read `packages/cli/dist`. After you edit `packages/cli/src` or `packages/session-ui/src`, rebuild before running them:

```bash
npm run build
```

`npm run dev:link` replaces the global `jz` and `jouzu` links with this checkout. Neither command installs Git hooks; run `./dev-build.sh install-hooks` to rebuild automatically after Git operations.

## Deterministic suites

`npm test` runs every default suite:

| Command | Scope |
| --- | --- |
| `npm run test:runner` | Test-runner deadlines, diagnostics, timing records, and command contracts |
| `npm run test --workspace packages/session-ui` | Session UI |
| `npm run test --workspace packages/cli` | CLI and session flow control |
| `npm run test:endurance --workspace packages/cli` | Flow-control cases that cross exact production storage limits |
| `npm run test:python` | Python package reservation |
| `npm run test:pack-check` | Package contents and `dev-build.sh` |
| `npm run test:release-metadata` | Release metadata, smoke phases, and live-smoke event analysis |

`npm run check` runs `check:types` (TypeScript without output) and `check:static` (Biome, the Pi patch and content-policy checks, and the build-transform checks). `npm run build` already type-checks, so after a build run `npm run check:static`. `npm run release:check` runs the full release gate.

Each gate runs each command once. `scripts/gate-commands.test.mjs` expands `npm run check`, `npm test`, `release:check:candidate`, and every CI job into their commands and fails on a repeat.

### Which gate to run

| Situation | Command |
| --- | --- |
| Editing a module | `npm run test:affected`, or `npm run test:node -- <files>` |
| Before a commit | `npm run check` and `npm run test:affected` |
| Before pushing product code | `npm run check` and `npm test` |
| Release candidate, dependency, Pi, or packaging change | `npm run release:check` |

`npm run test:affected` compares the working tree and untracked files with `HEAD` (or `--base REF`) and runs the Node test files that import a changed file, directly or through other sources and test fixtures. Compiled imports under `dist/` map to their `src/` files, and tests that launch the built CLI count as importing it. A changed workflow, manifest, or document selects the tests that name it. Changes to dependencies, build scripts, `upstream/`, or shared script fixtures select every test file. It skips `@endurance` tests unless you pass `--endurance`, and it refuses to run CLI tests against a stale build. Pass paths to select tests for specific files, and run `node scripts/affected-tests.mjs` without `--run` to list the selection.

Hosted CI runs full qualification for release commits and for pushes that change packaging, installation, updates, dependencies, or workflows (see [CI runs](ci.md)), so a local `release:check` is needed only for the release-boundary cases in the table.

### Endurance tests

Tests whose names end in `@endurance` repeat full runtime operations until they cross a production storage limit, such as 1,120 tool turns past the native request quota. The default CLI suite (`npm run test --workspace packages/cli`) skips them; `npm run test:endurance --workspace packages/cli` runs only them. `npm test` runs `test:full`, the whole CLI suite including endurance tests, so they share the suite's parallel workers. Tag a new test `@endurance` only when it must cross an exact production limit, and list its file in the `test:endurance` script. `scripts/gate-commands.test.mjs` fails when the list and the tagged files differ.

### Bounded Node runs

The Node suite commands use `scripts/run-tests.mjs`. It selects TAP output so
failure details appear alongside failed tests, applies a 120-second default
test timeout, and supervises each suite with a separate ten-minute deadline.
It prints elapsed-time notices to stderr every 15 seconds, and at the end of
a suite it repeats every failed test on stderr, with its file, line, failure
type and first error line, so a log cut to its last lines still names each
failure. The separate
supervisor can terminate a blocked test event loop or leaked handles that
prevent the test runner from exiting.

Use the same runner for a focused test:

```bash
npm run test:node -- --test-name-pattern="rewind" packages/cli/test/flow-session-service.test.mjs
```

File paths and quoted globs resolve from the working directory. Every selection
must match a file. Supported Node options are `--test-name-pattern`,
`--test-skip-pattern`, and `--test-concurrency`. Reporter, watch, force-exit, and
direct timeout flags are rejected rather than overriding the safeguards.

| Environment variable | Default | Allowed range |
| --- | --- | --- |
| `JOUZU_TEST_TIMEOUT_MS` | `120000` | 1-3600000 milliseconds |
| `JOUZU_TEST_SUITE_TIMEOUT_MS` | `600000` | 1-3600000 milliseconds |
| `JOUZU_TEST_CONCURRENCY` | Node default (CPUs minus one) | 1-64 test files at once; `--test-concurrency` overrides it |

Set a larger finite budget only for a measured workload that needs it, and
record the reason with the validation result. A timeout is a failure, not a
skip. Configuration errors exit with status 2; the suite deadline exits with
status 124. Interrupts exit with status 130 or 143. Timeout and interrupt
handling kills the test process group on POSIX and uses `taskkill /T /F` on
Windows; independently detached processes may require separate cleanup.

Hosted Linux CI jobs set `JOUZU_TEST_CONCURRENCY=4`; macOS and Windows jobs keep Node's default. In the Test benchmark workflow (three runs each on Node 22), 4 gave the lowest stable CLI suite median: 170 s on Ubuntu (default 3: 166 s median but a 247 s 90th percentile) and 259 s on macOS (default 2: 297 s). Concurrency 8 failed timing-sensitive tests on both runners, and on macOS concurrency 4 failed timing-sensitive tests in one benchmark run and in CI, so macOS stays at the default.

CI's opt-in extension network qualification uses a 600000ms test budget and
900000ms suite budget to accommodate its declared ten-minute network test; those
overrides apply only to that step. The `npm test --workspaces` steps use a
240000ms test budget and a 900000ms suite budget. The test budget is about twice
the slowest measured CI test file (107 seconds); the whole CLI suite needs about
280 seconds on CI.

### Test tiers and budgets

Each test belongs to one tier with a duration budget, calibrated on the hosted Ubuntu/Node 22 runner:

| Tier | Warn above | Fail above | Use for |
| --- | ---: | ---: | --- |
| `unit` | 1 s | 10 s | Default for every test |
| `integration` | 5 s | 30 s | Tests that drive a full session, storage, or many turns in process |
| `child-process` | 15 s | 90 s | Tests that launch the built CLI or real child agents |
| `endurance` | 60 s | 180 s | Tests tagged `@endurance` that cross exact production limits |

`scripts/test-tiers.json` holds the budgets and assigns `integration` or `child-process` to specific tests by `file :: full test name`. A test name ending in `@endurance` selects that tier. Any other test is `unit`.

```bash
npm run test:timings -- budget --tiers scripts/test-tiers.json --where label=jouzu.test <timing records>
```

The budget compares each test's median with its tier. Each CI job contributes one sample, so failure limits leave room for a runner stall (a 0.07-second test once took 4 seconds); warnings report smaller growth. CI checks the Ubuntu/Node 22 CLI suite and the endurance job: a test over its failure budget fails pushes and manual runs and warns on pull requests. A new test that needs more than its tier allows must state the guarantee it adds and be assigned a tier in the manifest; prefer making it faster.

### Timing-sensitive tests

Before committing a test that depends on sleeps, deadlines, process lifetimes, or concurrency, run it repeatedly on an oversubscribed machine:

```bash
npm run test:stress -- --repeat 10 packages/cli/test/flow-native-inclusion.test.mjs
```

`test:stress` runs the selected files `--repeat` times (default 10) while `--load` busy workers (default four per CPU) compete for the CPUs, and lists each test that failed in any run with its failure count. Runner options such as `--test-name-pattern` pass through; the command fails if no test ran. A test that waited on a 0.3-second dependency before checking its state failed 8 of 8 runs at this load and passed 8 of 8 after the fix.

Keep the full output while preserving failures in a Bash pipeline:

```bash
set -o pipefail
npm run test:flow 2>&1 | tee /tmp/jouzu-flow-tests.log
```

Do not pipe a running suite through `tail`: that hides progress and may hide
the failing exit status. Inspect the first failure's diagnostics while the
suite is running. A focused rerun diagnoses a failure; it does not replace the
full required gate. Runner regression tests check these package and CI entry
points as part of `npm run test:runner` and `npm test`.

### Timing records

Set `JOUZU_TEST_TIMINGS_DIR` to record each test's duration beside the TAP
output. Every runner invocation writes one JSON Lines file to that directory:
a run line (label, commit, OS, Node version, CPU count, concurrency, CI job and
image), one line per finished test (file, full name including parent tests,
nesting, duration, and status), and an end line (wall time and exit status).
Runner invocations started by tests do not inherit the variable.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `JOUZU_TEST_TIMINGS_DIR` | unset (no record) | Directory for timing records |
| `JOUZU_TEST_TIMINGS_LABEL` | npm package and script name, such as `jouzu_cli.test` | Suite label: letters, digits, `.`, `_`, `-` |
| `JOUZU_TEST_TIMINGS_JOB` | `GITHUB_JOB` | Job name recorded with the run |

```bash
JOUZU_TEST_TIMINGS_DIR=/tmp/jouzu-timings npm test
npm run test:timings -- summary --top 20 /tmp/jouzu-timings
npm run test:timings -- diff --base before/ --head after/ --where node=22
```

`summary` reports per-suite wall time, the slowest top-level tests and files
by median across runs, the count of tests over 1 and 10 seconds, and the share
of time in the slowest 10 and 50 tests. `diff` lists added and removed tests
and tests whose median changed by at least 1 second and 20%. `--where` limits
either command to runs with a matching context field, such as `label`,
`platform`, `node` (major or exact version), or `job`. Add `--json` for
machine-readable output. CI uploads the records from each test job as
`test-timings-*` artifacts.

## Session flow control

Flow control has a deterministic suite, a patched-Pi conformance check, and a live smoke. The deterministic suite is the gate; the live smoke measures whether a real model follows the wait contract.

### Deterministic suite

```bash
npm run build
npm run test:flow
```

The files under `packages/cli/test/flow-*.test.mjs` substitute the provider, drive a real Pi session with a substituted stream, or exercise hand-built stores and pure functions. No test calls a provider. The suite imports `packages/cli/dist/flow-control/*.js`, so `npm run build` must run first; the full CLI test script rejects stale output.

| Area | Example files |
| --- | --- |
| Admission and composition | `flow-admission`, `flow-native-admission`, `flow-runtime-assembly` |
| Waits and health | `flow-wait-tools`, `flow-wait-store`, `flow-wait-decisions`, `flow-wait-health`, `flow-wait-observation`, `flow-wait-retention` |
| Result delivery and observation | `flow-result-envelope`, `flow-result-manifest`, `flow-observation`, `flow-no-reply` |
| Host interception and queues | `flow-session-ingress`, `flow-host-boundary`, `flow-queued-run`, `flow-queue-receipts`, `flow-submissions` |
| Native Pi interaction | `flow-native-input`, `flow-native-requests`, `flow-native-inclusion`, `flow-pi-reuse` |
| Provider routes | `flow-provider-route`, `flow-google-cancellation`, `flow-vertex-auth`, `flow-bedrock-copy` |
| Recovery and retention | `flow-history-recovery`, `flow-uncertain-resolution`, `flow-attempt-retention`, `flow-retirement-context` |
| Assembly and lifecycle | `flow-assembly-*`, `flow-session-registry`, `flow-session-service`, `flow-ownership` |

### Workflow instructions

`flow-wait-tools.test.mjs` checks wait guidance in the assembled system prompt, deduplication, and removal when wait tools are disabled. Extension-specific guidance follows the active background and task tools. `capability-routing.test.mjs` checks routing availability and that asynchronous-work and untrusted-content guidance each appear once; `evals/core-capability-routing.json` includes long-running dependencies, replacement-job notifications, tasks awaiting a person, and status questions during a wait. The corpus records expected behavior; schema and routing tests do not measure model compliance.

### Flow journal checkpoints

`flow-journal-checkpoint.test.mjs` verifies streaming checkpoints on reopen and ongoing writes, preserved values and sequence numbers, deletions, torn final transactions, and refusal to rewrite malformed complete records. Flow journals checkpoint accumulated scalar updates at 32 MiB under the writer lease; this keeps historical updates from exceeding the JSONL reader's string limit. Checkpointing preserves current input, result, wait, and receipt records rather than resetting flow state.

### Preservation across cancellation and recovery

`flow-preservation.test.mjs` delivers a bounded result envelope with omitted members, preempts selection with user input, then resets, retires history, and reopens. It compares every retained member's status, title, reference, and warnings. The mixed-input case in `flow-task-adapter.test.mjs` completes a consumed task while its result shares the turn and a user message queues; provider requests and reopened history must preserve the result, user instruction, original flow content, and cancellation note. `flow-source-reconciliation.test.mjs` also verifies that failed input remains inspectable after compaction, reset, and two reopens.

These checks establish transport and storage preservation for those transitions. They do not establish model obedience to a cancellation note or indefinite retention after historical references become eligible for retirement.

### Installed task adapter

Task continuation delivery has one owner. With flow control on, the task adapter supplies a text builder; Jouzu admits the work, delivers a `jouzu-flow` message, and rechecks task validity before provider dispatch. With flow control off or no flow host attached, pi-tasks sends its own `pi-tasks:continuation` message and guards that message itself. The upstream message's `triggerTurn: true` starts native delivery from idle.

The delivery cases in `flow-task-adapter.test.mjs` start tasks from an idle `/tasks auto` command in all three modes. They require one continuation with the owning system's message identity, one automatic turn to complete the task, and a response when the user copies the completed task's instruction. The no-host case uses the installed adapter with Pi and no Jouzu flow assembly; it does not certify an unpatched Pi distribution.

`flow-task-adapter.test.mjs` loads the installed pi-tasks extension and the production flow assembly. It tests background execution and waits from a task continuation, waiting on a job started by the task's parent user turn (including health monitoring), explicit user-input and pause holds, dependency ordering, three admitted attempts without progress, task attribution across resume, and task creation from an extension turn using session attribution. `flow-task-producer.test.mjs` covers stale revisions, completion, deletion, foreign identities, and preservation of a separate flow pause. `flow-task-patch.test.mjs` checks the pinned build patch and refusal to overwrite unexpected package bytes. The consumed-queue race test completes a task before provider dispatch and checks that no stale request reaches the provider. `flow-task-context-guard.test.mjs` checks cancellation notes for mixed input, abort failures, and persisted cancellation markers. Mixed input retains its source bytes; ignoring the cancelled task instruction depends on the model following the added note. These tests run in the default suite without another checkout.

For subagents, `subagent` launch/resume returns `waitDependency` in its result when flow control is on. Copy that object into `agent_wait.on` and omit `work` to wait as the current invocation. The `subagent` producer's `terminal` predicate names one run: completion satisfies it; failure, interruption, or cancellation ends the wait with a failure decision. Resume creates a separate run identity. These waits have a deadline but no health policy, so omit `health` and `checkAfter`. Deadline expiry wakes the agent without stopping the child. Read and verify the child output after waking.

`flow-subagent-waits.test.mjs` checks attribution capture, terminal races, restored subscriptions, and session identity. `flow-subagent-wake.test.mjs` exercises the assembled runtime's completion, failure, cancellation, and deadline wake-ups without polling. Subagent and schedule waits require a receipt registered when the producer starts the work; a caller cannot assign an existing run to another work by constructing a handle.

`schedule_prompt` with `action: "add"` returns a `waitDependency` when flow control is on. Its `schedule` producer and `first-trigger` predicate wait for the newly created schedule to start its first attempt. This applies to one-shot and recurring schedules, with or without a model. It does **not** mean the scheduled prompt has finished or succeeded. Copy the receipt into `agent_wait.on`, omit `work`, `health`, and `checkAfter`, and supply a deadline. Removing or disabling the schedule before its first trigger ends the wait with a failure decision; deadline expiry wakes the agent without changing the schedule. Schedule edits retain the same first-trigger identity. Use the receipt only for the first trigger, not a later recurrence.

`flow-schedule-waits.test.mjs` checks attribution, job identity, storage errors, duplicate events, and recovery. `flow-schedule-wake.test.mjs` loads the installed scheduler and tests automatic trigger, removal, disable, error, and deadline wakes. It also checks inline prompt delivery and a one-shot timer with automatic disable. Trigger evidence retained by flow control survives reopening; if a crash leaves no trigger evidence, the deadline still provides a decision point. If a retained pending execution's producer state is unreadable, the session opens with automatic work held and a diagnostic identifying the source. `/flow` remains available for inspection. Repair the producer state and reopen, or use `/flow off` to work without automatic flow control; source failure does not establish completion.

For `agent_wait`, copy the producer's complete `waitDependency` object into `on` and supply `reason` and `deadline`. Omit optional fields, or pass `null` when the tool interface requires them. Top-level `work` selects the task or invocation to suspend; normally omit it or pass `null`. Never put a child run ID, job ID, message ID, or placeholder there. Nested `on[].work` identifies the execution owner; copy it and `scope` only when the producer returned them. Do not infer them from subagent context or session metadata. A task can wait on any execution registered in the same branch, including another task's job, without changing that execution's attribution.

For example, if a producer returns this dependency (the ID below is illustrative):

```json
{"producer":"subagent","handle":"run-123","execution":"run-123","until":"terminal"}
```

The minimal wait is:

```json
{
  "on": [{"producer":"subagent","handle":"run-123","execution":"run-123","until":"terminal"}],
  "reason": "Wait for the child result before reviewing it",
  "deadline": "3m"
}
```

Use the actual returned IDs. If the interface requires every field, set top-level `work`, `mode`, `replaceToken`, and `checkAfter` to `null`, and add `health`, `work`, and `scope` as `null` inside the dependency. `until: "terminal"` is a completion condition, not a health policy.

Work labels associate a wait with a task or session; they do not grant permission to use a dependency. Omit `agent_wait.work` or set it to `null` to use the current task or session. A paused task keeps its wait association so resuming does not duplicate the wait and stopping the task cancels it. An exact live `replaceToken` can replace a wait after task attribution changes, but cannot displace a separate live wait on the destination task. Missing or stale attribution must not prevent a valid tool call. Dependencies still require exact producer, handle, and execution identities so a wait cannot observe the wrong job. Pi's strict-schema converter does not support nullable objects; `strict: "prefer"` falls back to the registered non-strict schema without dropping nullability.

The standalone wait-decision case in `flow-assembly-pair.test.mjs` starts another background job, declares a wait, and cancels it from a decision turn. Availability tests cover missing attribution and session transitions; scheduler tests preserve explicit pause, stop, completion, and cancellation behavior.

### Task continuation integration

To qualify changes to task cancellation or Jouzu's task-message handling, run:

```bash
npm run test:tasks:integration
```

The two cases in `flow-task-continuation-integration.test.mjs` load the installed
pi-tasks extension and the production flow assembly, with the installed background
and multiloop producers. They also run in the default suite and require no additional
source checkout.

One case submits the installed extension's continuation at `agent_end`; the other
holds that same request until a separate user response is streaming. Both complete
the task after submission and require cancellation before prompt construction, zero
extra HTTP requests, no automation pause, intact stored task text, and successful
admission of the next user message. A local HTTP response gate and the adapter's
cancellation callback determine settlement; the tests do not infer success from a
sleep.

The consumed-queue and mixed-input cases in `flow-task-adapter.test.mjs` separately
check cancellation after prompt construction and preservation of source bytes through
provider delivery and session reopen. These tests verify cancellation and transport
behavior, not whether a model obeys a cancellation note.

### Saved flow-session recovery

To check recovery against an existing session without changing its files:

```bash
JOUZU_FLOW_RECOVERY_SESSION=/path/to/session.jsonl \
JOUZU_FLOW_RECOVERY_ROOT=/path/to/flow \
npm run test:node -- packages/cli/test/flow-saved-session-recovery.test.mjs
```

Run this after the source session has stopped writing. The test copies the transcript, session registry, and active flow branch to a temporary directory. It uses a local provider fixture and requires successful continuation, reset, two more requests, and another session reopen. The source files are only read. Both paths are required when either variable is set; the default suite skips this case when neither is set.

### Patched-Pi conformance

```bash
npm run pi:check
```

This verifies the pinned Pi patch bytes and the Pi lock against the installed package trees, then runs `scripts/pi-flow-control.test.mjs`, `scripts/pi-flow-ingress.test.mjs`, `scripts/pi-flow-ingress-dispositions.test.mjs`, `scripts/pi-provider-receipts.test.mjs`, `scripts/pi-upstream.test.mjs`, and `scripts/pi-content-policy.test.mjs`. It fails when applied bytes drift from the recorded patch, when unrecognized core bytes would be overwritten, or when the ingress, queue, and request-checkpoint contracts regress. Run it after changing the Pi pin or any `scripts/apply-pi-*` transform.

### Live first-candidate smoke

`scripts/live-flow-smoke.mjs` evaluates a real model's wait behavior. It is opt-in and spends provider credit.

```bash
JOUZU_LIVE_SMOKE=1 \
JOUZU_LIVE_PROVIDER="$PROVIDER" \
JOUZU_LIVE_MODEL="$MODEL" \
JOUZU_LIVE_MAX_USD=0.02 \
node scripts/live-flow-smoke.mjs
```

| Variable | Required | Default | Limit |
| --- | --- | --- | --- |
| `JOUZU_LIVE_SMOKE` | yes | — | must be `1` |
| `JOUZU_LIVE_PROVIDER` | yes | — | provider id |
| `JOUZU_LIVE_MODEL` | yes | — | model id |
| `JOUZU_LIVE_MAX_USD` | yes | — | >0 and ≤0.25 |
| `JOUZU_LIVE_MAX_REQUESTS` | no | 24 | ≤1000 |
| `JOUZU_LIVE_MAX_TOKENS` | no | 250000 | ≤10000000 |
| `JOUZU_PACKED_TARBALL` | no | built from source | path to a packed artifact |

The smoke builds and packs the workspace (unless `JOUZU_PACKED_TARBALL` names an artifact), installs it into a temporary consumer, and drives an RPC session through three stages:

1. The model starts a file-gated background job and declares `agent_wait` from the exact producer, handle, execution, and until values the tool returned.
2. A status question runs while the job is still gated. The model must not redeclare, renew, or cancel the wait.
3. The test releases the job. The wait must resolve into exactly one composed wake for the declared token.

The smoke prints requests, tokens, cost, and defect labels. It never prints transcript content. A non-empty defect list or an exceeded ceiling fails the run.

Known limits:

- Usage is checked after each assistant response. The ceilings do not cap in-flight tokens or spending, and transport retries may not appear as separate assistant messages.
- Redirection and compaction are recorded as confounders but not deliberately triggered.
- Observation ends when the wake turn settles. Duplicate delivery after that point is covered by the deterministic suite.
- The result is marked `incomplete`: late-wake observation, deliberate redirection, and compaction acceptance remain open.

`scripts/live-flow-smoke.test.mjs` tests the defect analysis without spending money; it runs in `npm run test:release-metadata`.

### Manual inspection

Reopening an interactive session with existing history starts with flow control paused. Automated continuations and notifications stay held until `/flow resume` or the next user message. `/flow` inspection preserves the pause. Background processes keep running while delivery is held.

In an interactive session, `/flow` shows what flow control is holding and repairs a hold:

```text
/flow shows what session flow control is holding.
/flow retry <request> authorizes one withheld request.
/flow cancel <token> removes a wait's dependency gate without stopping its job.
/flow pause <work> holds a campaign's automated turns; /flow resume <work> releases it.
/flow stop <work> retires a campaign and ends its waits.
/flow resolve <attempt> retry|discard decides an interrupted turn whose outcome is unknown.
/flow off takes flow control out of the circuit; /flow on puts it back; /flow reset is the destructive idle fallback.
/flow clear releases a stuck reservation while preserving receipts, waits, and running jobs.
```

`JOUZU_FLOW_CONTROL=0` starts a session with flow control disabled.

## Live Japanese tool flow

The opt-in Japanese smoke requires an explicitly selected provider/model and cost budget. It installs the packed artifact in a temporary consumer, permits only `read` and `write`, stores no session or transcript, verifies exact Japanese output bytes, and fails if reported cost exceeds the declared budget.

```bash
JOUZU_LIVE_SMOKE=1 \
JOUZU_LIVE_PROVIDER="$PROVIDER" \
JOUZU_LIVE_MODEL="$MODEL" \
JOUZU_LIVE_MAX_USD=0.02 \
npm run test:live:ja
```

The maximum declared budget is $0.25. The cost check runs after the request; it is not a provider-side spending cap.

## Live per-language evaluation

`scripts/live-locale-smoke.mjs` measures one language for the six dimensions in
[per-language evaluation criteria](evaluation/per-language-eval-criteria.md):
comprehension, fluency, coding, tool use, mixed-language retention, and
artifact-policy compliance. It is opt-in, spends provider credit, and is not part
of the deterministic gate. `JOUZU_LIVE_LOCALE` selects the language and defaults
to `ja`; the accepted evaluation values are `en`, `ja`, `zh-Hans`, and `zh-Hant`.
The Chinese checks exercise model output, not an offered Chinese interface.

```bash
JOUZU_LIVE_SMOKE=1 \
JOUZU_LIVE_PROVIDER="$PROVIDER" \
JOUZU_LIVE_MODEL="$MODEL" \
JOUZU_LIVE_MAX_USD=0.25 \
JOUZU_LIVE_LOCALE=zh-Hans \
npm run test:live:locale
```

It shares the opt-in and budget contract of the Japanese smoke: `JOUZU_LIVE_SMOKE`
must be `1`, `JOUZU_LIVE_PROVIDER` and `JOUZU_LIVE_MODEL` are required, and
`JOUZU_LIVE_MAX_USD` must be positive and no greater than 0.25. It prints the
run conditions (model, route, versions, prompt digest, and date) and one result
per dimension, or the reason a dimension was not reached. A passing run is a
bounded model-output check, not native terminal qualification or a human
judgment of translation quality. Remove private provider routes and identifying
data before sharing its report.

`scripts/live-locale-smoke.test.mjs` checks the opt-in contract, the refusal
path, and the graders without a provider; it runs in `npm run test:release-metadata`.

## Related documents

- [Architecture](architecture.md) — module map and state-file ownership.
- [CI runs](ci.md) — hosted checks and Windows diagnostics.
