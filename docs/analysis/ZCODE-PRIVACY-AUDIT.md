# ZCode telemetry privacy audit

> **Bottom line:** A normal checkout does not send telemetry because the reporting endpoints are not configured in tracked files. If an operator supplies endpoint environment variables, telemetry can be sent to three separately configured destinations. The most important confirmed privacy gap is that a context-compaction failure reason can contain the original error message and is sent to the warehouse without the normal error sanitizer.

| Field | Value |
| --- | --- |
| Audit date | 2026-09-21 |
| Audited commit | `872ad960de7ec172591f7e1952f7849229f94521` |
| Scope | CLI telemetry, Desktop telemetry, shared telemetry helpers, services telemetry, and UI event producers |
| Method | Static source review; no telemetry path was executed |
| Status | Point-in-time engineering audit, not a compliance assessment |

## 1. How to use this audit

### Evidence labels

- **Verified** — the relevant producer, transformation, and outbound call were traced in source.
- **Inferred** — the source supports the conclusion, but one part of the external or dependency-controlled path could not be inspected.
- **Unverified** — this audit could not establish the behavior.

File and line references point to the audited commit. Line numbers can change after later edits; the commit hash above identifies the exact source snapshot.

### Important distinction: collection versus transmission

A telemetry field may be constructed in memory without leaving the computer. In this audit, “sent” means that the field reaches an outbound request in the source path that was reviewed. Each destination is separately gated by its own endpoint, so enabling one does not automatically enable the others.

## 2. Executive summary

### What is disabled by default in the checked-in source

The three endpoint values are read from runtime environment variables. The shared constants default to an empty string when the variables are absent (`packages/shared/src/env.ts:50-58`). The warehouse reporter returns without sending if its endpoint is empty (`packages/services/src/telemetry/telemetryCore.ts:366-370`). ARMS initialization follows the same endpoint check (`packages/desktop/src/main/appARMSBootstrap.ts:266-268`).

Packaged Desktop builds load only a distribution marker from their local environment files; they do not embed endpoint or credential values (`packages/desktop/src/main/desktopRuntimeEnv.ts:154-159`). This does not prevent an operator from supplying runtime configuration outside the package.

### What can be enabled by configuration

