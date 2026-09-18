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
| `npm run test:runner` | Test-runner deadlines, diagnostics, and command contracts |
| `npm run test --workspace packages/session-ui` | Session UI |
| `npm run test --workspace packages/cli` | CLI and session flow control |
| `npm run test:python` | Python scanner |
| `npm run test:pack-check` | Package contents and `dev-build.sh` |
| `npm run test:release-metadata` | Release metadata, smoke phases, and live-smoke event analysis |

`npm run check` adds type checks, Biome, and the Pi patch and content-policy checks. `npm run release:check` runs the full release gate.

### Bounded Node runs

The Node suite commands use `scripts/run-tests.mjs`. It selects TAP output so
failure details appear alongside failed tests, applies a 60-second default
test timeout, and supervises each suite with a separate five-minute deadline.
It prints elapsed-time notices to stderr every 15 seconds. The separate
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
| `JOUZU_TEST_TIMEOUT_MS` | `60000` | 1-3600000 milliseconds |
| `JOUZU_TEST_SUITE_TIMEOUT_MS` | `300000` | 1-3600000 milliseconds |

Set a larger finite budget only for a measured workload that needs it, and
record the reason with the validation result. A timeout is a failure, not a
skip. Configuration errors exit with status 2; the suite deadline exits with
status 124. Interrupts exit with status 130 or 143. Timeout and interrupt
handling kills the test process group on POSIX and uses `taskkill /T /F` on
Windows; independently detached processes may require separate cleanup.

CI's opt-in extension network qualification uses a 600000ms test budget and
900000ms suite budget to accommodate its declared ten-minute network test; those
overrides apply only to that step. The `npm test --workspaces` steps use a
360000ms test budget and a 900000ms suite budget, because shared runners run the
CLI suites roughly four times slower than a developer machine: the heaviest
files take about a minute here, and the whole CLI suite needs about 280s on CI.

Keep the full output while preserving failures in a Bash pipeline:

```bash
set -o pipefail
npm run test:flow 2>&1 | tee /tmp/jouzu-flow-tests.log
```

Do not pipe a running suite through `tail`: that hides progress and may hide
the failing exit status. Inspect the first failure's diagnostics while the
suite is running. A focused rerun diagnoses a failure; it does not replace the
full required gate. Runner regression tests check these package and CI entry
points as part of `npm run check` and `npm test`.

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

`flow-wait-tools.test.mjs` checks wait guidance in the assembled system prompt, deduplication, and removal when wait tools are disabled. Extension-specific guidance follows the active background, task, and scheduling tools. `capability-routing.test.mjs` checks routing availability; `evals/core-capability-routing.json` includes long-running dependencies, replacement-job notifications, tasks awaiting a person, and status questions during a wait. The corpus records expected behavior; schema and routing tests do not measure model compliance.

### Flow journal checkpoints

`flow-journal-checkpoint.test.mjs` verifies streaming checkpoints on reopen and ongoing writes, preserved values and sequence numbers, deletions, torn final transactions, and refusal to rewrite malformed complete records. Flow journals checkpoint accumulated scalar updates at 32 MiB under the writer lease; this keeps historical updates from exceeding the JSONL reader's string limit. Checkpointing preserves current input, result, wait, and receipt records rather than resetting flow state.

### Preservation across cancellation and recovery

`flow-preservation.test.mjs` delivers a bounded result envelope with omitted members, preempts selection with user input, then resets, retires history, and reopens. It compares every retained member's status, title, reference, and warnings. The mixed-input case in `flow-task-adapter.test.mjs` completes a consumed task while its result shares the turn and a user message queues; provider requests and reopened history must preserve the result, user instruction, original flow content, and cancellation note. `flow-source-reconciliation.test.mjs` also verifies that failed input remains inspectable after compaction, reset, and two reopens.

These checks establish transport and storage preservation for those transitions. They do not establish model obedience to a cancellation note or indefinite retention after historical references become eligible for retirement.

### Installed task adapter

`flow-task-adapter.test.mjs` loads the installed pi-tasks extension and the production flow assembly. It tests background execution and waits from a task continuation, explicit user-input and pause holds, dependency ordering, three admitted attempts without progress, task ownership across resume, and rejection of an unadapted extension borrowing a previous user turn. `flow-task-producer.test.mjs` covers stale revisions, completion, deletion, foreign identities, and preservation of a separate flow pause. `flow-task-patch.test.mjs` checks the pinned build patch and refusal to overwrite unexpected package bytes. The consumed-queue race test completes a task before provider dispatch and checks that no stale request reaches the provider. `flow-task-context-guard.test.mjs` checks cancellation notes for mixed input, abort failures, and persisted cancellation markers. Mixed input retains its source bytes; ignoring the cancelled task instruction depends on the model following the added note. These tests run in the default suite without another checkout.

The standalone wait-decision case in `flow-assembly-pair.test.mjs` starts another background job, declares a wait, and cancels it from a decision turn. Context tests reject a foreign work or branch and preserve paused/completed work states.

### Task continuation integration

To qualify changes to task cancellation or Jouzu's task-message handling, provide a pi-tasks source checkout and run:

```bash
JOUZU_PI_TASKS_CHECKOUT=/path/to/pi-tasks npm run test:tasks:integration
```

This command requires the checkout; missing or invalid sources fail the run. The default suite skips these two tests when the variable is absent. The tests bundle `src/task-continuation.ts` from that checkout against Jouzu's installed runtime packages and use the full flow assembly with the installed background and multiloop producers.

A local HTTP server gates a response to test a follow-up enqueued while a request is active; a second case enqueues at `agent_end`. Both require zero extra HTTP requests for the stale task, no automation pause, intact stored source text, and successful admission of the next user message. Lifecycle events determine settlement; the tests do not use a timed sleep to infer success.

These tests verify cancellation and transport behavior. When valid input accompanies a stale task, the source instruction remains in context with a cancellation note; the tests do not prove that a model will obey that note.

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

This verifies the pinned Pi patch bytes and the Pi lock against the installed package trees, then runs `scripts/pi-flow-control.test.mjs`, `scripts/pi-flow-ingress.test.mjs`, `scripts/pi-provider-receipts.test.mjs`, and `scripts/pi-content-policy.test.mjs`. It fails when applied bytes drift from the recorded patch, when unrecognized core bytes would be overwritten, or when the ingress, queue, and request-checkpoint contracts regress. Run it after changing the Pi pin or any `scripts/apply-pi-*` transform.

### Live first-candidate smoke

`scripts/live-flow-smoke.mjs` is the only test that measures a real model. It is opt-in and spends provider credit.

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
/flow off takes flow control out of the circuit; /flow on puts it back; /flow reset is both in order.
/flow clear releases a stuck reservation without stopping jobs or deleting receipts.
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

## Related documents

- [Architecture](architecture.md) — module map and state-file ownership.
- [CI runs](ci.md) — hosted checks and Windows diagnostics.
