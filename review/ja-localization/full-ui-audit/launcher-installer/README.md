# Launcher and installer Japanese UI source audit

Source: `fe0cf0878e35236ec9716f5d3ee237fff11c3480` on `jouzu-ja`.

This is a source/state ledger, not a translation patch or native acceptance result. No product code, dictionary, catalog, package lock, configuration, or global setting was changed. No build, package installation, external network/account operation, installer, native launcher, browser test, broad suite, or commit was run.

## Artifacts and scope

- `surfaces.csv`: reviewed screen/state and wiring entries, explicit unreachable boundaries, plus separately labelled mechanical diagnostic candidates. `L<number>` in `source_finding` anchors the finding in `source_file` at the audited revision.
- `files.csv`: a disposition for every tracked file under `apps/launcher/` and `packaging/launcher/`, including configuration, assets, tests and documentation. It also records the development helper and its immediate installation/validation helpers.
- `build-ledgers.py`: authored state inventory plus source-derived diagnostic rows and file census. It preserves existing CSVs unless explicitly given `--refresh`; it never modifies product sources.
- `validate-ledgers.py`: parses the CSVs and checks identifiers, columns, source paths/line bounds, relevant test paths, the tracked-file census and bootstrap/delegation dispositions. It does not execute product code.
- `validation.json`: computed checks, counts, source census digest and CSV hashes.

The census includes `apps/launcher/index.html` (initial `lang="en"`, document title `Jouzu Launcher`, root and `/src/main.tsx` bootstrap) and `apps/launcher/package.json` (version plus Vite/build/Tauri scripts and the version reference in `tauri.conf.json`). Neither establishes the language of native dialogs.

`packaging/launcher/network-acceptance.mjs` is `delegated`: its product CLI/catalog/inference behavior belongs to the other audit partitions. It is not counted as an inspected/excluded UI-completeness result here. Likewise, forwarding into product CLI reports, terminal panels, external browser/account pages, and the pinned reporter does not establish their coverage in this partition. The owning partitions must supply substantive evidence for them.

Build/sign/publish helpers are classified as infrastructure because their implementation is release preparation, not because another partition is assumed to have audited them. Test-only, documentation-only and demonstrably unreferenced code have separate reasoned exclusions. A production file's disposition is not a statement that every dependency or external system it calls has been inspected.

## Computed census

Counts come from the validation script, not estimates:

| Measure | Count |
| --- | ---: |
| Ledger rows (including candidates) | 487 |
| Noncandidate source entries (including exclusions/wiring) | 246 |
| `source-wired` rows | 196 |
| `source-internal` rows | 1 |
| `source-unreferenced` rows | 49 |
| `source-candidate` extraction rows, not reviewed UI states | 241 |
| File dispositions | 165 |
| Tracked files in the two scoped trees | 157 |
| Additional development/helper files | 8 |
| Missing tracked-tree dispositions | 0 |
| Main-dictionary-only keys without a production render reference | 44 |
| Delegated files | 1 |

### Reviewed conclusions versus extraction candidates

This bounded pass dispositioned the scoped production files and reviewed the major implemented state families: bootstrap/startup, onboarding, workspaces, provider/account configuration, Settings/environment/components, updates, confirmations, recovery and native error boundaries, installer language/hooks, cancellation and narrow-layout source rules. It does not establish independent completeness or native/runtime sign-off.

The 241 `source-candidate` rows are mechanical literal extraction from Rust/PowerShell error branches, updater internals and development-script output. Caller-family notes help a later reviewer investigate them, but **each candidate is not an independently reviewed or additional UI state**. Their findings and coverage limits explicitly mark that distinction. Raw substrings, lexical nearest-function matching and line bounds do not prove end-to-end reachability, visibility, state coverage or translation requirements. Candidates may overlap reviewed parent states or be internal only; they must not inflate completed-state or defect totals.

The 246 noncandidate entries also are **not unique screens or unique defects**: they include wiring, dictionary-only keys and exclusions as well as reviewed state families. One screen may have several reviewed states, and one error family can reach several entry points. No further diagnostic extraction is needed to reproduce this bounded inventory; semantic classification remains open.

