# Jouzu interaction model

This guide governs every Jouzu-owned interactive surface: the Palette, the Session Frame, Help, first-run prompts, and command output. It defines what Jouzu inherits from Pi, how keys are assigned, which key combinations other software already claims, and how surfaces behave when the terminal cannot support the full design.

The guide states intended behavior. Tests encode it. A view that disagrees with this guide is a defect in the view, not an amendment to the guide. [`palette-ux.md`](palette-ux.md) is the Palette chapter and applies in addition to this one.

## Surfaces

| Surface | Module | Presentation | Governed by |
| --- | --- | --- | --- |
| Palette (Models, Settings / Catalogs) | `packages/cli/src/palette.ts`, `model-picker.ts`, `catalog-settings.ts` | Floating overlay or in-place replacement | [`palette-ux.md`](palette-ux.md) |
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
| Keybinding file format and resolution | Pi (`keybindings.json`) | Inherited. Jouzu seeds two defaults once into its isolated agent root and never rewrites an existing file. |
| Palette views, model ranking, catalog settings, Session Frame, startup header | Jouzu | Owned outright. |
| `app.model.select` routing (`Ctrl+L`), `app.model.cycleForward` (`Ctrl+P`) | Pi action, Jouzu handler | Jouzu routes the semantic action to its own view and list. The binding stays Pi's and stays user-configurable. |

Two consequences follow. A new Jouzu action gets a semantic ID and a default binding, not a raw key check in a component. A key that Pi already defines keeps Pi's meaning unless a recorded decision overrides it.

## Key assignment rules

