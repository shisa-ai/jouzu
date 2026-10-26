# Final translation reconciliation format

This supplement matches the confirmed groups in `full-ui-audit/FINDINGS.md` to existing current-source drafts and adds missing proposals. It does not reopen the source inventory or change product text.

## Partition files

Each partition writes a JSON object with `findings` and `proposals` arrays.

A finding record has:

- `area`: Exact first-column name from the confirmed findings table.
- `existing_rows`: Existing reconciliation `row_id` values relevant to the finding, including resolved rows when exact existing Japanese should be reused for wiring.
- `proposal_ids`: New proposal IDs in the same partition.
- `action`: Concrete implementation work, separating catalog propagation from new wording.
- `coverage`: `matched`, `supplemented`, or `verification_only`.
- `limits`: Honest remaining source, runtime, language or compatibility limits. State whether a large family has only representative proposals; never label it translation-complete from a few samples.

A proposal record has:

- `row_id`: Unique partition-prefixed ID.
- `areas`: Exact confirmed finding area names to which this proposal applies.
- `source_file`: Repository-relative current source path.
- `source_line`: Positive line number.
- `source_anchor`: Exact single source line at `source_line`; read source before proposing.
- `english`: Complete concrete message/template or display-value meaning, not an abbreviated family summary.
- `japanese`: Proposed Japanese preserving all behavior-bearing placeholders and protected values.
- `kind`: `translate`, `display_only`, or `reuse_existing_ja`.
- `message_id`: Existing catalog ID for reuse, otherwise empty.
- `placeholders`: Array of exact template/Fluent tokens used in both proposals. For nonliteral display composition, document the deliberate implementation transformation in `notes` instead of claiming an exact template replacement.
- `notes`: Consumer context, preservation and compatibility boundaries, any deliberate normalization and the proposed implementation method.

Do not repeat an existing proposal with identical English and Japanese. Link existing rows instead. Same English in different contexts is not automatically interchangeable. Retained machine/model/external content is not a translation gap. New drafts are source-context checked, not qualified language or runtime approval.
