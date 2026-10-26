# Japanese localization checklist

## Source inventory closed; execution and language review not complete

This is the translation backlog from the bounded source inventory. It is not an exhaustive string count, a promise that every state was exercised, or Japanese language/layout approval. See [FINDINGS.md](FINDINGS.md) for individual findings and [COVERAGE.md](COVERAGE.md) for limitations. No translations or product behavior were changed.

Priorities below are recommendations based on visibility and shared wiring, not measured usage.

## 1. Fix shared catalog wiring

- [ ] Pass the selected catalog to Labels, TextGuard review, runtime diagnostics, optional-extension diagnostics and tool-conflict notices.
- [ ] Pass the catalog through the shipped browser adapter registration.
- [ ] Correct catalog omissions in keybinding bootstrap, context-policy reload and catalog-refresh failure classification.
- [ ] Add Japanese startup regression cases for descriptions, reports and nonempty/error states—not only constructor fixtures.

Evidence: `terminal-owned/`, `semantic-release/`, `import-consumers/`; [startup observations](../translation-drafts/STARTUP-AUDIT.md).

## 2. Translate menus, submenus and status views

- [ ] Settings: source/credential guidance, composed thinking steps, human-readable values and theme actions.
- [ ] Workflow and subagents: role validation, lifecycle sentences, widget text and retained local failure framing. Check which widget/dashboard is actually attached.
- [ ] Work dashboard: `running`, `open`, `done`, `failed` counts; human display labels for raw states; local `lane`/`task` prefixes while preserving IDs.
- [ ] Tasks, Schedule, Background, Multiloop and Code Preview: nested menus, details, empty/error/confirmation states and notices.
- [ ] Session navigation and authentication: resume/tree filters and hints, rename/delete states, auth instructions/progress and callback controls.
- [ ] Flow, compaction, status and key hints: local recovery/action sentences, unavailable fallbacks and `Unbound`.

Evidence: `dependencies/`, `terminal-owned/`, `semantic-owned/`, `semantic-roles/`, `semantic-flow/`, `display-consumers/`.

## 3. Translate owned diagnostics and result framing

- [ ] Language recovery, model preferences, profile/import/update and private-storage errors: separate local prose from paths and native error details.
- [ ] TextGuard: local withholding/failure text can reach live tool rows and saved history; request-only history filtering is a different path.
- [ ] Tool results: local success/error/empty/limit framing, fetch/PDF extraction headings and native fallback expand hints.
- [ ] Flow result bodies and extension-error framing: `model-only` is not a terminal-visibility flag. Preserve hashes, references, stable codes and machine fields.
- [ ] Compatibility-review retained text and receipt hashes before changing persisted or protocol content.

Evidence: `semantic-owned/`, `semantic-dependencies/`, `semantic-flow/`, `host-consumers/`, `import-consumers/`.

## 4. Cover separate presentation surfaces

- [ ] Exported HTML viewer: controls, search/filter, tooltips, thinking/output and parameter framing, including CSS-generated hints.
- [ ] Launcher: accessible `Close`, provider-search empty wording and owned error details inside Japanese wrappers.
- [ ] Installer/recovery: local summaries and validation framing, separately from OS messages.
- [ ] Operator/development tools: English-only help/progress where Japanese support is intended.

Evidence: `semantic-dependencies/`, `launcher-installer/`, `semantic-launcher/`, `operator-cli/`.

## Not blanket translation targets

Preserve commands, identifiers, paths, URLs, code, actual user/model text, external page/service content and genuine native diagnostics. Stable stored state can receive a localized display label without changing its value. Follow `docs/localization-glossary.md` for protected product names. English dictionary equality is a review lead, not a defect count.

The inspected external-receipt API forwards to a user-supplied transport; it does not establish a shipped receipt screen. Arbitrary plugins, transports and provider implementations are outside this bounded inventory.

## Explicit follow-up, not part of this inventory closure

- [ ] Finish semantic review of the saved command-route mapping; its structural checks pass, but the final review/report was interrupted.
- [ ] Resolve the listed Settings keyboard-callback and other asynchronous/attachment/provider display boundaries in `COVERAGE.md`.
- [ ] Exercise safe Japanese nonempty/error/cancel/expanded states with isolated fixtures.
- [ ] Check narrow terminals, CJK width, input-method composition, focus and accessibility natively.
- [ ] Separately authorize authenticated, installer, updater and other machine-mutating acceptance scenarios.
- [ ] Obtain qualified Japanese wording and layout review.

These are remaining verification requirements, not reasons to keep expanding the source inventory.
