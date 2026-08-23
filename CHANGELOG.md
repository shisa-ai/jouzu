# Changelog

## Unreleased

- Add the Jouzu Palette Models view on `/model` and `Ctrl+L`, with exact provider/model search, current and previous choices, project/global favorites and recents, session-only selection, explicit global-default selection, context-fit blocking, and floating/replacement presentations.
- Preserve open editor autocomplete behavior before application-level key handling.

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
