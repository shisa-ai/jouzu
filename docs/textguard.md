# TextGuard scanning

Sessions started with `jz` scan skill files, skill names and descriptions, web
results, and [MCP tool results and resources](tools.md#mcp-servers). Scanning runs
locally and is on by default. The packaged scanner requires no Python
installation or first-use download. Content that passes without findings is
preserved; scanning does not rewrite or sanitize it.

A scan cannot establish that content is safe. Blocking a result can also prevent
the model from getting information it needs. TextGuard handles data and
instructions differently:

| Input | Treated as | Flagged content |
| --- | --- | --- |
| Web and search results, MCP tool results and resources, ordinary file reads (when enabled) | Data the model reads | Visible content is delivered with findings and an untrusted-data advisory; structured metadata is omitted |
| Skill files, skill names and descriptions, expanded skill text, reads of a skill file | Instructions the agent follows | Withheld until you approve it |

In the default mode, a flagged data result keeps its visible text and image
content. An advisory tells the model to treat that content as data, not
instructions.

Other fields—`details`, `structuredContent`, `nestedCalls`, and usage metadata—are
omitted because the advisory cannot be attached to them. If a result contains
only structured fields and no visible content, the model may receive the
advisory without the data.

TextGuard acts on error-level findings and incomplete checks. Informational and
warning-level findings never block or annotate content. The text scanner cannot
check images; an inspected result containing one is treated as an incomplete
check.

Mentions of `curl`, `wget`, `bash -c`, and `powershell` produce warnings because
these commands also appear in ordinary documentation. A skill containing those
names can load; its warnings remain available in `/textguard reports`. Other
findings, such as instruction overrides or hidden directional characters, can
still require approval.

## Modes

| Command | Launch flag | Effect |
| --- | --- | --- |
| `/textguard on` | (default) | The visible content of flagged data is delivered with findings; structured metadata and flagged instructions are withheld |
| `/textguard strict` | `--jouzu-textguard-strict` | Every flagged input is withheld until you approve it |
| `/textguard off` | `--jouzu-textguard-off` | Nothing is scanned and everything is admitted |

A mode lasts for the session and survives reload; restarting Jouzu returns to
the launch mode. Changing it discards the approvals and reports collected under
the previous mode and reloads resources. A child agent starts in the mode its
parent session is in.

## Notifications

Withholding content, or delivering it with findings attached, raises one
notification naming the source and what the scan found. The same content
notifies once per session. Findings that block nothing never interrupt the
session.

## Review withheld content

1. Run `/textguard` without arguments in an interactive session.
2. Review the list. It shows what needs a decision: content withheld pending
   approval and content that was delivered with error-level findings. Findings
   that blocked nothing are counted in the footer and listed by
   `/textguard reports`.
3. Select an item to open its detail view.
4. Inspect the detail view. It shows the escaped source label, the content's
   SHA-256 fingerprint, severity counts, finding explanations with locations,
   and the flagged content with controls and invisible characters shown as
   escapes. Page up and page down scroll the view.
5. Choose an action:
   - **Allow for this session** admits the content for the current session.
   - **Always allow this exact content** also records a persistent approval
     for the exact bytes, described below.
   - **Back** keeps the content withheld.
   Non-blocking reports offer **Dismiss report** instead, which removes them
   from the list and notifications for the current session.
   The cursor starts on the non-approving action; Escape returns to the list
   instead of closing the review.
6. After approval, resources reload. Retry the skill, web, or MCP request.

The review requires a terminal of at least 48 columns and 24 rows and uses the
normal selection and cancel keys. Print and RPC sessions do not grant approvals;
their diagnostics direct you to interactive review.

Warning and informational reports stay inspectable through `/textguard reports`
without interrupting the session. Dismissing one removes it from the list and
notifications for the current session.

## Approvals and their scope

A session approval applies to the exact content, source, scanner version, and
policy in that session. Changed content needs another review. Reload preserves
approval; replacing the session or closing Jouzu clears it. A dialog opened in
a replaced session cannot approve content in its replacement.

**Always allow this exact content** records a persistent approval keyed by the
content's SHA-256 digest, the scanner identity, and the policy version. Any
change to the content, a scanner update, or a policy change requires a new
decision.

Approvals are stored in the Jouzu cache under `textguard/approvals.json`
(bounded to 128 records); the file holds no source text, paths, or labels.
Delete that file to revoke all persistent approvals. Child agents do not share
the store and cannot create approvals.

The agent's `write` and `edit` tools cannot change Jouzu's state or cache
folders, including through a relative path or a symbolic link from the
workspace, so they cannot add approvals, record scan results, or alter
flow-control holds. Shell
commands still run with your own operating-system access; containing them needs
process-level isolation.

Checks limited by input size, time, decoding, or scanner failure are incomplete,
not clean. An incomplete check can be approved: the approval covers those exact
bytes, and a later check of the same content that is interrupted does not
withhold it again.

Scanning accepts up to 256 KiB of text per request; a serialized tool result
includes both text and structured details in that budget. Content that cannot be
captured completely and identified cannot be approved. Retry the request after
resolving its size, access, or read error.

## Ordinary file reads

Skill-file reads are checked by default. To include ordinary `read` tool results:

```sh
jz --jouzu-textguard-files
```

Pass Jouzu flags before Pi arguments. This checks the result returned by `read`,
including any truncation, rather than every byte of the source file.

## Child agents

Jouzu child agents check skill-file reads and expanded skill text in restored
sessions. Each child has its own scanner and decisions; it does not inherit
parent approvals, but it does start in the parent session's mode. Child agents
cannot open approval dialogs, so content that needs approval stays withheld for
the child.

`--jouzu-textguard-files` also checks ordinary reads in child agents launched or
resumed from that CLI session. Role-based tool restrictions still apply.

## Limits

The scanner caches up to 128 complete results in the Jouzu cache, in a file
limited to 256 KiB. It stores content hashes and scan evidence, not the source
content. Incomplete results are not cached as clean verdicts.

Persistent approvals are stored separately, with up to 128 records identified
by content hash.

Scanning is a model-input check, not a sandbox. It does not block files being
installed, extension code execution, or shell commands. It does not scan arbitrary
third-party tool output. Approval does not change tool permissions, and a scan
cannot establish that content is safe.
