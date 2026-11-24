# Review candidate identity

Jouzu compares a Git workspace fingerprint when a review-only child launches and
when it finishes. A **changed** marker means the captured workspace inputs differ;
it does not mean the reviewer edited files or found a defect.

The fingerprint covers HEAD, tracked changes and nonignored untracked files in
the selected workspace, within bounded snapshot limits. It does not cover sibling
repositories merely because the reviewer reads them.

## Scheduler runtime files

These exact workspace-relative paths are excluded when they are untracked regular
files:

- `.pi/schedule-prompts.json`
- `.pi/schedule-prompts.json.tmp`

The scheduler writes its job store and atomic-write temporary file at these
paths. Changes to either excluded file, including job definitions stored there,
do not change the review fingerprint. Track a file if its changes must be part of
the review candidate.

Tracked files at those paths remain covered, including staged and unstaged edits
and deletions. Symlinks and other project files remain covered. The exclusion does
not extend to the whole `.pi/` directory, scheduler settings, similarly named
backups or nested workspaces.

## Coverage limits

Non-root workspaces, submodules, unavailable Git data and snapshots exceeding
limits produce **unverified** coverage. Ignored files are outside the fingerprint.
An unchanged fingerprint establishes only that the captured inputs match, not
that the review is complete or the work is approved for release.

See [Review evidence](subagents.md#review-evidence) for reviewer context and result
semantics.