1. **OpenTelemetry Protocol (OTLP)** — agent traces and metrics. OTLP is a standard format for observability data. Endpoints are resolved from `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, or the common `OTEL_EXPORTER_OTLP_ENDPOINT` (`apps/zcode-cli/packages/telemetry/src/bootstrap.ts:74-101`).
2. **Alibaba Cloud ARMS RUM** — browser and Electron performance/error telemetry, custom events, and crash-related events. It is configured with `ZCODE_ARMS_RUM_ENDPOINT` (`packages/desktop/src/main/appARMSBootstrap.ts:166-190`).
3. **Warehouse analytics** — product events sent to `ZCODE_TELEMETRY_REPORT_ENDPOINT` (`packages/services/src/telemetry/telemetryCore.ts:366-414`). The request includes an authorization mechanism supplied by the host service; the exact credential source should be checked separately if deployment ownership matters.

These destinations may be controlled by different operators. The code does not provide one user-facing switch that governs all three.

### Main confirmed risks

| Priority | Finding | Evidence |
| --- | --- | --- |
| High | A context-compaction failure reason can carry a raw error message into a warehouse event. | [Finding 1](#finding-1-raw-error-messages-can-reach-the-warehouse) |
| Medium | Network telemetry retains configured hostnames, which can reveal providers or services in use. | [Finding 2](#finding-2-network-telemetry-reveals-configured-hostnames) |
| Medium | The account identifier sent in OTLP is an unsalted SHA-256 hash, so it is pseudonymous rather than anonymous. | [Finding 3](#finding-3-the-otlp-account-identifier-is-an-unsalted-hash) |
| Medium | There is no user-facing consent or all-telemetry opt-out in the reviewed source. | [Finding 7](#finding-7-no-user-facing-consent-or-all-telemetry-opt-out) |

### What the source says is not intentionally collected by these writers

The reviewed payload builders do not intentionally include user prompts, model responses, tool arguments, tool results, command text, file contents, or file paths. This is a statement about the reviewed writers, not a guarantee that a future producer cannot add a new field. The raw-error exception above is why content-bearing fields still need defensive checks at the final boundary.

## 3. Destinations and activation

| Destination | Environment variable(s) | Main data | Sampling or cadence |
| --- | --- | --- | --- |
| OTLP traces | `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` | Agent/model/tool spans and selected attributes | Root traces use a 10% ratio; spans are batch-exported every 5 seconds (`apps/zcode-cli/packages/telemetry/src/otlp-exporter.ts:31-32,86-89,158-160`) |
| OTLP metrics | `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` or common endpoint | Agent and model metrics | Periodic export; the default interval is 5 minutes (`apps/zcode-cli/packages/telemetry/src/otlp-exporter.ts:31,86-89`) |
| ARMS RUM | `ZCODE_ARMS_RUM_ENDPOINT` | Browser/Electron errors, performance, resource, network, custom, and crash events | Sessions are configured at `sampleRate: 1` (`packages/desktop/src/main/appARMSBootstrap.ts:185-190`); ARMS tracing has a separate sample setting (`packages/desktop/src/main/appARMSBootstrap.ts:211-215`) |
| Warehouse | `ZCODE_TELEMETRY_REPORT_ENDPOINT` | Product analytics events | One report per event, with bounded retries (`packages/services/src/telemetry/telemetryCore.ts:425-477`) |

The CLI trace path also stops when `ZCODE_MODEL_TELEMETRY_ENABLED` is one of `0`, `false`, `off`, or `disabled` (`apps/zcode-cli/packages/telemetry/src/bootstrap.ts:122-125,413-415`). That flag does not disable ARMS or warehouse events.

The compile-time/shared switch `ZCODE_TELEMETRY_ENABLED` is currently `true` (`packages/shared/src/env.ts:46-50`). It is not a user setting. In practice, the endpoint checks above are what keep each destination inactive when no endpoint is supplied.

## 4. What is reported during normal use

The following is a source-based inventory, grouped by user-visible activity. It describes event construction, not a claim that the event leaves the machine when its destination is disabled.

- **Launch:** ARMS application-start/performance events; warehouse `app_launch` and daily-active events. ARMS associates its user name with the persistent `device_mid` (`packages/desktop/src/main/appARMSBootstrap.ts:146-153,183-186`).
- **Login/logout:** warehouse login, login-success, and logout events. The login-check URL is reduced to a hostname by the shared sanitizer (`packages/shared/src/telemetry.ts:62-79`).
- **Session open:** ARMS session-open performance timings and counts, plus a warehouse `session_create` event (`packages/ui/src/lib/sessionOpenArmsTelemetry.ts`; `packages/ui/src/lib/messageTelemetry.ts:620-690`).
- **Prompt submission:** warehouse metadata such as ask mode, model/provider identifiers, plan state, and memory state. A selected suggested prompt can include its full template text (`packages/ui/src/v4/draftSuggestedPromptItems.ts`; `packages/ui/src/lib/messageTelemetry.ts:700-760`).
- **Agent/model/tool execution:** OTLP spans and warehouse step events containing names, counts, durations, statuses, and byte counts. Command telemetry uses categories and a sanitized name rather than command text (`apps/zcode-cli/packages/telemetry/src/agent-trace-runtime.ts`; `apps/zcode-cli/packages/telemetry/src/agent-trace-support.ts`).
- **Context compaction:** token counts and status are reported; the failure reason is the exception path described in Finding 1 (`packages/ui/src/lib/messageTelemetry.ts:650-690`).
- **Steady state and exit:** ARMS resource and network windows, agent lifecycle events, application exit, and OTLP flush behavior (`packages/desktop/src/main/desktopNetworkTelemetry.ts:80-102`; `packages/desktop/src/main/desktopResourceTelemetry.ts`; `packages/desktop/src/main/desktopStabilityTelemetry.ts`).

## 5. Data categories

### Identifiers and correlation fields

- `device_mid`: a persistent UUID stored in `~/.zcode/v2/telemetry-state.json` and reused by ARMS, the warehouse, and optionally OTLP (`apps/zcode-cli/packages/telemetry/src/bootstrap.ts:226-228`; `packages/desktop/src/main/appARMSBootstrap.ts:146-153`; `packages/services/src/telemetry/telemetryCore.ts:399-402`; `apps/zcode-cli/packages/telemetry/src/otlp-exporter.ts:246-250`).
- `user_subject_id`: an account-derived identifier used by OTLP when identity telemetry is included (`apps/zcode-cli/packages/telemetry/src/agent-trace-support.ts:341-345`; `packages/services/src/zcode-agent/agentTelemetryEnv.ts:20-35`).
- Session, turn, query, message, tool-call, request, and automation identifiers may correlate events within a workflow. Their definitions are distributed across the telemetry contract and event builders (`apps/zcode-cli/packages/contracts/src/telemetry/`; `packages/ui/src/lib/messageTelemetry.ts`).

### Operational and environment metadata

The reviewed writers include model/provider metadata, token counts, durations, retry and status information, tool names, permission decisions, command categories, output byte counts, plan/memory flags, operating-system and application versions, architecture, memory and CPU counts, screen resolution, timezone, language, and runtime/build information. Examples of the OTLP resource fields are in `apps/zcode-cli/packages/telemetry/src/otlp-exporter.ts:225-252`; warehouse fields are assembled in `packages/services/src/telemetry/telemetryCore.ts:385-405`.

### Content-bearing or content-derived fields

- `context_compaction.reason` can contain a raw error message; see Finding 1.
- `prompt_template_ck.template_prompt` contains the selected suggested-prompt text. The source reviewed here is a server-delivered product template, not typed user prompt text (`packages/ui/src/v4/draftSuggestedPromptItems.ts`).
- `event_text` is not sanitized by `sanitizeTelemetryEventDetail`; current producers use labels and names, but a future producer could add free text (`packages/services/src/telemetry/telemetryCore.ts:390-394`).
- ARMS browser and exception payloads may contain SDK-generated text before the final ARMS redaction hook (`packages/desktop/src/main/appARMSBootstrap.ts:202-231`; `packages/desktop/src/main/armsEventRedaction.ts`).

## 6. Sanitization and privacy controls

### Controls that are present

| Data path | Control | Evidence |
| --- | --- | --- |
| CLI/provider error text | Replaces or removes URLs, paths, email-like values, and several common credential formats; truncates input. | `apps/zcode-cli/packages/telemetry/src/error-sanitizer.ts` |
| ARMS exception/click/resource events | Redacts exception text and stack data, strips click element text to a tag, and reduces URLs to origin/route. | `packages/desktop/src/main/armsEventRedaction.ts`; `packages/shared/src/telemetryRedaction.ts` |
| ARMS crash details | Replaces workspace/home/absolute paths and secret-like assignments. | `packages/desktop/src/main/desktopStabilityTelemetry.ts:190-220` |
| Warehouse `error_msg` | Sanitizes the value at the shared boundary; the current implementation applies the error sanitizer. | `packages/shared/src/telemetry.ts:82-95`; `packages/services/src/telemetry/telemetryCore.ts:390-394` |
| Warehouse login URL | Keeps only a validated hostname. | `packages/shared/src/telemetry.ts:62-79` |
| Network interface/path | Converts local paths to `local_file`, replaces dynamic path segments with `:id`, and truncates to 120 characters. | `packages/desktop/src/main/networkTelemetryAggregator.ts:224-247` |

### Controls that are incomplete or fail open

The warehouse detail filter is keyed to only two special fields: `error_msg` and `app_login_ck.login_url`. All other keys are forwarded unchanged (`packages/shared/src/telemetry.ts:82-95`). This is a denylist: a new free-text field is safe only if someone remembers to add a new rule.

The CLI and shared redaction implementations overlap but are not the same. The CLI implementation includes rules for `x-arms-license-key` and a local-part/hex-host form that are not present in the shared implementation (`apps/zcode-cli/packages/telemetry/src/error-sanitizer.ts:56-85`; `packages/shared/src/telemetryRedaction.ts`). No parity test was found in the reviewed test files.

## 7. Findings and recommended next steps

The recommendations below are engineering options, not claims that the repository has adopted them.

### Finding 1: Raw error messages can reach the warehouse

**Severity:** High · **Evidence:** Verified

Failure handling takes a non-`CoreError` exception's `error.message` verbatim (`apps/zcode-cli/packages/core/src/runtime/helpers/compact.ts:67-72`). The value is put into the compaction payload and persisted (`apps/zcode-cli/packages/core/src/runtime/methods/compact-persistence.ts:179-205`), copied into telemetry detail (`packages/ui/src/lib/messageTelemetry.ts:650-690`), passed through unchanged because `reason` is not a special key (`packages/shared/src/telemetry.ts:82-95`), and included in the warehouse request (`packages/services/src/telemetry/telemetryCore.ts:390-394`).

Errors can contain URLs, request identifiers, provider text, or other echoed content. The smallest engineering correction is to sanitize or discard `reason` at the final warehouse boundary, then add a fixture test for this exact path.

### Finding 2: Network telemetry reveals configured hostnames

**Severity:** Medium · **Evidence:** Verified

`perf_network_window` reports the normalized interface for each network bucket (`packages/desktop/src/main/desktopNetworkTelemetry.ts:85-102`). Normalization removes local paths and masks dynamic path segments, but keeps `parsed.host` (`packages/desktop/src/main/networkTelemetryAggregator.ts:224-247`). The hostname set can therefore reveal which model providers, MCP servers, or other remote services are configured.

If hostname attribution is not required, consider a bucket or keyed hash. This is a product decision because the hostname is currently part of the metric's diagnostic value.

### Finding 3: The OTLP account identifier is an unsalted hash

**Severity:** Medium · **Evidence:** Verified

`buildAgentTelemetrySpawnEnv` hashes the account ID with plain SHA-256 (`packages/services/src/zcode-agent/agentTelemetryEnv.ts:20-35`). A hash of an enumerable or low-entropy identifier can be tested against candidate values. It is pseudonymous, not anonymous.

Consider a keyed hash whose secret is controlled by the telemetry operator, or omit the identifier when cross-session correlation is not needed.

### Finding 4: Warehouse detail fields fail open

**Severity:** Medium · **Evidence:** Verified

`sanitizeTelemetryEventDetail` transforms `error_msg` and one login field but forwards every other key (`packages/shared/src/telemetry.ts:82-95`). The UI also sanitizes before handing the event to the host, but the service boundary is the final defense (`packages/ui/src/lib/appTelemetry.ts:44-56`; `packages/services/src/telemetry/telemetryCore.ts:390-394`). `event_text` is outside that filter (`packages/services/src/telemetry/telemetryCore.ts:390`).

Prefer an explicit per-event allowlist or typed event schema that fails closed. At minimum, add tests for every current free-text field.

### Finding 5: One persistent device identifier joins destinations

**Severity:** Medium · **Evidence:** Verified

The same persistent UUID is used as ARMS `user.name`, warehouse `device_mid`, and an optional OTLP installation attribute (`apps/zcode-cli/packages/telemetry/src/bootstrap.ts:226-228`; `packages/desktop/src/main/appARMSBootstrap.ts:146-153`; `packages/services/src/telemetry/telemetryCore.ts:399-402`; `apps/zcode-cli/packages/telemetry/src/otlp-exporter.ts:246-250`). This allows activity from separate systems to be correlated by device.

Use destination-specific identifiers if independent data controllers should not be able to join all streams.

### Finding 6: Two redaction implementations can drift

**Severity:** Medium · **Evidence:** Verified

The CLI and shared sanitizers are separate files (`apps/zcode-cli/packages/telemetry/src/error-sanitizer.ts`; `packages/shared/src/telemetryRedaction.ts`). The CLI contains additional ARMS-key and host-token rules that the shared implementation does not. This creates different protection depending on which destination receives the text.

Move both paths behind one dependency-safe implementation, or add parity fixtures that must pass in both workspaces.

### Finding 7: No user-facing consent or all-telemetry opt-out

**Severity:** Medium · **Evidence:** Verified for the reviewed source

The global switch is a hardcoded `true`, not a setting (`packages/shared/src/env.ts:46-50`). The endpoint variables are runtime configuration, and the CLI model flag covers only the CLI trace path (`apps/zcode-cli/packages/telemetry/src/bootstrap.ts:122-125`). No telemetry consent setting or UI control was found in the reviewed source tree.

Whether consent or an in-product opt-out is required is a product and legal decision. If it is required, add one control whose scope is explicit for OTLP, ARMS, and warehouse events.

### Finding 8: Telemetry privacy behavior has little automated coverage

**Severity:** Medium · **Evidence:** Verified from repository search

The reviewed test files contain no telemetry/redaction fixtures, and the two sanitizer implementations have no parity test. This means a future field or pattern can change without a test identifying the privacy impact.

Add focused tests for the final warehouse boundary, redaction parity, endpoint gating, and network-host normalization. Confirm the test entry points from each package's `package.json` before adding commands.

### Finding 9: HTTP endpoints are accepted

**Severity:** Low · **Evidence:** Verified

The OTLP URL validator accepts both `http:` and `https:` (`apps/zcode-cli/packages/telemetry/src/bootstrap.ts:403-411`). The same policy is used for configured HTTP destinations in the reviewed endpoint paths. A misconfigured endpoint could expose identity or authorization headers over cleartext.

Require HTTPS for endpoints carrying credentials or stable identifiers, or make the transport policy explicit for local development exceptions.

### Finding 10: Telemetry behavior is documented only here

**Severity:** Low · **Evidence:** Inferred from repository search

The repository's general documents do not provide a user-facing telemetry summary. This audit is therefore easy to miss and is tied to source line numbers.

Add a short reference from the appropriate product notice or privacy documentation, and keep this engineering audit as the detailed source map.

## 8. Verification limits

- **No runtime telemetry was sent during this audit.** Activation, sampling, retry, and failure behavior were inferred from source.
- **The ARMS SDK's external dispatch implementation was not fully inspected.** The repository configures `beforeReport` and calls `redactArmsEventBatch` before transmission (`packages/desktop/src/main/appARMSBootstrap.ts:202-231`), but the installed dependency was unavailable for an independent inspection of every SDK event type. Custom-event and crash conclusions should be treated as **Inferred** where they depend on SDK behavior.
- **Endpoint configuration outside tracked files was not assessed.** Local `.env` files, deployment secrets, and operator infrastructure can change whether a path is active.
- **Line numbers are not stable.** Re-audit the cited ranges after source changes.
- **Severity is an engineering risk rating.** It is not a regulatory or legal conclusion.

## Appendix A — Source index

| Area | Primary source |
| --- | --- |
| Endpoint constants and global switch | `packages/shared/src/env.ts:46-58` |
| OTLP endpoint resolution and disable flag | `apps/zcode-cli/packages/telemetry/src/bootstrap.ts:74-125,403-415` |
| OTLP sampling and export intervals | `apps/zcode-cli/packages/telemetry/src/otlp-exporter.ts:31-32,86-89,158-160` |
| OTLP attributes | `apps/zcode-cli/packages/telemetry/src/otlp-exporter.ts:225-252` |
| CLI error redaction | `apps/zcode-cli/packages/telemetry/src/error-sanitizer.ts` |
| Shared event-detail redaction | `packages/shared/src/telemetry.ts:62-95` |
| Shared ARMS redaction | `packages/shared/src/telemetryRedaction.ts` |
| Warehouse request boundary | `packages/services/src/telemetry/telemetryCore.ts:366-477` |
| Account-derived OTLP identity | `packages/services/src/zcode-agent/agentTelemetryEnv.ts:20-35` |
| ARMS initialization and final redaction hook | `packages/desktop/src/main/appARMSBootstrap.ts:146-231,266-268` |
| ARMS event redaction | `packages/desktop/src/main/armsEventRedaction.ts` |
| Network event construction | `packages/desktop/src/main/desktopNetworkTelemetry.ts:80-102` |
| Network hostname/path normalization | `packages/desktop/src/main/networkTelemetryAggregator.ts:224-247` |
| Context-compaction failure reason | `apps/zcode-cli/packages/core/src/runtime/helpers/compact.ts:67-72`; `apps/zcode-cli/packages/core/src/runtime/methods/compact-persistence.ts:179-205` |
| Warehouse event producers | `packages/ui/src/lib/messageTelemetry.ts`; `packages/ui/src/lib/appTelemetry.ts`; `packages/ui/src/v4/telemetry/conversationTelemetrySupervisor.ts` |
| Packaged runtime environment | `packages/desktop/src/main/desktopRuntimeEnv.ts:154-159` |

## Appendix B — Reproducing the source review

Run these commands from the repository root. They inspect configuration and source; they do not send telemetry.

```sh
grep -rn "OTEL_EXPORTER_OTLP\\|ZCODE_ARMS_RUM_ENDPOINT\\|ZCODE_TELEMETRY_REPORT_ENDPOINT" \
  --include="*.ts" --include="*.md" --include="*.json" . | grep -v node_modules
```

```sh
for file in .env.example .env.development .env.production; do
  test -f "$file" && grep -n -i "telemetry\|otel\|arms" "$file"
done
```

```sh
grep -rhoP 'elementName:\s*"[a-z0-9_]+"' --include="*.ts" --include="*.tsx" packages/ | sort -u
```

To inspect the dependency-controlled ARMS boundary after installing dependencies:

```sh
pnpm install
grep -n "beforeReport\\|sendCustom" node_modules/@arms/rum-electron/dist/index.mjs
```
