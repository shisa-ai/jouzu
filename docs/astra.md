# GPT-6 Astra

Jouzu adds the same working guidance for `gpt-6-astra`, `gpt-6.1-sol`, and
`gpt-6.1-terra` when the session uses the default system prompt. It asks the
model to finish authorized work, carry steering across turns, keep responses
concise, and stop expanding verification after required checks pass. Delegation
instructions appear when the session exposes the `subagent` tool. Custom system
prompts remain user-owned.

For configured `openai/gpt-6-astra` entries using `openai-responses` at
`https://api.openai.com/v1`, Jouzu exposes `low`, `medium`, `high`, `xhigh`, and
`max`. Selecting or restoring `off` or `minimal` resolves to `low`. Account model
limits, prices, credentials, and discovery remain provider-owned; this does not
add account access or a catalog entry.

The official API adapter removes unsupported sampling and logprob fields after
Pi's request transforms. API-key requests use `prompt_cache_options.ttl: "30m"`
for automatic caching; explicit cache disable is preserved. ChatGPT sign-in
requests omit `prompt_cache_options` and `max_output_tokens`, including values
added by request transforms.

The adapter covers main-session requests and auxiliary requests that use the
adapted model. Compatibility rules apply only to that exact provider, API, model
ID, and endpoint.

## Task completion guidance

For implementation and repair assignments, the guidance asks the agent
to diagnose failed checks, make authorized in-scope repairs, rerun affected checks,
and continue toward every requested deliverable. Review-only and diagnosis-only
requests keep their stated boundaries. The instructions prohibit weakening checks
or silently reducing scope to obtain a passing result.

For assignments with three or more independently verifiable deliverables, the
the guidance asks the agent to create an overall completion checklist covering each
requested deliverable and verification row before implementation. In Jouzu
sessions with task tools, the agent uses those tools selectively for bounded,
coherent work packages. Cascade task progress is an execution queue: an
`in_progress` task is prompted before pending tasks, so holds and dependencies
use the corresponding task controls rather than an informal status or a `Next`
list. Task status does not replace implementation and verification evidence.

Follow-up corrections call for a concrete action or dependency wait in the same
turn, rather than another promise to continue. Running jobs and unfinished
requirements stay active across follow-up messages. Before a final report, the
agent is instructed to compare the requested deliverables with completed work and
verification. Explicit pauses and cancellations are respected; missing user input
or external resources must be named. Waiting for an asynchronous job does not
count as task completion.

These are behavioral instructions, not a runtime guarantee. Prompt-delivery tests
verify that the text reaches main and child sessions. They do not measure whether
a model follows it on a coding task.

## Verification

Run after building:

```sh
npm run test:node -- packages/cli/test/astra-compatibility.test.mjs packages/cli/test/model-guidance.test.mjs packages/cli/test/presentation.test.mjs
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
