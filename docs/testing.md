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
| `npm run test --workspace packages/session-ui` | Session UI |
| `npm run test --workspace packages/cli` | CLI and session flow control |
| `npm run test:python` | Python scanner |
| `npm run test:pack-check` | Package contents and `dev-build.sh` |
| `npm run test:release-metadata` | Release metadata, smoke phases, and live-smoke event analysis |

`npm run check` adds type checks, Biome, and the Pi patch and content-policy checks. `npm run release:check` runs the full release gate.

## Session flow control

Flow control has a deterministic suite, a patched-Pi conformance check, and a live smoke. The deterministic suite is the gate; the live smoke measures whether a real model follows the wait contract.

### Deterministic suite

```bash
npm run build
node --test packages/cli/test/flow-*.test.mjs
```

The 63 files under `packages/cli/test/flow-*.test.mjs` (1032 tests) substitute the provider, drive a real Pi session with a substituted stream, or exercise hand-built stores and pure functions. No test calls a provider. The suite imports `packages/cli/dist/flow-control/*.js`, so `npm run build` must run first; the full CLI test script rejects stale output.

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

In an interactive session, `/flow` shows what flow control is holding and repairs a hold:

```text
/flow shows what session flow control is holding.
/flow retry <request> authorizes one withheld request.
/flow cancel <token> removes a wait's dependency gate without stopping its job.
/flow pause <work> holds a campaign's automated turns; /flow resume <work> releases it.
/flow stop <work> retires a campaign and ends its waits.
/flow resolve <attempt> retry|discard decides an interrupted turn whose outcome is unknown.
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
