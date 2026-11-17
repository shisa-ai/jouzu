# Side conversations

Run `/btw <question>` to ask about the current work while the main agent continues.
Bare `/btw` reopens the side conversation. It has its own question field and saved
history; questions and answers do not enter the main conversation automatically.

Choose **Ask a question**, type your question, and submit it with the displayed key.
Use the displayed cancel key to return to the action list. Page Up/Page Down scroll
the side transcript. Closing the panel keeps its request running. **Cancel side
request** stops only that request; it does not interrupt the main agent.

## Context and tools

Each question uses a text snapshot from the main agent's latest admitted provider
request: the request after conversation transforms and content checks. The panel
shows its capture time and transcript boundary. It excludes the reply being
generated, images, thinking blocks, tool declarations, and tool-call arguments.
New replies and tool results become available after the next main request includes
them. The snapshot is limited to 64,000 characters and 8,000 per message; a `…`
marker beside the snapshot boundary means content was truncated.

Side conversations have no callable tools and load no project instructions,
skills, or extension code. They can explain supplied evidence but cannot inspect
another file, search, run commands, change code, delegate work, or control tasks.
Historical requests in the snapshot are reference material, not work for the side
assistant to execute.

Flow control must be on, and the main agent must have sent a request in this
process. Jouzu refuses side context when it cannot verify a filtered snapshot.
For example, a provider-payload replacement makes that request unavailable for
side sharing. Jouzu does not fall back to raw session history.

The first question inherits the main model, provider destination, thinking setting,
and response-language preference. A changed model, destination, or parent branch
requires **Start a new side conversation**. Up to 20 questions share one saved
child conversation; each question is a separate execution. Side requests share the
configured child concurrency limit and provider capacity. Retryable provider
errors have at most two retries, within a three-minute execution limit.

## Bring information back

- **Bring latest exchange to main editor** appends the latest completed question
  and answer to your existing draft without submitting it. Review or edit it
  before sending.
- **Send an instruction with this exchange as steering** opens an instruction
  field. Submit your instruction with the quoted side exchange as evidence.
- **Send an instruction with this exchange as a follow-up** uses the same field
  but queues the input after ongoing work.

Steering and follow-up use Jouzu's authenticated human-input path. Delivery notices
separate retained, held, queued, and consumed input. Queued does not mean the model
has consumed it, and consumed does not mean it followed the instruction. The
submission stays bound to the main branch selected when the instruction field
opened; navigation does not silently retarget it.

## History and usage

Side records and child transcripts are saved locally under Jouzu's state directory,
separately from main history and compaction. Reopening the main session restores
its latest side thread. **Start a new side conversation** resets the active thread
without deleting saved records. It is unavailable while that thread has an active
request. Exiting Jouzu stops its running side requests; saved history remains.

The panel shows per-execution tokens and known cost, with the same unknown-cost
and estimate qualifiers as child runs. These requests consume provider capacity
and can incur charges. Main-session usage totals exclude separate child sessions,
including side conversations; do not add a side execution twice when calculating
a combined total. The Workflow subagent switch controls delegated workers, not
user-owned side questions.

`/btw` is an interactive-terminal command. Print and RPC modes report this
requirement without launching a child.
