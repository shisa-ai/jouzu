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
  ├─ pi-import.ts        opt-in stock-Pi models/auth import
  ├─ model-catalog.ts    strict catalog parser and semantic validation
  ├─ model-catalog-sync.ts  bounded remote refresh and private last-known-good cache
  ├─ catalog-command.ts  catalog status, refresh, acceptance, and conformance commands
  ├─ release-extensions.ts  exact release manifest and runtime resource resolution
  ├─ camoufox-adapter.ts lazy release-owned rendered-browser registration
  ├─ profiles.ts         bundled profile loading
  ├─ profile-manager.ts  profile planning/application (see above)
  ├─ keybindings.ts      durable keybinding defaults
  ├─ updater.ts          Jouzu self-update (verify/install/rollback)
  ├─ doctor.ts           diagnostics (read-only), typed report plus text renderer
  ├─ presentation.ts     startup presentation extension
  ├─ palette.ts          floating/replacement Palette surface host
  ├─ model-picker*.ts    Models view, ranking, and private picker state
  ├─ terminal-layout.ts  stable CLI re-export of shared display-width helpers
  ├─ session-ui/         build-time adapter to the standalone workspace
  ├─ resume.ts           session-resume guidance
  ├─ state-lock.ts       shared state-lock primitive
  └─ private-fs.ts       private directory/file boundary and atomic writes

packages/session-ui
  ├─ extension.ts        lifecycle wiring and single surface ownership
  ├─ color.ts            truecolor/256/16/plain detection and RGB mapping
  ├─ snapshot.ts         provider-neutral typed session facts
  ├─ controller.ts       event-driven/coalesced local refresh
  ├─ prompt-frame.ts     custom Pi editor framing and rail
  ├─ session-line.ts     hint plus protected model/thinking identity
  ├─ status-bar.ts       responsive semantic status segments
  ├─ styles.ts           semantic roles and replaceable color mapping
  ├─ layout.ts           ANSI/Unicode terminal-column primitives
  └─ sources/            bounded Git and optional runtime probes
```

Dependency direction is downward: `cli.ts` composes, leaf modules
(`args.ts`, `paths.ts`, `state-lock.ts`) depend on nothing internal except
types. `runtime.ts` and `profile-manager.ts` depend on `paths.ts` and
`profiles.ts`; `doctor.ts` depends only on leaf modules and type-only imports.
There are no circular module imports.

## Interactive UX authority

The [Palette interaction standards](palette-ux.md) define the contributor requirements for Jouzu-owned Palette views. Read them before changing `palette.ts`, a Palette component, interactive key handling, focus, hints, messages, or terminal layout. Interaction changes require the applicable mode-transition and width tests listed in that guide.

## State-file ownership and shared primitives

| State | Owner | Location |
| --- | --- | --- |
| Profile state | `profile-manager.ts` | `state/profile-state.json` |
| Profile consent | `profile-choice.ts` | `state/profile-choice.json` |
| Pi import decisions | `pi-import.ts` | `state/pi-import.json` |
| Keybinding state | `keybindings.ts` | `state/keybindings-state.json` |
| Self-update state | `updater.ts` | `state/self-update.json` |
| Model-picker project defaults, favorites, and recents | `model-picker-state.ts` | `state/model-picker.json` |
| Account-partitioned model catalog cache | `model-catalog-sync.ts` | `cache/model-catalog/<endpoint-hash>/` |

Locks (`profile.lock`, `pi-import.lock`, `keybindings.lock`, `self-update.lock`, `model-picker.lock`, and per-endpoint catalog `refresh.lock`) are created and
released by `state-lock.ts`, the shared state-lock primitive used by the
updater, profile, Pi-import, keybinding, model-picker, and catalog operations. It records a PID, a started-at
timestamp, and a release token, refuses locks held by a live process, and
recovers a dead owner's or owner-unknown lock after the stale threshold.

`private-fs.ts` creates Jouzu-owned roots and descendants with POSIX mode
`0700`, creates copied backup files with mode `0600`, rejects symlinks inside
those owned boundaries, and leaves caller-owned parent directories unchanged.
It also owns `writeFilePrivateAtomic`, the atomic replacement helper used by
every state owner. The payload goes to a uniquely named `0600` temporary file
inside the owned directory, is flushed, and is renamed over the destination, so
a concurrent reader never observes a partial write. The helper does not flush
the parent directory after rename and makes no power-loss durability claim for
the directory entry. Each owner module keeps its own schema validation and
parsing.

## Update lanes

There are three distinct update lanes:

- **Jouzu application updates** (`updater.ts`, `jz self-update`): replace the
  installed Jouzu package for a real global npm install, verifying the exact
  version and SHA-512 integrity and rolling back on failure.
- **Pi qualification** (scripts/pi-upstream.mjs, scripts/check-pi-contract.mjs):
  a maintainer lane that pins an exact reviewed Pi artifact before promotion.
  It is not a runtime code path.
- **Release-owned extension updates** (`release-extensions.json`): move only with a Jouzu application release. They are bundled dependencies rather than mutable Pi package entries.
- **User-installed extension updates** (`jz update --extensions`): follow Pi's package behavior inside the isolated Jouzu root. This lane does not replace or independently advance the release-owned set and remains outside Jouzu's release qualification.

## Release-owned extension boundary

`release-extensions.json` records ten selected extension packages, their exact npm versions or Git commits, two package skill paths, three compatibility dependencies, source URLs, licenses, and integrity evidence. `release-extensions.ts` resolves those resources from the packed `jouzu` package and adds them to Core and JA launches. A matching user-configured package entrypoint is suppressed in memory without changing `settings.json`; unrelated packages still load. A different package that registers a release-owned tool name produces one consolidated conflict.

`camoufox-adapter.ts` registers `tff-fetch_url` and `tff-search_web` without starting the browser during ordinary startup. The first browser tool call uses bundled `camoufox-js`, `playwright-core`, and `better-sqlite3`; `session_shutdown` closes the client.

## Bundled profile boundaries

Jouzu bundles two profiles, `core` (the language-neutral fallback) and `ja` (the optional Japanese-focused extension). Each profile declares its product-owned assets in `profiles/<id>/manifest.json`; `profile-manager.ts` plans and applies those assets into the isolated agent root. Core and JA use the same release-owned extension and five-skill set. JA adds only its response-language prompt asset.

The optional model catalog is a model-metadata input, not an extension installer. With no configured endpoint, it performs no network work. A configured refresh streams at most 16 MiB, validates strict JSON and semantic references before activation, partitions cache by endpoint and account, quarantines bounded mass changes, and preserves the active last-known-good document on failure.

## Workspace boundary

`packages/session-ui` is a rename-friendly internal workspace, not a separately published product or stable extension API. Runtime IDs are centralized and it writes no feature-named state or configuration. Pure snapshots, sources, renderers, styles, and layout helpers remain independently testable; `extension.ts` is the only Pi lifecycle adapter. `styles.ts` owns the replaceable semantic color mapping, so renderers do not depend on raw colors or legacy names. `scripts/copy-session-ui.mjs` is the only packaging bridge.

Other CLI modules remain in `packages/cli` until a second consumer needs a stable boundary. File length alone is not an interface.