1. **Every action must be reachable without a modified key.** Modified keys are accelerators. `Ctrl`, `Alt`, `Shift`, and `Super` combinations that a legacy terminal cannot encode are unavailable to some users on every platform; see [Encoding requirements](#encoding-requirements).
2. **Check both binding tables before claiming a key.** Pi's `TUI_KEYBINDINGS` and Jouzu's `JOUZU_KEYBINDING_DEFAULTS` are the two tables Jouzu already occupies. A raw `matchesKey` call that shadows an entry in either table is a defect.
3. **Prefer a semantic action to a raw key.** Use `keybindings.matches(data, "<action>")`. Use `matchesKey` only where Pi defines no action for the interaction, and record why.
4. **A mode with a live text field has no bare-letter and no bare-`Space` shortcuts.** While a text field holds focus, letters, digits, punctuation, and `Space` belong to it. A mode with no text field may use them. This protects search and IME composition; see [Text, language, and input](#text-language-and-input).
5. **`Tab` belongs to the innermost visible tab row.** A surface shows at most one tab row. A surface with no visible tab row does not advertise `Tab` navigation and does not require `Tab` to reach any control.
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

A keystroke passes through four layers before a Jouzu view sees it. Each layer can consume it, and the layers above the terminal are outside Jouzu's control.

```text
compositor / window manager / OS   niri, GNOME, KDE, Windows, macOS
   └─ terminal emulator            Ghostty, Windows Terminal, iTerm2, Apple Terminal
        └─ multiplexer (optional)  tmux, screen
             └─ Pi + Jouzu
```

A binding that is valid in `keybindings.json` and reportable by the terminal is still unreachable if a higher layer grabs it. Jouzu does not detect these grabs; it avoids them by default and documents the mitigation.

### Do not bind

| Key | Claimed by | Effect |
| --- | --- | --- |
| `Ctrl+,` | Ghostty 1.3 `open_config` on Linux; Windows Terminal `Terminal.OpenSettingsUI` | Opens the terminal's own settings. Never reaches Jouzu. |
| `Ctrl+Space` | macOS "Select previous input source"; fcitx5 and ibus IME toggle on Linux; common compositor launcher binding | Switches input method or opens a launcher. Unusable for a Japanese-capable product. |
| `Ctrl+Alt+Backspace` | X11 zap; niri `quit` | Ends the graphical session. |
| `Ctrl+Alt+F1`–`F12` | Linux virtual-terminal switching | Leaves the graphical session. |
| `Ctrl+S`, `Ctrl+Q` | Terminal XON/XOFF flow control | Freezes and unfreezes terminal output. |
| `Ctrl+Z`, `Ctrl+\` | Job control (`SIGTSTP`, `SIGQUIT`) | Suspends or kills the process. |
| `Super+<key>` | Every desktop compositor | Reserved by the desktop. Reaches the terminal only under a custom configuration. |
| `Ctrl+Shift+<letter>` | Terminal copy, paste, search, split, tab, palette, inspector across Ghostty and Windows Terminal | Mostly consumed by the terminal. Treat the whole range as unavailable. |

### Reserved by terminal and desktop

Verified against Ghostty 1.3.1 (`ghostty +list-keybinds --default`), niri 26.04, and the Windows Terminal default action list; macOS entries are from Apple's keyboard-shortcut documentation.

| Key | Layer | Claim |
| --- | --- | --- |
| `Ctrl+Enter` | Ghostty (Linux) | `toggle_fullscreen`. Jouzu's `app.message.followUp` default is unreachable until the user overrides it. |
| `Ctrl+Shift+Enter` | Ghostty | `toggle_split_zoom` |
| `Ctrl+Tab`, `Ctrl+Shift+Tab` | Ghostty, Windows Terminal | Next and previous tab |
| `Ctrl+PageUp`, `Ctrl+PageDown` | Ghostty | Previous and next tab |
| `Shift+Home`, `Shift+End`, `Shift+PageUp`, `Shift+PageDown` | Ghostty | Scrollback movement |
| `Shift+←`, `Shift+→`, `Shift+↑`, `Shift+↓` | Ghostty | Adjust selection |
| `Ctrl+Alt+←/→/↑/↓` | Ghostty split focus; niri workspace focus | Two layers claim the same range; niri wins |
| `Ctrl+Alt+Shift+←/→`, `Ctrl+Shift+Alt+↑/↓` | niri | Move column and move window to workspace |
| `Alt+1`–`Alt+9` | Ghostty | Go to tab |
| `Alt+Tab`, `Alt+Shift+Tab`, `Alt+Enter`, `Alt+\`` | niri and most desktops | Window switching and fullscreen |
| `Ctrl+=`, `Ctrl+-`, `Ctrl+0` | Ghostty, Windows Terminal | Font size |
| `Ctrl+C`, `Ctrl+V` | Windows Terminal | Copy when a selection exists, otherwise passed through; paste always consumed |
| `Ctrl+Insert`, `Shift+Insert` | Ghostty, Windows Terminal | Copy and paste |
| `F11` | Windows Terminal | Fullscreen |
| `Ctrl+↑`, `Ctrl+↓` | macOS | Mission Control and App Exposé. Jouzu's `app.message.dequeue` default is affected. |
| `Ctrl+←`, `Ctrl+→` | macOS | Move between Spaces when more than one Space exists |
| `Ctrl+Cmd+F` | macOS | Fullscreen |
| Prefix key, default `Ctrl+B` | tmux | Consumed before the application |

Compositor and terminal configurations are user-editable, so this table describes defaults, not guarantees. A user who rebinds a terminal key recovers the application key.

### Encoding requirements

A legacy terminal encodes only what ASCII can express. These gestures need the Kitty keyboard protocol, xterm `modifyOtherKeys`, or an explicit terminal-side mapping:

- `Ctrl+Enter`, `Shift+Enter`, and every other modified `Enter`;
- modified arrow keys, including `Ctrl+↑` and `Ctrl+↓`;
- `Ctrl` with punctuation, including `Ctrl+,`;
- `Super` with anything.

Support by terminal: Ghostty, Kitty, WezTerm, and foot implement the Kitty keyboard protocol. Windows Terminal added it in version 1.25. Apple Terminal does not implement it; iTerm2 does in recent versions. Inside tmux, set `extended-keys on` and `extended-keys-format csi-u`; without them tmux discards the modifiers.

Some `Ctrl` combinations collapse into control codes that are indistinguishable from another key:

| Gesture | Byte | Also produced by |
| --- | --- | --- |
| `Ctrl+I` | `0x09` | `Tab` |
| `Ctrl+M` | `0x0D` | `Enter` |
| `Ctrl+J` | `0x0A` | `Shift+Enter` under some terminal configurations |
| `Ctrl+[` | `0x1B` | `Escape` |
| `Ctrl+H` | `0x08` | `Backspace` |
| `Ctrl+D` | `0x04` | End of file on an empty line |

Under the Kitty protocol these become distinguishable. Jouzu does not rely on that: a binding that needs disambiguation is an accelerator, and rule 1 still applies.

### Working around a collision

A user who wants a colliding Jouzu binding can remap the higher layer. Ghostty on Linux, where `Ctrl+Enter` is `toggle_fullscreen` by default:

```ini
# ~/.config/ghostty/config
keybind = ctrl+enter=csi:13;5u
```

This sends the CSI-u sequence for `Ctrl+Enter` to the application instead of toggling fullscreen. The equivalent for other layers is to unbind or rebind the grab in the compositor or terminal configuration.

### Verifying on one machine

```bash
jz keybindings plan          # effective Jouzu/Pi bindings and portability warnings
/hotkeys                     # effective Pi map inside a session
ghostty +list-keybinds --default   # Ghostty grabs
showkey -a                   # bytes a key actually produces (Linux console)
```

`jz keybindings plan` reports the modified-Enter, modified-arrow, tmux, macOS, and `TERM=dumb` warnings without changing any binding.

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
| tmux or screen | Inline image protocols are unavailable; the Palette selects the replacement presentation. Modified keys need `extended-keys` as above. |
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
3. check new bindings against `TUI_KEYBINDINGS`, `JOUZU_KEYBINDING_DEFAULTS`, and the [Do not bind](#do-not-bind) table;
4. keep every rendered line inside the requested width at 48 columns with mixed-width text;
5. carry tests for the behavior it changes, including the mode transitions in [`palette-ux.md`](palette-ux.md);
6. leave no meaning encoded in color alone.

Run `npm run check` and `npm test` before committing.

### Known deviations

| Surface | Deviation | Resolution |
| --- | --- | --- |
| Help (`help.ts`) | Renders its own overlay outside the Palette router with its own frame and sizing, and lists a shortcut set that is maintained by hand. | Becomes a Palette view when it can derive commands and effective bindings from the runtime registries. |
| Models (`model-picker.ts`) | `Ctrl+F` shadows Pi's `tui.editor.cursorRight`; `Shift+Enter` shadows `tui.input.newLine`; `Home` and `End` move the list instead of the search cursor. | Rebinding under review. |
| Palette router (`palette.ts`) | `Ctrl+,` reaches Settings but is consumed by Ghostty on Linux and by Windows Terminal. A view switch also discards an unsaved form without confirmation. | `/catalogs` is the reliable route. Replacement binding under review. |
