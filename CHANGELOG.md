# Changelog

## 0.1.0 - 2026-08-20

- Launch exact, qualified Pi 0.84.2 through the `jouzu` and `jz` commands while preserving Pi CLI modes and blocking runtime self-update drift.
- Isolate Jouzu configuration, authentication, packages, profiles, and sessions from stock Pi global state on Linux, macOS, and Windows.
- Add non-mutating diagnostics, an adaptive Unicode startup presentation, and the `/jouzu` runtime status command.
- Bundle provider-neutral Core and default Japanese profiles with deterministic manifests, dry-run plans, conflict detection, backups, atomic application, safe profile switching, and automatic pre-launch reconciliation.
- Add deterministic Japanese/CJK, encoding, path, terminal, packed-install, and exact Pi compatibility gates.
- Establish npm as the only functional v0.1 channel; PyPI remains the non-functional 0.0.1 reservation.

## 0.0.1 - 2026-08-03

- Reserve the initial Jouzu package names with minimal preview stubs.
