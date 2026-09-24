# Pi update review

Jouzu ships an exact Pi version. `upstream/pi.lock.json` is the machine-readable authority for the npm version, integrity, Git tag and commit, qualification status, and active source deviations. This file records the review performed for each candidate.

A Pi release is not adopted because its version is newer. Its npm artifact, upstream tag, APIs, behavior, Jouzu integration, and complete release checks must agree.

## Candidate checklist

### Provenance

- Run `npm run pi:latest` and record the candidate version.
- Verify the npm SHA-512 integrity and signatures or provenance metadata.
- Record the immutable version-tag commit and npm package-source commit separately. Require registry `gitHead` and SLSA provenance to agree on the package source, which must equal or descend from the tag.
- Compare the published changelog with the tag diff.
- Keep the configured package minimum-release-age policy for ordinary updates and publication. A qualification-only override requires explicit maintainer authorization and does not change the checked-in default.
- Stop when registry metadata, artifact bytes, and Git provenance disagree.

### Dependency graph

- Review direct and transitive dependency changes, Node engine requirements, optional native packages, and licenses.
- Confirm every Jouzu manifest and `package-lock.json` resolves the same exact Pi version.
- Update the CLI's exact `@earendil-works/pi-tui` dependency and the Session UI's exact Pi/Pi TUI peers in the same candidate transaction; verify that Pi's declared TUI range includes that version.
- Inspect packaged entrypoints and bundled/unbundled runtime changes that can affect imports or startup.

### Jouzu integration

Review changes to:

- exported APIs used by the launcher and contract checks;
- interactive-mode host seams used by the Jouzu Palette;
- model selection, thinking levels, persistence, scoped models, and session restoration;
- editor input routing, autocomplete, keybindings, and terminal protocols;
- custom editors, overlays, themes, width calculation, IME behavior, and no-color rendering;
- extension lifecycle, provider registration, commands, tools, events, and project trust;
- session files, compaction, branch navigation, usage, and resume behavior;
- provider catalogs, authentication, request serialization, routing, usage, and pricing; and
- updater, package manager, Windows, RPC, JSON, and print-mode behavior.

### Source deviations

- Compare installed Pi bytes with the verified npm tarball before testing.
- Reject untracked edits under `node_modules` as qualification evidence.
- Record every required patch in `upstream/pi.lock.json` with its public path and SHA-256 digest.
- Require a compatibility test, owner, upstream disposition, first carried version, and retirement condition.
- Remove a deviation when the candidate implements the required behavior.

### Qualification

```bash
npm run pi:update -- <version>
npm run pi:check
npm run pi:check:online
npm run release:check
npm run pi:qualify
```

Review all generated manifest and lock changes before qualification. Run focused model-picker, Session UI, keybinding, provider, CJK, packed-install, and platform-native checks when the candidate touches those surfaces. Record cross-platform CI after the candidate commit is synchronized.

## Update log

### Pi 0.87.1 — qualified locally

- **Release:** 2026-09-22 (`0.87.0` published 2026-09-21)
- **Tag and npm `gitHead`:** `v0.87.1` at `f07218c4d4bbc12bef056a7058c3dd49dfe41abe`
- **npm package:** `@earendil-works/pi-coding-agent@0.87.1`
- **npm integrity:** `sha512-m8ArJUtVcQMSe1lLE/Ei7vX/JV7O39sWmWBsXV2NOU70F0qCp8GubA24pT3LnwTmM6LL2xV80/h6sQg85n69ew==`
- **Disposition:** Qualified on 2026-09-24 at public commit `84cda377`, with eight registered deviations. Two of them, `pi-path-utils` and `code-previews`, joined the lock on 2026-09-21 for Unicode-path corrections and are unrelated to this candidate. Evidence is Linux/Node 24.16.0; no Windows, macOS, or live-model qualification is claimed.

#### Relevant upstream changes

