# Session and pane labels

Use `/labels on` in an interactive session to approve the selected provider and
model for automatic naming. Jouzu keeps that exact naming model when you switch
the main conversation model. Run `/labels on` again to approve the new selection.
Naming is off until approved, and the choice is saved with the session.

The naming request proposes a session name of at most 60 characters and a pane
label of at most 12 lowercase ASCII letters, digits, or hyphens. Session names
appear in `/resume`. Session IDs, filenames, workflow lanes, and tmux window names
do not change.

## Commands

| Command | Effect |
| --- | --- |
| `/labels` | Show naming model and ownership settings. |
| `/labels on` | Approve the selected provider/model for subsequent naming requests. |
| `/labels off` | Cancel pending naming and stop model requests. Keep existing labels. |
| `/labels pin` | Protect the session name, including when its text has not changed. |
| `/labels auto` | Allow automatic replacement of the session name. |
| `/labels pane pin` | Protect the pane title and release Jouzu's claim without restoring a prior title. |
| `/labels pane auto` | Explicitly allow replacing this pane's title. Refuse a claim held by another attachment. |

Using `/name` also pins the session name. A pre-existing session name without
Jouzu ownership metadata is protected. Session and pane ownership are independent.

## When naming runs

Jouzu checks submitted interactive text when it enters the conversation and
confirmed `/goal` or multiloop starts and resumes. It does not name from tool
iterations, background notifications, or automatic continuation prompts. A fresh
launch without task text makes no request. Reopening a session reuses saved labels.
Commands expanded into different text may not trigger ordinary task naming; the
explicit goal and multiloop notifications do not depend on text matching.

Requests run independently of the main turn, without tools, repository reads,
attachments, or full conversation history. The task excerpt is limited to 1,800
UTF-8 bytes. Absolute path tokens and common credential prefixes are redacted;
this is not a general secret detector. Do not include secrets in task text.

Requests use a 100-output-token limit, no automatic retries, and cancellation
after ten seconds. Only one request runs at a time; newer pending tasks replace
older pending tasks. Completed labels are reconsidered at most once per five
minutes for ordinary input. Workflow objectives bypass that interval. Deduplication
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
adapter uses a pane-local `@jouzu-label-owner` option; it does not change tmux
border or status configuration. Your tmux configuration decides where pane
titles are visible.

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
