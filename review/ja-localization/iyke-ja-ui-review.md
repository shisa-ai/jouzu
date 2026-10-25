# Jouzu JA — UI/UX notes (2026-10-24)

Manually checked the Japanese review build in Ghostty on macOS. These are the issues I noticed while using it.

1. **`unbound` appears in the footer.** It shows `unbound モデル · unbound お気に入り` even though a Shisa model is shown on the right. It's unclear to a Japanese user whether this means a missing shortcut or a model-setting problem.

2. **Workflow / subagent screen contains English.** The agent rows show `Same as this session`, and the bottom key hint includes `Esc/Ctrl+C close`. The rest of the screen is mostly Japanese, so the mixed languages stand out.

3. **Settings is only partly localized.** Some fields are in Japanese, but navigation labels such as `Models`, `Workflow`, `Settings`, and `Catalogs`, and values like `active`, remain in English. This makes the Japanese interface feel inconsistent.

4. **Visible thinking text was in English.** I asked a question in Japanese and received a Japanese answer, but the visible reasoning above it was in English. This may be model behavior rather than a UI-translation issue, but it's noticeable in a Japanese-language session.

5. **The Japanese full-width slash doesn't start commands.** Typing `／help` with Japanese IME wasn't recognized as a slash command; `/help` with an ASCII slash worked. Switching input just to enter a command is inconvenient.

6. **Japanese punctuation can wrap onto its own line.** In a Japanese response, `。` appeared alone at the beginning of the next line. Punctuation should stay with the preceding text when wrapping.

Screenshots were captured during the manual Ghostty review and can be provided separately. This is a list of observations, not a full Japanese localization sign-off.
