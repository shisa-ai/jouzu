# Jouzu interaction model

This guide governs every Jouzu-owned interactive surface: the Palette, the Session Frame, Help, first-run prompts, and command output. It defines what Jouzu inherits from Pi, how keys are assigned, which key combinations other software already claims, and how surfaces behave when the terminal cannot support the full design.

The guide states intended behavior. Tests encode it. A view that disagrees with this guide is a defect in the view, not an amendment to the guide. [`palette-ux.md`](palette-ux.md) is the Palette chapter and applies in addition to this one.

## Surfaces

| Surface | Module | Presentation | Governed by |
| --- | --- | --- | --- |
| Palette (Models, Workflow, Settings / Catalogs) | `packages/cli/src/palette.ts`, `model-picker.ts`, `workflow.ts`, `catalog-settings.ts` | Floating overlay or in-place replacement | [`palette-ux.md`](palette-ux.md) |
| Help | `packages/cli/src/help.ts` | Floating overlay | This guide; see [Known deviations](#known-deviations) |
| Session Frame (prompt frame, session line, status bar) | `packages/session-ui/src` | Persistent, around Pi's editor | This guide |
| Startup header | `packages/cli/src/presentation.ts` | One-time output | This guide |
| First-run prompts (Japanese support, Pi import) | `profile-choice.ts`, `pi-import.ts` | Line-oriented `readline` | This guide, [Non-interactive and degraded modes](#non-interactive-and-degraded-modes) |
| Command output (`doctor`, `catalog`, `keybindings`, `self-update`) | `doctor.ts`, `catalog-command.ts`, `keybindings.ts`, `updater.ts` | Text and `--json` | This guide, [Messages](#messages) |

## What Jouzu inherits from Pi

Jouzu adds surfaces to Pi rather than replacing Pi's input model. Read this table before adding a key or a component.

| Concern | Owner | Jouzu's position |
| --- | --- | --- |
| Editor text keys, kill ring, undo, word motion (`tui.editor.*`) | Pi | Inherited unchanged. Jouzu never reimplements text editing. |
| List selection (`tui.select.up/down/pageUp/pageDown/confirm/cancel`) | Pi | Inherited. Jouzu views resolve these through `KeybindingsManager`, not raw key matching. |
| Submit, newline, autocomplete Tab (`tui.input.*`) | Pi | Inherited. The prompt frame preserves Pi routing and only adds framing. |
| Transcript scroll and search (`tui.altScreen.*`) | Pi | Inherited. Jouzu adds no competing scroll keys. |
| Slash commands, `/hotkeys`, dialogs, autocomplete menus | Pi | Inherited. Jouzu registers commands; it does not intercept a working Pi command to show an unavailable view. |
| Theme roles and color capability | Pi theme, Jouzu `session-ui/styles.ts` | Jouzu maps its own semantic roles onto Pi's theme and emits no raw escapes from views. |
| Overlay compositing, placement, z-order, focus capture | Pi | Inherited through one adapter in `palette.ts`. Views never call Pi overlay methods directly. |
| Keybinding file format and resolution | Pi (`keybindings.json`) | Inherited. Jouzu seeds two defaults once into its isolated agent root and never rewrites an existing file. Jouzu-owned `jouzu.*` actions resolve through a Jouzu registry reading the same file; Pi ignores entries it does not define. |
| Palette views, model ranking, catalog settings, Session Frame, startup header | Jouzu | Owned outright. |
| `app.model.select` routing (`Ctrl+L`), `app.model.cycleForward` (`Ctrl+P`) | Pi action, Jouzu handler | Jouzu routes the semantic action to its own view and list. The binding stays Pi's and stays user-configurable. |

Two consequences follow. A new Jouzu action gets a semantic ID and a default binding, not a raw key check in a component. A key that Pi already defines keeps Pi's meaning unless a recorded decision overrides it.

## Key assignment rules

1. **Every action must be reachable without a modified key.** Modified keys are accelerators. `Ctrl`, `Alt`, `Shift`, and `Super` combinations that a legacy terminal cannot encode are unavailable to some users on every platform; see [Encoding and line discipline](key-collisions.md#encoding-and-line-discipline). A recorded decision may accept an accelerator-only action; the current exception is Models favorite (`jouzu.model.toggleFavorite`), recorded in [palette-ux.md](palette-ux.md#key-assignment-rules).
2. **Check both binding tables before claiming a key.** Pi's `TUI_KEYBINDINGS` and Jouzu's `JOUZU_KEYBINDING_DEFAULTS` are the two tables Jouzu already occupies. A raw `matchesKey` call that shadows an entry in either table is a defect.
3. **Prefer a semantic action to a raw key.** Use `keybindings.matches(data, "<action>")`. Use `matchesKey` only where Pi defines no action for the interaction, and record why.
4. **A mode with a live text field has no bare-letter and no bare-`Space` shortcuts.** While a text field holds focus, letters, digits, punctuation, and `Space` belong to it. A mode with no text field may use them. This protects search and IME composition; see [Text, language, and input](#text-language-and-input). A view with type-to-search, where typing focuses the search field, has no usable bare-letter layer even in browse; its browse actions use non-printable unmodified keys only.
5. **`Tab` belongs to the single visible tab row.** The Palette reserves that row for top-level sections such as Models and Settings. Choices inside a section use `←` and `→`. A surface with no visible tab row does not advertise `Tab` navigation and does not require `Tab` to reach any control.
6. **The focused element claims its own keys first.** A focused text field keeps `←`, `→`, `Home`, and `End`. Only a non-text focus may use `←` and `→` for a discrete choice or for disclosure. List extremes use `Ctrl+Home` and `Ctrl+End` in a surface whose text field is live.
7. **Hints name resolved bindings, not hardcoded labels,** wherever `KeybindingsManager` can resolve them. A hint that names a key the user has rebound is wrong on that user's machine.
8. **Destructive and recovery actions keep a reachable path.** Cancel, interrupt, and exit must remain reachable when a terminal drops modified keys.

### Routing precedence

The focused scope decides which action runs, highest first:

1. active modal or custom component (the Palette while it owns focus);
2. active selector, tree, or autocomplete menu;
3. fullscreen transcript viewport;
4. focused editor or text input;
5. application and session actions;
6. global actions.

The same physical key may carry different actions in scopes that are never eligible at the same time. Two actions eligible in one scope at one moment are a conflict, not context routing.

## Key collisions

A keystroke passes through four layers before a Jouzu view sees it:

```text
operating system / desktop / compositor
   └─ terminal emulator
        └─ multiplexer (optional: tmux, GNU Screen, Byobu)
             └─ Pi + Jouzu
```

[`key-collisions.md`](key-collisions.md) is the collision authority. It maps the effective Pi and Jouzu defaults to operating-system, terminal, tmux, GNU Screen, and Byobu interceptions; distinguishes blocked, conditional, prefix, and encoding failures; and records the evidence for each supported baseline.

Apply these rules before assigning a key:

1. Do not add a default that the map marks **Blocked** or **Prefix** on a supported host.
2. A **Conditional** or **Encoding-dependent** gesture may be an accelerator only when the same action has a visible unmodified route.
3. Check the exact key rather than banning an entire modifier range. `Ctrl+Shift` and `Super` ranges contain many platform claims, but no source establishes that every member is blocked.
4. Treat desktop, terminal, and multiplexer configuration as mutable. The map covers named defaults; `/hotkeys` and host configuration establish one user's effective result.

`jz keybindings plan` reports Jouzu's desired actions and generic modified-key warnings. It does not inspect higher-layer shortcuts. Use `/hotkeys` for the effective Pi map, then compare it with the collision map and the host's active terminal and multiplexer configuration.

## Text, language, and input

- IME composition input goes to the focused text field and is never interpreted as a shortcut. This is why rule 4 exists: a bare-letter shortcut competing with a live text field breaks Japanese, Chinese, and Korean input.
- Measure terminal display columns, not JavaScript string length. Every rendered line must fit its width after ANSI removal and grapheme, emoji, and CJK measurement. `packages/cli/src/terminal-layout.ts` and `packages/session-ui/src/layout.ts` supply the primitives.
- Sanitize external text before styling it. Catalog labels, model names, provider IDs, and error text from a remote source pass through `sanitizeTerminalText` first.
- Never render a credential value. Report whether a named environment variable is set; do not print its contents, and keep it out of configuration, cache, logs, errors, tests, and rendered output.
- User-visible strings are English in v0.1. Do not add a translation catalog or a language switch before the release that owns localization.

## Non-interactive and degraded modes

| Condition | Required behavior |
| --- | --- |
| Not a TUI (`ctx.mode !== "tui"`, piped output, `--print`) | The surface does not open. The command produces text or `--json` output and a meaningful exit status. |
| `NO_COLOR` | Labels, markers, and symbols carry every meaning that color carries. Selection, warning, failure, and availability remain distinguishable. |
| `TERM=dumb` | No interactive key events are available. Report the limitation rather than rendering an unusable view. |
| Narrow or short terminal | The Palette falls back from floating to in-place replacement below 58 columns or 16 rows. Both presentations offer the same actions and the same cancel result. |
| Minimum width | Views render every required label in full at 48 columns. Reduce value width or change layout instead of clipping a label. Below 12 columns a view may render its title alone. |
| tmux or GNU Screen | Jouzu suppresses terminal inline-image detection, then chooses floating or replacement presentation from terminal dimensions. tmux modified keys need the extended-key settings in the collision map; test GNU Screen delivery on the active stack. |
| Windows | Windows Terminal or another UTF-8-capable terminal is required. See [`windows.md`](windows.md). |

Color, cursor shape, and cursor position are never the only indication of selection, state, or failure.

## Messages

- Name the operation while it runs, including the object: `Refreshing Office pool…`.
- State the failure class before the details: authentication, denied access, validation, network, or storage.
- Give the user an action when recovery is possible.
- Wrap within the frame. Do not truncate the status, the field name, or the recovery action to fit one row.
- Do not explain internal mechanics in a user-facing message. Endpoint probing, cache paths, and request sequencing are not user tasks.
- Write for a user, not for a maintainer. Every user-facing string states what happened or what to do; remove internal jargon and explain any term the reader needs. This applies to hints, errors, command output, and help text.

## Conformance

A change to an interactive surface must:

1. use semantic actions where Pi defines them, and record why where it does not;
2. keep every action reachable without a modified key;
3. check new bindings against `TUI_KEYBINDINGS`, `JOUZU_KEYBINDING_DEFAULTS`, and the [key collision map](key-collisions.md);
4. keep every rendered line inside the requested width at 48 columns with mixed-width text;
5. carry tests for the behavior it changes, including the mode transitions in [`palette-ux.md`](palette-ux.md);
6. leave no meaning encoded in color alone.

Run `npm run check` and `npm test` before committing.

### Known deviations

| Surface | Deviation | Resolution |
| --- | --- | --- |
| Help (`help.ts`) | Renders its own overlay outside the Palette router with its own frame and sizing. Its command list is maintained by hand, although semantic key labels resolve from the effective binding map. | Becomes a Palette view when it can derive commands and effective bindings from the runtime registries. |
