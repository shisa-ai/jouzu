# Palette interaction standards

This guide defines keyboard interaction, focus, feedback, and layout for Jouzu-owned Palette views. Contributors must apply it when adding or changing an interactive terminal view. The implementation and tests remain the runtime authority.

## Interaction model

A Palette view has one visible mode at a time:

- **Browse:** move through a collection and run an action on the selected item.
- **Edit:** change a form and either save or cancel it.
- **Confirm:** approve or cancel one destructive action.
- **Busy:** wait for or cancel an operation that is already identified on screen.

The title, selection marker, fields, and key hints must make the active mode apparent. Do not require the user to infer a mode from a key that stopped working.

### Common keys

Use the same key for the same class of action across Palette views:

| Key | Meaning |
| --- | --- |
| `↑` / `↓` | Move by one item or one form field. |
| `Page Up` / `Page Down` | Move by one visible page in a long collection. |
| `Home` / `End` | Move to the first or last item in a long collection. |
| `←` / `→` | Move the cursor in text, change a visible discrete choice, or collapse and expand a selected item. |
| `Enter` | Run the selected item’s primary action, save an edit, or accept a confirmation. |
| `Esc` | Cancel the active edit or confirmation. At the root browse mode, close the Palette. |
| `Space` | Toggle a focused boolean value. |
| `Tab` / `Shift+Tab` | Move between visible peer groups presented as tabs. |
| Typing | Edit the focused text field or the view’s visible search field. |

Use `KeybindingsManager` semantic actions for selection, paging, confirmation, and cancellation. Use direct key matching only when Pi exposes no semantic action for the required interaction.

`Tab` is not a substitute for `↑` and `↓`. A form must remain usable without Tab. A view without visible tabs must not advertise Tab navigation.

### Primary and secondary actions

`Enter` always invokes the action named first in the current hint. Examples include selecting a model, editing a catalog, saving a form, and confirming removal.

Letter and modified-key shortcuts are secondary actions. Use them for operations such as add, refresh, remove, favorite, or project-default selection. They must not be the only way to perform the view’s primary action.

When an item supports disclosure as well as a primary action, reserve `Enter` for the primary action and use `←` and `→` to collapse and expand it.

## Browse mode

- Select the first actionable item when the view opens unless retained state identifies another valid item.
- Preserve selection when data refreshes and the same item still exists.
- Keep a visible non-color marker on the selected row. Background color may reinforce selection but cannot be the only indicator.
- Keep search input active in searchable views while `↑` and `↓` move results. `←` and `→` must continue to move the text cursor.
- If an empty view has one safe setup action, open that action directly. `Esc` must still leave without writing.
- Name the selected item’s primary action in the first hint line.

## Edit mode

- Put the mode and object in the heading, such as `Add catalog` or `Edit Office pool`.
- Use `↑` and `↓` to move between fields.
- Send ordinary text-editing keys to the focused text field.
- Render discrete choices as choices, for example `Authentication  < None >`, and change them with `←` and `→`.
- Render dependent fields directly beneath the choice that reveals them.
- Explain why a dependent field is needed and whether Jouzu can use its value. Never render credential values.
- Use `Enter` to validate and save the complete form. Keep field values and focus when validation or saving fails.
- Use `Esc` to discard the in-memory edit and return to browse mode. Canceling must not write state.
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
- Show only keys that work in the active mode.
- Keep required controls visible without relying on a README.
- Prefer two short hint rows over one clipped row.
- Remove or compact lower-priority hints before truncating the primary action.
- Do not explain automatic endpoint probing, cache paths, request sequencing, or other internal behavior in a form. Perform automatic work without making the user manage it.

## Messages and progress

- Name the operation while it runs: `Testing catalog…`, `Saving catalog…`, or `Refreshing Office pool…`.
- State the failure class before details: authentication, denied access, validation, network, or storage.
- Give an action when the user can recover.
- Wrap messages within the frame. Do not truncate the status, field name, or recovery action into one line.
- Sanitize external text before styling it.
- Never render bearer tokens, authorization headers, credential values, or secret-bearing URLs.
- Keep a successful message long enough to identify what changed; do not replace the screen’s stable state with a success-only screen.

## Layout and terminal behavior

- Measure terminal display columns rather than JavaScript string length.
- Keep every rendered line within the supplied width, including ANSI styling and CJK or emoji text.
- Render labels in full at the supported minimum width. Reduce value width or change layout instead of clipping labels.
- Bound long collections to the available terminal rows and keep the selected item visible.
- Do not use color, cursor shape, or position as the only indication of selection, state, or failure.
- Preserve the same interaction in floating and replacement presentations.

## Anti-patterns

Do not ship a Palette view with any of these behaviors:

- `Tab` is the only way to reach a form field.
- `Enter` expands an item when the expected primary action is edit or select.
- Saving requires an undisclosed modified key such as `Ctrl+Enter`.
- `Space` cycles an enum without showing that the row is a choice.
- A conditional field appears without a visible parent choice or explanation.
- A required label is clipped by a fixed-width column.
- A long error is forced into one row and loses the status or recovery action.
- Help text describes internal URL probing or another automatic implementation detail.
- The hint names keys that are inactive in the current mode.
- A raw key check bypasses a semantic keybinding action that already exists.
- Canceling an edit writes partial state.
- A credential value appears in configuration, cache, logs, errors, tests, or rendered output.

## Required tests

An interaction change must include tests for the affected modes and transitions:

1. `↑` and `↓` move selection or form focus.
2. `Enter` performs the mode’s primary action.
3. `Esc` cancels one level and does not write canceled edits.
4. Discrete choices respond to `←` and `→`; conditional fields appear and disappear with the choice.
5. Empty-state setup, busy state, success, and representative failures render the intended controls.
6. Credential tests prove that availability can be shown without rendering the value.
7. Render tests cover a narrow supported width and mixed-width text; every line stays within the requested terminal columns.
8. Hints contain the active primary action and omit inactive or internal controls.

Run the focused interaction tests while iterating, then run `npm run check` and `npm test` before committing.