`source-wired` means the caller/branch is present in inspected source. It does **not** mean observed at runtime, verified on Windows, or proven reachable with a qualified installed artifact. Conditional installer pages remain conditional. `source-internal` means a caller consumes/replaces the text rather than rendering it directly. `source-unreferenced` prevents dictionary presence or an exported helper from being promoted to an active UI. `source-candidate` means extracted evidence requiring individual review, not a reviewed conclusion.

`existing_test` names related existing tests, not a claim that the listed state is completely tested. Tests were read, not run. Most browser fixtures force English and mock native IPC. The main dictionary parity test cannot verify dialogs, layout, native errors, local update/recovery tables or installed runtime wiring.

## Reviewed source conclusions (bounded)

1. **The launcher and installer choose language independently.** `App.tsx` reads `localStorage["jouzu.ui.language"]` or `navigator.language`, then `resolveLocale()` and `messages[locale]`. Unsupported language preferences select English. It directly indexes complete typed tables; there is no per-key English fallback loader. `UpdatePreview` and recovery confirmation use separate local tables. These paths do not read the product Fluent catalogs. NSIS reads its remembered `Installer Language`; `/UPDATE` first selects `1033` and optionally overrides it from the registry. Changing launcher UI language does not update that preference or pass a locale to Rust/PowerShell/plugin operations.
2. **English authored failures reach Japanese views.** Startup errors, configuration cancellation/timeouts/protocol failures, sanitized `control.mjs` action failures, secure-environment validation/storage, helper failures, session locks, recovery and updater failures are passed through as strings. Startup presents a localized wrapper plus raw code/tooltip/clipboard; general errors present localized outer text plus technical details, and Settings also displays the raw alert. Component/update rows display raw errors directly. `RUNTIME_REPAIR_MESSAGE` gives full-installer guidance in English. Dependency/OS/source errors and their substitutions remain exact diagnostic content; this audit proposes no blanket translation of them.
3. **Default dialog close accessibility remains English.** `DialogContent` contains `<span className="sr-only">Close</span>`. The console-repair and restart-confirmation dialogs use that default. Settings supplies its own localized dismiss control. The exported `DialogFooter` has a separate English `Close` but has no current caller.
4. **The provider picker uses folder-specific empty text.** Its `empty` prop is `t.noResults`, whose Japanese value is `一致するフォルダーはありません。`. This is a source-proven mismatch in the provider-search context. The saved-provider search has no separate no-results message.
5. **Notes are content, not localized by the UI locale.** Update headers and empty-description text are Japanese-capable, but signed manifest/feed notes and their source marker are rendered unchanged. The notes producers read the release changelog; no Japanese-selection mechanism is wired.
6. **Installer wrappers do not translate helper details.** Custom NSIS `LangString`s have Japanese definitions and concrete call sites. Component preparation appends English summaries and a report path inside its localized warning. Locked launcher-only replacement shows `$1` directly. Standard NSIS/Tauri pages, helper macros, WebView2 installer text, native confirm buttons, folder-picker controls, and Windows security text are separate native paths, not covered by table presence.
7. **Several apparent surfaces are not active UI.** Dictionary entries for connection checks, import/profile choices, browser preview, maximize, extra empty/help states and other labels have no production render reference. Plain non-Tauri browser startup stays at the loader without an injected backend. `bug_report` is registered, but current report buttons open `https://github.com/shisa-ai/jouzu/issues`, not a draft form. The release-plan library and exported `rollbackJouzu()` are not called by the active launcher path. Repair uses Rust `restore_bundled()`.
8. **Cancellation/recovery state needs its own verification.** Native folder-picker cancel clears choosing without a notice. Device cancellation becomes a backend error before the panel clears. Closing the console-repair view does not cancel installation; retry installs Terminal but does not resume the original launch call. Updates expose no download/install cancel action. Interrupted update locks block recovery; static tests do not demonstrate a native recovery workflow. Cleanup-pending is returned by installation but not rendered as a separate warning.
9. **Narrow, timestamp and diagnostic content remain distinct.** The native minimum is `560x480`; Settings uses a bounded-height dialog, a fixed sidebar and scrolling; headings/descriptions/paths have specific truncation rules. No Japanese minimum-width/DPI/accessibility result is claimed. Crash timestamps use `toLocaleString()` without the selected UI locale; panic/WebView2 diagnostic strings remain unchanged.
10. **Development launcher language boundary is English.** Reviewed help and major build/link/prerequisite/lock/hook/smoke paths have no localization lookup. Individual error/output literals are retained as `source-candidate` leads, not as separately completed UI reviews. Commands, environment variables, paths, errors and product names are preserved. No development build/link/hook operation was performed.

