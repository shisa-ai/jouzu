# CI runs

Pushes and pull requests run the full platform matrix. To run Windows checks manually:

```sh
gh workflow run ci.yml --ref main -f platform=windows -f npm-cache=warm -f fixture-drive=runner
```

This runs Windows Node 22/24, Python 3.10/3.12/3.13, packed local/global/npm-exec installation, update success/rollback, and first-use Camoufox. One Ubuntu job builds and checks the shared release artifacts before the Windows consumers start.

`npm-cache=warm` restores npm archives and lets the updater reuse the job's cache. The first run can miss the cache. `npm-cache=cold` skips restoration and gives the updater a fresh cache. Both modes install fresh dependency trees. Compare repeated runs at the same commit to measure cache effects.

`fixture-drive=runner` uses the runner's temp directory. `C` and `D` select a job-owned directory on that volume for temporary test installations; npm archives remain under the runner temp directory. Use the same cache mode when comparing volumes. Fixture placement does not depend on Defender state. Jobs preserve image protection settings and remove only exclusions they add.

The `windows-npm-*` artifacts contain npm timing/debug logs and the selected paths. `windows-defender-*` records protection state and exclusion cleanup. Compare elapsed time from the first Windows job start to the last Windows job finish, and inspect the artifact producer's duration separately. Adding parallel job durations measures runner usage, not elapsed time.

Source compatibility jobs use `node scripts/install-source-dependencies.mjs` followed by `JOUZU_BUILD_SOURCE_ONLY=1 npm run build`. The install temporarily removes workspace bundle declarations so npm installs the locked source dependencies, then restores the manifest and lock bytes even on failure. The build reuses those dependencies through package-directory links. Release artifact production uses `npm ci --ignore-scripts` and `npm run build` to prepare the nested distributable bundle.