- 0.87.0 makes `SessionManager` canonical for provider context and adds append-only context edits (`ContextEditEntry`) plus the `context` and `context_with_system` extension events.
- `@earendil-works/pi-agent-core` removes `shouldStopAfterTurn` in favor of `finishTurn` returning `{ action: "end" }`, expands `TurnEndEvent`, adds `AgentBeforeSettleEvent`, stops accepting `turn_end` in `ExtensionRunner.emit()`, and no longer gives deferred runs from `agent_settled` handlers a reentrant `agent_start` in the same dispatch.
- `PendingMessageQueue` gains `peek`, `hasItems`, and `clear`, and `drain` delegates to `peek`.
- Assigning `session.agent.state.messages` no longer replaces provider history.
- 0.87.1 adds frontier models and carries fixes in two files the provider-receipt deviation patches: image-only user messages no longer send an empty text part, Anthropic OAuth requests report a current Claude Code version, and unknown OpenAI-compatible endpoints no longer receive strict tool schemas unless they advertise them.

#### Jouzu interaction review

- A projection rebuild no longer breaks custom-message identity. Pi builds agent state from the session projection, which constructed a new object for a `custom_message` entry on every projection, so identity-bound flow receipts and wait decisions stopped resolving. The patch retains the emitted object on its entry under a shared symbol; the property is non-enumerable, so session files and entry key sets are unchanged.
- `peek()` unwraps claim wrappers for the public preview API while `drain()` keeps claim identity, and `hasItems()` and `clear()` stay wrapper-agnostic. The `beforeQueueClaim` and `afterQueueClaim` checkpoints keep their semantics.
- `continueQueued()` reports whether it consumed input, so a denied or cancelled initial claim ends the session pass without another claim or provider request.
- Native source recovery reads Pi's public `buildSessionProjection()`, which applies persisted recovery omissions. The single trailing-terminal omission allowance is gone because Pi records those omissions as context edits.
- The session-listing correction stays. Pi removed `includeEmpty` and the empty-session filter, so the patch re-adds both and the picker keeps its default; 0.87.1 widened explicit-ID lookup, which is a different path.
- The model-context filtering subset of `pi-content-policy` stays patched. The new `context` and `context_with_system` events cover context transformation, but they cannot refuse a request, do not run for compaction or branch summarization, and do not report the original-to-clone mapping the receipts depend on. Retirement now requires all three.
- The launcher exports, extension API, `deliverAs: "nextTurn"`, registered `turn_end` and `agent_settled` handlers, and the Palette seams remain available. `context` handlers no longer see system messages and Pi restores prompt and tool state afterwards, which matches the assumptions in `packages/cli/src/flow-control/task-context-guard.ts`.

#### Qualification evidence

`npm run pi:qualify` passed online provenance, the complete candidate gate, packed install, automatic-update smoke, Python artifacts, and the API/CLI/RPC contract probes before promoting the pin. Gate counts: Pi patch tests 140, Session UI 49, CLI 2,551 passed with two opt-in skips and no failures or cancellations, pack and release helpers 35, release metadata and artifact 82, runner 9, Python 2. `npm run pi:check:online` reports npm `latest` as `0.87.1`, and comparing both installed trees byte-for-byte against the registry tarball reports 0 unexpected differences. The two skips are the opt-in saved-session recovery test and the optional online web-extension fetch test.

### Pi 0.86.1 — qualified and released in Jouzu v0.1.14

- **Release:** 2026-09-20
- **Tag and npm `gitHead`:** `v0.86.1` at `13cbf77df2396303013a41646bcfa77b4271ae56`
- **npm package:** `@earendil-works/pi-coding-agent@0.86.1`
- **npm integrity:** `sha512-vZBuNfJnruxZyemZ3O05V0S/Ylze08ahFTIQ1Mik++gVdOevPl89gt/Uv0U97BPAJaj9cj6Vf9rcIgKtUrd0BA==`
- **Disposition:** Qualified on 2026-09-20 and shipped in Jouzu v0.1.14 with six registered deviations. `d25132a` pinned the tuple and refreshed the patch inputs; `7ac0b8b` promoted the pin with the release metadata.

#### Relevant upstream changes

- System instructions survive cancelled user input, and compacted summaries are checked by message role.
- Pi's native clipboard helpers are used directly; the vendored clipboard copies and their build step were removed during the 0.86.0 port.
- Interactive-mode plus OpenAI-completions and type changes were the only patch-input drift from 0.86.0.

#### Qualification evidence

