# Changelog

## 0.1.4 - 2026-08-27

- Bundle ten release-owned Pi extensions for scheduling, background processes, readable and rendered web access, code previews, tasks, goals, measured loops, context recall, and skill discovery, plus the `pi-goal` and `multiloop` package skills. Matching user-configured copies are suppressed without changing user settings; unrelated Pi packages remain user-managed.
- Add the optional model catalog and `jouzu catalog status|refresh|accept|validate|conformance` commands, with strict duplicate-key and credential rejection, bounded streaming refresh, account-partitioned private cache, ETag validation, mass-change quarantine, and last-known-good retention.
- Add separate opt-in first-run imports for stock Pi `models.json` and `auth.json`; both default to no, preserve source and destination files, and record a local receipt.
- Restore the last Models filter used when the picker opens again.
- Compare model-switch context fit against a 4,096-token safety margin instead of the model's maximum output cap, and offer confirmed compaction before switching to a model whose context is too small.
- Keep queued model switches responsive during active calls, advance repeated `Ctrl+P` presses through queued favorites, and avoid floating Palette overlays on terminals that render inline images above text.
- Preserve JSON `__proto__` as an own property during catalog validation, report picker-state and cached-catalog warnings independently, cap response bodies while streaming, and make model-picker tests independent of the developer's terminal.
- Default isolated Jouzu settings to quiet startup while preserving explicit settings and `--verbose` resource output.
- Route pi-vcc configuration to Jouzu's isolated agent root.
- Add on-demand Clear Writing and database-free Source Check skills to the Core and JA profiles.
- Expand Clear Writing to cover drafting, revision, audit, documentation structure, terminology, and accessibility; point Pi's default system prompt to it while preserving custom prompts.
- Group Core capability selection for session recall, web research, finite tasks, goals, measured loops, background processes, and scheduled prompts; add an untrusted-web rule and routing evaluation corpus.
- Keep current-state skills and documentation focused on active capabilities; reserve prior-component references for versioned release and migration records.
- Qualify the bundled extension set on Linux and macOS. Native Windows qualification remains pending; v0.1.3 is the last release qualified by the full Windows matrix.

## 0.1.3 - 2026-08-26

- Route `/model` and `Ctrl+L` through the Jouzu Models view when slash autocomplete is visible and when Pi copies its stock handlers directly into the Prompt Frame.
- Refresh Pi's effective model inventory when the Models view opens; retain cached models with an in-view warning when refresh fails or times out.
- Use one global favorites list: `Ctrl+F` toggles membership, while `Ctrl+P` and its reverse binding cycle available favorites that fit the active context and effective model scope.
- Remove project favorites, `Alt+F`, and `/scoped-models` from Jouzu's interactive surface. Explicit and configured Pi model scopes continue to constrain the usable inventory.

## 0.1.2 - 2026-08-25

- Add the Jouzu Palette Models view on `/model` and `Ctrl+L`, with Recent/Favorite/All filters, result counts, exact provider/model search, current and previous choices, global favorites, project/global recents, session-only selection, user-local project defaults, documented startup precedence, context-fit blocking, and floating/replacement presentations.
- Add `Ctrl+/` and `Ctrl+?` Jouzu help shortcuts and show the model/help shortcuts in the Session Line.
- Preserve open editor autocomplete behavior before application-level key handling.
- Add the built-in Jouzu Prompt Frame, Session Line, and responsive Status Bar with provider-neutral local facts and CJK/ANSI-safe width degradation.
- Match the retained Session UI color baseline through Jouzu-owned semantic style roles, with a bright Jouzu-cyan Prompt Frame rail that can be replaced by a future global theme.
- Add a public Pi candidate checklist and reverse-chronological update log, including fail-closed v0.84.3 provenance and host-seam findings.
- Preserve project-default activation, failed-selection persistence boundaries, and replacement-editor cursor/paste state; sanitize model labels and render Jouzu RGB roles through the terminal's truecolor, 256-color, 16-color, or no-color mode.
- Identify linked development builds by UTC build time, source commit, and dirty-worktree state without changing the published package version.
- Add experimental `jouzu doctor --json` schema 1 with machine-readable fields and issues; its structure and identifiers may change before v0.3/v0.4.
- Style the Palette through the same Jouzu semantic color roles as the Session UI, so one terminal color policy covers every Jouzu-owned surface.

## 0.1.1 - 2026-08-23

- Change the queued follow-up shortcut from `Tab` to `Ctrl+Enter`, leaving `Tab` available for Pi editor autocomplete.
- Back up and migrate only the exact v0.1.0 `Tab` binding recorded as Jouzu-owned; preserve user-owned and modified bindings.

## 0.1.0 - 2026-08-20

- Launch exact, qualified Pi 0.84.2 through the `jouzu` and `jz` commands while preserving Pi CLI modes and blocking independent Pi runtime self-update drift.
- Automatically update eligible global npm installations before interactive startup by default, with exact-version SHA-512 verification, local rollback, installed-runtime validation, restart-loop protection, explicit status/check/apply/policy commands, and safe source/local/npx fallback.
- Isolate Jouzu configuration, authentication, packages, profiles, and sessions from stock Pi global state on Linux, macOS, and Windows, with `jz --session SESSION_ID` exit guidance that resolves Jouzu's session root.
- Add non-mutating diagnostics, an adaptive Unicode startup presentation, and a provider-neutral `/status` session summary.
- Seed Pi-compatible Jouzu keybinding defaults once (`Tab` follow-up and `Ctrl+Up` dequeue), with semantic-action planning, explicit conflict-safe apply/reset, backups, ownership receipts, user override preservation, and terminal portability diagnostics.
- Bundle a language-neutral Core fallback and optional JA preview with explicit first-run consent, deterministic manifests, dry-run plans, conflict detection, backups, atomic application, safe profile switching, and automatic pre-launch reconciliation.
- Add deterministic Japanese/CJK, encoding, path, terminal, packed-install, and exact Pi compatibility gates.
- Establish npm as the only functional v0.1 channel; PyPI remains the non-functional 0.0.1 reservation.

## 0.0.1 - 2026-08-03

- Reserve the initial Jouzu package names with minimal preview stubs.
