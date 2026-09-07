# TextGuard scanning

Sessions started with `jz` scan skill files, skill names and descriptions, and
web results locally by default. The packaged native helper requires no Python
installation or first-use download. Scanning preserves admitted content; it does
not clean or rewrite it.

A skill with error-level findings or an incomplete check is omitted before its
metadata or body enters model context. Web results requiring approval are
withheld as a whole, including structured details and images. Informational and
warning-level findings do not block content. Images cannot be checked by the
text scanner and require explicit approval.

## Review withheld content

1. In an interactive session, run `/textguard` without arguments.
2. Select a withheld item. The review shows an escaped, shortened source label,
   the content's SHA-256 fingerprint, severity counts, and up to two finding
   samples or the reason a check was incomplete.
3. Keep **Keep withheld**, or choose **Allow this content for this session**.
   Cancellation leaves the content withheld.
4. After approval, resources reload. Retry the skill or web request.

The review requires a terminal of at least 48 columns and 24 rows. It uses the
normal selection and cancel keys. Print and RPC sessions do not grant approvals;
their diagnostics direct you to interactive review.

Approval applies to the exact content, source, scanner version, and policy in
that session. Changed content needs another review. Reload preserves approval;
replacing the session or closing Jouzu clears it. A dialog opened in a replaced
session cannot approve content in its replacement.

Checks limited by input size, time, decoding, or scanner failure are incomplete,
not clean. Scanning accepts up to 256 KiB of text per request; a serialized web
result includes both text and structured details in that budget. Content that
cannot be captured completely and identified cannot be approved. Retry the
request after resolving its size, access, or read error.

## Ordinary file reads

Skill-file reads are checked by default. To include ordinary `read` tool results:

```sh
jz --jouzu-textguard-files
```

Pass Jouzu flags before Pi arguments. This checks the result returned by `read`,
including any truncation, rather than every byte of the source file.

## Python comparison reports

To add reports from a separately installed TextGuard 1.0.0:

```sh
python3 -m venv /absolute/path/to/textguard-env
/absolute/path/to/textguard-env/bin/python -m pip install 'textguard==1.0.0'
jz --jouzu-textguard-python /absolute/path/to/textguard-env/bin/python
```

On Windows, use the environment's `Scripts/python.exe` path. For Python's bundled
YARA pattern rules, install `textguard[yara]==1.0.0` and add
`--jouzu-textguard-yara`. Python comparison reports do not replace native checks
or approve withheld content. The Python adapter does not load semantic models
or custom rule directories.

## Limits

The verdict cache holds up to 128 complete results and is bounded to 256 KiB on
disk. It stores content hashes and scan evidence, not source bodies or approvals.
Incomplete results are not cached as clean verdicts.

Scanning is a model-input check, not a sandbox. It does not block files being
installed, extension code execution, or shell commands. It does not scan arbitrary
third-party tool output. Approval does not change tool permissions, and a scan
cannot establish that content is safe.
