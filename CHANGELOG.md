# Changelog

## Unreleased

- Add the Jouzu Palette Models view on `/model` and `Ctrl+L`, with Recent/Favorite/All filters, result counts, exact provider/model search, current and previous choices, project/global favorites and recents, session-only selection, user-local project defaults, documented startup precedence, context-fit blocking, and floating/replacement presentations.
- Add `Ctrl+/` and `Ctrl+?` Jouzu help shortcuts and show the model/help shortcuts in the Session Line.
- Preserve open editor autocomplete behavior before application-level key handling.
- Add the built-in Jouzu Prompt Frame, Session Line, and responsive Status Bar with provider-neutral local facts and CJK/ANSI-safe width degradation.
- Match the retained Session UI color baseline through Jouzu-owned semantic style roles, with a bright Jouzu-cyan Prompt Frame rail that can be replaced by a future global theme.
- Add a public Pi candidate checklist and reverse-chronological update log, including fail-closed v0.84.3 provenance and host-seam findings.
- Preserve project-default activation, failed-selection persistence boundaries, and replacement-editor cursor/paste state; sanitize model labels and render Jouzu RGB roles through the terminal's truecolor, 256-color, 16-color, or no-color mode.
- Identify linked development builds by UTC build time, source commit, and dirty-worktree state without changing the published package version.
- Add `jouzu doctor --json`, printing the same diagnostics as a structured report with stable field and issue identifiers.
- Style the Palette through the same Jouzu semantic color roles as the Session UI, so one terminal capability policy covers every Jouzu-owned surface.

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
