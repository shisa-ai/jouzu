# Session and pane labels

Automatic naming is on by default in interactive sessions. Jouzu uses the selected
provider/model for the first naming request and keeps that exact route when you
switch the main conversation model. `/labels on` enables naming with the selected
model; `/labels off` disables it. The choice is saved with the session, and a saved
off choice stays off when you reopen it.

Run `/labels` for a read-only status report and the complete command list. It shows
the naming model, session and pane protection, request count, and any pending
ambiguity revisit.

The naming request proposes a session name of at most 60 characters and a pane
label of at most 12 lowercase ASCII letters, digits, or hyphens. Session names
appear in `/resume`. Session IDs, filenames, workflow lanes, and tmux window names
do not change.

## Commands

| Command | Effect |
| --- | --- |
| `/labels` | Show status and all commands without changing settings or starting a request. |
| `/labels on` | Enable naming with the selected provider/model. |
| `/labels off` | Cancel pending naming and stop model requests. Keep existing labels. |
| `/labels pin` | Protect the session name, including when its text has not changed. |
| `/labels auto` | Allow automatic replacement of the session name. |
| `/labels pane pin` | Protect the pane title and release Jouzu's claim without restoring a prior title. |
| `/labels pane auto` | Explicitly allow replacing this pane's title. Refuse a claim held by another attachment. |

Using `/name` also pins the session name. A pre-existing session name without
Jouzu ownership metadata is protected. Session and pane ownership are independent.

## When naming runs

Jouzu collects admitted interactive queries and confirmed `/goal` or multiloop
objectives, then waits for the first completed assistant run before requesting
labels. It does not request names at launch without completed task context, during
tool iterations, or because of background notifications and automatic
continuations. An interrupted or failed first run does not trigger naming.
Commands expanded into different text may not trigger ordinary task naming; the
explicit goal and multiloop notifications do not depend on text matching.

The request includes the working folder name, Git repository name when available,
and bounded current and previous queries. A local, one-second-bounded
`git rev-parse --show-toplevel` lookup supplies only the repository's name, not its
absolute path or file contents. The naming model has no tools or attachments;
it does not receive full conversation history. Each query excerpt is limited to
1,800 UTF-8 bytes. Absolute path tokens and common credential prefixes are
redacted; this is not a general secret detector. Do not include secrets in task
text.

For an ambiguous task, the model can defer naming until 1–3 more task turns have
completed. Jouzu saves that threshold and revisits with the newer query and prior
context. There is no timer-driven retry; automatic turns do not advance it. A
confirmed new workflow can prompt reconsideration after its first completed run.

On resume, valid saved labels are reused and user-owned names remain protected.
A missing label is reconsidered from the saved task excerpt, or the initial user
query on the active branch when that history contains a completed assistant
response. Resuming alone does not advance an ambiguity revisit: additional user
context is still required.

Requests use a 100-output-token limit, no automatic retries, and cancellation
after ten seconds. Only one request runs at a time; newer pending tasks replace
older pending tasks. Completed labels are reconsidered at most once per five
minutes for ordinary input. Workflow objectives and due ambiguity revisits bypass
that interval. Deduplication
and a 20-request cap persist with the session. Failed or invalid responses keep
existing names. Model usage returned before session replacement or shutdown is saved in
`jouzu-session-label-usage` custom session entries, outside the conversation;
those entries are not included in Pi's standard token/cost totals. Requests can
incur provider charges, including cancelled requests for which no usage arrives.

## tmux protection

Jouzu suppresses terminal-title escape sequences from the interactive runtime,
including Pi's startup and session-name writes. The tmux adapter captures the
server and pane at launch and updates only that pane. Other terminal and
multiplexer titles are left unchanged. Print, JSON, RPC, and child sessions do not
claim a pane.

An empty pane title can be claimed automatically. A nonempty title with no
ownership evidence is protected, including a hostname, shell name, or a title
beginning with `Jouzu`. Use `/labels pane auto` to opt in on such a pane. The
adapter uses pane-local `@jouzu-label-owner` and `@jouzu-label-value` options.
For stock tmux and Byobu status formats, it installs a window-local display rule:
show the active pane's owned label when the window is automatically named or has
an empty name. A manual window rename disables automatic naming in tmux, so an
explicit nonempty window name stays visible—even if it is `jouzu`. An automatically
named `jouzu` window displays its pane label instead. The actual window name and
`automatic-rename` setting are never changed.

Custom status formats are preserved. Pane borders are unchanged. The display
rule remains window-local after Jouzu exits, falling back to the window name when
there is no matching pane owner and label. To restore inherited status formats
for that window, run:

```sh
tmux set-option -wu window-status-format
tmux set-option -wu window-status-current-format
```

These commands remove window-local overrides, including any you added yourself;
do not use them if you want to keep a custom window-local format.

Each update checks the attachment's ownership token and its last title inside
the tmux command queue. If the title differs, Jouzu relinquishes ownership.
An external command that sets exactly the same title is not distinguishable from
no rename: use `/labels pane pin` to protect that title explicitly.

On normal shutdown or reload, Jouzu restores the captured prior title only if it
still owns the pane and the title has not changed. A subsequent attachment may
need `/labels pane auto` again. After a crash, an ownership token can remain;
Jouzu refuses to steal it. Once you have confirmed that the owning Jouzu process
has exited, clear that pane's token with:

```sh
tmux set-option -pu -t "$TMUX_PANE" @jouzu-label-owner
```

Then run `/labels pane auto`. Do not clear another running session's claim.
The adapter is tested on Linux with tmux; this does not establish native macOS or
Windows behavior.
