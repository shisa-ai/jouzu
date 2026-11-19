# Shisa AI account

A [Shisa AI](https://platform.shisa.ai/) account provides open coding models, the Shisa model catalog, and [voice input](voice.md). Each service needs access on your account.

- On first interactive launch without a Shisa credential, Jouzu offers to connect once. The prompt says `Connect to Shisa AI to access hosted models and voice input.` and links to [offers and eligibility](https://platform.shisa.ai/jouzu). Answer `y` to sign in; press `Enter` or `n` to skip.
- Offers depend on account eligibility and are not an account balance. Check the linked page for current terms, eligibility, and any expiry.

The prompt makes no network request before you choose to connect. Noninteractive commands, offline diagnostics, child agents, and Settings do not show the prompt.

## Sign in

1. Run `/login shisa`, or press `Enter` on the **Shisa AI** row in Settings.
2. Open the verification URL Jouzu shows and approve in your browser.

Jouzu saves a dedicated API key and device link with private file permissions. It then refreshes catalogs and models without a restart.

## Settings row

The **Shisa AI** row sits at the top of Settings / Catalogs.

| State | Row shows |
| --- | --- |
| Signed out | `Not connected` and a link to offers and eligibility |
| Signed in | Organization and dashboard address |
| Using `SHISA_API_KEY` | `Connected · SHISA_API_KEY` |

| Key | Action |
| --- | --- |
| `Enter` | Start sign-in |
| `Esc` | Cancel sign-in without closing Settings |
| `D` | Sign out, after confirmation |

## Credentials

| Service | Credential order |
| --- | --- |
| Inference and voice | `SHISA_API_KEY`, then the saved login |
| Model catalog | `SHISA_API_KEY`, then a saved catalog token, then the saved login |

## Sign out

Run `/logout shisa`, select Shisa in `/logout`, or press `D` on the Settings row.

- Jouzu asks Shisa to revoke the key, then removes the local key and device link.
- Voice recording stops and Shisa catalog models leave the Models view.
- Other providers keep their credentials.
- For the rest of the process, Shisa login, catalog, and voice ignore `SHISA_API_KEY`, even if it remains set. Unset it before restarting to stay signed out, or run `/login shisa` to reconnect.

## Inference errors

For recognized Shisa HTTP errors on the catalog's OpenAI-compatible inference route, Jouzu shows the server's message followed by its code, such as `(free_allowance_exhausted)`. Authentication, balance, plan-access and free-allowance failures stop agent-level retries. Follow the message's account action or wait for allowance replenishment as appropriate.

Rate, ingress, capacity and temporary authentication-verification failures remain eligible for the configured agent retry budget. Existing billing and quota exclusions still take precedence. Separately configured transport retries are unchanged: a funding HTTP 429 can still be retried inside a request. The conditional `/bug` hint may appear for account errors; it is not a diagnosis that Jouzu caused the failure.

Recognized messages have control characters removed, whitespace collapsed and one code suffix. The complete formatted error is limited to 1,800 UTF-16 code units; unusually long text or URLs can be truncated. Other payload shapes and adapters that use separate error formatting retain their existing behavior.

## Troubleshooting

| Message or symptom | Action |
| --- | --- |
| Revocation not confirmed | You are signed out locally. Disconnect the device in the Shisa dashboard. |
| Saved link has no issuing gateway | Disconnect the device in the Shisa dashboard. |
| Key saved but delivery to Shisa not confirmed | Sign in again. |
| Server confirmation failed after saving credentials | Follow the recovery instructions shown in the panel. |
