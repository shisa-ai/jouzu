# Jouzu session UI workspace

This private workspace owns the persistent interactive surfaces around a Jouzu session. It is compiled and copied into the published `jouzu` CLI; it is not installed or published separately.

## Surfaces

- **Prompt Frame:** wraps Pi's `CustomEditor` with Jouzu borders and a left rail while preserving Pi input behavior.
- **Session Line:** places one priority hint on the left and protects provider/model/thinking identity on the right.
- **Status Bar:** renders provider-neutral workspace, Git, project-runtime, context, token, and health facts with deterministic narrowing.

## Boundaries

- `snapshot.ts` contains typed local facts and no raw workspace path.
- `controller.ts` coalesces bounded project probes and owns cancellation; there is no unconditional timer.
- `sources/` contains local Git and optional runtime detection only.
- Renderers use `layout.ts` for ANSI-, grapheme-, and CJK-aware terminal columns.
- `extension.ts` is the only Pi lifecycle adapter.
- `styles.ts` maps Jouzu semantic roles to the default Session UI colors. Renderers contain no raw color choices or legacy style names, and a future global theme can replace the complete mapping.
- Runtime IDs live in `identity.ts`; no state or configuration uses the feature/package name, so naming can change without migration.

The workspace deliberately excludes provider quota caches, cost claims, legacy zentui configuration, global message-renderer patches, and the obsolete editor recreation workaround. Submitted-message styling remains outside the package until Pi provides a supported composition seam.

## Development

From the repository root:

```bash
npm run build --workspace packages/session-ui
npm run check --workspace packages/session-ui
npm test --workspace packages/session-ui
```

The CLI build runs the workspace build first and vendors only runtime JavaScript, source maps, and `THIRD_PARTY_NOTICES.md` under `dist/session-ui`.