`npm run pi:qualify` passed under the shared build lock with the local no-CC deviation reverted and restored. `./dev-build.sh release-check` passed on `7bab852` with 2,444 CLI passes and two skips, 130 Pi tests, packed installs, synthetic update/restart/rollback, and Python package checks. Hosted CI run `35528621964` passed all 26 required jobs, native Windows source checks passed on Node 22/24 and Python 3.10/3.12/3.13, and the full native Windows qualification passed 12 checks. A command-scoped `npm_config_min_release_age=0` override covered the fresh pin; no global npm policy changed. The live JA gate produced no passing live-provider result: the first install stopped at the local age policy, the Anthropic attempt failed for insufficient credits, and the OpenAI `gpt-4.1-mini` attempt returned an unsupported-request-handler diagnostic. The Windows installer preview remains unsigned.

### Pi 0.86.0 — qualified locally, superseded

- **Release:** 2026-09-19
- **Tag and npm `gitHead`:** `v0.86.0` at `ecac0a9c4edad3dac5d9f8b40e0c7db7a56471fc`
- **npm package:** `@earendil-works/pi-coding-agent@0.86.0`
- **npm integrity:** `sha512-tzLh/10bPQZbA9shvA8TALT4eSNCifJaDq672MPXHldsvZ9t9lQ8J5Z9CD1d7UZVzG4l85XUZWo6ZCCNhBULxw==`
- **Disposition:** Qualified on 2026-09-20 at public commits `6cc9291`, `8314590`, and `f99496e`, with six registered deviations; the port added none. Superseded the same day by 0.86.1, which shipped in Jouzu v0.1.14.

#### Relevant upstream changes

- Provider implementations receive a branded `TranscriptContext`. Public entry points still accept `Context`, but system prompts and tool declarations arrive as transcript system messages, and `ModelRuntime.stream` and `streamSimple` normalize before provider dispatch.
- `SessionManager.list` and `listAll` gained a cancellation argument and report partial progress.
- Compaction may project a system message before the summary, and system tool declarations can be rewritten before emission.
- Session disposal cancellation and cache-warmer cleanup changed.
- The interactive `/bug` command prepares a report with optional transcript inclusion and an optional model-generated summary.

#### Jouzu interaction review

- Provider-conversion observers were rebased onto normalized transcript contexts, with identity tests for duplicate user objects and grouped tool results across OpenAI Completions, OpenAI Responses, Anthropic, Google Generative AI, Bedrock, and Mistral.
- System-message events are separated from prompt and claimed-queue ownership, so a rewritten tool declaration cannot consume a user-input receipt or become cancelled user content.
- Compaction summaries are selected by role in idle settlement and omitted-member verification, so a projected system message cannot mask a changed summary.
- Session-list cancellation and filtered partial progress are preserved. Explicit prefix and global recovery still opt into empty sessions, and exact-ID recovery uses upstream `findById`.
- Clipboard vendoring scripts and their build step were removed, and pack checks now require Pi's six native helpers in every bundled TUI tree. Those checks establish presence, not execution on six native platforms.
- `/bug`'s model-summary path calls the session stream function without a native request checkpoint, so Jouzu refuses it before another provider call; a regression proves no additional provider call. Metadata redaction removes secret-looking keys and URL credentials but does not make a bundle anonymous, and no report was uploaded.
- esbuild moved to 0.28.2 and typebox to 1.3.27 with the upstream updater, and the extension manifest and license notices were synchronized.

#### Qualification evidence

The maintainer approved a qualification-only `min-release-age=0` override for the fresh pin; checked-in npm policy did not change. `npm run pi:qualify` passed online provenance, 109 Pi tests, the complete gate, packed install smoke, updater start and rollback smoke, Python sdist/wheel and Twine checks, and the API/CLI/RPC contract probes. `npm test` reported 2,392 CLI passes with two skips, 49 Session UI passes, nine runner passes, two Python passes, 35 pack and artifact passes, and 82 release-metadata passes. The initial full suite failed with 33 failures and three cancellations; the corrected run had none, and no test deadline was raised. Follow-ups recorded at the time were warm-request admission qualification, the `/bug` destination decision, and native macOS, Windows, and live-provider qualification.

### Pi 0.85.1 — qualified locally

