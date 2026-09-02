# Key collision map

A key reaches Jouzu only after the operating system, desktop or compositor, terminal emulator, and optional multiplexer decline to consume it. This map records known default interceptions that affect Jouzu or constrain future defaults.

The map covers defaults, not every user configuration. Desktop, terminal, and multiplexer bindings are configurable. Keyboard layout, locale, application mode, and terminal version can also change a result.

## Decision rule

| Status | Meaning | Rule for a new Jouzu default |
| --- | --- | --- |
| **Blocked** | A higher layer consumes the gesture before the terminal application receives it. | Do not use it. |
| **Conditional** | A higher layer consumes it only in a named mode, such as terminal selection or multiplexer copy mode. | Use it only with a visible, collision-free route to the same action. |
| **Encoding-dependent** | The gesture needs an enhanced keyboard protocol or collapses to another control byte. | It may be an accelerator, not the only route. |
| **Prefix** | A multiplexer consumes the first key and waits for another. | Do not use the prefix as an application default. |
| **Reserved** | Common platform defaults claim the range, but the exact claim varies by host. | Check the supported host set before assigning a key from the range. |

A new default must avoid every **Blocked** and **Prefix** row in the supported host set. A **Conditional** or **Encoding-dependent** default requires an unmodified route that remains visible in the same mode. Pi-owned defaults that Jouzu inherits remain in the map even when Jouzu cannot change them directly.

## Conflicts in the effective Jouzu and Pi map

The action IDs below come from Pi 0.84.3 plus Jouzu keybinding defaults version 2. Windows and Windows Subsystem for Linux (WSL) use Pi's Windows variants where noted.

