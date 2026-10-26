# Role configuration and Workflow error visibility

This supplementary source pass reads all **386 lines** of `packages/cli/src/subagents/roles.ts` and bounded consumer regions in `workflow.ts` and `subagents/integration.ts`. The earlier non-flow partial/excerpt predicate did not select this file: its original disposition was `visible-source-metadata-and-validation`, while its evidence explicitly left the parser/storage body unaudited. A disposition-name filter therefore cannot establish whole-source completeness.

`files.csv` records one full producer read and two bounded traces. `surfaces.csv` records six grouped families in the shared eleven-column schema. `receipt.json` contains computed counts and the producer hash. These are not unique-message, defect, screen or runtime-pass counts.

## Findings

- Role/schema/placement/tool/judging/thinking validation uses locally authored English `Validation:` sentences. Numeric limits add English labels such as `Concurrent agents` and `Timeout seconds` without a catalog.
- Text-length errors have a catalog-backed frame, but their `Role ID`, `Description`, `Model` and `Instructions` arguments are literal English.
- Store safety, size, lock contention and revision-conflict errors own English recovery guidance. Workflow preserves ordinary `Error.message` in its input/render message area. Startup instead catches an unreadable role configuration and displays `subagentWorkflowAgentsUnreadable` through the active catalog. Source presence is not uniform visibility.
- Default role descriptions are generated English configuration metadata; existing descriptions/instructions can be user-authored. Instructions and language contracts are model-facing content. IDs, model selectors, tool names, placement/thinking/policy values and hashes stay exact.
- Model ambiguity/unavailability and thinking-resolution helpers support catalog messages. Their capability is not proof that every caller supplies the selected locale.

The explicit save route is `integration.ts service.save` → `AgentRoleStore.save` → `parseAgentConfig`; `workflow.ts` catches the error and `errorText` preserves normal errors while separately resolving `CatalogError`. The session-start load route has its own replacing catch. Consumer regions are identified in `files.csv`, not counted as full-file reviews.

## Reproduce

```sh
python -B review/ja-localization/full-ui-audit/semantic-roles/build-ledger.py
python -B review/ja-localization/full-ui-audit/validate.py
```

The generator materializes authored findings and computes counts; it is not independent semantic proof. Review changed producer/caller source before regenerating its hash. The shared validator checks schemas, source/test paths, IDs and tracked-source census consistency, not all caller routes or Japanese rendering.

No role file, configuration, lock, model/provider, native terminal or interactive form was exercised. Other callers, asynchronous errors, Japanese wording, CJK layout and platform behavior remain separate checks. The 25-import candidate list in `semantic-owned/README.md` is unchanged as that pass's historical boundary; this pass supplies additional evidence for one of its named files, not closure of the other consumer paths.
