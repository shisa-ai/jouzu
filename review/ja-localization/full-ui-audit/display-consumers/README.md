# Dashboard and external receipt consumers

This source pass reads **six complete files, 1,393 lines**, plus **seven bounded consumer regions**. Six grouped findings clarify the final owned dashboard renderer and the external receipt handoff. These are source-evidence records, not unique screens or successful runtime scenarios.

## Dashboard findings

- `main-cli.ts` supplies the active catalog to `createFlowWorkSource` and job framing. `flowWorkSnapshot` selects only retryable, uncertain and unaccountable work. It does **not** display all `captureFlowStatusContext` fields, so that helper's English sender/stage fallbacks cannot be assigned to this dashboard merely because the projection omits its catalog.
- `flow-runtime.ts` authors unaccountable descriptions as `lane <id> (<tag>)` and `task #<id>`. The prefixes are local framing; IDs and tags remain protected identity. `work-dashboard-renderer.ts` sanitizes and displays those labels without translation.
- The renderer uses catalog section names/attention/durations, but independently composes **`running`, `open`, `done`, `failed`** count segments. Rows without attention can show raw `failed`, `cancelled`, `waiting` and `paused` states. A separate display mapping can localize these without altering stored enums.
- `WorkDashboardController` drops source-read error messages, retaining old units as stale or leaving unknown empty state. The English stale-read exception is not displayed through this catch. `WorkDashboardComponent` passes the snapshot to the renderer; Session UI installs it above the editor in TUI mode. No live polling, rendering or placement was executed.

The existing `dashboard.summary` row did not explicitly inventory count prose. `display-consumers.dashboard-counts` supplies that missing distinction rather than treating all dynamic segments as preserved source data.

## External receipt boundary

`UserInputAdapters` projects catalog-backed receipt prose and returns or publishes the object. The inspected Pi loader, session and ingress wrappers enforce lifetime/authority and forward the object; they do not render its `reason.text` in a terminal view.

The complete example `examples/user-input-adapter/extension.ts` requires an application-supplied authenticated transport. Its `setReceipt` and `reportFailure` methods are interfaces, not a client implementation. Submission/reconnect errors go to that transport; registration/rebind/unsupported-host errors can additionally use English `External user input` notification framing. The file explicitly is not itself an extension entry.

A reproducible scoped scan of tracked `packages/cli/src`, `packages/session-ui/src` and `examples` finds one literal `.registerUserInputAdapter(` call, in that example. This does not inspect arbitrary installed extensions, computed calls or user-supplied authenticated clients. The product API's English receipt prose remains an actionable catalog/content finding, but **no shipped final receipt screen is established by this route**. External-client presentation is a consumer-owned extension boundary, not a finite product screen silently counted as audited.

## Artifacts and checks

- `files.csv`: complete reads separated from bounded traces.
- `surfaces.csv`: common eleven-column schema and six `display-consumers.` families.
- `anchors.csv`: unique exact source fragments for staleness checks; not proof of semantic correctness.
- `receipt.json`: computed line/file counts, full-read hashes, scoped registration call results and false runtime sign-off.
- `build-ledger.py`, `consumer_test.py`: authored evidence generator and saved-artifact/source/limit checks; neither imports product runtime.

```sh
python -B review/ja-localization/full-ui-audit/display-consumers/build-ledger.py
python -m unittest discover -s review/ja-localization/full-ui-audit/display-consumers -p '*_test.py' -v
python -B review/ja-localization/full-ui-audit/validate.py
```

Changed sources require renewed inspection before accepting regenerated anchors/hashes. Remaining limits are native layout/timing, all arbitrary external clients, inherited producer payload and other uninspected host routes. This pass does not deliver a receipt, open real user state, arm a timer, authenticate, invoke a tool or change product/catalog/settings source.
