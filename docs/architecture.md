# Jouzu architecture

This document maps the Jouzu v0.1 codebase for contributors. It is a living
overview, not a normative contract; the TypeScript sources and their tests
remain authoritative.

## Module map and dependency direction

Jouzu publishes one npm package (`jouzu`) from `packages/cli` and keeps its persistent interactive surfaces in the private `packages/session-ui` workspace. The CLI build compiles that workspace first and copies its JavaScript plus third-party notice under `dist/session-ui`; users do not install a second package. The CLI entry point remains `dist/cli.js`, compiled from `packages/cli/src/cli.ts`.

```text
cli.ts  (entry: argument routing, profile resolution, launch)
  ├─ args.ts             argument parsing and usage/help
  ├─ paths.ts            platform path resolution (agent/state/cache roots)
  ├─ metadata.ts         loads bundled Pi lock metadata
  ├─ runtime.ts          profile selection + configurePiProcess
  │    └─ profile-manager.ts   strict profile-state reader, plan/apply
  ├─ profile-choice.ts   first-run Japanese support consent
  ├─ profiles.ts         bundled profile loading
  ├─ profile-manager.ts  profile planning/application (see above)
  ├─ keybindings.ts      durable keybinding defaults
  ├─ updater.ts          Jouzu self-update (verify/install/rollback)
  ├─ doctor.ts           diagnostics (read-only)
  ├─ presentation.ts     startup presentation extension
  ├─ palette.ts          floating/replacement Palette surface host
  ├─ model-picker*.ts    Models view, ranking, and private picker state
  ├─ terminal-layout.ts  stable CLI re-export of shared display-width helpers
  ├─ session-ui/         build-time adapter to the standalone workspace
  ├─ resume.ts           session-resume guidance
  ├─ state-lock.ts       shared state-lock primitive
  └─ private-fs.ts       private directory/file boundary

packages/session-ui
  ├─ extension.ts        lifecycle wiring and single surface ownership
  ├─ snapshot.ts         provider-neutral typed session facts
  ├─ controller.ts       event-driven/coalesced local refresh
  ├─ prompt-frame.ts     custom Pi editor framing and rail
  ├─ session-line.ts     hint plus protected model/thinking identity
  ├─ status-bar.ts       responsive semantic status segments
  ├─ layout.ts           ANSI/Unicode terminal-column primitives
  └─ sources/            bounded Git and optional runtime probes
```

Dependency direction is downward: `cli.ts` composes, leaf modules
(`args.ts`, `paths.ts`, `state-lock.ts`) depend on nothing internal except
types. `runtime.ts` and `profile-manager.ts` depend on `paths.ts` and
`profiles.ts`; `doctor.ts` depends only on leaf modules and type-only imports.
There are no circular module imports.

## State-file ownership and shared primitives

| State | Owner | Location |
| --- | --- | --- |
| Profile state | `profile-manager.ts` | `state/profile-state.json` |
| Profile consent | `profile-choice.ts` | `state/profile-choice.json` |
| Keybinding state | `keybindings.ts` | `state/keybindings-state.json` |
| Self-update state | `updater.ts` | `state/self-update.json` |
| Model-picker favorites/recents | `model-picker-state.ts` | `state/model-picker.json` |

Locks (`profile.lock`, `keybindings.lock`, `self-update.lock`) are created and
released by `state-lock.ts`, the shared state-lock primitive used by the
updater, profile, and keybinding operations. It records a PID, a started-at
timestamp, and a release token, refuses locks held by a live process, and
recovers a dead owner's or owner-unknown lock after the stale threshold.

`private-fs.ts` creates Jouzu-owned roots and descendants with POSIX mode
`0700`, creates copied backup files with mode `0600`, rejects symlinks inside
those owned boundaries, and leaves caller-owned parent directories unchanged.
Each owner module keeps its own `atomicWrite` and validated-JSON helpers.
Consolidating those helpers is deferred and must preserve existing schemas.

## Update lanes

There are three distinct update lanes:

- **Jouzu application updates** (`updater.ts`, `jz self-update`): replace the
  installed Jouzu package for a real global npm install, verifying the exact
  version and SHA-512 integrity and rolling back on failure.
- **Pi qualification** (scripts/pi-upstream.mjs, scripts/check-pi-contract.mjs):
  a maintainer lane that pins an exact reviewed Pi artifact before promotion.
  It is not a runtime code path.
- **Pi-owned extension updates** (`jz update --extensions`): follow Pi's own
  package behavior. This lane is outside Jouzu's v0.1 compatibility guarantee.

## Bundled profile boundaries

Jouzu bundles two profiles, `core` (the language-neutral fallback) and `ja`
(the optional Japanese-focused extension). Each profile declares its assets in
`profiles/<id>/manifest.json`; `profile-manager.ts` plans and applies those
assets into the isolated agent root. v0.1 ships no extension or prompt
catalogs beyond these bundled profiles; the `catalog/`, `profiles/`, and
`packaging/` top-level directories are placeholders for future releases.

## Workspace boundary

`packages/session-ui` is a rename-friendly internal workspace, not a separately published product or stable extension API. Runtime IDs are centralized and it writes no feature-named state or configuration. Pure snapshots, sources, renderers, and layout helpers remain independently testable; `extension.ts` is the only Pi lifecycle adapter. `scripts/copy-session-ui.mjs` is the only packaging bridge.

Other CLI modules remain in `packages/cli` until a second consumer needs a stable boundary. File length alone is not an interface.
