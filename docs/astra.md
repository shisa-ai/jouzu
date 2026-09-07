# GPT-6 Astra

Jouzu adds model-specific working guidance when the selected model ID is
`gpt-6-astra` and the session uses the default system prompt. The guidance asks
Astra to finish authorized work, carry steering across turns, keep responses
concise, and stop expanding verification after required checks pass. Delegation
instructions appear when the session exposes the `subagent` tool. Custom system
prompts remain user-owned.

For configured `openai/gpt-6-astra` entries using `openai-responses` at
`https://api.openai.com/v1`, Jouzu exposes `low`, `medium`, `high`, `xhigh`, and
`max`. Selecting or restoring `off` or `minimal` resolves to `low`. Account model
limits, prices, credentials, and discovery remain provider-owned; this does not
add account access or a catalog entry.

The official API adapter removes unsupported sampling and logprob fields after
Pi's request transforms and uses `prompt_cache_options.ttl: "30m"` for automatic
caching. Explicit cache disable is preserved. It covers main-session requests
and auxiliary requests dispatched through the registered provider. Compatibility
rules apply only to that exact provider, API, model ID, and endpoint.

## Verification

Run after building:

```sh
node --test packages/cli/test/astra-compatibility.test.mjs packages/cli/test/model-guidance.test.mjs packages/cli/test/presentation.test.mjs
```

These fixtures also run through `npm test` and Pi upgrade qualification. They
inspect serialized requests, prompt delivery, model switching, and session
restoration. Mock request checks establish payload behavior; they do not establish
live provider availability or improved model behavior.

Track live route qualification and removal of temporary compatibility rules in
[issue #27](https://github.com/shisa-ai/jouzu/issues/27). Before removing a rule,
run the same request and restoration fixtures against the candidate Pi version
without the adapter and record bounded text, tool-call, and continuation results.
The behavioral prompt requires live comparison on representative tasks.

References: [Astra model reference](https://developers.openai.com/api/docs/models/gpt-6-astra)
and [OpenAI model and prompting guidance](https://developers.openai.com/api/docs/guides/latest-model).
