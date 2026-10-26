# Launcher diagnostic semantic follow-up

This source pass resolves the mechanical diagnostic candidates from `../launcher-installer/surfaces.csv` through full producer-file reads and bounded immediate-consumer tracing. It does not replace the earlier screen/state ledger or claim native execution.

## Scope and artifacts

`validation.json` records **33 full-read primary files**, **33 grouped source families** and **241 candidate resolutions**. These are records, not independent screens, unique messages or unique translation defects. `candidate-resolutions.csv` maps each original candidate ID to exactly one reviewed family and its caller-specific visibility classification. The original extraction rows remain available as discovery evidence.

- `files.csv`: specific full-read producer dispositions, source hashes and consumer findings.
- `surfaces.csv`: meaningful grouped state/visibility families in the common audit schema.
- `candidate-resolutions.csv`: closure of the original finite candidate set, not a new mechanical extraction.
- `build-ledger.py`: the authored semantic conclusions and deterministic artifact generator.
- `resolution_test.py`: candidate membership/uniqueness, family/path/line checks and regressions for replaced, nonvisible and unselected paths.

Immediate consumers were read or traced in `apps/launcher/src/App.tsx`, `components/component-row.tsx`, `command-entry-section.tsx`, `git-bash-section.tsx`, `terminal-section.tsx`, `update-preview.tsx`, `use-jouzu-update.ts`, and `packaging/launcher/{control,update-service,install-update,runtime-requirements}.mjs` plus `installer-hooks.nsh` and `installer-messages.nsh`. This is bounded consumer tracing, not a claim that every transitive dependency or every frontend file was semantically reviewed in this pass.

## What the caller tracing changes

1. **Internal update errors are not separate launcher messages.** Authentication, download, staging, activation and transport failures usually reach `update-service.mjs`, which replaces them with one sanitized English error. The coded runtime-repair exception preserves its own English full-installer guidance. Source exceptions and visible UI copy must not share a defect total.
2. **Cleanup can become a flag rather than an error sentence.** Preflight pruning failures reject the update. Pruning failures during final cleanup are caught and become `cleanupPending`; the frontend does not render a separate cleanup warning. These are different states, not two visible versions of the same exception.
3. **Modal and component consumers differ.** System component rows render captured helper errors directly. The console-repair modal captures the backend error but shows localized `consoleRepairFailed`, not the raw sentence. A source-only blanket claim that every Terminal error is visible in the modal would be false.
4. **Crash dismissal rejection is not routed to the alert.** The dismiss callback refreshes diagnostics in `finally` without catching into `setError`. Its two authored rejection strings therefore do not establish visible English alerts. Crash-record `message` is displayed verbatim; WebView2 process names/reasons are composed diagnostic content, distinct from ordinary controls.
5. **Installer detail paths differ.** Locked launcher-only replacement displays helper output directly in an NSIS message. The stop-process path adds helper output to localized technical details. Component preparation stores sanitized raw helper details in JSON but prints a short English failure/report-path summary; that summary is what the installer embeds in its Japanese warning.
6. **Repair is not rollback.** The exported JavaScript `rollbackJouzu()` has no production caller in the reviewed launcher tree; its tests call it. Active repair is Rust `restore_bundled()`. The exported rollback errors are not active launcher recovery states merely because they exist in a packaged module.
7. **Configuration sanitization is not localization.** `control.mjs` deliberately replaces upstream errors with action-specific English. The Rust bridge and frontend preserve those replacement sentences inside Japanese outer framing. Underlying account/parser strings cannot each be counted as visible through this path.
8. **The developer script is a separate interface.** `dev-build.sh` has English help/progress/error/hook messages and no locale lookup. Commands, paths, versions and environment-variable names are preserved. Reading it did not install dependencies, build, link, alter hooks or acquire a lock.

## Reproduce the artifact checks

From the repository root:

```sh
python review/ja-localization/full-ui-audit/semantic-launcher/build-ledger.py
python -m unittest discover -s review/ja-localization/full-ui-audit/semantic-launcher -p '*_test.py' -v
python review/ja-localization/full-ui-audit/validate.py
```

Regeneration must not be used to approve changed source blindly: inspect producer/caller changes before accepting new hashes or classifications. The tests establish structural and selected semantic-classification regressions, not successful native traversal or a Japanese rendering assertion.

## Remaining limits

The finite candidate set is source-dispositioned. The extraction was never a complete string/exception parser, so this does not prove that no unlisted diagnostic or state exists. Direct library/build callers can still expose diagnostic exceptions outside the reviewed active-launcher path. Native NSIS expansion, Windows security/WebView2 dialogs, secure storage, process/file locks, recovery/update transactions, accessibility and CJK layout remain unexecuted. Preserve OS errors, credentials, paths, remote/source text and stable protocol fields; assess localized display framing separately.
