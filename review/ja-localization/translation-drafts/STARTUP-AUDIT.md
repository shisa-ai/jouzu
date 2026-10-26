# Japanese startup wiring audit

This supplements [the source reconciliation](CURRENT.md) with observations from the actual CLI startup wiring at product source `b703b9e` (v0.2.3). It does not replace the historical CSVs or change their row totals. No runtime translations are changed by this audit.

## Findings

In a fresh Core session, the active slash-completion provider returns **57 entries**. All 57 have matching English/Japanese catalog patterns. **55 descriptions match Japanese catalog output at startup; two remain English:**

| Surface | Observed English | Existing Japanese message ID | Cause |
| --- | --- | --- | --- |
| `/labels` description | Configure automatic session names and tmux pane labels | `jouzu.cli.sessionLabels.command.description` | `main-cli.ts` constructs `createSessionLabelsExtension` without its catalog argument |
| `/textguard` description | Review TextGuard findings, or set scanning to on, strict, or off | `jouzu.cli.textguard.commandDescription` | `main-cli.ts` constructs `createTextGuardReviewExtension` without `options.catalog` |

Both constructors fall back to `defaultCatalog()`, which resolves English. The slash-description localizer has no entry for either command to replace that output. The required change is catalog propagation, not new translation wording.

Seven command-detail scenarios were exercised through their registered startup handlers:

| Scenario | Observed result in Japanese startup |
| --- | --- |
| Labels status and help | English status block and command explanations |
| Labels invalid argument | English usage notice |
| TextGuard invalid argument | English usage notice |
| TextGuard empty reports | English empty-report notice |
| Voice invalid argument | Japanese usage notice; command syntax preserved |
| Subagents invalid argument | Japanese usage notice; command syntax preserved |
| Workflow invalid argument | Japanese usage notice; command syntax preserved |

The real `/settings` selector contributes **33 setting-field records**, plus **eight rendered views**: the root and its three available submenus (warnings, model thinking, theme), each at widths 48 and 100. These expose mixed-language output even when labels are Japanese. For example, the model-thinking submenu still displays `Step 1/2 · Select a model to configure`. That is an existing gap (`new-pi-0016` in `pi-and-previews-reconciliation.csv`), now observed through startup rather than only source inspection. Boolean/enum values and theme identifiers remain visible in the evidence; a changed panel is not classified as fully localized.

Full command descriptions and detail outputs are saved in [`startup-audit.json`](startup-audit.json). Its 48 surface records comprise 33 setting-field records, eight view renders, and seven notifications. These are observations, not counts of distinct untranslated strings.

## Why the earlier checks missed the two command descriptions

- The reconciliation covered every historical draft row but did not independently enumerate every runtime surface. Neither command-description ID nor either extension source file appears in those translation-draft CSVs.
- The command test in `packages/cli/test/runtime-localization.test.mjs` enumerated upstream Pi built-ins, despite its title also claiming bundled-command coverage. Its title now states the narrower scope.
- Component locale fixtures supply a Japanese catalog explicitly. They prove that a component can render Japanese; they do not prove startup passes that catalog.
- Catalog key/argument consistency and direct-string checks cannot detect an English catalog passed to an otherwise catalog-backed renderer.

## Reproduce

Use the checkout's locked dependencies and a fresh build. The probe refuses stale compiled output. It neither installs dependencies nor changes global links.

```sh
npm run build
node scripts/audit-ja-startup.mjs > startup-audit.candidate.json
npm run test:node -- packages/cli/test/localization-startup-audit.test.mjs
```

Inspect the candidate outside this directory before replacing the reviewed JSON. Review added/removed commands, changed output, protected technical values, message matches, and unexercised paths. Do not update the snapshot merely to make a test pass. When correcting a known gap, update both its classification and the finding here.

The probe creates separate temporary homes for English and Japanese, excludes ambient provider credentials and user configuration, sets offline/no-update options, and removes its homes afterward. It invokes the real `runMainCli`, binds the actual interactive extensions and their `session_start` handlers, and asks the active editor's completion provider for `/` suggestions. The command set comes from that provider, not the translation map. UI notifications are captured; `/settings` is opened through its real selector method, submenu navigation is cancelled without accepting a value, and component renders have terminal sequences stripped. No terminal loop, microphone/device enumeration, model request, or provider credit is used.

The test runs both startups and compares the report with the reviewed JSON. Added or removed commands, changed descriptions, lost Japanese wiring, and changed detail outputs require review. Negative controls cover an unregistered-in-the-snapshot command, a missing command, a Japanese description replaced by English, changed detail output, and empty/asymmetric/failed startup observations. Known English gaps are recorded explicitly: a passing audit test is **not** a claim that the interface has no English.

## Evidence states and remaining coverage

Each command records these separately:

- `catalog`: an exact English pattern has a differing Japanese counterpart, or no match was established. This does not prove wiring or translation quality.
- `startup_description`: the completion-provider output matches that Japanese counterpart, remains identical to English, or needs review.
- `detail_surfaces`: selected paths were exercised, or no detail path was exercised. This never means every submenu or state was covered.

Surface records distinguish setting fields, notifications, and component renders. Settings field records are **backing source data**, marked `source-data-not-rendered`: the localization adapter preserves those English fields and translates temporarily during rendering. Their English content is not an English-screen finding. Use view renders to inspect displayed labels. `changed-needs-review` means output differs between languages, not that all text is Japanese. Mixed English/Japanese content must still be reviewed.

This is a **Windows local, fresh-home Core-startup audit**, not repository-wide completion or platform qualification. The completion provider is exercised, but the slash-menu widget is not painted in a real terminal. Only the stated settings views are rendered. Model-dependent settings steps, automatic-theme submenus, nonempty TextGuard findings and decision views, account dialogs, user-configured resources, locale switching within a running session, launcher/installer text, and other command panels remain separate scenarios. Arbitrary user content and command identifiers must not be translated to satisfy an English detector.

For the next scenario, use the runtime entry point and real selected catalog; discover its items independently of translation maps; record both languages and the triggering state; exercise success, empty, error, and cancellation paths where applicable. Mark rendering and semantic review separately. Add a deliberately broken-wiring control before treating a passing test as coverage.
