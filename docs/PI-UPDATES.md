# Pi update review

Jouzu ships an exact Pi version. `upstream/pi.lock.json` is the machine-readable authority for the npm version, integrity, Git tag and commit, qualification status, and active source deviations. This file records the review performed for each candidate.

A Pi release is not adopted because its version is newer. Its npm artifact, upstream tag, APIs, behavior, Jouzu integration, and complete release checks must agree.

## Candidate checklist

### Provenance

- Run `npm run pi:latest` and record the candidate version.
- Verify the npm SHA-512 integrity and signatures or provenance metadata.
- Verify that npm `gitHead` equals the commit referenced by the immutable upstream tag.
- Compare the published changelog with the tag diff.
- Do not bypass configured package minimum-release-age policy.
- Stop when registry metadata, artifact bytes, and Git provenance disagree.

### Dependency graph

- Review direct and transitive dependency changes, Node engine requirements, optional native packages, and licenses.
- Confirm every Jouzu manifest and `package-lock.json` resolves the same exact Pi version.
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

### Pi 0.84.3 — blocked candidate

- **Release:** 2026-08-24
- **Tag:** `v0.84.3` at `4e58f324fae8ebfa98a3d45181fb248072a2afac`
- **npm package:** `@earendil-works/pi-coding-agent@0.84.3`
- **npm integrity:** `sha512-Yr2p9PubrbFZmYEPYI+C8KmZP9xlFuLDnAG64RtU0ZDgrdiXYWa+y7WGyJO5OlqPliOkVCMd9IzVszO3/t0D0w==`
- **Disposition:** Not adopted. Jouzu remains pinned to qualified Pi 0.84.2.

#### Relevant upstream changes

- Model and thinking selections are session-scoped by default; selector `Ctrl+S` explicitly saves global defaults.
- `AgentSession.setModel()` uses an opt-in `persist` option instead of Jouzu's prototype `persistDefault` option.
- `/thinking` and searchable model/thinking selectors were added.
- Windows and WSL defaults changed for image paste, model cycling, undo, transcript navigation/search, and message queueing.
- The optional PowerShell tool was added for Windows.
- Node CLI and RPC entrypoints moved to a bundled runtime; library imports remain modular.
- Extension-factory cleanup, UTF-8 BOM handling, narrow padded text, model refresh, provider usage, and compaction behavior received fixes.

#### Jouzu interaction review

- Session-scoped upstream selection aligns with Jouzu's `Enter` behavior and removal of the Palette global-default shortcut.
- Jouzu's host model-picker option is absent from the pristine 0.84.3 npm artifact. The Palette cannot replace `/model` or `Ctrl+L` through that seam.
- The autocomplete-priority prototype change is also absent. Jouzu's default follow-up binding no longer uses `Tab`, and the Palette handles its own `Tab`, so this change can be retired unless a separate regression proves it is still required.
- The changed `setModel` persistence option requires the host adapter to use 0.84.3's session-scoped semantics if the host seam is restored upstream or carried as an approved deviation.
- Jouzu's Pi contract check must continue covering top-level exports, host model-picker routing, session-only activation, editor behavior, and packed runtime startup.

#### Blockers

1. npm `gitHead` is `bfb004d4418ff05c6f909eaaab856cbe75c1fde0`, which does not equal the `v0.84.3` tag commit `4e58f324fae8ebfa98a3d45181fb248072a2afac`. `npm run pi:update -- 0.84.3` fails closed on this mismatch.
2. The Palette prototype was tested against locally modified generated Pi runtime files that are not present in the npm tarball or declared as source deviations. Those bytes are not releasable evidence.

Adoption requires corrected upstream provenance plus a public, reproducible host-model-picker seam. If upstream does not provide that seam, Jouzu must approve and track a temporary deviation before qualification.

### Pi 0.84.2 — qualified baseline

- **Release:** 2026-08-14
- **Tag and npm `gitHead`:** `914cf1472e715297caa30db4b9535d534a9eb718`
- **npm integrity:** `sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA==`
- **Disposition:** Qualified for Jouzu v0.1.1 with zero declared deviations.

The v0.1.2 Palette campaign subsequently exposed undeclared local generated-runtime changes used for host picker routing, session-only model activation, and autocomplete priority. Pi 0.84.2 remains the package provenance baseline, but those local changes cannot be included in a release until they are upstream or represented by the deviation process.
