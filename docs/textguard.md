# TextGuard scanning

Enable experimental local scanning for one Jouzu launch:

```sh
python3 -m venv /absolute/path/to/textguard-env
/absolute/path/to/textguard-env/bin/python -m pip install 'textguard==1.0.0'
jz --jouzu-textguard-python /absolute/path/to/textguard-env/bin/python
```

On Windows, use the environment's `Scripts/python.exe` path. Pass Jouzu flags
before Pi arguments. Source builds require the same explicit flag.

The adapter checks for TextGuard 1.0.0 and runs its JSON CLI in an isolated
Python process. It scans loaded skill files and their descriptions before each
agent turn, expanded skill prompts, and text returned by Jouzu's web tools before
that result enters model context. Identical content reuses a bounded in-memory
cache. Reading a `SKILL.md` through the `read` tool is included.

For bundled injection-pattern rules, install `textguard[yara]==1.0.0` in that
environment and add `--jouzu-textguard-yara`. Without that flag, scanning covers
Unicode concealment, bounded encoded payloads, and split-token signals. Add
`--jouzu-textguard-files` to scan ordinary `read` tool text as well.

Scans preserve the original content. Reports contain finding codes, severities,
and offsets into the scanned text. Reports include counts for every severity and
up to 16 finding samples; they omit source excerpts and normalized/decoded text. Reports
mark oversized input, timeouts, invalid output, or a missing scanner as
`unavailable`. Each input is limited to 256 KiB, each scanner process to two
seconds, and skill inventory scanning to five seconds per turn. Up to 128 scan
results are cached. No scan result grants permission or certifies safety.

This is detection at the model-input boundary. Skill scanning happens after Pi
has discovered resources; it does not block installation or extension code
execution. The adapter does not scan images, shell output, arbitrary third-party
MCP tools, or child-agent sessions. Ordinary file scanning covers text returned
by `read`, including its truncation, rather than every byte of the source file.
The Python adapter does not load semantic models or custom rule directories.
