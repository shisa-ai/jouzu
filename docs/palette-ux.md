# Palette interaction standards

This guide defines keyboard interaction, focus, feedback, and layout for Jouzu-owned Palette views. Contributors must apply it when adding or changing an interactive terminal view. It states intended behavior; tests encode it. A view that disagrees with this guide is a defect in the view.

[`ux.md`](ux.md) governs every Jouzu surface and holds the key-assignment rules, the routing precedence, and the platform key-collision tables. Read it first; this guide adds the Palette-specific requirements.

## Interaction model

A Palette view has one visible mode at a time:

- **Browse:** move through a collection and run an action on the selected item.
- **Edit:** change a form and either save or cancel it.
- **Confirm:** approve or cancel one destructive action.

**Busy** is a state layered on any of the three, not a fourth mode. While an operation runs, the view names the operation, disables conflicting actions, and offers cancellation when the operation supports it.

Search focus is a named state of browse in a searchable view, not a mode and not a secret. The title names it, such as `· Search`; the hint footer lists only keys that work in it; and cancel leaves it before closing the view. Every committal row action — selecting an item, toggling a marker such as favorite, writing a default — must remain reachable while search holds focus, through a semantic accelerator or a one-keystroke transition that keeps the query.

The title, selection marker, fields, and key hints must make the active mode and the busy state apparent. Do not require the user to infer a mode or state from a key that stopped working.

### Common keys

Use the same key for the same class of action across Palette views:

| Key | Meaning |
| --- | --- |
| `↑` / `↓` | Move by one item or one form field. |
| `Page Up` / `Page Down` | Move by one visible page in a long collection. |
| `Home` / `End` | Move to the first or last item, in a view with no live text field. |
| `Ctrl+Home` / `Ctrl+End` | Move to the first or last item in a view whose text field is live. |
| `←` / `→` | Move the cursor in text, change a visible discrete choice, or collapse and expand a selected item, resolved by [key precedence](#key-precedence). |
| `Enter` | Run the selected item's primary action, save an edit, or accept a confirmation. |
| `Esc` | Cancel the active edit or confirmation. In browse mode, close the Palette. |
| `Space` | Toggle a focused boolean field. Unavailable in a view with a live text field. |
| `Tab` / `Shift+Tab` | Move forward or backward through the visible top-level Palette sections. |
| Typing | Edit the focused text field or the view's visible search field. |

Resolve selection, paging, confirmation, and cancellation through `KeybindingsManager` semantic actions. Pi defines no select-scope action for `Home`, `End`, `Tab`, `Space`, `←`, or `→`; match those keys directly and keep the meanings in this table.

`tui.select.cancel` resolves to both `Escape` and `Ctrl+C` by default, so both cancel one level. Hints show the effective list, such as `Esc/Ctrl+C`; user bindings replace that list.

### Key precedence

`←`, `→`, `Home`, `End`, letters, digits, punctuation, and `Space` are claimed in this order:

1. **A focused text field takes them.** A search field in search mode and a text field in edit mode keep `←`, `→`, `Home`, `End`, and every printable character, including IME composition input.
2. **A focused non-text control takes `←` and `→`** to change a visible discrete choice.
3. **The selected row takes `←` and `→`** to collapse and expand disclosure, when neither of the above applies.

A mode with a live text field has no bare-letter and no bare-`Space` shortcuts. A mode without one may use them, because the two are never eligible at the same time. This keeps search usable and keeps IME composition out of the shortcut layer. A view with type-to-search, where typing focuses the search field, has no usable bare-letter layer even in browse: every printable character edits the field, so browse actions there use non-printable unmodified keys only.

### Primary and secondary actions

`Enter` always invokes the action named first in the current hint. Examples include selecting a model, editing a catalog, saving a form, and confirming removal.

Modified-key shortcuts are secondary actions for operations such as add, refresh, remove, favorite, or project-default selection. They must not be the only way to perform any action; see the reachability rule in [`ux.md`](ux.md#key-assignment-rules). Check a proposed shortcut against Pi's `TUI_KEYBINDINGS`, Jouzu's `JOUZU_KEYBINDING_DEFAULTS`, and the platform collision tables before claiming it. Recorded exception: Models favorite (`jouzu.model.toggleFavorite`, `Ctrl+Shift+S`) is accelerator-only while the planned Models row-actions list, reserved in [`key-collisions.md`](key-collisions.md#reserved-ranges-for-future-defaults), is its future unmodified route.

When an item supports disclosure as well as a primary action, reserve `Enter` for the primary action and use `←` and `→` to collapse and expand it.

### Navigation between views

- The Palette holds one view at a time and switches in place. Opening the Palette again routes the existing instance and focuses it; it does not create a second panel.
- The top-level tab row shows every registered section. `Tab` and `Shift+Tab` move through that row in browse mode.
- A section switch while an edit is dirty must confirm or refuse. Discarding unsaved form input without asking is a defect.
- Nested filters and choices are not tab rows. Change a visible choice with `←` and `→` when no text field holds focus.
- `Esc` in browse mode closes the Palette. There is no separate root level to return to first.
- Cancel restores the editor text that was present when the Palette opened.
- `/catalogs` and `/model` route directly to a view. A route is registered only when its view exists.

## Browse mode

- Select the first actionable item when the view opens unless retained state identifies another valid item.
- Preserve selection when data refreshes and the same item still exists.
- Keep a visible non-color marker on the selected row. Background color may reinforce selection but cannot be the only indicator.
- A searchable view starts in browse mode. Typing or `/` focuses search; `Esc` returns to browse mode before another `Esc` closes the Palette.
- While search holds focus, `←`, `→`, `Home`, `End`, and printable input go to the search field. `↑` and `↓` continue to move results.
- While search holds focus, the title names the search state and committal row actions keep working through their semantic accelerators. `Esc` returns to browse with the query intact, so a browse-only key is one keystroke away and is hinted as such.
- Report the result count against the total when a search or filter is narrowing the collection.
- A search with no results says so and keeps the search text editable. It does not close, clear the query, or fall back to an unfiltered list.
- Render an item that cannot be acted on as unavailable, with the reason, rather than hiding it or failing on `Enter`.
- If an empty view has one safe setup action, open that action directly. `Esc` then closes the Palette without writing; the auto-opened form is not a nested level.
- Name the selected item's primary action in the first hint line.

## Edit mode

- Put the mode and object in the heading, such as `Add catalog` or `Edit Office pool`.
- Use `↑` and `↓` to move between fields.
- Send ordinary text-editing keys to the focused text field.
- Render discrete choices as choices, for example `Authentication  < None >`, and change them with `←` and `→`.
- Render dependent fields directly beneath the choice that reveals them.
- Explain why a dependent field is needed and whether Jouzu can use its value. Never render credential values.
- Use `Enter` to validate and save the complete form. Keep field values and focus when validation or saving fails.
- Use `Esc` to discard the in-memory edit and return to browse mode, or to close the Palette when the form was opened directly into an empty view. Canceling must not write state.
- Disable conflicting actions while a save is in progress. If the operation supports cancellation, `Esc` cancels it and returns to the form.

## Confirm mode

- Ask for confirmation only for destructive or difficult-to-reverse actions.
- Name the object and action in the prompt.
- Use `Enter` to confirm and `Esc` to return without writing.
- Do not overload unrelated keys while confirmation is active.

## Authentication fields

Authentication is a visible discrete choice, not a hidden mode toggle.

- Label the choice `Authentication` in full.
- Use user-facing values such as `None` and `Bearer token`.
- Show the token-variable field only when `Bearer token` is selected.
- State that the field accepts an environment variable name rather than a token value.
- Report whether the named variable is available to Jouzu without displaying its value.
- Identify HTTP 401 as an authentication failure and HTTP 403 as denied access.

## Hints and explanatory text

Hints describe available actions, not implementation details.

- Put the primary action first, followed by movement and cancellation.
- Show only keys that work in the active mode and state. While a text field holds focus, omit printable-character bindings from hints; those keys type.
- Resolve key labels through `KeybindingsManager` where the action has a semantic ID, so a rebound key is named correctly.
- Keep required controls visible without relying on a README.
- Prefer two short hint rows over one clipped row.
- Remove or compact lower-priority hints before truncating the primary action.
- Do not explain automatic endpoint probing, cache paths, request sequencing, or other internal behavior in a form. Perform automatic work without making the user manage it.

## Messages and progress

[`ux.md`](ux.md#messages) defines the message rules for every surface. In the Palette:

- Name the operation while it runs: `Testing catalog…`, `Saving catalog…`, or `Refreshing Office pool…`.
- Keep a successful message on screen until the next input or the next state change, whichever comes first. Do not replace the view's stable state with a success-only screen.
- Clear a stale message when the user moves selection or edits text.

## Layout and terminal behavior

- Measure terminal display columns rather than JavaScript string length.
- Keep every rendered line within the supplied width, including ANSI styling and CJK or emoji text.
- Render every required label in full at 48 columns, the Palette's minimum floating width. Reduce value width or change layout instead of clipping labels.
- Below 12 columns a view may render its title alone.
- Bound long collections to the available terminal rows and keep the selected item visible.
- Do not use color, cursor shape, or position as the only indication of selection, state, or failure.
- Preserve the same interaction, actions, and cancel result in floating and replacement presentations. The Palette selects replacement below 58 columns or 16 rows and in terminals that render inline images. Under tmux and GNU Screen, Jouzu suppresses inline-image detection and still chooses from terminal dimensions.

## Anti-patterns

Do not ship a Palette view with any of these behaviors:

- `Tab` is the only way to reach a form field.
- A view with no visible top-level tab row advertises `Tab` navigation.
- A nested filter uses `Tab` instead of the top-level section row.
- `Enter` expands an item when the expected primary action is edit or select.
- An action is reachable only through a modified key, such as `Ctrl+Enter` to save.
- A bare letter or `Space` is a shortcut in a mode whose text field is live.
- A committal row action works in browse but has no route while search holds focus.
- A hint names a printable-character shortcut while a text field holds focus.
- `Space` cycles an enum without showing that the row is a choice.
- `←` or `→` moves a list or toggles disclosure while a text field holds focus.
- A conditional field appears without a visible parent choice or explanation.
- A required label is clipped by a fixed-width column.
- A long error is forced into one row and loses the status or recovery action.
- Help text describes internal URL probing or another automatic implementation detail.
- The hint names keys that are inactive in the current mode, or names a default key the user has rebound.
- A raw key check bypasses a semantic keybinding action that already exists, or shadows a key Pi has already defined.
- Canceling an edit writes partial state.
- Switching views discards an unsaved edit without confirmation.
- A credential value appears in configuration, cache, logs, errors, tests, or rendered output.

## Required tests

An interaction change must include tests for the affected modes and transitions:

1. `↑` and `↓` move selection or form focus.
2. `Enter` performs the mode's primary action.
3. `Esc` cancels one level and does not write canceled edits.
4. Discrete choices respond to `←` and `→`; conditional fields appear and disappear with the choice.
5. `←` and `→` reach the text cursor, not the list, while a text field holds focus.
6. Empty-state setup, empty search results, busy state, success, and representative failures render the intended controls.
7. Credential tests prove that availability can be shown without rendering the value.
8. Render tests cover 48 columns and mixed-width text; every line stays within the requested terminal columns.
9. `Tab` and `Shift+Tab` move top-level sections in browse mode and cannot discard an edit.
10. Hints contain the active primary action, omit inactive or internal controls, show user-rebound semantic bindings, and omit printable bindings while a text field is live.
11. Committal row actions fire through their semantic accelerators while search holds focus, and the title names the search state.

Run the focused interaction tests while iterating, then run `npm run check` and `npm test` before committing.