- **Tag and package source:** `v0.85.1` at `d981de1229ef899957bbe968bc8dcda02a21f477`.
- **Coding-agent integrity:** `sha512-FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ==`.
- **Disposition:** Qualified on 2026-09-05 with no source deviations. The final Jouzu release commit still requires native CI qualification.

Pi 0.85.1 fixes model/thinking selector save bindings, keeps list selection unchanged on mouse hover, adds faster Alt-wheel scrolling, and updates Astra request caching. Its stable CLI entrypoint no longer imports the experimental remote harness. Jouzu's launcher export, extension lifecycle, model activation, editor routing, and child-session interfaces remain compatible.

The update changes only Pi package versions and their dependency layout. Node.js remains at least 22.19 and Pi remains MIT-licensed. Jouzu retains its exact external Pi server dependency; no dependency is made optional by this update. The production lock audit reports zero vulnerabilities.

`npm run pi:qualify` passed the full local candidate gate, packed local/npm-exec/global installs, synthetic update/rollback, and the API/CLI/RPC contract probes before promoting the lock. Registry signatures, signed provenance, and tarball integrity were separately verified for both coding-agent and server packages. Their source commits match the tag; signing identity and provenance name `earendil-works/pi`, `.github/workflows/build-binaries.yml`, and `refs/tags/v0.85.1`. No minimum-release-age override was used.

### Pi 0.84.4 — qualified

- **Release:** 2026-08-28
- **Tag and npm `gitHead`:** `v0.84.4` at `b79e4cc834970cca69daebffab7df1da7d1e52c4`
- **npm package:** `@earendil-works/pi-coding-agent@0.84.4`
- **npm integrity:** `sha512-jmOlrqUmvhh/siNWFRXjYLJzhKFIHNsAQaysRwzQPQFnPAaV/vhqHsLH/MBsIISA1Rjj7WTUFR3nJrpXoLx39w==`
- **Disposition:** Adopted and qualified on 2026-09-03 with no Pi source deviations.

#### Relevant upstream changes

- Terminal capability overrides, extension UI prompt events, RPC queue clearing, and configurable fullscreen selection copying were added.
- Large tool results that cross the auto-compaction threshold are compacted before the next provider request. Compaction and branch summaries no longer force `toolChoice: "none"`, and interactive progress resumes after same-run compaction.
- Extension messages with `triggerTurn: false` wait for active tool results before entering history, preserving provider-valid tool call ordering.
- Saving a default model from a non-empty scope keeps it available in that scope. File autocomplete favors direct and shallower matches.
- Session append repairs, Windows shell-abort handling, thinking-output rendering, provider reasoning replay, explicit tool choice, proxy transport, and model catalog data received fixes.

#### Jouzu interaction review

- The launcher exports and interactive seams used by Jouzu remain available. The contract probe passed `main`, agent-directory resolution, session management, model runtime, resource loading, CLI version/help, isolated RPC startup, semantic key actions, custom-editor handler interception, Palette model activation, session-only persistence, and packed startup.
- The model-scope fix agrees with Jouzu's project-default layer: activation stays session-scoped while Jouzu stores a successful Palette selection separately. Model selection, favorites, scoped commands, compaction, autocomplete, CJK layout, and extension lifecycle tests passed.
- Pi owns the new `fullscreenCopyOnSelect` and `Ctrl+X` selection behavior. Jouzu's `Ctrl+Enter`, `Ctrl+Up`, and Models `Ctrl+F` defaults did not change.
- Both lockfiles retain their prior record sets. Only the seven `@earendil-works/pi-*` runtime packages, the direct Pi TUI package, and the matching manifest records changed from 0.84.3 to 0.84.4. Pi's Node.js minimum remains 22.19 and its package license remains MIT. The packed production audit reported zero vulnerabilities.

#### Qualification evidence

`npm run pi:qualify` passed online npm and Git tag checks, 42 Session UI tests, 300 CLI tests, five pack-check tests, six release-metadata tests, Python build/checks, packed local/npm-exec/global installs, synthetic update and rollback, the Pi contract probe, and promotion. The installed coding-agent package matched all 1,044 npm tarball files byte-for-byte. Release extension network tests passed readable fetch, batch fetch, rendered browser fetch/search, and cleanup. The deployed Shisa catalog returned nine offerings, and the packed JA smoke completed its Japanese write/read flow through `google/gemini-2.5-flash-lite` for `$0.0003658` under a `$0.02` cap.

