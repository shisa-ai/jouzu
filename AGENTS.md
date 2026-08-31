# Jouzu — public product repository guide

This repository contains the distributable Jouzu product: code, tests, public user documentation, package metadata, exact upstream locks, CI, installers, release scripts, and deployment files. Private planning, research, decision history, worklogs, partner context, and release operations belong in the private development companion, not here.

## Non-negotiables

1. Commit each complete, validated logical unit immediately; do not leave finished work uncommitted.
2. Never use `git add .`, `git add -A`, or `git commit -a`. Stage exact paths and review the staged diff.
3. Treat pre-existing or unexpected changes as another worker's work. Never reset, restore, overwrite, delete, stash, or commit it.
4. Keep public text user-facing. Do not expose private repository paths, planning IDs, worklog entries, partner details, credentials, local hostnames, or internal review operations.
5. Product behavior is specified by public code/tests and sanitized public issues. Internal research is not a public API or release promise.
6. Pi is an exact dependency. Update it only through the checked-in upstream workflow; never let the embedded runtime self-update independently.
7. Describe the active product surface by default. Do not mention removed, rejected, superseded, unavailable, or hypothetical components in current-state instructions, skills, prompts, README/help text, or assistant prose. Exceptions are explicit planning/porting inventories and versioned changelogs, release notes, or migrations that name the affected versions. Public current-state docs mention prior behavior only when a user must act on an upgrade or compatibility boundary.
8. Before changing a Jouzu-owned interactive terminal view, read and follow [`docs/palette-ux.md`](docs/palette-ux.md). Interaction changes must satisfy the applicable mode, keyboard, hint, cancellation, error, and terminal-width tests in that guide.

## Before editing

```bash
pwd
git rev-parse --show-toplevel
git rev-parse --git-common-dir
git rev-parse --git-path index
git branch --show-current
git rev-parse --short HEAD
git status -sb
git diff --name-only
git diff --staged --name-only
git log -5 --oneline --decorate
git worktree list --porcelain
```

Use a dedicated linked worktree and branch for substantial or overlapping work. Worktrees isolate files and indexes, but refs, remotes, Git config, and hooks remain shared. Never switch, move, rebase, or remove another active worktree or branch. Do not use `git stash` as shared-worktree coordination.

High-conflict paths include `package.json`, `package-lock.json`, `upstream/pi.lock.json`, `packages/cli/`, release workflows, installer manifests, `AGENTS.md`, and `README.md`. Coordinate before same-file edits.

## Repository boundary

| Public `jouzu` | Private development companion |
| --- | --- |
| Product source and tests | Plans, specifications, and prioritization |
| Public user/operator documentation | Research and conversation logs |
| Package and dependency locks | Decision history and immutable worklogs |
| CI, installers, release/build scripts | Private release runbooks and partner context |
| Reproducible source patches actually used by builds | Patch ownership, upstream disposition, and retirement tracking |

When implementing a private decision here, transfer only the minimum reviewed requirement. Public commits and docs must make sense without access to a private repository.

## Development workflow

- Follow a light `spec -> test -> implement -> validate -> commit` cycle.
- Add or update tests before behavior where practical.
- Keep one logical unit per commit and avoid unrelated cleanup.
- Use the narrowest focused check while iterating; run the complete applicable release gate at milestone/release boundaries.
- Public user claims require runtime wiring, test evidence, and documentation parity.
- A local result is not cross-platform proof; CI or native evidence must support platform claims.

## Pi upstream tracking

The public machine authority is [`upstream/pi.lock.json`](upstream/pi.lock.json).

```bash
npm run pi:latest          # compare the pin with npm latest
npm run pi:update          # prepare latest candidate; status becomes pending
npm run pi:check           # offline metadata and API/CLI/RPC contract checks
npm run pi:check:online    # verify npm integrity, git tag, and latest status
npm run pi:qualify         # online checks + complete release gate + promotion
```

Review all manifest/lock/dependency changes. A bump remains pending until qualification succeeds. Source deviations must be public and reproducible; each needs a private owner/upstream reference/test/removal condition, and the active count may not exceed ten.

## Validation

For ordinary changes, run the narrowest tests plus:

```bash
npm run check
npm test
```

For dependency, packaging, Pi, or release changes:

```bash
npm run release:check
```

Do not claim Windows/macOS behavior from Linux-only results. Installer work uses its platform-native acceptance corpus.

## Commit discipline

Immediately before committing:

```bash
git status -sb
git diff --staged --name-only
git diff --staged
git diff --staged --check
```

Use a conventional subject of 72 characters or fewer and a meaningful body, for example:

```text
feat: add isolated Jouzu launcher

- Describe the user-visible change and boundary.
- Record exact validation and any remaining limitation.
```

Do not add AI attribution, bylines, or co-author footers. A local commit does not authorize a push, tag, public issue/PR comment, registry publish, release, or deployment; those require explicit approval and the private release process.
