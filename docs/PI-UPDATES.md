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