| Gesture | Jouzu or Pi action | Higher-layer claim | Status | Remaining route or action |
| --- | --- | --- | --- | --- |
| `Ctrl+Enter` | `app.message.followUp` | Ghostty 1.3.1 on Linux toggles fullscreen. | **Blocked** | Rebind the Ghostty action or the Pi semantic action. See [Ghostty override](#ghostty-ctrlenter-override). |
| `Ctrl+↑` | `app.message.dequeue`; fullscreen `tui.altScreen.previousPrompt` | macOS opens Mission Control. A legacy terminal or multiplexer may also lose the modifier. | **Blocked** on default macOS; **Encoding-dependent** elsewhere | Customize `app.message.dequeue`. Fullscreen prompt navigation also has `Ctrl+Shift+↑` outside Windows/WSL. |
| `Ctrl+Shift+P` | `app.model.cycleBackward` outside Windows/WSL | Ghostty and WezTerm open their command palettes. Kitty uses `Ctrl+Shift+P` as the start of a key sequence. | **Blocked** | Open Models with `app.model.select`, or cycle forward with `app.model.cycleForward`. Windows/WSL uses `Alt+P` for this action. |
| `Ctrl+Shift+F` | `tui.altScreen.search` outside Windows/WSL | Ghostty and Windows Terminal open terminal search; WezTerm starts search; Kitty moves a terminal window. | **Blocked** | Rebind the Pi semantic action. Windows/WSL uses `Ctrl+F`. |
| `Ctrl+Shift+O` | `app.tree.filter.cycleBackward` | Ghostty creates a split; Kitty passes the selection to another program. | **Blocked** | `Ctrl+O` cycles forward. |
| `Ctrl+-` | `tui.editor.undo` outside Windows/WSL | Ghostty and WezTerm decrease font size. Windows Terminal also uses `Ctrl+-`, but Pi uses `Ctrl+Z` there. | **Blocked** in Ghostty and WezTerm | Rebind `tui.editor.undo`. |
| `Ctrl+Page Up`, `Ctrl+Page Down` | Alternate `tui.editor.pageUp` and `tui.editor.pageDown` bindings | Ghostty and WezTerm change terminal tabs. | **Blocked** | Unmodified `Page Up` and `Page Down` remain active. |
| `Ctrl+Shift+↑`, `Ctrl+Shift+↓` | `tui.altScreen.previousPrompt` and `tui.altScreen.nextPrompt` outside Windows/WSL | WezTerm changes pane focus; Kitty scrolls terminal history; Windows Terminal scrolls terminal history. | **Blocked** in those terminals | `Ctrl+↑` and `Ctrl+↓` remain Pi alternatives outside Windows/WSL, subject to the macOS reservation above. |
| `Alt+←`, `Alt+→` | Editor word motion and tree fold/unfold alternatives | Windows Terminal changes pane focus. | **Blocked** in Windows Terminal | `Ctrl+←` and `Ctrl+→` remain alternatives. |
| `Alt+↑`, `Alt+↓` | `app.models.reorderUp` and `app.models.reorderDown` | Windows Terminal changes pane focus. | **Blocked** in Windows Terminal | No Jouzu surface exposes these scoped-model actions. Do not reuse the gestures. |
| `Ctrl+B` | Alternate `tui.editor.cursorLeft` | tmux uses `Ctrl+B` as its default prefix. | **Prefix** in tmux | `←` remains active. Send a literal `Ctrl+B` with `Ctrl+B Ctrl+B` under the default tmux map. |
| `Ctrl+A` | Editor line start and context-specific select/filter actions | GNU Screen uses `Ctrl+A` as its command prefix. Byobu also intercepts `Ctrl+A` for its prefix setup. | **Prefix** in Screen and Byobu | `Home` remains the editor line-start route. Screen sends a literal `Ctrl+A` with `Ctrl+A a`. |
| `Enter`, `Ctrl+C` | Submit/confirm and cancel/clear actions | Windows Terminal copies a terminal selection instead of forwarding the key; without a selection it forwards the key. | **Conditional** | Clear the terminal selection. `Escape` remains the default cancel binding. |
| `Ctrl+Shift+S` | Jouzu `jouzu.model.toggleFavorite` accelerator in Models | Kitty 0.48.2 defaults it to `paste_from_selection`. Under legacy encoding the gesture collapses to `Ctrl+S` (`app.session.toggleSort`). | **Conditional** in Kitty; **Encoding-dependent** elsewhere | `Space` in Models browse state is the visible unmodified route; `Esc` leaves search with the query intact. Unmap the key in Kitty or rebind the Jouzu action. |
| `Shift+Enter` | Models project-default selection; `tui.input.newLine` | Basic terminal encoding cannot distinguish it from Enter or a newline. A terminal-side `text:\n` mapping also removes the modifier. | **Encoding-dependent** | Session selection remains on the effective `tui.select.confirm` binding. The project-default action is a known deviation until it has an unmodified route. |

These rows are conflicts, not a recommendation to replace one blocked modified key with another. Check the full map before selecting an alternative.

## Reserved ranges for future defaults

| Gesture or range | Default owner | Policy |
| --- | --- | --- |
| `Ctrl+,` | Ghostty on Linux and Windows Terminal open terminal settings. | Do not bind. |
| `Ctrl+Space` | macOS changes input source. Input methods and compositors commonly use it on Linux. | Do not bind in a product that supports an input method editor (IME). |
| `Alt+Enter` | Windows Terminal and WezTerm toggle fullscreen. | Do not bind. |
| `Ctrl+Tab`, `Ctrl+Shift+Tab` | Ghostty, Windows Terminal, WezTerm, and Apple Terminal change terminal tabs. | Do not bind. Jouzu uses unmodified `Tab` only while the Palette owns focus. |
| `Shift+←/→/↑/↓` | Ghostty adjusts the terminal selection. | Do not use as the only route. |
| `Ctrl+Shift+<key>` | Ghostty, Kitty, WezTerm, and Windows Terminal each claim different members of this range. | Check the exact key in each terminal. The whole range is not universally blocked. |
| `Super+<key>` | GNOME, Windows, macOS, and compositors use different members for desktop actions. | Do not assign a cross-platform default without an explicit per-platform audit. The whole range is not universally blocked. |
| `Alt+Tab` and platform equivalents | Operating systems and desktop environments switch applications or windows. | Do not bind. |
| `Ctrl+Alt+F1`–`F12` on Linux | The Linux console may switch virtual terminals. | Do not bind. |
| `F2`–`F9`, `F12`, modified variants | Byobu creates, changes, detaches, scrolls, renames, configures, or locks sessions. | Do not use as portable defaults. |
| `Alt+Page Up`, `Alt+Page Down` | Byobu enters scrollback mode. | Do not use as portable defaults. |
| `Ctrl+B` | tmux prefix. | Do not bind as the only route. |
| `Ctrl+A` | GNU Screen prefix and Byobu prefix setup. | Do not bind as the only route. |

## Terminal map

Only defaults that affect Jouzu or constrain likely alternatives are listed.

| Terminal baseline | Default interceptions relevant to Jouzu |
| --- | --- |
| Ghostty 1.3.1, Linux | `Ctrl+Enter`, `Ctrl+Shift+Enter`, `Ctrl+,`, `Ctrl+Shift+F`, `Ctrl+Shift+O`, `Ctrl+Shift+P`, `Ctrl+-`, `Ctrl+=`, `Ctrl+0`, `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+Page Up/Down`, `Shift+arrows`, `Shift+Home/End/Page Up/Page Down`, `Ctrl+Alt+arrows` |
| Kitty 0.48 default `kitty_mod=Ctrl+Shift`, non-macOS | `Ctrl+Shift+P` starts a sequence; `Ctrl+Shift+F/O/S/B/↑/↓/←/→/Page Up/Page Down/Enter` run terminal actions (`S` pastes the selection, `B` moves a window). Kitty's exact map is configurable. |
| WezTerm defaults | `Ctrl+-`, `Ctrl+=`, `Ctrl+0`, `Ctrl+Shift+F/P/↑/↓/←/→`, `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+Page Up/Down`, clipboard bindings, and terminal tab/pane actions |
| Windows Terminal defaults | `Ctrl+,`, `Ctrl+Shift+F`, `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Alt+arrows`, `Alt+Enter`, `F11`, clipboard bindings, and terminal tab/pane actions |
| Apple Terminal on macOS 26 | `Ctrl+Tab`, `Ctrl+Shift+Tab`, Command-based window, tab, scroll, clipboard, search, settings, and mark actions |

The terminal map is sampled rather than exhaustive. A new default must also be checked against any terminal added to Jouzu's release qualification set.

## Multiplexer map

### tmux

- The default prefix is `Ctrl+B`; the prefix key does not reach Jouzu.
- Prefix-table commands matter only after the prefix. Ordinary arrows, `Tab`, and `Enter` pass through while tmux is in its root table.
- Copy and choose modes intentionally own their navigation keys. Exit the mode before testing a Jouzu binding.
- A clean tmux 3.7b configuration has `extended-keys off` and `extended-keys-format xterm`. Modified Enter and modified arrows need an explicit extended-key configuration and terminal support.

```tmux
# ~/.tmux.conf
set -g extended-keys on
set -g extended-keys-format csi-u
```

Reload the tmux configuration, then verify the key in the application. Nested multiplexers need compatible settings at every layer.

### GNU Screen

- The default command prefix is `Ctrl+A`.
- Screen command sequences consume the key after the prefix; outside a Screen mode, other keys normally pass through.
- The GNU Screen manual used for this map does not document a tmux-equivalent CSI-u setting. Keep an unmodified application route and test the bytes delivered by the actual Screen version and outer terminal.

### Byobu

- Byobu uses tmux when available and can use GNU Screen instead.
- Byobu adds unprefixed `F2`–`F9`, `F12`, modified function-key bindings, and `Alt+Page Up/Down` above its backend.
- Byobu's tmux configuration also intercepts `Ctrl+A` for prefix selection.
- `Shift+F12` disables Byobu's function-key layer; backend bindings still apply.

A multiplexer does not by itself force the Palette into replacement presentation. Jouzu suppresses terminal inline-image detection under tmux and Screen, then selects floating or replacement presentation from the remaining terminal dimensions.

## Encoding and line discipline

Enhanced reporting and higher-layer shortcuts are separate checks. A key can survive the desktop and terminal shortcut maps but still lose its modifier in encoding or in a multiplexer.

| Gesture | Limitation |
| --- | --- |
| Modified Enter, arrows, and punctuation | Need the Kitty keyboard protocol, xterm `modifyOtherKeys`, or a terminal-side mapping. |
| `Ctrl+I`, `Ctrl+M`, `Ctrl+[`, `Ctrl+H` | Collapse to the same bytes as `Tab`, `Enter`, `Escape`, and `Backspace` without enhanced reporting. |
| `Ctrl+J` | Produces line feed and may be indistinguishable from a configured `Shift+Enter`. |
| `Ctrl+S`, `Ctrl+Q` | Act as XOFF/XON only while the terminal line discipline has software flow control enabled. A raw TUI normally disables it; shells and nested programs may differ. |
| `Ctrl+Z`, `Ctrl+\` | Can invoke terminal job-control signals while signal processing is enabled. Pi already owns `Ctrl+Z` for suspend on Unix. |

Windows Terminal added Kitty keyboard protocol support in version 1.25. Ghostty, Kitty, and WezTerm support enhanced reporting. Apple Terminal may send plain Return for `Shift+Enter`; Pi has a same-Mac modifier fallback for that gesture, but the fallback does not work over remote SSH and does not make every modified Enter portable. tmux needs compatible extended-key settings; no terminal protocol can recover a gesture already consumed by the operating system or terminal shortcut layer.

## Ghostty `Ctrl+Enter` override

Ghostty on Linux can send `Ctrl+Enter` to Jouzu instead of toggling fullscreen:

```ini
# ~/.config/ghostty/config
keybind = ctrl+enter=csi:13;5u
```

This sends the CSI-u enhanced-key representation of `Ctrl+Enter`. Rebinding the Pi semantic action in Jouzu's `keybindings.json` is the alternative.

## Verify one host

```bash
jz keybindings plan                 # Jouzu defaults and generic protocol warnings
# In a Jouzu session:
/hotkeys                            # effective Pi semantic bindings
ghostty +list-keybinds --default    # Ghostty defaults
tmux show-options -gv prefix
tmux show-options -gv extended-keys
tmux show-options -gsv extended-keys-format
byobu --version
```

`jz keybindings plan` does not inspect desktop, terminal, or multiplexer configuration. Compare its effective actions with this map and with the host's active configuration.

## Evidence and scope

Checked 2026-09-01:

- [Ghostty keybinding actions](https://ghostty.org/docs/config/keybind/reference), plus `ghostty +list-keybinds --default` from Ghostty 1.3.1 on Linux.
- [Windows Terminal actions and default bindings](https://learn.microsoft.com/en-us/windows/terminal/customize-settings/actions).
- [WezTerm default key assignments](https://wezterm.org/config/default-keys.html).
- [Kitty keyboard shortcut configuration](https://sw.kovidgoyal.net/kitty/conf/#keyboard-shortcuts), checked against Kitty 0.48.2's installed default definitions.
- [macOS keyboard shortcuts](https://support.apple.com/en-us/102650) and [Apple Terminal shortcuts](https://support.apple.com/guide/terminal/keyboard-shortcuts-trmlshtcts/mac).
- [GNOME keyboard shortcuts](https://help.gnome.org/users/gnome-help/stable/shell-keyboard-shortcuts.html.en) and the [Fcitx FAQ](https://fcitx-im.org/wiki/FAQ) for the `Ctrl+Space` input-method trigger.
- [tmux manual](https://man.openbsd.org/tmux.1), checked against a clean tmux 3.7b server.
- [GNU Screen default key bindings](https://www.gnu.org/software/screen/manual/html_node/Default-Key-Bindings.html).
- [Byobu manual and keybindings](https://manpages.ubuntu.com/manpages/noble/man1/byobu.1.html), checked against Byobu 7.15's installed tmux bindings.

The Linux command checks establish those named versions on one host. Windows and macOS rows are documentation checks, not native runtime tests. Custom key maps can add collisions that this document cannot predict.