The existing translation-draft coverage file was consulted only after independent source enumeration as a cross-check. Its proposed strings are not evidence of runtime language or native execution. The startup-localization audit script covers other runtime surfaces and is not a substitute for launcher-native inspection.

## Native and runtime blockers

- No Windows GUI, NSIS, installer/uninstaller, WebView2 process-failure event, DPAPI, Authenticode, process stop/file-lock scenario, shell tab, PATH mutation or native folder/confirm dialog was executed.
- The generated NSIS `language_files`, `utils.nsh` expansion, dependency-owned default button/accessibility wording and actual signed installed artifacts are not supplied by the checked-in source alone. Native Japanese rendering, focus/cancel behavior and line wrapping require separate controlled Windows evidence.
- Both normal and partial/silent/passive/update paths require care: the preparation warning suppresses passive interaction, but the process-close macro checks `IfSilent`, not `$PassiveMode`. Do not infer every passive path is noninteractive.
- Platform enums and pure library tests do not demonstrate macOS/Linux desktop support. Managed paths and helper execution require Windows resources; secure storage/session locking explicitly reject other platforms.
- A local source assertion or mocked browser test is not Windows/macOS acceptance, an account login, a real update, a successful native terminal/session launch, or proof that a recovered application starts correctly.

## Related focused checks

These commands identify relevant test corpora, not native execution evidence. Saved execution results are recorded separately in `../launcher-contract-test-evidence.json`. They require only the existing runtime/dependencies; do not install anything to run them. Run from the repository root through the project's bounded Node runner:

```bash
npm run test:node -- packaging/launcher/authenticate-recipe.test.mjs packaging/launcher/activate-update.test.mjs packaging/launcher/install-update.test.mjs packaging/launcher/stage-update.test.mjs packaging/launcher/runtime-requirements.test.mjs packaging/launcher/update-configuration.test.mjs packaging/launcher/update-transport.test.mjs packaging/launcher/runtime-pins.test.mjs packaging/launcher/jouzu-notes.test.mjs packaging/launcher/launcher-notes.test.mjs scripts/dev-smoke.test.mjs
```

Those implementations use in-memory/stubbed fetches, injected install/probe dependencies or temporary fixtures; they do not need a real update source, package install, installer or account. They check source/runtime contracts, not native Japanese UI.

If launcher dependencies are already installed, its existing Vitest tests can be targeted without a build:

```bash
npm --prefix apps/launcher test -- src/i18n.test.ts src/control-state.test.ts src/diagnostics.test.ts src/git-bash-section.test.tsx src/update-schedule.test.ts
```

The POSIX development-helper fixture corpus is also designed to avoid real installs/network/global links:

```bash
python3 scripts/test_dev_build.py
```

Do **not** run the full `prepare-component.test.mjs` under this audit's restrictions: it can compile and execute NSIS installers. `command-path.test.mjs` writes a user environment value; native command/Git/Terminal tests launch PowerShell/fixture executables; Cargo/Tauri builds may resolve packages. Browser tests need an existing server/dependencies and mock IPC. These need separate review/authorization or isolation, not inclusion in a broad test command.

Audit-only validation, executed successfully:

```bash
python3 review/ja-localization/full-ui-audit/launcher-installer/build-ledgers.py --refresh
python3 review/ja-localization/full-ui-audit/launcher-installer/validate-ledgers.py
```

The generator's `--refresh` only rewrites this partition's CSV files. Omit it to preserve them. The read-only validator can be rerun as-is; `--record` records a new `validation.json` and refuses to overwrite an existing record. Cross-partition reconciliation and semantic/runtime limits are recorded in [COVERAGE.md](../COVERAGE.md).
