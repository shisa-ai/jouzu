# Native TextGuard build inputs

`source/` contains the deterministic scanner and helper based on
[shisa-ai/textguard-go](https://github.com/shisa-ai/textguard-go) revision
`2e0dda937e1c2cb38713dd66659e9e3c3fb7693d`, with Unicode conformance fixes and
bounded native scanning changes. Modified Go files carry a change notice.
Optional model-classification code is excluded. Vendored dependencies permit
compilation without fetching scanner modules.

`source.lock.json` pins every source and license file, Go `go1.26.1`, the helper
protocol, and the six OS/architecture targets. Builds reject missing, added,
or changed source files until the reviewed lock is updated.

From the repository root:

```sh
node scripts/build-textguard.mjs
```

The build requires Go; it may download the pinned toolchain through Go's
verified toolchain mechanism. The output goes to `packages/cli/dist/textguard/`.
Users of packaged binaries do not need Go or Python. An optional positional
argument selects another output directory for reproducibility checks.

The build disables CGo, trims source paths, omits build IDs and version-control
metadata, and emits executable hashes and sizes in `manifest.json`. Linux,
Windows, and macOS each have x64 and ARM64 artifacts. Cross-compilation alone
is not evidence that a binary executes correctly on its target platform.

## Protocol

Each newline-delimited request has exactly `version`, `id`, and `text` fields.
Protocol version is `1`. IDs are 1–64 ASCII letters, digits, or hyphens. Input
is valid Unicode text with at most 256 KiB of UTF-8 bytes; the encoded request
has a 2 MiB ceiling. Duplicate fields and unpaired surrogate escapes are
rejected. No file paths, configuration overrides, or executable commands are
accepted.

The helper uses the default preset, trimmed confusables, split-token detection,
and bundled patterns. It ignores ambient scanner configuration. Each scan has
a 4096-finding production budget before deduplication, including discarded
normalization findings. Exhaustion reports unavailable coverage; it does not
return a partial clean result.

Responses include the input SHA-256 digest, complete finding/severity counts,
at most 64 finding records, and decoder reason codes. They exclude full source,
normalized text, decoded text, and freeform finding details. A response has a
64 KiB ceiling. `unavailable` includes finding, input, and decoding limits as
well as protocol/scanner failures. Consumers must interpret it separately from
`clear` and supervise process deadlines, cancellation, and bounded queues.

The helper's 96 MiB Go memory target is a garbage-collector hint, not an
operating-system memory ceiling. Finding and input bounds are enforced
separately.

## Redistribution

`licenses/` is copied next to the packaged executables. It includes TextGuard's
Apache-2.0 terms, the Go and golang.org/x dependency licenses, the TOML parser's
COPYING file, and Unicode License V3 from `https://www.unicode.org/license.txt`.

The embedded confusables and script-range JSON retain source URLs, Unicode
17.0.0 identifiers, and input checksums. Generated character classes use Unicode
15.0.0 properties matching Python 3.12. Rule files retain their source comments.
The source and vendored dependency trees retain their own license notices.
