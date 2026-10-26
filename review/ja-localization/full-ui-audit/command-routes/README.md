# Selected command routes

## Saved registration reconciliation; final semantic review incomplete

This bounded source-only reconciliation covers builtin declarations/dispatch, owned and release-selected registrations, Session UI interception, and shipped skill/prompt routes. It does not execute commands or prove every nested state was reviewed.

`reconciliation.json` computes 70 route-layer records and 68 unique invocation spellings, with 11 additional state families and zero unmapped routes in the selected extraction. Duplicate spellings can represent different interception/dispatch layers; these are not screen or defect counts. Resource availability remains conditional.

The final source-review report was not completed. The saved artifacts pass reconciliation and mutation checks, but that is structural evidence, not approval of every authored mapping. Keep final semantic reconciliation as an explicit follow-up rather than claiming exhaustive command coverage.

## Artifacts

- `routes.csv`: discovered routes, selection anchors, description/state references and limits.
- `route_map.py`: authored mappings to existing and additional state families.
- `surfaces.csv`: additional common-schema state families.
- `alias-rules.csv`: normalization and alias rules.
- `residuals.csv`: exact selection, resource and external-extension boundaries.
- `reconciliation.json`: computed counts, package-local import edges, unresolved import boundaries and source-text hashes.
- `reconcile.py`, `reconcile_test.py`: static extraction, artifact comparisons and in-memory mutation checks. Product JavaScript is never imported.

The graph follows lexical relative imports within selected packages. It is not a JavaScript parser or proof that every imported implementation body was semantically reviewed. Arbitrary project/user extensions, collision suffixes, custom templates and skills are not an enumerable shipped command set. No `/language` command is inferred from an earlier family label; language settings are reached through Settings routes.

## Checks

```sh
python -B review/ja-localization/full-ui-audit/command-routes/reconcile.py
python -B -m unittest discover -s review/ja-localization/full-ui-audit/command-routes -p '*_test.py' -v
```

Both checks passed locally; the regression suite contains 18 tests. Run without `--write` to compare saved artifacts. Inspect changed source before deliberately regenerating. Runtime, native layout, resource materialization and Japanese correctness remain unverified.
