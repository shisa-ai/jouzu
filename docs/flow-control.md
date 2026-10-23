# Flow control

Flow control coordinates background jobs, goals, loops, and tasks in one session. It is on by default.

- Background results arrive in batches after the current reply and any queued messages.
- Tasks can wait for your input or for another job before continuing.
- Ask Jouzu to show, reorder, pause, or continue tasks.

Jouzu keeps **receipts**, records used to track delivery of inputs and results.
It also reserves one reply at a time so automatic work does not start overlapping
turns. A stuck reservation can prevent the next reply from starting.

## Commands

| Command | Effect |
| --- | --- |
| `/flow` | Show why automatic work stopped and how to resume it |
| `/flow pause` | Pause automatic replies. Background jobs keep running. |
| `/flow resume` | Allow automatic replies again |
| `/flow off` | Turn flow control off for this session. Messages run as ordinary turns; jobs, tasks, and loops send their own notifications. |
| `/flow on` | Turn flow control back on |
| `/flow reset` | Explain the destructive reset without changing anything. |
| `/flow reset confirm` | Destructive reset, available only while idle. Discards all queued messages, receipts, and waits, and releases holds on model requests. Running jobs keep running. Use it only if `/flow clear` does not fix the problem. |
| `/flow clear` | Release a stuck reservation while preserving receipts, waits, and running jobs. Run while Jouzu is idle. |
| `/flow retry <request>` | Allow one withheld request to go through the pre-send checks again; use its request ID from `/flow` |
| `/flow cancel <token>` | Cancel an entire wait, even if it covers multiple dependencies. Underlying jobs keep running and its work stays open. Use the wait token from `/flow`. |
| `/flow resolve <attempt> retry` or `discard` | Settle a model request with an unknown outcome, using the attempt ID shown by `/flow` |
| `/flow runtime` | Show startup package paths and hashes |

- Interrupting a reply also pauses automatic work until your next message or `/flow resume`.
- A reply that still ends with a provider error or is truncated after retries and context recovery pauses automatic work. The pause explains the failure; your next message or `/flow resume` releases it.
- Local commands stay available while flow control holds model input: during recovery, and while a model request is still in flight. Running one, such as `/flow` or `/about`, does not resume automatic replies by itself; use `/flow resume`, `/flow clear`, `/flow reset confirm`, or send a message. If the session is replaced or its branch changes while a command is still waiting on recovery state, the command does not start.
- A command runs locally only when the message is its name followed by a space or the end of the message; everything after the first space is the command's argument. Other text, such as `/flow` followed by a tab, `/flows`, a leading space, an unknown name, or a prompt sent with template expansion off, is a message: flow control holds or delivers it like any other input.
- `/flow clear` repairs a reservation without discarding flow evidence. If that does not fix the problem, `/flow reset confirm` is the destructive fallback: it discards all queued messages and flow delivery state, cancels waits, and leaves underlying jobs running.
- `/flow resolve <attempt> retry` may repeat a request the model already answered. It resolves an unknown attempt outcome; `/flow retry <request>` instead authorizes a withheld request.
- Set `JOUZU_FLOW_CONTROL=0` before starting Jouzu to disable flow control for that process.

## Waiting for jobs

When the assistant uses `agent_wait` and the call returns `waiting`, Jouzu waits
for completion, failure, or the deadline before scheduling a response. If a reply
is in progress, it finishes first. Queued user messages also run first and can
include the wait outcome in the model's context. Once the outcome has been
delivered, it does not trigger another response.

An explicit pause or an unresolved execution outcome still blocks automatic replies. The wait outcome stays pending; use `/flow` to inspect the blocker.

Inputs that can no longer be delivered remain visible as undelivered input.
They are not queued and do not block automatic replies. Submit one again only
if it is still needed.

If sending an input was interrupted and its outcome is unknown, inspect the
session and job state before using `/flow clear`. Clearing releases that hold
without sending the interrupted input again.

## Request history capacity

Request history records delivery and recovery separately from the model's token
context. Jouzu archives settled requests when no live input, result, wait, or retry
depends on them, using both a record count and a byte budget.

If request history fills up, Jouzu holds new requests. `/flow` remains available
for inspection, and `/flow clear` can release a stuck request while preserving
receipts, waits, and running jobs. Continue with a new message after clearing it.

## Branches and resuming

| Action | Result |
| --- | --- |
| Return to where you left a recent branch | Its unfinished work resumes, including tasks waiting for background jobs |
| Rewind to an earlier point | Starts a new branch; unfinished work does not resume. File changes are not undone. |
| Reopen a session | Continues from its last saved position, which may differ from the branch you last viewed |

Extension commands can await `ctx.navigateTree()` with flow control on or off. Navigation requires an idle session with no queued input or other active host operations. A busy refusal leaves the current branch usable. Wait for navigation to finish before starting another host operation, including while the old branch attachment closes and the new one opens.

A command continues to own host work on the selected branch until its callback ends; independent navigation remains busy during that continuation. Retained input captured before navigation stays bound to its original branch. A callback that outlives the command cannot use the command's old attachment after navigation.

## Missing tool results

- If a branch lacks a tool result, Jouzu tells the model the outcome is unknown. It does not rerun the tool, copy a result from another branch, or edit the saved conversation.
- If Jouzu cannot match tool calls to their results, it stops the request.
