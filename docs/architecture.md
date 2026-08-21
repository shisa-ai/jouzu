# Jouzu architecture

This document maps the Jouzu v0.1 codebase for contributors. It is a living
overview, not a normative contract; the TypeScript sources and their tests
remain authoritative.

## Module map and dependency direction

Jouzu is a single npm package (`jouzu`) with one TypeScript workspace
(`packages/cli`). The CLI entry point is `dist/cli.js`, compiled from
`packages/cli/src/cli.ts`.

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
  ├─ resume.ts           session-resume guidance
  └─ state-lock.ts       shared state-lock primitive
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

Locks (`profile.lock`, `keybindings.lock`, `self-update.lock`) are created and
released by `state-lock.ts`, the shared state-lock primitive used by the
updater, profile, and keybinding operations. It records a PID, a started-at
timestamp, and a release token, refuses locks held by a live process, and
recovers a dead owner's or owner-unknown lock after the stale threshold.

Each owner module keeps its own small `atomicWrite`/validated-JSON helpers.
These overlap; consolidating them into one shared store is deferred (see the
private follow-up work) and will preserve existing schemas.

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

## Package split trigger

Jouzu is deliberately a single package at v0.1. Splitting `updater.ts`,
`keybindings.ts`, `presentation.ts`, `doctor.ts`, or profile/Pi-host code into
separate packages is deferred until a second consumer needs a stable boundary
or a stable test seam exists. File length alone is not an interface.