The npm SLSA provenance names `refs/tags/v0.84.4`, repository `earendil-works/pi`, build workflow `.github/workflows/build-binaries.yml`, and source commit `b79e4cc834970cca69daebffab7df1da7d1e52c4`. The registry `gitHead`, immutable tag, provenance source, and checked-in lock agree.

### Pi 0.84.3 — qualified

- **Release:** 2026-08-24
- **Tag:** `v0.84.3` at `4e58f324fae8ebfa98a3d45181fb248072a2afac`
- **npm package:** `@earendil-works/pi-coding-agent@0.84.3`
- **npm integrity:** `sha512-Yr2p9PubrbFZmYEPYI+C8KmZP9xlFuLDnAG64RtU0ZDgrdiXYWa+y7WGyJO5OlqPliOkVCMd9IzVszO3/t0D0w==`
- **Package source:** `bfb004d4418ff05c6f909eaaab856cbe75c1fde0`, recorded by npm `gitHead` and the SLSA provenance attestation
- **Disposition:** Adopted and qualified on 2026-08-25 with no Pi source deviations.

#### Relevant upstream changes

- Model and thinking selections are session-scoped by default; selector `Ctrl+S` explicitly saves global defaults.
- `AgentSession.setModel()` uses an opt-in `persist` option instead of Jouzu's prototype `persistDefault` option.
- `/thinking` and searchable model/thinking selectors were added.
- Windows and WSL defaults changed for image paste, model cycling, undo, transcript navigation/search, and message queueing.
- The optional PowerShell tool was added for Windows.
- Node CLI and RPC entrypoints moved to a bundled runtime; library imports remain modular.
- Extension-factory cleanup, UTF-8 BOM handling, narrow padded text, model refresh, provider usage, and compaction behavior received fixes.

#### Jouzu interaction review

- Pi's upstream model activation is session-scoped. Jouzu stores a successful Palette selection separately as the user-local project default.
- The built-in Prompt Frame intercepts Pi's copied `app.model.select` handler and exact `/model` submissions before stock dispatch, then opens the Palette through Jouzu's extension.
- The Prompt Frame intercepts Pi's forward/backward model-cycle actions so they cycle Jouzu's global favorites. It filters model-scope management from autocomplete while explicit and configured Pi model scopes remain inventory constraints.
- Palette `Enter` calls public extension API `pi.setModel()`, then stores the project default only after activation succeeds. Models does not bind `Shift+Enter`.
- Project defaults are applied from `session_start` through the same public session-scoped API. Explicit models, resumed sessions, and scoped-model sets retain precedence without injecting a process-wide CLI model override.
- Palette `Tab` is handled inside its component, and the Prompt Frame preserves ordinary autocomplete behavior.
- Jouzu's Pi contract check covers upstream session model activation, Jouzu project-default persistence, semantic editor actions, direct custom-editor handler copying, favorite-cycle routing, scoped-command interception, and packed runtime startup with the pristine Pi package.

#### Provenance disposition

The `v0.84.3` tag commit is `4e58f324fae8ebfa98a3d45181fb248072a2afac`. The official npm package was built from descendant commit `bfb004d4418ff05c6f909eaaab856cbe75c1fde0`, two commits after the tag, and its SLSA provenance names that source commit and the upstream build workflow. Pi lock schema 2 records both tag and package-source commits. Online checks require the registry `gitHead` to equal the package-source commit and require that source to equal or descend from the immutable version tag.

The first installation attempt stopped at npm's configured minimum-release-age policy. A maintainer then authorized a qualification-only `min-release-age=0` override so the exact verified package could be installed and tested immediately; the checked-in npm policy was not changed. `npm run pi:qualify` passed the full candidate gate, packed local/npm-exec/global smoke tests, auto-update smoke, Pi contract checks, online registry checks, and promotion with zero source deviations.

### Pi 0.84.2 — qualified baseline

- **Release:** 2026-08-14
- **Tag and npm `gitHead`:** `914cf1472e715297caa30db4b9535d534a9eb718`
- **npm integrity:** `sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA==`
- **Disposition:** Qualified for Jouzu v0.1.1 with zero declared deviations.
