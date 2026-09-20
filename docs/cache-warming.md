# Prompt-cache warming

Cache warming replays a prompt with a minimal output budget to refresh a provider's cached prompt before it expires. These requests can incur token charges. They do not add assistant turns or tool calls to the conversation.

Choose **Cache warming** in `/settings`:

| Mode | Behavior |
| --- | --- |
| `streaming` (default) | Refresh while an agent run is active, including during tool execution. Stop when the run settles. |
| `idle` | Also allow refreshes after the run settles. |
| `off` | Do not send refreshes. |

The global settings key is `cacheWarming`. Project settings do not override it. `/session` shows the warming status and the reason when warming is inactive.

## Eligibility and limits

Automatic warming requires a known prompt-cache lifetime, a safely replayable request, and estimated savings that meet the runtime's threshold. A provider supporting streaming does not establish that these conditions hold. Models with zero configured prices do not warm automatically; extensions can override the economic decision.

The runtime requests one output token and disables provider retries. Provider adapters can raise that limit: the OpenAI Responses adapter uses a minimum of 16 output tokens. The main session's refresh check accepts only a one-token provider payload, so it refuses that Responses replay without sending it. Child workers use the adapter's limit.

The main session checks that the replay matches the admitted request before sending it. Changed or unsupported payloads are refused without failing the conversational turn. Refresh failures are best-effort and can be tried again at a later scheduled interval.

Each captured request has a one-hour warming limit while running. In `idle` mode, the limit is 30 minutes from that request's capture, not 30 minutes after the run settles. A new request starts its own interval. Context changes and session disposal cancel the previous refresh schedule.

Successful refresh usage is recorded separately from assistant messages. A response arriving after its warming run was cancelled does not add usage. Local usage records therefore do not establish that a provider charged nothing for a cancelled request.

## Subagents

New child launches and resumes copy the global warming mode. Running children retain the mode copied at launch; changing the parent setting does not update them. Child warming uses the child's model and conversation. Reported child usage includes successful warming requests, but their responses do not become child assistant turns or enter later model context.

A child process exits when its work completes, so `idle` does not keep a completed child running to warm its cache. See [Agents and runs](subagents.md) for child execution and usage reporting.
