# Side conversations

Run `/btw <question>` to ask about the current work while the main agent continues.
Bare `/btw` reopens the side conversation. It has its own question field and saved
history; questions and answers do not enter the main conversation automatically.

Choose **Ask a question**, type your question, and submit it with the displayed key.
Use the displayed cancel key to discard the question or instruction draft and
return to the action list. Each edit starts empty. Cancelling instruction
preparation returns to the actions without opening the instruction field later.
Page Up/Page Down scroll the side transcript. Closing the panel keeps its request
running. **Cancel side request** stops only that request; it does not interrupt the
main agent. Opening the panel does not hold the main agent's next automatic turn.

## Context and tools

Each question uses the saved main conversation on the active branch, including
compaction summaries, after the session's content checks. This works immediately
in a new or resumed session, without sending a main-agent request first. The panel
shows the snapshot's capture time and transcript boundary. It excludes unfinished
replies, images, thinking blocks, tool declarations, and tool-call arguments.
The snapshot is limited to 64,000 characters and 8,000 per message; a `…`
marker beside the snapshot boundary means content was truncated.

Side conversations have no callable tools and load no project instructions,
skills, or extension code. They can explain supplied evidence but cannot inspect
another file, search, run commands, change code, delegate work, or control tasks.
Historical requests in the snapshot are reference material, not work for the side
assistant to execute.

Jouzu checks a copy of saved history without starting a main turn or consuming
queued inputs. If those checks fail, the side request is withheld. Side questions
do not require Flow to be enabled; steering and follow-up handoffs use Flow's
human-input delivery path.

The first question inherits the main model, provider destination, thinking setting,
and response-language preference. A changed model, destination, or parent branch
requires **Start a new side conversation**. Up to 20 questions share one saved
child conversation; each question is a separate execution. Side requests share the
configured child concurrency limit and provider capacity. Retryable provider
errors have at most two retries, within a three-minute execution limit.

## Bring information back

- **Bring latest exchange to main editor** captures the latest completed question
  and answer, closes the panel, then appends the exchange to your existing draft
  without submitting it. This also preserves the insertion when a narrow terminal
  uses the replacement panel. Review or edit it before sending.
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
